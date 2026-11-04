import type { RuntimeAdapter } from "@agentoryhq/runtime-contract";
import { ADAPTER_API_VERSION } from "@agentoryhq/runtime-contract";
import { applyAlignPatch } from "./align.js";
import { indexCursorSessions } from "./asset-index.js";
import { detectCursor, discoverCursorConfig } from "./discover.js";
import { invokeCursor } from "./invoke.js";
import { captureTranscriptSnapshot, transcriptFileForSourceKey } from "./transcript.js";

export { applyAlignPatch } from "./align.js";
export {
  buildCursorProjectPathMap,
  cwdForCursorResume,
  indexCursorSessions,
  titleFromTranscriptJsonl,
  titleFromUserText,
} from "./asset-index.js";
export {
  SUMMARY_READ_MAX_BYTES,
  firstBodyLine,
  parseMemoryFrontmatter,
  summarizeMemoryFile,
} from "./memory-summary.js";
export { detectCursor, discoverCursorConfig } from "./discover.js";
export { invokeCursor, runHeadless } from "./invoke.js";
export {
  TRANSCRIPT_MESSAGE_MAX_CHARS,
  TRANSCRIPT_WINDOW_MESSAGES,
  captureTranscriptSnapshot,
  maskSecrets,
  transcriptFileForSourceKey,
} from "./transcript.js";

export const cursorAdapter: RuntimeAdapter = {
  manifest: {
    runtime: "cursor",
    adapterApi: ADAPTER_API_VERSION,
    displayName: "Cursor",
    capabilities: [
      "detect",
      "discoverConfig",
      "applyAlign",
      "indexSessions",
      "readTranscript",
      "invoke",
    ],
  },
  detect: detectCursor,
  discoverConfig: discoverCursorConfig,
  applyAlign: applyAlignPatch,
  indexSessions: indexCursorSessions,
  transcriptFileForSourceKey,
  captureTranscriptSnapshot,
  invoke: invokeCursor,
};
