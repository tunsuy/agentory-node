import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdapterCapability } from "@agentoryhq/runtime-contract";
import { ADAPTER_API_VERSION, hasCapability } from "@agentoryhq/runtime-contract";
import { adapterForRuntime, builtinAdapters } from "./registry.js";

/**
 * capability ↔ 方法一致性（契约注释「Optional methods must match declared
 * capabilities」的机械闸）。声明了 capability 就必须有对应方法；实现了可选
 * 方法就必须声明对应 capability。
 */
const CAPABILITY_METHODS: Record<AdapterCapability, readonly string[]> = {
  detect: ["detect"],
  discoverConfig: ["discoverConfig"],
  applyAlign: ["applyAlign"],
  indexSessions: ["indexSessions"],
  readTranscript: ["transcriptFileForSourceKey", "captureTranscriptSnapshot"],
  /** 控制面侧导出（handoff snapshot），无 adapter 方法。 */
  handoffExport: [],
  invoke: ["invoke"],
};

const METHOD_CAPABILITY: Record<string, AdapterCapability> = {
  discoverConfig: "discoverConfig",
  applyAlign: "applyAlign",
  indexSessions: "indexSessions",
  transcriptFileForSourceKey: "readTranscript",
  captureTranscriptSnapshot: "readTranscript",
  invoke: "invoke",
};

test("builtin adapters: manifest capabilities match implemented methods", () => {
  assert.ok(builtinAdapters.length >= 2);
  for (const adapter of builtinAdapters) {
    const { runtime, adapterApi, capabilities } = adapter.manifest;
    assert.equal(adapterApi, ADAPTER_API_VERSION, `${runtime}: adapter_api 保持 1（additive 契约）`);
    assert.ok(capabilities.includes("detect"), `${runtime}: detect 必声明`);
    for (const cap of capabilities) {
      for (const method of CAPABILITY_METHODS[cap]) {
        assert.equal(
          typeof (adapter as unknown as Record<string, unknown>)[method],
          "function",
          `${runtime}: 声明 capability "${cap}" 但缺方法 ${method}`,
        );
      }
    }
    for (const [method, cap] of Object.entries(METHOD_CAPABILITY)) {
      if (typeof (adapter as unknown as Record<string, unknown>)[method] === "function") {
        assert.ok(
          hasCapability(adapter.manifest, cap),
          `${runtime}: 实现了 ${method} 但未声明 capability "${cap}"`,
        );
      }
    }
  }
});

test("invoke capability 诚实边界（AC-4 契约面）：claude-code 声明并实现；cursor 不声明、不实现", () => {
  const claude = adapterForRuntime("claude-code");
  assert.ok(claude);
  assert.ok(hasCapability(claude.manifest, "invoke"), "claude-code 有 headless 执行面，须声明 invoke");
  assert.equal(typeof claude.invoke, "function");

  const cursor = adapterForRuntime("cursor");
  assert.ok(cursor);
  assert.ok(!hasCapability(cursor.manifest, "invoke"), "cursor 无 headless 执行面，不得声明 invoke");
  assert.equal(cursor.invoke, undefined);
});

test("adapterForRuntime resolves builtins; unknown runtime returns undefined", () => {
  assert.equal(adapterForRuntime("claude-code")?.manifest.displayName, "Claude Code");
  assert.equal(adapterForRuntime("cursor")?.manifest.displayName, "Cursor");
  assert.equal(adapterForRuntime("nope-runtime"), undefined);
});
