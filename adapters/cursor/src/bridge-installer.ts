import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_DESKTOP_BUNDLE,
  SUBMIT_SENTINEL,
  applyBundlePatch,
  isBundlePatched,
  locateAnchor,
  revertBundlePatch,
  statusBundlePatch,
} from "./patch-bundle.js";

/**
 * Cursor IDE 桥（方案 A · B 全自动）的安装器：检测 / 安装 / 卸载。
 *
 * 产物两部分：
 *   1) Cursor 扩展（agentory.cursor-bridge）——打包成 .vsix 后 `cursor --install-extension`
 *   2) workbench.desktop.main.js 补丁（自动提交 + 正文回传）——备份/还原见 patch-bundle
 *
 * 路径与命令均可注入（`BridgeInstallerDeps`），便于在无 Cursor 的环境做单元测试。
 */

export const CURSOR_BRIDGE_EXTENSION_ID = "agentory.cursor-bridge";

export type RunResult = { status: number | null; stdout: string; stderr: string };
export type RunFn = (cmd: string, args: string[], opts?: { cwd?: string }) => RunResult;

export type BridgeInstallerDeps = {
  platform?: NodeJS.Platform;
  /** /Applications/Cursor.app */
  cursorAppRoot?: string;
  bundlePath?: string;
  /** Cursor CLI：.../Contents/Resources/app/bin/cursor */
  cursorCli?: string;
  /** 扩展预装目录（~/.cursor/extensions） */
  extensionsDir?: string;
  /** 扩展源码目录（含 package.json + extension.js） */
  extensionSourceDir?: string;
  extensionId?: string;
  run?: RunFn;
  /** 打包 vsix；缺省用系统 zip（mac）。测试可注入。 */
  buildVsix?: (srcDir: string, outVsix: string) => void;
  tmpDir?: () => string;
};

export type CursorBridgeStatus = {
  ok: boolean;
  platform: string;
  cursorApp?: string;
  cursorVersion?: string;
  cursorCli?: string;
  extensionId: string;
  extensionInstalled: boolean;
  bundlePath?: string;
  bundlePatched: boolean;
  /** 补丁是否可打：已打补丁或能定位 anchor（否则 = 版本漂移，拒绝） */
  compatible: boolean;
  reasons: string[];
};

function parseSemver(v: string | undefined): [number, number, number] | undefined {
  if (!v) return undefined;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Cursor ≥3.11 使用 glass/desktop 双 bundle + 该命令面；低于则不保证。 */
export const MIN_CURSOR_VERSION = "3.11.0";

function semverGte(a: string | undefined, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return true;
}

function defaultAppRoot(platform: NodeJS.Platform): string | undefined {
  if (platform === "darwin") return "/Applications/Cursor.app";
  return undefined; // Linux/Windows 路径不一期硬化，交给 deps 覆盖
}

function defaultExtensionsDir(): string {
  return path.join(os.homedir(), ".cursor", "extensions");
}

function readCursorVersion(appRoot: string): string | undefined {
  const candidates = [
    path.join(appRoot, "Contents", "Resources", "app", "package.json"),
    path.join(appRoot, "resources", "app", "package.json"),
  ];
  for (const file of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      /* next */
    }
  }
  return undefined;
}

function findCursorCli(appRoot: string | undefined): string | undefined {
  if (!appRoot) return undefined;
  const candidates = [
    path.join(appRoot, "Contents", "Resources", "app", "bin", "cursor"),
    path.join(appRoot, "resources", "app", "bin", "cursor"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* next */
    }
  }
  return undefined;
}

function extensionInstalledIn(extensionsDir: string, id: string): boolean {
  const short = id.split(".").pop() ?? id;
  try {
    return fs
      .readdirSync(extensionsDir)
      .some((name) => name.startsWith(`${id}-`) || name.startsWith(`${short}-`) || name === id || name === short);
  } catch {
    return false;
  }
}

function resolve(deps: BridgeInstallerDeps) {
  const platform = deps.platform ?? process.platform;
  const cursorApp = deps.cursorAppRoot ?? defaultAppRoot(platform);
  const bundlePath = deps.bundlePath ?? DEFAULT_DESKTOP_BUNDLE;
  const cursorCli = deps.cursorCli ?? findCursorCli(cursorApp);
  const extensionsDir = deps.extensionsDir ?? defaultExtensionsDir();
  const extensionId = deps.extensionId ?? CURSOR_BRIDGE_EXTENSION_ID;
  const extensionSourceDir = deps.extensionSourceDir;
  return { platform, cursorApp, bundlePath, cursorCli, extensionsDir, extensionId, extensionSourceDir };
}

export function detectCursorBridge(deps: BridgeInstallerDeps = {}): CursorBridgeStatus {
  const { platform, cursorApp, bundlePath, cursorCli, extensionsDir, extensionId } = resolve(deps);
  const reasons: string[] = [];

  const cursorVersion = cursorApp ? readCursorVersion(cursorApp) : undefined;
  if (!cursorApp) reasons.push("未找到 Cursor.app（非 macOS 或自定义安装路径）");
  else if (!cursorVersion) reasons.push("无法读取 Cursor 版本");
  else if (!semverGte(cursorVersion, MIN_CURSOR_VERSION)) {
    reasons.push(`Cursor ${cursorVersion} 低于支持下限 ${MIN_CURSOR_VERSION}`);
  }

  let bundlePatched = false;
  let compatible = false;
  let bundleReadable = false;
  try {
    const st = statusBundlePatch(bundlePath);
    bundlePatched = st.patched;
    const bundle = fs.readFileSync(bundlePath, "utf8");
    bundleReadable = true;
    compatible = bundlePatched || locateAnchor(bundle).ok;
    if (!compatible) reasons.push("bundle 结构与已知版本不符（升级后需重新适配）");
  } catch {
    reasons.push("无法读取 workbench.desktop.main.js");
  }

  const extensionInstalled = extensionInstalledIn(extensionsDir, extensionId);
  if (!cursorCli) reasons.push("未找到 cursor CLI（扩展需手动安装）");

  return {
    ok: Boolean(cursorApp && cursorVersion && semverGte(cursorVersion, MIN_CURSOR_VERSION) && compatible),
    platform,
    ...(cursorApp ? { cursorApp } : {}),
    ...(cursorVersion ? { cursorVersion } : {}),
    ...(cursorCli ? { cursorCli } : {}),
    extensionId,
    extensionInstalled,
    ...(bundleReadable ? { bundlePath } : {}),
    bundlePatched,
    compatible,
    reasons,
  };
}

