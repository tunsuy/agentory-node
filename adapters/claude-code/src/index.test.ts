import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyAlignPatch, discoverClaudeCodeConfig } from "./index.js";

test("discoverClaudeCodeConfig reads project .mcp.json and skills", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-claude-d-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "proj");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        docs: { type: "http", url: "https://example.com/mcp" },
        local: { command: "npx", args: ["-y", "svc"] },
      },
    }),
  );
  fs.mkdirSync(path.join(cwd, ".claude", "skills", "brief"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".claude", "skills", "brief", "SKILL.md"), "# x\n");

  const agent = discoverClaudeCodeConfig({ homeDir: home, cwd });
  assert.ok(agent);
  assert.equal(agent.supported, true);
  assert.equal(agent.runtime, "claude-code");
  assert.equal(agent.mcp.length, 2);
  assert.ok(agent.mcp.find((m) => m.name === "docs" && m.command === "https://example.com/mcp"));
  assert.ok(agent.mcp.find((m) => m.name === "local" && m.command?.includes("npx")));
  assert.ok(agent.skills.includes("brief"));
});

test("applyAlignPatch Claude refuses unconfirmed; writes .mcp.json on confirm", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-claude-a-"));
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { a: { command: "old" } } }),
  );
  const denied = applyAlignPatch({
    projectRoot: root,
    patch: { mcp: [{ name: "a", command: "npx new" }], skills: ["s1"] },
    confirmed: false,
  });
  assert.equal(denied.ok, false);
  assert.match(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"), /old/);

  const ok = applyAlignPatch({
    projectRoot: root,
    patch: {
      mcp: [
        { name: "a", command: "npx new" },
        { name: "remote", command: "https://mcp.example/x" },
      ],
      skills: ["s1"],
    },
    confirmed: true,
  });
  assert.equal(ok.ok, true);
  assert.ok(ok.snapshotPath && fs.existsSync(ok.snapshotPath));
  const after = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, { command?: string; args?: string[]; type?: string; url?: string }>;
  };
  assert.equal(after.mcpServers.a.command, "npx");
  assert.deepEqual(after.mcpServers.a.args, ["new"]);
  assert.equal(after.mcpServers.remote.type, "http");
  assert.equal(after.mcpServers.remote.url, "https://mcp.example/x");
  const skills = JSON.parse(
    fs.readFileSync(path.join(root, ".claude", "agentory-skills.json"), "utf8"),
  ) as { skills: string[] };
  assert.deepEqual(skills.skills, ["s1"]);
});

test("applyAlignPatch Claude：stdio env / http headers 原样落盘（${ENV} 占位，invariant #6）；未声明不带键（mcp-registry-integration）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-claude-e-"));
  const res = applyAlignPatch({
    projectRoot: root,
    patch: {
      mcp: [
        { name: "fs", command: "npx -y p@1.0.0", env: { RFS_API_KEY: "${RFS_API_KEY}" } },
        { name: "remote", command: "https://mcp.example/x", headers: { Authorization: "Bearer ${SMITHERY_API_KEY}" } },
        { name: "plain", command: "npx -y bare" },
      ],
      skills: [],
    },
    confirmed: true,
  });
  assert.equal(res.ok, true);
  const raw = fs.readFileSync(path.join(root, ".mcp.json"), "utf8");
  const after = JSON.parse(raw) as {
    mcpServers: Record<
      string,
      { command?: string; args?: string[]; env?: Record<string, string>; type?: string; url?: string; headers?: Record<string, string> }
    >;
  };
  // stdio：command+args+env（Claude Code 原生展开 ${ENV}，秘密本体只在节点环境变量）
  assert.deepEqual(after.mcpServers.fs, {
    command: "npx",
    args: ["-y", "p@1.0.0"],
    env: { RFS_API_KEY: "${RFS_API_KEY}" },
  });
  // remote：{type:"http",url,headers}，值仅占位符
  assert.deepEqual(after.mcpServers.remote, {
    type: "http",
    url: "https://mcp.example/x",
    headers: { Authorization: "Bearer ${SMITHERY_API_KEY}" },
  });
  // 未声明 env/headers 的条目不带空键（老形状零变化）
  assert.deepEqual(after.mcpServers.plain, { command: "npx", args: ["-y", "bare"] });
  assert.ok(!/"env": \{\}/.test(raw) && !/"headers": \{\}/.test(raw), "空对象不落盘");
});
