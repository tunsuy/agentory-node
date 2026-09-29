# agentory-node

Open-source **Agentory Node**: Host daemon + **RuntimeAdapter** contract + in-tree adapters.

Contribute how to **detect / discover / safely write** a given Agent runtime.  
The Agentory **control plane** (API, Console, seats, billing) is **not** in this repository.

| In this repo (Apache-2.0) | Not here (product) |
|---------------------------|--------------------|
| `apps/node` — Host (`agentory-node` CLI) | Control plane API |
| `packages/runtime-contract` | Console UI |
| `adapters/*` (Cursor, Claude Code, …) | Seats / quotas / audit enforcement |
| `@agentoryhq/shared` wire/DTO types | Hosted SaaS |

Architecture summary (ADR-004): open-source Host + RuntimeAdapter contract + in-tree `adapters/*` PRs; control plane stays product-side. No third-party dynamic adapter loader in phase 1.

## Install

```bash
# After npm publish (@agentoryhq — unscoped name "agentory" is taken on npm):
npx -y @agentoryhq/node version

# From this repo (development):
npm install
npm run build
node apps/node/dist/cli.js version
```

Point the node at your control plane:

```bash
export CONTROL_PLANE_BASE_URL=https://your-agentory.example
agentory-node register --token <node-root-token>
agentory-node daemon
```

## Develop

```bash
npm install
npm run build
npm test
```

## Add an adapter

See [docs/how-to-write-an-adapter.md](docs/how-to-write-an-adapter.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

Phase-1 extension model: **in-tree `adapters/<id>` PR** (no third-party dynamic loader).

## License

Apache License 2.0 — see [LICENSE](LICENSE).
