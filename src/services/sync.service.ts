/**
 * Main synchronization service that orchestrates the sync process.
 *
 * RESPONSIBILITIES:
 * - Monitor config changes via ConfigService.changed$
 * - Sanitize config before sync (remove private keys)
 * - Encrypt/decrypt sync data
 * - Upload to / download from Google Drive
 * - Merge remote config with local config
 * - Handle errors gracefully with retry logic
 *
 * SYNC FLOW:
 * 1. User changes config → detect via changed$
 * 2. Sanitize config → remove SSH keys, paths
 * 3. Encrypt with AES-256 using master password
 * 4. Upload to Google Drive AppData folder
 *
 * On startup:
 * 1. Download from Google Drive
 * 2. Decrypt with master password
 * 3. Merge with local config (smart merge)
 * 4. Save merged config
 */

import { Injectable, NgZone } from '@angular/core';
import {
  ConfigService,
  Logger,
  LogService,
  PlatformService,
  HostAppService,
} from 'tabby-core';
import { Subscription, BehaviorSubject, Observable } from 'rxjs';
import { debounceTime, filter } from 'rxjs/operators';

import { CryptoService, EncryptedData } from './crypto.service';
import { DriveService, DriveConnectionStatus } from './drive.service';
import { createSyncPayload } from '../utils/sanitize.util';
import { mergePayloads, applyPayloadToConfig } from '../utils/merge.util';
import {
  SyncPayload,
  GDriveSyncConfig,
  SyncResult,
  QuickCommand,
  QuickCommandGroup,
  SyncVersion,
} from '../interfaces/sync.interface';
import * as yaml from 'js-yaml';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

/** Retry configuration */
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const SYNC_DEBOUNCE_MS = 5000; // Wait 5 seconds after last change before syncing

/**
 * Current sync state for UI
 */
export interface SyncState {
  status: 'idle' | 'syncing' | 'error' | 'disabled';
  lastSyncTime?: Date;
  lastSyncError?: string;
  pendingChanges: boolean;
}

@Injectable()
export class SyncService {
  private readonly log: Logger;

  /** Current master password (kept in memory only) */
  private masterPassword: string | null = null;

  /** Subscription to config changes */
  private configChangeSub: Subscription | null = null;

  /** Sync state observable */
  private syncState = new BehaviorSubject<SyncState>({
    status: 'idle',
    pendingChanges: false,
  });
  public syncState$: Observable<SyncState> = this.syncState.asObservable();

  /** Flag to prevent sync loop when applying remote changes */
  private isApplyingRemote = false;

  /** Missing plugins detected from sync */
  public missingPlugins$ = new BehaviorSubject<string[]>([]);

  constructor(
    private config: ConfigService,
    private crypto: CryptoService,
    private drive: DriveService,
    private hostApp: HostAppService,
    private platform: PlatformService,
    private zone: NgZone,
    logService: LogService,
  ) {
    this.log = logService.create('GDriveSync:Sync');
  }

  /**
   * Gets the current plugin configuration.
   */
  private getPluginConfig(): GDriveSyncConfig {
    return (this.config.store.gdrivesync || {}) as GDriveSyncConfig;
  }

  /**
   * Saves plugin configuration.
   */
  private async savePluginConfig(
    config: Partial<GDriveSyncConfig>,
  ): Promise<void> {
    if (!this.config.store.gdrivesync) {
      this.config.store.gdrivesync = {};
    }
    Object.assign(this.config.store.gdrivesync as object, config);
    await this.config.save();
  }

