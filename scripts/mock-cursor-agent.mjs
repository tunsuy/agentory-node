#!/usr/bin/env node
/**
 * Mock Cursor Agent CLI（messaging-phase2 smoke/dev 载体）。
 *
 * 经 `CURSOR_AGENT_BIN=scripts/mock-cursor-agent.mjs` 注入，走 cursor adapter
 * `invokeCursor` 的同一条 spawn 路径。输出 `--output-format json` 形态，回填 session_id。
 * 生产零注册面：不设 env 即不存在。
 *
 * 参数面与真 agent CLI 同构：`-p --output-format json [--resume <id>] <prompt>`。
 * prompt 内可带 mock:text= / mock:outcome=failed / mock:exit=N（与 mock-claude 同方言）。
 */
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
let resume = "";
let prompt = "";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--resume") {
    resume = args[i + 1] ?? "";
    i += 1;
    continue;
  }
  if (args[i] === "-p" || args[i] === "--output-format" || args[i] === "json") continue;
  if (args[i]?.startsWith("-")) continue;
  prompt = args[i] ?? "";
}

const directives = {};
for (const m of prompt.matchAll(/mock:(\w+)=([^\s]+)/g)) directives[m[1]] = m[2];

const text =
  directives.text ??
  (prompt.trim() ? `cursor mock ok: ${prompt.trim().slice(0, 80)}` : "cursor mock ok");
const sessionId = resume || randomUUID();
const failed = directives.outcome === "failed";
const exitCode = failed ? Number(directives.exit ?? 1) || 1 : 0;

process.stdout.write(
  `${JSON.stringify({
    type: "result",
    subtype: failed ? "error" : "success",
    is_error: failed,
    result: text,
    session_id: sessionId,
  })}\n`,
);
process.exit(exitCode);
