#!/usr/bin/env bash
# 一条命令把云端要用的三个 secret 配好。只需要粘贴一次 key。
set -euo pipefail

REPO="HeYanXing-Tap/game-radar"
BASE_DEFAULT="https://llm-proxy.tapsvc.com/v1"
MODEL_DEFAULT="deepseek/deepseek-flash"

command -v gh >/dev/null || { echo "没找到 gh，请先装 GitHub CLI"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh 还没登录，先跑 gh auth login"; exit 1; }

echo "仓库：$REPO"
echo

read -r -p "接口地址（回车用默认）[$BASE_DEFAULT]: " BASE
BASE="${BASE:-$BASE_DEFAULT}"

read -r -p "打分模型（回车用默认）[$MODEL_DEFAULT]: " MODEL
MODEL="${MODEL:-$MODEL_DEFAULT}"

printf '粘贴 API Key（输入时不会显示）: '
stty -echo
read -r KEY
stty echo
echo
[ -n "${KEY:-}" ] || { echo "❌ 没读到 key，什么都没改"; exit 1; }
case "$KEY" in
  *" "*) echo "⚠️  key 里有空格，可能是粘贴时带了首尾空白，已自动去掉"; KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')" ;;
esac

echo
echo "正在写入三个 secret ……"
gh secret set LLM_BASE_URL -R "$REPO" --body "$BASE"
gh secret set LLM_MODEL    -R "$REPO" --body "$MODEL"
printf '%s' "$KEY" | gh secret set LLM_API_KEY -R "$REPO"

echo
echo "✅ 写入完成，当前仓库的 secret："
gh secret list -R "$REPO"
echo
echo "下一步：跑一次云端任务验证"
echo "  gh workflow run daily.yml -R $REPO"
