import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AlignPlan, CursorBridgeReport, PendingSkillInstall, SkillInstallReport } from "@agentoryhq/shared";
import { controlPlaneBaseUrl } from "@agentoryhq/shared";
import { applyAlignPatch } from "./align.js";
import { discoverAssetIndex } from "./asset-index.js";
import { discoverAgentsWithHealth } from "./discover.js";
import { adapterForRuntime } from "./registry.js";
import type { InvokeResult, SkillFileManifestEntry } from "@agentoryhq/runtime-contract";
import { captureTranscriptForSourceKey } from "./transcript.js";
import { executeGithubTask, type GithubTaskPayload } from "./github-task.js";
import type { TranscriptSnapshot } from "@agentoryhq/shared";

export type NodeState = {
  workspaceId?: string;
  nodeId: string;
  nodeToken: string;
  controlPlaneBaseUrl: string;
  /** 注册时的节点名（自愈重注册沿用，缺省回退 "local"）。 */
  name?: string;
  /**
   * 节点根令牌：控制面（demo 档 memory）重启清空节点记录后，heartbeat 401/404
   * 时用它自愈重注册。文件 0600 仅属主可读；不写日志、不上报。
   */
  rootToken?: string;
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

/** 二进制 GET（skill zip 下载走控制面代理；节点零直连 skillhub）。 */
async function apiBytes(
  urlPath: string,
  token: string,
): Promise<{ status: number; bytes?: Uint8Array }> {
  const res = await fetch(`${controlPlaneBaseUrl()}${urlPath}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/zip" },
  });
  if (!res.ok) return { status: res.status };
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
}

/** files 清单解包：上游信封 {code,message,data:{files}} 与裸 {files} 都容忍。 */
function manifestFromFilesBody(
  body: Record<string, unknown>,
): SkillFileManifestEntry[] | undefined {
  const data = (body.data as Record<string, unknown> | undefined) ?? body;
  const files = data.files;
  if (!Array.isArray(files)) return undefined;
  const out: SkillFileManifestEntry[] = [];
  for (const f of files) {
    if (typeof f !== "object" || f === null) continue;
    const o = f as Record<string, unknown>;
    if (typeof o.path !== "string" || !o.path) continue;
    const entry: SkillFileManifestEntry = { path: o.path };
    if (typeof o.size === "number") entry.size = o.size;
    if (typeof o.sha256 === "string" && o.sha256) entry.sha256 = o.sha256;
    out.push(entry);
  }
  return out;
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
    name,
    rootToken,
  });
  console.log(JSON.stringify({ nodeId: node.id, workspaceId: node.workspaceId }, null, 2));
  return 0;
}

async function postHeartbeat(st: NodeState, extra?: { cursorBridge?: CursorBridgeReport }) {
  return api("POST", `/v1/nodes/${st.nodeId}/heartbeat`, {
    token: st.nodeToken,
    ...(extra?.cursorBridge ? { body: { cursorBridge: extra.cursorBridge } } : {}),
  });
}

export async function heartbeat(extra?: { cursorBridge?: CursorBridgeReport }): Promise<number> {
  const st = loadState();
  if (!st) {
    console.error("not registered; run: agentory-node register --token <root>");
    return 2;
  }
  let { status, body } = await postHeartbeat(st, extra);
  // 自愈重注册：401/404 = 控制面不认识本节点（典型：demo 档 memory store 重启
  // 清空全部节点记录）。state 里有根令牌就重注册一次再重试；重注册后 nodeId/
  // nodeToken 全新（daemon 后续通道各自 loadState，自动用新凭据）。
  // 403（node_revoked，Owner 吊销）不自愈——kill switch 不可绕过。
  // 存量 state 无 rootToken 或根令牌也失效（PG 档登录轮换）→ 照旧报错。
  if ((status === 401 || status === 404) && st.rootToken) {
    console.error(`heartbeat ${status}: control plane forgot this node; re-registering with stored root token`);
    const code = await registerNode(st.rootToken, st.name ?? "local");
    const fresh = code === 0 ? loadState() : undefined;
    if (fresh) ({ status, body } = await postHeartbeat(fresh, extra));
  }
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
      resumeSessionId?: string;
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
            ...(msg.resumeSessionId ? { resumeSessionId: msg.resumeSessionId } : {}),
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

/**
 * Skill 安装通道（skillhub-integration · 拉模型，独立于 align 计划）：
 * 拉取 pending（控制面按 desired × 安装状态推导）→ 经控制面代理取 files 清单
 * + zip（节点零直连 skillhub）→ adapter.installSkills 逐文件 sha256 校验落盘
 * → 回流结果。sha256 不符 = integrity 信号（控制面不自动重试）；其余失败
 * 下周期自动重试（AC-7）；同版本已装 → skipped 幂等（AC-5）。
 * zip 内容/清单正文不落节点日志——只回计数与状态（AC-9 同纪律）。
 */
export async function fulfillPendingSkillInstalls(): Promise<number> {
  const st = loadState();
  if (!st) {
    console.error("not registered; run: agentory-node register --token <root>");
    return 2;
  }
  const { status, body } = await api("GET", `/v1/nodes/${st.nodeId}/skillhub/pending`, {
    token: st.nodeToken,
  });
  if (status !== 200) {
    console.error(status, JSON.stringify(body));
    return 1;
  }
  const pending = (body.installs as PendingSkillInstall[]) ?? [];
  if (!pending.length) {
    console.log(JSON.stringify({ pending: 0, installed: 0, failed: 0 }, null, 2));
    return 0;
  }
  const adapter = adapterForRuntime("claude-code");
  const cwd = process.cwd();
  const reports: SkillInstallReport[] = [];
  let installed = 0;
  let skipped = 0;
  let failed = 0;
  let integrity = 0;
  for (const item of pending) {
    if (!item.version) continue; // 防御：选装时版本已固定，pending 必带 version
    let report: SkillInstallReport;
    try {
      if (!adapter?.installSkills) {
        // 节点侧无安装能力（版本偏差）：诚实回流 failed 而不是静默丢弃。
        report = {
          slug: item.slug,
          version: item.version,
          status: "failed",
          error: "no installSkills adapter for runtime claude-code",
        };
      } else {
        const q = `slug=${encodeURIComponent(item.slug)}&version=${encodeURIComponent(item.version)}`;
        const filesRes = await api("GET", `/v1/nodes/${st.nodeId}/skillhub/files?${q}`, {
          token: st.nodeToken,
        });
        const manifest = filesRes.status === 200 ? manifestFromFilesBody(filesRes.body) : undefined;
        const dl = manifest
          ? await apiBytes(`/v1/nodes/${st.nodeId}/skillhub/download?${q}`, st.nodeToken)
          : undefined;
        if (!manifest || !dl?.bytes) {
          // 来源暂不可用：非 integrity，控制面下周期自动重试（AC-7）。
          report = {
            slug: item.slug,
            version: item.version,
            status: "failed",
            error: `skillhub source unavailable (files HTTP ${filesRes.status}${manifest ? "" : ", no manifest"}${dl ? `, download HTTP ${dl.status}` : ""})`,
          };
        } else {
          const outcomes = await adapter.installSkills(
            { homeDir: os.homedir(), cwd },
            { items: [{ slug: item.slug, version: item.version, zip: dl.bytes, files: manifest }] },
          );
          const out = outcomes[0];
          if (!out || out.status === "failed") {
            report = { slug: item.slug, version: item.version, status: "failed" };
            if (out?.error) report.error = out.error;
            if (out?.integrity) report.integrity = true;
          } else {
            report = { slug: item.slug, version: item.version, status: "installed" };
            if (out.status === "skipped") skipped += 1;
            else installed += 1;
          }
        }
      }
    } catch (err) {
      report = {
        slug: item.slug,
        version: item.version,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (report.status === "failed") {
      failed += 1;
      if (report.integrity) integrity += 1;
    }
    reports.push(report);
  }
  if (reports.length) {
    const res = await api("POST", `/v1/nodes/${st.nodeId}/skillhub/report`, {
      token: st.nodeToken,
      body: { installs: reports },
    });
    if (res.status !== 200) {
      // 回流失败：状态行未落库 → 下周期同批重试（adapter 幂等 skipped 兜底）。
      console.error(res.status, JSON.stringify(res.body));
      return 1;
    }
  }
  console.log(
    JSON.stringify({ pending: pending.length, installed, skipped, failed, integrity }, null, 2),
  );
  return 0;
}
