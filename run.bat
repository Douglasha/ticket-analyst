@echo off
title GLPI Ticket Analyst - Copiloto de Triagem T.I. (Node.js)

if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
  echo Verificando/Iniciando servico de LLM Local (Ollama)...
  start "Ollama LLM Server" /min "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve
)

echo Iniciando GLPI Ticket Analyst (Node.js) em http://localhost:8000 ...
start "" http://localhost:8000
node src/server.js
