#!/usr/bin/env bash
# Publish OSS npm packages in dependency order (requires npm login + 2FA or automation token).
# Usage:
#   ./scripts/npm-publish-oss.sh --dry-run
#   NPM_OTP=123456 ./scripts/npm-publish-oss.sh          # authenticator code
#   # or: enable 2FA + granular token with "Bypass 2FA", then plain ./scripts/npm-publish-oss.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DRY=()
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY=(--dry-run)
  echo "==> dry-run only"
fi

OTP_ARGS=()
if [[ -n "${NPM_OTP:-}" ]]; then
  OTP_ARGS=(--otp "$NPM_OTP")
  echo "==> using NPM_OTP for publish"
fi

npm run build

ORDER=(
  @agentoryhq/shared
  @agentoryhq/runtime-contract
  @agentoryhq/adapter-cursor
  @agentoryhq/adapter-claude-code
  @agentoryhq/node
)

for pkg in "${ORDER[@]}"; do
  echo "==> publish $pkg"
  if [[ ${#DRY[@]} -gt 0 ]]; then
    npm publish -w "$pkg" --access public "${DRY[@]}" ${OTP_ARGS[@]+"${OTP_ARGS[@]}"}
  else
    npm publish -w "$pkg" --access public ${OTP_ARGS[@]+"${OTP_ARGS[@]}"}
  fi
done

echo "OK: published ${#ORDER[@]} packages"
echo "verify: npm view @agentoryhq/node version && npx -y @agentoryhq/node version"
