import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MEMORY_DESC_MAX } from "@agentoryhq/shared";
import {
  TRANSCRIPT_MESSAGE_MAX_CHARS,
  TRANSCRIPT_WINDOW_MESSAGES,
  captureTranscriptSnapshot,
  indexClaudeSessions,
  maskSecrets,
  cwdForClaudeResume,
  findClaudeSessionJsonl,
  projectPathFromClaudeSessionJsonl,
  summarizeMemoryFile,
  titleFromClaudeSessionJsonl,
  transcriptFileForSourceKey,
} from "./index.js";

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agy-claude-idx-"));
}

/** Real-shape claude rows (verified schema; bodies are fixture-only). */
function row(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    cwd: "/Users/demo/work/app",
    isSidechain: false,
    timestamp: "2026-10-30T10:00:00.000Z",
    version: "2.1.0",
    ...partial,
  };
}

function humanRow(text: string): Record<string, unknown> {
  return row({
    type: "user",
    origin: { kind: "human" },
    message: { role: "user", content: text },
  });
}

function writeSession(home: string, slug: string, file: string, rows: unknown[]): string {
  const target = path.join(home, ".claude", "projects", slug, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, rows.map((r) => JSON.stringify(r)).join("\n"));
  return target;
}

test("indexClaudeSessions discovers sessions + memory, excludes subdirs and non-dialog files (AC-3)", () => {
  const home = makeHome();
  try {
    const jsonl = writeSession(home, "Users-demo-work-app", "11111111-2222-3333-4444-555555555555.jsonl", [
      { type: "mode", mode: "default" },
      { type: "permission-mode", permissionMode: "default" },
      { type: "system", subtype: "init", content: "system noise" },
      humanRow("Fix the flaky test in ci"),
      row({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "tool echo" }] },
      }),
      row({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "On it" }] },
      }),
    ]);

    // <uuid>/ subdir (subagent data) — must NOT be indexed even if it holds .jsonl-like files
    const sub = path.join(home, ".claude", "projects", "Users-demo-work-app", "11111111-2222-3333-4444-555555555555", "sub.jsonl");
    fs.mkdirSync(path.dirname(sub), { recursive: true });
    fs.writeFileSync(sub, "garbage");

    // non-jsonl stray file
    fs.writeFileSync(path.join(home, ".claude", "projects", "Users-demo-work-app", "notes.txt"), "x");

    // memory dimension (Q1 随行)
    const memDir = path.join(home, ".claude", "projects", "Users-demo-work-app", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "MEMORY.md"), "# index\n");

    const out = indexClaudeSessions({ homeDir: home, cwd: home });
    assert.equal(out.sessions.length, 1);
    const s = out.sessions[0];
    assert.equal(s.sourceKey, `claude-session:${jsonl}`);
    assert.equal(s.runtime, "claude-code");
    // title = first human row text, NOT the tool_result echo or system rows
    assert.equal(s.displayName, "Fix the flaky test in ci");
    // cwd field is the authoritative projectPath
    assert.equal(s.projectPath, "/Users/demo/work/app");
    assert.ok(s.updatedAt);

    assert.equal(out.memories.length, 1);
    const m = out.memories[0];
    assert.equal(m.kind, "memory");
    assert.equal(m.sourceKey, `claude-memory:${path.join(memDir, "MEMORY.md")}`);
    assert.equal(m.runtime, "claude-code");
    assert.match(m.pathLabel, /Users-demo-work-app\/memory\/MEMORY\.md/);
    // memory projectPath inherits cwd from a sibling session in the same slug
    assert.equal(m.projectPath, "/Users/demo/work/app");
    // memory-asset-cards: "# index\n" 无 frontmatter → title 回退文件名、hash 恒在（AC-1/AC-4）
    assert.equal(m.title, "MEMORY");
    assert.match(m.contentHash ?? "", /^[0-9a-f]{16}$/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("indexClaudeSessions excludes sidechain rows from the title (AC-3)", () => {
  const home = makeHome();
  try {
    const jsonl = writeSession(home, "Users-demo-work-app", "99999999-8888-7777-6666-555555555555.jsonl", [
      // sidechain human row comes first in file order — must be skipped for title
      row({
        type: "user",
        isSidechain: true,
        origin: { kind: "human" },
        message: { role: "user", content: "subagent internal prompt" },
      }),
      humanRow("Main thread request"),
    ]);
    const title = titleFromClaudeSessionJsonl(jsonl);
    assert.equal(title, "Main thread request");

    const out = indexClaudeSessions({ homeDir: home, cwd: home });
    assert.equal(out.sessions.length, 1);
    assert.equal(out.sessions[0].displayName, "Main thread request");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("titleFromClaudeSessionJsonl truncates to 80 chars (AC-3)", () => {
  const home = makeHome();
  try {
    const jsonl = writeSession(home, "Users-demo-work-app", "aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl", [
      humanRow("y".repeat(200)),
    ]);
    const title = titleFromClaudeSessionJsonl(jsonl);
    assert.ok(title.length <= 80 + 1); // 80 chars + …
    assert.ok(title.endsWith("…"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("indexClaudeSessions skips jsonl without any human row (not an indexable conversation)", () => {
  const home = makeHome();
  try {
    writeSession(home, "Users-demo-work-app", "00000000-0000-0000-0000-000000000000.jsonl", [
      { type: "mode", mode: "default" },
      row({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "orphan reply" }] } }),
    ]);
    const out = indexClaudeSessions({ homeDir: home, cwd: home });
    assert.equal(out.sessions.length, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("cwdForClaudeResume: 续聊优先会话 jsonl 内 cwd，目录不存在则 fallback", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cwd-resume-"));
  const proj = path.join(home, "my-proj");
  fs.mkdirSync(proj);
  const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const slugDir = path.join(home, ".claude", "projects", "Users-demo-my-proj");
  fs.mkdirSync(slugDir, { recursive: true });
  const jsonl = path.join(slugDir, `${sid}.jsonl`);
  fs.writeFileSync(
    jsonl,
    `${JSON.stringify({ type: "system", cwd: proj })}\n${JSON.stringify({
      type: "user",
      origin: { kind: "human" },
      message: { content: "hi" },
    })}\n`,
  );
  assert.equal(findClaudeSessionJsonl(home, sid), jsonl);
  assert.equal(cwdForClaudeResume(home, sid, "/fallback"), proj);
  assert.equal(
    cwdForClaudeResume(home, "00000000-0000-0000-0000-000000000000", "/fallback"),
    "/fallback",
  );
  // 会话 cwd 已删 → fallback
  fs.rmSync(proj, { recursive: true, force: true });
  assert.equal(cwdForClaudeResume(home, sid, "/fallback"), "/fallback");
});

test("projectPathFromClaudeSessionJsonl reads cwd from first row", () => {
  const home = makeHome();
  try {
    const jsonl = writeSession(home, "Users-demo-work-app", "12345678-1234-1234-1234-123456789012.jsonl", [
      row({ type: "system", cwd: "/Users/demo/work/app" }),
      humanRow("hi"),
    ]);
    assert.equal(projectPathFromClaudeSessionJsonl(jsonl), "/Users/demo/work/app");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("maskSecrets masks common token shapes (AC-4)", () => {
  const cases: Array<[string, string]> = [
    ["sk-abcdef0123456789abcdef", "sk-••••••••"],
    ["ghp_0123456789abcdefghijklmnopqrstuvwxyz", "ghp_••••••••"],
    ["xoxb-0123456789abcdefGHI", "xox•-••••••••"],
  ];
  for (const [raw, masked] of cases) {
    assert.equal(maskSecrets(raw).includes(masked), true);
    assert.equal(maskSecrets(raw).includes(raw), false);
  }
  const kv = maskSecrets("deploy with password=hunter2-secret now");
  assert.equal(kv.includes("hunter2"), false);
  assert.equal(maskSecrets("fix the login bug please"), "fix the login bug please");
});

test("captureTranscriptSnapshot: human gate, sidechain/tool_result exclusion, masking (AC-4)", () => {
  const home = makeHome();
  try {
    const long = "x".repeat(TRANSCRIPT_MESSAGE_MAX_CHARS + 500);
    const jsonl = writeSession(home, "Users-demo-work-app", "abcdefab-cdef-abcd-efab-cdefabcdefab.jsonl", [
      { type: "mode", mode: "default" },
      { type: "permission-mode", permissionMode: "acceptEdits" },
      { type: "file-history-snapshot", snapshot: "x" },
      { type: "attachment", attachment: { path: "x" } },
      humanRow("Fix login with sk-abcdef0123456789abcdef"),
      // tool_result row (type user) — NOT human input, excluded
      row({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "tool echo body" }] },
      }),
      // user row without human origin — excluded
      row({
        type: "user",
        message: { role: "user", content: "no-origin text" },
      }),
      // sidechain assistant — excluded
      row({
        type: "assistant",
        isSidechain: true,
        message: { role: "assistant", content: [{ type: "text", text: "subagent text" }] },
      }),
      row({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal" },
            { type: "text", text: long },
          ],
        },
      }),
      "not-json",
    ]);
    const snap = captureTranscriptSnapshot(jsonl, new Date("2026-10-30T12:00:00.000Z"));
    assert.ok(snap);
    assert.equal(snap.sourceKey, `claude-session:${jsonl}`);
    assert.equal(snap.messages.length, 2);
    assert.equal(snap.messages[0].role, "user");
    assert.equal(snap.messages[0].text.includes("sk-abcdef"), false);
    assert.ok(snap.messages[0].text.includes("sk-••••••••"));
    assert.equal(snap.messages[1].role, "assistant");
    assert.ok(snap.messages[1].text.length <= TRANSCRIPT_MESSAGE_MAX_CHARS + 1);
    assert.ok(snap.messages[1].text.endsWith("…"));
    // tool echo / non-human / sidechain / non-dialog rows never appear
    const joined = snap.messages.map((m) => m.text).join(" ");
    assert.ok(!joined.includes("tool echo"));
    assert.ok(!joined.includes("no-origin"));
    assert.ok(!joined.includes("subagent"));
    assert.equal(snap.truncated, false);
    assert.equal(snap.capturedAt, "2026-10-30T12:00:00.000Z");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("captureTranscriptSnapshot keeps near-end window + truncated flag (AC-4)", () => {
  const home = makeHome();
  try {
    const rows = Array.from({ length: TRANSCRIPT_WINDOW_MESSAGES + 27 }, (_, i) =>
      humanRow(`msg-${i}`),
    );
    const jsonl = writeSession(home, "p-slug", "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb.jsonl", rows);
    const snap = captureTranscriptSnapshot(jsonl);
    assert.ok(snap);
    assert.equal(snap.messages.length, TRANSCRIPT_WINDOW_MESSAGES);
    assert.equal(snap.truncated, true);
    assert.ok(snap.windowTotal);
    assert.match(snap.windowTotal, new RegExp(`${TRANSCRIPT_WINDOW_MESSAGES} / ${rows.length}`));
    assert.equal(snap.messages[0].text, `msg-${rows.length - TRANSCRIPT_WINDOW_MESSAGES}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("captureTranscriptSnapshot missing file → undefined (AC-4)", () => {
  const home = makeHome();
  try {
    assert.equal(captureTranscriptSnapshot(path.join(home, "nope.jsonl")), undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("transcriptFileForSourceKey enforces ~/.claude/projects containment (invariants §4, AC-4)", () => {
  const home = makeHome();
  try {
    const inside = path.join(home, ".claude", "projects", "slug", "session.jsonl");
    assert.equal(transcriptFileForSourceKey(`claude-session:${inside}`, home), inside);

    const outside = path.join(home, ".ssh", "id_ed25519");
    assert.equal(transcriptFileForSourceKey(`claude-session:${outside}`, home), undefined);
    // cursor-prefixed keys are not ours — must not resolve
    assert.equal(transcriptFileForSourceKey(`cursor-transcript:${inside}`, home), undefined);
    assert.equal(transcriptFileForSourceKey("claude-session:", home), undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── memory-asset-cards：节点侧记忆摘要（frontmatter → 回退；mask + 截断在出机前，全文永不出机）──

function writeMemFile(dir: string, name: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, content);
  return f;
}

test("summarizeMemoryFile: frontmatter wins, secrets masked BEFORE egress (memory-asset-cards AC-1/AC-3)", () => {
  const home = makeHome();
  try {
    const dir = path.join(home, "mem");
    const f = writeMemFile(
      dir,
      "deploy-prefs.md",
      [
        "---",
        "name: 部署偏好",
        "description: 用户偏好 canary 发布；密钥 sk-abcdef0123456789abcdef 不得外泄",
        "metadata:",
        "  type: user",
        "---",
        "# 正文",
        "正文首行不应被采用",
      ].join("\n"),
    );
    const s = summarizeMemoryFile(f);
    assert.equal(s.title, "部署偏好");
    assert.equal(s.memType, "user");
    assert.ok(s.description?.includes("canary 发布"));
    // AC-3 负断言：真令牌形态在出机前已脱敏
    assert.ok(!s.description?.includes("sk-abcdef0123456789"));
    assert.ok(s.description?.includes("sk-••••••••"));
    assert.match(s.contentHash ?? "", /^[0-9a-f]{16}$/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("summarizeMemoryFile: no frontmatter → filename + first body line; over-limit truncated (AC-1)", () => {
  const home = makeHome();
  try {
    const dir = path.join(home, "mem2");
    const f = writeMemFile(dir, "my-notes.md", "# 标题\n\nfirst real line\nsecond line\n");
    const s = summarizeMemoryFile(f);
    assert.equal(s.title, "my-notes");
    assert.equal(s.description, "first real line");
    assert.equal(s.memType, undefined);

    // 注意：不能用 "x".repeat(N)——单字符长串会命中 maskSecrets 长密钥形态被整体掩码，
    // 测不到截断分支；用带空格的长词文本（脱敏不动、纯超长）
    const long = writeMemFile(dir, "long.md", `# t\n\n${"release notes ".repeat(30)}\n`);
    const ls = summarizeMemoryFile(long);
    assert.ok(ls.description!.length <= MEMORY_DESC_MAX);
    assert.ok(ls.description!.endsWith("…"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("summarizeMemoryFile: contentHash stable per content; oversized file → no summary (AC-2/AC-3)", () => {
  const home = makeHome();
  try {
    const dir = path.join(home, "mem3");
    const a = writeMemFile(dir, "a.md", "same body\n");
    const b = writeMemFile(dir, "b.md", "same body\n");
    const c = writeMemFile(dir, "c.md", "different body\n");
    // 同内容异路径 → 同 hash（跨 Agent 归组键）；异内容 → 异 hash（负断言：不瞎合并）
    assert.equal(summarizeMemoryFile(a).contentHash, summarizeMemoryFile(b).contentHash);
    assert.notEqual(summarizeMemoryFile(a).contentHash, summarizeMemoryFile(c).contentHash);

    const big = writeMemFile(dir, "big.md", "y".repeat(256 * 1024 + 1));
    assert.deepEqual(summarizeMemoryFile(big), {}); // 诚实「无摘要」，不半读大文件
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
