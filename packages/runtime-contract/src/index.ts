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
  | "handoffExport"
  | "invoke";

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
  /** 规则写盘目录(rules-desired-config,cursor-only;未写规则时缺省) */
  rulesDir?: string;
  /** 被覆盖规则文件的快照目录(rules-<ts>/;无覆盖时缺省) */
  rulesSnapshotDir?: string;
};

export type AssetIndexResult = {
  sessions: SessionIndexReportItem[];
  memories: MemoryIndexReportItem[];
};

/** Outcome of one headless execution requested via `invoke`. */
export type InvokeOutcome = "done" | "failed" | "timeout";

export type InvokeRequest = {
  /** Task text sent to the runtime (单发单执行；一期不带上文). */
  prompt: string;
  /** Wall-clock execution budget; adapter MUST kill the process (group) on expiry. */
  timeoutMs: number;
  /** Cap on captured output; adapter truncates and sets `truncated`. */
  maxOutputBytes: number;
  /** Project directory the runtime executes in (Agent 实例根). */
  cwd: string;
  /** 二期预留（thread resume）；一期调用方不得设置。 */
  resumeSessionId?: string;
};

export type InvokeResult = {
  outcome: InvokeOutcome;
  /** Captured stdout+stderr, possibly truncated. Never contains secrets in plaintext. */
  output: string;
  truncated: boolean;
  /** Process exit code; null when killed by signal (timeout) or not spawned. */
  exitCode: number | null;
  durationMs: number;
  /** Runtime's own session id when obtainable; reserved for 二期 resume. */
  runtimeSessionId?: string;
  /** Short failure summary for `failed` / `timeout`. */
  errorText?: string;
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
  /**
   * Execute one headless task (agent-messaging). Async on purpose: executions
   * may run up to `timeoutMs` (~minutes) and MUST NOT block the daemon event
   * loop — heartbeats keep flowing while a task runs.
   * Red line (ADR-005): run with the runtime's DEFAULT permission model;
   * never inject permission-relaxing flags (`--dangerously-skip-permissions` 类).
   */
  invoke?(ctx: AdapterContext, req: InvokeRequest): Promise<InvokeResult>;
};

export function hasCapability(
  manifest: AdapterManifest,
  cap: AdapterCapability,
): boolean {
  return manifest.capabilities.includes(cap);
}
