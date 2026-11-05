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
  | "installSkills"
  | "indexSessions"
  | "readTranscript"
  | "handoffExport"
  | "invoke"
  /** 方案 A：接真实 IDE 会话（renderer 补丁 + 本地桥），后台提交并回传正文。 */
  | "invokeIde";

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

/**
 * Skill 本体安装（skillhub-integration · 一期只有 claude-code 实现）：
 * Host 负责传输（鉴权/下载/清单获取都在 Host 手里），adapter 只消费字节并
 * 拥有落盘布局与完整性校验——zip 逐文件 sha256 对照清单，不符则整体不落盘。
 */
export type SkillFileManifestEntry = {
  /** zip 内相对路径（SKILL.md、references/xx.md …） */
  path: string;
  size?: number;
  sha256?: string;
};

export type SkillInstallItem = {
  slug: string;
  version: string;
  /** zip 字节（Host 已下载）；adapter 不落盘未经校验的内容 */
  zip: Uint8Array;
  /** 文件清单（Host 已从来源 files API 取得）；带 sha256 的条目逐一校验 */
  files: SkillFileManifestEntry[];
};

export type SkillInstallOutcome = {
  slug: string;
  version: string;
  /** installed = 校验通过且落盘；skipped = 同版本已装（幂等）；failed = 任一环节失败 */
  status: "installed" | "skipped" | "failed";
  error?: string;
  /** sha256 校验失败（供应链信号）：控制面不自动重试，需用户显式改版本/重选装 */
  integrity?: boolean;
  /** 落盘目录（installed/skipped 时给出） */
  dir?: string;
};

export type InstallSkillsOpts = {
  items: SkillInstallItem[];
};

/** Outcome of one headless execution requested via `invoke`. */
export type InvokeOutcome = "done" | "failed" | "timeout";

export type InvokeRequest = {
  /** Task text sent to the runtime（新开或续聊均单次 prompt；续聊靠 resumeSessionId）. */
  prompt: string;
  /** Wall-clock execution budget; adapter MUST kill the process (group) on expiry. */
  timeoutMs: number;
  /** Cap on captured output; adapter truncates and sets `truncated`. */
  maxOutputBytes: number;
  /**
   * Project directory the runtime executes in.
   * 新开：通常 = daemon process.cwd()。
   * 续聊：adapter 应优先解析原会话记录的工作目录，找不到再回落本字段。
   */
  cwd: string;
  /**
   * 续聊：接上一次 invoke 回填的 runtimeSessionId（claude-code → `--resume <id>`）。
   * 缺省 = 新开会话（`--session-id` 自生成）。
   */
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
  /** Runtime's own session id when obtainable（新开或续聊后的同一会话 id）。 */
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
  /**
   * 安装 skill 本体到该 runtime 的技能目录（skillhub-integration）。
   * 逐 item 独立成败（AC-6：一个失败不影响其他）；实现 MUST NOT throw——
   * 失败收敛为该 item 的 failed outcome。
   */
  installSkills?(ctx: AdapterContext, opts: InstallSkillsOpts): Promise<SkillInstallOutcome[]>;
  indexSessions?(ctx: AdapterContext): AssetIndexResult;
  transcriptFileForSourceKey?(sourceKey: string, homeDir?: string): string | undefined;
  captureTranscriptSnapshot?(file: string, now?: Date): TranscriptSnapshot | undefined;
  /**
   * Execute one headless task (agent-messaging). Async on purpose: executions
   * may run up to `timeoutMs` (~minutes) and MUST NOT block the daemon event
   * loop — heartbeats keep flowing while a task runs.
   * Permission (ADR-005 rev 2026-11-04): claude-code injects
   * `--dangerously-skip-permissions` by default (headless has no TTY confirm).
   * Other runtimes keep their own default unless an adapter ADR says otherwise.
   * Console must surface a standing risk hint on the composer.
   */
  invoke?(ctx: AdapterContext, req: InvokeRequest): Promise<InvokeResult>;
  /**
   * 方案 A：接「真实 IDE 会话」（renderer 补丁 + 本地桥）。与 `invoke` 语义同构
   * （prompt → 执行 → 结果），但执行发生在 IDE 进程内、UI 跟着走，正文经补丁
   * 后台轮询生成完成后回传。不可用时诚实返回 failed（由调用方决定是否回落）。
   */
  invokeIde?(ctx: AdapterContext, req: InvokeRequest): Promise<InvokeResult>;
};

export function hasCapability(
  manifest: AdapterManifest,
  cap: AdapterCapability,
): boolean {
  return manifest.capabilities.includes(cap);
}
