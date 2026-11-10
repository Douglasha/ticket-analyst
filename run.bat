@echo off
chcp 65001 >nul
title GLPI Ticket Analyst + LLM Local (Ollama)
cls

echo ==========================================================
echo    INICIANDO SERVICOS: LLM (OLLAMA) + GLPI TICKET ANALYST
echo ==========================================================
echo.

:: 1. Iniciar Ollama se nao estiver rodando
tasklist /fi "imagename eq ollama.exe" 2>nul | find /i "ollama.exe" >nul
if errorlevel 1 (
    echo [...] Iniciando servico de LLM Local (Ollama)...
    if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
        start "Ollama LLM Server" /min "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve
    ) else (
        start "Ollama LLM Server" /min ollama serve
    )
    timeout /t 2 /nobreak >nul
    echo [OK] Ollama iniciado em segundo plano (http://localhost:11434).
) else (
    echo [OK] Servico Ollama ja esta em execucao.
)

echo.
:: 2. Iniciar GLPI Ticket Analyst
echo [...] Iniciando servidor web do GLPI Ticket Analyst...
echo [INFO] Abrindo navegador em http://localhost:8000
start "" http://localhost:8000

echo.
echo ==========================================================
echo  Pressione CTRL+C para encerrar o servidor Node.
echo ==========================================================
echo.

node src/server.js
