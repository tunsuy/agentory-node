import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { controlPlaneBaseUrl } from "@agentoryhq/shared";
import { applyPendingAligns, fulfillPendingTranscripts, heartbeat, loadState, reportAssetIndex, reportDiscovery } from "./client.js";
import { discoverAssetIndex } from "./asset-index.js";

/**
 * Resident daemon: periodic heartbeat (+ align pull), asset-index report
 * (sha-deduped), discovery report. Pure outbound — the control plane never
 * reaches back into the node (invariants §4/§5).
 */

export type DaemonIntervals = {
  heartbeatSec: number;
  indexSec: number;
  discoverSec: number;
};

export type DaemonOpts = {
  intervals?: Partial<DaemonIntervals>;
  /** Run every channel once, then exit 0 (cron / testing entry). */
  once?: boolean;
  /** 测试注入：可控时钟与睡眠。 */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signalHandlers?: NodeJS.Signals[];
  /** 提早注入信号（测试）。 */
  registerSignal?: (onSignal: (sig: NodeJS.Signals) => void) => void;
};

const MIN_INTERVAL_SEC = 5;
const DEFAULTS: DaemonIntervals = {
  heartbeatSec: 60,
  indexSec: 600,
  discoverSec: 3600,
};

type Channel = "heartbeat" | "align" | "asset-index" | "discover" | "transcript";

function logLine(stream: (s: string) => void, channel: string, status: string, detail?: Record<string, unknown>) {
  stream(JSON.stringify({ ts: new Date().toISOString(), channel, status, ...detail }));
}

/** Env override with hard clamp to MIN_INTERVAL_SEC (AC-6). */
export function parseIntervalSec(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= MIN_INTERVAL_SEC) return Math.floor(parsed);
  if (!Number.isFinite(parsed) || parsed !== MIN_INTERVAL_SEC) {
    // 只对真被钳制的值打日志（含 0/负数/非数字；不重复日志 0 会被钳到 5）
    logLine(console.error, "daemon", "clamped", { message: `${envName}=${raw} clamped to ${MIN_INTERVAL_SEC}sec` });
  }
  return MIN_INTERVAL_SEC;
}

export function resolveIntervals(): DaemonIntervals {
  return {
    heartbeatSec: parseIntervalSec("AGENTORY_DAEMON_HEARTBEAT_SEC", DEFAULTS.heartbeatSec),
    indexSec: parseIntervalSec("AGENTORY_DAEMON_INDEX_SEC", DEFAULTS.indexSec),
    discoverSec: parseIntervalSec("AGENTORY_DAEMON_DISCOVER_SEC", DEFAULTS.discoverSec),
  };
}

/** 0–10% of the period of jitter, so a fleet of nodes doesn't fire in unison. */
export function jitterMs(periodSec: number, rand: () => number = Math.random): number {
  return Math.floor(rand() * 0.1 * periodSec * 1000);
}

export function assetIndexSha(index: unknown): string {
  return createHash("sha256").update(JSON.stringify(index)).digest("hex");
}

/** Daemon-owned state (last reported index sha), persisted next to node.json. */
type DaemonState = { lastIndexSha?: string };

function daemonStateFile(): string {
  return process.env.AGENTORY_NODE_STATE
    ? path.join(path.dirname(process.env.AGENTORY_NODE_STATE), "daemon-state.json")
    : path.join(os.homedir(), ".agentory", "daemon-state.json");
}

function loadDaemonState(): DaemonState {
  try {
    const raw = JSON.parse(fs.readFileSync(daemonStateFile(), "utf8")) as DaemonState;
    if (raw && typeof raw === "object") return raw;
  } catch {
    /* fresh start */
  }
  return {};
}

function saveDaemonState(state: DaemonState): void {
  const file = daemonStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
}

const daemonState: DaemonState = loadDaemonState();

/** Report the index only when its content hash changed since last report (AC-3). */
export async function reportAssetIndexIfChanged(): Promise<number> {
  const sha = assetIndexSha(discoverAssetIndex());
  if (daemonState.lastIndexSha === sha) {
    logLine(console.log, "asset-index", "unchanged, skip", { sha: sha.slice(0, 12) });
    return 0;
  }
  const code = await reportAssetIndex();
  if (code === 0) {
    daemonState.lastIndexSha = sha;
    saveDaemonState(daemonState);
  }
  return code;
}

let heartbeatFailures = 0;

