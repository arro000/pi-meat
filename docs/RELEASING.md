# Releasing

Only maintainer publishes releases.

## 1. Prerequisites

- npm account owns `@andreaarrighi` scope/name and has 2FA enabled.
- GitHub repository is public at `arro000/pi-meat`.
- `main` branch and `v*` tags are protected with repository rulesets.
- GitHub `npm` environment exists with required reviewer/tag restrictions.
- GitHub private vulnerability reporting is enabled (email fallback remains documented).
- Working tree is clean and CI passes on `main`.

Current package ships Go source, not platform binaries. Go 1.24.13+ runtime requirement must remain visible until binary distribution is implemented.

Align GitHub About metadata before first release:

```bash
gh repo edit arro000/pi-meat \
  --description "Navigable reading diffs for Pi, powered by Meat and your existing Pi model." \
  --homepage "https://pi.dev/packages/@andreaarrighi/pi-meat" \
  --add-topic pi-package --add-topic pi-extension --add-topic code-review --add-topic git-diff
```

Repository rules, environment protection, private reporting, npm ownership, and secrets are host settings; repository files cannot enable them.

## 2. Prepare version

```bash
npm version <patch|minor|major> --no-git-tag-version
```

Update `CHANGELOG.md`, verify docs, then run:

```bash
npm ci
npm run release:check
```

`release:check` builds exact tarball, installs it in temporary clean consumer, and verifies manifest plus required package files. Also inspect `npm pack --dry-run` output manually before first release.

## 3. Configure npm trusted publishing

Configure npm package **Settings → Trusted Publisher**:

- provider: GitHub Actions;
- owner: `arro000`;
- repository: `pi-meat`;
- workflow: `release.yml`;
- environment: `npm`.

The release workflow uses GitHub OIDC and does not require an `NPM_TOKEN` secret.

## 4. Tag and publish

```bash
git tag -s vX.Y.Z -m "pi-meat vX.Y.Z"
git push origin main vX.Y.Z
```

`.github/workflows/release.yml` validates tag/version parity, tests, audits, smoke-tests exact tarball, publishes npm package with provenance, and creates GitHub release.

## 5. Verify npm and Pi catalog

```bash
npm view @andreaarrighi/pi-meat name version keywords pi repository --json
pi -e npm:@andreaarrighi/pi-meat@X.Y.Z
pi install npm:@andreaarrighi/pi-meat@X.Y.Z
```

Check:

- <https://www.npmjs.com/package/@andreaarrighi/pi-meat>
- provenance/source metadata on npm;
- <https://pi.dev/packages/@andreaarrighi/pi-meat>
- <https://pi.dev/packages?name=%40andreaarrighi%2Fpi-meat>

Pi catalog discovers npm packages tagged `pi-package`; no manual submission is documented. Indexing has no published SLA and may lag. If absent after 24–48 hours, confirm npm visibility and keyword search first, then report reproducible catalog indexing issue upstream.

## 6. Rollback

npm versions are immutable. Never reuse version. For bad release:

- deprecate affected version with clear message;
- publish fixed patch;
- update GitHub release and security advisory if applicable.

Avoid unpublish except npm policy and urgent security/legal case permit it.
