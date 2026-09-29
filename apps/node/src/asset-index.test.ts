import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverAssetIndex } from "./asset-index.js";

test("discoverAssetIndex reads rules and session meta without bodies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentory-idx-"));
  try {
    const rules = path.join(root, ".cursor", "rules");
    fs.mkdirSync(rules, { recursive: true });
    fs.writeFileSync(path.join(rules, "harness.mdc"), "SECRET=should-not-appear-in-index\n");

    const sessions = path.join(root, ".cursor", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, "a.meta.json"),
      JSON.stringify({
        displayName: "Demo session",
        projectPath: root,
        updatedAt: "2026-09-16T10:00:00.000Z",
      }),
    );

    const out = discoverAssetIndex({ cwd: root, homeDir: root });
    assert.equal(out.sessions.length, 1);
    assert.equal(out.sessions[0].displayName, "Demo session");
    assert.ok(!JSON.stringify(out).includes("SECRET"));
    assert.equal(out.memories.length, 1);
    assert.equal(out.memories[0].kind, "rules");
    assert.match(out.memories[0].pathLabel, /harness\.mdc/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discoverAssetIndex fixture path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentory-fix-"));
  try {
    const file = path.join(root, "fixture.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        sessions: [
          {
            sourceKey: "fx1",
            displayName: "From fixture",
            updatedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
        memories: [],
      }),
    );
    const out = discoverAssetIndex({ fixturePath: file, cwd: root });
    assert.equal(out.sessions.length, 1);
    assert.equal(out.sessions[0].displayName, "From fixture");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discoverAssetIndex reads native agent-transcripts metadata only", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentory-home-"));
  try {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const projSlug = "Users-demo-work-app";
    const projectPath = "/Users/demo/work/app";
    const jsonl = path.join(home, ".cursor", "projects", projSlug, "agent-transcripts", id, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(jsonl), { recursive: true });
    const secret = "SUPER_SECRET_BODY_SHOULD_NOT_LEAK";
    fs.writeFileSync(
      jsonl,
      [
        JSON.stringify({
          role: "user",
          message: { content: [{ type: "text", text: "Fix the login bug please" }] },
        }),
        JSON.stringify({
          role: "assistant",
          message: { content: [{ type: "text", text: `I will help ${secret}` }] },
        }),
      ].join("\n"),
    );

    const ws = path.join(
      home,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "workspaceStorage",
      "ws1",
    );
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "workspace.json"), JSON.stringify({ folder: `file://${projectPath}` }));

    const out = discoverAssetIndex({ cwd: home, homeDir: home });
    assert.equal(out.sessions.length, 1);
    assert.equal(out.sessions[0].projectPath, projectPath);
    assert.match(out.sessions[0].displayName, /Fix the login bug/);
    assert.ok(!out.sessions[0].displayName.includes(secret));
    assert.ok(!JSON.stringify(out).includes(secret));
    assert.match(out.sessions[0].sourceKey, /cursor-transcript:/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
