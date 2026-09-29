import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TranscriptSnapshot } from "@agentoryhq/shared";

/**
 * Node-side transcript capture for on-demand review (model B · S-tier).
 * Whole pipeline is local: read JSONL → extract messages → mask secret-shaped
 * strings → keep the near-end window. Only the masked, windowed snapshot ever
 * leaves the machine; raw body is never logged (brief §5 AC-3/AC-9).
 */

/** 近端窗口上限（brief AC-4：具体值在此钉死） */
export const TRANSCRIPT_WINDOW_MESSAGES = 40;
/** 单条消息字符上限（同上） */
export const TRANSCRIPT_MESSAGE_MAX_CHARS = 2000;

type CursorRow = {
  role?: unknown;
  ts?: unknown;
  message?: unknown;
};

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

/** Mask secret-shaped substrings BEFORE anything leaves the node (AC-3). */
export function maskSecrets(text: string): string {
  let out = text;
  for (const { re, mask } of SECRET_PATTERNS) {
    out = out.replace(re, mask);
  }
  return out;
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

function cleanTimestampTag(text: string): string {
  return text
    .replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, " ")
    .replace(/<\/?user_query>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Read the transcript at `file` and build a masked, windowed snapshot.
 * Returns undefined when the file is missing/unreadable; an empty snapshot
 * for a session with no extractable messages (brief AC-1 empty state).
 */
export function captureTranscriptSnapshot(file: string, now = new Date()): TranscriptSnapshot | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const sourceKey = `cursor-transcript:${file}`;
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
    const row = o as CursorRow;
    if (row.role !== "user" && row.role !== "assistant") continue;
    let text = "";
    if (typeof row.message === "string") text = row.message;
    else if (row.message && typeof row.message === "object") {
      text = extractTextBlob((row.message as { content?: unknown }).content);
    }
    text = cleanTimestampTag(text);
    if (!text) continue;
    if (text.length > TRANSCRIPT_MESSAGE_MAX_CHARS) {
      text = `${text.slice(0, TRANSCRIPT_MESSAGE_MAX_CHARS)}…`;
    }
    const ts = typeof row.ts === "string" ? row.ts : "";
    all.push({ role: row.role, ts, text });
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
 * Resolve a transcript file path for a session sourceKey
 * (`cursor-transcript:<abs path>` as emitted by asset-index.ts).
 * Only files under `~/.cursor/projects/` (or AGENTORY_CURSOR_ROOT override)
 * qualify — no arbitrary path scanning (invariants §4).
 */
export function transcriptFileForSourceKey(sourceKey: string, homeDir?: string): string | undefined {
  const prefix = "cursor-transcript:";
  if (!sourceKey.startsWith(prefix)) return undefined;
  const file = sourceKey.slice(prefix.length);
  const home = homeDir ?? (process.env.AGENTORY_CURSOR_ROOT?.trim() || os.homedir());
  const root = path.join(home, ".cursor", "projects");
  try {
    const rel = path.relative(root, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  } catch {
    return undefined;
  }
  return file;
}
