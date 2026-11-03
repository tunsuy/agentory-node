import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MEMORY_DESC_MAX, MEMORY_TITLE_MAX } from "@agentoryhq/shared";
import { maskSecrets } from "./transcript.js";

/**
 * memory-asset-cards: node-side memory summary extraction — the FIRST AND ONLY
 * content-derived egress channel. Same discipline as transcript.ts (mask +
 * window BEFORE anything leaves the machine):
 * - frontmatter (name / description / metadata.type) wins;
 * - fallback: title = filename without extension, description = first
 *   non-heading body line, masked + truncated (≤ MEMORY_DESC_MAX);
 * - contentHash = sha256(content) first 16 hex — grouping key only, hash
 *   leaving the node ≠ content leaving the node;
 * - the full file body NEVER leaves the node.
 */

/** 摘要读取窗口上限：超过则视为异常大文件，只留既有元数据（诚实「无摘要」，不半读大文件）。 */
export const SUMMARY_READ_MAX_BYTES = 256 * 1024;
/** memType 原值长度上限（词表外值归「未分类」由 UI 承担，节点只防超长垃圾）。 */
const MEM_TYPE_MAX = 32;

export type MemorySummary = {
  title?: string;
  description?: string;
  memType?: string;
  contentHash?: string;
};

/** Minimal YAML-ish frontmatter parse: top-level `key: value` + `metadata:` 块内 `type:`。
 *  不引 yaml 依赖（记忆文件 frontmatter 形状固定：name/description/metadata.type）。 */
export function parseMemoryFrontmatter(text: string): {
  name?: string;
  description?: string;
  metadataType?: string;
  body: string;
} {
  if (!text.startsWith("---")) return { body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { body: text };
  const fmBlock = text.slice(3, end).replace(/^\r?\n/, "");
  const body = text.slice(text.indexOf("\n", end + 1) < 0 ? text.length : text.indexOf("\n", end + 1) + 1);
  let name: string | undefined;
  let description: string | undefined;
  let metadataType: string | undefined;
  let inMetadata = false;
  for (const raw of fmBlock.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indented = /^\s/.test(line);
    const m = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      inMetadata = false;
      continue;
    }
    const key = m[1];
    const val = m[2].trim().replace(/^["']|["']$/g, "");
    if (!indented) inMetadata = key === "metadata" && val === "";
    if (!indented && key === "name" && val) name = val;
    else if (!indented && key === "description" && val) description = val;
    else if (indented && inMetadata && key === "type" && val) metadataType = val;
  }
  return { name, description, metadataType, body };
}

/** 正文首个非标题/非空行（回退摘要源）；mask + 截断在出机前完成。 */
export function firstBodyLine(body: string): string {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#") || line === "---") continue;
    return line;
  }
  return "";
}

function clampMasked(text: string, max: number): string {
  const masked = maskSecrets(text.replace(/\s+/g, " ").trim());
  return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
}

/**
 * Extract the card summary for one memory/rules markdown file.
 * Returns {} for unreadable/oversized files (caller keeps metadata-only shape —
 * honest「无摘要」downstream, never a fabricated one).
 */
export function summarizeMemoryFile(file: string): MemorySummary {
  let content: string;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > SUMMARY_READ_MAX_BYTES) return {};
    content = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const contentHash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  const { name, description, metadataType, body } = parseMemoryFrontmatter(content);
  const fallbackName = path.basename(file).replace(/\.(md|mdc|txt)$/i, "");
  const title = clampMasked(name || fallbackName, MEMORY_TITLE_MAX);
  const descriptionOut = description || firstBodyLine(body);
  return {
    title: title || undefined,
    description: descriptionOut ? clampMasked(descriptionOut, MEMORY_DESC_MAX) : undefined,
    memType:
      metadataType && metadataType.length <= MEM_TYPE_MAX ? metadataType : undefined,
    contentHash,
  };
}
