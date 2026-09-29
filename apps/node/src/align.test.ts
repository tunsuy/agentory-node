import assert from "node:assert/strict";
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
