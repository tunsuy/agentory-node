import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AdapterContext } from "@agentoryhq/runtime-contract";
import type { DiscoveredAgent, LiveMcpBinding, LiveRuleBinding } from "@agentoryhq/shared";

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

/**
 * 规则发现（rules-desired-config）：扫 `.cursor/rules/*.mdc`，只报名字 + 内容 sha256，
 * 正文永不出节点（会话流索引只读口径不变）。name = 去 .mdc 扩展名的文件名。
 * hash 契约：sha256(文件字节) = API 侧 ruleBodyHash(body)——文件 = body 原样。
 * dirs 顺序 = cwd → home，先见优先（cwd 优先，与 asset-index 口径一致）。
 */
function rulesFromDirs(dirs: string[]): LiveRuleBinding[] {
  const byName = new Map<string, LiveRuleBinding>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".mdc")) continue;
      const name = file.slice(0, -".mdc".length);
      if (!name || byName.has(name)) continue;
      const full = path.join(dir, file);
      try {
        if (!fs.statSync(full).isFile()) continue;
        const contentHash = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
        byName.set(name, { name, contentHash });
      } catch {
        continue;
      }
    }
  }
  return [...byName.values()];
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
    rules: rulesFromDirs([
      path.join(ctx.cwd, ".cursor", "rules"),
      path.join(ctx.homeDir, ".cursor", "rules"),
    ]),
  };
}
