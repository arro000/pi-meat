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

1. The extension resolves the selected Git diff and the active or configured Pi model.
2. The local Go helper runs Meat's original `Abridge` engine without provider credentials.
3. For each `meat.Model.Generate` call, the helper sends provider-neutral messages and tools over the versioned JSONL pipe.
4. The extension performs the request through `pi-ai` in the Pi process, then returns the assistant response to Meat. Full provider response state stays in that model conversation.
5. Meat handles validation, chunking, folds, and elisions. The extension stores the original and reading diffs and opens the viewer.
6. Viewer comments are anchored to file, old/new side, line, and code snippet. On review, extension appends them to Pi's user message; original diff remains immutable.

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
