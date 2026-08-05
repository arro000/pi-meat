# AGENTS.md

## Project

pi-meat is a TypeScript Pi extension with a Go bridge. It turns Git diffs into smaller reading diffs and opens them in a navigable viewer.

## Repository layout

- `extensions/pi-meat/`: Pi extension, viewer, cache, settings, and bridge client
- `bridge/`: Go abridgement bridge
- `internal/`: shared Go logic
- `test/`: TypeScript tests
- `docs/`: architecture, privacy, release, and brand documentation

## Development

- Use Node.js 24+.
- Install dependencies with `npm install`.
- Run `npm test` for tests.
- Run `npm run check` for TypeScript and Go checks.
- Run `npm run format:check` for Go formatting.

## Change rules

- Keep user-facing text in English.
- Preserve `/meat` CLI shortcuts when changing interactive behavior.
- Update `README.md` and relevant files in `docs/` when commands, menus, settings, or data flow change.
- Do not expose repository tools to the nested model call unless explicitly required by protocol changes.
- Keep original diffs immutable and verify review findings against original diffs.
- Never commit secrets, cache artifacts, generated binaries, or local settings.

## Validation

Before finishing, run at least `npm run check`. Run `npm test` when behavior or parsing changes. Report any unavailable external dependency or pre-existing failure.
