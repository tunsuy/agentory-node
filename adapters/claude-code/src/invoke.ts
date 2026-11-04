import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AdapterContext, InvokeRequest, InvokeResult } from "@agentoryhq/runtime-contract";
import { cwdForClaudeResume } from "./asset-index.js";

/**
 * Headless 执行 runner（agent-messaging 切片 2）。
 *
 * 权限（ADR-005 修订 2026-11-04）：claude-code invoke 默认注入
 * `--dangerously-skip-permissions`（负责人直通——headless 无交互确认面，否则联网/写盘类工具不可用）。
 * Console 派活区须常驻风险提示。其余纪律不变：
 * - 纯本地 spawn，零入站端口、零反连。
 * - 超时 kill 整个进程组（detached + kill(-pid)），不留僵尸。
 * - 输出按 maxOutputBytes 截断（字节口径），truncated 标记。
 */

export type HeadlessRunOpts = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env?: NodeJS.ProcessEnv;
  /** 若进程成功 spawn，则以此值回填 InvokeResult.runtimeSessionId。 */
  sessionId?: string;
};

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

    /**
     * 两路输出各自按 maxOutputBytes 封顶。stdout 是任务答案通道；stderr 只在
     * 非成功（或 stdout 为空）时并入 output——Claude Code 把模型目录告警、
     * 进度等写在 stderr，成功时合流会把真答案挤出任务结果。
     */
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
      const output = keepStderr
        ? `${stdout}${stdout.length > 0 && !stdout.endsWith("\n") ? "\n" : ""}${stderr}`
        : stdout;
      const base = { output, truncated, durationMs };
      if (spawnError) {
        resolve({
          ...base,
          outcome: "failed",
          exitCode: null,
          errorText: spawnError.message,
        });
        return;
      }
      if (spawned && opts.sessionId) {
        (base as { runtimeSessionId?: string }).runtimeSessionId = opts.sessionId;
      }
      if (timedOut) {
        resolve({
          ...base,
          outcome: "timeout",
          exitCode,
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
        exitCode,
        errorText:
          exitCode === null
            ? `runtime 被信号终止（${signal ?? "unknown"}）`
            : `runtime 退出码 ${exitCode}`,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // 进程组终止：detached spawn 的负 pid = 整组（含 runtime 再派生的子进程）。
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
      // spawn 失败（如 ENOENT）：'close' 可能不再触发，这里直接收口。
      // 重复 resolve 无副作用（Promise 只认第一次）。
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

/**
 * Claude Code headless 执行。
 *
 * - 新开：`--session-id <uuid>` 自生成 → 回填 runtimeSessionId；cwd = 请求/daemon cwd
 * - 续聊：`req.resumeSessionId` 有值 → `--resume <id>`；cwd 优先取原会话 jsonl 内记录的目录
 *
 * 二进制解析：`CLAUDE_CODE_BIN` env 覆盖（测试/非标准安装），默认 PATH 中 `claude`。
 */
export async function invokeClaudeCode(
  ctx: AdapterContext,
  req: InvokeRequest,
): Promise<InvokeResult> {
  const resume = typeof req.resumeSessionId === "string" ? req.resumeSessionId.trim() : "";
  const sessionId = resume || randomUUID();
  const bin = process.env.CLAUDE_CODE_BIN?.trim() || "claude";
  const fallbackCwd = req.cwd || ctx.cwd;
  const cwd = resume
    ? cwdForClaudeResume(ctx.homeDir, sessionId, fallbackCwd)
    : fallbackCwd;
  // Headless 无 TTY 确认面：默认跳过权限提示，否则 WebSearch/写盘等工具会被拒。
  const args = resume
    ? ["-p", req.prompt, "--resume", sessionId, "--dangerously-skip-permissions"]
    : ["-p", req.prompt, "--session-id", sessionId, "--dangerously-skip-permissions"];
  return runHeadless({
    command: bin,
    args,
    cwd,
    timeoutMs: req.timeoutMs,
    maxOutputBytes: req.maxOutputBytes,
    sessionId,
  });
}