  /**
   * Initializes the sync service.
   * Called on plugin startup.
   */
  async initialize(): Promise<void> {
    // Wait for ConfigService to be ready
    await new Promise<void>((resolve) => {
      this.config.ready$.subscribe({
        next: () => resolve(),
        error: () => resolve(), // Continue even if error
      });
    });

    this.log.info('Initializing sync service');

    const pluginConfig = this.getPluginConfig();

    // DriveService is now auto-configured with hardcoded credentials

    // If we have stored tokens, try to reconnect
    if (pluginConfig.googleAuthTokens && this.drive.isConfigured()) {
      try {
        const success = await this.drive.initialize(
          pluginConfig.googleAuthTokens,
        );
        if (success) {
          this.log.info('Reconnected to Google Drive using stored tokens');

          // Update tokens if refreshed
          const newTokens = this.drive.getTokens();
          if (newTokens && newTokens !== pluginConfig.googleAuthTokens) {
            await this.savePluginConfig({
              googleAuthTokens:
                newTokens as GDriveSyncConfig['googleAuthTokens'],
            });
          }

          // Auto-sync can only run after the user unlocks encryption.
          if (pluginConfig.autoSyncOnStartup && this.hasPassword()) {
            this.log.info('Auto-sync: pulling config from remote...');
            this.fullSync().catch((err) => {
              this.log.error('Auto-sync on startup failed:', err);
            });
          } else {
            this.log.info(
              'Auto-sync on startup skipped until sync password is unlocked',
            );
          }
        }
      } catch (error) {
        this.log.warn('Failed to reconnect with stored tokens:', error);
      }
    }

    // Start watching for config changes if enabled
    this.refreshChangeWatcher();
  }

  /**
   * Sets the master password for encryption/decryption.
   * Password is verified against stored hash if exists.
   *
   * @param password - Master password
   * @returns True if password is correct (or first-time setup)
   */
  setMasterPassword(password: string): boolean {
    if (!password) {
      this.log.warn('Empty master password rejected');
      return false;
    }

    const pluginConfig = this.getPluginConfig();

    // If we have a stored hash, verify password
    if (pluginConfig.masterPasswordHash && pluginConfig.masterPasswordSalt) {
      const isValid = this.crypto.verifyPassword(
        password,
        pluginConfig.masterPasswordHash,
        pluginConfig.masterPasswordSalt,
      );

      if (!isValid) {
        this.log.warn('Invalid master password');
        return false;
      }
    }

    this.masterPassword = password;
    this.crypto.clearCache();
    this.refreshChangeWatcher();
    this.log.info('Master password set successfully');
    return true;
  }

  /**
   * Sets up a new master password (first-time setup or password change).
   *
   * @param password - New master password
   */
  async setupMasterPassword(password: string): Promise<void> {
    if (!password) {
      throw new Error('Master password cannot be empty');
    }

    const { hash, salt } = this.crypto.generatePasswordHash(password);

    await this.savePluginConfig({
      masterPasswordHash: hash,
      masterPasswordSalt: salt,
    });

    this.masterPassword = password;
    this.crypto.clearCache();
    this.refreshChangeWatcher();
    this.log.info('Master password configured');
  }

  /**
   * Configures the master password for first-time setup.
   * If Drive is connected, validates it against the remote file before storing
   * the local verification hash. This avoids pinning a new machine to a wrong
   * password when an encrypted sync file already exists.
   */
  async configureMasterPassword(password: string): Promise<SyncResult | null> {
    if (!password) {
      return {
        success: false,
        action: 'none',
        timestamp: Date.now(),
        error: 'Master password cannot be empty',
      };
    }

    if (this.isPasswordConfigured()) {
      const unlocked = this.setMasterPassword(password);
      if (!unlocked) {
        return {
          success: false,
          action: 'none',
          timestamp: Date.now(),
          error: 'Incorrect master password',
        };
      }
      return null;
    }

    this.masterPassword = password;
    this.crypto.clearCache();

    if (this.drive.isConnected()) {
      const syncResult = await this.fullSync();
      if (!syncResult.success) {
        this.clearPassword();
        return syncResult;
      }
    }

    await this.setupMasterPassword(password);
    return null;
  }

