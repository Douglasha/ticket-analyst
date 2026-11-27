#!/bin/bash
# ==============================================================================
# Script de Atualização Contínua em Produção — GLPI Ticket Analyst
# Unimed Sudoeste de Minas / Hospital Unimed
# ==============================================================================

set -e

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

echo "=========================================================="
echo "🔄 [1/4] Verificando atualizações no GitHub..."
echo "=========================================================="
git fetch origin main

LOCAL_HASH=$(git rev-parse HEAD)
REMOTE_HASH=$(git rev-parse origin/main)

if [ "$LOCAL_HASH" = "$REMOTE_HASH" ]; then
    echo "✅ O sistema já está na versão mais recente ($LOCAL_HASH)."
    echo "Nenhuma atualização pendente."
    exit 0
fi

echo "⬇️ [2/4] Baixando novidades do repositório remoto..."
git pull origin main

echo "🐳 [3/4] Recompilando e reiniciando o container da aplicação..."
docker compose up -d --build app

echo "🩺 [4/4] Verificando integridade dos serviços..."
sleep 3
docker compose ps

echo "=========================================================="
echo "🎉 Atualização concluída com sucesso!"
echo "Versão ativa: $(git log -1 --pretty=format:'%h - %s (%cr)')"
echo "=========================================================="
