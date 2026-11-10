# ==========================================================
# GLPI Ticket Analyst - Inicializador de LLM + Servidor Web
# ==========================================================
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   GLPI TICKET ANALYST - INICIANDO LLM + SERVIDOR         " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Verificar e Iniciar Ollama
$ollamaPath = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"
$ollamaRunning = Get-Process -Name "ollama*" -ErrorAction SilentlyContinue

if ($ollamaRunning) {
    Write-Host "[OK] Servico Ollama (LLM) ja esta em execucao." -ForegroundColor Green
} else {
    if (Test-Path $ollamaPath) {
        Write-Host "[...] Iniciando servico de LLM Local (Ollama)..." -ForegroundColor Yellow
        Start-Process -FilePath $ollamaPath -ArgumentList "serve" -WindowStyle Hidden
        Start-Sleep -Seconds 2
        Write-Host "[OK] Ollama iniciado em segundo plano (http://localhost:11434)." -ForegroundColor Green
    } else {
        $cmdOllama = Get-Command "ollama" -ErrorAction SilentlyContinue
        if ($cmdOllama) {
            Write-Host "[...] Iniciando servico de LLM Local (Ollama)..." -ForegroundColor Yellow
            Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
            Start-Sleep -Seconds 2
            Write-Host "[OK] Ollama iniciado em segundo plano (http://localhost:11434)." -ForegroundColor Green
        } else {
            Write-Host "[AVISO] Executavel do Ollama nao localizado automaticamente em $ollamaPath." -ForegroundColor Red
        }
    }
}

Write-Host ""

# 2. Iniciar o servidor Node.js
Write-Host "[...] Iniciando servidor do GLPI Ticket Analyst (Node.js)..." -ForegroundColor Yellow
Write-Host "[INFO] Interface Web acessivel em: http://localhost:8000" -ForegroundColor Cyan
Write-Host "[INFO] Pressione CTRL+C nesta janela para parar o servidor." -ForegroundColor Gray
Write-Host "----------------------------------------------------------" -ForegroundColor DarkGray

node src/server.js
