import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  TRANSCRIPT_MESSAGE_MAX_CHARS,
  TRANSCRIPT_WINDOW_MESSAGES,
  captureTranscriptSnapshot,
  maskSecrets,
  transcriptFileForSourceKey,
} from "./transcript.js";

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentory-tr-"));
}

function writeJsonl(home: string, rel: string, rows: unknown[]): string {
  const file = path.join(home, ".cursor", "projects", rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n"));
  return file;
}

test("maskSecrets masks common token shapes (AC-3)", () => {
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
  // 普通文本不受影响
  assert.equal(maskSecrets("fix the login bug please"), "fix the login bug please");
});

test("maskSecrets masks long hex / base64 blobs", () => {
  const hex = "a".repeat(48);
  const b64 = "AbcD" + "e6Fg7H" + "a9b8c7d6e5f4g3h2i1j0k9l8m7n6o5p4q3r2s1"; // ≥40 随机形态
  for (const raw of [hex, b64]) {
    const out = maskSecrets(raw);
    assert.equal(out.includes(raw), false, `leaked: ${raw}`);
  }
});

test("captureTranscriptSnapshot parses jsonl, caps long messages, masks secrets", () => {
  const home = makeHome();
  try {
    const long = "x".repeat(TRANSCRIPT_MESSAGE_MAX_CHARS + 500);
    const file = writeJsonl(home, "Users-dev-work-app/agent-transcripts/id1/id1.jsonl", [
      { role: "user", message: { content: [{ type: "text", text: "Fix login with sk-abcdef0123456789abcdef" }] }, ts: "2026-09-24T10:00:00.000Z" },
      { role: "assistant", message: { content: [{ type: "text", text: long }] }, ts: "2026-09-24T10:00:05.000Z" },
      { role: "tool", message: { content: [{ type: "text", text: "ignored role" }] } },
      "not-json",
      { role: "user", message: { content: [{ type: "text", text: "<timestamp>x</timestamp>hi <user_query>there" }] }, ts: "2026-09-24T10:01:00.000Z" },
    ]);
    const snap = captureTranscriptSnapshot(file, new Date("2026-09-24T12:00:00.000Z"));
    assert.ok(snap);
    assert.equal(snap.sourceKey, `cursor-transcript:${file}`);
    assert.equal(snap.messages.length, 3);
    assert.equal(snap.messages[0].role, "user");
    assert.equal(snap.messages[0].text.includes("sk-abcdef"), false);
    assert.ok(snap.messages[0].text.includes("sk-••••••••"));
    assert.ok(snap.messages[1].text.length <= TRANSCRIPT_MESSAGE_MAX_CHARS + 1);
    assert.ok(snap.messages[1].text.endsWith("…"));
    // timestamp 标签被清理
    assert.ok(!snap.messages[2].text.includes("timestamp"));
    assert.equal(snap.messages[2].text, "hi there");
    assert.equal(snap.truncated, false);
    assert.equal(snap.capturedAt, "2026-09-24T12:00:00.000Z");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("captureTranscriptSnapshot keeps near-end window and sets truncated (AC-4)", () => {
  const home = makeHome();
  try {
    const rows = Array.from({ length: TRANSCRIPT_WINDOW_MESSAGES + 27 }, (_, i) => ({
      role: "user",
      message: `msg-${i}`,
    }));
    const file = writeJsonl(home, "p/agent-transcripts/id2/id2.jsonl", rows);
    const snap = captureTranscriptSnapshot(file);
    assert.ok(snap);
    assert.equal(snap.messages.length, TRANSCRIPT_WINDOW_MESSAGES);
    assert.equal(snap.truncated, true);
    assert.ok(snap.windowTotal);
    assert.match(snap.windowTotal, new RegExp(`${TRANSCRIPT_WINDOW_MESSAGES} / ${rows.length}`));
    // 近端：窗口第一条是倒数第 40 条
    assert.equal(snap.messages[0].text, `msg-${rows.length - TRANSCRIPT_WINDOW_MESSAGES}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("captureTranscriptSnapshot empty / missing files (AC-1 空态)", () => {
  const home = makeHome();
  try {
    const file = writeJsonl(home, "p/agent-transcripts/id3/id3.jsonl", [
      { role: "tool", message: "no user/assistant rows" },
    ]);
    const empty = captureTranscriptSnapshot(file);
    assert.ok(empty);
    assert.deepEqual(empty.messages, []);

    const missing = captureTranscriptSnapshot(path.join(home, "nope.jsonl"));
    assert.equal(missing, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("transcriptFileForSourceKey enforces ~/.cursor/projects containment (invariants §4)", () => {
  const home = makeHome();
  try {
    const inside = path.join(home, ".cursor", "projects", "slug", "agent-transcripts", "id", "id.jsonl");
    assert.equal(transcriptFileForSourceKey(`cursor-transcript:${inside}`, home), inside);

    // 逃逸出 projects 根 → 拒绝
    const outside = path.join(home, ".ssh", "id_ed25519");
    assert.equal(transcriptFileForSourceKey(`cursor-transcript:${outside}`, home), undefined);
    // 其他前缀 / 非路径
    assert.equal(transcriptFileForSourceKey(`cursor-session:${inside}`, home), undefined);
    assert.equal(transcriptFileForSourceKey("cursor-transcript:", home), undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