  /**
   * Changes the local master password and re-encrypts the remote sync file.
   */
  async changeMasterPassword(password: string): Promise<SyncResult | null> {
    if (!password) {
      return {
        success: false,
        action: 'none',
        timestamp: Date.now(),
        error: 'Master password cannot be empty',
      };
    }

    if (!this.masterPassword) {
      return {
        success: false,
        action: 'none',
        timestamp: Date.now(),
        error: 'Unlock the current master password before changing it',
      };
    }

    if (!this.drive.isConnected()) {
      return {
        success: false,
        action: 'none',
        timestamp: Date.now(),
        error: 'Connect Google Drive before changing the master password',
      };
    }

    const previousPassword = this.masterPassword;
    this.masterPassword = password;
    this.crypto.clearCache();

    const syncResult = await this.syncToRemote();
    if (!syncResult.success) {
      this.masterPassword = previousPassword;
      this.crypto.clearCache();
      this.refreshChangeWatcher();
      return syncResult;
    }

    await this.setupMasterPassword(password);
    return syncResult;
  }

  /**
   * Checks if master password is set in memory.
   */
  hasPassword(): boolean {
    return this.masterPassword !== null;
  }

  /**
   * Checks if master password has been configured.
   */
  isPasswordConfigured(): boolean {
    const pluginConfig = this.getPluginConfig();
    return !!(
      pluginConfig.masterPasswordHash && pluginConfig.masterPasswordSalt
    );
  }

  /**
   * Clears the master password from memory.
   */
  clearPassword(): void {
    this.masterPassword = null;
    this.crypto.clearCache();
    this.refreshChangeWatcher();
    this.log.debug('Master password cleared');
  }

  /**
   * Checks if Google credentials are configured.
   * Always returns true since credentials are hardcoded.
   */
  hasGoogleCredentials(): boolean {
    return true; // Credentials are now hardcoded in DriveService
  }

  /**
   * Starts the Google Drive authorization flow.
   */
  async connectGoogleDrive(): Promise<boolean> {
    try {
      const tokens = await this.drive.authorize();

      // Save tokens
      await this.savePluginConfig({
        googleAuthTokens: tokens as GDriveSyncConfig['googleAuthTokens'],
      });

      this.refreshChangeWatcher();
      this.log.info('Google Drive connected');
      return true;
    } catch (error) {
      this.log.error('Failed to connect Google Drive:', error);
      return false;
    }
  }

  /**
   * Disconnects from Google Drive.
   */
  async disconnectGoogleDrive(): Promise<void> {
    await this.drive.disconnect();
    this.clearPassword();
    await this.savePluginConfig({
      googleAuthTokens: undefined,
      driveFileId: undefined,
    });
    this.refreshChangeWatcher();
    this.log.info('Google Drive disconnected');
  }

  /**
   * Gets the current Drive connection status.
   */
  getDriveStatus(): Observable<DriveConnectionStatus> {
    return this.drive.connectionStatus$;
  }

  /**
   * Enables or disables sync.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    await this.savePluginConfig({ enabled });

    this.refreshChangeWatcher();

    this.updateSyncState({
      status: enabled ? 'idle' : 'disabled',
    });

    this.log.info(`Sync ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Starts watching for config changes.
   */
  private startWatchingChanges(): void {
    if (this.configChangeSub) {
      return; // Already watching
    }

    this.log.debug('Starting config change watcher');

    this.configChangeSub = this.config.changed$
      .pipe(
        filter(() => !this.isApplyingRemote), // Ignore changes from applying remote
        debounceTime(SYNC_DEBOUNCE_MS),
      )
      .subscribe(() => {
        this.zone.run(() => {
          this.updateSyncState({ pendingChanges: true });
          if (!this.masterPassword) {
            this.log.debug('Auto-sync skipped: master password is locked');
            return;
          }
          this.syncToRemote().catch((error) => {
            this.log.error('Auto-sync failed:', error);
          });
        });
      });
  }

