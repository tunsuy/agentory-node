import os from "node:os";
import type { TranscriptSnapshot } from "@agentoryhq/shared";
import { builtinAdapters } from "./registry.js";

/**
 * Transcript routing (claude-session-index §3-4): resolve each pending
 * sourceKey across builtin adapters — the adapter whose
 * `transcriptFileForSourceKey` recognizes the key owns it, and its own
 * `captureTranscriptSnapshot` captures it (cursor keys stay on the cursor
 * adapter, claude-session: keys route to claude-code). Unknown prefixes
 * resolve to undefined = miss, same semantics as before. Same iteration
 * shape as discoverAssetIndex.
 */
export function captureTranscriptForSourceKey(
  sourceKey: string,
  homeDir?: string,
): TranscriptSnapshot | undefined {
  const home = homeDir ?? os.homedir();
  for (const adapter of builtinAdapters) {
    if (!adapter.transcriptFileForSourceKey || !adapter.captureTranscriptSnapshot) continue;
    const file = adapter.transcriptFileForSourceKey(sourceKey, home);
    if (file === undefined) continue;
    return adapter.captureTranscriptSnapshot(file);
  }
  return undefined;
}

export {
  TRANSCRIPT_MESSAGE_MAX_CHARS,
  TRANSCRIPT_WINDOW_MESSAGES,
  captureTranscriptSnapshot,
  maskSecrets,
  transcriptFileForSourceKey,
} from "@agentoryhq/adapter-cursor";

export type TranscriptFetchOpts = {
  homeDir?: string;
};
