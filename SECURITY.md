# Security policy

pi-meat processes source-code diffs, launches a local Go helper, and sends model requests through Pi. Treat it as security-sensitive software.

## Supported versions

Security fixes are provided for latest published npm version only. Before first npm release, support applies to `main`.

| Version | Supported |
| --- | --- |
| Latest npm release | Yes |
| Older releases | No |
| Unreleased `main` | Best effort |

## Report vulnerability

Do not open public issue for suspected vulnerability.

Use [GitHub private vulnerability reporting](https://github.com/arro000/pi-meat/security/advisories/new). If GitHub reports that private reporting is unavailable, email `arrighi000@gmail.com` with subject `pi-meat security report`. Do not attach private source until encrypted transfer is agreed.

Include:

- affected version and platform;
- reproduction or proof of concept;
- impact and expected security boundary;
- suggested remediation, if known;
- whether report may be credited publicly.

Maintainer aims to acknowledge report within 5 business days, provide initial triage within 10 business days, and coordinate disclosure after fix is available. These are response targets, not service-level guarantees.

## Security boundaries

- Pi packages execute with full user permissions. Review source before installation.
- pi-meat sends selected Git diff and model conversation needed for abridgement to configured model provider.
- Repository file tools are disabled: bridge does not let model read unrelated, ignored, metadata, or symlinked files.
- Provider credentials are not intentionally passed to helper: they are excluded from bridge child environment, JSONL protocol, and cache.
- Helper is trusted, unsandboxed code with same OS user permissions. Environment filtering is data minimization, not process sandbox.
- Local cache contains plaintext source diffs and model output. Cache directories use mode `0700`; files use `0600` on POSIX systems.
- `PI_MEAT_BRIDGE` deliberately executes user-selected helper path. Set it only to trusted executable.
- `PI_MEAT_CACHE` and `PI_MEAT_SETTINGS` deliberately redirect local storage. Protect those locations appropriately.

See [Privacy and data flow](docs/PRIVACY.md) and [Architecture](docs/ARCHITECTURE.md).

## Remove local data

Close active pi-meat runs, then remove cache:

```bash
rm -rf ~/.pi/agent/cache/pi-meat
```

If `PI_MEAT_CACHE` is set, remove that directory instead.
