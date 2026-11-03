import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  AdapterContext,
  InstallSkillsOpts,
  SkillInstallItem,
  SkillInstallOutcome,
} from "@agentoryhq/runtime-contract";
import { readZip, ZipFormatError } from "./unzip.js";

/**
 * Claude Code skill 本体安装（skillhub-integration · 一期唯一装本体的 runtime；
 * cursor 维持名单 tracking 诚实边界）。落盘 `~/.claude/skills/<slug>/`——与
 * discover.ts 扫描目录同口径，装好即被本机发现、align diff 自然收敛 keep。
 *
 * 供应链纪律（brief §6 缓解③）：先解压到同盘 temp → 逐文件 sha256 对照清单 →
 * 全部通过才原子换入目标目录；任一不符 = 整体不落盘 + integrity 标记
 * （控制面不自动重试）。同 slug@version 已装且校验痕迹在 → skipped（幂等）。
 */

export const SKILL_MARKER_FILE = ".agentory-skillhub.json";
const SLUG_SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

class IntegrityError extends Error {}

export type SkillInstallMarker = {
  slug: string;
  version: string;
  source: "skillhub";
  installedAt: string;
};

export function claudeSkillsRoot(ctx: AdapterContext): string {
  return path.join(ctx.homeDir, ".claude", "skills");
}

function readMarker(file: string): SkillInstallMarker | undefined {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof o.slug !== "string" || typeof o.version !== "string") return undefined;
    return o as unknown as SkillInstallMarker;
  } catch {
    return undefined;
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 清单路径归一：files API 可能带 `<slug>/` 前缀，zip 内不带——统一去前缀比对。 */
function normalizeManifestPaths(files: SkillInstallItem["files"], slug: string): Map<string, { size?: number; sha256?: string }> {
  const prefix = `${slug}/`;
  const allPrefixed = files.length > 0 && files.every((f) => f.path.startsWith(prefix));
  const out = new Map<string, { size?: number; sha256?: string }>();
  for (const f of files) {
    const p = allPrefixed ? f.path.slice(prefix.length) : f.path;
    if (p && !p.endsWith("/")) out.set(p, { size: f.size, sha256: f.sha256 });
  }
  return out;
}

function installOne(ctx: AdapterContext, item: SkillInstallItem): SkillInstallOutcome {
  const base = { slug: item.slug, version: item.version };
  try {
    if (!SLUG_SAFE_RE.test(item.slug) || item.slug.includes("..")) {
      return { ...base, status: "failed", error: `unsafe slug: ${item.slug}` };
    }
    const root = claudeSkillsRoot(ctx);
    const dir = path.join(root, item.slug);
    const markerPath = path.join(dir, SKILL_MARKER_FILE);

    // 幂等：同版本已装 + SKILL.md 在 → skipped（AC-5 幂等口径）
    const marker = readMarker(markerPath);
    if (
      marker &&
      marker.slug === item.slug &&
      marker.version === item.version &&
      fs.existsSync(path.join(dir, "SKILL.md"))
    ) {
      return { ...base, status: "skipped", dir };
    }

    const entries = readZip(item.zip);
    if (!entries.some((e) => e.path === "SKILL.md")) {
      return { ...base, status: "failed", error: "zip missing SKILL.md (not a Claude skill package)" };
    }
    const manifest = normalizeManifestPaths(item.files, item.slug);
    const seen = new Set<string>();
    for (const entry of entries) {
      seen.add(entry.path);
      const mf = manifest.get(entry.path);
      if (!mf) {
        throw new IntegrityError(`unexpected file not in manifest: ${entry.path}`);
      }
      if (mf.sha256) {
        const actual = sha256Hex(entry.bytes);
        if (actual !== mf.sha256.toLowerCase()) {
          throw new IntegrityError(`sha256 mismatch for ${entry.path}`);
        }
      }
      if (mf.size !== undefined && mf.size >= 0 && mf.size !== entry.bytes.byteLength) {
        throw new IntegrityError(`size mismatch for ${entry.path}`);
      }
    }
    for (const p of manifest.keys()) {
      if (!seen.has(p)) throw new IntegrityError(`manifest file missing from zip: ${p}`);
    }

    // 同盘 temp 解压 → 校验已毕 → 原子换入（先移旧再 rename；失败回滚旧目录）
    fs.mkdirSync(root, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(root, `.${item.slug}.tmp-`));
    try {
      for (const entry of entries) {
        const dest = path.join(tmp, entry.path); // readZip 已拒穿越/绝对路径
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, entry.bytes, { mode: 0o644 });
      }
      const markerBody: SkillInstallMarker = {
        slug: item.slug,
        version: item.version,
        source: "skillhub",
        installedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(tmp, SKILL_MARKER_FILE),
        `${JSON.stringify(markerBody, null, 2)}\n`,
        "utf8",
      );
      let old: string | undefined;
      if (fs.existsSync(dir)) {
        old = `${dir}.old-${Date.now()}-${process.pid}`;
        fs.renameSync(dir, old);
      }
      try {
        fs.renameSync(tmp, dir);
      } catch (err) {
        if (old) fs.renameSync(old, dir); // 换入失败：旧版本复位，机器上不留半装状态
        throw err;
      }
      if (old) fs.rmSync(old, { recursive: true, force: true });
      return { ...base, status: "installed", dir };
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true }); // 残留清理（AC-6：不落半装）
      throw err;
    }
  } catch (err) {
    const integrity = err instanceof IntegrityError;
    const message =
      err instanceof ZipFormatError || err instanceof IntegrityError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      ...base,
      status: "failed",
      error: message,
      ...(integrity ? { integrity: true } : {}),
    };
  }
}

/** 逐 item 独立成败（AC-6）；实现不 throw——失败收敛为 failed outcome。 */
export async function installSkills(
  ctx: AdapterContext,
  opts: InstallSkillsOpts,
): Promise<SkillInstallOutcome[]> {
  const out: SkillInstallOutcome[] = [];
  // 逐 item 独立成败，单 item 崩溃不外溢；temp 目录建在 skills root 同盘
  // （不用 os.tmpdir：跨盘 rename 会 EXDEV）。
  for (const item of opts.items) {
    out.push(installOne(ctx, item));
  }
  return out;
}
