import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AdapterContext, InvokeRequest, InvokeResult } from "@agentoryhq/runtime-contract";

/**
 * Cursor Agent CLI headless 执行（agent-messaging 二期 · Cursor invoke）。
 *
 * - 新开：`agent -p --output-format json <prompt>` → 回填 JSON.session_id
 * - 续聊：`--resume <id>` 接续，回填同一 id
 *
 * 红线（ADR-005）：不注入 `--force` / `--yolo` / 任何权限放宽 flag。
 * 二进制：`CURSOR_AGENT_BIN` env 覆盖（测试），默认 PATH 中 `agent`。
 */

export type HeadlessRunOpts = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env?: NodeJS.ProcessEnv;
  /** 已知 session id（续聊或预生成）；成功时优先回填。 */
  sessionId?: string;
};

function parseCursorJsonOutput(raw: string): { text: string; sessionId?: string } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return { text: raw };
  try {
    const obj = JSON.parse(trimmed) as {
      result?: unknown;
      session_id?: unknown;
    };
    const text = typeof obj.result === "string" ? obj.result : raw;
    const sessionId =
      typeof obj.session_id === "string" && obj.session_id.trim()
        ? obj.session_id.trim()
        : undefined;
    return { text, sessionId };
  } catch {
    return { text: raw };
  }
}

export function runHeadless(opts: HeadlessRunOpts): Promise<InvokeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let spawned = false;
    let spawnError: Error | undefined;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        outcome: "failed",
        output: "",
        truncated: false,
        exitCode: null,
        durationMs: Date.now() - started,
        errorText: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const pushWithin = (
      chunks: Buffer[],
      used: number,
      buf: Buffer,
      markTruncated: boolean,
    ): number => {
      const remaining = opts.maxOutputBytes - used;
      if (remaining <= 0) {
        if (markTruncated && buf.length > 0) truncated = true;
        return used;
      }
      if (buf.length > remaining) {
        chunks.push(buf.subarray(0, remaining));
        if (markTruncated) truncated = true;
        return opts.maxOutputBytes;
      }
      chunks.push(buf);
      return used + buf.length;
    };

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const keepStderr =
        stderr.length > 0 &&
        (exitCode !== 0 || timedOut || spawnError !== undefined || stdout.trim() === "");
      const rawOut = keepStderr
        ? `${stdout}${stdout.length > 0 && !stdout.endsWith("\n") ? "\n" : ""}${stderr}`
        : stdout;
      const parsed = keepStderr ? { text: rawOut, sessionId: undefined } : parseCursorJsonOutput(rawOut);
      const base: InvokeResult = {
        output: parsed.text,
        truncated,
        durationMs,
        outcome: "failed",
        exitCode,
      };
      const sid = opts.sessionId || parsed.sessionId;
      if (spawned && sid) base.runtimeSessionId = sid;
      if (spawnError) {
        resolve({
          ...base,
          outcome: "failed",
          exitCode: null,
          errorText: spawnError.message,
        });
        return;
      }
      if (timedOut) {
        resolve({
          ...base,
          outcome: "timeout",
          errorText: `执行超时（超过 ${opts.timeoutMs}ms 上限）`,
        });
        return;
      }
      if (exitCode === 0) {
        resolve({ ...base, outcome: "done", exitCode: 0 });
        return;
      }
      resolve({
        ...base,
        outcome: "failed",
        errorText:
          exitCode === null
            ? `runtime 被信号终止（${signal ?? "unknown"}）`
            : `runtime 退出码 ${exitCode}`,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, opts.timeoutMs);

    child.on("spawn", () => {
      spawned = true;
    });
    child.on("error", (err) => {
      spawnError = err;
      finish(null, null);
    });
    child.stdout?.on("data", (buf: Buffer) => {
      stdoutBytes = pushWithin(stdoutChunks, stdoutBytes, buf, true);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      stderrBytes = pushWithin(stderrChunks, stderrBytes, buf, false);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

export async function invokeCursor(
  ctx: AdapterContext,
  req: InvokeRequest,
): Promise<InvokeResult> {
  const resume = typeof req.resumeSessionId === "string" ? req.resumeSessionId.trim() : "";
  const sessionId = resume || randomUUID();
  const bin = process.env.CURSOR_AGENT_BIN?.trim() || "agent";
  // -p = print/non-interactive；--output-format json 便于回填 session_id + 答案文本。
  // 续聊带 --resume；新开不传 --resume（CLI 自建会话，我们从 JSON 读回 session_id，
  // 并以预生成 UUID 作 fallback——若 CLI 忽略我们的 id，以 JSON 为准）。
  const args = resume
    ? ["-p", "--output-format", "json", "--resume", sessionId, req.prompt]
    : ["-p", "--output-format", "json", req.prompt];
  const result = await runHeadless({
    command: bin,
    args,
    cwd: req.cwd || ctx.cwd,
    timeoutMs: req.timeoutMs,
    maxOutputBytes: req.maxOutputBytes,
    sessionId: resume || undefined,
  });
  // 新开：若 JSON 未带回 session_id，用预生成 UUID 兜底（与 claude --session-id 同构可 resume）。
  if (result.outcome === "done" && !result.runtimeSessionId && !resume) {
    result.runtimeSessionId = sessionId;
  }
  if (result.outcome === "done" && resume) {
    result.runtimeSessionId = sessionId;
  }
  return result;
}
