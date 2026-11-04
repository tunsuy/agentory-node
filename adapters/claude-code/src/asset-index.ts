import fs from "node:fs";
import path from "node:path";
import type { AdapterContext, AssetIndexResult } from "@agentoryhq/runtime-contract";
import type { MemoryIndexReportItem, SessionIndexReportItem } from "@agentoryhq/shared";
import { summarizeMemoryFile } from "./memory-summary.js";

const TITLE_MAX = 80;
const PEEK_BYTES = 16 * 1024;

/**
 * Claude Code rows live at ~/.claude/projects/<slug>/<uuid>.jsonl (one file
 * per session). Row shapes (verified against real transcripts, structure
 * only — bodies never leave the node):
 * - non-dialog rows: mode / permission-mode / system / file-history-snapshot
 *   / attachment / last-prompt / ai-title / queue-operation / … — skipped.
 * - user rows: message.content is a string (human), a text array (human),
 *   or a [{type:"tool_result",…}] array (tool echo — NOT human input).
 *   The authoritative human gate is origin:{kind:"human"}.
 * - sidechain rows (isSidechain:true — subagent transcripts) are excluded.
 */
type ClaudeRow = {
  type?: unknown;
  cwd?: unknown;
  timestamp?: unknown;
  isSidechain?: unknown;
  origin?: unknown;
  message?: unknown;
};

function isHumanOrigin(row: ClaudeRow): boolean {
  const origin = row.origin;
  return !!origin && typeof origin === "object" &&
    (origin as { kind?: unknown }).kind === "human";
}

/** Human gate: user row + non-tool_result content shape + origin.kind==="human". */
function humanTextFromUserRow(row: ClaudeRow): string {
  if (row.type !== "user" || row.isSidechain === true) return "";
  if (!isHumanOrigin(row)) return "";
  const msg = row.message;
  if (!msg || typeof msg !== "object") return "";
  const content = (msg as { content?: unknown }).content;
  // tool_result arrays are tool echoes wearing a "user" type — reject.
  if (Array.isArray(content) &&
      content.some((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "tool_result")) {
    return "";
  }
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (typeof b === "string") parts.push(b);
      else if (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string") {
        parts.push((b as { text: string }).text);
      }
    }
    return parts.join(" ");
  }
  return "";
}

function cleanTitleText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Read only enough of the session jsonl (16KB) to derive a short title —
 * never the full body. Falls back to "" when no human row is in range.
 */
export function titleFromClaudeSessionJsonl(file: string): string {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(PEEK_BYTES);
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
        const text = cleanTitleText(humanTextFromUserRow(o as ClaudeRow));
        if (!text) continue;
        return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* ignore unreadable file */
  }
  return "";
}

/**
 * 按 session UUID 定位 ~/.claude/projects/<slug>/<uuid>.jsonl（续聊 cwd 解析用）。
 * 只认顶层同名文件；找不到 → undefined。
 */
export function findClaudeSessionJsonl(
  homeDir: string,
  sessionId: string,
): string | undefined {
  const id = sessionId.trim().toLowerCase();
  if (!id) return undefined;
  const needle = `${id}.jsonl`;
  const projectsRoot = path.join(homeDir, ".claude", "projects");
  let slugs: string[] = [];
  try {
    slugs = fs.readdirSync(projectsRoot);
  } catch {
    return undefined;
  }
  for (const slug of slugs) {
    const file = path.join(projectsRoot, slug, needle);
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* next */
    }
  }
  return undefined;
}

/**
 * 续聊工作目录：会话 jsonl 内 cwd 字段（且目录仍存在）；否则 fallback。
 */
export function cwdForClaudeResume(
  homeDir: string,
  sessionId: string,
  fallback: string,
): string {
  const file = findClaudeSessionJsonl(homeDir, sessionId);
  if (!file) return fallback;
  const fromSession = projectPathFromClaudeSessionJsonl(file);
  if (fromSession) {
    try {
      if (fs.statSync(fromSession).isDirectory()) return fromSession;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

/** cwd field on rows is the authoritative projectPath (first row wins, 16KB-peek). */
export function projectPathFromClaudeSessionJsonl(file: string): string | undefined {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(PEEK_BYTES);
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
        const cwd = (o as ClaudeRow).cwd;
        if (typeof cwd === "string" && cwd.trim()) return cwd;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* ignore unreadable file */
  }
  return undefined;
}

function mtimeIso(file: string): string {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/**
 * Claude Code asset index (metadata only).
 * - Sessions: ~/.claude/projects/<slug>/<uuid>.jsonl (top-level .jsonl only;
 *   <uuid>/ subdirs hold subagent/tool data and are excluded).
 * - Memory: ~/.claude/projects/<slug>/memory/*.md (kind=memory, Q1 随行).
 */
export function indexClaudeSessions(ctx: AdapterContext): AssetIndexResult {
  const home = ctx.homeDir;
  const projectsRoot = path.join(home, ".claude", "projects");
  const sessions: SessionIndexReportItem[] = [];
  const memories: MemoryIndexReportItem[] = [];

  let slugs: string[] = [];
  try {
    slugs = fs.readdirSync(projectsRoot);
  } catch {
    return { sessions, memories };
  }

  for (const slug of slugs) {
    const projectDir = path.join(projectsRoot, slug);
    try {
      if (!fs.statSync(projectDir).isDirectory()) continue;
    } catch {
      continue;
    }

    let names: string[] = [];
    try {
      names = fs.readdirSync(projectDir);
    } catch {
      continue;
    }
    // Prefer cwd from the first indexed session in this slug as the memory projectPath
    // (memory/*.md has no cwd of its own; never invent a fake <name>.jsonl path).
    let slugProjectPath: string | undefined;
    for (const name of names) {
      // Top-level .jsonl files only — <uuid>/ subdirs and stray files skipped.
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(projectDir, name);
      try {
        if (!fs.statSync(file).isFile()) continue;
      } catch {
        continue;
      }
      const title = titleFromClaudeSessionJsonl(file);
      if (!title) continue; // no human row in peek range — not an indexable conversation
      const projectPath = projectPathFromClaudeSessionJsonl(file);
      if (!slugProjectPath && projectPath) slugProjectPath = projectPath;
      sessions.push({
        sourceKey: `claude-session:${file}`,
        displayName: title,
        projectPath,
        updatedAt: mtimeIso(file),
        runtime: "claude-code",
      });
    }

    // Memory dimension (Q1 随行): <slug>/memory/*.md, path label keeps the slug visible.
    const memoryDir = path.join(projectDir, "memory");
    if (fs.existsSync(memoryDir)) {
      let memNames: string[] = [];
      try {
        memNames = fs.readdirSync(memoryDir);
      } catch {
        continue;
      }
      for (const name of memNames) {
        if (!name.endsWith(".md")) continue;
        const file = path.join(memoryDir, name);
        try {
          if (!fs.statSync(file).isFile()) continue;
        } catch {
          continue;
        }
        memories.push({
          sourceKey: `claude-memory:${file}`,
          kind: "memory",
          pathLabel: `${slug}/memory/${name}`,
          projectPath: slugProjectPath,
          updatedAt: mtimeIso(file),
          runtime: "claude-code",
          // memory-asset-cards：节点侧摘要（frontmatter → 首行回退；mask + 截断后才出机，全文永不出机）
          ...summarizeMemoryFile(file),
        });
      }
    }
  }

  sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  memories.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return { sessions, memories };
}
