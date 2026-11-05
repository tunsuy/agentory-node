import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  SUBMIT_SENTINEL,
  applyBundlePatch,
  isBundlePatched,
  locateAnchor,
  revertBundlePatch,
  statusBundlePatch,
} from "./patch-bundle.js";

// 合成一个「最小可定位」的 bundle：minified 标识符随意，但结构对标真实产物。
const SYNTHETIC =
  'var qpt="composer.startComposerPrompt2",v0="x";' +
  'var zh=Xt("composerService"),GO=Xt("composerChatService"),xb=Xt("composerViewsService"),so=Xt("composerDataService");' +
  'var MT=[{no:0,name:"MESSAGE_TYPE_UNSPECIFIED"},{no:1,name:"MESSAGE_TYPE_HUMAN",localName:"HUMAN"},{no:2,name:"MESSAGE_TYPE_AI",localName:"AI"}];' +
  "var wgm=class extends vt{constructor(){super({id:qpt,title:{value:\"Open Chat\"}})}" +
  "async run(e,t,n){if(e.get(Pr).isGlass){if(t!==void 0)return;return}return t}};";

test("locateAnchor: 现场解析 id/service/isGlass 并能构造 anchor+inject", () => {
  const loc = locateAnchor(SYNTHETIC);
  assert.equal(loc.ok, true);
  if (!loc.ok) return;
  assert.equal(loc.located.anchor, "async run(e,t,n){if(e.get(Pr).isGlass){");
  assert.ok(loc.located.inject.startsWith("async run(e,t,n){try{"));
  assert.ok(loc.located.inject.includes("e.get(zh)"));
  assert.ok(loc.located.inject.includes("e.get(GO)"));
  assert.ok(loc.located.inject.includes("e.get(so)"));
  assert.ok(loc.located.inject.includes("var AI=2;"));
  assert.ok(loc.located.inject.includes("runPoll"));
  assert.ok(loc.located.inject.includes("ack:true"));
  assert.ok(loc.located.inject.includes("protocol:2"));
  assert.ok(loc.located.inject.includes(SUBMIT_SENTINEL));
});

test("locateAnchor: 缺命令 id → 版本漂移报错而非盲打", () => {
  const loc = locateAnchor("var nothing=1;");
  assert.equal(loc.ok, false);
});

test("apply/revert: 幂等 apply、写备份、revert 还原", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentory-patch-"));
  const file = path.join(dir, "workbench.desktop.main.js");
  fs.writeFileSync(file, SYNTHETIC);

  assert.deepEqual(statusBundlePatch(file).patched, false);
  const applied = applyBundlePatch(file);
  assert.equal(applied.ok, true);
  assert.equal(applied.patched, true);
  assert.ok(fs.existsSync(`${file}.agentory.bak`));
  assert.equal(isBundlePatched(fs.readFileSync(file, "utf8")), true);

  // 幂等
  const second = applyBundlePatch(file);
  assert.equal(second.ok, true);
  assert.equal(second.reason, "already patched");

  const reverted = revertBundlePatch(file);
  assert.equal(reverted.ok, true);
  assert.equal(fs.readFileSync(file, "utf8"), SYNTHETIC);
});

test("版本漂移时 apply 返回 ok:false 且不改文件", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentory-patch-"));
  const file = path.join(dir, "workbench.desktop.main.js");
  const drifted = 'var qpt="composer.startComposerPrompt2";var w=class{async run(e,t,n){return}};';
  fs.writeFileSync(file, drifted);
  const res = applyBundlePatch(file);
  assert.equal(res.ok, false);
  assert.equal(fs.readFileSync(file, "utf8"), drifted);
});
