@echo off
title FreeLLMAPI Gateway
cd /d "%~dp0\server"
echo Starting FreeLLMAPI on http://127.0.0.1:3001 ...
node dist/index.js
pause
