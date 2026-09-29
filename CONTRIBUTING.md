# Contributing to agentory-node

Thanks for helping grow Agent runtime coverage. By participating, you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Adapters** under `adapters/<runtime-id>/` (primary)
- Host bugfixes that do **not** hard-code a single runtime’s paths inside Host core
- Docs, fixtures, and CI improvements
- Bug reports and feature requests via [GitHub Issues](https://github.com/tunsuy/agentory-node/issues)

## Out of scope (please don’t open PRs for)

- Control plane API, Console UI, seats, billing, or hosted SaaS
- Default unauthenticated full-disk scan or SSH “takeover”
- Secrets, tokens, or `.env` contents in commits or logs
- Making rulesync / add-mcp (or similar) a **Host kernel** dependency
- Dynamic third-party adapter loading (phase 1 is **in-tree PRs only**)

## Development setup

```bash
git clone https://github.com/tunsuy/agentory-node.git
cd agentory-node
npm install
npm run build
npm test
```

Requires **Node.js ≥ 20**.

## Add a runtime (checklist)

1. Copy `adapters/claude-code` → `adapters/<id>/`.
2. Rename the package to `@agentoryhq/adapter-<id>` in `package.json`.
3. Implement `RuntimeAdapter` (`@agentoryhq/runtime-contract`): at least `detect`; declare `capabilities` honestly.
4. Register the adapter in `apps/node/src/registry.ts` (`builtinAdapters`).
5. Add fixture tests (temp directories; assert discover / refuse unconfirmed align).
6. Update `adapters/README.md`.
7. Open a pull request.

Details: [docs/how-to-write-an-adapter.md](docs/how-to-write-an-adapter.md).

## Pull requests

1. Fork (or branch) from `main`.
2. Keep changes focused; one runtime or one Host fix per PR when possible.
3. Ensure `npm test` passes.
4. Fill in the PR template (what / why / how tested).
5. Expect review on security boundaries (write paths, secrets, scan surface).

### Commit messages

Prefer short, imperative subjects, e.g.:

- `feat(adapter-codex): detect + discoverConfig`
- `fix(host): route align by plan.runtime`
- `docs: clarify align confirmation gate`

## Reporting bugs

Use the **Bug report** issue template. Include:

- OS and Node version
- `agentory-node version` output
- Adapter / runtime involved
- Steps to reproduce (no secrets)

## Security issues

See [SECURITY.md](SECURITY.md) — do **not** open a public issue for vulnerabilities.

## License

Contributions are licensed under the [Apache License 2.0](LICENSE).
