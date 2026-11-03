import fs from "node:fs";
import path from "node:path";
import type { ApplyAlignOpts, ApplyAlignResult } from "@agentoryhq/runtime-contract";

type McpServerEntry =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

/**
 * Write confirmed align patch to Claude Code project files.
 * - MCP → project root `.mcp.json`
 * - Skills name list → `.claude/agentory-skills.json` (tracking; does not install skill bodies)
 * - patch.rules 显式忽略（rules-desired-config Q1 裁决：一期规则载体只有 cursor，
 *   claude-code 诚实提示暂不支持；API 侧对 claude-code 恒下发空 rules patch，双保险）
 * Snapshots prior `.mcp.json` under `.claude/agentory-snapshots/`.
 */
export function applyAlignPatch(opts: ApplyAlignOpts): ApplyAlignResult {
  const mcpPath = path.join(opts.projectRoot, ".mcp.json");
  const skillsPath = path.join(opts.projectRoot, ".claude", "agentory-skills.json");
  if (!opts.confirmed) {
    return {
      ok: false,
      error: "refusing write: align not confirmed",
      mcpPath,
      skillsPath,
    };
  }

  const claudeDir = path.join(opts.projectRoot, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  let snapshotPath: string | undefined;
  let priorMcp: string | undefined;
  try {
    if (fs.existsSync(mcpPath)) {
      priorMcp = fs.readFileSync(mcpPath, "utf8");
      const snapDir = path.join(claudeDir, "agentory-snapshots");
      fs.mkdirSync(snapDir, { recursive: true });
      snapshotPath = path.join(snapDir, `mcp-${Date.now()}.json`);
      fs.writeFileSync(snapshotPath, priorMcp, "utf8");
    }

    const mcpServers: Record<string, McpServerEntry> = {};
    for (const item of opts.patch.mcp) {
      const command = item.command?.trim() || "echo";
      if (/^https?:\/\//i.test(command)) {
        // mcp-registry-integration：remote 鉴权头原样落盘（值仅 ${ENV} 占位符/非敏感
        // 明文——秘密本体只在节点环境变量，invariant #6；写侧 validateDesiredMcp 形状校验）。
        const headers =
          item.headers && Object.keys(item.headers).length ? item.headers : undefined;
        mcpServers[item.name] = { type: "http", url: command, ...(headers ? { headers } : {}) };
        continue;
      }
      const parts = command.split(/\s+/);
      // stdio env：Claude Code 原生展开 ${ENV}（AC-6：.mcp.json env 原样落盘）。
      const env = item.env && Object.keys(item.env).length ? item.env : undefined;
      mcpServers[item.name] = {
        command: parts[0] ?? "echo",
        args: parts.length > 1 ? parts.slice(1) : undefined,
        ...(env ? { env } : {}),
      };
    }
    const mcpBody = JSON.stringify({ mcpServers }, null, 2);
    const skillsBody = JSON.stringify({ skills: opts.patch.skills }, null, 2);

    fs.writeFileSync(mcpPath, `${mcpBody}\n`, "utf8");
    try {
      fs.writeFileSync(skillsPath, `${skillsBody}\n`, "utf8");
    } catch (err) {
      if (priorMcp !== undefined) fs.writeFileSync(mcpPath, priorMcp, "utf8");
      else if (fs.existsSync(mcpPath)) fs.unlinkSync(mcpPath);
      throw err;
    }

    return { ok: true, mcpPath, skillsPath, snapshotPath };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      mcpPath,
      skillsPath,
      snapshotPath,
    };
  }
}
