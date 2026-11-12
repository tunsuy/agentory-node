export const PKG_VERSION = "0.1.16";

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

/** 期望态规则条目：name = 规则名（节点侧落 .cursor/rules/<name>.mdc 文件名语义），body = markdown 正文整段透传（rules-desired-config Q3 裁决：不解构 frontmatter）。 */
export type DesiredRule = { name: string; body: string };

/**
 * 期望态 Skill 条目（skillhub-integration）：旧数据是纯 string（= 目录名，无来源），
 * 新数据可为结构化条目。name 恒 = 节点侧 skills 目录名（skillhub 源 = slug，与
 * claude-code discovery「目录名」口径一致，装好即 diff 收敛 keep）。
 * source 留扩展位，一期只有 "skillhub" 一个实现（brief 非目标：不接其他源）。
 */
export type DesiredSkillSourceKind = "skillhub";

export type DesiredSkillEntry = {
  name: string;
  source?: DesiredSkillSourceKind;
  slug?: string;
  /** 选装时固定的版本（semver）；升级 = 用户显式改版本重装，不自动跟随 latest */
  version?: string;
  /** SkillHub 选装/回填的展示描述（纯展示面，不进节点对齐契约；存量条目由 Console 异步回填） */
  description?: string;
};

/** 读侧宽容类型：存量 `string[]` 与结构化条目并存（AC-8）。 */
export type DesiredSkill = string | DesiredSkillEntry;

export function desiredSkillName(s: DesiredSkill): string {
  return typeof s === "string" ? s : s.name;
}

/**
 * 读侧归一（AC-8 向后兼容单点）：string → {name}；对象条目做宽容清洗
 * （name 非空字符串才保留；source 只认 "skillhub"，其他值丢弃降级为无来源；
 * slug/version/description 非字符串丢弃）；按 name 去重（先到先得）。脏条目静默滤除，
 * 与 discovery parseDiscoveredAgents 同口径。
 */
export function normalizeDesiredSkills(raw: unknown): DesiredSkillEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: DesiredSkillEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    let entry: DesiredSkillEntry | undefined;
    if (typeof item === "string") {
      const name = item.trim();
      if (name) entry = { name };
    } else if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const o = item as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name.trim() : "";
      if (name) {
        entry = { name };
        if (o.source === "skillhub") {
          entry.source = "skillhub";
          if (typeof o.slug === "string" && o.slug.trim()) entry.slug = o.slug.trim();
          if (typeof o.version === "string" && o.version.trim()) entry.version = o.version.trim();
          if (typeof o.description === "string" && o.description.trim())
            entry.description = o.description.trim();
        }
      }
    }
    if (!entry || seen.has(entry.name)) continue;
    seen.add(entry.name);
    out.push(entry);
  }
  return out;
}

/**
 * 节点安装结果上报条目（skillhub-integration 拉模型安装通道）：
 * installed = zip 校验通过且落盘；failed = 任一环节失败（error 必填可读原因）。
 * integrity = sha256 校验失败（供应链信号：不自动重试，需用户显式改版本/重选装）。
 */
export type SkillInstallReport = {
  slug: string;
  version?: string;
  status: "installed" | "failed";
  error?: string;
  integrity?: boolean;
  installedAt?: string;
};

/** 安装状态存储行（skill_install_status 表 / memory Map 同构）：按 (workspace, node, slug) 唯一。 */
export type SkillInstallRow = SkillInstallReport & {
  workspaceId: string;
  nodeId: string;
  updatedAt: string;
};

/** 节点安装通道拉取条目：desired 中带 skillhub 来源、该节点尚未装成的技能。 */
export type PendingSkillInstall = { name: string; slug: string; version?: string };

/** 规则发现上报条目：只报名字与内容 hash，正文不上传（会话流索引只读口径不变）。hash 契约 = sha256(body UTF-8 字节) hex。 */
export type LiveRuleBinding = { name: string; contentHash?: string };

/**
 * 期望态 MCP 条目（mcp-registry-integration）：存量形状 {name, command?} 零破坏，
 * 新字段全部可选（additive，wire 兼容老节点——老节点忽略新字段照常按 command 对齐）。
 * source="mcp-registry" 时 slug = Registry 全名（命名空间/service，内部追溯用）；
 * env/headers 值 = `${ENV}` 占位符或显式非敏感明文（invariant #6：秘密本体只在节点侧
 * 环境变量，控制面存储/审计/响应/展示零密钥明文——写侧 validateDesiredMcp 单点校验）。
 */
export type DesiredMcpSourceKind = "mcp-registry";

export type DesiredMcpEntry = {
  name: string;
  command?: string;
  source?: DesiredMcpSourceKind;
  slug?: string;
  /** 选装时固定的版本；升级 = 显式重新选装（不自动跟随 latest） */
  version?: string;
  /** stdio 环境变量（.mcp.json env 原样落盘，Claude 原生 ${ENV} 展开） */
  env?: Record<string, string>;
  /** remote 鉴权头（.mcp.json headers 原样落盘，值仅占位符/非敏感明文） */
  headers?: Record<string, string>;
};

/** Registry 全名 → 服务自身名字（负责人裁决 2026-11-03：去命名空间前缀作主展示/desired name）。 */
export function registryServiceName(fullName: string): string {
  const i = fullName.indexOf("/");
  return i >= 0 ? fullName.slice(i + 1) : fullName;
}

