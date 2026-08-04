# pi-meat implementation plan

## Product contract

pi-meat turns Meat's abridgement engine into a first-class Pi reading experience. It uses the active model and subscription already authenticated in Pi; provider credentials are never handed to the Go child process.

## Architecture

1. **Git source adapter** selects HEAD, a revision/range, staged, unstaged, or all local changes.
2. **Go bridge** imports `meat.dev/meat`, disables repository read/grep tools, and implements only its `Model` boundary over versioned JSONL.
3. **Pi model adapter** converts Meat messages/tools to `pi-ai`, preserving the full assistant response as opaque provider state between Meat turns.
4. **Artifact cache** keys immutable input + active model + bridge protocol and stores original/reading diffs outside the repository.
5. **TUI viewer** navigates files and lines, folds files, toggles original/reading views, and hands review back to Pi.

## Delivery milestones

- [x] Repository/package foundation and publication metadata
- [x] Meat-to-Pi JSONL bridge
- [x] Active Pi subscription model adapter
- [x] Git source selection and cache artifacts
- [x] Navigable reading/original diff viewer
- [x] Review handoff to Pi
- [x] Interactive persistent model picker
- [ ] Interactive source picker
- [x] Responsive side-by-side mode with changed-file sidebar
- [ ] Search and hunk-level review handoff
- [x] Open-source governance, security/privacy docs, and npm release automation
- [x] Helper environment isolation, strict protocol validation, and private cache permissions
- [ ] Prebuilt signed bridge binaries
- [ ] End-to-end PTY/TUI tests against a fake model

## Validation contract for the MVP

- TypeScript compiles in strict mode.
- Go bridge tests/build pass against the pinned Meat module.
- Diff parser tests cover commit preambles, files, hunks, additions, and deletions.
- A local smoke test can run the bridge with a deterministic fake JSONL model.
- No provider credential is serialized into bridge requests, cache files, or UI artifacts.
