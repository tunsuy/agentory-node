import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverAgents, discoverAgentsWithHealth } from "./discover.js";

test("discover cursor mcp and empty skills; claude supported", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-disc-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "proj");
  fs.mkdirSync(path.join(cwd, ".cursor"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        github: { command: "npx", args: ["-y", "server"] },
      },
    }),
  );
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });

  const agents = discoverAgents({ homeDir: home, cwd });
  const cursor = agents.find((a) => a.runtime === "cursor");
  const claude = agents.find((a) => a.runtime === "claude-code");
  assert.ok(cursor);
  assert.equal(cursor.supported, true);
  assert.equal(cursor.mcp.length, 1);
  assert.equal(cursor.mcp[0]?.name, "github");
  assert.equal(cursor.mcp[0]?.status, "unknown");
  assert.deepEqual(cursor.skills, []);
  assert.ok(claude);
  assert.equal(claude.supported, true);
});

test("discoverAgentsWithHealth probes bindings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-disc-h-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "proj");
  fs.mkdirSync(path.join(cwd, ".cursor"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        broken: { command: "npx", args: ["invalid", "bad-url"] },
        ok: { command: "npx", args: ["-y", "server"] },
      },
    }),
  );
  const agents = await discoverAgentsWithHealth({ homeDir: home, cwd });
  const cursor = agents.find((a) => a.runtime === "cursor");
  assert.ok(cursor);
  const broken = cursor.mcp.find((m) => m.name === "broken");
  const ok = cursor.mcp.find((m) => m.name === "ok");
  assert.equal(broken?.status, "failed");
  assert.ok(broken?.reason);
  assert.equal(ok?.status, "healthy");
});

test("discover includes ~/.cursor/skills-cursor names", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-skills-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "proj");
  fs.mkdirSync(path.join(cwd, ".cursor"), { recursive: true });
  fs.mkdirSync(path.join(home, ".cursor", "skills-cursor", "native-skill"), { recursive: true });
  fs.writeFileSync(path.join(home, ".cursor", "skills-cursor", "native-skill", "SKILL.md"), "# native\n");

  const agents = discoverAgents({ homeDir: home, cwd });
  const cursor = agents.find((a) => a.runtime === "cursor");
  assert.ok(cursor);
  assert.ok(cursor.skills.includes("native-skill"));
});

test("fixture overrides filesystem", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-fix-"));
  const fixture = path.join(root, "fix.json");
  fs.writeFileSync(
    fixture,
    JSON.stringify({
      agents: [
        {
          runtime: "cursor",
          supported: true,
          displayName: "Cursor · fixture",
          mcp: [],
          skills: [],
        },
      ],
    }),
  );
  const agents = discoverAgents({ fixturePath: fixture, homeDir: root, cwd: root });
  assert.equal(agents.length, 1);
  assert.equal(agents[0]?.mcp.length, 0);
});

// rules-desired-config 切片Ⅱ:规则发现只报名字 + sha256(文件字节),正文不出节点。
test("discover cursor rules:名字+hash 上报 · cwd 优先 · 非 .mdc 忽略 · claude 恒空", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-disc-rules-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "proj");
  fs.mkdirSync(path.join(cwd, ".cursor", "rules"), { recursive: true });
  fs.mkdirSync(path.join(home, ".cursor", "rules"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".cursor", "rules", "code-style.mdc"), "cwd body");
  fs.writeFileSync(path.join(home, ".cursor", "rules", "code-style.mdc"), "home body"); // 同名:cwd 优先
  fs.writeFileSync(path.join(home, ".cursor", "rules", "global.mdc"), "g");
  fs.writeFileSync(path.join(cwd, ".cursor", "rules", "notes.md"), "ignored"); // 非 .mdc 不进规则维

  const agents = discoverAgents({ homeDir: home, cwd });
  const cursor = agents.find((a) => a.runtime === "cursor")!;
  assert.ok(cursor);
  const byName = new Map((cursor.rules ?? []).map((r) => [r.name, r]));
  assert.equal(byName.size, 2);
  assert.equal(
    byName.get("code-style")?.contentHash,
    createHash("sha256").update("cwd body", "utf8").digest("hex"),
  );
  assert.equal(
    byName.get("global")?.contentHash,
    createHash("sha256").update("g", "utf8").digest("hex"),
  );
  assert.equal(byName.has("notes"), false);

  // claude-code 诚实边界:恒报空 rules
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  const agents2 = discoverAgents({ homeDir: home, cwd });
  const claude = agents2.find((a) => a.runtime === "claude-code")!;
  assert.ok(claude);
  assert.deepEqual(claude.rules, []);
});
