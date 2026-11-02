import type { AlignPatch } from "@agentoryhq/shared";
import { applyAlignPatch as cursorApplyAlign } from "@agentoryhq/adapter-cursor";
import { applyAlignPatch as claudeApplyAlign } from "@agentoryhq/adapter-claude-code";
import { adapterForRuntime } from "./registry.js";

export type ApplyAlignOpts = {
  /** Project root for the runtime (Cursor: `.cursor/`; Claude: `.mcp.json` root). */
  cursorRoot: string;
  patch: AlignPatch;
  confirmed: boolean;
  runtime?: string;
};

export type ApplyAlignResult = {
  ok: boolean;
  error?: string;
  mcpPath: string;
  skillsPath: string;
  snapshotPath?: string;
  /** 规则写盘目录(rules-desired-config,cursor-only;未写规则时缺省) */
  rulesDir?: string;
  /** 被覆盖规则文件的快照目录(rules-<ts>/;无覆盖时缺省) */
  rulesSnapshotDir?: string;
};

/** Host facade — routes to the matching RuntimeAdapter.applyAlign. */
export function applyAlignPatch(opts: ApplyAlignOpts): ApplyAlignResult {
  const runtime = opts.runtime ?? "cursor";
  const adapter = adapterForRuntime(runtime);
  if (!adapter?.applyAlign) {
    return {
      ok: false,
      error: `no applyAlign adapter for runtime ${runtime}`,
      mcpPath: "",
      skillsPath: "",
    };
  }
  return adapter.applyAlign({
    projectRoot: opts.cursorRoot,
    patch: opts.patch,
    confirmed: opts.confirmed,
  });
}

/** @deprecated Prefer applyAlignPatch({ runtime }) — kept for explicit cursor tests. */
export function applyCursorAlignPatch(opts: {
  cursorRoot: string;
  patch: AlignPatch;
  confirmed: boolean;
}): ApplyAlignResult {
  return cursorApplyAlign({
    projectRoot: opts.cursorRoot,
    patch: opts.patch,
    confirmed: opts.confirmed,
  });
}

export function applyClaudeAlignPatch(opts: {
  projectRoot: string;
  patch: AlignPatch;
  confirmed: boolean;
}): ApplyAlignResult {
  return claudeApplyAlign(opts);
}
