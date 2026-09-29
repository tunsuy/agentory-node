# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Documentation layout aligned with common open-source project norms (SECURITY, SUPPORT, CoC, issue/PR templates, CI).

## [0.1.1] - 2026-09-29

### Added

- Initial public release of **agentory-node** (Apache-2.0).
- Host CLI `@agentoryhq/node` (`agentory-node`): register, discover, align, asset-index, transcript, daemon.
- `@agentoryhq/runtime-contract` — RuntimeAdapter manifest and capabilities.
- `@agentoryhq/shared` — wire / DTO types.
- `@agentoryhq/adapter-cursor` — Cursor reference adapter.
- `@agentoryhq/adapter-claude-code` — Claude Code discover + align.
- Contributor docs: README, CONTRIBUTING, how-to-write-an-adapter.

### Notes

- npm scope is `@agentoryhq` because the unscoped package name `agentory` is already taken on the public registry.
- Phase 1 accepts **in-tree** `adapters/*` PRs only (no dynamic third-party loader).

[Unreleased]: https://github.com/tunsuy/agentory-node/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/tunsuy/agentory-node/releases/tag/v0.1.1
