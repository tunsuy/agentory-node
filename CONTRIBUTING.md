# Contributing to agentory-node

Thanks for helping grow Agent runtime coverage.

## What belongs here

- New or improved **adapters** under `adapters/<runtime-id>/`
- Host bugfixes that do not embed a specific runtime’s file paths
- Docs / fixtures for adapter authors

## What does not belong here

- Control plane / Console / seats / billing
- Default unauthenticated full-disk scan or SSH “takeover”
- Secrets, tokens, or `.env` contents in commits or logs
- Making rulesync / add-mcp a Host kernel dependency

## Add a runtime (checklist)

1. Copy `adapters/claude-code` → `adapters/<id>/`, rename the package to `@agentoryhq/adapter-<id>`.
2. Implement `RuntimeAdapter` in `packages/runtime-contract` shape: at least `detect`; declare `capabilities` honestly.
3. Register in `apps/node/src/registry.ts` `builtinAdapters`.
4. Add fixture tests (temp dir + assert discover / align).
5. Update `adapters/README.md`.
6. Open a PR against this repo.

Details: [docs/how-to-write-an-adapter.md](docs/how-to-write-an-adapter.md).

## Development

```bash
npm install
npm run build
npm test
```

Node.js ≥ 20.

## License

By contributing, you agree that your contributions are licensed under the Apache License 2.0.
