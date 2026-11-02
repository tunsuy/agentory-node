import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { invokeClaudeCode, runHeadless } from "./invoke.js";

const baseOpts = { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 };

test("runHeadless: done captures stdout+stderr and exit code 0", async () => {
  const res = await runHeadless({
    command: "/bin/sh",
    args: ["-c", "echo out-line; echo err-line >&2"],
    cwd: os.tmpdir(),
    ...baseOpts,
  });
  assert.equal(res.outcome, "done");
  assert.equal(res.exitCode, 0);
  assert.match(res.output, /out-line/);
  assert.match(res.output, /err-line/);
  assert.equal(res.truncated, false);
  assert.ok(res.durationMs >= 0);
});

test("runHeadless: non-zero exit → failed with 退出码 errorText", async () => {
  const res = await runHeadless({
    command: "/bin/sh",
    args: ["-c", "echo partial; exit 3"],
    cwd: os.tmpdir(),
    ...baseOpts,
  });
  assert.equal(res.outcome, "failed");
  assert.equal(res.exitCode, 3);
  assert.match(res.output, /partial/);
  assert.match(res.errorText ?? "", /退出码 3/);
});

test("runHeadless: timeout kills the process group and keeps partial output (AC-7)", async () => {
  const started = Date.now();
  const res = await runHeadless({
    // 子进程再派生孙进程——进程组 kill 必须一起收走。
    // 时长用唯一标记 61.7（机器上有无关 watchdog 循环 sleep 60，全局断言会误伤）。
    command: "/bin/sh",
    args: ["-c", "echo before-hang; sleep 61.7 & sleep 61.7"],
    cwd: os.tmpdir(),
    timeoutMs: 400,
    maxOutputBytes: 64 * 1024,
  });
  assert.equal(res.outcome, "timeout");
  assert.match(res.output, /before-hang/);
  assert.match(res.errorText ?? "", /执行超时/);
  assert.ok(Date.now() - started < 10_000, "超时后应立即收口，不等 sleep");
  // 进程组确实被收走（负 pid kill 不残留）。模式 61[.]7 防 pgrep 包装 sh 自匹配。
  await new Promise((r) => setTimeout(r, 200));
  const pgrep = await runHeadless({
    command: "/bin/sh",
    args: ["-c", "pgrep -f 'sleep 61[.]7' | head -1 || true"],
    cwd: os.tmpdir(),
    ...baseOpts,
  });
  assert.equal(pgrep.output.trim(), "", "timeout 后不应残留本测试的 sleep 进程");
});

test("runHeadless: output beyond maxOutputBytes is truncated with flag", async () => {
  const res = await runHeadless({
    command: "/bin/sh",
    args: ["-c", "printf 'x%.0s' $(seq 1 5000)"],
    cwd: os.tmpdir(),
    timeoutMs: 10_000,
    maxOutputBytes: 100,
  });
  assert.equal(res.outcome, "done");
  assert.equal(res.truncated, true);
  assert.equal(Buffer.byteLength(res.output, "utf8"), 100);
});

test("runHeadless: spawn failure (ENOENT) → failed, exitCode null", async () => {
  const res = await runHeadless({
    command: "/definitely/not/a/binary",
    args: [],
    cwd: os.tmpdir(),
    ...baseOpts,
  });
  assert.equal(res.outcome, "failed");
  assert.equal(res.exitCode, null);
  assert.ok(res.errorText);
  assert.equal(res.runtimeSessionId, undefined, "未 spawn 成功不得回填会话标识");
});

test("invokeClaudeCode: headless args + runtimeSessionId 回填 + 零权限放宽 flag (AC-12)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-claude-i-"));
  const argsFile = path.join(root, "args.txt");
  const fakeBin = path.join(root, "fake-claude.sh");
  fs.writeFileSync(
    fakeBin,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`,
      "echo fake-result-text",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  const prev = process.env.CLAUDE_CODE_BIN;
  process.env.CLAUDE_CODE_BIN = fakeBin;
  try {
    const res = await invokeClaudeCode(
      { homeDir: root, cwd: root },
      { prompt: "总结最近一周构建失败原因", timeoutMs: 10_000, maxOutputBytes: 4096, cwd: root },
    );
    assert.equal(res.outcome, "done");
    assert.match(res.output, /fake-result-text/);
    assert.ok(res.runtimeSessionId, "spawn 成功应回填 runtimeSessionId");
    assert.match(
      res.runtimeSessionId ?? "",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      "runtimeSessionId 应为 UUID（二期 --resume 可用）",
    );
    const sentArgs = fs.readFileSync(argsFile, "utf8").split("\n").filter(Boolean);
    assert.deepEqual(sentArgs, [
      "-p",
      "总结最近一周构建失败原因",
      "--session-id",
      res.runtimeSessionId ?? "",
    ]);
    // AC-12 红线：参数面零权限放宽 flag
    for (const arg of sentArgs) {
      assert.ok(
        !/dangerously|skip-permissions|permission-mode|yolo|bypass/i.test(arg),
        `不得注入权限放宽 flag: ${arg}`,
      );
    }
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = prev;
  }
});

test("invokeClaudeCode: resumeSessionId 一期忽略（不产生 --resume 类参数）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-claude-r-"));
  const argsFile = path.join(root, "args.txt");
  const fakeBin = path.join(root, "fake-claude.sh");
  fs.writeFileSync(
    fakeBin,
    ["#!/bin/sh", `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`, "exit 0"].join("\n"),
    { mode: 0o755 },
  );
  const prev = process.env.CLAUDE_CODE_BIN;
  process.env.CLAUDE_CODE_BIN = fakeBin;
  try {
    await invokeClaudeCode(
      { homeDir: root, cwd: root },
      {
        prompt: "hi",
        timeoutMs: 10_000,
        maxOutputBytes: 4096,
        cwd: root,
        resumeSessionId: "should-be-ignored",
      },
    );
    const sentArgs = fs.readFileSync(argsFile, "utf8");
    assert.ok(!sentArgs.includes("should-be-ignored"));
    assert.ok(!sentArgs.includes("--resume"));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = prev;
  }
});
