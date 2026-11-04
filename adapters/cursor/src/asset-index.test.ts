import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { indexCursorSessions } from "./index.js";
import { titleFromTranscriptJsonl, titleFromUserText } from "./asset-index.js";

test("titleFromUserText: 优先 user_query，跳过 Image/image_files 壳", () => {
  assert.equal(
    titleFromUserText(
      "[Image]\n<image_files>\nThe following images were provided by the user and saved to disk for future use:\n1. /tmp/x.png\n</image_files>\n<user_query>\n我们来看下配置台这个页面\n</user_query>",
    ),
    "我们来看下配置台这个页面",
  );
  assert.equal(titleFromUserText("[Image]\n<image_files>\nok\n</image_files>"), "");
});

test("titleFromTranscriptJsonl: 首条 user 含 Image+user_query 时取人话标题", () => {
  const home = makeHome();
  try {
    const file = path.join(home, "s.jsonl");
    fs.writeFileSync(
      file,
      JSON.stringify({
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: "[Image]\n<image_files>\npic\n</image_files>\n<user_query>\n去掉右边常用mcp\n</user_query>",
            },
          ],
        },
      }) + "\n",
    );
    assert.equal(titleFromTranscriptJsonl(file), "去掉右边常用mcp");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agy-cursor-idx-"));
}

test("indexCursorSessions: rules 与 memory 双 kind 均带节点侧摘要（memory-asset-cards AC-1/AC-6）", () => {
  const home = makeHome();
  try {
    const cwd = path.join(home, "proj");
    const ruleDir = path.join(cwd, ".cursor", "rules");
    fs.mkdirSync(ruleDir, { recursive: true });
    fs.writeFileSync(
      path.join(ruleDir, "code-style.mdc"),
      [
        "---",
        "name: 代码风格",
        "description: 统一使用两空格缩进",
        "metadata:",
        "  type: reference",
        "---",
        "正文",
      ].join("\n"),
    );
    const memDir = path.join(cwd, ".cursor", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    // 无 frontmatter → 文件名 + 正文首行回退；首行含真令牌形态 → 出机前脱敏（AC-3 负断言）
    fs.writeFileSync(
      path.join(memDir, "MEMORY.md"),
      "# 索引\n提交前记得跑 lint，令牌 ghp_0123456789abcdefghijklmnopqrstuvwxyz 不得外泄\n",
    );

    const out = indexCursorSessions({ cwd, homeDir: home });
    const rules = out.memories.filter((m) => m.kind === "rules");
    const mems = out.memories.filter((m) => m.kind === "memory");

    assert.equal(rules.length, 1);
    assert.equal(rules[0].title, "代码风格");
    assert.equal(rules[0].description, "统一使用两空格缩进");
    assert.equal(rules[0].memType, "reference");
    assert.match(rules[0].contentHash ?? "", /^[0-9a-f]{16}$/);

    assert.equal(mems.length, 1);
    assert.equal(mems[0].title, "MEMORY");
    assert.ok(mems[0].description?.includes("提交前记得跑 lint"));
    assert.ok(!mems[0].description?.includes("ghp_0123456789"));
    assert.ok(mems[0].description?.includes("ghp_••••••••"));
    assert.equal(mems[0].memType, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("indexCursorSessions: 超大记忆文件诚实无摘要（只留既有元数据，不半读大文件）", () => {
  const home = makeHome();
  try {
    const cwd = path.join(home, "proj-big");
    const memDir = path.join(cwd, ".cursor", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "big.md"), "y".repeat(256 * 1024 + 1));

    const out = indexCursorSessions({ cwd, homeDir: home });
    const mems = out.memories.filter((m) => m.kind === "memory");
    assert.equal(mems.length, 1);
    assert.equal(mems[0].title, undefined);
    assert.equal(mems[0].description, undefined);
    assert.equal(mems[0].contentHash, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
