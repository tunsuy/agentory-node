import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { AdapterContext, SkillFileManifestEntry, SkillInstallItem } from "@agentoryhq/runtime-contract";
import { installSkills, claudeSkillsRoot, SKILL_MARKER_FILE } from "./install.js";
import { readZip, ZipFormatError } from "./unzip.js";

/**
 * skillhub-integration 节点侧安装面：temp 解压 → 逐文件 sha256/size 对照清单 →
 * 原子换入；任一不符整体不落盘 + integrity（AC-5/6）。installSkills 不 throw。
 * zip 由测试程序化构造（store 法；readZip 不查 CRC——sha256 对照才是信任层）。
 */

// ── 程序化 zip 构造器（store=0；CRC 置 0 合法：readZip 不校验 CRC） ──

type ZipSeed = { path: string; data: string; symlink?: boolean };

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function buildZip(seeds: ZipSeed[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const seed of seeds) {
    const nameBuf = Buffer.from(seed.path, "utf8");
    const dataBuf = Buffer.from(seed.data, "utf8");
    const crc = crc32(dataBuf);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 6); // flags
    lfh.writeUInt16LE(0, 8); // method: store
    lfh.writeUInt16LE(0, 10); // mod time
    lfh.writeUInt16LE(0x21, 12); // mod date (1996-01-01, 合法 DOS 日期)
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(dataBuf.length, 18);
    lfh.writeUInt32LE(dataBuf.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    locals.push(lfh, nameBuf, dataBuf);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    // versionMadeBy 高 16 = unix mode：symlink → S_IFLNK|0777，普通 → S_IFREG|0644
    const unixMode = seed.symlink ? 0o120777 : 0o100644;
    cd.writeUInt8(20, 4); // version made by: zip 2.0
    cd.writeUInt8(3, 5); // host system: unix（externalAttrs 高 16 位才有意义）
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(dataBuf.length, 20);
    cd.writeUInt32LE(dataBuf.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE((unixMode << 16) >>> 0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, nameBuf);
    offset += 30 + nameBuf.length + dataBuf.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(seeds.length, 8);
  eocd.writeUInt16LE(seeds.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

function sha256(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}

/** 由 seeds 生成清单（模拟 SkillHub files API 响应口径：无前缀路径 + sha256 + size）。 */
function manifestOf(seeds: ZipSeed[]): SkillFileManifestEntry[] {
  return seeds.map((s) => ({ path: s.path, sha256: sha256(s.data), size: Buffer.byteLength(s.data) }));
}

function makeCtx(): { ctx: AdapterContext; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-claude-i-"));
  const homeDir = path.join(root, "home");
  const cwd = path.join(root, "proj");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { ctx: { homeDir, cwd }, root };
}

function item(slug: string, version: string, zip: Uint8Array, files: SkillFileManifestEntry[]): SkillInstallItem {
  return { slug, version, zip, files };
}

const SKILL_MD = "---\nname: demo\n---\n# Demo skill\n";

// ── readZip 护栏（unzip 面单测） ──

test("readZip：store 法往返；穿越/绝对路径/symlink/垃圾字节诚实拒绝", () => {
  const ok = readZip(buildZip([{ path: "SKILL.md", data: SKILL_MD }]));
  assert.equal(ok.length, 1);
  assert.equal(ok[0]!.path, "SKILL.md");
  assert.equal(Buffer.from(ok[0]!.bytes).toString("utf8"), SKILL_MD);

  // 目录条目不产文件
  const withDir = readZip(buildZip([{ path: "sub/", data: "" }, { path: "sub/a.txt", data: "a" }]));
  assert.deepEqual(withDir.map((e) => e.path), ["sub/a.txt"]);

  for (const bad of ["../evil.md", "/abs.md", "a\\b.md", ".."]) {
    assert.throws(() => readZip(buildZip([{ path: bad, data: "x" }])), ZipFormatError, `reject ${bad}`);
  }
  assert.throws(() => readZip(buildZip([{ path: "link", data: "/etc/passwd", symlink: true }])), /symlink/);
  assert.throws(() => readZip(Buffer.from("this is not a zip at all")), /EOCD not found/);
});

// ── installSkills 主路径 ──

test("fresh install：目录 + SKILL.md + marker 落盘 ~/.claude/skills/<slug>；outcome installed", async () => {
  const { ctx } = makeCtx();
  const seeds: ZipSeed[] = [
    { path: "SKILL.md", data: SKILL_MD },
    { path: "scripts/run.sh", data: "#!/bin/sh\necho hi\n" },
  ];
  const out = await installSkills(ctx, {
    items: [item("demo-skill", "1.0.0", buildZip(seeds), manifestOf(seeds))],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.status, "installed");
  assert.equal(out[0]!.slug, "demo-skill");
  const dir = path.join(claudeSkillsRoot(ctx), "demo-skill");
  assert.equal(out[0]!.dir, dir);
  assert.equal(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"), SKILL_MD);
  assert.equal(fs.readFileSync(path.join(dir, "scripts", "run.sh"), "utf8"), "#!/bin/sh\necho hi\n");
  const marker = JSON.parse(fs.readFileSync(path.join(dir, SKILL_MARKER_FILE), "utf8"));
  assert.equal(marker.slug, "demo-skill");
  assert.equal(marker.version, "1.0.0");
  assert.equal(marker.source, "skillhub");
  assert.ok(typeof marker.installedAt === "string");
  // skills root 无 temp 残留
  assert.ok(!fs.readdirSync(claudeSkillsRoot(ctx)).some((n) => n.includes(".tmp-")));
});

test("幂等：同 slug@version 二装 → skipped，不动盘（AC-5）；版本变化 → 内容替换 + marker 更新", async () => {
  const { ctx } = makeCtx();
  const v1: ZipSeed[] = [{ path: "SKILL.md", data: SKILL_MD }];
  const first = await installSkills(ctx, { items: [item("demo", "1.0.0", buildZip(v1), manifestOf(v1))] });
  assert.equal(first[0]!.status, "installed");
  const dir = path.join(claudeSkillsRoot(ctx), "demo");
  const mtime = fs.statSync(path.join(dir, "SKILL.md")).mtimeMs;

  const again = await installSkills(ctx, { items: [item("demo", "1.0.0", buildZip(v1), manifestOf(v1))] });
  assert.equal(again[0]!.status, "skipped");
  assert.equal(fs.statSync(path.join(dir, "SKILL.md")).mtimeMs, mtime, "skipped 不应重写文件");

  const v2: ZipSeed[] = [{ path: "SKILL.md", data: "# v2\n" }];
  const upgrade = await installSkills(ctx, { items: [item("demo", "2.0.0", buildZip(v2), manifestOf(v2))] });
  assert.equal(upgrade[0]!.status, "installed");
  assert.equal(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"), "# v2\n");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, SKILL_MARKER_FILE), "utf8")).version, "2.0.0");
  // 无 .old-* 残留
  assert.ok(!fs.readdirSync(claudeSkillsRoot(ctx)).some((n) => n.includes(".old-")));
});

test("清单带 <slug>/ 前缀（files API 另一口径）→ 归一后照常安装", async () => {
  const { ctx } = makeCtx();
  const seeds: ZipSeed[] = [{ path: "SKILL.md", data: SKILL_MD }];
  const prefixed = manifestOf(seeds).map((m) => ({ ...m, path: `demo/${m.path}` }));
  const out = await installSkills(ctx, { items: [item("demo", "1.0.0", buildZip(seeds), prefixed)] });
  assert.equal(out[0]!.status, "installed");
  assert.ok(fs.existsSync(path.join(claudeSkillsRoot(ctx), "demo", "SKILL.md")));
});

// ── 供应链护栏（AC-6：整体不落盘 + integrity，控制面不自动重试） ──

test("sha256 不符 → failed + integrity；目标目录不存在、无 temp 残留、同机其他 skill 不受扰", async () => {
  const { ctx } = makeCtx();
  // 先装一个无辜 bystander
  const bySeeds: ZipSeed[] = [{ path: "SKILL.md", data: "# bystander\n" }];
  await installSkills(ctx, { items: [item("bystander", "1.0.0", buildZip(bySeeds), manifestOf(bySeeds))] });

  const seeds: ZipSeed[] = [{ path: "SKILL.md", data: SKILL_MD }];
  const tampered = manifestOf(seeds).map((m) => ({ ...m, sha256: "f".repeat(64) }));
  const out = await installSkills(ctx, { items: [item("evil", "1.0.0", buildZip(seeds), tampered)] });
  assert.equal(out[0]!.status, "failed");
  assert.equal(out[0]!.integrity, true);
  assert.match(out[0]!.error ?? "", /sha256 mismatch/);
  assert.ok(!fs.existsSync(path.join(claudeSkillsRoot(ctx), "evil")), "整体不落盘");
  assert.ok(!fs.readdirSync(claudeSkillsRoot(ctx)).some((n) => n.includes(".tmp-")));
  assert.equal(fs.readFileSync(path.join(claudeSkillsRoot(ctx), "bystander", "SKILL.md"), "utf8"), "# bystander\n");
});

test("size 不符 / 清单外多文件 / 清单内缺文件 → failed + integrity（三类完整性偏差同判）", async () => {
  const { ctx } = makeCtx();
  const seeds: ZipSeed[] = [{ path: "SKILL.md", data: SKILL_MD }];

  const badSize = manifestOf(seeds).map((m) => ({ ...m, size: (m.size ?? 0) + 1 }));
  const o1 = await installSkills(ctx, { items: [item("a1", "1.0.0", buildZip(seeds), badSize)] });
  assert.equal(o1[0]!.status, "failed");
  assert.equal(o1[0]!.integrity, true);
  assert.match(o1[0]!.error ?? "", /size mismatch/);

  const extra: ZipSeed[] = [...seeds, { path: "sneaky.sh", data: "rm -rf /\n" }];
  const o2 = await installSkills(ctx, { items: [item("a2", "1.0.0", buildZip(extra), manifestOf(seeds))] });
  assert.equal(o2[0]!.status, "failed");
  assert.equal(o2[0]!.integrity, true);
  assert.match(o2[0]!.error ?? "", /unexpected file/);

  const missing = [...manifestOf(seeds), { path: "docs/extra.md", sha256: "a".repeat(64), size: 3 }];
  const o3 = await installSkills(ctx, { items: [item("a3", "1.0.0", buildZip(seeds), missing)] });
  assert.equal(o3[0]!.status, "failed");
  assert.equal(o3[0]!.integrity, true);
  assert.match(o3[0]!.error ?? "", /missing from zip/);

  for (const slug of ["a1", "a2", "a3"]) {
    assert.ok(!fs.existsSync(path.join(claudeSkillsRoot(ctx), slug)), `${slug} 不落盘`);
  }
});

test("zip 缺 SKILL.md（非 Claude skill 包）→ failed（非 integrity：内容问题非篡改信号）", async () => {
  const { ctx } = makeCtx();
  const seeds: ZipSeed[] = [{ path: "README.md", data: "# nope\n" }];
  const out = await installSkills(ctx, { items: [item("notskill", "1.0.0", buildZip(seeds), manifestOf(seeds))] });
  assert.equal(out[0]!.status, "failed");
  assert.equal(out[0]!.integrity, undefined);
  assert.match(out[0]!.error ?? "", /missing SKILL\.md/);
});

test("危险 slug / 垃圾 zip / 穿越条目 → failed，不 throw（installSkills 契约：永不外抛）", async () => {
  const { ctx } = makeCtx();
  const seeds: ZipSeed[] = [{ path: "SKILL.md", data: SKILL_MD }];
  const zip = buildZip(seeds);
  const manifest = manifestOf(seeds);

  const out = await installSkills(ctx, {
    items: [
      item("../escape", "1.0.0", zip, manifest),
      item(".hidden", "1.0.0", zip, manifest),
      item("ok slug!", "1.0.0", zip, manifest),
      item("garbage", "1.0.0", Buffer.from("not a zip"), manifest),
    ],
  });
  assert.equal(out.length, 4);
  for (const o of out) {
    assert.equal(o.status, "failed");
    assert.ok(o.error, "failed 必带诚实原因");
  }
  assert.match(out[0]!.error ?? "", /unsafe slug/);
  assert.match(out[1]!.error ?? "", /unsafe slug/);
  assert.match(out[3]!.error ?? "", /not a zip/);
  const root = claudeSkillsRoot(ctx);
  assert.ok(!fs.existsSync(root) || fs.readdirSync(root).length === 0, "全部拒绝 → 不落盘任何东西");
});

test("逐 item 独立成败：坏包不拖累好包（AC-6）", async () => {
  const { ctx } = makeCtx();
  const good: ZipSeed[] = [{ path: "SKILL.md", data: SKILL_MD }];
  const out = await installSkills(ctx, {
    items: [
      item("bad", "1.0.0", buildZip(good), manifestOf(good).map((m) => ({ ...m, sha256: "0".repeat(64) }))),
      item("good", "1.0.0", buildZip(good), manifestOf(good)),
    ],
  });
  assert.equal(out[0]!.status, "failed");
  assert.equal(out[1]!.status, "installed");
  assert.ok(fs.existsSync(path.join(claudeSkillsRoot(ctx), "good", "SKILL.md")));
});

test("装好即被发现：discover 扫描 ~/.claude/skills 与安装目录同口径（name=slug 收敛 keep）", async () => {
  const { ctx } = makeCtx();
  const seeds: ZipSeed[] = [{ path: "SKILL.md", data: SKILL_MD }];
  await installSkills(ctx, { items: [item("hub-skill", "1.0.0", buildZip(seeds), manifestOf(seeds))] });
  const { discoverClaudeCodeConfig } = await import("./index.js");
  const agent = discoverClaudeCodeConfig(ctx);
  assert.ok(agent);
  assert.ok(agent!.skills.includes("hub-skill"), "安装目录名=slug → discover 名单自然收敛");
});
