# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Documentation layout aligned with common open-source project norms (SECURITY, SUPPORT, CoC, issue/PR templates, CI).

## [0.1.3] - 2026-11-02

### Added

- `@agentoryhq/adapter-claude-code` — `indexSessions` + `readTranscript` (sessions/memory under `~/.claude/projects/<slug>/`; human-gate for tool_result-as-user rows; sidechain excluded).
- Host transcript routing across builtin adapters (`captureTranscriptForSourceKey`) so `claude-session:` keys resolve to the Claude adapter.
- Wire: optional `runtime` on session/memory index report items (additive; legacy payloads default to `cursor`).

## [0.1.2] - 2026-10-30

### Added

- **`invoke` capability** — execution face for the RuntimeAdapter contract:
  - `RuntimeAdapter.invoke?(ctx, req)` with `InvokeRequest` / `InvokeResult` (`outcome: done | failed | timeout`, byte-capped output with `truncated` flag, process-group kill on timeout).
  - `@agentoryhq/adapter-claude-code` implements invoke via headless single-shot runs (`claude -p`) under the default permission model — no permission-relaxing flags, no inbound ports (ADR-005 red lines).
  - Node daemon channel `message`: pulls locked pending messages from the control plane, executes them via the runtime adapter, reports outcomes.
  - Node daemon channel `github-task`: pulls claimed GitHub tasks, starts them, runs headless execution against the task branch (PR-only), reports results. Secrets masked in all error text.
- **Rules dimension** (desired-state alignment, phase 1 cursor-only):
  - `DesiredRule` / `LiveRuleBinding` wire types in `@agentoryhq/shared`; `AlignPatch.rules` is optional for old-node tolerance.
  - `@agentoryhq/adapter-cursor` discovers `.cursor/rules/*.mdc` and reports **name + sha256 only** — rule bodies never leave the node.
  - Cursor align writes rule bodies verbatim (hash contract: file bytes = body bytes, no trailing newline), snapshots pre-existing files before overwrite, and defensively skips unsafe rule names.
  - `@agentoryhq/adapter-claude-code` reports an empty rules list and ignores `patch.rules` (honest boundary for phase 1).
- New tests: invoke (headless run harness), registry capability honesty, mock-runtime, github-task unit (prompt/git masking), rules discover/align.
- `scripts/mock-claude.mjs` — deterministic mock runtime for invoke tests.

### Notes

- `invoke` stays optional in the contract: adapters without an execution face simply omit it, and the node daemon honestly reports `no invoke adapter for runtime <id>` instead of silently dropping work.
- Node daemon align results now carry `rulesDir` / `rulesSnapshotDir` when a rules write happened.
- This release was synced from the control plane after agent-messaging / github-tasks / rules-desired-config landed there; npm publish of `0.1.2` was deferred and ships together with `0.1.3`.

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

[Unreleased]: https://github.com/tunsuy/agentory-node/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/tunsuy/agentory-node/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/tunsuy/agentory-node/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/tunsuy/agentory-node/releases/tag/v0.1.1