export type DesiredCatalog = {
  workspaceId: string;
  /** 存量 {name, command?} 与新结构化条目同形（DesiredMcpEntry 全可选扩展，AC-9 零破坏） */
  mcp: DesiredMcpEntry[];
  /** 纯 string（存量，无来源）或结构化条目（skillhub-integration）；读侧走 normalizeDesiredSkills */
  skills: DesiredSkill[];
  rules: DesiredRule[];
  updatedAt: string;
};

export type AlignDiffAction = "add" | "update" | "keep" | "keep_live";

export type AlignDiffItem = {
  kind: "mcp" | "skill" | "rule";
  name: string;
  action: AlignDiffAction;
  /** live 与 desired 冲突；写入时以期望态为准 */
  conflict: boolean;
  liveCommand?: string;
  desiredCommand?: string;
  /** 规则维 hash 对照（kind="rule"）：live 上报的内容 hash / desired 正文 hash */
  liveHash?: string;
  desiredHash?: string;
  /** Skill 来源维（kind="skill" · skillhub-integration）：desired 条目的来源/版本透传，供 Console 徽标 */
  source?: DesiredSkillSourceKind;
  slug?: string;
  version?: string;
  note?: string;
};

export type AlignPatch = {
  /** mcp-registry-integration：条目可带 env/headers（additive；老节点忽略新字段零破坏） */
  mcp: DesiredMcpEntry[];
  skills: string[];
  /** 可选 = node↔api 版本偏差容忍：老节点收到无 rules 的 patch 按老形状执行 */
  rules?: DesiredRule[];
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
  /** 可选 = 老节点上报无 rules 字段零破坏；API 侧归一为 [] */
  rules?: LiveRuleBinding[];
  /**
   * 稳定实例标识：节点按 (runtime + 根目录) 派生，跨 discovery 轮次保持不变，
   * 供会话索引/消息等精确绑定到具体 Agent 实例（避免 runtime+nodeId 的宽松启发式）。
   */
  agentInstanceId?: string;
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
  /** 最近一次随心跳上报的 Cursor 桥状态；缺省 = 老节点未上报或非 macOS。 */
  cursorBridge?: CursorBridgeReport | null;
};

/** Cursor IDE 桥接状态（节点侧检测、随心跳上报；控制面只读展示，绝不回写节点）。 */
export type CursorBridgeReport = {
  /** Cursor 是否安装（false 时其余能力字段无意义）。 */
  installed: boolean;
  /** 检测到的 Cursor 版本（如 3.11.19）。 */
  cursorVersion?: string;
  /** 桥扩展是否已装入 Cursor。 */
  bridgeInstalled: boolean;
  /** workbench bundle 是否已打补丁。 */
  bundlePatched: boolean;
  /** 当前 Cursor 版本是否可安全打补丁（版本漂移 → false）。 */
  compatible: boolean;
  /** 打补丁/装扩展后是否需要重启 Cursor 才能生效。 */
  needsReload?: boolean;
  /** 不满足条件或异常的原因（节点侧脱敏，仅状态，无正文）。 */
  reasons?: string[];
  /** 节点侧检测时间（ISO）。 */
  checkedAt: string;
};


/** Read-only session metadata (no message body), any indexed runtime. */
export type SessionIndexReportItem = {
  sourceKey: string;
  displayName: string;
  projectPath?: string;
  updatedAt: string;
  /** runtime the item was discovered by; absent = legacy node payload → API defaults "cursor" */
  runtime?: RuntimeKind;
  /** 产出该会话的 Agent 实例稳定 id（节点上报）；absent = 老节点 → 前端回退 runtime+node 启发式 */
  agentInstanceId?: string;
};

/** memory-asset-cards: 节点侧摘要字段长度上限（常量同源——节点截断 + API ingest 拒绝超限，AC-3 双侧硬上限）。 */
export const MEMORY_TITLE_MAX = 80;
export const MEMORY_DESC_MAX = 200;
/** contentHash 形态：文件内容 sha256 前 16 hex（节点侧计算；hash 出机 ≠ 内容出机）。 */
export const MEMORY_HASH_RE = /^[0-9a-f]{16}$/;

/** Read-only memory/rules metadata (no file body), any indexed runtime.
 *  memory-asset-cards additive：title/description/memType/contentHash 为节点侧
 *  摘要提取产物（frontmatter 优先 + 首行回退，节点侧脱敏 + 截断后才出机；
 *  全文永不出机）。老节点不带新字段，wire 零破坏（AC-4）。 */
export type MemoryIndexReportItem = {
  sourceKey: string;
  kind: "memory" | "rules";
  pathLabel: string;
  projectPath?: string;
  updatedAt: string;
  /** runtime the item was discovered by; absent = legacy node payload → API defaults "cursor" */
  runtime?: RuntimeKind;
  /** 卡片标题（frontmatter name → 文件名回退；≤ MEMORY_TITLE_MAX，节点侧已脱敏） */
  title?: string;
  /** 一句话摘要（frontmatter description → 正文首个非标题行回退；≤ MEMORY_DESC_MAX，节点侧已脱敏截断） */
  description?: string;
  /** frontmatter metadata.type 原值（词表 user|feedback|project|reference；词表外原样上报，UI 归「未分类」——开放问题 6 裁决） */
  memType?: string;
  /** 文件内容 sha256 前 16 hex（跨节点/跨 runtime 精确归组键——开放问题 2 裁决：hash 优先，缺失回退归一化 title） */
  contentHash?: string;
};

export type SessionIndexEntry = SessionIndexReportItem & {
  id: string;
  workspaceId: string;
  nodeId: string;
  /** runtime dimension since claude-session-index; widened from "cursor" literal */
  runtime: RuntimeKind;
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
  /** runtime dimension since claude-session-index; widened from "cursor" literal */
  runtime: RuntimeKind;
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
