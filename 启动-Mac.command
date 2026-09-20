#!/bin/bash
# 双击这个文件就能开工作台（Mac）
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  没找到 Node.js —— 先去 https://nodejs.org 下载 LTS 版装上，再双击这个文件。"
  echo "  （装完要把这个窗口关掉重开一次）"
  echo ""
  open "https://nodejs.org/zh-cn/download" 2>/dev/null
  read -r -p "  按回车关闭…" _
  exit 1
fi

echo "  正在启动，浏览器会自动打开…（关掉这个窗口就等于关掉工作台）"
node web/server.js
read -r -p "  服务已停止，按回车关闭…" _
