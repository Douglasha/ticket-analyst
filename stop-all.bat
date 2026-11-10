@echo off
chcp 65001 >nul
title Encerrando GLPI Ticket Analyst + LLM
echo ==========================================================
echo    ENCERRANDO SERVICOS: LLM (OLLAMA) + NODE.JS
echo ==========================================================
echo.
echo Encerrando processo do Ollama...
taskkill /f /im ollama.exe 2>nul
taskkill /f /im ollama_app.exe 2>nul
echo.
echo Encerrando processos Node.js do Ticket Analyst...
powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*server.js*' } | Stop-Process -Force" 2>nul
echo.
echo [OK] Servicos encerrados com sucesso.
timeout /t 2 /nobreak >nul
