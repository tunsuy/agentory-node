// github-task 执行器单测（github-tasks 切片 3）：假 git + 假 invoke 注入面。
// 覆盖：remote URL 解析矩阵 · 脱敏（AC-12）· remote 不一致 failed 零执行（AC-4）·
// happy path 全序列（fetch→checkout -B 任务分支→invoke→add/status/commit/push→done+pushedBranch,
// AC-5/8）· invoke failed/timeout 原样回流不 push（AC-6）· 无改动 no_changes 诚实失败 ·
// git 步骤失败脱敏回流 · prompt = issue 标题+正文快照（AC-4 输入面）。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { InvokeResult } from "@agentoryhq/runtime-contract";
import {
  executeGithubTask,
  githubTaskPrompt,
  maskSecrets,
  parseGithubRepo,
  type GithubTaskPayload,
  type GitRunner,
} from "./github-task.js";

const TASK: GithubTaskPayload = {
  id: "ght_1",
  repoOwner: "tunsuy",
  repoName: "agentory",
  defaultBranch: "main",
  issueNumber: 901,
  issueTitle: "修复登录闪烁",
  issueBody: "复现步骤 BODY",
  branch: "agentory/task-ght_1",
  timeoutMs: 60_000,
  maxOutputBytes: 1024,
};

type GitOut = { code?: number; stdout?: string; stderr?: string };

