import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AlignPlan } from "@agentoryhq/shared";
import { controlPlaneBaseUrl } from "@agentoryhq/shared";
import { applyAlignPatch } from "./align.js";
import { discoverAssetIndex } from "./asset-index.js";
import { discoverAgentsWithHealth } from "./discover.js";
import { adapterForRuntime } from "./registry.js";
import type { InvokeResult } from "@agentoryhq/runtime-contract";
import { captureTranscriptForSourceKey } from "./transcript.js";
import { executeGithubTask, type GithubTaskPayload } from "./github-task.js";
import type { TranscriptSnapshot } from "@agentoryhq/shared";

export type NodeState = {
  workspaceId?: string;
  nodeId: string;
  nodeToken: string;
  controlPlaneBaseUrl: string;
};

function statePath(): string {
  return process.env.AGENTORY_NODE_STATE ?? path.join(os.homedir(), ".agentory", "node.json");
}

export function loadState(): NodeState | undefined {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8")) as NodeState;
  } catch {
    return undefined;
  }
}

export function saveState(state: NodeState): void {
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function cursorRoot(): string {
  return process.env.AGENTORY_CURSOR_ROOT?.trim() || process.cwd();
}

async function api(
  method: string,
  urlPath: string,
  opts: { token: string; body?: unknown },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${controlPlaneBaseUrl()}${urlPath}`, {
    method,
    headers: {
      authorization: `Bearer ${opts.token}`,
      "content-type": "application/json",
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

export async function registerNode(rootToken: string, name: string): Promise<number> {
  const hostname = os.hostname();
  const { status, body } = await api("POST", "/v1/nodes/register", {
    token: rootToken,
    body: { name, hostname },
  });
  if (status !== 200) {
    console.error(status, body);
    return 1;
  }
  const node = body.node as { id: string; workspaceId: string };
  const nodeToken = body.nodeToken as string;
  saveState({
    workspaceId: node.workspaceId,
    nodeId: node.id,
    nodeToken,
    controlPlaneBaseUrl: controlPlaneBaseUrl(),
  });
  console.log(JSON.stringify({ nodeId: node.id, workspaceId: node.workspaceId }, null, 2));
  return 0;
}

export async function heartbeat(): Promise<number> {
  const st = loadState();
  if (!st) {
    console.error("not registered; run: agentory-node register --token <root>");
    return 2;
  }
  const { status, body } = await api("POST", `/v1/nodes/${st.nodeId}/heartbeat`, {
    token: st.nodeToken,
  });
  console.log(status, JSON.stringify(body));
  return status === 200 ? 0 : 1;
}

export async function reportDiscovery(): Promise<number> {
  const st = loadState();
  if (!st) {
    console.error("not registered; run: agentory-node register --token <root>");
    return 2;
  }
  const agents = await discoverAgentsWithHealth();
  const { status, body } = await api("POST", `/v1/nodes/${st.nodeId}/discovery`, {
    token: st.nodeToken,
    body: { agents },
  });
  console.log(status, JSON.stringify(body, null, 2));
  return status === 200 ? 0 : 1;
}

export async function reportAssetIndex(): Promise<number> {
  const st = loadState();
  if (!st) {
    console.error("not registered; run: agentory-node register --token <root>");
    return 2;
  }
  const index = discoverAssetIndex();
  const { status, body } = await api("POST", `/v1/nodes/${st.nodeId}/asset-index`, {
    token: st.nodeToken,
    body: index,
  });
  console.log(status, JSON.stringify(body, null, 2));
  return status === 200 ? 0 : 1;
}

/**
 * Model B pull: fetch pending transcript requests, capture each session
 * locally (mask + window, never logs the body — AC-9), POST snapshots back.
 * Called from the daemon index channel and `agentory-node transcript` CLI.
 */
export async function fulfillPendingTranscripts(): Promise<number> {
  const st = loadState();
  if (!st) {
    console.error("not registered; run: agentory-node register --token <root>");
    return 2;
  }
  const { status, body } = await api("GET", `/v1/nodes/${st.nodeId}/transcript/pending`, {
    token: st.nodeToken,
  });
  if (status !== 200) {
    console.error(status, JSON.stringify(body));
    return 1;
  }
  const pending = (body.requests as Array<{ sourceKey: string }>) ?? [];
  if (!pending.length) {
    console.log(JSON.stringify({ fulfilled: 0, requests: [] }, null, 2));
    return 0;
  }
  const snapshots: TranscriptSnapshot[] = [];
  const misses: string[] = [];
  for (const req of pending) {
    // 跨 adapter 路由（claude-session-index AC-5）：cursor/claude key 各自
    // 找到归属 adapter 捕获；未知前缀无人认领 → miss 上报（既有语义）。
    const snap = captureTranscriptForSourceKey(req.sourceKey);
    if (snap) snapshots.push(snap);
    else misses.push(req.sourceKey);
  }
  const { status: reportStatus, body: reportBody } = await api(
    "POST",
    `/v1/nodes/${st.nodeId}/transcript/report`,
    {
      token: st.nodeToken,
      body: { snapshots, missing: misses },
    },
  );
  if (reportStatus !== 200) {
    console.error(reportStatus, JSON.stringify(reportBody));
    return 1;
  }
  // 审计侧只回 count——快照正文不落节点日志（AC-9）。
  console.log(
    JSON.stringify(
      {
        fulfilled: snapshots.length,
        missing: misses.length,
        reported: (reportBody as { snapshots: number }).snapshots,
      },
      null,
      2,
    ),
  );
  return 0;
}

/**
 * 消息通道（ADR-005 拉模型第六通道 · agent-messaging 切片 4）：
 * 拉取即锁定的 pending 消息 → adapter.invoke 逐条串行执行（一期单发单执行）→ 回流结果。
 * 红线：不注入任何权限放宽 flag（invoke 实现内钉死）；纯 outbound 零反连；
 * 消息正文/输出不落节点日志（只回计数与状态，transcript AC-9 同纪律）。
 */
export async function fulfillPendingMessages(): Promise<number> {
  const st = loadState();
  if (!st) {
    console.error("not registered; run: agentory-node register --token <root>");
    return 2;
  }
  const { status, body } = await api("GET", `/v1/nodes/${st.nodeId}/messages/pending`, {
    token: st.nodeToken,
  });
  if (status !== 200) {
    console.error(status, JSON.stringify(body));
    return 1;
  }
  const pending =
    (body.messages as Array<{
      id: string;
      agentInstanceId: string;
      runtime: string;
      body: string;
      timeoutMs: number;
      maxOutputBytes: number;
    }>) ?? [];
  if (!pending.length) {
    console.log(JSON.stringify({ executed: 0, reported: 0, outcomes: {} }, null, 2));
    return 0;
  }
  const cwd = process.cwd();
  const outcomes: Record<string, number> = {};
  let reported = 0;
  let reportFailed = 0;
  for (const msg of pending) {
    let result: InvokeResult;
    const adapter = adapterForRuntime(msg.runtime);
    if (!adapter?.invoke) {
      // 控制面已按诚实集拦 409；走到这里 = 节点侧无该 runtime adapter（版本偏差），
      // 诚实回流 failed 而不是静默丢弃。
      result = {
        outcome: "failed",
        output: "",
        truncated: false,
        exitCode: null,
        durationMs: 0,
        errorText: `no invoke adapter for runtime ${msg.runtime}`,
      };
    } else {
      try {
        result = await adapter.invoke(
          { homeDir: os.homedir(), cwd },
          {
            prompt: msg.body,
            timeoutMs: msg.timeoutMs,
            maxOutputBytes: msg.maxOutputBytes,
            cwd,
          },
        );
      } catch (err) {
        result = {
          outcome: "failed",
          output: "",
          truncated: false,
          exitCode: null,
          durationMs: 0,
          errorText: err instanceof Error ? err.message : String(err),
        };
      }
    }
    outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
    const report = await api("POST", `/v1/nodes/${st.nodeId}/messages/report`, {
      token: st.nodeToken,
      body: {
        messageId: msg.id,
        outcome: result.outcome,
        output: result.output,
        truncated: result.truncated,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        runtimeSessionId: result.runtimeSessionId,
        errorText: result.errorText,
      },
    });
    // 业务失败（failed/timeout）是正常回流结果，不算通道失败；只有回流本身报错才非 0。
    if (report.status === 200) reported += 1;
    else reportFailed += 1;
  }
  console.log(
    JSON.stringify({ executed: pending.length, reported, reportFailed, outcomes }, null, 2),
  );
  return reportFailed ? 1 : 0;
}

/**
 * GitHub 任务通道（github-tasks 切片 3 · ADR-007 拉模型第七通道）：
 * 拉取即锁定的 claimed 任务 → start（claimed→running）→ executeGithubTask
 * （remote 校验 AC-4 / headless 执行 / commit+push 任务分支 AC-8）→ 回流结果。
 * 红线：不注入任何权限放宽 flag（adapter.invoke 内钉死）；纯 outbound 零反连；
 * issue 正文/输出不落节点日志（只回计数与状态，messaging AC-9 同纪律）。
 */
export async function fulfillPendingGithubTasks(): Promise<number> {
  const st = loadState();
  if (!st) {
    console.error("not registered; run: agentory-node register --token <root>");
    return 2;
  }
  const { status, body } = await api("GET", `/v1/nodes/${st.nodeId}/github-tasks/pending`, {
    token: st.nodeToken,
  });
  if (status !== 200) {
    console.error(status, JSON.stringify(body));
    return 1;
  }
  const pending = (body.tasks as GithubTaskPayload[]) ?? [];
  if (!pending.length) {
    console.log(JSON.stringify({ executed: 0, reported: 0, outcomes: {} }, null, 2));
    return 0;
  }
  const adapter = adapterForRuntime("claude-code");
  // 一期单仓库：仓库工作目录 env 指定（部署面文档化,切片 6）；缺省 = daemon 进程 cwd（messaging 同口径）。
  const repoDir = process.env.AGENTORY_GITHUB_REPO_DIR?.trim() || process.cwd();
  const outcomes: Record<string, number> = {};
  let reported = 0;
  let reportFailed = 0;
  for (const task of pending) {
    const startRes = await api("POST", `/v1/nodes/${st.nodeId}/github-tasks/start`, {
      token: st.nodeToken,
      body: { taskId: task.id },
    });
    if (startRes.status !== 200) {
      // claimed 锁定被并发取走/版本偏差：诚实计数,不执行不上报。
      reportFailed += 1;
      continue;
    }
    let report;
    if (!adapter?.invoke) {
      // 节点侧无 claude-code adapter（版本偏差）：诚实回流 failed 而不是静默丢弃。
      report = {
        outcome: "failed" as const,
        output: "",
        truncated: false,
        exitCode: null,
        durationMs: 0,
        errorText: "no invoke adapter for runtime claude-code",
      };
    } else {
      const invoke = adapter.invoke;
      report = await executeGithubTask(task, {
        repoDir,
        invoke: (req) => invoke({ homeDir: os.homedir(), cwd: req.cwd }, req),
      });
    }
    outcomes[report.outcome] = (outcomes[report.outcome] ?? 0) + 1;
    const res = await api("POST", `/v1/nodes/${st.nodeId}/github-tasks/report`, {
      token: st.nodeToken,
      body: { taskId: task.id, ...report },
    });
    // 业务失败（failed/timeout）是正常回流结果;只有回流本身报错才非 0（messaging 同口径）。
    if (res.status === 200) reported += 1;
    else reportFailed += 1;
  }
  console.log(
    JSON.stringify({ executed: pending.length, reported, reportFailed, outcomes }, null, 2),
  );
  return reportFailed ? 1 : 0;
}

/** Pull confirmed plans and write Cursor files (AC-3). */
export async function applyPendingAligns(): Promise<number> {
  const st = loadState();
  if (!st) {
    console.error("not registered; run: agentory-node register --token <root>");
    return 2;
  }
  const { status, body } = await api("GET", `/v1/nodes/${st.nodeId}/align/pending`, {
    token: st.nodeToken,
  });
  if (status !== 200) {
    console.error(status, body);
    return 1;
  }
  const plans = (body.plans as AlignPlan[]) ?? [];
  if (!plans.length) {
    console.log(JSON.stringify({ applied: 0, plans: [] }, null, 2));
    return 0;
  }
  const root = cursorRoot();
  const results: unknown[] = [];
  let failed = 0;
  for (const plan of plans) {
    const local = applyAlignPatch({
      cursorRoot: root,
      patch: plan.patch,
      confirmed: plan.status === "confirmed",
      runtime: plan.runtime,
    });
    const report = await api("POST", `/v1/nodes/${st.nodeId}/align/${plan.id}/result`, {
      token: st.nodeToken,
      body: {
        ok: local.ok,
        error: local.error,
        snapshotPath: local.snapshotPath,
      },
    });
    if (!local.ok || report.status !== 200) failed += 1;
    results.push({
      planId: plan.id,
      local,
      reportStatus: report.status,
      plan: report.body.plan,
    });
  }
  console.log(JSON.stringify({ applied: plans.length - failed, failed, results }, null, 2));
  return failed ? 1 : 0;
}
