import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  detectCursorBridge,
  installCursorBridge,
  type CursorBridgeStatus,
  type InstallResult,
} from "@agentoryhq/adapter-cursor";

/**
 * daemon 侧的 Cursor 桥「自动接入」：检测 → 需要时装（补丁+扩展）→ 重载 Cursor。
 *
 * 开关：AGENTORY_CURSOR_BRIDGE_AUTO=1（默认关）。只在 macOS + Cursor 版本兼容时动作；
 * 版本漂移/权限不足 → 诚实跳过或报错，绝不静默破坏。重载受 AGENTORY_CURSOR_BRIDGE_RELOAD=0 可关。
 *
 * 纯 outbound 纪律不变：本模块只做本机文件/命令，不上报正文；日志只回状态与计数。
 */

export function isCursorBridgeAutoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.AGENTORY_CURSOR_BRIDGE_AUTO?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function reloadDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.AGENTORY_CURSOR_BRIDGE_RELOAD?.trim().toLowerCase();
  return v === "0" || v === "false" || v === "no";
}

/** 定位扩展源码：env → 打包内 `bridge-extension` → 仓库 `spikes/cursor-bridge`。 */
export function resolveBridgeExtensionDir(): string | undefined {
  const candidates: string[] = [];
  const env = process.env.AGENTORY_CURSOR_BRIDGE_EXT?.trim();
  if (env) candidates.push(env);
  const here = path.dirname(fileURLToPath(import.meta.url));
  candidates.push(path.join(here, "..", "bridge-extension"));
  for (const seed of [process.cwd(), here]) {
    let dir = seed;
    for (let i = 0; i < 8; i++) {
      candidates.push(path.join(dir, "spikes", "cursor-bridge"));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, "extension.js")) && fs.existsSync(path.join(dir, "package.json"))) {
        return dir;
      }
    } catch {
      /* next */
    }
  }
  return undefined;
}

export type RunResult = { status: number | null; stdout: string; stderr: string };
export type RunFn = (cmd: string, args: string[]) => RunResult;

/** 优雅退出再启动 Cursor（让补丁/扩展生效）。macOS only。 */
export function makeReloadCursor(deps: { platform?: NodeJS.Platform; run?: RunFn } = {}) {
  const platform = deps.platform ?? process.platform;
  const run: RunFn =
    deps.run ??
    ((cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: "utf8" });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    });
  return (): { ok: boolean; detail: string } => {
    if (platform !== "darwin") return { ok: false, detail: "reload 仅支持 macOS" };
    const q = run("osascript", ["-e", 'tell application "Cursor" to quit']);
    const o = run("open", ["-a", "Cursor"]);
    return { ok: o.status === 0, detail: `quit=${q.status ?? "?"} open=${o.status ?? "?"}` };
  };
}

export type EnsureDeps = {
  enabled: boolean;
  reloadEnabled?: boolean;
  detect: () => CursorBridgeStatus;
  install: () => InstallResult;
  reload: () => { ok: boolean; detail: string };
};

export type EnsureReport = {
  acted: boolean;
  ok: boolean;
  action: "disabled" | "skipped" | "already" | "installed" | "install_failed";
  reasons: string[];
  reloaded?: boolean;
  reloadDetail?: string;
  steps?: string[];
};

export function ensureCursorBridgeAuto(deps: EnsureDeps): EnsureReport {
  if (!deps.enabled) return { acted: false, ok: true, action: "disabled", reasons: [] };

  const st = deps.detect();
  if (!st.ok) {
    return { acted: false, ok: false, action: "skipped", reasons: st.reasons.length ? st.reasons : ["不满足接入条件"] };
  }
  if (st.extensionInstalled && st.bundlePatched) {
    return { acted: false, ok: true, action: "already", reasons: [] };
  }

  const res = deps.install();
  if (!res.ok) {
    return { acted: true, ok: false, action: "install_failed", reasons: [res.error ?? "install failed"], steps: res.steps };
  }
  const report: EnsureReport = { acted: true, ok: true, action: "installed", reasons: [], steps: res.steps };
  if (deps.reloadEnabled !== false) {
    const rl = deps.reload();
    report.reloaded = rl.ok;
    report.reloadDetail = rl.detail;
  }
  return report;
}

let attemptedThisProcess = false;

/**
 * daemon 通道入口：按 env 开关自动接入。返回 0=已处理/跳过，非 0=接入失败。
 * 单进程只尝试安装一次（失败不刷屏；版本漂移等需人工介入）。
 */
export async function autoInstallCursorBridge(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!isCursorBridgeAutoEnabled(env)) return 0;

  const report = ensureCursorBridgeAuto({
    enabled: true,
    reloadEnabled: !reloadDisabled(env),
    detect: () => detectCursorBridge({}),
    install: () => {
      if (attemptedThisProcess) {
        return { ok: false, steps: [], error: "本进程已尝试过，跳过重试" };
      }
      attemptedThisProcess = true;
      const extensionSourceDir = resolveBridgeExtensionDir();
      return installCursorBridge(extensionSourceDir ? { extensionSourceDir } : {});
    },
    reload: makeReloadCursor(),
  });

  // 只回状态（不落正文）
  console.log(
    JSON.stringify({
      channel: "cursor-bridge-auto",
      action: report.action,
      ok: report.ok,
      reloaded: report.reloaded ?? false,
      reasons: report.reasons,
    }),
  );
  return report.ok ? 0 : 1;
}
