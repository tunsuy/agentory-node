import fs from "node:fs";
import path from "node:path";
import type { AdapterContext } from "@agentory/runtime-contract";
import type { DiscoveredAgent, LiveMcpBinding } from "@agentory/shared";

function readJsonFile(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function mcpFromCursorConfig(raw: unknown): LiveMcpBinding[] {
  if (typeof raw !== "object" || raw === null) return [];
  const servers = (raw as { mcpServers?: unknown }).mcpServers;
  if (typeof servers !== "object" || servers === null) return [];
  const out: LiveMcpBinding[] = [];
  for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
    if (!name) continue;
    let command: string | undefined;
    if (typeof cfg === "object" && cfg !== null) {
      const c = cfg as { command?: unknown; args?: unknown };
      if (typeof c.command === "string") {
        const args = Array.isArray(c.args) ? c.args.map(String).join(" ") : "";
        command = args ? `${c.command} ${args}` : c.command;
      }
    }
    out.push({ name, command, status: "unknown" });
  }
  return out;
}

function skillsFromDir(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || (d.isFile() && d.name.endsWith(".md")))
      .map((d) => d.name.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

export function detectCursor(ctx: AdapterContext): boolean {
  const cursorMcpCandidates = [
    path.join(ctx.cwd, ".cursor", "mcp.json"),
    path.join(ctx.homeDir, ".cursor", "mcp.json"),
  ];
  for (const file of cursorMcpCandidates) {
    if (fs.existsSync(file)) return true;
  }
  return fs.existsSync(path.join(ctx.cwd, ".cursor"));
}

export function discoverCursorConfig(ctx: AdapterContext): DiscoveredAgent | null {
  if (!detectCursor(ctx)) return null;

  const cursorMcpCandidates = [
    path.join(ctx.cwd, ".cursor", "mcp.json"),
    path.join(ctx.homeDir, ".cursor", "mcp.json"),
  ];
  let cursorMcp: LiveMcpBinding[] = [];
  for (const file of cursorMcpCandidates) {
    if (!fs.existsSync(file)) continue;
    cursorMcp = mcpFromCursorConfig(readJsonFile(file));
    break;
  }

  const skillDirs = [
    path.join(ctx.cwd, ".cursor", "skills"),
    path.join(ctx.homeDir, ".cursor", "skills"),
    path.join(ctx.cwd, ".cursor", "skills-cursor"),
    path.join(ctx.homeDir, ".cursor", "skills-cursor"),
  ];
  const skillNames = new Set<string>();
  for (const d of skillDirs) {
    for (const name of skillsFromDir(d)) skillNames.add(name);
  }

  return {
    runtime: "cursor",
    supported: true,
    displayName: `Cursor · ${path.basename(ctx.cwd) || "workspace"}`,
    mcp: cursorMcp,
    skills: [...skillNames],
  };
}
