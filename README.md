# agentory-node

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@agentoryhq/node.svg)](https://www.npmjs.com/package/@agentoryhq/node)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

Open-source **Agentory Node**: the Host daemon, **RuntimeAdapter** contract, and in-tree adapters that discover and safely align MCP/Skill (and related) config for coding Agents (Cursor, Claude Code, …).

Community contributions add **how to detect / read / write a given Agent runtime**.  
The Agentory **control plane** (API, Console, seats, billing) lives in a **separate private product repository** and is not part of this project.

| In this repo (Apache-2.0) | Not in this repo |
|---------------------------|------------------|
| `apps/node` — Host CLI `agentory-node` | Control plane API |
| `packages/runtime-contract` | Console UI |
| `adapters/*` | Seats / quotas / audit enforcement |
| `@agentoryhq/shared` wire/DTO types | Hosted SaaS |

**Extension model (phase 1):** in-tree `adapters/<id>` pull requests only — no third-party dynamic adapter loader.

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [Packages](#packages)
- [Develop](#develop)
- [Add an adapter](#add-an-adapter)
- [Documentation](#documentation)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

## Install

npm scope is **`@agentoryhq`** (the unscoped name `agentory` is already taken on the public registry).

```bash
# Run without a global install
npx -y @agentoryhq/node version

# Or install the CLI
npm install -g @agentoryhq/node
agentory-node version
```

From this repository (development):

```bash
npm install
npm run build
node apps/node/dist/cli.js version
```

## Quick start

Point the node at your Agentory control plane, then register and run the daemon:

```bash
export CONTROL_PLANE_BASE_URL=https://your-agentory.example
agentory-node register --token <node-root-token>
agentory-node daemon
```

Useful commands:

| Command | Purpose |
|---------|---------|
| `agentory-node discover` | Report local Agents / MCP / skills |
| `agentory-node align` | Apply confirmed align plans |
| `agentory-node asset-index` | Report session/memory metadata index |
| `agentory-node daemon [--once]` | Heartbeat + channels on a schedule |
| `agentory-node --help` | Full usage |

## Packages

| Package | Role |
|---------|------|
| [`@agentoryhq/node`](https://www.npmjs.com/package/@agentoryhq/node) | Host CLI (`agentory-node`) |
| [`@agentoryhq/runtime-contract`](https://www.npmjs.com/package/@agentoryhq/runtime-contract) | `RuntimeAdapter` manifest & capabilities |
| [`@agentoryhq/shared`](https://www.npmjs.com/package/@agentoryhq/shared) | Wire / DTO types |
| [`@agentoryhq/adapter-cursor`](https://www.npmjs.com/package/@agentoryhq/adapter-cursor) | Cursor reference adapter |
| [`@agentoryhq/adapter-claude-code`](https://www.npmjs.com/package/@agentoryhq/adapter-claude-code) | Claude Code adapter |

## Develop

Requirements: **Node.js ≥ 20**.

```bash
npm install
npm run build
npm test
```

Layout:

```
apps/node/                 # Host
packages/runtime-contract/ # Adapter API
packages/shared/           # Shared types
adapters/cursor/           # Reference adapter
adapters/claude-code/      # Second runtime
docs/                      # Contributor guides
```

## Add an adapter

1. Read [docs/how-to-write-an-adapter.md](docs/how-to-write-an-adapter.md).
2. Follow the checklist in [CONTRIBUTING.md](CONTRIBUTING.md).
3. Open a PR against this repository.

## Documentation

| Doc | Description |
|-----|-------------|
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |
| [docs/how-to-write-an-adapter.md](docs/how-to-write-an-adapter.md) | Adapter authoring guide |
| [adapters/README.md](adapters/README.md) | Adapter directory conventions |
| [SECURITY.md](SECURITY.md) | Vulnerability reporting |
| [SUPPORT.md](SUPPORT.md) | Where to ask for help |
| [CHANGELOG.md](CHANGELOG.md) | Release notes |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Community standards |

## Security

Do not file security issues in public GitHub issues. See [SECURITY.md](SECURITY.md).

Hard rules for adapters and Host code:

- No default unauthenticated full-disk scan or SSH “takeover”
- No secrets / tokens in commits or logs
- Align writes only after **confirmed** control-plane plans

## Contributing

We welcome PRs that add or improve adapters and Host fixes that stay runtime-agnostic.  
Please read [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
