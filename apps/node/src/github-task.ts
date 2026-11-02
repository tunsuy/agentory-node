// GitHub 任务执行器（github-tasks 切片 3 · ADR-007 拉模型第七通道）。
// 红线：纯出站零反连（只调控制面 API 与本地 git）；errorText 全脱敏（git 错误文本可能
// 含 remote 凭据——AC-12 令牌零明文）；invoke 走 claude-code adapter 默认权限（ADR-005
// 红线，adapter 内钉死不注入放宽 flag）；PR-only：push 目标恒为入队定型分支 task.branch
// （agentory/task-<id>），任何路径不直推默认分支（AC-8）。
import { execFile } from "node:child_process";
import type { InvokeResult } from "@agentoryhq/runtime-contract";

/** 控制面 pending 载荷（PendingGithubTask 同构；client.ts HTTP 面内联解析，messaging 判例）。 */
export type GithubTaskPayload = {
  id: string;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  branch: string;
  timeoutMs: number;
  maxOutputBytes: number;
};

/** 上报形状（控制面 GithubTaskReport 同构：outcome=done 时 pushedBranch 必有，AC-5）。 */
export type GithubTaskRunReport = {
  outcome: "done" | "failed" | "timeout";
  output: string;
  truncated: boolean;
  exitCode: number | null;
  durationMs: number;
  errorText?: string;
  pushedBranch?: string;
};

const ERROR_TEXT_CHARS = 200;
const GIT_OUTPUT_CAP = 16_384;

/** 令牌样式串脱敏（AC-12）：GitHub PAT 前缀族 + URL 内嵌凭据形态,一律 [redacted]。 */
export function maskSecrets(text: string): string {
  return text
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, "[redacted]")
    .replace(/\/\/[^/\s@]*:[^/\s@]*@/g, "//[redacted]@");
}

/** remote URL → owner/repo（https / ssh:// / git@ 三形态；非 github.com → undefined = 校验失败）。 */
export function parseGithubRepo(remoteUrl: string): { owner: string; repo: string } | undefined {
  const url = remoteUrl.trim();
  const patterns = [
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/,
  ];
  for (const p of patterns) {
    const m = p.exec(url);
    if (m) return { owner: m[1], repo: m[2] };
  }
  return undefined;
}

/** 失败原因文本：先脱敏、压空白、再截短（控制面 failureReason 200 字符同口径）。 */
function errText(prefix: string, detail: string): string {
  return `${prefix}: ${maskSecrets(detail).replace(/\s+/g, " ").trim()}`.slice(0, ERROR_TEXT_CHARS);
}

export type GitRunner = (
  args: string[],
  cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** 默认 git runner：execFile（零 shell 注入面）；输出封顶防爆、超时兜底防挂死。 */
export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: GIT_OUTPUT_CAP * 2, timeout: 120_000 },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string }) | null;
        const code = typeof e?.code === "number" ? e.code : e ? 1 : 0;
        resolve({
          code,
          stdout: String(stdout ?? "").slice(0, GIT_OUTPUT_CAP),
          stderr: String(stderr ?? "").slice(0, GIT_OUTPUT_CAP),
        });
      },
    );
  });

/** 任务 prompt（AC-4：输入 = issue 标题+正文入队快照）；git 收尾由宿主负责,agent 只改工作区。 */
export function githubTaskPrompt(task: GithubTaskPayload): string {
  return [
    `处理 GitHub issue #${task.issueNumber}：${task.issueTitle}`,
    "",
    task.issueBody,
    "",
    `直接在当前工作区（分支 ${task.branch}）完成此 issue；把改动留在工作区即可，git add/commit/push 由宿主负责。`,
  ].join("\n");
}

export type ExecuteDeps = {
  /** 仓库工作目录（实例项目目录,AC-4；client.ts 解析 env/cwd 后注入）。 */
  repoDir: string;
  /** 测试可注入假 git；缺省 = 真 execFile runner。 */
  git?: GitRunner;
  /** 执行注入（client.ts 接 claude-code adapter.invoke;单元测试接假实现）。 */
  invoke: (req: {
    prompt: string;
    timeoutMs: number;
    maxOutputBytes: number;
    cwd: string;
  }) => Promise<InvokeResult>;
};

