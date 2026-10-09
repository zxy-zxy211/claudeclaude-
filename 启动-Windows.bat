@echo off
chcp 65001 >nul
rem 双击这个文件就能开工作台（Windows）
cd /d "%~dp0"
title 银柴火 · 编导 AI 工作台

if not exist "web\server.js" (
  echo.
  echo   这里找不到 web\server.js，当前位置是：
  echo   %CD%
  echo.
  echo   两种常见原因：
  echo   1. 直接在压缩包里双击了 —— 要先解压到一个文件夹，再双击解压出来的这个文件
  echo   2. 这个文件被单独拷了出来 —— 它必须和 web 文件夹放在同一层
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没找到 Node.js —— 先去 https://nodejs.org 下载 LTS 版装上，再双击这个文件。
  echo   （装完要把这个窗口关掉重开一次）
  start "" "https://nodejs.org/zh-cn/download"
  pause
  exit /b 1
)

echo   正在启动，浏览器会自动打开…（关掉这个窗口就等于关掉工作台）
echo.
node web\server.js
echo.
echo   服务已停止。上面若有红色报错，把它截图发给 Claude。
pause
