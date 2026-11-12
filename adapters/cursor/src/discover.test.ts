import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverCursorConfig } from "./index.js";

test("discoverCursorConfig follows symlinked skill entries (cc-switch pattern)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cursor-slink-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "proj");
  const store = path.join(root, "store");
  fs.mkdirSync(path.join(home, ".cursor", "skills"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".cursor"), { recursive: true }); // detectCursor 标记探 cwd/.cursor
  // 真身目录 + 真身 .md
  fs.mkdirSync(path.join(store, "linked-dir"), { recursive: true });
  fs.writeFileSync(path.join(store, "linked.md"), "# x\n");
  fs.symlinkSync(path.join(store, "linked-dir"), path.join(home, ".cursor", "skills", "linked-dir"), "dir");
  fs.symlinkSync(path.join(store, "linked.md"), path.join(home, ".cursor", "skills", "linked.md"), "file");
  // 断链不炸、不上报
  fs.symlinkSync(path.join(store, "gone"), path.join(home, ".cursor", "skills", "dead"), "dir");

  const agent = discoverCursorConfig({ homeDir: home, cwd });
  assert.ok(agent);
  assert.ok(agent.skills.includes("linked-dir"), "symlinked skill dir must be discovered");
  assert.ok(agent.skills.includes("linked"), "symlinked .md must be discovered (ext stripped)");
  assert.ok(!agent.skills.includes("dead"), "broken symlink must be skipped");
});
