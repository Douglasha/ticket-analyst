# GLPI Ticket Analyst — Copiloto de Triagem e Tratativa Prévia (Unimed)

Plataforma web em **Node.js (Express)** integrada em tempo real à **API REST do GLPI**, projetada para a equipe de **T.I. da Unimed Sudoeste de Minas / Hospital Unimed**.

O sistema automatiza a triagem de chamados abertos pelos colaboradores, traduz relatos vagos ("usuariês") em diagnósticos técnicos objetivos, identifica informações faltantes no formulário, sugere e executa a **reclassificação de categorias no GLPI**, consulta **3 camadas de conhecimento + memória de aprendizado contínuo** e gera tanto a **Nota Técnica Privada** quanto a **Resposta Pública ao Solicitante**.

---

## Principais Funcionalidades

### 1. Integração Completa com a API REST do GLPI
- **Sincronização em Tempo Real (`GET /Ticket`):** Lista apenas chamados ativos (Novos, Em Atendimento e Pendentes), ocultando automaticamente chamados já Solucionados (`5`), Fechados (`6`) ou na Lixeira (`is_deleted = 1`).
- **Extração Inteligente de Formulários (`FormCreator`):** Interpreta automaticamente os campos estruturados do GLPI (`Tipo de Solicitação`, `Setor Solicitante`, `Localização`, `Título`, `Ativos`, `Nome do Colaborador`, `CPF`, `Acessos`, `Motivo`, `Problema`, `Aplicação` e `Descrição`), limpando tags HTML e entidades codificadas.
- **Envio Direto de Acompanhamentos (`POST /Ticket/:id/ITILFollowup`):**
  - Envia **Resposta Pública ao Solicitante** ou **Nota Técnica Privada** diretamente para o chamado no GLPI.
  - Opção integrada **"Mudar status do chamado para Pendente"** (`PUT /Ticket/:id` com `status = 4`), executada na mesma sessão autenticada para máxima velocidade.
- **Reclassificação Interativa de Categoria no GLPI (`GET /ITILCategory` + `PUT /Ticket/:id`):**
  - Carrega as **122 categorias reais do GLPI** da instituição.
  - Quando o solicitante abre o chamado em uma categoria inadequada (ex.: pediu *Indicadores WConect*, *Acesso ao Controle de Contas* ou *Erro no App Meu Ponto* dentro de *Sistemas Operacionais* ou *Aplicativos*), o sistema detecta a divergência e exibe o card **"Sugestão de Reclassificação de Categoria no GLPI"**.
  - Com **1 clique em "Acatar e Alterar no GLPI"**, o analista atualiza o `itilcategories_id` do chamado diretamente no GLPI, ou pode escolher qualquer outra categoria no seletor.
- **Destaque e Filtro de Rotinas Preventivas (`[R]`):**
  - Identifica tarefas preventivas recorrentes com sufixo `[R]`, posicionando-as ao final da fila e permitindo ocultá-las com o filtro rápido *"Ocultar rotinas [R]"*.

---

### 2. Motor de Conhecimento em 3 Camadas + Aprendizado Contínuo
Durante a análise de cada chamado, o motor de busca ([`src/knowledgeEngine.js`](src/knowledgeEngine.js)) consulta simultaneamente:

1. **1ª Camada — Base de Conhecimento Oficial do GLPI (`KnowbaseItem`):**
   - Artigos técnicos e procedimentos documentados oficialmente no GLPI.
2. **2ª Camada — Histórico Cumulativo de Chamados Resolvidos da T.I. (`ITILSolution` + `Group_Ticket`):**
   - Filtra estritamente chamados atribuídos ao **Grupo T.I (`Group ID = 12`, vínculo `type = 2`)**, ignorando chamados de outros setores (Manutenção, Auditoria Médica, Compras, etc.).
   - Armazena cumulativamente as soluções em [`data/resolved_history.json`](data/resolved_history.json), permitindo que a base cresça continuamente a cada chamado solucionado pela equipe.
3. **3ª Camada — Playbooks Locais de Processos da T.I. ([`data/playbooks.json`](data/playbooks.json)):**
   - Regras de negócio, checklists de informações obrigatórias (`required_info`), passos de resolução (`resolution_steps`) e templates de resposta padronizados da Unimed.
   - **Botão "Virar Playbook" (1 Clique):** Permite transformar a tratativa de qualquer chamado analisado ou de qualquer chamado resolvido da 2ª Camada em um Playbook oficial do setor.
4. **Memória de Aprendizado Contínuo ([`data/learned_feedback.json`](data/learned_feedback.json)):**
   - Aprende automaticamente sempre que o analista utiliza o recurso **"Orientar IA"** (`custom_instruction`) ou envia uma resposta pública ajustada para o GLPI.
   - Em chamados futuros com o mesmo contexto técnico, reutiliza o padrão aprendido sem exigir retrabalho.

---

