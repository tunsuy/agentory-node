import fs from "node:fs";
import path from "node:path";

/**
 * Cursor renderer bundle 补丁（方案 A）的版本自适应定位 + 应用/还原。
 *
 * 为什么不用写死符号：minified 标识符（composerService 的 `zh`、命令 id 变量等）
 * 每个 Cursor 版本都会变。这里在补丁时**从 bundle 里现场解析**：
 *   1. `X = "composer.startComposerPrompt2"` → 命令 id 变量
 *   2. 该变量的 handler `run(<acc>,<arg>,<n>){ if(<acc>.get(<P>).isGlass){…`
 *   3. `S = …("composerService")` / `…("composerChatService")` / `…("composerViewsService")`
 * 任一步失配 → 返回 error（视为版本漂移），绝不盲打。
 *
 * 幂等；首次 apply 写 `<bundle>.agentory.bak`，revert 从备份还原。
 */

export const SUBMIT_SENTINEL = "__AGENTORY_SUBMIT__";

export const DEFAULT_DESKTOP_BUNDLE =
  "/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js";

export type Located = { anchor: string; inject: string };
export type LocateResult = { ok: true; located: Located } | { ok: false; reason: string };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function serviceVar(bundle: string, serviceId: string): string | undefined {
  const re = new RegExp(
    `([A-Za-z_$][\\w$]*)\\s*=\\s*[A-Za-z_$][\\w$]*\\("${escapeRe(serviceId)}"\\)`,
  );
  return re.exec(bundle)?.[1];
}

/** 从 bundle 文本解析出 anchor 与注入体；失败给出漂移原因。 */
export function locateAnchor(bundle: string): LocateResult {
  const idVar = /([A-Za-z_$][\w$]*)\s*=\s*"composer\.startComposerPrompt2"/.exec(bundle)?.[1];
  if (!idVar) return { ok: false, reason: "composer.startComposerPrompt2 id not found" };

  const cmdIdx = bundle.indexOf(`id:${idVar}`);
  if (cmdIdx < 0) return { ok: false, reason: "startComposerPrompt2 handler class not found" };

  const runIdx = bundle.indexOf("async run(", cmdIdx);
  if (runIdx < 0) return { ok: false, reason: "handler run() not found" };
  const paramsEnd = bundle.indexOf("){", runIdx);
  if (paramsEnd < 0) return { ok: false, reason: "handler run() params not closed" };

  const params = bundle.slice(runIdx + "async run(".length, paramsEnd);
  const parts = params.split(",").map((p) => p.trim());
  const acc = parts[0];
  const arg = parts[1];
  if (!acc || !arg) return { ok: false, reason: "unexpected run() arity" };

  const head = bundle.slice(runIdx, runIdx + 6000);
  const glassVar = new RegExp(
    `${escapeRe(acc)}\\.get\\(([A-Za-z_$][\\w$]*)\\)\\.isGlass`,
  ).exec(head)?.[1];
  if (!glassVar) return { ok: false, reason: "isGlass guard not found in run()" };

  const composerService = serviceVar(bundle, "composerService");
  const chatService = serviceVar(bundle, "composerChatService");
  const viewsService = serviceVar(bundle, "composerViewsService");
  const dataService = serviceVar(bundle, "composerDataService");
  if (!composerService || !chatService || !viewsService || !dataService) {
    return { ok: false, reason: "composer service ids not found" };
  }

  // 气泡类型 MESSAGE_TYPE_AI 的数值（跨版本稳定：按字面量取，不依赖 minified 枚举名）。
  const aiType = /no:(\d+),name:"MESSAGE_TYPE_AI"/.exec(bundle)?.[1];
  if (!aiType) return { ok: false, reason: "MESSAGE_TYPE_AI enum value not found" };

  const anchor = `async run(${params}){if(${acc}.get(${glassVar}).isGlass){`;
  if (bundle.split(anchor).length - 1 !== 1) {
    return { ok: false, reason: "anchor not unique" };
  }

  const inject =
    `async run(${params}){` +
    `try{` +
    `if(typeof ${arg}==='string'&&${arg}.startsWith('${SUBMIT_SENTINEL}')){` +
    `var P=JSON.parse(${arg}.slice(${arg}.indexOf('{')));` +
    `var CS=${acc}.get(${composerService}),CH=${acc}.get(${chatService}),VW=${acc}.get(${viewsService}),DS=${acc}.get(${dataService});` +
    `var AI=${aiType};` +
    `var MR=function(o){var cp=P.bridgePort||4517;try{fetch('http://127.0.0.1:'+cp+'/v1/cursor/result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(o)})}catch(_f){}};` +
    `var lastAi=function(d){if(!d)return{};var hs=d.fullConversationHeadersOnly||[],cm=d.conversationMap||{};for(var i=hs.length-1;i>=0;i--){var h=hs[i];if(h&&h.type===AI){var bb=cm[h.bubbleId];if(bb&&typeof bb.text==='string'&&bb.text.trim())return{id:h.bubbleId,text:bb.text}}}return{}};` +
    `var base=lastAi(DS.getComposerDataIfLoaded(P.composerId||''));` +
    `var runPoll=async function(cid){` +
    `var deadline=Date.now()+(P.timeoutMs||300000),last='',stableAt=0,seen=false;` +
    `while(Date.now()<deadline){` +
    `await new Promise(function(r){setTimeout(r,500)});` +
    `var d=DS.getComposerDataIfLoaded(cid);if(!d)continue;` +
    `var gen=(d.generatingBubbleIds&&d.generatingBubbleIds.length>0)||d.status==='generating';` +
    `var cur=lastAi(d);` +
    `if(cur.id&&cur.id!==base.id){seen=true;if(cur.text!==last){last=cur.text;stableAt=Date.now()}}` +
    `if(seen&&!gen){if(!stableAt)stableAt=Date.now();if(Date.now()-stableAt>800){MR({ok:!0,composerId:cid,output:last});return}}` +
    `}` +
    `MR({ok:!0,composerId:cid,output:last,timedOut:true});` +
    `};` +
    `if(!P.composerId){` +
    `var hh=await CS.createComposer({partialState:{text:P.prompt,unifiedMode:'agent'},autoSubmit:!0});` +
    `var cid0=hh&&hh.composerId;` +
    `if(!cid0){MR({ok:!1,error:'no_composer_id'});return}` +
    `MR({ok:!0,protocol:2,composerId:cid0,ack:true});` +
    `runPoll(cid0);return` +
    `}` +
    `var cid=P.composerId;` +
    `try{await VW.showAndFocus(cid)}catch(_e){}` +
    `await CH.submitChatMaybeAbortCurrent(cid,P.prompt,{});` +
    `MR({ok:!0,protocol:2,composerId:cid,ack:true});` +
    `runPoll(cid);return` +
    `}` +
    `}catch(err){MR({ok:!1,error:String(err&&err.message||err)});return}` +
    `if(${acc}.get(${glassVar}).isGlass){`;

  return { ok: true, located: { anchor, inject } };
}

