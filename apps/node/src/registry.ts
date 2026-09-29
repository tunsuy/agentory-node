import type { RuntimeAdapter } from "@agentory/runtime-contract";
import { claudeCodeAdapter } from "@agentory/adapter-claude-code";
import { cursorAdapter } from "@agentory/adapter-cursor";

/** Built-in adapters shipped with agentory-node (仓内 adapters/*). */
export const builtinAdapters: readonly RuntimeAdapter[] = [cursorAdapter, claudeCodeAdapter];

export function adapterForRuntime(runtime: string): RuntimeAdapter | undefined {
  return builtinAdapters.find((a) => a.manifest.runtime === runtime);
}
