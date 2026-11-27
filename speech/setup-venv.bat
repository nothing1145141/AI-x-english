@echo off
chcp 936 >nul
setlocal
title WordWise - 安装本地语音评测环境
cd /d "%~dp0.."

echo.
echo  ==================================================
echo   WordWise 本地语音评测环境（基础能力零依赖）
echo  ==================================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo  [错误] 未找到 python，请先安装 Python 3.10-3.12 并加入 PATH。
  echo.
  pause
  exit /b 1
)

if exist ".venv\Scripts\python.exe" (
  echo  [信息] .venv 已存在，直接自检...
) else (
  echo  [1/2] 创建虚拟环境 .venv ...
  python -m venv .venv
  if errorlevel 1 goto :fail
)

echo  [2/2] 自检语音服务模块 ...
".venv\Scripts\python.exe" -m py_compile speech\server.py
if errorlevel 1 goto :fail
".venv\Scripts\python.exe" speech\server.py --selftest
if errorlevel 1 goto :fail

echo.
echo  [完成] 基础语音评测能力已就绪（无需额外模型）。
echo.
echo  可选增强：
echo    .venv\Scripts\python.exe -m pip install faster-whisper -i https://pypi.tuna.tsinghua.edu.cn/simple
echo    然后设置环境变量 OPENPRONOUNCE_CMD 接入音素级发音评估。
echo.
pause
exit /b 0

:fail
echo.
echo  [失败] 安装或自检出错，请检查 Python 版本后重试。
echo.
pause
exit /b 1
