import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { heartbeat, loadState, saveState } from "./client.js";

/**
 * heartbeat 自愈重注册（demo 固定根令牌配套）：控制面 memory 档重启后节点记录
 * 清空 → heartbeat 401 → 用 state 里存的 rootToken 重注册 → 新凭据重试成功。
 * fetch 全量 stub：不出网，断言调用序列与 state 落盘。
 */

const BASE = "http://127.0.0.1:9";

function tmpStateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentory-client-test-"));
  return path.join(dir, "node.json");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function withEnv(file: string, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const prevState = process.env.AGENTORY_NODE_STATE;
    const prevBase = process.env.CONTROL_PLANE_BASE_URL;
    process.env.AGENTORY_NODE_STATE = file;
    process.env.CONTROL_PLANE_BASE_URL = BASE;
    const originalFetch = globalThis.fetch;
    try {
      await fn();
    } finally {
      globalThis.fetch = originalFetch;
      if (prevState === undefined) delete process.env.AGENTORY_NODE_STATE;
      else process.env.AGENTORY_NODE_STATE = prevState;
      if (prevBase === undefined) delete process.env.CONTROL_PLANE_BASE_URL;
      else process.env.CONTROL_PLANE_BASE_URL = prevBase;
    }
  };
}

test("heartbeat 自愈：401 → rootToken 重注册 → 新凭据重试成功", () => {
  const file = tmpStateFile();
  return withEnv(file, async () => {
    saveState({
      nodeId: "node_old",
      nodeToken: "nd_old",
      controlPlaneBaseUrl: BASE,
      name: "mymac",
      rootToken: "node_root_x",
    });
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? "GET"} ${u.slice(BASE.length)}`);
      if (u.includes("/heartbeat")) {
        return calls.filter((c) => c.includes("/heartbeat")).length === 1
          ? jsonResponse(401, { error: "invalid node token" })
          : jsonResponse(200, { node: { id: "node_new" } });
      }
      if (u.endsWith("/v1/nodes/register")) {
        // 重注册必须带原 name（不退回 "local"）
        const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string };
        assert.equal(body.name, "mymac");
        return jsonResponse(200, {
          node: { id: "node_new", workspaceId: "ws_1" },
          nodeToken: "nd_new",
        });
      }
      return jsonResponse(404, { error: "not found" });
    }) as typeof fetch;

    assert.equal(await heartbeat(), 0);
    const st = loadState();
    assert.ok(st);
    assert.equal(st.nodeId, "node_new");
    assert.equal(st.nodeToken, "nd_new");
    assert.equal(st.workspaceId, "ws_1");
    // 根令牌与名字保留（下次重启继续自愈）
    assert.equal(st.rootToken, "node_root_x");
    assert.equal(st.name, "mymac");
    assert.deepEqual(calls, [
      "POST /v1/nodes/node_old/heartbeat",
      "POST /v1/nodes/register",
      "POST /v1/nodes/node_new/heartbeat",
    ]);
  })();
});

test("heartbeat：无 rootToken（存量 state）→ 401 照旧失败，不重注册", () => {
  const file = tmpStateFile();
  return withEnv(file, async () => {
    saveState({ nodeId: "node_old", nodeToken: "nd_old", controlPlaneBaseUrl: BASE });
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url).slice(BASE.length)}`);
      return jsonResponse(401, { error: "invalid node token" });
    }) as typeof fetch;

    assert.equal(await heartbeat(), 1);
    assert.equal(calls.length, 1); // 只打了一次 heartbeat，没有 register
  })();
});

test("heartbeat：rootToken 也失效（PG 档登录轮换后）→ 失败不崩溃", () => {
  const file = tmpStateFile();
  return withEnv(file, async () => {
    saveState({
      nodeId: "node_old",
      nodeToken: "nd_old",
      controlPlaneBaseUrl: BASE,
      rootToken: "node_rotated_away",
    });
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/v1/nodes/register")) {
        return jsonResponse(401, { error: "invalid node root token" });
      }
      return jsonResponse(401, { error: "invalid node token" });
    }) as typeof fetch;

    assert.equal(await heartbeat(), 1);
    // state 未被坏数据覆盖（registerNode 只在 200 时 saveState）
    assert.equal(loadState()?.nodeId, "node_old");
  })();
});

test("heartbeat：403 node_revoked（Owner 吊销）→ 不自愈重注册，照旧失败", () => {
  const file = tmpStateFile();
  return withEnv(file, async () => {
    saveState({
      nodeId: "node_old",
      nodeToken: "nd_old",
      controlPlaneBaseUrl: BASE,
      rootToken: "node_root_x",
    });
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url).slice(BASE.length)}`);
      return jsonResponse(403, { error: "node revoked", code: "node_revoked" });
    }) as typeof fetch;

    assert.equal(await heartbeat(), 1);
    assert.equal(calls.length, 1); // 只有 heartbeat，没有 register
    assert.equal(loadState()?.nodeId, "node_old");
  })();
});
