import fs from "node:fs";
import path from "node:path";
import type { ApplyAlignOpts, ApplyAlignResult } from "@agentory/runtime-contract";

type McpServerEntry =
  | { command: string; args?: string[] }
  | { type: "http"; url: string };

/**
 * Write confirmed align patch to Claude Code project files.
 * - MCP → project root `.mcp.json`
 * - Skills name list → `.claude/agentory-skills.json` (tracking; does not install skill bodies)
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
        mcpServers[item.name] = { type: "http", url: command };
        continue;
      }
      const parts = command.split(/\s+/);
      mcpServers[item.name] = {
        command: parts[0] ?? "echo",
        args: parts.length > 1 ? parts.slice(1) : undefined,
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
