import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AdapterContext, InvokeRequest, InvokeResult } from "@agentoryhq/runtime-contract";
import { cwdForCursorResume } from "./asset-index.js";
import { pickLiveBridge, submitViaBridge } from "./ide-bridge.js";

/**
 * Cursor Agent CLI headless 执行（agent-messaging 二期 · Cursor invoke）。
 *
 * - 新开：`agent -p --output-format json <prompt>` → 回填 JSON.session_id；cwd = 请求/daemon cwd
 * - 续聊：`--resume <id>`；cwd 优先取原会话项目目录
 *
 * 红线（ADR-005）：不注入 `--force` / `--yolo` / 任何权限放宽 flag。
 * 二进制：`CURSOR_AGENT_BIN` env 覆盖（测试），默认 PATH 中 `agent`。
 */

export type HeadlessRunOpts = {  command: string;
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

export function isIdeBridgeEnabled(): boolean {
  const v = process.env.AGENTORY_CURSOR_IDE_BRIDGE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
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

function ideBridgeFailure(message: string): InvokeResult {
  return {
    outcome: "failed",
    output: "",
    truncated: false,
    exitCode: null,
    durationMs: 0,
    errorText: message,
  };
}

export async function invokeCursorIde(
  ctx: AdapterContext,
  req: InvokeRequest,
): Promise<InvokeResult> {
  const portEnv = process.env.AGENTORY_CURSOR_BRIDGE_PORT?.trim();
  const port = portEnv ? Number(portEnv) : undefined;
  const bridge = await pickLiveBridge({
    ...(port && Number.isInteger(port) ? { port } : {}),
    homeDir: ctx.homeDir,
  });
  if (!bridge) return ideBridgeFailure("Cursor IDE bridge 未发现可用窗口（请确认已打补丁并重载窗口）");

  const resume = typeof req.resumeSessionId === "string" ? req.resumeSessionId.trim() : "";
  const submitted = await submitViaBridge(bridge.port, req.prompt, {
    ...(resume ? { composerId: resume } : {}),
    timeoutMs: req.timeoutMs,
  });
  if (!submitted.ok) return ideBridgeFailure(submitted.errorText ?? "Cursor IDE bridge 提交失败");

  let output = submitted.output ?? "";
  let truncated = false;
  if (Buffer.byteLength(output, "utf8") > req.maxOutputBytes) {
    output = Buffer.from(output, "utf8").subarray(0, req.maxOutputBytes).toString("utf8");
    truncated = true;
  }
  return {
    outcome: submitted.timedOut ? "timeout" : "done",
    output,
    truncated,
    exitCode: submitted.timedOut ? null : 0,
    durationMs: submitted.durationMs,
    ...(submitted.composerId
      ? { runtimeSessionId: submitted.composerId }
      : resume
        ? { runtimeSessionId: resume }
        : {}),
    ...(submitted.timedOut ? { errorText: "IDE 生成未在预算内结束（已回传当前文本）" } : {}),
  };
}

export async function invokeCursor(
  ctx: AdapterContext,
  req: InvokeRequest,
): Promise<InvokeResult> {
  const resume = typeof req.resumeSessionId === "string" ? req.resumeSessionId.trim() : "";

  /**
   * `invoke` 默认保持 Cursor Agent CLI 兼容路径；设置 AGENTORY_CURSOR_IDE_BRIDGE=1
   * 时才优先尝试真实 IDE 桥，桥不可用则回落 CLI。
   */  if (isIdeBridgeEnabled()) {
    const ide = await invokeCursorIde(ctx, req);
    if (ide.outcome === "done" || ide.outcome === "timeout") return ide;
    // 桥失败（未打补丁/未重载/端口无响应）→ 回落 CLI，可用性优先。
  }

  const sessionId = resume || randomUUID();
  const bin = process.env.CURSOR_AGENT_BIN?.trim() || "agent";
  const fallbackCwd = req.cwd || ctx.cwd;
  const cwd = resume
    ? cwdForCursorResume(ctx.homeDir, sessionId, fallbackCwd)
    : fallbackCwd;
  // -p = print/non-interactive；--output-format json 便于回填 session_id + 答案文本。
  // 续聊带 --resume；新开不传 --resume（CLI 自建会话，我们从 JSON 读回 session_id，
  // 并以预生成 UUID 作 fallback——若 CLI 忽略我们的 id，以 JSON 为准）。
  const args = resume
    ? ["-p", "--output-format", "json", "--resume", sessionId, req.prompt]
    : ["-p", "--output-format", "json", req.prompt];
  const result = await runHeadless({
    command: bin,
    args,
    cwd,
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
