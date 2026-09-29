export const PKG_VERSION = "0.1.1";

export const DEFAULT_API_PORT = 8787;
export const DEFAULT_CONSOLE_PORT = 5173;

export type HealthBody = {
  ok: true;
  service: "api" | "console" | "node";
  version: string;
};

export type Role = "owner" | "member";

export type WorkspacePlan = "free" | "pro";

export type Workspace = {
  id: string;
  name: string;
  createdAt: string;
  /** Max memberships (Owner counts). Default from WORKSPACE_DEFAULT_SEAT_LIMIT. */
  seatLimit: number;
  /** free | pro — quotas only; no cashier. Default WORKSPACE_DEFAULT_PLAN. */
  plan: WorkspacePlan;
  /** Max active (non-revoked) nodes. */
  nodeLimit: number;
  /** Max lifetime successful align.confirm actions. */
  alignConfirmLimit: number;
};

export type SeatsInfo = {
  used: number;
  limit: number;
};

export type NodesQuotaInfo = {
  used: number;
  limit: number;
};

export type AlignQuotaInfo = {
  used: number;
  limit: number;
};

export type Membership = {
  workspaceId: string;
  email: string;
  role: Role;
};

export type DesiredCatalog = {
  workspaceId: string;
  mcp: { name: string; command?: string }[];
  skills: string[];
  updatedAt: string;
};

export type AlignDiffAction = "add" | "update" | "keep" | "keep_live";

export type AlignDiffItem = {
  kind: "mcp" | "skill";
  name: string;
  action: AlignDiffAction;
  /** live 与 desired 冲突；写入时以期望态为准 */
  conflict: boolean;
  liveCommand?: string;
  desiredCommand?: string;
  note?: string;
};

export type AlignPatch = {
  mcp: { name: string; command?: string }[];
  skills: string[];
};

export type AlignPlanStatus =
  | "pending_confirm"
  | "confirmed"
  | "applied"
  | "failed"
  | "cancelled";

export type AlignPlan = {
  id: string;
  workspaceId: string;
  agentId: string;
  nodeId: string;
  runtime: RuntimeKind;
  status: AlignPlanStatus;
  diff: AlignDiffItem[];
  patch: AlignPatch;
  createdAt: string;
  createdBy: string;
  confirmedAt?: string;
  confirmedBy?: string;
  appliedAt?: string;
  resultError?: string;
  snapshotPath?: string;
};

/** Supported first; others may be discovered but not aligned. */
export type RuntimeKind = "cursor" | "claude-code" | "unknown";

/** 目录条目状态：已支持纳管 / 规划中（仅展示，不进数据模型） */
export type CatalogStatus = "supported" | "planned";

/** Agent 页 runtime 目录条目（静态能力清单 SSOT；实例数由发现数据聚合，不在此） */
export type RuntimeCatalogEntry = {
  runtime: RuntimeKind | string;
  displayName: string;
  description: string;
  status: CatalogStatus;
};

/**
 * 常见 Agent runtime 目录。静态能力清单：0 实例也常驻展示（「未接入 · 0」），
 * 实例计数与实例列表一律来自真实发现数据（console 前端按 runtime 聚合）。
 * 顺序即展示顺序：已支持在前，规划中在后。
 */
export const RUNTIME_CATALOG: RuntimeCatalogEntry[] = [
  {
    runtime: "cursor",
    displayName: "Cursor",
    description: "IDE 内置 Agent",
    status: "supported",
  },
  {
    runtime: "claude-code",
    displayName: "Claude Code",
    description: "终端 Agent",
    status: "supported",
  },
  {
    runtime: "codex",
    displayName: "Codex",
    description: "OpenAI 终端 Agent",
    status: "planned",
  },
  {
    runtime: "gemini-cli",
    displayName: "Gemini CLI",
    description: "Google 终端 Agent",
    status: "planned",
  },
  {
    runtime: "opencode",
    displayName: "OpenCode",
    description: "开源终端 Agent",
    status: "planned",
  },
  {
    runtime: "lingma",
    displayName: "通义灵码",
    description: "阿里云 · IDE 插件 + CLI",
    status: "planned",
  },
  {
    runtime: "trae",
    displayName: "Trae",
    description: "字节跳动 · AI IDE",
    status: "planned",
  },
  {
    runtime: "codebuddy",
    displayName: "CodeBuddy",
    description: "腾讯 · IDE 插件 + CLI",
    status: "planned",
  },
  {
    runtime: "comate",
    displayName: "文心快码",
    description: "百度 · IDE 插件",
    status: "planned",
  },
];

export type McpHealthStatus = "healthy" | "degraded" | "failed" | "unknown";

export type LiveMcpBinding = {
  name: string;
  command?: string;
  status: McpHealthStatus;
  /** 失败 / 降级时必填可读原因 */
  reason?: string;
};

