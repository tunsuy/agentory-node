import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AlignPlan } from "@agentoryhq/shared";
import { controlPlaneBaseUrl } from "@agentoryhq/shared";
import { applyAlignPatch } from "./align.js";
import { discoverAssetIndex } from "./asset-index.js";
import { discoverAgentsWithHealth } from "./discover.js";
import { captureTranscriptSnapshot, transcriptFileForSourceKey } from "./transcript.js";
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
    const file = transcriptFileForSourceKey(req.sourceKey);
    const snap = file ? captureTranscriptSnapshot(file) : undefined;
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
