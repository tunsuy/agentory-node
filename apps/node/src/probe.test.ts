import assert from "node:assert/strict";
import { test } from "node:test";
import { probeAll, probeMcpBinding, worstStatus } from "./probe.js";

test("probe marks missing command unknown", async () => {
  const r = await probeMcpBinding({ name: "empty" });
  assert.equal(r.status, "unknown");
  assert.match(r.reason ?? "", /no command/i);
});

test("probe simulates failed invalid / ENOENT / timeout", async () => {
  const bad = await probeMcpBinding({ name: "bad", command: "npx invalid bad-url" });
  assert.equal(bad.status, "failed");
  assert.ok(bad.reason && bad.reason.length > 0);

  const enoent = await probeMcpBinding({
    name: "gone",
    command: "ENOENT /usr/bin/missing-mcp",
  });
  assert.equal(enoent.status, "failed");
  assert.match(enoent.reason ?? "", /ENOENT/);

  const timed = await probeMcpBinding(
    { name: "slow", command: "timeout-sim http://127.0.0.1:9" },
    { timeoutMs: 25 },
  );
  assert.equal(timed.status, "failed");
  assert.match(timed.reason ?? "", /timeout/i);
});

test("probe healthy and degraded", async () => {
  const ok = await probeMcpBinding({ name: "gh", command: "npx -y @modelcontextprotocol/server" });
  assert.equal(ok.status, "healthy");

  const deg = await probeMcpBinding({ name: "warn", command: "degraded npx server" });
  assert.equal(deg.status, "degraded");
  assert.ok(deg.reason);
});

test("probeAll + worstStatus", async () => {
  const all = await probeAll([
    { name: "a", command: "npx ok" },
    { name: "b", command: "invalid endpoint" },
  ]);
  assert.equal(all.length, 2);
  assert.equal(worstStatus(all.map((b) => b.status)), "failed");
});