export function isBundlePatched(bundle: string): boolean {
  return bundle.includes(SUBMIT_SENTINEL);
}

export type BundlePatchResult = {
  ok: boolean;
  bundle: string;
  backup?: string;
  patched: boolean;
  reason?: string;
};

function backupPath(bundlePath: string): string {
  return `${bundlePath}.agentory.bak`;
}

export function readBundle(bundlePath: string = DEFAULT_DESKTOP_BUNDLE): string {
  return fs.readFileSync(bundlePath, "utf8");
}

export function statusBundlePatch(
  bundlePath: string = DEFAULT_DESKTOP_BUNDLE,
): BundlePatchResult {
  const bundle = readBundle(bundlePath);
  return {
    ok: true,
    bundle: bundlePath,
    backup: fs.existsSync(backupPath(bundlePath)) ? backupPath(bundlePath) : undefined,
    patched: isBundlePatched(bundle),
  };
}

export function applyBundlePatch(
  bundlePath: string = DEFAULT_DESKTOP_BUNDLE,
): BundlePatchResult {
  const bundle = readBundle(bundlePath);
  if (isBundlePatched(bundle)) {
    return { ok: true, bundle: bundlePath, patched: true, reason: "already patched" };
  }
  const loc = locateAnchor(bundle);
  if (!loc.ok) {
    return { ok: false, bundle: bundlePath, patched: false, reason: loc.reason };
  }
  const bak = backupPath(bundlePath);
  if (!fs.existsSync(bak)) {
    fs.copyFileSync(bundlePath, bak);
  }
  fs.writeFileSync(bundlePath, bundle.replace(loc.located.anchor, loc.located.inject));
  return { ok: true, bundle: bundlePath, backup: bak, patched: true };
}

export function revertBundlePatch(
  bundlePath: string = DEFAULT_DESKTOP_BUNDLE,
): BundlePatchResult {
  const bak = backupPath(bundlePath);
  if (!fs.existsSync(bak)) {
    const patched = isBundlePatched(readBundle(bundlePath));
    return {
      ok: !patched,
      bundle: bundlePath,
      patched,
      reason: patched ? "patched but no backup; refuse to revert" : "not patched",
    };
  }
  fs.copyFileSync(bak, bundlePath);
  return { ok: true, bundle: bundlePath, backup: bak, patched: false };
}
