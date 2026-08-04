# Architecture

pi-meat turns Meat's diff abridgement engine into Pi-native reading workflow.

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

## Components

- `extensions/pi-meat/index.ts`: command lifecycle, Git selection, model resolution, cache, viewer and review handoff.
- `extensions/pi-meat/bridge.ts`: helper process lifecycle, environment isolation, JSONL transport, cancellation and validation.
- `extensions/pi-meat/protocol.ts`: versioned wire types and Pi/Meat message conversion.
- `extensions/pi-meat/viewer.ts`: responsive syntax-aware TUI viewer.
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
