// Agentory Cursor Bridge — spike
//
// 目标（方案 A 进程内桥）：验证本机扩展能否「后台无 GUI 粘贴」地把一条 prompt 送进
// Cursor 内部 composer，并让 IDE 会话真的开聊/续聊。
//
// 三层可切换策略（spike 阶段全留，逐个实测）：
//   S1 commands.executeCommand("composer.createComposer") + 内部 composer 服务提交
//   S2 chat.type / chat.submit（Cursor 后端自动化命令）
//   S3 workbench glass global（window.<...>) 打内部 service —— 版本敏感，最后才试
//
// 对外 HTTP（默认 127.0.0.1:4517，AGENTORY_BRIDGE_PORT 可覆盖）：
//   GET  /health                -> { ok, version, strategies }
//   POST /v1/cursor/sessions    { prompt, strategy? }         -> { ok, sessionId?, detail }
//   POST /v1/cursor/sessions/:id/messages { prompt }          -> { ok, sessionId?, detail }
//   GET  /v1/cursor/probe       -> 探测可用命令/内部服务名

const vscode = require("vscode");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = Number(process.env.AGENTORY_BRIDGE_PORT || 4517);
const RUNTIME_DIR = path.join(os.homedir(), ".agentory", "bridge");

let lastResult = null;
let actualPort = PORT;

/** @type {vscode.OutputChannel} */
let log;

function out(...args) {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ")}`;
  log?.appendLine(line);
  // 同时落控制台，便于 tail 扩展宿主日志
  console.log(line);
}

async function existingCommands() {
  try {
    return await vscode.commands.getCommands(true);
  } catch (e) {
    return [];
  }
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (buf) => {
      size += buf.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// S2: chat.* command 策略 —— 最贴近「UI 会跟着走」，但依赖 Cursor 内部命令确已注册。
// ---------------------------------------------------------------------------
async function strategyCommandsChat(prompt) {
  const cmds = await existingCommands();
  const report = { hasChatType: cmds.includes("chat.type"), hasChatSubmit: cmds.includes("chat.submit") };
  if (!report.hasChatType) return { ok: false, detail: { ...report, reason: "chat.type 未注册" } };
  // 打开 chat 面板/新建 chat，再 type+submit。
  for (const open of ["workbench.action.chat.open", "aichat.newchataction", "composer.newAgentChat"]) {
    if (!cmds.includes(open)) continue;
    try {
      await vscode.commands.executeCommand(open);
      break;
    } catch (e) {
      out("open failed", open, String(e));
    }
  }
  try {
    await vscode.commands.executeCommand("chat.type", prompt);
  } catch (e) {
    return { ok: false, detail: { ...report, reason: `chat.type 失败: ${String(e)}` } };
  }
  if (report.hasChatSubmit) {
    try {
      await vscode.commands.executeCommand("chat.submit");
    } catch (e) {
      return { ok: false, detail: { ...report, reason: `chat.submit 失败: ${String(e)}` } };
    }
  }
  return { ok: true, detail: { strategy: "chat.*", ...report } };
}

// ---------------------------------------------------------------------------
// S1: composer 命令策略 —— 有文档面的 Cursor 命令，作为回退。
// ---------------------------------------------------------------------------
async function strategyComposerCommand(prompt) {
  const cmds = await existingCommands();
  const candidates = [
    "composer.startComposerPrompt",
    "composer.startComposerPrompt2",
    "composer.newAgentChat",
    "composer.createComposer",
  ];
  const hit = candidates.filter((c) => cmds.includes(c));
  if (hit.length === 0) return { ok: false, detail: { reason: "无 composer 提交类命令", candidates } };
  // startComposerPrompt 系列接受文本参数；newAgentChat 不带文本（仅开面板）。
  const withText = hit.find((c) => c.startsWith("composer.startComposerPrompt"));
  try {
    if (withText) {
      await vscode.commands.executeCommand(withText, prompt);
      return { ok: true, detail: { strategy: withText, submittedText: true } };
    }
    await vscode.commands.executeCommand(hit[0]);
    return { ok: false, detail: { strategy: hit[0], reason: "仅能开面板，未拿到带文本的提交入口" } };
  } catch (e) {
    return { ok: false, detail: { reason: `composer 命令失败: ${String(e)}`, hit } };
  }
}

// ---------------------------------------------------------------------------
// S3: chat.open 预填 + 尝试各种「发送」候选命令。
// ---------------------------------------------------------------------------
const SUBMIT_CANDIDATES = [
  "workbench.action.chat.submit",
  "workbench.action.chat.send",
  "composer.submit",
  "composer.send",
  "aichat.submit",
  "aichat.newchataction",
];

async function strategyChatOpen(prompt) {
  const cmds = await existingCommands();
  if (!cmds.includes("workbench.action.chat.open")) {
    return { ok: false, detail: { reason: "workbench.action.chat.open 未注册" } };
  }
  try {
    await vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt });
  } catch (e) {
    return { ok: false, detail: { reason: `chat.open 失败: ${String(e)}` } };
  }
  // 预填成功；再逐个试发送候选命令，记录哪个可调用。
  const submitTried = [];
  for (const c of SUBMIT_CANDIDATES) {
    if (!cmds.includes(c)) {
      submitTried.push({ command: c, present: false });
      continue;
    }
    try {
      const r = await vscode.commands.executeCommand(c);
      submitTried.push({ command: c, present: true, ok: true, result: safeJson(r) });
      return { ok: true, detail: { strategy: "chat.open+submit", submittedBy: c, submitTried } };
    } catch (e) {
      submitTried.push({ command: c, present: true, ok: false, error: String(e) });
    }
  }
  return {
    ok: false,
    detail: { strategy: "chat.open", reason: "仅预填，未找到可用发送命令", submitTried },
  };
}

