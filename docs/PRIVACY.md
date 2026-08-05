# Privacy and data flow

## Data sent to model provider

- selected Git diff;
- Meat system instructions and abridgement conversation;
- local validation-tool results derived only from selected diff;
- provider state needed to continue same model conversation.

Repository read/grep tools are disabled. pi-meat does not intentionally send unrelated repository files, ignored files, `.git` metadata, or local cache contents.

Provider handling, retention, and training policies depend on model/provider configured in Pi. Review provider policy before processing sensitive code.

## Data kept local

Default cache: `~/.pi/agent/cache/pi-meat/`

- `original.diff`: selected immutable Git diff;
- `reading.diff`: Meat reading diff;
- `result.json`: summary, token counts, source selector, and model label;
- `current.json`: active cache generation pointer.

Default settings: `~/.pi/agent/pi-meat.json`

- selected default model label, Meat thinking level, and startup mode;
- no API key or provider credential.

Cache is plaintext. On each run, pi-meat recursively tightens current and legacy cache trees to `0700` directories and `0600` files on POSIX systems. Disk encryption, backups, administrator access, malware, and custom cache locations remain outside pi-meat control.

## Credentials

Provider authentication is resolved and used in Pi process. Credentials are not intentionally serialized into JSONL messages, cache, or helper environment. Helper receives allowlisted runtime variables only; token/API-key/cloud credential variables are excluded. Helper remains trusted, unsandboxed code with same OS user permissions.

## Retention and deletion

Cache has no automatic expiry yet. Delete it manually:

```bash
rm -rf ~/.pi/agent/cache/pi-meat
```

Use `PI_MEAT_CACHE` to choose another location. Use `--fresh` to bypass cached result for one run; this creates new generation and does not delete older data.

## Telemetry

pi-meat adds no independent analytics or telemetry. Network traffic consists of provider calls made through Pi and possible Go module downloads when helper falls back to `go run`.
