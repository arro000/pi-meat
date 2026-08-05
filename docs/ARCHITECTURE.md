# Architecture

pi-meat turns Meat's diff abridgement engine into a Pi-native reading workflow.

```text
Git selector
    │ unified diff
    ▼
Pi extension (TypeScript)
    │ versioned JSONL, no provider credentials
    ▼
Meat helper (Go)
    │ provider-neutral model request
    ▼
Pi extension → pi-ai → configured provider
```

## Runtime flow

1. The extension resolves the selected Git diff, configured Pi model, model-supported Meat thinking level, and startup mode.
2. The viewer opens immediately on the original diff and keeps Meat's state visible below the Reading/Original choices. In `default` mode abridgement starts immediately; in `on-demand` mode it starts only after the user opens Reading and presses `Enter`. A cached reading diff requires no new run.
3. The local Go helper runs Meat's original `Abridge` engine without provider credentials.
4. For each `meat.Model.Generate` call, the helper sends provider-neutral messages and tools over the versioned JSONL pipe.
5. The extension performs the request through `pi-ai` in the Pi process, then returns the assistant response to Meat. Full provider response state stays in that model conversation.
6. Meat handles validation, chunking, folds, and elisions. The extension stores the original and reading diffs, updates the open viewer in place, and marks Reading with `✨`.
7. The viewer marks commented files and lines, and opens an overlaid dialog to inspect or edit the selected comment. Each comment is anchored to file, old/new side, line, and code snippet. On review, the extension appends them to Pi's user message; the original diff remains immutable.

Repository read and grep tools are disabled. The model receives the selected Git diff and abridgement conversation, not unrelated repository files.

## Components

- `extensions/pi-meat/index.ts`: command lifecycle, Git selection, model resolution, cache, viewer and review handoff.
- `extensions/pi-meat/bridge.ts`: helper process lifecycle, environment isolation, JSONL transport, cancellation and validation.
- `extensions/pi-meat/protocol.ts`: versioned wire types and Pi/Meat message conversion.
- `extensions/pi-meat/viewer.ts`: responsive syntax-aware TUI viewer and session-scoped line comments.
- `internal/diff.ts`: terminal-safe unified diff parser.
- `bridge/main.go`: narrow adapter around pinned `meat.dev` module.

## Trust boundaries

1. **Git checkout** is untrusted input. Git output and decoded paths may contain terminal controls.
2. **Go helper** is trusted, unsandboxed local child process with same OS user permissions. It receives selected diff and allowlisted runtime environment; provider credentials are not intentionally passed.
3. **Model provider** receives selected diff and abridgement conversation. Repository tools are disabled.
4. **Cache** stores plaintext diffs/model output locally with owner-only POSIX permissions.
5. **Viewer** treats diff, paths, model summaries, and progress as untrusted terminal text.

## Protocol

Extension starts helper, sends one `abridge` request, waits for versioned `ready`, answers zero or more `generate` requests, then accepts one `result` or `error`. Unknown, malformed, out-of-order, wrong-version, and oversized events are rejected.

## Distribution

Current npm package ships Go source and runs `go run` when trusted prebuilt helper is absent. Therefore Go 1.24.13+ remains runtime requirement. Prebuilt signed binaries are planned but not yet release contract.
