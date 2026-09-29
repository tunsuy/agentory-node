import fs from "node:fs";
import os from "node:os";
import type { AdapterContext } from "@agentoryhq/runtime-contract";
import type { DiscoveredAgent } from "@agentoryhq/shared";
import { probeAll } from "./probe.js";
import { builtinAdapters } from "./registry.js";

export type DiscoverOpts = {
  /** Override home for tests. */
  homeDir?: string;
  /** Optional JSON fixture path (AGENTORY_DISCOVERY_FIXTURE). */
  fixturePath?: string;
  cwd?: string;
  /** Skip probe (unit tests of filesystem parse only). */
  skipProbe?: boolean;
};

function readJsonFile(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function adapterContext(opts: DiscoverOpts): AdapterContext {
  return {
    homeDir: opts.homeDir ?? os.homedir(),
    cwd: opts.cwd ?? process.cwd(),
  };
}

function discoverAgentsSync(opts: DiscoverOpts = {}): DiscoveredAgent[] {
  const fixture = opts.fixturePath ?? process.env.AGENTORY_DISCOVERY_FIXTURE;
  if (fixture) {
    const raw = readJsonFile(fixture);
    if (Array.isArray(raw)) return raw as DiscoveredAgent[];
    if (raw && typeof raw === "object" && Array.isArray((raw as { agents?: unknown }).agents)) {
      return (raw as { agents: DiscoveredAgent[] }).agents;
    }
  }

  const ctx = adapterContext(opts);
  const agents: DiscoveredAgent[] = [];
  for (const adapter of builtinAdapters) {
    if (!adapter.detect(ctx)) continue;
    if (adapter.discoverConfig) {
      const agent = adapter.discoverConfig(ctx);
      if (agent) agents.push(agent);
    }
  }
  return agents;
}

/** Sync filesystem/fixture discovery (no probe). */
export function discoverAgents(opts: DiscoverOpts = {}): DiscoveredAgent[] {
  return discoverAgentsSync(opts);
}

/** Discovery + binding-level health probe (AC-2). */
export async function discoverAgentsWithHealth(opts: DiscoverOpts = {}): Promise<DiscoveredAgent[]> {
  const agents = discoverAgentsSync(opts);
  if (opts.skipProbe) return agents;
  return Promise.all(
    agents.map(async (a) => {
      if (!a.mcp.length) return a;
      const mcp = await probeAll(a.mcp.map((m) => ({ name: m.name, command: m.command })));
      return { ...a, mcp };
    }),
  );
}
