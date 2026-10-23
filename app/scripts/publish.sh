#!/usr/bin/env bash
# 把「本地跑出来的结果」发布到线上：导出 → 同步 docs/ → 提交 → 推送
# 本地和云端用的是同一个数据库文件，所以本地打完分，提交上去就同步了。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[1/4] 导出静态数据"
node --disable-warning=ExperimentalWarning src/cli.ts export

echo "[2/4] 同步到 docs/"
rm -rf ../docs/data
mkdir -p ../docs
cp -R public/. ../docs/

echo "[3/4] 提交"
git -C .. add -A
if git -C .. diff --cached --quiet; then
  echo "  没有变化，跳过提交"
else
  git -C .. commit -qm "publish: 本地打分结果 $(date '+%Y-%m-%d %H:%M')"
  echo "[4/4] 推送"
  git -C .. push
fi

echo
echo "已发布。线上地址 https://heyanxing-tap.github.io/game-radar/"
