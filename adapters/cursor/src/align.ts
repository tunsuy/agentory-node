import fs from "node:fs";
import path from "node:path";
import type { ApplyAlignOpts, ApplyAlignResult } from "@agentoryhq/runtime-contract";

/**
 * Write confirmed align patch to Cursor project files.
 * Snapshots prior mcp.json under `.cursor/agentory-snapshots/`.
 * All-or-nothing: on failure restores snapshot when possible.
 */
export function applyAlignPatch(opts: ApplyAlignOpts): ApplyAlignResult {
  const mcpPath = path.join(opts.projectRoot, ".cursor", "mcp.json");
  const skillsPath = path.join(opts.projectRoot, ".cursor", "agentory-skills.json");
  if (!opts.confirmed) {
    return {
      ok: false,
      error: "refusing write: align not confirmed",
      mcpPath,
      skillsPath,
    };
  }

  const cursorDir = path.join(opts.projectRoot, ".cursor");
  fs.mkdirSync(cursorDir, { recursive: true });

  let snapshotPath: string | undefined;
  let priorMcp: string | undefined;
  try {
    if (fs.existsSync(mcpPath)) {
      priorMcp = fs.readFileSync(mcpPath, "utf8");
      const snapDir = path.join(cursorDir, "agentory-snapshots");
      fs.mkdirSync(snapDir, { recursive: true });
      snapshotPath = path.join(snapDir, `mcp-${Date.now()}.json`);
      fs.writeFileSync(snapshotPath, priorMcp, "utf8");
    }

    const mcpServers: Record<string, { command: string; args?: string[] }> = {};
    for (const item of opts.patch.mcp) {
      const command = item.command?.trim() || "echo";
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
