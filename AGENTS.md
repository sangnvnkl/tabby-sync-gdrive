# Repository Guidelines

## Project Structure & Module Organization

This repository is a TypeScript Tabby plugin that syncs Tabby settings through Google Drive. Source lives in `src/`: `index.ts` registers the plugin, `config.provider.ts` provides settings integration, `components/` contains the Angular settings UI, `services/` contains sync, Google Drive, and crypto logic, `utils/` contains focused helpers, and `interfaces/`/`types/` define local contracts and Tabby typings. Build output goes to `dist/` and should not be edited. `scripts/install.js` installs the built plugin locally. `support-for-me/` contains README donation assets.

## Build, Test, and Development Commands

- `yarn install --frozen-lockfile`: install dependencies exactly as locked; this is what CI uses.
- `yarn build`: run webpack in production mode and emit `dist/index.js`, declarations, copied `package.json`, and README.
- `yarn watch`: rebuild continuously for local development.
- `yarn lint`: run ESLint over `src/**/*.ts`.
- `yarn clean`: remove `dist/`.
- `yarn install-plugin`: install the plugin into the local Tabby plugin location after building.

## Coding Style & Naming Conventions

Use TypeScript with strict compiler settings. Follow the existing ESLint rules: 2-space indentation, semicolons, single quotes, trailing commas for multiline constructs, `const` when possible, no `var`, and strict equality. Unused parameters should be prefixed with `_`. Keep filenames lowercase with role suffixes such as `sync.service.ts`, `merge.util.ts`, `settings.component.ts`, and `sync.interface.ts`.

## Testing Guidelines

There is currently no committed automated test suite. Before submitting changes, run `yarn lint` and `yarn build`; for behavior changes, manually verify in Tabby using `yarn install-plugin`. If adding tests, place them near the relevant source or in a dedicated `test/` directory, use clear names like `crypto.service.spec.ts`, and cover encryption, merge conflict handling, path mapping, and Google Drive error paths.

## Commit & Pull Request Guidelines

Recent history uses short release commits such as `1.0.19` and Conventional Commit-style messages such as `feat(sync): ...`, `perf(sync): ...`, and `docs: ...`. Prefer the Conventional Commit form for source changes. Pull requests should include a concise description, user-visible impact, verification steps (`yarn lint`, `yarn build`, Tabby manual checks), linked issues when relevant, and screenshots for settings UI changes.

## Security & Configuration Tips

Do not commit secrets, OAuth credentials, local Tabby config, generated `dist/` edits, or machine-specific paths. Preserve the project’s privacy boundary: SSH private keys and local-only paths must not be uploaded or logged.
