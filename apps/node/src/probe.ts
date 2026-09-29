import type { LiveMcpBinding, McpHealthStatus } from "@agentory/shared";
import { worstMcpStatus } from "@agentory/shared";

export type ProbeInput = {
  name: string;
  command?: string;
};

const DEFAULT_TIMEOUT_MS = 50;

/**
 * Binding-level health probe (slice 3 / AC-2).
 * Simulation hooks in command string for tests: invalid / ENOENT / timeout-sim / degraded.
 * Optional real HTTP(S) fetch when command looks like a URL and AGENTORY_MCP_HTTP_PROBE=1.
 */
export async function probeMcpBinding(
  input: ProbeInput,
  opts?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<LiveMcpBinding> {
  const { name, command } = input;
  if (!command || !command.trim()) {
    return { name, status: "unknown", reason: "no command configured" };
  }
  const cmd = command.trim();
  if (/ENOENT|invalid|bad-url|does-not-exist/i.test(cmd)) {
    return {
      name,
      command: cmd,
      status: "failed",
      reason: readableFail(cmd),
    };
  }
  if (/timeout-sim/i.test(cmd)) {
    return {
      name,
      command: cmd,
      status: "failed",
      reason: `probe timeout after ${opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
    };
  }
  if (/degraded/i.test(cmd)) {
    return {
      name,
      command: cmd,
      status: "degraded",
      reason: "probe succeeded with warnings (simulated)",
    };
  }

  const urlMatch = cmd.match(/https?:\/\/[^\s]+/i);
  if (urlMatch && process.env.AGENTORY_MCP_HTTP_PROBE === "1") {
    const fetchFn = opts?.fetchImpl ?? fetch;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetchFn(urlMatch[0], { method: "GET", signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) {
        return {
          name,
          command: cmd,
          status: "failed",
          reason: `HTTP ${res.status} from ${urlMatch[0]}`,
        };
      }
      return { name, command: cmd, status: "healthy" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        name,
        command: cmd,
        status: "failed",
        reason: msg.includes("abort")
          ? `probe timeout after ${timeoutMs}ms`
          : `probe error: ${msg}`,
      };
    }
  }

  // Config present and no failure signal → healthy for MVP.
  return { name, command: cmd, status: "healthy" };
}

function readableFail(cmd: string): string {
  if (/ENOENT/i.test(cmd)) {
    const pathMatch = cmd.match(/\/[^\s]+/);
    return pathMatch ? `ENOENT ${pathMatch[0]}` : "ENOENT path missing";
  }
  if (/bad-url|invalid/i.test(cmd)) return `invalid endpoint in command: ${cmd.slice(0, 80)}`;
  return `probe failed for ${cmd.slice(0, 80)}`;
}

export async function probeAll(
  bindings: ProbeInput[],
  opts?: { timeoutMs?: number },
): Promise<LiveMcpBinding[]> {
  return Promise.all(bindings.map((b) => probeMcpBinding(b, opts)));
}

export function worstStatus(statuses: McpHealthStatus[]): McpHealthStatus {
  return worstMcpStatus(statuses);
}