  /**
   * Starts or stops config-change watching based on connection and password state.
   */
  private refreshChangeWatcher(): void {
    const pluginConfig = this.getPluginConfig();
    const shouldWatch = !!(
      pluginConfig.enabled &&
      pluginConfig.autoSyncOnChange &&
      this.masterPassword &&
      this.drive.isConnected()
    );

    if (shouldWatch) {
      this.startWatchingChanges();
    } else {
      this.stopWatchingChanges();
    }
  }

  /**
   * Stops watching for config changes.
   */
  private stopWatchingChanges(): void {
    if (this.configChangeSub) {
      this.configChangeSub.unsubscribe();
      this.configChangeSub = null;
      this.log.debug('Stopped config change watcher');
    }
  }

  /**
   * Updates the sync state.
   */
  private updateSyncState(update: Partial<SyncState>): void {
    this.syncState.next({
      ...this.syncState.value,
      ...update,
    });
  }

  /**
   * Syncs local config to Google Drive.
   *
   * @returns Sync result
   */
  async syncToRemote(): Promise<SyncResult> {
    if (!this.masterPassword) {
      return {
        success: false,
        action: 'none',
        timestamp: Date.now(),
        error: 'Master password not set',
      };
    }

    if (!this.drive.isConnected()) {
      return {
        success: false,
        action: 'none',
        timestamp: Date.now(),
        error: 'Not connected to Google Drive',
      };
    }

    this.updateSyncState({ status: 'syncing' });
    this.log.info('Starting sync to remote');

    try {
      // Get current config as raw object
      const rawConfigStr = await this.config.readRaw();
      const rawConfig = yaml.load(rawConfigStr.replace(/^---\n/, '')) as Record<
        string,
        unknown
      >;

      // Create sanitized sync payload
      const hostname = await this.getHostname();
      const installedPlugins = this.getInstalledPlugins();
      const quickCmds = this.getQuickCommands();

      // Add quick-cmds to config if exists
      if (quickCmds) {
        rawConfig['quick-cmds'] = quickCmds;
      }

      const payload = createSyncPayload(rawConfig, hostname, installedPlugins);

      // Encrypt the payload
      const encrypted = this.crypto.encryptObject(payload, this.masterPassword);

      // Upload to Drive
      await this.retryWithBackoff(async () => {
        await this.drive.uploadSyncFile(JSON.stringify(encrypted));
      });

      const now = Date.now();
      await this.savePluginConfig({
        lastSyncTime: now,
        lastSyncError: undefined,
        lastSyncHost: hostname,
      });

      this.updateSyncState({
        status: 'idle',
        lastSyncTime: new Date(now),
        lastSyncError: undefined,
        pendingChanges: false,
      });

      this.log.info('Sync to remote completed');
      return { success: true, action: 'upload', timestamp: now };
    } catch (error) {
      const errorMsg = (error as Error).message;
      this.log.error('Sync to remote failed:', error);

      await this.savePluginConfig({ lastSyncError: errorMsg });
      this.updateSyncState({
        status: 'error',
        lastSyncError: errorMsg,
      });

      return {
        success: false,
        action: 'upload',
        timestamp: Date.now(),
        error: errorMsg,
      };
    }
  }

  /**
   * Lists available versions from Google Drive
   */
  async listRemoteVersions(): Promise<SyncVersion[]> {
    try {
      const revisions = await this.drive.listVersions();
      return revisions
        .filter((rev) => rev.id && rev.modifiedTime)
        .map((rev) => ({
          id: rev.id as string,
          modifiedTime: rev.modifiedTime as string,
          size: rev.size,
          name: `Version ${new Date(rev.modifiedTime as string).toLocaleString()}`,
        }))
        .sort(
          (a, b) =>
            new Date(b.modifiedTime).getTime() -
            new Date(a.modifiedTime).getTime(),
        )
        .slice(0, 20);
    } catch (error) {
      this.log.error('Failed to list remote versions:', error);
      return [];
    }
  }

