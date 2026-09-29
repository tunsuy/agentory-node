import assert from "node:assert/strict";
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