async function runChannel(
  name: Channel,
  fn: () => Promise<number>,
  onExit?: (code: number) => void,
): Promise<void> {
  try {
    const code = await fn();
    if (name === "heartbeat") {
      heartbeatFailures = code === 0 ? 0 : heartbeatFailures + 1;
      if (heartbeatFailures >= 3) {
        logLine(console.error, "daemon", "heartbeat failing", { consecutiveFailures: heartbeatFailures });
      }
    }
    logLine(console.log, name, code === 0 ? "ok" : "error", code === 0 ? undefined : { exit: code });
    if (code !== 0 && onExit) onExit(code);
  } catch (err) {
    // 单轮失败不退进程（AC-4）——结构化错误行，继续下一个通道/下一轮。
    logLine(console.error, name, "error", { error: err instanceof Error ? err.message : String(err), base: controlPlaneBaseUrl() });
    if (onExit) onExit(1);
  }
}

/** One full round: all channels (--once 与首轮同语义，AC-1）。失败通道 → 非 0。 */
export async function runFullRound(): Promise<number> {
  let code = 0;
  await runChannel("heartbeat", heartbeat, (c) => {
    if (c !== 0) code = c;
  });
  await runChannel("align", applyPendingAligns, (c) => {
    if (c !== 0) code = c;
  });
  await runChannel("asset-index", reportAssetIndexIfChanged, (c) => {
    if (c !== 0) code = c;
  });
  await runChannel("transcript", fulfillPendingTranscripts, (c) => {
    if (c !== 0) code = c;
  });
  await runChannel("discover", reportDiscovery, (c) => {
    if (c !== 0) code = c;
  });
  return code;
}

export async function runDaemon(opts: DaemonOpts = {}): Promise<number> {
  const st = loadState();
  if (!st) {
    console.error("not registered; run: agentory-node register --token <root>");
    return 2;
  }
  const intervals = { ...resolveIntervals(), ...(opts.intervals ?? {}) };
  logLine(console.log, "daemon", "start", {
    nodeId: st.nodeId,
    heartbeatSec: intervals.heartbeatSec,
    indexSec: intervals.indexSec,
    discoverSec: intervals.discoverSec,
    once: !!opts.once,
  });

  if (opts.once) {
    // 第一轮前先探活：控制面不可达时 --once 应失败退出非 0（AC-4），
    // 常驻模式则靠 runChannel 的容错继续重试。
    try {
      const res = await fetch(`${controlPlaneBaseUrl()}/health`);
      if (!res.ok) {
        logLine(console.error, "daemon", "unreachable", { base: controlPlaneBaseUrl(), status: res.status });
        return 1;
      }
    } catch (err) {
      logLine(console.error, "daemon", "unreachable", {
        base: controlPlaneBaseUrl(),
        error: err instanceof Error ? err.message : String(err),
      });
      return 1;
    }
    const code = await runFullRound();
    logLine(console.log, "daemon", "stop", { reason: "once" });
    return code;
  }

  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = opts.clock ?? (() => Date.now());
  const startedAt = clock();

  let stopping = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logLine(console.log, "daemon", "stopping", { signal: sig });
  };
  if (opts.registerSignal) {
    opts.registerSignal(onSignal);
  } else {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

  // Anti-flap jitter（防整点齐射）；进程收到信号时 jumping out。
  try {
    const j = jitterMs(intervals.heartbeatSec);
    if (j > 0) {
      logLine(console.log, "daemon", "jitter", { ms: j });
      await sleep(j);
    }
  } catch {
    /* sleep aborted（少见；继续） */
  }

  const nextDue: Record<"heartbeat" | "index" | "discover", number> = {
    heartbeat: startedAt + intervals.heartbeatSec * 1000,
    index: startedAt + intervals.indexSec * 1000,
    discover: startedAt + intervals.discoverSec * 1000,
  };

  while (!stopping) {
    const now = clock();

    if (now >= nextDue.heartbeat) {
      await runChannel("heartbeat", heartbeat);
      await runChannel("align", applyPendingAligns);
      await runChannel("transcript", fulfillPendingTranscripts);
      nextDue.heartbeat += intervals.heartbeatSec * 1000;
    }
    if (now >= nextDue.index) {
      await runChannel("asset-index", reportAssetIndexIfChanged);
      nextDue.index += intervals.indexSec * 1000;
    }
    if (now >= nextDue.discover) {
      await runChannel("discover", reportDiscovery);
      nextDue.discover += intervals.discoverSec * 1000;
    }

    // 睡到最近一个到期点（信号会被 stopping 吸收，醒来即退）。
    const wakeAt = Math.min(nextDue.heartbeat, nextDue.index, nextDue.discover);
    const ms = Math.max(0, wakeAt - clock());
    try {
      await ms > 0 ? sleep(ms) : sleep(0);
    } catch {
      /* sleep aborted */
    }
  }

  logLine(console.log, "daemon", "stop", { reason: "signal" });
  return 0;
}