/** 假 git：按 args 前缀匹配计划表;全调用留痕供序列断言。 */
function fakeGit(plan: Array<[prefix: string, out: GitOut]>, calls: string[][]): GitRunner {
  return async (args) => {
    const key = args.join(" ");
    calls.push(args);
    for (const [prefix, out] of plan) {
      if (key.startsWith(prefix)) {
        return { code: out.code ?? 0, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

const OK_REMOTE: [string, GitOut] = [
  "config --get remote.origin.url",
  { stdout: "https://github.com/tunsuy/agentory.git\n" },
];

function fakeInvoke(result: Partial<InvokeResult>, seen: Array<{ prompt: string; cwd: string }>) {
  return async (req: { prompt: string; timeoutMs: number; maxOutputBytes: number; cwd: string }): Promise<InvokeResult> => {
    seen.push({ prompt: req.prompt, cwd: req.cwd });
    return {
      outcome: "done",
      output: "mock ok",
      truncated: false,
      exitCode: 0,
      durationMs: 5,
      ...result,
    };
  };
}

test("parseGithubRepo：https/ssh/git@ 三形态 + .git 后缀 + 非 github 拒绝", () => {
  assert.deepEqual(parseGithubRepo("https://github.com/tunsuy/agentory.git"), { owner: "tunsuy", repo: "agentory" });
  assert.deepEqual(parseGithubRepo("https://github.com/tunsuy/agentory"), { owner: "tunsuy", repo: "agentory" });
  assert.deepEqual(parseGithubRepo("ssh://git@github.com/tunsuy/agentory.git"), { owner: "tunsuy", repo: "agentory" });
  assert.deepEqual(parseGithubRepo("git@github.com:tunsuy/agentory.git"), { owner: "tunsuy", repo: "agentory" });
  assert.equal(parseGithubRepo("https://gitlab.com/tunsuy/agentory.git"), undefined, "非 github.com 拒绝");
  assert.equal(parseGithubRepo("https://github.com.evil.com/tunsuy/agentory.git"), undefined, "域名后缀伪装拒绝");
  assert.equal(parseGithubRepo("/srv/git/origin.git"), undefined, "本地路径拒绝");
  assert.equal(parseGithubRepo(""), undefined);
});

test("maskSecrets：PAT 前缀族 + URL 内嵌凭据（AC-12）", () => {
  assert.ok(!maskSecrets("token ghp_abcdefghijklmnop0123 leaked").includes("ghp_"));
  assert.ok(maskSecrets("ghp_abcdefghijklmnop0123").includes("[redacted]"));
  assert.ok(!maskSecrets("github_pat_11ABCDEFGH_abcdefghij0123").includes("github_pat_11"));
  const masked = maskSecrets("https://x-access-token:ghs_secretvalue123456@github.com/o/r");
  assert.ok(!masked.includes("ghs_secretvalue123456"), `URL 凭据应脱敏：${masked}`);
});

test("githubTaskPrompt：issue 标题+正文快照+任务分支（AC-4 输入面）", () => {
  const p = githubTaskPrompt(TASK);
  assert.ok(p.includes("#901"));
  assert.ok(p.includes("修复登录闪烁"));
  assert.ok(p.includes("复现步骤 BODY"));
  assert.ok(p.includes(TASK.branch));
});

test("happy path：fetch→checkout -B→invoke→add/status/commit/push→done+pushedBranch（AC-5/8）", async () => {
  const calls: string[][] = [];
  const seen: Array<{ prompt: string; cwd: string }> = [];
  const git = fakeGit(
    [OK_REMOTE, ["status --porcelain", { stdout: "M fix.txt\n" }]],
    calls,
  );
  const report = await executeGithubTask(TASK, { repoDir: "/repo", git, invoke: fakeInvoke({}, seen) });
  assert.equal(report.outcome, "done");
  assert.equal(report.pushedBranch, TASK.branch, "push 目标 = 入队定型任务分支（PR-only AC-8）");
  assert.equal(report.exitCode, 0);
  const keys = calls.map((a) => a.join(" "));
  const idx = (prefix: string) => keys.findIndex((k) => k.startsWith(prefix));
  assert.ok(idx("fetch origin main") >= 0, "先 fetch 默认分支");
  assert.ok(keys.includes(`checkout -B ${TASK.branch} origin/main`), "基于 origin/main 建任务分支");
  assert.ok(idx("add -A") > idx("checkout"), "invoke 后 add");
  assert.ok(idx("commit -m") > idx("add -A"));
  assert.ok(keys.includes(`push -u origin ${TASK.branch}`), "push 任务分支");
  assert.ok(!keys.some((k) => k.startsWith("push") && k.includes("main")), "绝不直推默认分支（AC-8）");
  assert.equal(seen.length, 1);
  assert.ok(seen[0].prompt.includes("复现步骤 BODY"), "prompt 携带 issue 快照");
  assert.equal(seen[0].cwd, "/repo");
});

test("remote 不一致 → failed repo_mismatch，invoke/fetch 零调用（AC-4 零执行）", async () => {
  const calls: string[][] = [];
  const seen: Array<{ prompt: string; cwd: string }> = [];
  const git = fakeGit(
    [["config --get remote.origin.url", { stdout: "https://github.com/evil/other-repo.git\n" }]],
    calls,
  );
  const report = await executeGithubTask(TASK, { repoDir: "/repo", git, invoke: fakeInvoke({}, seen) });
  assert.equal(report.outcome, "failed");
  assert.match(report.errorText ?? "", /^repo_mismatch/);
  assert.ok((report.errorText ?? "").includes("tunsuy/agentory"), "原因指明绑定仓库");
  assert.equal(seen.length, 0, "零执行");
  const keys = calls.map((a) => a.join(" "));
  assert.ok(!keys.some((k) => k.startsWith("fetch")), "不一致时不 fetch");
  assert.ok(!keys.some((k) => k.startsWith("checkout")), "不一致时不动工作区");
  assert.ok(!report.errorText?.includes("evil/other-repo"), "不回显 remote URL（可能含凭据）");
});

test("非 git 目录 / 无 origin → failed 诚实回流", async () => {
  const calls: string[][] = [];
  const git = fakeGit([["rev-parse --show-toplevel", { code: 128, stderr: "not a git repository" }]], calls);
  const report = await executeGithubTask(TASK, {
    repoDir: "/nope",
    git,
    invoke: fakeInvoke({}, []),
  });
  assert.equal(report.outcome, "failed");
  assert.match(report.errorText ?? "", /^not_a_git_repo/);
});

test("invoke failed/timeout 原样回流：不 commit 不 push（AC-6）", async () => {
  for (const outcome of ["failed", "timeout"] as const) {
    const calls: string[][] = [];
    const git = fakeGit([OK_REMOTE], calls);
    const report = await executeGithubTask(TASK, {
      repoDir: "/repo",
      git,
      invoke: fakeInvoke(
        { outcome, output: "partial", truncated: false, exitCode: outcome === "failed" ? 7 : null, durationMs: 12, errorText: "boom" },
        [],
      ),
    });
    assert.equal(report.outcome, outcome);
    assert.equal(report.exitCode, outcome === "failed" ? 7 : null);
    assert.match(report.errorText ?? "", /^execution: boom/);
    const keys = calls.map((a) => a.join(" "));
    assert.ok(!keys.some((k) => k.startsWith("push")), `${outcome} 不 push`);
    assert.ok(!keys.some((k) => k.startsWith("commit")), `${outcome} 不 commit`);
  }
});

test("无改动 → failed no_changes（诚实,不开空 PR）", async () => {
  const calls: string[][] = [];
  const git = fakeGit([OK_REMOTE, ["status --porcelain", { stdout: "" }]], calls);
  const report = await executeGithubTask(TASK, { repoDir: "/repo", git, invoke: fakeInvoke({}, []) });
  assert.equal(report.outcome, "failed");
  assert.match(report.errorText ?? "", /^no_changes/);
  const keys = calls.map((a) => a.join(" "));
  assert.ok(!keys.some((k) => k.startsWith("push")));
});

test("fetch/push 失败 → 脱敏 errorText 回流（AC-12）", async () => {
  const fetchCalls: string[][] = [];
  const fetchFail = await executeGithubTask(TASK, {
    repoDir: "/repo",
    git: fakeGit([OK_REMOTE, ["fetch origin", { code: 1, stderr: "fatal: unable to access 'https://x-access-token:ghs_secretvalue123456@github.com/…'" }]], fetchCalls),
    invoke: fakeInvoke({}, []),
  });
  assert.equal(fetchFail.outcome, "failed");
  assert.match(fetchFail.errorText ?? "", /^fetch_failed/);
  assert.ok(!(fetchFail.errorText ?? "").includes("ghs_secretvalue123456"), "凭据脱敏");
  assert.ok((fetchFail.errorText ?? "").length <= 200, "截短同控制面口径");

  const pushCalls: string[][] = [];
  const pushFail = await executeGithubTask(TASK, {
    repoDir: "/repo",
    git: fakeGit(
      [OK_REMOTE, ["status --porcelain", { stdout: "M a\n" }], ["push -u origin", { code: 1, stderr: "remote: Invalid PAT ghp_abcdefghijklmnop0123" }]],
      pushCalls,
    ),
    invoke: fakeInvoke({}, []),
  });
  assert.equal(pushFail.outcome, "failed");
  assert.match(pushFail.errorText ?? "", /^push_failed/);
  assert.ok(!(pushFail.errorText ?? "").includes("ghp_"), "PAT 脱敏");
});