  /**
   * Restores a specific version from Google Drive
   */
  async restoreRemoteVersion(versionId: string): Promise<boolean> {
    if (!this.masterPassword) {
      this.log.error('Master password not set');
      return false;
    }

    try {
      this.log.info(`Restoring version ${versionId}...`);

      // 1. Download content
      const encryptedContent = await this.drive.downloadVersion(versionId);
      if (!encryptedContent) {
        throw new Error('Version content not found');
      }

      // 2. Decrypt
      if (!this.masterPassword) {
        throw new Error('Master password not set (please unlock sync first)');
      }

      let payload: SyncPayload;
      try {
        const encryptedData = JSON.parse(encryptedContent) as EncryptedData;
        const decryptedStr = this.crypto.decrypt(
          encryptedData,
          this.masterPassword,
        );

        if (!decryptedStr) {
          throw new Error('Decryption failed (wrong password?)');
        }

        payload = JSON.parse(decryptedStr) as SyncPayload;
      } catch (e) {
        throw new Error(
          'Failed to decrypt version content: ' + (e as Error).message,
        );
      }

      // 3. Force apply (Set timestamp to future to win conflict resolution)
      payload.lastUpdated = Date.now() + 10000;

      // 4. Apply configuration
      const rawConfigStr = await this.config.readRaw();
      const rawConfig = yaml.load(rawConfigStr.replace(/^---\n/, '')) as Record<
        string,
        unknown
      >;

      // Check missing plugins
      if (payload.settings.installedPlugins) {
        this.checkMissingPlugins(payload.settings.installedPlugins);
      }

      // Apply quick commands
      if (payload.settings.quickCmds) {
        await this.applyQuickCommands(payload.settings.quickCmds);
      }

      // Merge and write
      const updatedConfig = applyPayloadToConfig(rawConfig, payload);
      await this.config.writeRaw(yaml.dump(updatedConfig));

      // Save sync state
      await this.savePluginConfig({
        lastSyncTime: Date.now(),
        lastSyncError: undefined,
      });

      this.log.info(`Version ${versionId} restored successfully`);
      return true;
    } catch (error) {
      this.log.error('Failed to restore version:', error);
      return false;
    }
  }