/**
 * 执行单任务（纯函数面）：
 * ① git 工作区校验 → ② origin remote 与绑定仓库一致（不一致 → failed 零执行,AC-4）
 * → ③ fetch 默认分支 + checkout -B 任务分支（入队定型,PR-only AC-8）
 * → ④ invoke（claude-code headless 默认权限；超时 kill/截断承 messaging 判例）
 * → ⑤ done 且有改动 → commit + push 任务分支 → done + pushedBranch（AC-5）;
 *    failed/timeout 原样回流（不 commit 不 push,AC-6）;无改动 → failed no_changes（诚实,不开空 PR）。
 */
export async function executeGithubTask(
  task: GithubTaskPayload,
  deps: ExecuteDeps,
): Promise<GithubTaskRunReport> {
  const git = deps.git ?? runGit;
  const startedAt = Date.now();
  const fail = (errorText: string): GithubTaskRunReport => ({
    outcome: "failed",
    output: "",
    truncated: false,
    exitCode: null,
    durationMs: Date.now() - startedAt,
    errorText,
  });

  const topLevel = await git(["rev-parse", "--show-toplevel"], deps.repoDir);
  if (topLevel.code !== 0) {
    return fail(errText("not_a_git_repo", topLevel.stderr || "rev-parse failed"));
  }
  // 读配置原值而非 `remote get-url`：后者会应用 url.insteadOf 传输层重写（代理/凭据
  // 替换场景返回重写后 URL），身份校验必须看仓库声明的 origin（AC-4）。
  const remote = await git(["config", "--get", "remote.origin.url"], deps.repoDir);
  if (remote.code !== 0) return fail(errText("no_origin_remote", remote.stderr));
  const parsed = parseGithubRepo(remote.stdout);
  if (!parsed || parsed.owner !== task.repoOwner || parsed.repo !== task.repoName) {
    // 不回显 remote URL（可能含凭据）——只说与哪个绑定仓库不一致。
    return fail(`repo_mismatch: origin does not match binding ${task.repoOwner}/${task.repoName}`);
  }
  const fetched = await git(["fetch", "origin", task.defaultBranch], deps.repoDir);
  if (fetched.code !== 0) return fail(errText("fetch_failed", fetched.stderr));
  const checkout = await git(["checkout", "-B", task.branch, `origin/${task.defaultBranch}`], deps.repoDir);
  if (checkout.code !== 0) return fail(errText("checkout_failed", checkout.stderr));

  const result = await deps.invoke({
    prompt: githubTaskPrompt(task),
    timeoutMs: task.timeoutMs,
    maxOutputBytes: task.maxOutputBytes,
    cwd: deps.repoDir,
  });
  if (result.outcome !== "done") {
    return {
      outcome: result.outcome,
      output: result.output,
      truncated: result.truncated,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(result.errorText ? { errorText: errText("execution", result.errorText) } : {}),
    };
  }

  await git(["add", "-A"], deps.repoDir);
  const status = await git(["status", "--porcelain"], deps.repoDir);
  if (status.code !== 0) return fail(errText("status_failed", status.stderr));
  if (!status.stdout.trim()) return fail("no_changes: agent produced no workspace changes");
  const commit = await git(
    ["commit", "-m", `agentory: ${task.issueTitle} (#${task.issueNumber})`],
    deps.repoDir,
  );
  if (commit.code !== 0) return fail(errText("commit_failed", commit.stderr));
  const push = await git(["push", "-u", "origin", task.branch], deps.repoDir);
  if (push.code !== 0) return fail(errText("push_failed", push.stderr));
  return {
    outcome: "done",
    output: result.output,
    truncated: result.truncated,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    pushedBranch: task.branch,
  };
}
