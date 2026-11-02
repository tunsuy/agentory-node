import type { RuntimeAdapter } from "@agentoryhq/runtime-contract";
import { ADAPTER_API_VERSION } from "@agentoryhq/runtime-contract";
import { applyAlignPatch } from "./align.js";
import { detectClaudeCode, discoverClaudeCodeConfig } from "./discover.js";
import { invokeClaudeCode } from "./invoke.js";
import { indexClaudeSessions } from "./asset-index.js";
import { captureTranscriptSnapshot, transcriptFileForSourceKey } from "./transcript.js";

export { applyAlignPatch } from "./align.js";
export { detectClaudeCode, discoverClaudeCodeConfig, mcpFromClaudeConfig } from "./discover.js";
export { invokeClaudeCode, runHeadless } from "./invoke.js";
export {
  indexClaudeSessions,
  titleFromClaudeSessionJsonl,
  projectPathFromClaudeSessionJsonl,
} from "./asset-index.js";
export {
  TRANSCRIPT_MESSAGE_MAX_CHARS,
  TRANSCRIPT_WINDOW_MESSAGES,
  captureTranscriptSnapshot,
  maskSecrets,
  transcriptFileForSourceKey,
} from "./transcript.js";

export const claudeCodeAdapter: RuntimeAdapter = {
  manifest: {
    runtime: "claude-code",
    adapterApi: ADAPTER_API_VERSION,
    displayName: "Claude Code",
    capabilities: ["detect", "discoverConfig", "applyAlign", "indexSessions", "readTranscript", "invoke"],
  },
  detect: detectClaudeCode,
  discoverConfig: discoverClaudeCodeConfig,
  applyAlign: applyAlignPatch,
  indexSessions: indexClaudeSessions,
  transcriptFileForSourceKey,
  captureTranscriptSnapshot,
  invoke: invokeClaudeCode,
};
