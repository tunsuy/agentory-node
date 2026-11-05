import type { RuntimeAdapter } from "@agentoryhq/runtime-contract";
import { ADAPTER_API_VERSION } from "@agentoryhq/runtime-contract";
import { applyAlignPatch } from "./align.js";
import { indexCursorSessions } from "./asset-index.js";
import { detectCursor, discoverCursorConfig } from "./discover.js";
import { invokeCursor, invokeCursorIde } from "./invoke.js";
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
export {
  bridgeHealth,
  bridgeRuntimeDir,
  discoverBridges,
  pickLiveBridge,
  submitViaBridge,
} from "./ide-bridge.js";
export type { BridgeEndpoint, BridgeSubmitOpts, BridgeSubmitResult } from "./ide-bridge.js";
export { invokeCursor, invokeCursorIde, isIdeBridgeEnabled, runHeadless } from "./invoke.js";
export {
  CURSOR_BRIDGE_EXTENSION_ID,
  MIN_CURSOR_VERSION,
  bundleHasOurPatch,
  detectCursorBridge,
  installCursorBridge,
  uninstallCursorBridge,
} from "./bridge-installer.js";
export type { BridgeInstallerDeps, CursorBridgeStatus, InstallResult } from "./bridge-installer.js";
export {
  DEFAULT_DESKTOP_BUNDLE,
  SUBMIT_SENTINEL,
  applyBundlePatch,
  isBundlePatched,
  locateAnchor,
  readBundle,
  revertBundlePatch,
  statusBundlePatch,
} from "./patch-bundle.js";
export type { BundlePatchResult } from "./patch-bundle.js";
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
      "invokeIde",
    ],
  },
  detect: detectCursor,
  discoverConfig: discoverCursorConfig,
  applyAlign: applyAlignPatch,
  indexSessions: indexCursorSessions,
  transcriptFileForSourceKey,
  captureTranscriptSnapshot,
  invoke: invokeCursor,
  invokeIde: invokeCursorIde,
};
