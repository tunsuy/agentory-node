#!/usr/bin/env node
/**
 * Mock 执行 runtime（agent-messaging smoke/dev 载体 · billing MockChannel 判例）。
 *
 * 形态：假 claude 二进制——经 `CLAUDE_CODE_BIN=scripts/mock-claude.mjs` 注入，
 * 走 claude-code adapter `runHeadless` 的**完全同一条 spawn 路径**（超时 kill、
 * 字节截断、退出码全部是真机制）。生产零注册面：不设 env 即不存在。
 *
 * 确定性回放：不联网、不读盘、同一输入永远同一输出。行为由 prompt 内指令驱动：
 *   mock:text=STR        输出 STR（默认 `mock ok: <prompt>`）
 *   mock:bytes=N         输出 N 个 'x'（撑爆 maxOutputBytes 触发真截断）
 *   mock:file=PATH       向 cwd 写一个文件（内容 = 最终输出;github-task e2e 的改动面载体）
 *   mock:outcome=failed  以非零码退出（配 mock:exit=N，默认 1）
 *   mock:delay=MS        输出前睡眠（≤60s 钳制）
 *   mock:hang=1          输出部分行后挂住——等 runner 真超时 kill（AC-7 全真路径）
 *
 * 参数面与真 claude headless 同构：`-p <prompt> --session-id <uuid>`（其余忽略）。
 */

const args = process.argv.slice(2);
let prompt = "";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "-p") prompt = args[i + 1] ?? "";
}

const directives = {};
for (const m of prompt.matchAll(/mock:(\w+)=([^\s]+)/g)) directives[m[1]] = m[2];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const delay = Number(directives.delay ?? 0);
  if (Number.isFinite(delay) && delay > 0) await sleep(Math.min(delay, 60_000));

  if (directives.hang === "1") {
    process.stdout.write("mock partial before hang\n");
    await sleep(3_600_000);
    return;
  }

  let out = directives.text ?? `mock ok: ${prompt}`;
  const bytes = Number(directives.bytes ?? 0);
  if (Number.isFinite(bytes) && bytes > 0) out = "x".repeat(Math.min(bytes, 5_000_000));
  process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);

  if (directives.file) {
    // github-task e2e 改动面：向 cwd 写文件（真 fs,与真 runtime 改工作区同效）。
    const { writeFileSync } = await import("node:fs");
    writeFileSync(directives.file, `${out}\n`);
  }

  if (directives.outcome === "failed") {
    const exit = Number(directives.exit ?? 1);
    process.exit(Number.isFinite(exit) ? exit : 1);
  }
  process.exit(0);
}

main();
