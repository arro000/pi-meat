# Changelog

All notable changes to pi-meat are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Updated pinned GitHub Actions.
- Switched npm releases from a static token to OIDC trusted publishing.

### Security

- Neutralized Unicode bidirectional controls in terminal-rendered diff content.
- Added full development-toolchain auditing while retaining stricter runtime dependency gates.

## [0.1.0] - 2026-08-04

### Added

- Pi extension package with `/meat`, `/meat-settings`, and model picker.
- Meat-to-Pi JSONL bridge using existing authenticated Pi model.
- Cached reading/original diff artifacts and verification-oriented review handoff.
- Responsive syntax-aware viewer with unified and side-by-side layouts.
- Keyboard, pointer, vertical wheel, and horizontal wheel navigation.
- Added/removed line foreground and subtle background styling.
- Open-source community, security, privacy, architecture, and release documentation.

### Security

- Disabled model-driven repository file and grep tools; only selected diff is sent for abridgement.
- Removed ambient credentials and unrelated variables from helper environment.
- Restricted cache directories/files to owner-only POSIX permissions.
- Added strict bridge event validation, protocol negotiation, and terminal-text sanitization.

[Unreleased]: https://github.com/arro000/pi-meat/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/arro000/pi-meat/releases/tag/v0.1.0
