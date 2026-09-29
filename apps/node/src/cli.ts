#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PKG_VERSION, controlPlaneBaseUrl, jsonHealth } from "@agentoryhq/shared";
import { applyPendingAligns, fulfillPendingTranscripts, heartbeat, registerNode, reportAssetIndex, reportDiscovery } from "./client.js";
import { discoverAssetIndex } from "./asset-index.js";
import { discoverAgents } from "./discover.js";
import { runDaemon } from "./daemon.js";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
}

export async function runCli(argv: string[]): Promise<number> {
  const cmd = argv[2] ?? "version";
  if (cmd === "version" || cmd === "-v" || cmd === "--version") {
    const body = jsonHealth("node");
    console.log(`${body.service} ${PKG_VERSION}`);
    return 0;
  }
  if (cmd === "ping") {
    const base = controlPlaneBaseUrl();
    try {
      const res = await fetch(`${base}/health`);
      const text = await res.text();
      console.log(res.status, text);
      return res.ok ? 0 : 1;
    } catch (err) {
      console.error(`unreachable ${base}:`, err instanceof Error ? err.message : err);
      return 2;
    }
  }
  if (cmd === "register") {
    const token = flag(argv, "--token") ?? process.env.AGENTORY_NODE_ROOT_TOKEN;
    if (!token) {
      console.error("usage: agentory-node register --token <node_root_token>");
      return 2;
    }
    const name = flag(argv, "--name") ?? "local";
    return registerNode(token, name);
  }
  if (cmd === "heartbeat") return heartbeat();
  if (cmd === "discover") {
    if (argv.includes("--dry-run")) {
      console.log(JSON.stringify({ agents: discoverAgents() }, null, 2));
      return 0;
    }
    return reportDiscovery();
  }
  if (cmd === "asset-index") {
    if (argv.includes("--dry-run")) {
      console.log(JSON.stringify(discoverAssetIndex(), null, 2));
      return 0;
    }
    return reportAssetIndex();
  }
  if (cmd === "align") {
    return applyPendingAligns();
  }
  if (cmd === "transcript") {
    return fulfillPendingTranscripts();
  }
  if (cmd === "daemon") {
    return runDaemon({ once: argv.includes("--once") });
  }
  console.error("usage: agentory-node <version|ping|register|heartbeat|discover|asset-index|align|transcript|daemon [--once]>");
  return 2;
}

const thisFile = fileURLToPath(import.meta.url);
function isCliEntry(argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    const resolved = fileURLToPath(pathToFileURL(path.resolve(argv1)));
    if (resolved === thisFile) return true;
  } catch {
    /* ignore */
  }
  const base = path.basename(argv1);
  return base === "agentory-node" || base === "agentory-node.js";
}
if (isCliEntry(process.argv[1])) {
  runCli(process.argv).then((code) => process.exit(code));
}