const STRATEGIES = {
  "chat.open": strategyChatOpen,
  "chat.*": strategyCommandsChat,
  composer: strategyComposerCommand,
};

function safeJson(v) {
  try {
    return JSON.parse(JSON.stringify(v ?? null));
  } catch {
    return String(v);
  }
}

async function dispatch(prompt, strategy) {
  const order = strategy ? [strategy] : ["chat.open", "chat.*", "composer"];
  const tried = [];
  for (const name of order) {
    const fn = STRATEGIES[name];
    if (!fn) {
      tried.push({ name, ok: false, detail: { reason: "未知策略" } });
      continue;
    }
    let r;
    try {
      r = await fn(prompt);
    } catch (e) {
      r = { ok: false, detail: { reason: String(e) } };
    }
    tried.push({ name, ...r });
    if (r.ok) return { ok: true, strategy: name, detail: r.detail, tried };
  }
  return { ok: false, detail: { reason: "所有策略均失败", tried }, tried };
}

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    });
    res.end();
    return;
  }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { ok: true, port: PORT, strategies: Object.keys(STRATEGIES) });
  }
  if (req.method === "GET" && url.pathname === "/v1/cursor/probe") {
    const cmds = await existingCommands();
    return json(res, 200, {
      ok: true,
      pid: process.pid,
      vscodeVersion: vscode.version,
      chatType: cmds.includes("chat.type"),
      chatSubmit: cmds.includes("chat.submit"),
      composerCmds: cmds.filter((c) => c.startsWith("composer.")),
    });
  }
  if (req.method === "GET" && url.pathname === "/commands") {
    const cmds = await existingCommands();
    const re = url.searchParams.get("re");
    const list = re ? cmds.filter((c) => new RegExp(re, "i").test(c)) : cmds;
    return json(res, 200, { ok: true, total: cmds.length, commands: list });
  }
  if (req.method === "POST" && url.pathname === "/exec") {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return json(res, 400, { ok: false, error: "bad_json" });
    }
    if (!body || typeof body.command !== "string") {
      return json(res, 400, { ok: false, error: "missing_command" });
    }
    const args = Array.isArray(body.args) ? body.args : body.args === undefined ? [] : [body.args];
    try {
      const result = await vscode.commands.executeCommand(body.command, ...args);
      let serializable;
      try {
        serializable = JSON.parse(JSON.stringify(result ?? null));
      } catch {
        serializable = String(result);
      }
      return json(res, 200, { ok: true, result: serializable });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  }
  if (req.method === "POST" && url.pathname === "/v1/cursor/submit") {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return json(res, 400, { ok: false, error: "bad_json" });
    }
    if (!body || typeof body.prompt !== "string" || !body.prompt.trim()) {
      return json(res, 400, { ok: false, error: "missing_prompt" });
    }
    lastResult = null;
    const payload = `__AGENTORY_SUBMIT__${JSON.stringify({
      prompt: body.prompt,
      composerId: body.composerId || undefined,
      bridgePort: actualPort,
      timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
    })}`;
    out("submit via patch", { composerId: body.composerId, prompt: body.prompt.slice(0, 80) });
    try {
      await vscode.commands.executeCommand("composer.startComposerPrompt2", payload);
      return json(res, 200, { ok: true, queued: true });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  }
  if (req.method === "POST" && url.pathname === "/v1/cursor/result") {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return json(res, 400, { ok: false, error: "bad_json" });
    }
    lastResult = { ...body, receivedAt: new Date().toISOString() };
    out("renderer result", lastResult);
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/v1/cursor/result") {
    return json(res, 200, { ok: true, result: lastResult });
  }
  const newMatch = url.pathname.match(/^\/v1\/cursor\/sessions$/);
  const msgMatch = url.pathname.match(/^\/v1\/cursor\/sessions\/([^/]+)\/messages$/);
  if (req.method === "POST" && (newMatch || msgMatch)) {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return json(res, 400, { ok: false, error: "bad_json" });
    }
    if (!body || typeof body.prompt !== "string" || !body.prompt.trim()) {
      return json(res, 400, { ok: false, error: "missing_prompt" });
    }
    const sid = msgMatch ? decodeURIComponent(msgMatch[1]) : undefined;
    out("dispatch", { sid, strategy: body.strategy, prompt: body.prompt.slice(0, 80) });
    const r = await dispatch(body.prompt, body.strategy);
    return json(res, r.ok ? 200 : 502, { ok: r.ok, sessionId: sid, ...r });
  }
  json(res, 404, { ok: false, error: "not_found" });
}

