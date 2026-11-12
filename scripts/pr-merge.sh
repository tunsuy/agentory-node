#!/usr/bin/env bash
# 等 PR CI 全绿再 squash merge（OSS 精简版——无 check-ship/handoff 步骤；
# 完整版见私有仓 scripts/pr-merge.sh）。裸 `gh pr merge` 由 agent hooks 硬拦。
#
# 用法:
#   make pr-merge PR=12
#   bash scripts/pr-merge.sh 12
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PR="${1:-${PR:-}}"
if [ -z "$PR" ]; then
  PR="$(gh pr view --json number -q .number 2>/dev/null || true)"
fi
if [ -z "$PR" ]; then
  echo "Usage: make pr-merge PR=<n>" >&2
  exit 2
fi

echo "==> pr-merge(oss): waiting for CI on PR #${PR}"
if ! gh pr checks "$PR" --watch --fail-fast --interval 10; then
  echo "REFUSE: CI failed or incomplete on PR #${PR}; fix then re-run" >&2
  exit 1
fi

echo "==> pr-merge(oss): CI green; squash merging PR #${PR}"
gh pr merge "$PR" --squash --delete-branch
echo "PR #${PR} merged ✓"
