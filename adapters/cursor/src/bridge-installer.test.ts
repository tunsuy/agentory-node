import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  detectCursorBridge,
  installCursorBridge,
  uninstallCursorBridge,
} from "./bridge-installer.js";

const SYNTHETIC =
  'var qpt="composer.startComposerPrompt2";' +
  'var zh=Xt("composerService"),GO=Xt("composerChatService"),xb=Xt("composerViewsService"),so=Xt("composerDataService");' +
  'var MT=[{no:1,name:"MESSAGE_TYPE_HUMAN"},{no:2,name:"MESSAGE_TYPE_AI"}];' +
  "var w=class extends vt{constructor(){super({id:qpt})}async run(e,t,n){if(e.get(Pr).isGlass){return}return t}};";

const DRIFT = 'var qpt="composer.startComposerPrompt2";var w=class{async run(e,t,n){return}};';

function scaffold(opts: { version?: string; bundle?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentory-inst-"));
  const appRoot = path.join(root, "Cursor.app");
  const appRes = path.join(appRoot, "Contents", "Resources", "app");
  fs.mkdirSync(path.join(appRes, "bin"), { recursive: true });
  fs.writeFileSync(path.join(appRes, "package.json"), JSON.stringify({ version: opts.version ?? "3.11.19" }));
  const cursorCli = path.join(appRes, "bin", "cursor");
  fs.writeFileSync(cursorCli, "#!/bin/sh\n");
  const bundlePath = path.join(root, "workbench.desktop.main.js");
  fs.writeFileSync(bundlePath, opts.bundle ?? SYNTHETIC);
  const extensionSourceDir = path.join(root, "ext");
  fs.mkdirSync(extensionSourceDir, { recursive: true });
  fs.writeFileSync(path.join(extensionSourceDir, "package.json"), JSON.stringify({ name: "cursor-bridge", publisher: "agentory", version: "0.2.0" }));
  fs.writeFileSync(path.join(extensionSourceDir, "extension.js"), "// ext\n");
  const extensionsDir = path.join(root, "extensions");
  fs.mkdirSync(extensionsDir, { recursive: true });
  return { root, appRoot, cursorCli, bundlePath, extensionSourceDir, extensionsDir };
}

function deps(s: ReturnType<typeof scaffold>) {
  return {
    cursorAppRoot: s.appRoot,
    bundlePath: s.bundlePath,
    cursorCli: s.cursorCli,
    extensionsDir: s.extensionsDir,
    extensionSourceDir: s.extensionSourceDir,
  };
}

test("detect: 识别版本/可打补丁/未安装", () => {
  const s = scaffold();
  const st = detectCursorBridge(deps(s));
  assert.equal(st.cursorVersion, "3.11.19");
  assert.equal(st.compatible, true);
  assert.equal(st.bundlePatched, false);
  assert.equal(st.extensionInstalled, false);
  assert.equal(st.ok, true);
});

test("detect: Cursor 版本过低 → 不 ok 并给原因", () => {
  const s = scaffold({ version: "3.0.0" });
  const st = detectCursorBridge(deps(s));
  assert.equal(st.ok, false);
  assert.ok(st.reasons.some((r) => r.includes("低于支持下限")));
});

test("detect: bundle 结构漂移 → 不可打补丁", () => {
  const s = scaffold({ bundle: DRIFT });
  const st = detectCursorBridge(deps(s));
  assert.equal(st.compatible, false);
  assert.equal(st.ok, false);
});

test("install: 打补丁 + 装扩展（注入 run/buildVsix）", () => {
  const s = scaffold();
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const res = installCursorBridge({
    ...deps(s),
    run: (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: "", stderr: "" };
    },
    buildVsix: (_src, out) => fs.writeFileSync(out, "PK\u0003\u0004dummy"),
    tmpDir: () => fs.mkdtempSync(path.join(os.tmpdir(), "agentory-inst-tmp-")),
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.steps.length >= 2, true);
  const installCall = calls.find((c) => c.args.includes("--install-extension"));
  assert.ok(installCall, "应调用 --install-extension");
  // 补丁已落盘
  assert.equal(fs.readFileSync(s.bundlePath, "utf8").includes("__AGENTORY_SUBMIT__"), true);
});

test("install: 版本漂移 → 不装、bundle 不变", () => {
  const s = scaffold({ bundle: DRIFT });
  const res = installCursorBridge({
    ...s,
    run: () => ({ status: 0, stdout: "", stderr: "" }),
    buildVsix: () => {},
    tmpDir: () => fs.mkdtempSync(path.join(os.tmpdir(), "agentory-inst-tmp-")),
  });
  assert.equal(res.ok, false);
  assert.equal(fs.readFileSync(s.bundlePath, "utf8"), DRIFT);
});

test("uninstall: 卸载扩展 + 还原 bundle", () => {
  const s = scaffold();
  // 先装
  installCursorBridge({
    ...s,
    run: () => ({ status: 0, stdout: "", stderr: "" }),
    buildVsix: (_src, out) => fs.writeFileSync(out, "dummy"),
    tmpDir: () => fs.mkdtempSync(path.join(os.tmpdir(), "agentory-inst-tmp-")),
  });
  const calls: string[][] = [];
  const res = uninstallCursorBridge({
    ...s,
    run: (_cmd, args) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(calls.some((a) => a.includes("--uninstall-extension")));
  assert.equal(fs.readFileSync(s.bundlePath, "utf8"), SYNTHETIC);
});
