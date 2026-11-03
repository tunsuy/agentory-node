#!/usr/bin/env bash
# OSS 仓精简 pr-merge：等 CI 全绿再 squash。无 Brief/Accept 闸。
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

TIMEOUT_SEC="${PR_MERGE_TIMEOUT_SEC:-1800}"
INTERVAL_SEC="${PR_MERGE_INTERVAL_SEC:-10}"
deadline=$((SECONDS + TIMEOUT_SEC))
GRACE_SEC="${PR_MERGE_NO_CI_GRACE_SEC:-30}"
no_ci_confirmed=0

echo "==> pr-merge: waiting for CI on PR #${PR} (timeout ${TIMEOUT_SEC}s)"
while true; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "REFUSE: timed out waiting for CI on PR #${PR}" >&2
    gh pr checks "$PR" 2>&1 || true
    exit 1
  fi
  set +e
  out="$(gh pr checks "$PR" --json name,bucket,state 2>/dev/null)"
  ec=$?
  set -e
  if [ "$ec" -eq 1 ]; then
    if [ "$no_ci_confirmed" -eq 0 ]; then
      no_ci_confirmed=$SECONDS
      echo "… no CI checks; grace ${GRACE_SEC}s"
    elif [ $((SECONDS - no_ci_confirmed)) -ge "$GRACE_SEC" ]; then
      echo "==> no CI workflow — merge gate = review only"
      break
    fi
    sleep "$INTERVAL_SEC"
    continue
  fi
  if [ "$ec" -eq 0 ] || [ "$ec" -eq 8 ]; then
    count="$(printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 0)' 2>/dev/null || echo 0)"
    if [ "${count:-0}" -gt 0 ]; then
      break
    fi
  fi
  sleep "$INTERVAL_SEC"
done

if [ "$no_ci_confirmed" -eq 0 ]; then
  set +e
  gh pr checks "$PR" --watch --fail-fast --interval "$INTERVAL_SEC"
  watch_ec=$?
  set -e
  if [ "$watch_ec" -ne 0 ]; then
    echo "REFUSE: CI failed on PR #${PR}" >&2
    gh pr checks "$PR" 2>&1 || true
    exit 1
  fi
  bad="$(gh pr checks "$PR" --json name,bucket 2>/dev/null | python3 -c '
import json, sys
rows = json.load(sys.stdin)
ok = {"pass", "skipping"}
print("\n".join(r.get("name","?") for r in rows if r.get("bucket") not in ok))
')"
  if [ -n "$bad" ]; then
    echo "REFUSE: non-green checks:" >&2
    printf '%s\n' "$bad" | sed 's/^/  /' >&2
    exit 1
  fi
fi

echo "==> pr-merge: squash merging PR #${PR}"
gh pr merge "$PR" --squash --delete-branch
echo "PR #${PR} merged ✓"
