import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { invokeCursor } from "./invoke.js";

test("invokeCursor: -p json 新开 + session_id 回填 + 零权限放宽 flag", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cursor-i-"));
  const argsFile = path.join(root, "args.txt");
  const fakeBin = path.join(root, "fake-agent.sh");
  const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  fs.writeFileSync(
    fakeBin,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`,
      `printf '%s\\n' '{"type":"result","subtype":"success","result":"cursor-ok","session_id":"${sid}"}'`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  const prev = process.env.CURSOR_AGENT_BIN;
  process.env.CURSOR_AGENT_BIN = fakeBin;
  try {
    const res = await invokeCursor(
      { homeDir: root, cwd: root },
      { prompt: "总结最近一周构建失败原因", timeoutMs: 10_000, maxOutputBytes: 4096, cwd: root },
    );
    assert.equal(res.outcome, "done");
    assert.match(res.output, /cursor-ok/);
    assert.equal(res.runtimeSessionId, sid);
    const sentArgs = fs.readFileSync(argsFile, "utf8").split("\n").filter(Boolean);
    assert.deepEqual(sentArgs, [
      "-p",
      "--output-format",
      "json",
      "总结最近一周构建失败原因",
    ]);
    for (const arg of sentArgs) {
      assert.ok(
        !/force|yolo|dangerously|skip-permissions|permission-mode|bypass/i.test(arg),
        `不得注入权限放宽 flag: ${arg}`,
      );
    }
  } finally {
    if (prev === undefined) delete process.env.CURSOR_AGENT_BIN;
    else process.env.CURSOR_AGENT_BIN = prev;
  }
});

test("invokeCursor: resumeSessionId → --resume 接续", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cursor-r-"));
  const argsFile = path.join(root, "args.txt");
  const fakeBin = path.join(root, "fake-agent.sh");
  fs.writeFileSync(
    fakeBin,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`,
      'printf \'%s\\n\' \'{"type":"result","subtype":"success","result":"continued","session_id":"11111111-2222-3333-4444-555555555555"}\'',
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  const prev = process.env.CURSOR_AGENT_BIN;
  process.env.CURSOR_AGENT_BIN = fakeBin;
  const resumeId = "11111111-2222-3333-4444-555555555555";
  try {
    const res = await invokeCursor(
      { homeDir: root, cwd: root },
      {
        prompt: "继续上次话题",
        timeoutMs: 10_000,
        maxOutputBytes: 4096,
        cwd: root,
        resumeSessionId: resumeId,
      },
    );
    assert.equal(res.outcome, "done");
    assert.equal(res.runtimeSessionId, resumeId);
    const sentArgs = fs.readFileSync(argsFile, "utf8").split("\n").filter(Boolean);
    assert.ok(sentArgs.includes("--resume"));
    assert.ok(sentArgs.includes(resumeId));
    assert.ok(sentArgs.includes("-p"));
  } finally {
    if (prev === undefined) delete process.env.CURSOR_AGENT_BIN;
    else process.env.CURSOR_AGENT_BIN = prev;
  }
});
