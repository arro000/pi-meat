<div align="center">

# 🥩 pi-meat

### Read the change. Skip the gristle

Navigable reading diffs for [Pi](https://pi.dev), powered by [Meat](https://meat.dev) and model subscription already used in Pi.

[![CI](https://github.com/arro000/pi-meat/actions/workflows/ci.yml/badge.svg)](https://github.com/arro000/pi-meat/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40andreaarrighi%2Fpi-meat)](https://www.npmjs.com/package/@andreaarrighi/pi-meat)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

![pi-meat preview](assets/pi-meat-preview.png)

</div>

## Why pi-meat?

Agent-written changes can be large even when core idea is small. Meat reduces unified diff to lines needed to understand behavior, data flow, and architecture. pi-meat keeps original diff one key away and adds:

- active Pi model/subscription—no second API key;
- syntax-aware keyboard and mouse diff viewer;
- reading/original toggle and synchronized side-by-side panes;
- private local artifacts for inspection;
- one-key handoff to verification-oriented Pi review.

> Meat abridges diffs; it does not prove correctness. Review handoff asks Pi to verify findings against original diff and repository source.

## Status

`0.1.x` is early public release. Commands, cache layout, and bridge protocol may evolve before `1.0.0`. See [changelog](CHANGELOG.md) and [roadmap](PLAN.md).

## Requirements

- Pi
- Node.js 24+
- Go 1.24.13+
- Git

Current npm package ships bridge source and falls back to `go run`; prebuilt helper binaries are planned.

## Install

From npm (recommended after `0.1.0` publication):

```bash
pi install npm:@andreaarrighi/pi-meat
```

Pin exact release:

```bash
pi install npm:@andreaarrighi/pi-meat@0.1.0
```

Install tagged Git source:

```bash
pi install git:github.com/arro000/pi-meat@v0.1.0
```

Try without persistent install:

```bash
pi -e npm:@andreaarrighi/pi-meat
```

Packages execute with full user permissions. Review source and [security policy](SECURITY.md) before installation.

## Usage

Authenticate and select desired model in Pi. Meat uses active Pi model by default. Set persistent Meat model with `/meat-settings` or `Ctrl+Shift+M`; `/meat settings` remains alias. Settings live in `~/.pi/agent/pi-meat.json` (override with `PI_MEAT_SETTINGS`).

```text
/meat                         latest commit
/meat staged                  staged changes
/meat worktree                unstaged changes
/meat all                     staged + unstaged changes
/meat main...HEAD             branch diff
/meat <revision>              specific commit
/meat HEAD --fresh            bypass current cache entry
```

### Viewer keys

| Key | Action |
| --- | --- |
| `j` / `k`, `↑` / `↓` | Scroll vertically |
| `h` / `l`, `←` / `→` | Scroll source horizontally |
| Horizontal wheel / `Shift` + wheel | Scroll source horizontally with supported terminals/mice |
| `PgUp` / `PgDn`, `Home` / `End` | Page or jump through current file |
| `n` / `p` | Next / previous changed file |
| `s` | Toggle side-by-side / unified layout |
| Mouse click / wheel | Select sidebar file / scroll current diff |
| `Space` | Fold / unfold current file |
| `Tab` | Toggle reading / original diff |
| `r` | Close viewer and ask Pi for verified review |
| `?` | Toggle help |
| `q` / `Esc` | Close |

Wide terminals show file sidebar and old/new panes. Medium terminals keep full-width side-by-side panes. Narrow terminals switch to unified layout. Hold `Shift` for terminal-native selection when mouse reporting is active.

## How subscription reuse works

Go helper runs original Meat `Abridge` engine without provider credentials. At each `meat.Model.Generate`, it sends provider-neutral messages/tools over local versioned JSONL pipe. Extension performs model request in Pi process through `pi-ai`, then returns assistant response to Meat.

```text
meat.Abridge → local JSONL helper → pi-ai → configured Pi provider
```

Repository read/grep tools are disabled. Model receives selected Git diff and abridgement conversation, not unrelated repository files. Full provider response state remains in model conversation while Meat handles validation, chunking, folds, and elisions.

See [architecture](docs/ARCHITECTURE.md) and [privacy/data flow](docs/PRIVACY.md).

## Privacy and local artifacts

- Provider credentials are not intentionally passed to helper; they are excluded from helper environment, JSONL, and cache.
- Helper is trusted, unsandboxed code running with same OS user permissions.
- Selected diff is sent to configured model provider.
- Cache defaults to `~/.pi/agent/cache/pi-meat/`.
- POSIX cache directories/files use owner-only permissions (`0700` / `0600`).
- Cache is plaintext and has no automatic expiry yet.
- Override cache root with `PI_MEAT_CACHE`.
- Override helper only with trusted executable via `PI_MEAT_BRIDGE=/path/to/pi-meat-bridge`.

Delete default cache:

```bash
rm -rf ~/.pi/agent/cache/pi-meat
```

## Development

```bash
git clone https://github.com/arro000/pi-meat.git
cd pi-meat
npm ci
npm run release:check
pi -e .
```

Build helper for faster startup:

```bash
npm run build:bridge
```

Contributions: [CONTRIBUTING.md](CONTRIBUTING.md) · Support: [SUPPORT.md](SUPPORT.md) · Security: [SECURITY.md](SECURITY.md) · Releases: [docs/RELEASING.md](docs/RELEASING.md)

## Publishing and Pi catalog

Package publishes as [`@andreaarrighi/pi-meat`](https://www.npmjs.com/package/@andreaarrighi/pi-meat) with npm provenance. Pi catalog automatically discovers public npm packages tagged `pi-package`; no manual submission is documented. Catalog indexing has no published SLA.

After release, verify [package page](https://pi.dev/packages/@andreaarrighi/pi-meat). Full maintainer procedure: [docs/RELEASING.md](docs/RELEASING.md).

## Naming and attribution

pi-meat is independent integration. It is not affiliated with or endorsed by Pi maintainers or Bold Software, Inc. Meat is licensed under Apache-2.0; see [NOTICE](NOTICE). Brand usage: [docs/BRAND.md](docs/BRAND.md).

## License

[Apache-2.0](LICENSE) © 2026 arro000
