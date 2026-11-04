import type { RuntimeAdapter } from "@agentoryhq/runtime-contract";
import { ADAPTER_API_VERSION } from "@agentoryhq/runtime-contract";
import { applyAlignPatch } from "./align.js";
import { detectClaudeCode, discoverClaudeCodeConfig } from "./discover.js";
import { installSkills } from "./install.js";
import { invokeClaudeCode } from "./invoke.js";
import { indexClaudeSessions } from "./asset-index.js";
import { captureTranscriptSnapshot, transcriptFileForSourceKey } from "./transcript.js";

export { applyAlignPatch } from "./align.js";
export { detectClaudeCode, discoverClaudeCodeConfig, mcpFromClaudeConfig } from "./discover.js";
export { installSkills, claudeSkillsRoot, SKILL_MARKER_FILE } from "./install.js";
export { readZip, ZipFormatError } from "./unzip.js";
export { invokeClaudeCode, runHeadless } from "./invoke.js";
export {
  indexClaudeSessions,
  titleFromClaudeSessionJsonl,
  projectPathFromClaudeSessionJsonl,
  findClaudeSessionJsonl,
  cwdForClaudeResume,
} from "./asset-index.js";
export {
  SUMMARY_READ_MAX_BYTES,
  firstBodyLine,
  parseMemoryFrontmatter,
  summarizeMemoryFile,
} from "./memory-summary.js";
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
    capabilities: ["detect", "discoverConfig", "applyAlign", "installSkills", "indexSessions", "readTranscript", "invoke"],
  },
  detect: detectClaudeCode,
  discoverConfig: discoverClaudeCodeConfig,
  applyAlign: applyAlignPatch,
  installSkills,
  indexSessions: indexClaudeSessions,
  transcriptFileForSourceKey,
  captureTranscriptSnapshot,
  invoke: invokeClaudeCode,
};
