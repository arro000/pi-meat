# Contributing to pi-meat

Thanks for helping improve pi-meat.

## Before starting

- Search [existing issues](https://github.com/arro000/pi-meat/issues).
- Use issue before large feature, protocol change, dependency swap, or UX redesign.
- Report vulnerabilities privately per [SECURITY.md](SECURITY.md).
- Keep scope small and explain user-visible tradeoffs.

## Development setup

Requirements: Node.js 24+, Go 1.24.13+, Git, and Pi.

```bash
git clone https://github.com/arro000/pi-meat.git
cd pi-meat
npm ci
npm test
npm run check
npm run format:check
pi -e .
```

Build helper for faster local startup:

```bash
npm run build:bridge
```

## Pull requests

1. Branch from `main`.
2. Add or update tests for behavior change.
3. Update README, changelog, privacy/security docs when contract changes.
4. Run:

   ```bash
   npm run release:check
   npm pack --dry-run
   ```

5. Complete pull-request checklist.

Prefer focused commits with imperative subjects. Do not commit generated binaries, caches, credentials, private source, or `.pi-subagents/` artifacts.

## Code expectations

- TypeScript remains strict and uses existing formatting.
- Go code must pass `gofmt`, `go test`, and `go vet`.
- Child-process and protocol changes need malformed-input and cancellation tests.
- Any code handling diffs, paths, cache, terminal text, or environment variables needs security review.
- New dependencies need license, maintenance, and vulnerability review.

## Licensing

By submitting contribution, you agree it may be distributed under repository's [Apache License 2.0](LICENSE). No CLA or DCO sign-off is currently required.

## Governance

Maintainer makes final merge and release decisions. See [GOVERNANCE.md](GOVERNANCE.md).