  /**
   * Syncs from Google Drive to local.
   * Downloads, decrypts, and merges with local config.
   *
   * @returns Sync result
   */
  async syncFromRemote(): Promise<SyncResult> {
    if (!this.masterPassword) {
      return {
        success: false,
        action: 'none',
        timestamp: Date.now(),
        error: 'Master password not set',
      };
    }

    if (!this.drive.isConnected()) {
      return {
        success: false,
        action: 'none',
        timestamp: Date.now(),
        error: 'Not connected to Google Drive',
      };
    }

    this.updateSyncState({ status: 'syncing' });
    this.log.info('Starting sync from remote');

    try {
      // Download from Drive
      const encryptedJson = await this.retryWithBackoff(async () => {
        return await this.drive.downloadSyncFile();
      });

      if (!encryptedJson) {
        // No remote file exists - nothing to sync
        this.log.info('No remote sync file found');
        this.updateSyncState({ status: 'idle' });
        return { success: true, action: 'none', timestamp: Date.now() };
      }

      // Parse encrypted data
      let encrypted: EncryptedData;
      try {
        encrypted = JSON.parse(encryptedJson) as EncryptedData;
      } catch {
        throw new Error('Remote sync file is corrupted (invalid JSON)');
      }

      // Decrypt
      const remotePayload = this.crypto.decryptObject<SyncPayload>(
        encrypted,
        this.masterPassword,
      );
      if (!remotePayload) {
        throw new Error(
          'Failed to decrypt remote data - wrong password or corrupted data',
        );
      }

      // Validate payload structure
      if (
        !remotePayload.version ||
        !remotePayload.lastUpdated ||
        !Array.isArray(remotePayload.profiles)
      ) {
        throw new Error('Remote sync file has invalid structure');
      }

      // Check for missing plugins
      if (remotePayload.settings.installedPlugins) {
        this.checkMissingPlugins(remotePayload.settings.installedPlugins);
      }

      // Apply quick commands/snippets if present
      if (remotePayload.settings.quickCmds) {
        await this.applyQuickCommands(remotePayload.settings.quickCmds);
      }

      // Get current local config
      const rawConfigStr = await this.config.readRaw();
      const rawConfig = yaml.load(rawConfigStr.replace(/^---\n/, '')) as Record<
        string,
        unknown
      >;
      const hostname = await this.getHostname();
      const localPayload = createSyncPayload(rawConfig, hostname);

      // Merge payloads
      const mergeResult = mergePayloads(localPayload, remotePayload, rawConfig);

      this.log.info(
        `Merge complete: ${mergeResult.addedProfiles.length} profiles added, ${mergeResult.conflicts.length} conflicts resolved`,
      );

      // Apply merged config
      this.isApplyingRemote = true;
      try {
        const updatedConfig = applyPayloadToConfig(
          rawConfig,
          mergeResult.mergedPayload,
        );

        // Write back to Tabby config
        await this.config.writeRaw(yaml.dump(updatedConfig));
      } finally {
        this.isApplyingRemote = false;
      }

      const now = Date.now();
      await this.savePluginConfig({
        lastSyncTime: now,
        lastSyncError: undefined,
        lastSyncHost: hostname,
      });

      this.updateSyncState({
        status: 'idle',
        lastSyncTime: new Date(now),
        lastSyncError: undefined,
        pendingChanges: false,
      });

      this.log.info('Sync from remote completed');
      return {
        success: true,
        action: 'merge',
        timestamp: now,
        conflictsResolved: mergeResult.conflicts.length,
      };
    } catch (error) {
      const errorMsg = (error as Error).message;
      this.log.error('Sync from remote failed:', error);

      await this.savePluginConfig({ lastSyncError: errorMsg });
      this.updateSyncState({
        status: 'error',
        lastSyncError: errorMsg,
      });

      // IMPORTANT: Do NOT overwrite local config on error
      return {
        success: false,
        action: 'download',
        timestamp: Date.now(),
        error: errorMsg,
      };
    }
  }

  /**
   * Performs a full bidirectional sync.
   * Downloads remote, merges, then uploads merged result.
   */
  async fullSync(): Promise<SyncResult> {
    this.log.info('Performing full sync');

    // First, sync from remote to get latest
    const downloadResult = await this.syncFromRemote();
    if (!downloadResult.success && downloadResult.error) {
      return downloadResult;
    }

    // Then, upload merged result
    const uploadResult = await this.syncToRemote();
    return uploadResult;
  }

  /**
   * Gets the hostname for this machine.
   */
  private async getHostname(): Promise<string> {
    try {
      return os.hostname();
    } catch {
      return 'unknown-host';
    }
  }

  /**
   * Retries an operation with exponential backoff.
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number = MAX_RETRIES,
  ): Promise<T> {
    let lastError: Error | null = null;
    let delay = INITIAL_RETRY_DELAY_MS;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        this.log.warn(
          `Operation failed (attempt ${attempt + 1}/${maxRetries}):`,
          lastError.message,
        );

        if (attempt < maxRetries - 1) {
          await this.sleep(delay);
          delay *= 2; // Exponential backoff
        }
      }
    }

    throw lastError || new Error('Operation failed after retries');
  }

  /**
   * Sleep helper.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Gets the list of installed plugins from package.json
   */
  private getInstalledPlugins(): string[] {
    try {
      // Try to get config path from PlatformService
      // Note: getConfigPath is not in the public type definition but exists at runtime
      const configPath = (
        this.platform as unknown as { getConfigPath?: () => string }
      ).getConfigPath?.();

      if (!configPath) {
        this.log.debug('Could not get config path from PlatformService');
        return [];
      }

      // Plugins are stored in 'plugins/package.json' relative to config directory
      const pluginsPath = path.join(
        path.dirname(configPath),
        'plugins',
        'package.json',
      );

      if (fs.existsSync(pluginsPath)) {
        const content = JSON.parse(fs.readFileSync(pluginsPath, 'utf8'));
        // Return plugin names from dependencies (they start with 'tabby-')
        const dependencies = content.dependencies || {};
        return Object.keys(dependencies).filter((name) =>
          name.startsWith('tabby-'),
        );
      } else {
        this.log.debug('Plugins package.json not found at:', pluginsPath);
      }
    } catch (error) {
      this.log.warn('Failed to read installed plugins:', error);
    }
    return [];
  }

