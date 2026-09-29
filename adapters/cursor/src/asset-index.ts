import fs from "node:fs";
import path from "node:path";
import type { AdapterContext, AssetIndexResult } from "@agentoryhq/runtime-contract";
import type { MemoryIndexReportItem, SessionIndexReportItem } from "@agentoryhq/shared";

const TITLE_MAX = 80;

function readJsonFile(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function mtimeIso(file: string): string {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function slugifyAbsPath(abs: string): string {
  return abs.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\//g, "-");
}

/** Map Cursor project dir slug → absolute folder path (best-effort). */
export function buildCursorProjectPathMap(homeDir: string): Map<string, string> {
  const map = new Map<string, string>();
  const add = (folderUri: string) => {
    const raw = folderUri.startsWith("file://") ? folderUri.slice("file://".length) : folderUri;
    if (!raw.startsWith("/")) return;
    map.set(slugifyAbsPath(raw), raw);
  };

  const storageJson = path.join(
    homeDir,
    "Library",
    "Application Support",
    "Cursor",
    "User",
    "globalStorage",
    "storage.json",
  );
  const storage = readJsonFile(storageJson);
  if (storage && typeof storage === "object") {
    const folders = (storage as { backupWorkspaces?: { folders?: { folderUri?: string }[] } })
      .backupWorkspaces?.folders;
    if (Array.isArray(folders)) {
      for (const f of folders) {
        if (f?.folderUri) add(f.folderUri);
      }
    }
  }

  const wsRoot = path.join(
    homeDir,
    "Library",
    "Application Support",
    "Cursor",
    "User",
    "workspaceStorage",
  );
  try {
    for (const name of fs.readdirSync(wsRoot)) {
      const wj = readJsonFile(path.join(wsRoot, name, "workspace.json"));
      if (wj && typeof wj === "object") {
        const folder = (wj as { folder?: string }).folder;
        if (typeof folder === "string") add(folder);
      }
    }
  } catch {
    /* no workspaceStorage */
  }

  return map;
}

function extractTextBlob(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (typeof c === "string") parts.push(c);
      else if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string") {
        parts.push((c as { text: string }).text);
      }
    }
    return parts.join(" ");
  }
  if (content && typeof content === "object" && typeof (content as { text?: unknown }).text === "string") {
    return (content as { text: string }).text;
  }
  return "";
}

/** Read only enough of the transcript to derive a short title — never return full body. */
export function titleFromTranscriptJsonl(file: string): string {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(16 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const chunk = buf.slice(0, n).toString("utf8");
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        let o: unknown;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (!o || typeof o !== "object") continue;
        const row = o as { role?: unknown; message?: unknown };
        if (row.role !== "user") continue;
        const msg = row.message;
        let text = "";
        if (typeof msg === "string") text = msg;
        else if (msg && typeof msg === "object") {
          text = extractTextBlob((msg as { content?: unknown }).content);
        }
        text = text
          .replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, " ")
          .replace(/<\/?user_query>/gi, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (!text) continue;
        return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* ignore */
  }
  return "";
}

function collectMetaSessions(cwd: string, home: string): SessionIndexReportItem[] {
  const sessions: SessionIndexReportItem[] = [];
  const sessionDirs = [path.join(cwd, ".cursor", "sessions"), path.join(home, ".cursor", "sessions")];
  for (const dir of sessionDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".meta.json")) continue;
      const file = path.join(dir, name);
      const raw = readJsonFile(file);
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      const displayName =
        typeof o.displayName === "string" && o.displayName.trim()
          ? o.displayName.trim()
          : name.replace(/\.meta\.json$/, "");
      const updatedAt = typeof o.updatedAt === "string" ? o.updatedAt : mtimeIso(file);
      const projectPath = typeof o.projectPath === "string" ? o.projectPath : cwd;
      sessions.push({
        sourceKey: `cursor-session:${file}`,
        displayName,
        projectPath,
        updatedAt,
      });
    }
  }
  return sessions;
}

function collectNativeTranscripts(home: string): SessionIndexReportItem[] {
  const sessions: SessionIndexReportItem[] = [];
  const projectsRoot = path.join(home, ".cursor", "projects");
  if (!fs.existsSync(projectsRoot)) return sessions;
  const pathMap = buildCursorProjectPathMap(home);

  let projectNames: string[] = [];
  try {
    projectNames = fs.readdirSync(projectsRoot);
  } catch {
    return sessions;
  }

  for (const slug of projectNames) {
    const transcriptsRoot = path.join(projectsRoot, slug, "agent-transcripts");
    if (!fs.existsSync(transcriptsRoot)) continue;
    const projectPath = pathMap.get(slug) || slug;
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(transcriptsRoot);
    } catch {
      continue;
    }
    for (const id of ids) {
      const file = path.join(transcriptsRoot, id, `${id}.jsonl`);
      if (!fs.existsSync(file)) continue;
      try {
        if (!fs.statSync(file).isFile()) continue;
      } catch {
        continue;
      }
      const title = titleFromTranscriptJsonl(file);
      sessions.push({
        sourceKey: `cursor-transcript:${file}`,
        displayName: title || id.slice(0, 8),
        projectPath,
        updatedAt: mtimeIso(file),
      });
    }
  }
  return sessions;
}

function collectRulesAndMemory(cwd: string, home: string): MemoryIndexReportItem[] {
  const memories: MemoryIndexReportItem[] = [];
  const ruleDirs = [path.join(cwd, ".cursor", "rules"), path.join(home, ".cursor", "rules")];
  for (const dir of ruleDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (!fs.statSync(file).isFile()) continue;
      } catch {
        continue;
      }
      memories.push({
        sourceKey: `cursor-rules:${file}`,
        kind: "rules",
        pathLabel: path.relative(cwd, file).replace(/\\/g, "/") || name,
        projectPath: cwd,
        updatedAt: mtimeIso(file),
      });
    }
    if (memories.some((m) => m.kind === "rules")) break;
  }

  const memoryDirs = [path.join(cwd, ".cursor", "memory"), path.join(home, ".cursor", "memory")];
  for (const dir of memoryDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (!fs.statSync(file).isFile()) continue;
      } catch {
        continue;
      }
      memories.push({
        sourceKey: `cursor-memory:${file}`,
        kind: "memory",
        pathLabel: path.relative(cwd, file).replace(/\\/g, "/") || name,
        projectPath: cwd,
        updatedAt: mtimeIso(file),
      });
    }
    if (memories.some((m) => m.kind === "memory")) break;
  }
  return memories;
}

/**
 * Cursor asset index (metadata only) — no Host fixtures.
 * - Legacy: `.cursor/sessions/*.meta.json`
 * - Native: ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl
 * - Rules / memory dirs (path + mtime only)
 */
export function indexCursorSessions(ctx: AdapterContext): AssetIndexResult {
  const { cwd, homeDir: home } = ctx;
  const sessions: SessionIndexReportItem[] = [];
  const seen = new Set<string>();

  const pushSession = (s: SessionIndexReportItem) => {
    if (seen.has(s.sourceKey)) return;
    seen.add(s.sourceKey);
    sessions.push(s);
  };

  for (const s of collectMetaSessions(cwd, home)) pushSession(s);
  for (const s of collectNativeTranscripts(home)) pushSession(s);

  sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

  return { sessions, memories: collectRulesAndMemory(cwd, home) };
}
