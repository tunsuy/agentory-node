import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Cursor IDE 进程内桥（方案 A）的客户端。
 *
 * 背景：扩展在 Cursor 扩展宿主起本地 HTTP（多窗口依次占 4517/4518/…），
 * 端口登记在 `~/.agentory/bridge/<pid>.json`。补丁后的 renderer 负责把
 * `composer.startComposerPrompt2` 的哨兵参数翻译为「新建会话 + 自动提交」。
 * 本模块只做发现 / 健康检查 / 提交 / 轮询结果，不碰 bundle。
 */

export type BridgeEndpoint = { pid: number; port: number };

export type FetchLike = typeof fetch;

export function bridgeRuntimeDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".agentory", "bridge");
}

/** 读取所有登记端口（去重），不校验存活。 */
export function discoverBridges(homeDir: string = os.homedir()): BridgeEndpoint[] {
  const dir = bridgeRuntimeDir(homeDir);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const seen = new Set<number>();
  const out: BridgeEndpoint[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch {
      continue;
    }
    if (typeof raw !== "object" || raw === null) continue;
    const { pid, port } = raw as { pid?: unknown; port?: unknown };
    if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port >= 65536) continue;
    if (seen.has(port)) continue;
    seen.add(port);
    out.push({ pid: typeof pid === "number" ? pid : 0, port });
  }
  return out;
}

type HttpResult = { ok: boolean; status: number; body: unknown };

async function httpJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<HttpResult | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { ok: res.ok, status: res.status, body };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export type BridgeHealthOpts = { timeoutMs?: number; fetchImpl?: FetchLike };

export async function bridgeHealth(port: number, opts: BridgeHealthOpts = {}): Promise<boolean> {
  const r = await httpJson(
    opts.fetchImpl ?? fetch,
    `http://127.0.0.1:${port}/health`,
    { method: "GET" },
    opts.timeoutMs ?? 800,
  );
  const body = r?.body as { ok?: unknown } | undefined;
  return Boolean(r && r.ok && body && body.ok === true);
}

export type PickBridgeOpts = BridgeHealthOpts & { homeDir?: string; port?: number };

/**
 * 选一个活着的桥。给定 `port` 只校验它；否则按登记顺序做健康探测。
 * 多窗口时「第一个活着的」即可——提交会落到该窗口的 renderer。
 */
export async function pickLiveBridge(opts: PickBridgeOpts = {}): Promise<BridgeEndpoint | undefined> {
  if (opts.port) {
    return (await bridgeHealth(opts.port, opts)) ? { pid: 0, port: opts.port } : undefined;
  }
  for (const b of discoverBridges(opts.homeDir)) {
    if (await bridgeHealth(b.port, opts)) return b;
  }
  return undefined;
}

export type BridgeSubmitResult = {
  ok: boolean;
  composerId?: string;
  /** 生成完成后最后一条 assistant 文本（可能为空；受 IDE 轮询上限影响）。 */
  output?: string;
  timedOut?: boolean;
  protocol?: number;
  errorText?: string;
  durationMs: number;
};

export type BridgeSubmitOpts = {
  /** 续聊：目标会话 id（renderer 走 showAndFocus + submitChatMaybeAbortCurrent）。 */
  composerId?: string;
  /** 生成总预算（收到 ack 后开始计）。 */
  timeoutMs?: number;
  /** 等 renderer「ack」的上限；超时判定为未打补丁，供调用方快速回落。 */
  ackTimeoutMs?: number;
  pollMs?: number;
  fetchImpl?: FetchLike;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 提交一条 prompt。返回时仅代表「renderer 已接收并触发提交」，不代表模型生成完成
 * （生成流在 IDE 内，另由 transcript 管线回收）。composerId 用于续聊回填。
 */
export async function submitViaBridge(
  port: number,
  prompt: string,
  opts: BridgeSubmitOpts = {},
): Promise<BridgeSubmitResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const ackTimeoutMs = opts.ackTimeoutMs ?? 8_000;
  const pollMs = opts.pollMs ?? 500;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = `http://127.0.0.1:${port}`;

  const post = await httpJson(
    fetchImpl,
    `${base}/v1/cursor/submit`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt,
        ...(opts.composerId ? { composerId: opts.composerId } : {}),
        timeoutMs,
      }),
    },
    Math.min(timeoutMs, 5_000),
  );
  const postBody = post?.body as { ok?: unknown; error?: unknown } | undefined;
  if (!post || !post.ok || !postBody || postBody.ok !== true) {
    return {
      ok: false,
      errorText: postBody?.error ? String(postBody.error) : "bridge submit failed",
      durationMs: Date.now() - started,
    };
  }

  // renderer 收到后会先回 `ack`（证明补丁生效），生成完成再回 `output`。
  // 迟迟没有 ack → 判定 renderer 未打补丁，快速失败供调用方回落。
  let acked = false;
  let finalDeadline = 0;
  while (true) {
    const now = Date.now();
    if (!acked && now - started > ackTimeoutMs) {
      return { ok: false, errorText: "bridge_unpatched", durationMs: now - started };
    }
    if (acked && now > finalDeadline) {
      return { ok: false, errorText: "bridge result timeout", durationMs: now - started };
    }
    await sleep(pollMs);
    const r = await httpJson(fetchImpl, `${base}/v1/cursor/result`, { method: "GET" }, 2_000);
    const result = (r?.body as { result?: unknown } | undefined)?.result;
    if (!result || typeof result !== "object") continue;
    const obj = result as {
      ok?: unknown;
      composerId?: unknown;
      output?: unknown;
      timedOut?: unknown;
      protocol?: unknown;
      error?: unknown;
    };
    if (obj.ok === false) {
      return {
        ok: false,
        errorText: obj.error ? String(obj.error) : "renderer reported failure",
        durationMs: Date.now() - started,
      };
    }
    if (obj.ok !== true) continue;
    const hasFinal = typeof obj.output === "string" || obj.timedOut === true;
    if (!acked) {
      acked = true;
      finalDeadline = Date.now() + timeoutMs;
    }
    if (hasFinal) {
      return {
        ok: true,
        composerId: typeof obj.composerId === "string" ? obj.composerId : undefined,
        output: typeof obj.output === "string" ? obj.output : undefined,
        timedOut: obj.timedOut === true ? true : undefined,
        protocol: typeof obj.protocol === "number" ? obj.protocol : undefined,
        durationMs: Date.now() - started,
      };
    }
    // 仅是 ack → 继续等最终结果。
  }
}
