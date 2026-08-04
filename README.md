<div align="center">

# 🥩 pi-meat

### Read the change. Skip the gristle

A navigable reading-diff experience for [Pi](https://pi.dev), powered by [Meat](https://meat.dev) and the model subscription you already use in Pi.

</div>

## Why pi-meat?

Agent-written changes can be large even when their core idea is small. Meat reduces a unified diff to the lines a senior engineer needs for understanding behavior, data flow, and architecture. pi-meat keeps that engine intact and adds:

- your active Pi model and subscription—no second API key;
- a keyboard-driven file and diff viewer;
- instant switching between Meat's reading diff and the immutable original;
- cached, inspectable artifacts;
- a one-key handoff from reading to a verification-oriented Pi review.

> Meat abridges diffs; it does not prove correctness. pi-meat's review handoff explicitly asks Pi to verify findings against the original diff and repository source.

## Status

Early MVP. The bridge, subscription adapter, cache, viewer, and review handoff are implemented. See [PLAN.md](PLAN.md) for the roadmap.

## Install for development

Requirements: Pi, Node.js 24+, Go 1.24+, and Git.

```bash
npm install
pi -e .
```

The first run uses `go run` and may download the pinned `meat.dev` module. For faster startup:

```bash
npm run build:bridge
pi -e .
```

A future release will ship prebuilt bridge binaries.

## Usage

Authenticate and select desired model in Pi. Meat uses Pi's active model by default. Set persistent Meat model with `/meat-settings` or `Ctrl+Shift+M`; picker lists authenticated Pi models. `/meat settings` remains an alias. Settings live in `~/.pi/agent/pi-meat.json` (override with `PI_MEAT_SETTINGS`).

Then:

```text
/meat                         latest commit
/meat staged                  staged changes
/meat worktree                unstaged changes
/meat all                     staged + unstaged changes
/meat main...HEAD             branch diff
/meat <revision>              a specific commit
/meat HEAD --fresh            bypass pi-meat's cache
```

### Viewer keys

| Key | Action |
| --- | --- |
| `j` / `k`, `↑` / `↓` | Scroll vertically |
| `h` / `l`, `←` / `→` | Scroll source horizontally in synchronized panes |
| `PgUp` / `PgDn`, `Home` / `End` | Page or jump through current file |
| `n` / `p` | Next / previous changed file |
| `s` | Toggle side-by-side / unified layout |
| Mouse click / wheel | Select sidebar file / scroll current diff |
| `Space` | Fold / unfold current file |
| `Tab` | Toggle reading / original diff |
| `r` | Close viewer and ask Pi for verified review |
| `?` | Toggle help |
| `q` / `Esc` | Close |

Wide terminals render changed-file sidebar plus old/new panes. Medium terminals keep full-width side-by-side panes. Narrow terminals automatically use unified layout. Click sidebar entries to select files; mouse wheel scrolls changes. Hold Shift for terminal-native text selection while mouse reporting is active. Source code uses file-aware syntax highlighting; line numbers and `+`/`-` gutters preserve diff semantics. Footer always shows primary navigation keys plus current line and column ranges.

## How subscription reuse works

The Go process runs Meat's original `Abridge` engine but has no provider credentials. At every `meat.Model.Generate` call it sends provider-neutral messages and tools over a local JSONL pipe. The extension performs that request in-process through `pi-ai` using configured Meat model and Pi's resolved authentication, then returns the assistant response to Meat.

```text
meat.Abridge → JSONL bridge → pi-ai → active Pi subscription
```

Full provider response state is preserved between Meat turns, while Meat remains responsible for its own tools, validation, chunking, folds, and elisions.

## Privacy and artifacts

- Credentials never enter bridge messages or cache files.
- Source diffs are sent to the active model provider, just as with other Pi model calls.
- Cached artifacts live under `~/.pi/agent/cache/pi-meat/` by default.
- Override the cache root with `PI_MEAT_CACHE`.
- Override the helper executable with `PI_MEAT_BRIDGE=/path/to/pi-meat-bridge`.

## Development

```bash
npm test
npm run check
npm run build:bridge
```

## Naming and attribution

pi-meat is an independent Pi integration. It is not affiliated with or endorsed by Bold Software, Inc. Meat is licensed under Apache-2.0; see [NOTICE](NOTICE).

## License

Apache-2.0 © 2026 arro000