### 3. Agente de Triagem e Diagnóstico Inteligente ([`src/aiAnalyst.js`](src/aiAnalyst.js))
- **Múltiplos Provedores de IA:** Suporte configurável para **Ollama Local (`qwen2.5:3b`)**, **Google Gemini (`gemini-2.5-flash`)**, **OpenAI (`gpt-4o-mini`)** e **Copiloto Heurístico Especializado**.
- **Validação de Suficiência de Dados (`COMPLETO`, `PARCIAL`, `INCOMPLETO`):**
  - Nunca solicita dados que o usuário já informou na abertura (ex.: se o número do registro/paciente ou o título do relatório já estão no relato, marca como `COMPLETO` e não faz perguntas desnecessárias).
  - Detecta inconsistências específicas do dia a dia da Unimed, tais como:
    - **Cadastro/Acesso aberto por terceiro com dados trocados (`PB-UNI-12`):** Detecta quando a solicitante pede acesso para um médico/prestador, mas preenche o Nome e CPF do formulário com os próprios dados dela, ou deixa o campo `Acessos` como *"Outros"* sem especificar os sistemas. Inclui a exigência de **fotografia frontal com expressão neutra** caso solicite acesso ao **Controle de Acesso / Reconhecimento Facial nas portas do Hospital**.
    - **Cancelamento de Registro no Controle de Contas (`PB-UNI-13`):** Identifica o número do registro e nome do(a) paciente informados e confirma a execução imediata sem pedir detalhes redundantes.
    - **Relatórios Agendados do Sistema S.G.H. / Spdata (`PB-UNI-14`):** Identifica falhas no recebimento diário de relatórios agendados no S.G.H., extrai o título do relatório e confirma a verificação do serviço de disparo.
    - **Vinculação de Acesso/Unidade em Sistema Interno (`PB-UNI-15`):** Identifica pedidos de vinculação de unidade ao próprio usuário (ex.: *Controle de Contas de Piumhi*), sugere reclassificação para `T.I > ST > Acesso e Permissões` e confirma o atendimento.
    - **Extração de Indicadores e Relatórios Gerenciais (`PB-UNI-16`):** Identifica solicitações de indicadores (ex.: *Indicadores WConect por recepcionista*), sugere reclassificação para `T.I > BD > Big Data e BI > Relatórios` e cobra o período de referência caso não tenha sido informado.
    - **App Meu Ponto / Benner — Dispositivo Não Válido (`PB-UNI-17`):** Reconhece o erro *"Esse dispositivo não é válido para o usuário logado"* (decorrente de troca de aparelho celular), identifica a colaboradora afetada, sugere reclassificação para `T.I > ST > Resolução de Problemas > Erros de Sistema` e orienta sobre a liberação do novo dispositivo no Benner.

---

### 4. Autenticação e Segurança ([`src/auth.js`](src/auth.js))
- Login integrado às credenciais do próprio **GLPI** (ou usuário administrador local de contingência).
- Tokens de sessão assinados via **HMAC-SHA256** com proteção de rotas na API.

---

## Estrutura de Arquivos

- [`package.json`](package.json) — Dependências e scripts (`npm start` e `npm run dev`).
- [`src/server.js`](src/server.js) — Servidor Express e rotas da API REST (`/api/tickets`, `/api/glpi/categories`, `/api/knowledge`, `/api/playbooks`, `/api/settings`).
- [`src/glpiClient.js`](src/glpiClient.js) — Cliente da API REST do GLPI (`Ticket`, `ITILFollowup`, `ITILCategory`, `KnowbaseItem`, `ITILSolution`, `Group/12/Group_Ticket`).
- [`src/knowledgeEngine.js`](src/knowledgeEngine.js) — Extrator de campos do FormCreator e motor de busca nas 3 camadas + Memória Contínua.
- [`src/aiAnalyst.js`](src/aiAnalyst.js) — Motor de análise, regras de negócio da Unimed, inferência de categorias e integração com LLMs.
- [`src/config.js`](src/config.js) — Persistência de configurações, cache de análises, histórico cumulativo de chamados resolvidos e memória de aprendizado.
- [`data/playbooks.json`](data/playbooks.json) — Playbooks oficiais de processos da T.I. (`PB-UNI-01` a `PB-UNI-17`).
- [`data/resolved_history.json`](data/resolved_history.json) — Base cumulativa de chamados resolvidos atribuídos ao grupo T.I.
- [`data/learned_feedback.json`](data/learned_feedback.json) — Memória de aprendizado contínuo com as respostas e orientações do analista.
- [`static/index.html`](static/index.html), [`static/app.js`](static/app.js), [`static/styles.css`](static/styles.css) — Interface Web responsiva com tema claro/escuro.

---

## Como Executar (Servidor + LLM Local Ollama)

### 1. Subir o Serviço de LLM Local (Ollama)
O sistema utiliza por padrão o **Ollama** rodando localmente na porta `11434` com o modelo `qwen2.5:3b`.

- **No PowerShell (caso o Ollama já esteja no PATH):**
  ```powershell
  ollama serve
  ```
- **No PowerShell (caminho completo padrão de instalação no Windows):**
  ```powershell
  & "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" serve
  ```
- **Caso esteja em uma máquina nova e precise baixar o modelo pela primeira vez:**
  ```powershell
  & "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" pull qwen2.5:3b
  ```

### 2. Subir o Servidor do GLPI Ticket Analyst
Em outro terminal (ou dando dois cliques em [`run.bat`](run.bat), que já sobe o Ollama e o servidor Node.js automaticamente), execute:

```powershell
node src/server.js
```

Em seguida, acesse no navegador: **http://localhost:8000**

