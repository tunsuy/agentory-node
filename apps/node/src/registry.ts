import type { RuntimeAdapter } from "@agentoryhq/runtime-contract";
import { claudeCodeAdapter } from "@agentoryhq/adapter-claude-code";
import { cursorAdapter } from "@agentoryhq/adapter-cursor";

/** Built-in adapters shipped with agentory-node (仓内 adapters/*). */
export const builtinAdapters: readonly RuntimeAdapter[] = [cursorAdapter, claudeCodeAdapter];

export function adapterForRuntime(runtime: string): RuntimeAdapter | undefined {
  return builtinAdapters.find((a) => a.manifest.runtime === runtime);
}