export type DiscoveredAgent = {
  runtime: RuntimeKind;
  /** false → 可展示，不进入对齐 */
  supported: boolean;
  displayName: string;
  mcp: LiveMcpBinding[];
  skills: string[];
};

export type AgentRecord = DiscoveredAgent & {
  id: string;
  workspaceId: string;
  nodeId: string;
  discoveredAt: string;
};

export type NodeRecord = {
  id: string;
  workspaceId: string;
  name: string;
  hostname: string;
  lastHeartbeatAt: string | null;
  createdAt: string;
  /** ISO timestamp when Owner revoked; null = active */
  revokedAt: string | null;
};

/** Read-only Cursor session metadata (no message body). */
export type SessionIndexReportItem = {
  sourceKey: string;
  displayName: string;
  projectPath?: string;
  updatedAt: string;
};

/** Read-only memory/rules metadata (no file body). */
export type MemoryIndexReportItem = {
  sourceKey: string;
  kind: "memory" | "rules";
  pathLabel: string;
  projectPath?: string;
  updatedAt: string;
};

export type SessionIndexEntry = SessionIndexReportItem & {
  id: string;
  workspaceId: string;
  nodeId: string;
  runtime: "cursor";
  discoveredAt: string;
};

/**
 * Transcript message frozen by a node for on-demand review (model B).
 * Desensitized + windowed on the NODE side before leaving the machine.
 * (S-tier: brief §5 AC-3/AC-4)
 */
export type TranscriptMessage = {
  role: "user" | "assistant";
  ts: string;
  text: string;
};

export type TranscriptSnapshot = {
  /** sourceKey of the session index entry this snapshot belongs to */
  sourceKey: string;
  messages: TranscriptMessage[];
  /** true when the message window was truncated (AC-4) */
  truncated: boolean;
  /** "27 of 67 messages" style hint when truncated */
  windowTotal?: string;
  /** captured (node-side) ISO timestamp */
  capturedAt: string;
};

export type MemoryIndexEntry = MemoryIndexReportItem & {
  id: string;
  workspaceId: string;
  nodeId: string;
  runtime: "cursor";
  discoveredAt: string;
};

export type AssetIndexFilter = {
  projectPath?: string;
  /** keyword; matches displayName/pathLabel or projectPath (case-insensitive) */
  q?: string;
  /** ISO timestamp; entries with updatedAt >= since */
  since?: string;
  /** memory index: restrict to kind (memory|rules); unset = all */
  kind?: "memory" | "rules";
};

/** Context item frozen into a handoff package (metadata only, no body). */
export type HandoffContextSession = {
  displayName: string;
  projectPath?: string;
  updatedAt: string;
};

export type HandoffContextMemory = {
  kind: "memory" | "rules";
  pathLabel: string;
  displayName?: string;
  projectPath?: string;
  updatedAt: string;
};

export type HandoffRecord = {
  id: string;
  workspaceId: string;
  fromAgentId: string;
  toAgentId: string;
  fromRuntime: string;
  toRuntime: string;
  note?: string;
  status: "created" | "acknowledged";
  depth: "package";
  context: { sessions: HandoffContextSession[]; memories: HandoffContextMemory[] };
  createdAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
};

export type AssetIndexPage = {
  /** page size; 1..500 */
  limit: number;
  /** zero-based row offset */
  offset: number;
};

export function controlPlaneBaseUrl(): string {
  const raw = process.env.CONTROL_PLANE_BASE_URL?.trim();
  if (raw) return raw.replace(/\/$/, "");
  return `http://127.0.0.1:${DEFAULT_API_PORT}`;
}

export function listenPort(envName: string, fallback: number): number {
  const n = Number(process.env[envName]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Bind address. Default loopback; set `LISTEN_HOST=0.0.0.0` for containers. */
export function listenHost(fallback = "127.0.0.1"): string {
  const raw = process.env.LISTEN_HOST?.trim();
  return raw || fallback;
}

export function jsonHealth(service: HealthBody["service"]): HealthBody {
  return { ok: true, service, version: PKG_VERSION };
}

export function maskSecret(token: string): string {
  if (token.length <= 8) return "••••";
  return `${token.slice(0, 4)}••••${token.slice(-2)}`;
}

const MCP_STATUS_ORDER: McpHealthStatus[] = ["failed", "degraded", "unknown", "healthy"];

export function worstMcpStatus(statuses: McpHealthStatus[]): McpHealthStatus {
  for (const s of MCP_STATUS_ORDER) {
    if (statuses.includes(s)) return s;
  }
  return "unknown";
}

export function isMcpHealthStatus(v: unknown): v is McpHealthStatus {
  return v === "healthy" || v === "degraded" || v === "failed" || v === "unknown";
}
