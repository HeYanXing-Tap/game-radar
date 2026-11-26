#!/usr/bin/env bash
# 只剩一步：粘贴 key。其余 secret 已配好。
set -euo pipefail
REPO="HeYanXing-Tap/game-radar"
printf '粘贴 API Key（输入不显示），然后按回车：'
stty -echo
read -r KEY
stty echo
echo
KEY="$(printf '%s' "${KEY:-}" | tr -d '[:space:]')"
[ -n "$KEY" ] || { echo "❌ 没读到 key，什么都没改"; exit 1; }
printf '%s' "$KEY" | gh secret set LLM_API_KEY -R "$REPO"
echo "✅ 写好了，当前 secret："
gh secret list -R "$REPO"
echo
echo "云端任务会自动触发，稍等十几分钟看结果。"
