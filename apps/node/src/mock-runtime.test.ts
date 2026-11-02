import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runHeadless } from "@agentoryhq/adapter-claude-code";

/**
 * Mock 执行 runtime（scripts/mock-claude.mjs）确定性回放断言。
 * 走 runHeadless 真 spawn 路径 = smoke 全链的同一机制（超时/截断/退出码全真）。
 */
const MOCK_BIN = fileURLToPath(new URL("../../../scripts/mock-claude.mjs", import.meta.url));

function run(prompt: string, overrides: Partial<Parameters<typeof runHeadless>[0]> = {}) {
  return runHeadless({
    command: process.execPath,
    args: [MOCK_BIN, "-p", prompt, "--session-id", "11111111-2222-3333-4444-555555555555"],
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    ...overrides,
  });
}

test("mock: 默认回放 mock ok: <prompt>", async () => {
  const res = await run("总结最近一周构建失败原因");
  assert.equal(res.outcome, "done");
  assert.equal(res.exitCode, 0);
  assert.match(res.output, /mock ok: 总结最近一周构建失败原因/);
});

test("mock: mock:text 指令覆盖输出", async () => {
  const res = await run("mock:text=P95-分析完成");
  assert.equal(res.outcome, "done");
  assert.match(res.output, /P95-分析完成/);
});

test("mock: outcome=failed + exit=7 → failed 退出码 7", async () => {
  const res = await run("mock:outcome=failed mock:exit=7");
  assert.equal(res.outcome, "failed");
  assert.equal(res.exitCode, 7);
  assert.match(res.errorText ?? "", /退出码 7/);
});

test("mock: bytes=5000 撑爆 maxOutputBytes=50 → 真截断", async () => {
  const res = await run("mock:bytes=5000", { maxOutputBytes: 50 });
  assert.equal(res.outcome, "done");
  assert.equal(res.truncated, true);
  assert.equal(Buffer.byteLength(res.output, "utf8"), 50);
});

test("mock: delay=300 → durationMs ≥ 250（可注入延迟）", async () => {
  const res = await run("mock:delay=300");
  assert.equal(res.outcome, "done");
  assert.ok(res.durationMs >= 250, `durationMs=${res.durationMs}`);
});

test("mock: hang=1 → runner 真超时 kill + 部分输出回流（AC-7 全真路径）", async () => {
  const started = Date.now();
  const res = await run("mock:hang=1", { timeoutMs: 600 });
  assert.equal(res.outcome, "timeout");
  assert.match(res.output, /mock partial before hang/);
  assert.match(res.errorText ?? "", /执行超时/);
  assert.ok(Date.now() - started < 8_000, "超时即收口");
});

test("mock: 确定性——同输入两次结果一致（CI 可跑判据）", async () => {
  const a = await run("mock:text=det");
  const b = await run("mock:text=det");
  assert.equal(a.output, b.output);
  assert.equal(a.outcome, b.outcome);
  assert.equal(a.exitCode, b.exitCode);
});
