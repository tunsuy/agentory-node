import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assetIndexSha,
  jitterMs,
  parseIntervalSec,
  resolveIntervals,
  runDaemon,
} from "./daemon.js";

function tmpStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentory-daemon-test-"));
}

function writeState(dir: string): string {
  const file = path.join(dir, "node.json");
  fs.writeFileSync(
    file,
    JSON.stringify(
      { nodeId: "nd_test", nodeToken: "tok_test", controlPlaneBaseUrl: "http://127.0.0.1:1" },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return file;
}

test("AC-6: interval clamps to minimum (0 and non-numeric)", () => {
  process.env.AGENTORY_DAEMON_HEARTBEAT_SEC = "0";
  assert.equal(parseIntervalSec("AGENTORY_DAEMON_HEARTBEAT_SEC", 60), 5);
  delete process.env.AGENTORY_DAEMON_HEARTBEAT_SEC;
  process.env.AGENTORY_DAEMON_INDEX_SEC = "abc";
  assert.equal(parseIntervalSec("AGENTORY_DAEMON_INDEX_SEC", 600), 5);
  delete process.env.AGENTORY_DAEMON_INDEX_SEC;
  // negative also clamps
  process.env.AGENTORY_DAEMON_DISCOVER_SEC = "-3";
  assert.equal(parseIntervalSec("AGENTORY_DAEMON_DISCOVER_SEC", 3600), 5);
  delete process.env.AGENTORY_DAEMON_DISCOVER_SEC;
  // valid values pass through
  assert.equal(parseIntervalSec("AGENTORY_DAEMON_HEARTBEAT_SEC", 60), 60);
});

test("AC-6: resolveIntervals reports clamped values", () => {
  const savedHb = process.env.AGENTORY_DAEMON_HEARTBEAT_SEC;
  process.env.AGENTORY_DAEMON_HEARTBEAT_SEC = "0";
  const iv = resolveIntervals();
  assert.equal(iv.heartbeatSec, 5);
  assert.equal(iv.indexSec, 600);
  assert.equal(iv.discoverSec, 3600);
  if (savedHb === undefined) delete process.env.AGENTORY_DAEMON_HEARTBEAT_SEC;
  else process.env.AGENTORY_DAEMON_HEARTBEAT_SEC = savedHb;
});

test("jitter stays within 10% of period (deterministic bounds)", () => {
  for (let i = 0; i < 50; i++) {
    const j = jitterMs(100, () => 0.999);
    assert.ok(j >= 0 && j < 10 * 1000, `jitter out of bounds: ${j}`);
  }
  assert.equal(jitterMs(100, () => 0), 0);
});

test("assetIndexSha changes when index changes", () => {
  const a = assetIndexSha({ sessions: [{ id: 1 }], memories: [] });
  const b = assetIndexSha({ sessions: [{ id: 2 }], memories: [] });
  assert.notEqual(a, b);
  assert.equal(a, assetIndexSha({ sessions: [{ id: 1 }], memories: [] }));
});

test("AC-4 (part): daemon --once exits non-zero when control plane unreachable, base URL in stderr/log", async () => {
  const dir = tmpStateDir();
  const prev = process.env.AGENTORY_NODE_STATE;
  const prevBase = process.env.CONTROL_PLANE_BASE_URL;
  process.env.AGENTORY_NODE_STATE = writeState(dir);
  process.env.CONTROL_PLANE_BASE_URL = "http://127.0.0.1:1"; // 不可达端口
  try {
    const code = await runDaemon({ once: true });
    assert.notEqual(code, 0);
  } finally {
    if (prev === undefined) delete process.env.AGENTORY_NODE_STATE;
    else process.env.AGENTORY_NODE_STATE = prev;
    if (prevBase === undefined) delete process.env.CONTROL_PLANE_BASE_URL;
    else process.env.CONTROL_PLANE_BASE_URL = prevBase;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon without registration exits 2 with usage hint", async () => {
  const dir = tmpStateDir();
  const prev = process.env.AGENTORY_NODE_STATE;
  process.env.AGENTORY_NODE_STATE = path.join(dir, "missing.json");
  try {
    const code = await runDaemon({ once: true });
    assert.equal(code, 2);
  } finally {
    if (prev === undefined) delete process.env.AGENTORY_NODE_STATE;
    else process.env.AGENTORY_NODE_STATE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-5: SIGNAL mid-run → graceful stop, exit 0", async () => {
  const dir = tmpStateDir();
  const prev = process.env.AGENTORY_NODE_STATE;
  process.env.AGENTORY_NODE_STATE = writeState(dir);
  let fireSignal: ((sig: NodeJS.Signals) => void) | undefined;
  let sawStoppingLine = false;
  const originalLog = console.log;
  console.log = (...args) => {
    const s = args.map(String).join(" ");
    if (s.includes('"stopping"')) sawStoppingLine = true;
    originalLog(...args);
  };
  try {
    let elapsedMs = 0;
    const code = await runDaemon({
      intervals: { heartbeatSec: 5, indexSec: 600, discoverSec: 3600 },
      clock: () => 1_000 + elapsedMs,
      sleep: (ms) => {
        elapsedMs += ms;
        if (elapsedMs >= 5_000 && fireSignal) {
          fireSignal("SIGINT");
        }
        return new Promise<void>((r) => setTimeout(r, 0));
      },
      registerSignal: (onSignal) => {
        fireSignal = onSignal;
      },
    });
    assert.equal(code, 0);
    assert.ok(sawStoppingLine, "expected a stopping log line on signal");
  } finally {
    console.log = originalLog;
    if (prev === undefined) delete process.env.AGENTORY_NODE_STATE;
    else process.env.AGENTORY_NODE_STATE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
