/**
 * Host re-exports Cursor transcript capture (adapter owns paths / masking).
 */
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
