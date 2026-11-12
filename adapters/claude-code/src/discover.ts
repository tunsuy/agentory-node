import fs from "node:fs";
import path from "node:path";
import type { AdapterContext } from "@agentoryhq/runtime-contract";
import type { DiscoveredAgent, LiveMcpBinding } from "@agentoryhq/shared";

function readJsonFile(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Parse mcpServers map (project `.mcp.json` or user `~/.claude.json`). */
export function mcpFromClaudeConfig(raw: unknown): LiveMcpBinding[] {
  if (typeof raw !== "object" || raw === null) return [];
  const servers = (raw as { mcpServers?: unknown }).mcpServers;
  if (typeof servers !== "object" || servers === null) return [];
  const out: LiveMcpBinding[] = [];
  for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
    if (!name) continue;
    let command: string | undefined;
    if (typeof cfg === "object" && cfg !== null) {
      const c = cfg as { command?: unknown; args?: unknown; url?: unknown; type?: unknown };
      if (typeof c.command === "string") {
        const args = Array.isArray(c.args) ? c.args.map(String).join(" ") : "";
        command = args ? `${c.command} ${args}` : c.command;
      } else if (typeof c.url === "string") {
        command = c.url;
      }
    }
    out.push({ name, command, status: "unknown" });
  }
  return out;
}

/**
 * Dirent.isDirectory() 对 symlink 恒 false——软链技能目录（cc-switch 等管理器
 * 的落盘形态）会被静默滤掉（判例：~/.claude/skills/cloud-servers -> …/.cc-switch/…
 * 永不上报，而 Claude Code 本体跟随软链照常用）。symlink 一律 statSync 解引用
 * 再判目录；断链 → 跳过。
 */
function isSkillDir(dir: string, d: fs.Dirent): boolean {
  if (d.isDirectory()) return true;
  if (!d.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(dir, d.name)).isDirectory();
  } catch {
    return false;
  }
}

function skillsFromSkillsRoot(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => isSkillDir(dir, d))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export function detectClaudeCode(ctx: AdapterContext): boolean {
  const markers = [
    path.join(ctx.cwd, ".claude"),
    path.join(ctx.homeDir, ".claude"),
    path.join(ctx.cwd, ".mcp.json"),
    path.join(ctx.homeDir, ".claude.json"),
  ];
  return markers.some((p) => fs.existsSync(p));
}

/**
 * Prefer project `.mcp.json`; else user-scope `mcpServers` in `~/.claude.json`.
 */
export function discoverClaudeCodeConfig(ctx: AdapterContext): DiscoveredAgent | null {
  if (!detectClaudeCode(ctx)) return null;

  const projectMcp = path.join(ctx.cwd, ".mcp.json");
  const userClaudeJson = path.join(ctx.homeDir, ".claude.json");
  let mcp: LiveMcpBinding[] = [];
  if (fs.existsSync(projectMcp)) {
    mcp = mcpFromClaudeConfig(readJsonFile(projectMcp));
  } else if (fs.existsSync(userClaudeJson)) {
    mcp = mcpFromClaudeConfig(readJsonFile(userClaudeJson));
  }

  const skillNames = new Set<string>();
  for (const d of [
    path.join(ctx.cwd, ".claude", "skills"),
    path.join(ctx.homeDir, ".claude", "skills"),
  ]) {
    for (const name of skillsFromSkillsRoot(d)) skillNames.add(name);
  }

  return {
    runtime: "claude-code",
    supported: true,
    // 实例名 = runtime 显示名；项目目录已由节点/会话索引表达，不再拼进 displayName
    displayName: "Claude Code",
    mcp,
    skills: [...skillNames],
    // 诚实边界（rules-desired-config Q1 裁决）：一期规则载体只有 cursor（.cursor/rules/*.mdc），
    // claude-code 恒报空——CLAUDE.md 类载体联动属二期，另开 Brief。
    rules: [],
  };
}