function startServer(context) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      out("handler error", String(e));
      try {
        json(res, 500, { ok: false, error: String(e) });
      } catch {
        /* ignore */
      }
    });
  });
  const writeRuntime = (port) => {
    try {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true });
      const file = path.join(RUNTIME_DIR, `${process.pid}.json`);
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port, at: new Date().toISOString() }));
      out(`runtime file: ${file} (port ${port})`);
    } catch (e) {
      out("write runtime file failed", String(e));
    }
  };
  // 顺序尝试 PORT..PORT+3，全部被占再退到临时端口。
  let attempt = 0;
  const tryListen = () => {
    const want = PORT + attempt;
    const onError = (e) => {
      server.removeListener("listening", onListening);
      if (e && e.code === "EADDRINUSE") {
        if (attempt < 3) {
          attempt += 1;
          out(`port ${want} busy, trying ${PORT + attempt}`);
          tryListen();
          return;
        }
        out("all candidate ports busy, falling back to ephemeral");
        server.once("listening", onListening);
        server.listen(0, "127.0.0.1");
        return;
      }
      out("server error", String(e));
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const actual = server.address().port;
      actualPort = actual;
      out(`bridge listening on http://127.0.0.1:${actual}`);
      writeRuntime(actual);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(want, "127.0.0.1");
  };
  tryListen();
  context.subscriptions.push({
    dispose: () => {
      server.close();
      try {
        fs.unlinkSync(path.join(RUNTIME_DIR, `${process.pid}.json`));
      } catch {
        /* ignore */
      }
    },
  });
  return server;
}

function activate(context) {
  log = vscode.window.createOutputChannel("Agentory Cursor Bridge");
  out("activate", { vscode: vscode.version, port: PORT });
  context.subscriptions.push(log);
  context.subscriptions.push(
    vscode.commands.registerCommand("agentoryBridge.showLog", () => log.show(true)),
  );
  startServer(context);
  // 后台探测一次，便于从日志/HTTP 判断命令面
  existingCommands().then((cmds) => {
    out("command probe", {
      total: cmds.length,
      chatType: cmds.includes("chat.type"),
      chatSubmit: cmds.includes("chat.submit"),
      composer: cmds.filter((c) => c.startsWith("composer.")).slice(0, 20),
    });
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
