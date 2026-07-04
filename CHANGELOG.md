# Changelog

All notable changes to this project are documented here. This file is generated
from the git history by [git-cliff](https://git-cliff.org).

## [0.1.0] - 2026-07-04

### CI/Build

- Reliable Android release builds on GitHub-hosted runners
- Split fast checks from the heavy build + reclaim runner disk

### Documentation

- Roadmap handoff for deferred work
- Document the release pipeline in CLAUDE.md

### Features

- Export/import app settings (backup & restore) (#5)
- Organize job uploads into date folders by file mtime (#4)

### Other

- Add server folder browser to job remote-path field (#3)
- Phase 2: F-Droid recipe, MIT license, non-free-deps CI gate
- Phase 1: Dagger-on-Nix release build core + GitHub Releases CI
- Phase 0: publishable app identity, de-Googled notifications, release signing
- Document full dev-environment bring-up in README
- Phase 6 (core): periodic background triggers, constraints, foreground service
- Phase 5: dashboard polish + per-file error surfacing
- Drop unused READ_MEDIA_AUDIO from manifest
- Phase 4: camera-roll source via expo-media-library
- Add Test connection buttons to server + job config screens
- Plan test-connection buttons for server + job config screens
- Add imagemagick to devShell for screenshot downscaling
- Document copyparty-server testing workflow in CLAUDE.md
- Document emulator control + devShell wrapping in CLAUDE.md
- Document NixOS Android emulator workflow in README
- Phase 3 PR B: Jobs tab + sync-now UI + live progress
- Phase 3 PR A: SAF walker + sync engine + progress bus
- Fix server-password SecureStore key
- Add reproducible Android dev build environment via nix flake
- Phase 2: SQLite schema + DAOs + secure-store + servers CRUD UI
- Phase 1: up2k protocol core + copyparty-sha512 native module
- Initial-plan
- Add CLAUDE.md and ignore .idea/
- Update package-lock.json peer metadata
- Initial commit


