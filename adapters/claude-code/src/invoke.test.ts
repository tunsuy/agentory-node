import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { invokeClaudeCode, runHeadless } from "./invoke.js";

const baseOpts = { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 };

test("runHeadless: done 只把 stdout 当结果，stderr 不并入 output", async () => {
  const res = await runHeadless({
    command: "/bin/sh",
    args: ["-c", "echo out-line; echo err-line >&2"],
    cwd: os.tmpdir(),
    ...baseOpts,
  });
  assert.equal(res.outcome, "done");
  assert.equal(res.exitCode, 0);
  assert.match(res.output, /out-line/);
  assert.doesNotMatch(res.output, /err-line/, "成功时 stderr（告警/进度）不得混入任务输出");
  assert.equal(res.truncated, false);
  assert.ok(res.durationMs >= 0);
});

test("runHeadless: done 且 stdout 为空时回退 stderr（不吞 runtime 输出）", async () => {
  const res = await runHeadless({
    command: "/bin/sh",
    args: ["-c", "echo only-stderr >&2"],
    cwd: os.tmpdir(),
    ...baseOpts,
  });
  assert.equal(res.outcome, "done");
  assert.match(res.output, /only-stderr/);
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

test("runHeadless: 失败时保留 stderr 供诊断", async () => {
  const res = await runHeadless({
    command: "/bin/sh",
    args: ["-c", "echo partial; echo boom >&2; exit 7"],
    cwd: os.tmpdir(),
    ...baseOpts,
  });
  assert.equal(res.outcome, "failed");
  assert.match(res.output, /partial/);
  assert.match(res.output, /boom/, "失败时 stderr 是诊断主力，必须保留");
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

test("invokeClaudeCode: headless args + runtimeSessionId 回填 + skip-permissions (ADR-005 修订)", async () => {
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
      "runtimeSessionId 应为 UUID（可供后续 --resume）",
    );
    const sentArgs = fs.readFileSync(argsFile, "utf8").split("\n").filter(Boolean);
    assert.deepEqual(sentArgs, [
      "-p",
      "总结最近一周构建失败原因",
      "--session-id",
      res.runtimeSessionId ?? "",
      "--dangerously-skip-permissions",
    ]);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = prev;
  }
});

test("invokeClaudeCode: resumeSessionId → --resume 接续 + 回填同一 session id + 原会话 cwd", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-claude-r-"));
  const proj = path.join(root, "old-proj");
  fs.mkdirSync(proj);
  const resumeId = "11111111-2222-3333-4444-555555555555";
  const slugDir = path.join(root, ".claude", "projects", "old");
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(
    path.join(slugDir, `${resumeId}.jsonl`),
    `${JSON.stringify({ type: "system", cwd: proj })}\n`,
  );
  const argsFile = path.join(root, "args.txt");
  const cwdFile = path.join(root, "cwd.txt");
  const fakeBin = path.join(root, "fake-claude.sh");
  fs.writeFileSync(
    fakeBin,
    [
      "#!/bin/sh",
      `pwd > ${JSON.stringify(cwdFile)}`,
      `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  const prev = process.env.CLAUDE_CODE_BIN;
  process.env.CLAUDE_CODE_BIN = fakeBin;
  try {
    const res = await invokeClaudeCode(
      { homeDir: root, cwd: root },
      {
        prompt: "继续上次话题",
        timeoutMs: 10_000,
        maxOutputBytes: 4096,
        cwd: root, // daemon cwd；续聊应改用会话 cwd
        resumeSessionId: resumeId,
      },
    );
    assert.equal(res.outcome, "done");
    assert.equal(res.runtimeSessionId, resumeId);
    const sentArgs = fs.readFileSync(argsFile, "utf8").split("\n").filter(Boolean);
    assert.deepEqual(sentArgs, [
      "-p",
      "继续上次话题",
      "--resume",
      resumeId,
      "--dangerously-skip-permissions",
    ]);
    assert.ok(!sentArgs.includes("--session-id"), "续聊不得再开 --session-id");
    assert.equal(
      fs.realpathSync(fs.readFileSync(cwdFile, "utf8").trim()),
      fs.realpathSync(proj),
      "续聊 spawn cwd = 原会话目录",
    );
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = prev;
  }
});
