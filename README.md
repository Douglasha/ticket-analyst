# GLPI Ticket Analyst — Copiloto de Triagem e Tratativa Prévia (Node.js)

Ferramenta web em **Node.js (Express)** integrada à **API REST do GLPI**, desenhada para reduzir o desgaste de interpretar relatos vagos ("usuariês"), checar se faltam informações, buscar soluções nas 3 camadas de conhecimento e gerar tanto o **Roteiro Técnico de Resolução** quanto a **Resposta Sugerida ao Solicitante**.

---

## Arquitetura do Projeto (Node.js)

- [`package.json`](package.json) — Dependências e scripts (`npm start` e `npm run dev`).
- [`src/server.js`](src/server.js) — Servidor Express e rotas da API REST (`/api/tickets`, `/api/knowledge`, `/api/playbooks`, `/api/settings`).
- [`src/glpiClient.js`](src/glpiClient.js) — Cliente da API REST do GLPI (`initSession`, `Ticket`, `ITILFollowup`, `KnowbaseItem`, `ITILSolution`) + Modo Simulação realista.
- [`src/knowledgeEngine.js`](src/knowledgeEngine.js) — Motor de busca híbrida em 3 Camadas:
  - **1ª Camada:** Base de Conhecimento Oficial do GLPI (`KnowbaseItem`)
  - **2ª Camada:** Histórico de Chamados Resolvidos no GLPI (`Ticket` + `ITILSolution`)
  - **3ª Camada:** Playbooks Locais da T.I. ([`data/playbooks.json`](data/playbooks.json))
- [`src/aiAnalyst.js`](src/aiAnalyst.js) — Agente de Triagem com suporte a **Google Gemini**, **OpenAI**, **Ollama Local** e **Motor Heurístico 3 Camadas**.
- [`static/index.html`](static/index.html), [`static/app.js`](static/app.js), [`static/styles.css`](static/styles.css) — Interface Web limpa com Google Material Symbols.

---

## Como Executar

Basta dar dois cliques em [`run.bat`](run.bat) ou executar no terminal:

```powershell
npm run dev
```

Depois, acesse no navegador: **http://localhost:8000**
