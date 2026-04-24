@echo off
chcp 65001 >nul
title 六脈 LIUMAI · 台股 AI 戰情艙
echo =====================================================
echo    六脈 LIUMAI · 台股 AI 戰情艙
echo    六識盤面 · 一劍斷勢
echo =====================================================
echo.
cd /d "%~dp0"

REM 找 python
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo [X] 找不到 python，請先安裝 Python 3.8+ https://www.python.org/downloads/
    pause
    exit /b 1
)

REM 背景啟動 server，然後自動開啟瀏覽器
start "" "http://127.0.0.1:8787/"
python server.py

pause
