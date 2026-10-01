---
trigger: always_on
description: Contexto arquitetural, regras de negócio da Unimed Sudoeste de Minas / Hospital Unimed e diretrizes de manutenção do projeto GLPI Ticket Analyst.
---

# Contexto Oficial do Projeto — GLPI Ticket Analyst (Unimed)

Este arquivo garante que qualquer sessão do **Antigravity** (seja no Desktop ou no **Antigravity Web** via repositório GitHub `https://github.com/Douglasha/ticket-analyst.git`) carregue automaticamente todo o histórico de decisões, arquitetura e regras de negócio do sistema.

## 1. Visão Geral e Ambiente
- **Organização:** Setor de T.I. da **Unimed Sudoeste de Minas / Hospital Unimed**.
- **Objetivo:** Copiloto de triagem e tratativa prévia de chamados integrado à API REST do GLPI (`http://192.168.41.125/apirest.php`) e ao Ollama local (`qwen2.5:3b`, além de suporte a Gemini e OpenAI).
- **Execução do Servidor:** Rodar com `node src/server.js` (evitar `node --watch` em produção Windows para que scans do Windows Defender em `node_modules` não reiniciem o processo durante chamadas longas de SMTP do GLPI ao enviar `ITILFollowup`).

## 2. Regras de Negócio e Triagem Consolidadas
1. **Filtro do Grupo T.I na 2ª Camada (`src/glpiClient.js` -> `fetchResolvedHistory`):**
   - A 2ª Camada (*Histórico de Chamados Resolvidos*, persistida cumulativamente em `data/resolved_history.json`) deve conter **exclusivamente chamados atribuídos ao grupo `T.I`** (`Group ID = 12`, vínculo `type = 2` em `/Group/12/Group_Ticket`).
2. **Reclassificação Interativa de Categorias no GLPI:**
   - Muitos usuários abrem chamados em categorias genéricas ou equivocadas (ex.: `T.I > ST > Instalação/Configuração > Sistemas Operacionais` ou `Aplicativos`).
   - O sistema compara `ticket.category` com `analysis.suggested_category` e exibe o card **"Sugestão de Reclassificação de Categoria no GLPI"** (`#category-reclass-box`), permitindo atualizar o `itilcategories_id` no GLPI em 1 clique (`PUT /api/tickets/:ticketId/category`).
3. **Suficiência de Informações (`COMPLETO` vs. `PARCIAL` / `INCOMPLETO`):**
   - Nunca pedir ID do HopToDesk ou perguntas genéricas quando o chamado já contém todos os dados necessários para execução (ex.: cancelamento de registro no Controle de Contas com número e nome informados, relatório agendado do S.G.H. com título informado, ou liberação de dispositivo no Meu Ponto Benner com nome da colaboradora informado).
4. **Playbooks Específicos da Unimed (`data/playbooks.json` e `src/aiAnalyst.js`):**
   - `PB-UNI-12` (**Acesso e Permissões para Médicos/Prestadores**): Verifica se o solicitante preencheu os próprios dados no formulário em vez dos dados do médico/terceiro e se especificou os sistemas. Caso envolva **Controle de Acesso / Reconhecimento Facial nas portas do Hospital**, exige o envio de **fotografia frontal e com expressão neutra do rosto** da pessoa a ser cadastrada.
   - `PB-UNI-13` (**Cancelamento de Registro no Controle de Contas**): Acionado apenas quando há intenção de cancelamento/exclusão/erro de lançamento (`cancelar`, `excluir`, `cadastrada por engano`).
   - `PB-UNI-14` (**Relatórios Agendados do S.G.H. / Spdata**): Trata interrupções no recebimento diário de relatórios agendados no S.G.H.
   - `PB-UNI-15` (**Vinculação de Acesso/Unidade em Sistema Interno**): Trata pedidos como *"vincular o controle de contas de Piumhi ao meu usuário"*, sugerindo reclassificação para `T.I > ST > Acesso e Permissões`.
   - `PB-UNI-16` (**Extração de Indicadores e Relatórios Gerenciais — WConect / BI**): Sugere reclassificação para `T.I > BD > Big Data e BI > Relatórios` e solicita o período de apuração caso não informado.
   - `PB-UNI-17` (**App Meu Ponto / Benner — Dispositivo Não Válido**): Quando o erro diz *"Esse dispositivo não é válido para o usuário logado"*, significa que o colaborador trocou de celular, sendo necessário desvincular o aparelho antigo e vincular o novo dispositivo ao login no Benner.
   - `PB-UNI-18` (**Criação / Alteração de Agenda de Profissional no PEP / SGH**): Parametrização de grade de horários, duração de atendimento e intervalos de profissionais de saúde no PEP/SGH, sugerindo reclassificação para `T.I > ST > Instalação/Configuração > Aplicativos` quando aberto em `Sistemas Operacionais`.
   - `PB-UNI-19` (**Unificação de Cadastros Duplicados — HRP Unimed / PEP / SGH**): Trata duplicidade de cadastros de beneficiário/paciente (ex.: *Cliente Intercâmbio* x *Cliente Saúde*), sugerindo reclassificação para `T.I > BD > Administração de Banco de Dados` e garantindo que roteiros técnicos internos de banco nunca sejam incluídos na resposta pública ao solicitante.
   - `PB-UNI-20` (**Remanejamento Físico de Equipamentos e Instalação de Ponto de Telefone / Rede**): Diferencia pedidos de mudança de local de impressora/computador (ex.: *trocar impressora Zebra do balcão da farmácia para o almoxarifado e colocar ponto de telefone*) de falhas de impressão (`PB-SD-02`).
   - `PB-UNI-21` (**Instabilidade de Internet / Instalação de Roteador Wi-Fi**): Trata pedidos de instalação de roteador Wi-Fi ou instabilidade de internet afetando chamadas de WhatsApp do setor, prevenindo falsos positivos com playbooks de faturamento/TISS (`PB-UNI-03`).
5. **Aprendizado Contínuo (`data/learned_feedback.json`):**
   - Toda orientação dada via **"Orientar IA"** (`custom_instruction`) ou resposta pública enviada ao GLPI é registrada automaticamente em `data/learned_feedback.json` e consultada pelo `KnowledgeEngine`.
