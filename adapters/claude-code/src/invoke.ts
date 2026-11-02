import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AdapterContext, InvokeRequest, InvokeResult } from "@agentoryhq/runtime-contract";

/**
 * Headless 执行 runner（agent-messaging 切片 2）。
 *
 * 红线（ADR-005）：
 * - 只以 runtime 默认权限模型执行——本文件不得出现任何权限放宽 flag
 *   （`--dangerously-skip-permissions` / `--permission-mode` 类，AC-12 grep 钉死）。
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
    const chunks: Buffer[] = [];
    let outputBytes = 0;
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

    const append = (buf: Buffer) => {
      const remaining = opts.maxOutputBytes - outputBytes;
      if (remaining <= 0) {
        if (buf.length > 0) truncated = true;
        return;
      }
      if (buf.length > remaining) {
        chunks.push(buf.subarray(0, remaining));
        outputBytes = opts.maxOutputBytes;
        truncated = true;
      } else {
        chunks.push(buf);
        outputBytes += buf.length;
      }
    };

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      const output = Buffer.concat(chunks).toString("utf8");
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
    child.stdout?.on("data", (buf: Buffer) => append(buf));
    child.stderr?.on("data", (buf: Buffer) => append(buf));
    child.on("close", (code, signal) => finish(code, signal));
  });
}

/**
 * Claude Code headless 单发执行（一期：单发单执行，不带上文）。
 *
 * `--session-id <uuid>`：自生成会话标识传给 runtime，从而确定性回填
 * runtimeSessionId（二期 thread resume 走 `--resume <id>`，契约已预留
 * resumeSessionId——一期调用方不得设置，此处忽略）。
 *
 * 二进制解析：`CLAUDE_CODE_BIN` env 覆盖（测试/非标准安装），默认 PATH 中 `claude`。
 */
export async function invokeClaudeCode(
  ctx: AdapterContext,
  req: InvokeRequest,
): Promise<InvokeResult> {
  const sessionId = randomUUID();
  const bin = process.env.CLAUDE_CODE_BIN?.trim() || "claude";
  const args = ["-p", req.prompt, "--session-id", sessionId];
  // req.resumeSessionId：二期预留，一期忽略（见 playbook 禁止清单「多轮接续二期」）。
  return runHeadless({
    command: bin,
    args,
    cwd: req.cwd || ctx.cwd,
    timeoutMs: req.timeoutMs,
    maxOutputBytes: req.maxOutputBytes,
    sessionId,
  });
}
