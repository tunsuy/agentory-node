import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyAlignPatch } from "./align.js";

test("applyAlignPatch refuses unconfirmed write", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-aln-"));
  fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
  const mcpPath = path.join(root, ".cursor", "mcp.json");
  fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { a: { command: "old" } } }));
  const r = applyAlignPatch({
    cursorRoot: root,
    patch: { mcp: [{ name: "a", command: "npx new" }], skills: [] },
    confirmed: false,
  });
  assert.equal(r.ok, false);
  assert.match(fs.readFileSync(mcpPath, "utf8"), /old/);
});

test("applyAlignPatch writes mcp+skills with snapshot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-aln-"));
  fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
  const mcpPath = path.join(root, ".cursor", "mcp.json");
  fs.writeFileSync(
    mcpPath,
    JSON.stringify({ mcpServers: { github: { command: "npx", args: ["live"] } } }),
  );
  const r = applyAlignPatch({
    cursorRoot: root,
    patch: {
      mcp: [
        { name: "github", command: "npx desired" },
        { name: "extra", command: "npx extra" },
      ],
      skills: ["brief"],
    },
    confirmed: true,
  });
  assert.equal(r.ok, true);
  assert.ok(r.snapshotPath && fs.existsSync(r.snapshotPath));
  const after = JSON.parse(fs.readFileSync(mcpPath, "utf8")) as {
    mcpServers: Record<string, { command: string; args?: string[] }>;
  };
  assert.equal(after.mcpServers.github.command, "npx");
  assert.deepEqual(after.mcpServers.github.args, ["desired"]);
  assert.ok(after.mcpServers.extra);
  const skills = JSON.parse(
    fs.readFileSync(path.join(root, ".cursor", "agentory-skills.json"), "utf8"),
  ) as { skills: string[] };
  assert.deepEqual(skills.skills, ["brief"]);
});

test("applyAlignPatch routes claude-code to .mcp.json not .cursor/", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-aln-claude-"));
  fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { keep: { command: "cursor-only" } } }),
  );
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { a: { command: "old" } } }),
  );
  const r = applyAlignPatch({
    cursorRoot: root,
    runtime: "claude-code",
    patch: { mcp: [{ name: "a", command: "npx claude" }], skills: ["s"] },
    confirmed: true,
  });
  assert.equal(r.ok, true);
  const claudeMcp = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, { command?: string; args?: string[] }>;
  };
  assert.equal(claudeMcp.mcpServers.a.command, "npx");
  assert.deepEqual(claudeMcp.mcpServers.a.args, ["claude"]);
  const cursorMcp = JSON.parse(fs.readFileSync(path.join(root, ".cursor", "mcp.json"), "utf8")) as {
    mcpServers: Record<string, { command?: string }>;
  };
  assert.equal(cursorMcp.mcpServers.keep?.command, "cursor-only");
  assert.ok(fs.existsSync(path.join(root, ".claude", "agentory-skills.json")));
});

// ── rules-desired-config 切片Ⅱ:cursor 规则写盘 + claude-code 诚实边界 ──

test("applyAlignPatch cursor 规则:写 .cursor/rules/<名>.mdc(body 原样) + 覆盖前快照 + 越权名防御跳过", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-aln-rules-"));
  fs.mkdirSync(path.join(root, ".cursor", "rules"), { recursive: true });
  const existing = path.join(root, ".cursor", "rules", "code-style.mdc");
  fs.writeFileSync(existing, "stale body");
  const r = applyAlignPatch({
    cursorRoot: root,
    patch: {
      mcp: [],
      skills: [],
      rules: [
        { name: "code-style", body: "always X" },
        { name: "new-rule", body: "# 标题\n正文" },
        { name: "../evil", body: "x" },
        { name: "a/b", body: "x" },
      ],
    },
    confirmed: true,
  });
  assert.equal(r.ok, true);
  // hash 契约:文件字节 = body 原样(不追加结尾换行) → sha256 与 API ruleBodyHash 同值
  const bytes = fs.readFileSync(existing);
  assert.equal(bytes.toString("utf8"), "always X");
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    createHash("sha256").update("always X", "utf8").digest("hex"),
  );
  assert.equal(
    fs.readFileSync(path.join(root, ".cursor", "rules", "new-rule.mdc"), "utf8"),
    "# 标题\n正文",
  );
  // 越权名防御性跳过(第二闸):rules 目录之外零文件
  assert.equal(fs.existsSync(path.join(root, ".cursor", "evil.mdc")), false);
  assert.equal(fs.existsSync(path.join(root, "evil.mdc")), false);
  assert.equal(fs.existsSync(path.join(root, ".cursor", "rules", "a")), false);
  assert.equal(r.rulesDir, path.join(root, ".cursor", "rules"));
  // 覆盖前快照既存文件
  assert.ok(r.rulesSnapshotDir);
  assert.equal(
    fs.readFileSync(path.join(r.rulesSnapshotDir!, "code-style.mdc"), "utf8"),
    "stale body",
  );
});

test("applyAlignPatch cursor 规则:无既存文件 = 零快照目录;空 patch.rules 不动 rules 目录", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-aln-rules2-"));
  fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
  const r1 = applyAlignPatch({
    cursorRoot: root,
    patch: { mcp: [], skills: [], rules: [{ name: "fresh", body: "b" }] },
    confirmed: true,
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.rulesSnapshotDir, undefined);
  assert.ok(fs.existsSync(path.join(root, ".cursor", "rules", "fresh.mdc")));

  const r2 = applyAlignPatch({
    cursorRoot: root,
    patch: { mcp: [], skills: [] }, // 老形状 patch 无 rules 字段
    confirmed: true,
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.rulesDir, undefined);
  assert.equal(fs.readFileSync(path.join(root, ".cursor", "rules", "fresh.mdc"), "utf8"), "b");
});

test("applyAlignPatch claude-code 忽略 patch.rules(一期 cursor-only 诚实边界)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-aln-cc-rules-"));
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  const r = applyAlignPatch({
    cursorRoot: root,
    runtime: "claude-code",
    patch: { mcp: [], skills: [], rules: [{ name: "r", body: "b" }] },
    confirmed: true,
  });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(root, ".claude", "rules")), false);
  assert.equal(fs.existsSync(path.join(root, ".cursor", "rules", "r.mdc")), false);
});
