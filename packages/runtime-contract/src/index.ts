import type {
  AlignPatch,
  DiscoveredAgent,
  MemoryIndexReportItem,
  SessionIndexReportItem,
  TranscriptSnapshot,
} from "@agentoryhq/shared";

/** Wire protocol version between Host and RuntimeAdapter implementations. */
export const ADAPTER_API_VERSION = 1 as const;

export type AdapterCapability =
  | "detect"
  | "discoverConfig"
  | "applyAlign"
  | "indexSessions"
  | "readTranscript"
  | "handoffExport";

export type AdapterManifest = {
  /** Matches control-plane / shared RuntimeKind when known. */
  runtime: string;
  adapterApi: typeof ADAPTER_API_VERSION;
  displayName: string;
  capabilities: readonly AdapterCapability[];
};

export type AdapterContext = {
  homeDir: string;
  cwd: string;
};

export type ApplyAlignOpts = {
  /** Project / install root for this runtime (Cursor: dir containing `.cursor/`). */
  projectRoot: string;
  patch: AlignPatch;
  confirmed: boolean;
};

export type ApplyAlignResult = {
  ok: boolean;
  error?: string;
  mcpPath: string;
  skillsPath: string;
  snapshotPath?: string;
};

export type AssetIndexResult = {
  sessions: SessionIndexReportItem[];
  memories: MemoryIndexReportItem[];
};

/**
 * Per-runtime adapter. Host orchestrates; adapters own paths and formats.
 * Optional methods must match declared `capabilities`.
 */
export type RuntimeAdapter = {
  manifest: AdapterManifest;
  detect(ctx: AdapterContext): boolean;
  discoverConfig?(ctx: AdapterContext): DiscoveredAgent | null;
  applyAlign?(opts: ApplyAlignOpts): ApplyAlignResult;
  indexSessions?(ctx: AdapterContext): AssetIndexResult;
  transcriptFileForSourceKey?(sourceKey: string, homeDir?: string): string | undefined;
  captureTranscriptSnapshot?(file: string, now?: Date): TranscriptSnapshot | undefined;
};

export function hasCapability(
  manifest: AdapterManifest,
  cap: AdapterCapability,
): boolean {
  return manifest.capabilities.includes(cap);
}
