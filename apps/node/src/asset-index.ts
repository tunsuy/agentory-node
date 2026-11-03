import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MemoryIndexReportItem, RuntimeKind, SessionIndexReportItem } from "@agentoryhq/shared";
import { builtinAdapters } from "./registry.js";
import { agentInstanceIdFor } from "./instance-id.js";

export type AssetIndexDiscoverOpts = {
  homeDir?: string;
  cwd?: string;
  /** JSON fixture: { sessions?, memories? } or AGENTORY_ASSET_INDEX_FIXTURE */
  fixturePath?: string;
};

function readJsonFile(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 每个 Agent（按 runtime 归类）最多上报最近 N 条会话索引——避免把本机全部历史
 * 会话一次性推上控制面；节点侧裁剪后，服务端存的就是这份最新窗口。
 */
export const SESSIONS_PER_AGENT_MAX = 10;

/**
 * Aggregate asset index: Host fixtures/drop-in + each adapter with `indexSessions`.
 */
export function discoverAssetIndex(opts: AssetIndexDiscoverOpts = {}): {
  sessions: SessionIndexReportItem[];
  memories: MemoryIndexReportItem[];
} {
  const fixture = opts.fixturePath ?? process.env.AGENTORY_ASSET_INDEX_FIXTURE;
  if (fixture) {
    const raw = readJsonFile(fixture);
    if (raw && typeof raw === "object") {
      const o = raw as { sessions?: SessionIndexReportItem[]; memories?: MemoryIndexReportItem[] };
      return {
        sessions: Array.isArray(o.sessions) ? o.sessions : [],
        memories: Array.isArray(o.memories) ? o.memories : [],
      };
    }
  }

  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();
  const sessions: SessionIndexReportItem[] = [];
  const memories: MemoryIndexReportItem[] = [];
  const seen = new Set<string>();

  const pushSession = (s: SessionIndexReportItem) => {
    if (seen.has(s.sourceKey)) return;
    seen.add(s.sourceKey);
    sessions.push(s);
  };

  const dropIn = path.join(cwd, ".agentory", "session-index.json");
  const drop = readJsonFile(dropIn);
  if (drop && typeof drop === "object") {
    const o = drop as { sessions?: SessionIndexReportItem[] };
    if (Array.isArray(o.sessions)) {
      for (const s of o.sessions) pushSession(s);
    }
  }

  const ctx = { homeDir, cwd };
  for (const adapter of builtinAdapters) {
    if (!adapter.indexSessions) continue;
    const runtime = adapter.manifest.runtime;
    // manifest.runtime 是 string；仅收敛已知 RuntimeKind，其余留空 = 老形状（API parse 缺省 cursor）。
    const runtimeKind: RuntimeKind | undefined =
      runtime === "cursor" || runtime === "claude-code" || runtime === "unknown" ? runtime : undefined;
    const instanceId = agentInstanceIdFor(runtime, cwd);
    const part = adapter.indexSessions(ctx);
    for (const s of part.sessions) pushSession({ ...s, runtime: s.runtime ?? runtimeKind, agentInstanceId: s.agentInstanceId ?? instanceId });
    memories.push(...part.memories);
  }

  sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

  return { sessions: capSessionsPerRuntime(sessions), memories };
}

/** 按 Agent 实例（agentInstanceId，缺失回退 runtime）分组，仅保留每组最新的 N 条会话索引。 */
export function capSessionsPerRuntime(
  sessions: SessionIndexReportItem[],
  max: number = SESSIONS_PER_AGENT_MAX,
): SessionIndexReportItem[] {
  const seen = new Map<string, number>();
  const kept: SessionIndexReportItem[] = [];
  for (const s of sessions) {
    const key = s.agentInstanceId ?? s.runtime ?? "cursor";
    const n = seen.get(key) ?? 0;
    if (n >= max) continue;
    seen.set(key, n + 1);
    kept.push(s);
  }
  return kept;
}

export {
  buildCursorProjectPathMap,
  titleFromTranscriptJsonl,
} from "@agentoryhq/adapter-cursor";