  /**
   * Gets quick commands/snippets from quick-cmds plugin config
   */
  private getQuickCommands():
    | { commands?: QuickCommand[]; groups?: QuickCommandGroup[] }
    | undefined {
    try {
      const configPath = (
        this.platform as unknown as { getConfigPath?: () => string }
      ).getConfigPath?.();

      if (!configPath) {
        this.log.debug('Could not get config path for quick-cmds');
        return undefined;
      }

      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf8');
        const config = yaml.load(content) as Record<string, unknown>;

        if (config['quick-cmds'] && typeof config['quick-cmds'] === 'object') {
          const quickCmds = config['quick-cmds'] as Record<string, unknown>;
          return {
            commands: Array.isArray(quickCmds['commands'])
              ? quickCmds['commands']
              : [],
            groups: Array.isArray(quickCmds['groups'])
              ? quickCmds['groups']
              : [],
          };
        }
      } else {
        this.log.debug('Config file not found at:', configPath);
      }
    } catch (error) {
      this.log.warn('Failed to read quick-cmds config:', error);
    }
    return undefined;
  }

  /**
   * Applies quick commands/snippets from remote sync
   */
  private async applyQuickCommands(remoteQuickCmds: {
    commands?: QuickCommand[];
    groups?: QuickCommandGroup[];
  }): Promise<void> {
    try {
      const configPath = (
        this.platform as unknown as { getConfigPath?: () => string }
      ).getConfigPath?.();

      if (!configPath) {
        this.log.warn('Could not get config path to apply quick-cmds');
        return;
      }

      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf8');
        config = yaml.load(content) as Record<string, unknown>;
      }

      // Merge quick-cmds config
      config['quick-cmds'] = {
        commands: remoteQuickCmds.commands || [],
        groups: remoteQuickCmds.groups || [],
      };

      // Write back to config
      const yamlContent = yaml.dump(config);
      fs.writeFileSync(configPath, yamlContent, 'utf8');

      this.log.info('Quick commands synced successfully');
    } catch (error) {
      this.log.warn('Failed to apply quick-cmds config:', error);
    }
  }

  /**
   * Checks for plugins present in remote but missing locally
   */
  private checkMissingPlugins(remotePlugins: string[]): void {
    const localPlugins = this.getInstalledPlugins();
    const missingPlugins = remotePlugins.filter(
      (p) => !localPlugins.includes(p),
    );

    if (missingPlugins.length > 0) {
      this.log.info('Found missing plugins:', missingPlugins);
      this.missingPlugins$.next(missingPlugins);

      // TODO: Use NotificationService to prompt user if available
      // For now, we log a prominent warning that user might see in DevTools
      console.warn(
        '[Tabby Sync] Missing plugins detected from sync: ' +
          missingPlugins.join(', ') +
          '. ' +
          'Please install them manually to match your other machine.',
      );
    } else {
      this.missingPlugins$.next([]);
    }
  }

  /**
   * Cleanup on destroy.
   */
  destroy(): void {
    this.stopWatchingChanges();
    this.clearPassword();
  }
}