export type InstallResult = {
  ok: boolean;
  steps: string[];
  error?: string;
  status?: CursorBridgeStatus;
};

function defaultRun(cmd: string, args: string[], opts?: { cwd?: string }): RunResult {
  const r = spawnSync(cmd, args, { cwd: opts?.cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function defaultBuildVsix(srcDir: string, outVsix: string): void {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "agentory-vsix-"));
  try {
    const ext = path.join(stage, "extension");
    fs.mkdirSync(ext, { recursive: true });
    for (const file of ["package.json", "extension.js"]) {
      fs.copyFileSync(path.join(srcDir, file), path.join(ext, file));
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(srcDir, "package.json"), "utf8")) as {
      version?: string;
      publisher?: string;
      name?: string;
      displayName?: string;
      description?: string;
    };
    fs.writeFileSync(
      path.join(stage, "[Content_Types].xml"),
      `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
</Types>`,
    );
    fs.writeFileSync(
      path.join(stage, "extension.vsixmanifest"),
      `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name ?? "cursor-bridge"}" Version="${pkg.version ?? "0.0.1"}" Publisher="${pkg.publisher ?? "agentory"}"/>
    <DisplayName>${pkg.displayName ?? "Agentory Cursor Bridge"}</DisplayName>
    <Description xml:space="preserve">${pkg.description ?? ""}</Description>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json"/>
  </Assets>
</PackageManifest>`,
    );
    const r = spawnSync("zip", ["-qr", outVsix, "."], { cwd: stage, encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`zip 打包失败: ${r.stderr || r.status}`);
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

export function installCursorBridge(deps: BridgeInstallerDeps = {}): InstallResult {
  const { bundlePath, cursorCli, extensionSourceDir, extensionId } = resolve(deps);
  const run = deps.run ?? defaultRun;
  const buildVsix = deps.buildVsix ?? defaultBuildVsix;
  const steps: string[] = [];

  if (!extensionSourceDir) {
    return { ok: false, steps, error: "缺少扩展源码目录（extensionSourceDir）" };
  }

  // 先打补丁（可逆）。失败（版本漂移）立即中止，避免装了扩展却不工作。
  const patched = applyBundlePatch(bundlePath);
  if (!patched.ok) {
    return { ok: false, steps, error: patched.reason ?? "bundle 补丁失败（版本漂移）" };
  }
  steps.push(`patched ${bundlePath} (backup: ${patched.backup ?? "已有"})`);

  // 打包 vsix
  const tmp = (deps.tmpDir ?? (() => fs.mkdtempSync(path.join(os.tmpdir(), "agentory-bridge-inst-"))))();
  const vsix = path.join(tmp, `${extensionId}-bridge.vsix`);
  try {
    buildVsix(extensionSourceDir, vsix);
    steps.push(`built ${vsix}`);
  } catch (e) {
    return { ok: false, steps, error: e instanceof Error ? e.message : String(e) };
  }

  // 安装扩展
  if (!cursorCli) {
    steps.push("skip: cursor CLI 未找到，请手动安装 vsix");
    return {
      ok: false,
      steps,
      error: `未找到 cursor CLI；请手动安装：Cursor → Extensions → … → Install from VSIX → ${vsix}`,
      status: detectCursorBridge(deps),
    };
  }
  const ins = run(cursorCli, ["--install-extension", vsix, "--force"]);
  steps.push(`cursor --install-extension → exit ${ins.status}`);
  if (ins.status !== 0) {
    return { ok: false, steps, error: `扩展安装失败: ${ins.stderr || ins.stdout}` };
  }

  return { ok: true, steps, status: detectCursorBridge(deps) };
}

export function uninstallCursorBridge(deps: BridgeInstallerDeps = {}): InstallResult {
  const { bundlePath, cursorCli, extensionId } = resolve(deps);
  const run = deps.run ?? defaultRun;
  const steps: string[] = [];

  if (cursorCli) {
    const rm = run(cursorCli, ["--uninstall-extension", extensionId]);
    steps.push(`cursor --uninstall-extension ${extensionId} → exit ${rm.status}`);
  } else {
    steps.push("skip: cursor CLI 未找到，请在 Cursor 里手动停用/卸载扩展");
  }

  const reverted = revertBundlePatch(bundlePath);
  steps.push(reverted.ok ? `reverted ${bundlePath}` : `revert: ${reverted.reason}`);
  return { ok: reverted.ok, steps, status: detectCursorBridge(deps), ...(reverted.ok ? {} : { error: reverted.reason }) };
}

/** 供 CLI/诊断：bundle 是否含本产品哨兵（用于判断补丁是否来自我们）。 */
export function bundleHasOurPatch(bundlePath: string = DEFAULT_DESKTOP_BUNDLE): boolean {
  try {
    return isBundlePatched(fs.readFileSync(bundlePath, "utf8")) || fs.readFileSync(bundlePath, "utf8").includes(SUBMIT_SENTINEL);
  } catch {
    return false;
  }
}
