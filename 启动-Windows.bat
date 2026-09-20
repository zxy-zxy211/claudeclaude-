@echo off
chcp 65001 >nul
rem 双击这个文件就能开工作台（Windows）
cd /d "%~dp0"

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
node web\server.js
pause
