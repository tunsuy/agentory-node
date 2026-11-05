import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { discoverBridges, pickLiveBridge, submitViaBridge } from "./ide-bridge.js";

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentory-bridge-"));
}

function writeRuntime(home: string, pid: number, port: number): void {
  const dir = path.join(home, ".agentory", "bridge");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, port, at: "t" }));
}

type Plan = "final" | "ack-final" | "none";

type FakeBridge = {
  port: number;
  close: () => void;
  submitted: Array<Record<string, unknown>>;
};

async function fakeBridge(opts: { health?: boolean; submitOk?: boolean; plan?: Plan } = {}): Promise<FakeBridge> {
  const plan: Plan = opts.plan ?? "final";
  let result: unknown = null;
  const submitted: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    const send = (status: number, obj: unknown) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
    };
    if (req.url === "/health") return send(200, { ok: opts.health ?? true, port: 0 });
    if (req.url === "/v1/cursor/submit") {
      let buf = "";
      req.on("data", (c) => (buf += c));
      req.on("end", () => {
        try {
          submitted.push(JSON.parse(buf || "{}"));
        } catch {
          submitted.push({});
        }
        if (opts.submitOk === false) return send(200, { ok: false, error: "missing_prompt" });
        result = null;
        send(200, { ok: true, queued: true });
        if (plan === "final") {
          setTimeout(() => (result = { ok: true, protocol: 2, composerId: "composer-xyz", output: "hello from ide" }), 40);
        } else if (plan === "ack-final") {
          setTimeout(() => (result = { ok: true, protocol: 2, composerId: "composer-xyz", ack: true }), 40);
          setTimeout(() => (result = { ok: true, protocol: 2, composerId: "composer-xyz", output: "hello from ide" }), 160);
        }
        // plan "none"：永不出结果（模拟未打补丁）
      });
      return;
    }
    if (req.url === "/v1/cursor/result") return send(200, { ok: true, result });
    send(404, { ok: false, error: "not_found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { port, close: () => server.close(), submitted };
}

test("discoverBridges: 读 runtime 文件（去重 + 忽略坏文件）", () => {
  const home = tmpHome();
  writeRuntime(home, 111, 4599);
  writeRuntime(home, 222, 4599); // 同端口去重
  writeRuntime(home, 333, 4600);
  fs.writeFileSync(path.join(home, ".agentory", "bridge", "bad.json"), "{not json");
  const found = discoverBridges(home).sort((a, b) => a.port - b.port);
  assert.deepEqual(
    found.map((b) => b.port),
    [4599, 4600],
  );
});

test("pickLiveBridge + submitViaBridge: 直接 final 结果回填 composerId/output", async () => {
  const home = tmpHome();
  const bridge = await fakeBridge({ plan: "final" });
  writeRuntime(home, 999, bridge.port);
  try {
    assert.equal((await pickLiveBridge({ homeDir: home }))?.port, bridge.port);
    const res = await submitViaBridge(bridge.port, "hello", { timeoutMs: 3000, pollMs: 20 });
    assert.equal(res.ok, true);
    assert.equal(res.composerId, "composer-xyz");
    assert.equal(res.output, "hello from ide");
    assert.equal(res.protocol, 2);
    assert.equal(bridge.submitted[0].prompt, "hello");
    assert.equal(bridge.submitted[0].timeoutMs, 3000);
  } finally {
    bridge.close();
  }
});

test("submitViaBridge: 先 ack 后 final → 等最终 output", async () => {
  const bridge = await fakeBridge({ plan: "ack-final" });
  try {
    const res = await submitViaBridge(bridge.port, "hello", { timeoutMs: 3000, ackTimeoutMs: 1000, pollMs: 20 });
    assert.equal(res.ok, true);
    assert.equal(res.output, "hello from ide");
  } finally {
    bridge.close();
  }
});

test("submitViaBridge: 无 ack → bridge_unpatched（快速降级）", async () => {
  const bridge = await fakeBridge({ plan: "none" });
  const t0 = Date.now();
  try {
    const res = await submitViaBridge(bridge.port, "hello", { timeoutMs: 5000, ackTimeoutMs: 200, pollMs: 20 });
    assert.equal(res.ok, false);
    assert.equal(res.errorText, "bridge_unpatched");
    assert.ok(Date.now() - t0 < 2000, "应在 ack 超时后快速返回");
  } finally {
    bridge.close();
  }
});

test("submitViaBridge: 桥拒绝 → ok:false 带 errorText", async () => {
  const bridge = await fakeBridge({ submitOk: false });
  try {
    const res = await submitViaBridge(bridge.port, "", { timeoutMs: 1000, pollMs: 10 });
    assert.equal(res.ok, false);
    assert.equal(res.errorText, "missing_prompt");
  } finally {
    bridge.close();
  }
});

test("pickLiveBridge: 端口不健康则不选中", async () => {
  const home = tmpHome();
  const bridge = await fakeBridge({ health: false });
  writeRuntime(home, 999, bridge.port);
  try {
    assert.equal(await pickLiveBridge({ homeDir: home }), undefined);
  } finally {
    bridge.close();
  }
});
