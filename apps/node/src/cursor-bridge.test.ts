import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ensureCursorBridgeAuto,
  isCursorBridgeAutoEnabled,
  makeReloadCursor,
} from "./cursor-bridge.js";
import type { CursorBridgeStatus, InstallResult } from "@agentoryhq/adapter-cursor";

function status(over: Partial<CursorBridgeStatus> = {}): CursorBridgeStatus {
  return {
    ok: true,
    platform: "darwin",
    extensionId: "agentory.cursor-bridge",
    extensionInstalled: false,
    bundlePatched: false,
    compatible: true,
    reasons: [],
    ...over,
  };
}

test("isCursorBridgeAutoEnabled: env 真值解析", () => {
  assert.equal(isCursorBridgeAutoEnabled({ AGENTORY_CURSOR_BRIDGE_AUTO: "1" }), true);
  assert.equal(isCursorBridgeAutoEnabled({ AGENTORY_CURSOR_BRIDGE_AUTO: "true" }), true);
  assert.equal(isCursorBridgeAutoEnabled({ AGENTORY_CURSOR_BRIDGE_AUTO: "0" }), false);
  assert.equal(isCursorBridgeAutoEnabled({}), false);
});

test("ensure: 关闭 → disabled 不动作", () => {
  let installed = false;
  const r = ensureCursorBridgeAuto({
    enabled: false,
    detect: () => status(),
    install: () => {
      installed = true;
      return { ok: true, steps: [] };
    },
    reload: () => ({ ok: true, detail: "" }),
  });
  assert.equal(r.action, "disabled");
  assert.equal(r.acted, false);
  assert.equal(installed, false);
});

test("ensure: 不兼容 → skipped", () => {
  const r = ensureCursorBridgeAuto({
    enabled: true,
    detect: () => status({ ok: false, compatible: false, reasons: ["版本漂移"] }),
    install: () => ({ ok: true, steps: [] }),
    reload: () => ({ ok: true, detail: "" }),
  });
  assert.equal(r.action, "skipped");
  assert.deepEqual(r.reasons, ["版本漂移"]);
});

test("ensure: 已装且已补丁 → already，不重装不重载", () => {
  let reloaded = false;
  const r = ensureCursorBridgeAuto({
    enabled: true,
    detect: () => status({ extensionInstalled: true, bundlePatched: true }),
    install: () => ({ ok: true, steps: [] }),
    reload: () => {
      reloaded = true;
      return { ok: true, detail: "" };
    },
  });
  assert.equal(r.action, "already");
  assert.equal(reloaded, false);
});

test("ensure: 需要装 → install + reload", () => {
  let didInstall = false;
  const r = ensureCursorBridgeAuto({
    enabled: true,
    detect: () => status(),
    install: (): InstallResult => {
      didInstall = true;
      return { ok: true, steps: ["patched", "installed"] };
    },
    reload: () => ({ ok: true, detail: "quit=0 open=0" }),
  });
  assert.equal(didInstall, true);
  assert.equal(r.action, "installed");
  assert.equal(r.ok, true);
  assert.equal(r.reloaded, true);
});

test("ensure: 安装失败 → install_failed 且不重载", () => {
  let reloaded = false;
  const r = ensureCursorBridgeAuto({
    enabled: true,
    detect: () => status(),
    install: () => ({ ok: false, steps: [], error: "bundle 补丁失败（版本漂移）" }),
    reload: () => {
      reloaded = true;
      return { ok: true, detail: "" };
    },
  });
  assert.equal(r.action, "install_failed");
  assert.equal(r.ok, false);
  assert.equal(reloaded, false);
  assert.match(r.reasons[0], /版本漂移/);
});

test("makeReloadCursor: 非 darwin 不动作；darwin 执行 quit+open", () => {
  const calls: string[][] = [];
  const relay = makeReloadCursor({
    platform: "linux",
    run: (_c, a) => {
      calls.push(a);
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(relay().ok, false);
  assert.equal(calls.length, 0);

  const calls2: Array<[string, string[]]> = [];
  const relay2 = makeReloadCursor({
    platform: "darwin",
    run: (cmd, a) => {
      calls2.push([cmd, a]);
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  const r = relay2();
  assert.equal(r.ok, true);
  assert.ok(calls2.some(([cmd, a]) => cmd === "osascript" && a.join(" ").includes("quit")));
  assert.ok(calls2.some(([cmd]) => cmd === "open"));
});
