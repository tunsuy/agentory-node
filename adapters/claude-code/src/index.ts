import type { RuntimeAdapter } from "@agentory/runtime-contract";
import { ADAPTER_API_VERSION } from "@agentory/runtime-contract";
import { applyAlignPatch } from "./align.js";
import { detectClaudeCode, discoverClaudeCodeConfig } from "./discover.js";

export { applyAlignPatch } from "./align.js";
export { detectClaudeCode, discoverClaudeCodeConfig, mcpFromClaudeConfig } from "./discover.js";

export const claudeCodeAdapter: RuntimeAdapter = {
  manifest: {
    runtime: "claude-code",
    adapterApi: ADAPTER_API_VERSION,
    displayName: "Claude Code",
    capabilities: ["detect", "discoverConfig", "applyAlign"],
  },
  detect: detectClaudeCode,
  discoverConfig: discoverClaudeCodeConfig,
  applyAlign: applyAlignPatch,
};
