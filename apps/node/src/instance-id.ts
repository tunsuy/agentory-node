import { createHash } from "node:crypto";

/**
 * 稳定 Agent 实例 id：按 (runtime, root) 派生，跨 discovery 轮次保持不变。
 * - runtime: 适配器运行时（cursor / claude-code / unknown）
 * - root: 该 Agent 实例的根目录（daemon cwd），同一实例每轮相同
 * 节点在 discovery 与 asset-index 两处都用同一派生，保证 Agent 记录与会话索引的 id 对齐。
 */
export function agentInstanceIdFor(runtime: string, root: string): string {
  return `ain_${createHash("sha256").update(`${runtime}\0${root}`).digest("hex").slice(0, 16)}`;
}
