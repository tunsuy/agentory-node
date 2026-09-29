import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MemoryIndexReportItem, SessionIndexReportItem } from "@agentory/shared";
import { builtinAdapters } from "./registry.js";

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
    const part = adapter.indexSessions(ctx);
    for (const s of part.sessions) pushSession(s);
    memories.push(...part.memories);
  }

  sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

  return { sessions, memories };
}

export {
  buildCursorProjectPathMap,
  titleFromTranscriptJsonl,
} from "@agentory/adapter-cursor";
