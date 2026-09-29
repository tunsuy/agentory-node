# How to write an adapter

## Contract

Implement `RuntimeAdapter` from `@agentory/runtime-contract`:

| Capability | Meaning |
|------------|---------|
| `detect` | Is this runtime present on the machine? |
| `discoverConfig` | Live MCP / Skill (etc.) snapshot |
| `applyAlign` | Write confirmed patch (with snapshot / rollback) |
| `indexSessions` | Session/memory **metadata** only (optional) |
| `readTranscript` | Read-only transcript (optional) |

Declare only what you implement in `manifest.capabilities`. Bump `adapter_api` only when the Host contract breaks (major).

## Layout

```
adapters/<runtime-id>/
  package.json          # @agentory/adapter-<runtime-id>
  src/index.ts          # export const xxxAdapter: RuntimeAdapter
  src/discover.ts       # optional split
  src/align.ts          # optional split
  src/*.test.ts         # fixture tests
```

Register the adapter in `apps/node/src/registry.ts`.

## Rules

1. **SSOT stays on the control plane** — adapters only apply **confirmed** align patches.
2. **Declare write paths** — e.g. project `.mcp.json` / `.cursor/`; do not scan arbitrary home paths by default.
3. **No secrets in logs** — mask tokens; never commit `.env`.
4. **Fixtures** — use `fs.mkdtempSync` trees; assert discover names and refuse unconfirmed writes.

## Minimal test sketch

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverXxxConfig, applyAlignPatch } from "./index.js";

test("discover reads project config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ad-"));
  // write markers + config under root…
  const agent = discoverXxxConfig({ homeDir: root, cwd: root });
  assert.equal(agent?.supported, true);
});

test("applyAlign refuses without confirm", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ad-"));
  const denied = applyAlignPatch({
    projectRoot: root,
    patch: { mcp: [], skills: [] },
    confirmed: false,
  });
  assert.equal(denied.ok, false);
});
```

## Reference implementations

- `adapters/cursor` — full capability set (discover, align, sessions, transcript)
- `adapters/claude-code` — discover + align (project `.mcp.json`)
