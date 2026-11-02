import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TranscriptSnapshot } from "@agentoryhq/shared";

/**
 * Node-side Claude Code transcript capture (claude-session-index, AC-4).
 * Same discipline as the cursor adapter: read jsonl locally → filter dialog
 * rows (human gate for user rows, assistant text blocks) → mask secret-shaped
 * strings → keep the near-end window. Only the masked, windowed snapshot ever
 * leaves the machine; raw body is never logged.
 */

/** 近端窗口上限（与 cursor transcript.ts 同值钉死） */
export const TRANSCRIPT_WINDOW_MESSAGES = 40;
/** 单条消息字符上限（同上） */
export const TRANSCRIPT_MESSAGE_MAX_CHARS = 2000;

const SECRET_PATTERNS: Array<{ re: RegExp; mask: string }> = [
  { re: /\bsk-[A-Za-z0-9_\-]{16,}/g, mask: "sk-••••••••" },
  { re: /\bghp_[A-Za-z0-9]{20,}/g, mask: "ghp_••••••••" },
  { re: /\bgho_[A-Za-z0-9]{20,}/g, mask: "gho_••••••••" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, mask: "github_pat_••••••••" },
  { re: /\bxox[baprs]-[A-Za-z0-9\-]{16,}/g, mask: "xox•-••••••••" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, mask: "AKIA••••••••" },
  { re: /(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, mask: "password=••••••••" },
  // 长随机密钥形态（hex/base64 ≥ 32 字符，独立成词）
  { re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, mask: "••••••••" },
  { re: /\b[0-9a-f]{32,}\b/gi, mask: "••••••••" },
];

/** Mask secret-shaped substrings BEFORE anything leaves the node (AC-4). */
export function maskSecrets(text: string): string {
  let out = text;
  for (const { re, mask } of SECRET_PATTERNS) {
    out = out.replace(re, mask);
  }
  return out;
}

type ClaudeRow = {
  type?: unknown;
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

/** Human gate (brief §3 陷阱): user + non-tool_result content + origin.kind==="human". */
function humanTextFromUserRow(row: ClaudeRow): string {
  if (row.type !== "user" || row.isSidechain === true) return "";
  if (!isHumanOrigin(row)) return "";
  const msg = row.message;
  if (!msg || typeof msg !== "object") return "";
  const content = (msg as { content?: unknown }).content;
  if (Array.isArray(content) &&
      content.some((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "tool_result")) {
    return "";
  }
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string") {
        parts.push((b as { text: string }).text);
      }
    }
    return parts.join(" ");
  }
  return "";
}

/** Assistant rows: aggregate message.content text blocks (skip thinking/tool_use). */
function assistantTextFromRow(row: ClaudeRow): string {
  if (row.type !== "assistant" || row.isSidechain === true) return "";
  const msg = row.message;
  if (!msg || typeof msg !== "object") return "";
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string") {
      parts.push((b as { text: string }).text);
    }
  }
  return parts.join(" ");
}

/**
 * Read the Claude session jsonl at `file` and build a masked, windowed
 * snapshot. Returns undefined when the file is missing/unreadable; an empty
 * snapshot for a session with no extractable dialog rows.
 */
export function captureTranscriptSnapshot(file: string, now = new Date()): TranscriptSnapshot | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const sourceKey = `claude-session:${file}`;
  const all: TranscriptSnapshot["messages"] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    const row = o as ClaudeRow;
    // Unknown row types (mode/system/snapshot/attachment/…) fall through both
    // extractors as "" — silently skipped, never crash (brief §7 schema-drift guard).
    let role: "user" | "assistant" | undefined;
    let text = "";
    const human = humanTextFromUserRow(row);
    if (human) {
      role = "user";
      text = human;
    } else {
      const assistant = assistantTextFromRow(row);
      if (assistant) {
        role = "assistant";
        text = assistant;
      }
    }
    if (!role || !text.trim()) continue;
    if (text.length > TRANSCRIPT_MESSAGE_MAX_CHARS) {
      text = `${text.slice(0, TRANSCRIPT_MESSAGE_MAX_CHARS)}…`;
    }
    const ts = typeof row.timestamp === "string" ? row.timestamp : "";
    all.push({ role, ts, text });
  }

  const windowMessages = all.length > TRANSCRIPT_WINDOW_MESSAGES
    ? all.slice(-TRANSCRIPT_WINDOW_MESSAGES)
    : all;
  const truncated = all.length > windowMessages.length;
  return {
    sourceKey,
    messages: windowMessages.map((m) => ({ ...m, text: maskSecrets(m.text) })),
    truncated,
    windowTotal: truncated ? `${windowMessages.length} / ${all.length} 条` : undefined,
    capturedAt: now.toISOString(),
  };
}

export type TranscriptFetchOpts = {
  homeDir?: string;
};

/**
 * Resolve a session jsonl path for a claude sourceKey
 * (`claude-session:<abs path>` as emitted by asset-index.ts).
 * Only files under `~/.claude/projects/` qualify — no arbitrary path
 * scanning (invariants §4; brief §4 不做: no AGENTORY_CLAUDE_ROOT override,
 * default scan face stays narrow).
 */
export function transcriptFileForSourceKey(sourceKey: string, homeDir?: string): string | undefined {
  const prefix = "claude-session:";
  if (!sourceKey.startsWith(prefix)) return undefined;
  const file = sourceKey.slice(prefix.length);
  const home = homeDir ?? os.homedir();
  const root = path.join(home, ".claude", "projects");
  try {
    const rel = path.relative(root, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  } catch {
    return undefined;
  }
  return file;
}
