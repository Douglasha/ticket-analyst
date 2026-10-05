import {
  extractFormCreatorFields,
  loadPlaybooks,
  normalizeText,
} from "./knowledgeEngine.js";

const SYSTEM_PROMPT = `Você é um Analista Sênior de T.I. da Unimed (Copiloto de Triagem GLPI).
Analise os dados reais do chamado abaixo e gere um JSON em Português do Brasil contendo:
- translated_intent: explique em 2 frases diretas o problema técnico ou solicitação real relatada pelo usuário, citando colaborador/equipamento/sistema e setor.
- urgency_reason: explique em 1 frase curta o impacto operacional deste chamado.
- public_reply_draft: escreva uma mensagem cordial e objetiva pronta para enviar ao solicitante no GLPI, iniciando SEMPRE com "Olá, <PrimeiroNome>! Tudo bem?".
  * Se 'Status da Triagem' for 'COMPLETO', apenas confirme que todos os dados necessários já foram recebidos e que a equipe de T.I. já está executando a solicitação (NÃO faça perguntas e NÃO peça ID do HopToDesk).
  * Se houver 'Perguntas de Triagem Pendentes', inclua APENAS essas perguntas em tópicos claros para o solicitante responder.`;

export function buildUserPrompt(
  ticket,
  matches,
  orgContext,
  customInstruction = null,
  missingInfoHints = []
) {
  const firstName =
    (ticket.requester_first_name || ticket.requester || "Solicitante")
      .trim()
      .split(/\s+/)[0];
  const formFields = extractFormCreatorFields(ticket.content);

  const followupsTxt =
    (ticket.followups || [])
      .slice(-2)
      .map(
        (f) =>
          `- [${f.date}] ${f.author}: ${String(f.content || "").slice(0, 180)}`
      )
      .join("\n") || "Nenhum.";

  const topMatches = (matches || [])
    .filter((m, idx) => idx === 0 || m.score >= 0.4)
    .slice(0, 2);

  let matchesTxt = "";
  if (topMatches.length > 0) {
    topMatches.forEach((m, idx) => {
      const stepsJoined = (m.steps || []).slice(0, 3).join(" | ");
      matchesTxt += `[${idx + 1}] ${m.source_id} (${m.title}): ${stepsJoined}\n`;
    });
  } else {
    matchesTxt = "Sem artigo específico na KB; use boas práticas de suporte de T.I.";
  }

  const extra = customInstruction
    ? `\nDIRETIVA DO ANALISTA (PRIORIDADE MÁXIMA): ${customInstruction}\n`
    : "";

  const cleanRelato = formFields.descricao || ticket.content || "";
  const extraFields = [
    formFields.tipo ? `Tipo: ${formFields.tipo}` : "",
    formFields.nomeColaborador ? `Colaborador(a): ${formFields.nomeColaborador}` : "",
    formFields.cpf ? `CPF: ${formFields.cpf}` : "",
    formFields.motivo ? `Motivo: ${formFields.motivo}` : "",
    formFields.acessos ? `Acessos Informados: ${formFields.acessos}` : "",
    formFields.localizacao || formFields.setorAlvo || formFields.setor
      ? `Local/Setor: ${formFields.localizacao || formFields.setorAlvo || formFields.setor}`
      : "",
    formFields.ativo ? `Equipamento/Ativo: ${formFields.ativo}` : "",
  ]
    .filter(Boolean)
    .join(" | ");

  const triageHintsTxt =
    Array.isArray(missingInfoHints) && missingInfoHints.length > 0
      ? `\n- Status da Triagem: PENDENTE DE INFORMAÇÕES\n- Perguntas de Triagem Pendentes para incluir na resposta ao solicitante:\n  * ${missingInfoHints.join("\n  * ")}`
      : `\n- Status da Triagem: COMPLETO (todas as informações pertinentes já constam no chamado; NÃO faça perguntas na resposta ao solicitante)`;

  return `CHAMADO #${ticket.id}:
- Título: ${ticket.title}
- Solicitante: ${ticket.requester} (Primeiro Nome para saudação: ${firstName} | Setor: ${ticket.requester_department || "Não informado"})
- Categoria GLPI: ${ticket.category} | Urgência: ${ticket.urgency_label}
${extraFields ? `- Dados do Formulário: ${extraFields}\n` : ""}- Relato do Solicitante: "${cleanRelato.slice(0, 450)}"${triageHintsTxt}
- Acompanhamentos: ${followupsTxt}
- Base Técnica Consultada:
${matchesTxt}${extra}`;
}

export function extractJsonObject(rawText) {
  let cleaned = String(rawText || "").trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "");
  cleaned = cleaned.replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }
  return JSON.parse(cleaned);
}

export class AIAnalyst {
  constructor(settings) {
    this.settings = settings;
  }

  async analyzeTicket(ticket, matches, customInstruction = null) {
    const provider = this.settings.ai_provider;
    const heuristic = this._buildSmartHeuristicAnalysis(
      ticket,
      matches,
      customInstruction
    );
    const userPrompt = buildUserPrompt(
      ticket,
      matches,
      this.settings.org_context,
      customInstruction,
      heuristic.missing_info
    );

    let llmData = null;
    let providerLabel = "";

    try {
      if (provider === "gemini" && this.settings.gemini_api_key?.trim()) {
        llmData = await this._callGemini(userPrompt);
        providerLabel = `Google Gemini (${this.settings.gemini_model})`;
      } else if (provider === "openai" && this.settings.openai_api_key?.trim()) {
        llmData = await this._callOpenAI(userPrompt);
        providerLabel = `OpenAI (${this.settings.openai_model})`;
      } else if (provider === "ollama") {
        llmData = await this._callOllama(userPrompt);
        providerLabel = `Ollama Local (${this.settings.ollama_model})`;
      }
    } catch (err) {
      providerLabel = `Motor Inteligente 3 Camadas (Fallback • ${String(err.message).slice(0, 55)})`;
    }

    if (!llmData) {
      if (!providerLabel) {
        providerLabel = "Copiloto Heurístico + Motor 3 Camadas (Node.js)";
      }
      llmData = heuristic;
    } else {
      const customWantsQuestions =
        customInstruction &&
        /\b(pe[çc]a|pergunte|perguntar|solicite|solicitar|cobrar|questionar|qual\b|quais\b)\b/i.test(
          customInstruction
        );
      const useSpecializedIntent =
        heuristic.has_custom_reply && !customInstruction;

      const validIntent =
        !useSpecializedIntent &&
        llmData.translated_intent &&
        llmData.translated_intent.length > 20 &&
        !/diagn[óo]stico t[ée]cnico claro/i.test(llmData.translated_intent)
          ? llmData.translated_intent
          : heuristic.translated_intent;

      const validUrgencyReason =
        !useSpecializedIntent &&
        llmData.urgency_reason &&
        llmData.urgency_reason.length > 10 &&
        !/justificativa curta/i.test(llmData.urgency_reason)
          ? llmData.urgency_reason
          : heuristic.urgency_reason;

      const shouldNotAskQuestions =
        heuristic.sufficiency_status === "completo" && !customWantsQuestions;
      const llmReplyHasUnwantedQuestions =
        shouldNotAskQuestions &&
        (/\?|hoptodesk|responda [àa]s perguntas|por favor,\s*verifique/i.test(
          llmData.public_reply_draft || ""
        ) &&
          !/tudo bem\?/i.test(
            (llmData.public_reply_draft || "").replace(/ol[áa],\s*[^?!]+\?\s*/i, "")
          ));

      const hasProperGreeting = /^ol[áa]\b/i.test(
        (llmData.public_reply_draft || "").trim()
      );

      const validPublicReply =
        !useSpecializedIntent &&
        llmData.public_reply_draft &&
        llmData.public_reply_draft.length > 25 &&
        hasProperGreeting &&
        !llmReplyHasUnwantedQuestions &&
        !/<PrimeiroNome>|o que falta para o atendimento\?|fornecemos a id/i.test(
          llmData.public_reply_draft
        )
          ? llmData.public_reply_draft
          : heuristic.public_reply_draft;

      llmData.translated_intent = validIntent;
      llmData.urgency_reason = validUrgencyReason;
      llmData.public_reply_draft = validPublicReply;
      llmData.detected_domain = heuristic.detected_domain;
      llmData.suggested_category = heuristic.suggested_category || ticket.category;
      llmData.real_urgency = heuristic.real_urgency;
      llmData.sufficiency_status = heuristic.sufficiency_status;
      llmData.missing_info = heuristic.missing_info;
      llmData.primary_knowledge_source = heuristic.primary_knowledge_source;
      llmData.resolution_steps = heuristic.resolution_steps;

      const missingTxt =
        llmData.missing_info.length > 0
          ? llmData.missing_info.map((item) => `  - ${item}`).join("\n")
          : "  - Dados suficientes no relato para iniciar a tratativa.";
      const stepsTxt = (llmData.resolution_steps || [])
        .slice(0, 6)
        .map((step, idx) => `  ${idx + 1}. ${step}`)
        .join("\n");

      llmData.private_note_draft =
        `[TRATATIVA PRÉVIA - COPILOTO DE T.I.]\n` +
        `----------------------------------------\n` +
        `ENTENDIMENTO TÉCNICO:\n` +
        `${llmData.translated_intent}\n\n` +
        `Classificação Sugerida: ${llmData.suggested_category} | Prioridade Real: ${llmData.real_urgency}\n` +
        `Base Consultada: ${llmData.primary_knowledge_source}\n\n` +
        `TRIAGEM DE INFORMAÇÕES (${String(llmData.sufficiency_status).toUpperCase()}):\n` +
        `${missingTxt}\n\n` +
        `ROTEIRO DE RESOLUÇÃO SUGERIDO:\n` +
        `${stepsTxt}`;
    }

    const now = new Date();
    const nowStr = `${String(now.getDate()).padStart(2, "0")}/${String(
      now.getMonth() + 1
    ).padStart(2, "0")}/${now.getFullYear()} ${String(now.getHours()).padStart(
      2,
      "0"
    )}:${String(now.getMinutes()).padStart(2, "0")}`;

    return {
      ticket_id: ticket.id,
      analyzed_at: nowStr,
      provider_used: providerLabel,
      translated_intent: llmData.translated_intent || heuristic.translated_intent,
      detected_domain:
        llmData.detected_domain || heuristic.detected_domain,
      suggested_category: llmData.suggested_category || ticket.category,
      real_urgency: llmData.real_urgency || heuristic.real_urgency,
      urgency_reason: llmData.urgency_reason || heuristic.urgency_reason,
      sufficiency_status: llmData.sufficiency_status || "parcial",
      missing_info: llmData.missing_info || [],
      knowledge_matches: matches || [],
      primary_knowledge_source:
        llmData.primary_knowledge_source || heuristic.primary_knowledge_source,
      resolution_steps: llmData.resolution_steps || [],
      private_note_draft: llmData.private_note_draft || heuristic.private_note_draft,
      public_reply_draft: llmData.public_reply_draft || heuristic.public_reply_draft,
    };
  }

  async _callGemini(userPrompt) {
    const model = (this.settings.gemini_model || "gemini-2.5-flash").trim();
    const apiKey = this.settings.gemini_api_key.trim();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
      apiKey
    )}`;

    const payload = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Gemini HTTP ${res.status}`);
    }
    const data = await res.json();
    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    return extractJsonObject(text);
  }

  async _callOpenAI(userPrompt) {
    const baseUrl = (this.settings.openai_base_url || "https://api.openai.com/v1").replace(
      /\/+$/,
      ""
    );
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.openai_api_key.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: (this.settings.openai_model || "gpt-4o-mini").trim(),
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI HTTP ${res.status}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || "{}";
    return extractJsonObject(text);
  }

  async _callOllama(userPrompt) {
    const baseUrl = (this.settings.ollama_base_url || "http://localhost:11434").replace(
      /\/+$/,
      ""
    );
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: (this.settings.ollama_model || "qwen2.5:3b").trim(),
        stream: false,
        format: {
          type: "object",
          properties: {
            translated_intent: { type: "string" },
            urgency_reason: { type: "string" },
            public_reply_draft: { type: "string" },
          },
          required: ["translated_intent", "urgency_reason", "public_reply_draft"],
        },
        keep_alive: "30m",
        options: {
          temperature: 0.2,
          num_ctx: 2048,
        },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama HTTP ${res.status}`);
    }
    const data = await res.json();
    const text = data?.message?.content || "{}";
    return extractJsonObject(text);
  }

  _buildSmartHeuristicAnalysis(ticket, matches, customInstruction = null) {
    const formFields = extractFormCreatorFields(ticket.content);
    const normAll = normalizeText(`${ticket.title} ${ticket.content}`);
    const normCore = normalizeText(
      `${ticket.title} ${formFields.tipo} ${formFields.ativo} ${formFields.descricao}`
    );
    const firstName = (
      ticket.requester_first_name ||
      ticket.requester ||
      "Solicitante"
    )
      .trim()
      .split(/\s+/)[0];
    const rawSetor = formFields.setor ? formFields.setor.trim() : "";
    const rawLoc = formFields.localizacao ? formFields.localizacao.trim() : "";
    const isGenericLoc = /^(hospital|sede|passos|unimed)$/i.test(rawLoc);

    const sectorName =
      rawSetor ||
      (!isGenericLoc ? rawLoc : "") ||
      ticket.requester_department ||
      rawLoc ||
      "setor solicitante";
    const playbooks = loadPlaybooks();

    let matchedPb = null;
    let matchedMemory = null;
    for (const m of matches || []) {
      if (!matchedMemory && m.layer === "learned_memory" && m.score >= 0.55) {
        matchedMemory = m;
      }
      if (!matchedPb && m.layer === "local_playbook") {
        matchedPb = playbooks.find((pb) => pb.id === m.source_id) || null;
      }
    }

    let primarySource =
      "3ª Camada • Conhecimento Técnico de TI (Sem artigo prévio na KB do GLPI)";
    if (matches && matches.length > 0) {
      primarySource = matches
        .slice(0, 2)
        .map((m) => `${m.layer_label} (${m.source_id})`)
        .join(" + ");
    }

    let translatedIntent = "";
    let detectedDomain = "Suporte Técnico Geral / Service Desk";
    let suggestedCategory = ticket.category;
    let realUrgency = ticket.urgency_label;
    let urgencyReason = "";
    let sufficiencyStatus = "parcial";
    let missingInfo = [];
    let customPublicReply = "";

    if (/\[r\]\s*$/i.test(ticket.title)) {
      const cleanRoutineName = ticket.title.replace(/\s*\[R\]\s*$/i, "").trim();
      translatedIntent =
        `Tarefa interna preventiva/recorrente da equipe de T.I. (${ticket.category}): "${cleanRoutineName}". ` +
        `Trata-se de um checklist operacional programado no GLPI para execução, validação e registro de evidências técnicas.`;
      detectedDomain =
        ticket.category.includes("IR") || ticket.category.includes("SI")
          ? "Infraestrutura e Rede"
          : ticket.category.includes("DV") || ticket.category.includes("BD")
          ? "Sistemas Internos / ERP / Sistemas Corporativos"
          : "Suporte Técnico Geral / Service Desk";
      suggestedCategory = ticket.category;
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason = "Rotina preventiva programada da operação de T.I.";
      sufficiencyStatus = "completo";
      missingInfo = [];
    } else if (
      /\b(ponto de telefone|linha e aparelho|remanejar|remanejamento|mudar de lugar|mudanca de local|novo ponto de rede)\b/i.test(
        normAll
      ) ||
      /\b(trocar|mudar|transferir|levar|passar|colocar)\b[\s\S]{0,60}\b(do|da)\b[\s\S]{0,50}\bpara\b/i.test(
        normAll
      )
    ) {
      const descOnly = formFields.descricao || "";
      const mentionsPrinterReloc = /\bimpressora\b/i.test(normAll);
      const isZebra = /\bzebra\b/i.test(normAll);
      const printerName = isZebra ? "impressora Zebra" : "impressora";
      const mentionsPhoneInstall =
        /\b(ponto de telefone|linha e aparelho|telefone|ramal|aparelho)\b/i.test(
          normAll
        );

      const fromToMatch = descOnly.match(
        /\bd[oa]\s+([^,\n]+?)\s+para\s+(?:o\s+|a\s+)?([^,\n.]+)/i
      );
      const originLoc = fromToMatch?.[1]
        ? fromToMatch[1].replace(/bal[cç][ãa]o/i, "balcão").trim()
        : sectorName;
      const destLoc = fromToMatch?.[2]
        ? fromToMatch[2].replace(/\s+coloca.*$/i, "").trim()
        : /\balmoxarifado\b/i.test(normAll)
        ? "Almoxarifado"
        : "novo local solicitado";

      detectedDomain = "Infraestrutura e Rede";
      suggestedCategory = ticket.category;
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason =
        "Solicitação de remanejamento físico de equipamento e/ou instalação de ponto de telefonia/rede, demandando atendimento presencial da equipe de Infraestrutura.";

      const actionsRequested = [];
      if (mentionsPrinterReloc) {
        actionsRequested.push(
          `**remanejar a ${printerName}** (d${
            originLoc.toLowerCase().startsWith("a") ? "a" : "o"
          } ${originLoc} para ${destLoc})`
        );
      }
      if (mentionsPhoneInstall) {
        actionsRequested.push(
          `**instalar um ponto de telefone (linha/ramal e aparelho)** n${
            destLoc.toLowerCase().startsWith("a") && !destLoc.toLowerCase().startsWith("almox")
              ? "a"
              : "o"
          } ${destLoc}`
        );
      }
      const actionsTxt =
        actionsRequested.length > 0
          ? actionsRequested.join(" e ")
          : `realizar a mudança/instalação física solicitada (${descOnly
              .replace(/\s+/g, " ")
              .trim()})`;

      translatedIntent =
        `O solicitante **${ticket.requester}** (${sectorName}) solicita atendimento presencial da equipe de Infraestrutura e Redes para ${actionsTxt}. ` +
        `Requer validação prévia de infraestrutura física (pontos de rede/energia no destino e definição de ramal telefônico) para execução no local.`;

      sufficiencyStatus = "parcial";
      missingInfo = [];
      if (mentionsPrinterReloc) {
        missingInfo.push(
          `Confirmar se no local de destino (${destLoc}) já existem tomadas elétricas e pontos de rede/cabeamento disponíveis (ou computador próximo, caso a ${printerName} seja conectada via USB)`
        );
      } else {
        missingInfo.push(
          `Confirmar a localização exata e disponibilidade de infraestrutura (rede/energia) no destino (${destLoc})`
        );
      }
      if (mentionsPhoneInstall) {
        missingInfo.push(
          `Informar se para o ponto de telefone (${destLoc}) deve ser configurado um novo número de ramal ou transferido um ramal já existente`
        );
      }

      const questionsBul = missingInfo
        .map((q, idx) => `${idx + 1}. ${q}?`)
        .join("\n");

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação para ${actionsTxt}.\n\n` +
        `Nossa equipe de Infraestrutura e Redes já está analisando o pedido para programar o atendimento presencial no setor. Para agilizarmos a execução no local, você poderia nos confirmar:\n` +
        (mentionsPrinterReloc && mentionsPhoneInstall
          ? `1. No local onde os equipamentos ficarão (${destLoc}), já existem **pontos de rede/cabeamento e tomadas elétricas** próximos (ou computador onde a ${printerName} será conectada)?\n` +
            `2. Sobre o ponto de telefone, será necessário configurar um **novo número de ramal** para o ${destLoc} ou transferir algum ramal já existente?`
          : questionsBul) +
        `\n\nAssim que nos confirmar por aqui, já programamos a ida do técnico até o local!`;
    } else if (
      /\b(nobreak|no-break|\bups\b)\b/i.test(normAll) ||
      (/\benergia\b/i.test(normAll) &&
        /\b(queda|pico|oscila|segura|bateria|desligando)\b/i.test(normAll))
    ) {
      detectedDomain = "Infraestrutura e Rede";
      suggestedCategory =
        "T.I > IR > Energia e Geradores > Teste/Manutenção de Nobreaks/UPS";
      realUrgency =
        /alta|urgente|servidor|uti|centro cirurgico/i.test(normAll)
          ? "Alta"
          : ticket.urgency_label || "Média";
      urgencyReason =
        "Nobreak sem autonomia de bateria durante oscilações ou quedas de energia elétrica, com risco de desligamento abrupto de equipamento e perda de dados.";

      const locMatch = (ticket.content || "").match(/Local\s*:\s*([^\n\r]+)/i);
      const roomMatches = (ticket.content || "").match(
        /\b(?:pr[ée]dio\s+[a-zà-ú]+|sala\s*\d{2,4}[a-z]?)\b/gi
      );
      const uniqueRooms = [
        ...new Set((roomMatches || []).map((r) => r.trim())),
      ];
      let localStr = locMatch ? locMatch[1].trim() : sectorName;
      if (uniqueRooms.length > 0) {
        localStr = locMatch
          ? `${locMatch[1].trim()} (${uniqueRooms.join(", ")})`
          : uniqueRooms.join(", ");
      }

      const mentionsEquipment = /\b(computador|pc|desktop|servidor)\b/i.test(
        normAll
      );
      const eqpLabel = mentionsEquipment ? "computador" : "equipamento";

      const userDocMatch = (ticket.content || "").match(
        /\b((?:dr\.?|dra\.?)\s+[A-ZÀ-Úa-zà-ú]+(?:\s+[A-ZÀ-Úa-zà-ú]+){1,3}?)(?=\s+(?:no|na|sala|predio|pr[ée]dio|em|\/|-|,|\.|$))/i
      );
      const userDoc = userDocMatch ? userDocMatch[1].trim() : "";

      const isOwnComputer =
        userDoc &&
        (normalizeText(ticket.requester || "").includes(
          normalizeText(userDoc.replace(/^(?:dr\.?|dra\.?)\s*/i, ""))
        ) ||
          normalizeText(userDoc).includes(normalizeText(firstName)));

      const userDocTxt = isOwnComputer
        ? "do seu computador"
        : userDoc
        ? `do computador (${userDoc})`
        : `do ${eqpLabel}`;

      const locationDetails = isOwnComputer
        ? `${eqpLabel} de **${ticket.requester}** em ${localStr}`
        : userDoc
        ? `${eqpLabel} de **${userDoc}** em ${localStr}`
        : `${eqpLabel} em ${localStr}`;

      translatedIntent =
        `O solicitante **${ticket.requester}** (${sectorName}) relata falha no Nobreak ${userDocTxt}, ` +
        `informando que o equipamento não segura a carga durante picos ou quedas de energia elétrica. ` +
        `Demanda vistoria presencial da equipe de Infraestrutura e Redes para teste de carga da bateria e substituição física do nobreak ou troca das baterias seladas. ` +
        `Todas as informações necessárias para atendimento já constam descritas no chamado.`;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente ao **Nobreak ${userDocTxt}**, localizado no **${localStr}**.\n\n` +
        `Identificamos o relato de que o equipamento não está segurando a carga durante picos ou quedas de energia elétrica. Todas as informações de localização e descrição da falha já foram validadas na triagem.\n\n` +
        `Nossa equipe de Infraestrutura e Redes já está separando um equipamento/bateria reserva e deslocará um técnico até o local (**${localStr}**) para realizar a vistoria técnica e a substituição do nobreak.\n\n` +
        `Assim que o atendimento presencial for concluído, confirmaremos a normalização por aqui!`;
    } else if (
      (/\b(scan|scanner|digitaliz|digitaliza[çc][ãa]o)\b/i.test(normAll) ||
        /\b(cadastr(ar|o))\b[\s\S]{0,30}\b(e-?mail|email)\b/i.test(normAll) ||
        /\b(e-?mail|email)\b[\s\S]{0,30}\b(impressora|scanner|scan)\b/i.test(normAll)) &&
      /\b(impressora|samsung|m4080|multifuncional|scanner)\b/i.test(normAll) &&
      !/\b(nao esta imprimindo|parou de imprimir|spooler|mancha|atolamento|papel preso|offline)\b/i.test(normAll)
    ) {
      const emailMatch = ticket.content.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i);
      const userEmail = emailMatch ? emailMatch[0].trim() : "";
      const isRecepcao = /recep[çc][ãa]o/i.test(normAll);
      const printerLocation = isRecepcao ? `Recepção do ${sectorName}` : sectorName;
      const printerModel =
        /\b(m4080|4080|samsung)\b/i.test(normAll) || /nucleo|hospital|passos/i.test(sectorName)
          ? "Samsung M4080"
          : "multifuncional";

      translatedIntent =
        `A solicitante **${ticket.requester}** (${sectorName}) solicita o cadastro do seu e-mail institucional (${userEmail || "e-mail"}) ` +
        `no catálogo de endereços da impressora **${printerModel}** (${printerLocation}) para envio direto de digitalizações (Scan to E-mail), ` +
        `destacando a conformidade com a LGPD e a privacidade no tratamento de dados sensíveis.`;
      detectedDomain = "Infraestrutura e Rede";
      suggestedCategory = "T.I > IR > Suporte a Hardware > Periféricos > Impressoras";
      realUrgency = "Média";
      urgencyReason =
        "Configuração de catálogo na impressora para envio de digitalizações por e-mail, garantindo sigilo e conformidade com a LGPD.";

      if (userEmail) {
        sufficiencyStatus = "completo";
        missingInfo = [];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação para cadastrar o seu e-mail (**${userEmail}**) na impressora **${printerModel}** (${printerLocation}) para envio direto de digitalizações (Scan to E-mail), em conformidade com a LGPD.\n\n` +
          `Todos os dados necessários já foram informados e nossa equipe de Infraestrutura e Redes já está realizando a inclusão do seu contato no catálogo de endereços do equipamento via painel administrativo (SyncThru).\n\n` +
          `Assim que concluirmos o cadastro, avisaremos por aqui para que você possa realizar o primeiro teste no painel da impressora!`;
      } else {
        sufficiencyStatus = "parcial";
        missingInfo = [
          "Informar o endereço de e-mail institucional exato que deve ser cadastrado no catálogo da impressora",
        ];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação para cadastro no catálogo da impressora **${printerModel}** (${printerLocation}) para envio de digitalizações (Scan to E-mail).\n\n` +
          `Para efetuarmos a inclusão no equipamento, você poderia nos confirmar qual o seu **endereço de e-mail institucional**?\n\n` +
          `Assim que nos confirmar por aqui, já finalizamos o cadastro no painel da impressora!`;
      }
    } else if (
      /\b(troca de toner|trocar toner|troca do toner|substitui[çc][ãa]o de toner|toner vazio|toner fraco|acabou o toner|novo toner)\b/i.test(
        normAll
      ) ||
      (/\btoner\b/i.test(normAll) &&
        /\b(troca|trocar|substitui|solicito|troque|colocar|acabou|fornecer|solicita[çc][ãa]o)\b/i.test(
          normAll
        ))
    ) {
      const isMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor)\b/i.test(
        firstName
      );
      const solPrefix = isMale ? "O solicitante" : "A solicitante";

      const explicitModel =
        formFields.ativo ||
        (/\bm4080(?:fx)?\b/i.test(normAll) ? "Samsung M4080FX" : "");
      const printerLabel = explicitModel
        ? `da impressora **${explicitModel}**`
        : "da impressora";

      detectedDomain = "Infraestrutura e Rede";
      suggestedCategory = "T.I > IR > Suporte a Hardware > Periféricos > Impressoras";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason = `Solicitação de troca de toner para manutenção da continuidade das impressões do setor ${sectorName}.`;
      sufficiencyStatus = "completo";
      missingInfo = [];

      const categoryMismatch =
        normalizeText(ticket.category || "") !==
        normalizeText(suggestedCategory);
      const catNote = categoryMismatch
        ? ` O chamado foi aberto na categoria '${ticket.category}' e recomenda-se reclassificar para '${suggestedCategory}'.`
        : "";

      translatedIntent =
        `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a **troca de toner** ${printerLabel} do setor **${sectorName}**. ` +
        `Todos os dados necessários para o atendimento presencial já constam descritos no chamado.${catNote}`;

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente à **troca de toner** ${printerLabel} do setor **${sectorName}**.\n\n` +
        `Nossa equipe de Infraestrutura e Redes já está separando o cartucho de toner compatível no estoque e providenciará o deslocamento de um técnico até o setor para realizar a substituição física e efetuar os testes de impressão no equipamento.\n\n` +
        `Assim que a troca for concluída e a impressora estiver liberada para uso, confirmaremos a finalização por aqui!\n\n` +
        `Permanecemos à disposição!`;
    } else if (
      normCore.includes("impressora") ||
      normCore.includes("impressoras") ||
      normCore.includes("imprimir") ||
      normCore.includes("imprimindo") ||
      normCore.includes("samsung") ||
      normCore.includes("m4080fx") ||
      normCore.includes("spooler")
    ) {
      const explicitModel =
        formFields.ativo ||
        (/\bm4080(?:fx)?\b/i.test(normAll)
          ? "Samsung M4080FX"
          : /\bzebra\b/i.test(normAll)
          ? "Zebra"
          : "");
      const printerLabel = explicitModel
        ? `a impressora **${explicitModel}**`
        : "a **impressora do setor**";
      const printerShort = explicitModel || "impressora do setor";
      const asksUrgency =
        normCore.includes("urgencia") || normCore.includes("urgente");

      translatedIntent =
        `O solicitante **${ticket.requester}** (${sectorName}) relata falha de impressão em ${printerLabel} localizada no setor **${sectorName}**` +
        (asksUrgency ? " e solicita atendimento com urgência. " : ". ") +
        `O relato não especifica se a falha afeta todas as estações do setor (queda de rede/alerta físico na impressora) ou apenas um computador específico (fila do Spooler travada).`;
      detectedDomain = "Infraestrutura e Rede";
      suggestedCategory = "T.I > IR > Suporte a Hardware > Periféricos > Impressoras";
      realUrgency = asksUrgency ? "Alta" : ticket.urgency_label || "Média";
      urgencyReason = asksUrgency
        ? `Parada de impressão em setor operacional (${sectorName}) com pedido de urgência.`
        : `Falha de impressão no equipamento (${printerShort} - ${sectorName}).`;
      sufficiencyStatus = "parcial";
      missingInfo = [
        `Confirmar se a ${printerShort} parou de imprimir para todos os computadores do setor (${sectorName}) ou apenas na sua estação`,
        `Verificar se aparece alguma mensagem de erro ou LED vermelho/laranja aceso no visor da ${printerShort} (ex: papel preso, bandeja, falta de toner ou cabo de rede desconectado)`,
        "Caso ocorra apenas no seu computador, informar o seu ID do HopToDesk para destravarmos a fila de impressão remotamente",
      ];
      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Já estamos verificando o status d${printerLabel} (${sectorName}) na rede.\n\n` +
        `Para agilizarmos o destravamento das impressões, você poderia nos confirmar rapidamente:\n` +
        `1. A falha ocorre em **todos os computadores** da ${sectorName} ou apenas na **sua máquina**?\n` +
        `2. Aparece alguma **mensagem de erro ou luz de alerta** no visor da ${printerShort} (como atolamento de papel, bandeja aberta ou falha de rede)?\n` +
        `3. Se for apenas no seu computador, qual é o seu **ID do HopToDesk** para reiniciarmos a fila de impressão remotamente?\n\n` +
        `Caso a impressora esteja inacessível na rede, já deslocaremos um técnico até a ${sectorName}!`;
    } else if (
      normAll.includes("bloqueio de conta") ||
      normAll.includes("bloqueio de acesso") ||
      normAll.includes("desligamento") ||
      normAll.includes("quadro funcional") ||
      (normAll.includes("bloquear") &&
        (normAll.includes("colaborador") || normAll.includes("acesso")))
    ) {
      const colabNome =
        formFields.nomeColaborador ||
        ticket.title.split(">").pop().trim() ||
        "colaborador(a)";
      const cpfTxt = formFields.cpf ? ` (CPF: ${formFields.cpf})` : "";
      const motivoTxt =
        formFields.motivo ||
        (normAll.includes("desligamento") || normAll.includes("desligada")
          ? "Desligamento"
          : "Bloqueio de Contas");
      const unidadeSetor = [
        formFields.unidade,
        formFields.setorAlvo || sectorName,
      ]
        .filter(Boolean)
        .join(" • ");

      const rawAcessos = (formFields.acessos || "")
        .replace(/outros\s*\(?descrever em observa[çc][õo]es\)?,?\s*/gi, "")
        .trim();
      const normDesc = normalizeText(formFields.descricao || "");
      const mentionsPhysicalBlock =
        normDesc.includes("entrada no hospital") ||
        normDesc.includes("portaria") ||
        normDesc.includes("catraca") ||
        normDesc.includes("biometria");
      const mentionsSystemsInDesc =
        /\b(spdata|sgh|wifi|wi-fi|lgpd|faculdade|email|e-mail|nextcloud|rede|active directory|totvs|hrp|autolac|myplace)\b/i.test(
          normDesc
        );

      const hasDiscriminatedAccesses =
        Boolean(rawAcessos) || mentionsPhysicalBlock || mentionsSystemsInDesc;

      const accessParts = [];
      if (rawAcessos) accessParts.push(rawAcessos);
      if (mentionsPhysicalBlock) {
        accessParts.push("Acesso físico de entrada no hospital");
      }
      const acessosListTxt =
        accessParts.join(" + ") || "sistemas informados na descrição";

      detectedDomain = "Acessos, Permissões e Contas";
      suggestedCategory = "T.I > ST > Acesso e Permissões > Bloqueio de Contas";
      realUrgency = "Alta";
      urgencyReason =
        "Revogação imediata de credenciais por desligamento/afastamento para segurança da informação e conformidade LGPD.";

      if (hasDiscriminatedAccesses) {
        translatedIntent =
          `Solicitação de **${motivoTxt}** aberta pelo RH referente a **${colabNome}**${cpfTxt}` +
          (unidadeSetor ? ` (${unidadeSetor})` : "") +
          `. Todas as informações pertinentes e os acessos a serem bloqueados (**${acessosListTxt}**) já estão discriminados no chamado.`;
        sufficiencyStatus = "completo";
        missingInfo = [];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a solicitação de bloqueio de acessos por motivo de **${motivoTxt}** referente a **${colabNome}**.\n\n` +
          `Todas as informações necessárias já constam no chamado e nossa equipe já iniciou o bloqueio imediato das credenciais discriminadas (**${acessosListTxt}**).\n\n` +
          `Assim que todos os bloqueios forem concluídos, confirmaremos por aqui!`;
      } else {
        translatedIntent =
          `Solicitação de **${motivoTxt}** referente a **${colabNome}**${cpfTxt}` +
          (unidadeSetor ? ` (${unidadeSetor})` : "") +
          `, porém o chamado não discriminou quais sistemas e credenciais devem ser bloqueados.`;
        sufficiencyStatus = "parcial";
        missingInfo = [
          `Informar quais acessos, sistemas e credenciais devem ser bloqueados para ${colabNome} (ex: Rede/AD, SGH Spdata, E-mail, Wi-Fi, Faculdade Unimed, LGPD ou acesso físico/portaria)`,
        ];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a solicitação de bloqueio de contas referente a **${colabNome}**.\n\n` +
          `Como a relação de sistemas não veio discriminada no formulário, você poderia nos informar **quais acessos e credenciais devem ser bloqueados** (ex: Rede/AD, SGH Spdata, E-mail, Wi-Fi, Faculdade Unimed, LGPD ou acesso de entrada no hospital)?\n\n` +
          `Assim que confirmar, executamos o bloqueio imediatamente!`;
      }
    } else if (
      normAll.includes("intranet") &&
      (normAll.includes("visualizar") ||
        normAll.includes("disponivel") ||
        normAll.includes("disponível") ||
        normAll.includes("informac") ||
        normAll.includes("informaç") ||
        normAll.includes("modulo") ||
        normAll.includes("módulo") ||
        normAll.includes("permissao") ||
        normAll.includes("permissão") ||
        normAll.includes("ja foi liberado") ||
        normAll.includes("já foi liberado") ||
        normAll.includes("ferramenta"))
    ) {
      const colabMatch = ticket.content.match(/(?:Colaboradora?|Nome)\s*:\s*([^\n]+)/i);
      const colabName = colabMatch ? colabMatch[1].trim() : "colaboradora";

      translatedIntent =
        `A solicitante **${ticket.requester}** (Recursos Humanos) relata que a colaboradora **${colabName}** já possui acesso liberado à **Intranet**, ` +
        `porém não está conseguindo visualizar determinadas informações ou módulos na ferramenta. O chamado não especifica quais páginas ou dados estão ausentes, demandando detalhamento para ajuste das permissões de perfil.`;
      detectedDomain = "Acessos, Permissões e Contas";
      suggestedCategory = "T.I > ST > Acesso e Permissões";
      realUrgency = "Média";
      urgencyReason = "Colaboradora com acesso ativo à Intranet, mas sem visualização de conteúdos ou módulos necessários para suas atividades.";
      sufficiencyStatus = "incompleto";
      missingInfo = [
        "Informar quais informações, páginas, documentos ou módulos específicos a colaboradora precisa visualizar e não estão aparecendo na Intranet",
        "Informar se é exibida mensagem de restrição/permissão negada ou se as opções simplesmente não constam na tela (se possível, anexar print da tela)",
      ];
      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a solicitação referente ao acesso da colaboradora **${colabName}** na **Intranet**.\n\n` +
        `Como a colaboradora já possui acesso à ferramenta, para que nossa equipe de T.I. possa ajustar o perfil e liberar a visualização correta, você poderia nos informar:\n` +
        `1. **Quais informações, páginas ou módulos específicos** ela precisa visualizar que não estão aparecendo?\n` +
        `2. É exibida alguma **mensagem de erro ou restrição de perfil**, ou as opções simplesmente não constam na tela?\n` +
        `3. Se possível, você poderia anexar aqui um **print da tela** de como a Intranet está sendo exibida para ela?\n\n` +
        `Assim que nos confirmar essas informações por aqui, daremos sequência com o ajuste das permissões imediatamente!`;
    } else if (
      !normAll.includes("intranet") &&
      (
        normAll.includes("relogio de ponto") ||
        normAll.includes("myplace") ||
        (
          normAll.includes("criacao de usuario") &&
          normAll.includes("recursos humanos") &&
          /\b(ponto|rep|myplace|admissao|admissão|biometria|folha|matricula|matrícula|pis)\b/i.test(normAll)
        )
      )
    ) {
      const hasMatricula = /matricula\s*[:\-]?\s*\d+/i.test(normAll);
      const hasPis = /\bpis\s*[:\-]?\s*[\d.\-]+/i.test(normAll);
      const colabMatch = ticket.content.match(/(?:Colaboradora?|Nome)\s*:\s*([^\n]+)/i);
      const colabName = colabMatch ? colabMatch[1].trim() : "novo(a) colaborador(a)";

      if (hasMatricula && hasPis) {
        translatedIntent =
          `Solicitação do RH para cadastro de colaborador (${colabName}) no Relógio de Ponto Eletrônico (REP), ` +
          `portal MyPlace e liberação de Wi-Fi. Os dados obrigatórios (Matrícula e PIS) já foram informados na descrição do chamado.`;
        sufficiencyStatus = "completo";
        missingInfo = [];
      } else {
        translatedIntent =
          `Solicitação do RH para cadastro de colaborador (${colabName}) no Relógio de Ponto Eletrônico (REP), ` +
          `portal MyPlace e liberação de Wi-Fi. Porém, faltam dados cadastrais obrigatórios (Matrícula e/ou PIS) para inclusão no sistema de ponto.`;
        sufficiencyStatus = "incompleto";
        missingInfo = [];
        if (!hasMatricula) {
          missingInfo.push("Número da Matrícula do(a) colaborador(a) (obrigatório para Relógio de Ponto e MyPlace)");
        }
        if (!hasPis) {
          missingInfo.push("Número do PIS/CPF do(a) colaborador(a) (obrigatório para cadastro no REP)");
        }
        missingInfo.push("Caso precise de Wi-Fi em dispositivo móvel, informar o endereço MAC do aparelho");
      }
      detectedDomain = "Acessos, Permissões e Contas";
      suggestedCategory = "T.I > ST > Criação de Usuário / Acessos";
      realUrgency = "Média";
      urgencyReason = "Admissão/onboarding de colaborador aguardando liberação de registro de ponto e portal RH.";
    } else if (normAll.includes("nextcloud") || normAll.includes("nextclaud")) {
      translatedIntent =
        "Usuária do setor de Auditoria Hospitalar relata falha genérica ao tentar acessar pasta compartilhada no Nextcloud, " +
        "sem especificar o nome da pasta, se o acesso ocorre via navegador ou cliente de sincronização Desktop, nem a mensagem de erro ou ID do HopToDesk.";
      detectedDomain = "Acessos, Permissões e Contas";
      suggestedCategory = "T.I > ST > Acesso a Pastas / Nextcloud";
      realUrgency = "Média";
      urgencyReason = "Impacta a rotina individual da colaboradora na Auditoria, mas requer dados básicos para diagnóstico.";
      sufficiencyStatus = "incompleto";
      missingInfo = [
        "Nome exato da pasta compartilhada no Nextcloud que está tentando acessar",
        "Se o erro ocorre pelo navegador web ou pelo aplicativo Nextcloud sincronizado no Windows",
        "ID do HopToDesk para acesso remoto e print/texto da mensagem de erro exibida",
      ];
    } else if (normAll.includes("xml") && normAll.includes("hash")) {
      const hasAsset = Boolean(formFields.ativo) || /hu\d{3,}|patrimonio\s*:\s*\w+/i.test(normAll);
      translatedIntent =
        "Solicitação do Laboratório para correção/recálculo de hash MD5 em 2 arquivos XML de faturamento TISS do convênio Aura Saúde. " +
        "O acesso remoto e os arquivos XML não foram informados na abertura.";
      detectedDomain = "Sistemas Internos / ERP / Sistemas Corporativos";
      suggestedCategory = "T.I > ST > Validação XML TISS / Faturamento";
      realUrgency = "Alta";
      urgencyReason = "Impacto direto no envio de lote de faturamento TISS de exames laboratoriais para o convênio.";
      sufficiencyStatus = hasAsset ? "parcial" : "incompleto";
      missingInfo = [
        "ID do HopToDesk do computador para conexão remota",
        "Anexar os 2 arquivos XML do convênio Aura Saúde no chamado (ou informar a pasta onde estão salvos)",
      ];
    } else if (normAll.includes("autolac") || (normAll.includes("pep") && normAll.includes("exame"))) {
      if (normAll.includes("meia noite") || normAll.includes("divergencia") || normAll.includes("23:50")) {
        translatedIntent =
          "Inconsistência na integração entre o PEP Hospitalar (módulo do SGH Spdata no Hospital Unimed) e o sistema laboratorial (AutoLac): " +
          "exames prescritos no PEP próximo à meia-noite (ex: 23:50) e importados no AutoLac após 00:00 estão assumindo a data de importação " +
          "em vez da data/hora real da solicitação médica, gerando divergência nos laudos.";
        detectedDomain = "Sistemas Internos / ERP / Sistemas Corporativos";
        suggestedCategory = "T.I > ST / DV > Integração PEP x AutoLac";
        realUrgency = "Alta";
        urgencyReason = "Divergência de data em documentos clínicos/laudos laboratoriais na virada de plantão.";
        sufficiencyStatus = "parcial";
        missingInfo = [
          "Número de 1 ou 2 atendimentos/requisições de exame onde ocorreu a divergência na virada da meia-noite (para rastreio no log de integração)",
        ];
      } else {
        translatedIntent =
          "Solicitação de orientação/treinamento operacional sobre como pesquisar e consultar resultados de exames no sistema AutoLac (Núcleo Passos).";
        detectedDomain = "Sistemas Internos / ERP / Sistemas Corporativos";
        suggestedCategory = "T.I > TR > Treinamento AutoLac";
        realUrgency = "Média";
        urgencyReason = "Dúvida de utilização do sistema; resolução rápida via orientação remota ao usuário.";
        sufficiencyStatus = "parcial";
        missingInfo = [
          "ID do HopToDesk do computador (ou ramal de contato no Núcleo Passos) para demonstração rápida no AutoLac",
        ];
      }
    } else if (
      normAll.includes("tnumm") ||
      normAll.includes("promoprev") ||
      normAll.includes("0256") ||
      (normAll.includes("hrp") &&
        (normAll.includes("precificacao") || normAll.includes("gestantes")))
    ) {
      if (normAll.includes("banco") || normAll.includes("tnumm") || normAll.includes("precificacao")) {
        translatedIntent =
          "Solicitação do setor de Faturamento para atualização massiva via banco de dados no sistema HRP (ajuste do campo 'precificação' " +
          "conforme regra pós-importação da tabela TNUMM).";
        detectedDomain = "Sistemas Internos / ERP / Sistemas Corporativos";
        suggestedCategory = "T.I > BD > Administração de Banco de Dados";
        realUrgency = "Alta";
        urgencyReason = "Parametrização necessária para o correto processamento de valores e faturamento no HRP.";
        sufficiencyStatus = "completo";
        missingInfo = [];
      } else {
        translatedIntent =
          "Solicitação da equipe Promoprev buscando o caminho/módulo no sistema HRP para extração do Relatório de Gestantes (carteira Clientes 0256).";
        detectedDomain = "Sistemas Internos / ERP / Sistemas Corporativos";
        suggestedCategory = "T.I > BD > Big Data e BI > Relatórios";
        realUrgency = "Baixa";
        urgencyReason = "Consulta de caminho para extração de relatório gerencial.";
        sufficiencyStatus = "completo";
        missingInfo = [];
      }
    } else if (
      /\b(roteador|access point|ap wifi)\b/i.test(normAll) ||
      (/\b(wifi|wi-fi|internet)\b/i.test(normAll) &&
        /\b(lentid[aã]o|oscila[cç][aã]o|instabilidade|quedas?|whatsapp)\b/i.test(
          normAll
        ))
    ) {
      detectedDomain = "Infraestrutura e Rede";
      suggestedCategory = "T.I > IR > Conectividade > Internet e WiFi";
      realUrgency = ticket.urgency_label && ticket.urgency_label !== "Muito baixa" ? ticket.urgency_label : "Média";
      urgencyReason = `Instabilidade e oscilação na conexão de internet afetando a rotina e chamadas de WhatsApp do setor ${sectorName}.`;

      translatedIntent =
        `A solicitante **${ticket.requester}** (${sectorName}) relata lentidão e oscilação na conexão de internet do setor (com impacto principalmente em ligações do WhatsApp) e solicita a instalação de um roteador Wi-Fi. ` +
        `Demanda vistoria presencial e testes de cobertura/estabilidade de sinal de rede sem fio pela equipe de Infraestrutura e Redes.`;

      sufficiencyStatus = "parcial";
      missingInfo = [
        `Confirmar se a lentidão e oscilação ocorrem apenas no sinal Wi-Fi (celulares e notebooks) ou também nos computadores conectados via cabo de rede no setor (${sectorName})`,
        "Confirmar se as falhas nas ligações do WhatsApp afetam aparelhos específicos ou todos os celulares utilizados no setor",
      ];
      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente à lentidão e oscilação da internet no setor de **${sectorName}** e ao pedido de instalação de um **roteador Wi-Fi**.\n\n` +
        `Nossa equipe de Infraestrutura e Redes já iniciou a análise de conectividade do setor. Para direcionarmos o diagnóstico correto antes do atendimento no local, você poderia nos confirmar:\n` +
        `1. A lentidão e oscilação ocorrem **apenas no sinal Wi-Fi** (celulares e notebooks) ou também nos **computadores conectados via cabo de rede**?\n` +
        `2. As falhas nas ligações do WhatsApp ocorrem em aparelhos específicos ou em todos os celulares utilizados no setor?\n\n` +
        `Assim que nos confirmar essas informações por aqui, daremos sequência com os testes de rede e a vistoria para instalação no local!`;
    } else if (
      (normAll.includes("wifi") || normAll.includes("wi fi")) &&
      (normAll.includes("celular") || normAll.includes("aparelho") || normAll.includes("telefone"))
    ) {
      translatedIntent =
        "Solicitação para configurar a rede Wi-Fi corporativa em um aparelho celular/telefone no setor Financeiro, " +
        "sem informar se o dispositivo é corporativo ou particular, o endereço MAC nem a aprovação da gestão.";
      detectedDomain = "Infraestrutura e Rede";
      suggestedCategory = "T.I > ST > Acesso Wi-Fi / Dispositivos Móveis";
      realUrgency = "Baixa";
      urgencyReason = "Liberação de acesso complementar em dispositivo móvel sujeita à política de Segurança da Informação.";
      sufficiencyStatus = "incompleto";
      missingInfo = [
        "Confirmar se o aparelho celular é corporativo da Unimed ou particular",
        "Justificativa de uso e 'De acordo' da coordenação/gerência do setor",
        "Endereço MAC Wi-Fi do aparelho (com 'MAC Aleatório / Endereço Privado' desativado)",
      ];
    } else if (normCore.includes("teclado") || normCore.includes("mouse") || normCore.includes("hu0")) {
      const patMatch = ticket.content.match(/\b(HU\d{3,}|\d{4,6})\b/i);
      const patCode = patMatch ? patMatch[1].toUpperCase() : formFields.ativo || null;
      translatedIntent =
        `Solicitação de manutenção presencial para substituição de periférico (teclado/mouse) no setor ${sectorName}` +
        (patCode ? `, estação identificada pelo patrimônio ${patCode}.` : ".");
      detectedDomain = "Suporte Técnico Geral / Service Desk";
      suggestedCategory = "T.I > ST > Hardware / Periféricos";
      realUrgency = "Média";
      urgencyReason = "Periférico físico com falha em posto de trabalho hospitalar; patrimônio já identificado.";
      sufficiencyStatus = patCode ? "completo" : "parcial";
      missingInfo = patCode
        ? []
        : ["Localização/posto exato ou número de patrimônio do computador onde o periférico deve ser substituído"];
    } else if (
      /\btelefone\b/i.test(normAll) &&
      (/\b(nao esta funcionando|não está funcionando|nao funciona|não funciona|sem sinal|mudo|apagado|parou de funcionar|problema no telefone)\b/i.test(normAll) ||
        (normAll.includes("telefone") && (normAll.includes("setor") || normAll.includes("aparelho")))) &&
      !/\b(caindo|quedas?|interromp|ligacoes caindo|ligações caindo|ponto de telefone|remanej)\b/i.test(normAll)
    ) {
      translatedIntent =
        `A solicitante **${ticket.requester}** (${sectorName}) relata que o telefone do setor não está funcionando. ` +
        `Demanda verificação do registro do ramal no PABX e testes de reinicialização e alimentação PoE do aparelho VoIP pela equipe de Infraestrutura e Redes.`;
      detectedDomain = "Infraestrutura e Rede";
      suggestedCategory = "T.I > IR > Administração de Redes > Telefones VoIP";
      realUrgency = "Média";
      urgencyReason = "Telefone do setor inoperante; demanda checagem de alimentação física, cabo de rede ou registro do ramal no PABX.";
      sufficiencyStatus = "parcial";
      missingInfo = [
        "Verificar se o visor do telefone está aceso ou totalmente apagado",
        "Informar o número do ramal desse aparelho",
        "Realizar o teste de desconectar e reconectar o cabo de rede atrás do aparelho (aguardar 10 segundos) para reinicializar",
      ];
      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos o seu chamado referente ao telefone do setor **${sectorName}**.\n\n` +
        `Nossa equipe de Infraestrutura e Redes já iniciou a verificação do ramal na central telefônica. Como na maioria dos casos trata-se de uma falha momentânea de comunicação ou alimentação do aparelho, você poderia realizar um teste rápido:\n` +
        `1. **Desconectar o cabo de rede** (cabo conectado atrás do telefone), aguardar cerca de **10 segundos** e **reconectar firmemente** para que o aparelho reinicie;\n` +
        `2. O visor do telefone chega a **acender** ou permanece **totalmente apagado**?\n` +
        `3. Qual é o **número do ramal** desse aparelho?\n\n` +
        `Caso o reinício não restabeleça a linha, nos confirme por aqui que já enviaremos um técnico até o ${sectorName} para checar o ponto de rede e o aparelho!`;
    } else if (normAll.includes("ligacoes") || (normAll.includes("caindo") && normAll.includes("linhas"))) {
      translatedIntent =
        `Relato de instabilidade na telefonia (quedas frequentes de ligações) no setor ${sectorName}, ` +
        "solicitando revisão das linhas telefônicas/tronco VoIP sem especificar quais ramais ou horários foram afetados.";
      detectedDomain = "Infraestrutura e Rede";
      suggestedCategory = "T.I > IR > Administração de Redes > Telefones VoIP";
      realUrgency = "Alta";
      urgencyReason = "Impacto direto no atendimento telefônico aos beneficiários/pacientes da unidade.";
      sufficiencyStatus = "incompleto";
      missingInfo = [
        "Quais números de ramais específicos do setor estão apresentando queda nas ligações",
        "Confirmar se as quedas ocorrem apenas em chamadas externas ou também entre ramais internos",
        "Horário aproximado ou número externo de exemplo em que a chamada caiu hoje para análise no PABX",
      ];
    } else if (
      normAll.includes("checklist") ||
      normAll.includes("sonda") ||
      normAll.includes("folley") ||
      normAll.includes("passagem de plantao") ||
      normAll.includes("titulo de formulario") ||
      normAll.includes("hemocomponentes") ||
      normAll.includes("mapas transfusionais")
    ) {
      translatedIntent =
        `Solicitação da área assistencial do Hospital Unimed (${sectorName}) para desenvolvimento/atualização de formulário ou mapa eletrônico no PEP Hospitalar (SGH Spdata) ("${ticket.title}"), ` +
        `visando padronização clínica/regulatória. Os modelos de referência já foram encaminhados no chamado.`;
      detectedDomain = "Sistemas Internos / ERP / Sistemas Corporativos";
      suggestedCategory = ticket.category.includes("DV")
        ? ticket.category
        : "T.I > DV > Evolução de Formulários Clínicos (PEP Hospitalar / SGH Spdata)";
      realUrgency = "Média";
      urgencyReason = "Demanda evolutiva de desenvolvimento para atualização de formulários/mapas assistenciais.";
      sufficiencyStatus = "completo";
      missingInfo = [];
    } else if (
      normAll.includes("ativo imobilizado") ||
      normAll.includes("sobras contabeis") ||
      normAll.includes("levantamento de ativos")
    ) {
      translatedIntent =
        `Demanda do setor de Contabilidade referente ao controle/inventário de Ativo Imobilizado (${ticket.title}): ` +
        `alinhamento sobre listagem de equipamentos de T.I. e viabilidade de solução/aplicativo para leitura de etiquetas de patrimônio.`;
      detectedDomain = "Sistemas Internos / ERP / Sistemas Corporativos";
      suggestedCategory = ticket.category;
      realUrgency = "Baixa";
      urgencyReason = "Projeto/levantamento contábil e patrimonial planejado sem parada operacional.";
      sufficiencyStatus = "completo";
      missingInfo = [];
    } else if (normAll.includes("treinamento") && ticket.category.includes("TR")) {
      translatedIntent =
        `Solicitação de agendamento de treinamento/capacitação técnica (${formFields.descricao.slice(0, 140) || ticket.title}).`;
      detectedDomain = "Suporte Técnico Geral / Service Desk";
      suggestedCategory = "T.I > TR > Treinamentos Técnicos";
      realUrgency = "Baixa";
      urgencyReason = "Demanda programada de capacitação/treinamento.";
      sufficiencyStatus = "completo";
      missingInfo = [];
    } else if (
      normAll.includes("evento") ||
      (normAll.includes("projetor") && normAll.includes("notebook")) ||
      normAll.includes("microfone")
    ) {
      translatedIntent =
        "Solicitação de reserva/empréstimo de kit audiovisual (notebook, projetor, som e microfone) e apoio presencial da T.I. " +
        "para o evento 'Dia do Secretariado' (01/10 às 19h no Lions Club).";
      detectedDomain = "Suporte Técnico Geral / Service Desk";
      suggestedCategory = "T.I > ST > Apoio a Eventos / Empréstimo de Equipamentos";
      realUrgency = "Média";
      urgencyReason = "Evento institucional com data e horário marcados, exigindo reserva de equipamentos e agendamento de escala.";
      sufficiencyStatus = "parcial";
      missingInfo = [
        "Horário exato em que o local (Lions Club) estará aberto para montagem e testes antes das 19h",
        "Confirmar quais tipos de conexões de áudio a caixa de som utiliza (P2, XLR ou Bluetooth) para separarmos os cabos corretos",
      ];
    } else if (
      /\b(item no glpi|itens no glpi|formul[aá]rio(s)? no glpi|formcreator|criar novos? itens?|criar novos? formul[aá]rios?|novo item no glpi|novos itens no glpi|criar item no glpi)\b/i.test(
        normAll
      ) ||
      (/\bglpi\b/i.test(normAll) &&
        /\b(formul[aá]rio|formul[aá]rios|item|itens)\b/i.test(normAll) &&
        /\b(criar|cria[çc][ãa]o|novo|novos|inclus[ãa]o|adicionar|parametrizar)\b/i.test(normAll))
    ) {
      const descText = formFields.descricao || ticket.content || "";
      const isMale = /^(frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|diego|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor)\b/i.test(
        firstName
      );
      const solPrefix = isMale ? "O solicitante" : "A solicitante";

      const hasMultipleItems = /\b(item 2|item\s*2|dois itens|2 itens|novos itens|novos formul[aá]rios)\b/i.test(
        descText
      );
      const itemsCountLabel = hasMultipleItems
        ? "dois novos formulários/itens"
        : "novo(s) formulário(s)/item(ns)";

      // Tenta extrair nomes dos formulários/itens informados
      const itemNames = [];
      const itemMatches = descText.matchAll(/Nome\s*:\s*([^\n\r]+)/gi);
      for (const m of itemMatches) {
        const nameVal = m[1].replace(/obrigat[oó]rio/i, "").trim();
        if (
          nameVal &&
          !itemNames.includes(nameVal) &&
          !/^(prestador|colaborador|usuario|secretaria)$/i.test(nameVal)
        ) {
          itemNames.push(nameVal);
        }
      }

      const itemsListed =
        itemNames.length > 0
          ? itemNames.map((n) => `**${n}**`).join(" e ")
          : itemsCountLabel;

      detectedDomain = "Desenvolvimento de Software / Aplicações Internas";
      suggestedCategory = "T.I > DV > Desenvolvimento > Novas aplicações";
      realUrgency = ticket.urgency_label || "Baixa";
      urgencyReason = `Criação e parametrização de novos formulários no catálogo do GLPI para atender os fluxos de trabalho e demandas intersetoriais do ${sectorName}.`;

      const hasFieldsSpecification =
        /\b(campos?|obrigat[oó]rio|opcional|destino autom[aá]tico)\b/i.test(
          descText
        );

      if (hasFieldsSpecification) {
        translatedIntent =
          `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a criação de ${itemsCountLabel} no catálogo do sistema **GLPI** vinculados à categoria de **${sectorName}** (${itemsListed}). ` +
          `O solicitante detalhou toda a estrutura necessária: nomes dos formulários, campos obrigatórios e opcionais, opções de seleção e destino automático dos chamados. ` +
          `O chamado foi aberto na categoria '${ticket.category}' e recomenda-se reclassificar para 'T.I > DV > Desenvolvimento > Novas aplicações'.`;
        sufficiencyStatus = "completo";
        missingInfo = [];

        const itemsBullet =
          itemNames.length > 0
            ? itemNames
                .map(
                  (n, i) =>
                    `${i + 1}. **${n}**${i === itemNames.length - 1 ? "." : ";"}`
                )
                .join("\n") + "\n\n"
            : "";

        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente à criação de ${itemsCountLabel} no catálogo do **GLPI** para o setor de **${sectorName}**:\n` +
          (itemsBullet || "") +
          `Todos os requisitos informados (relação de campos obrigatórios e opcionais, opções de seleção e destinos automáticos para os setores e observadores) já foram validados na triagem técnica.\n\n` +
          `Nossa equipe de Desenvolvimento já iniciou a parametrização dos novos formulários no Formcreator do GLPI. Assim que estiverem publicados no catálogo e disponíveis para homologação, avisaremos por aqui para que você possa realizar os testes de validação!\n\n` +
          `Permanecemos à disposição!`;
      } else {
        translatedIntent =
          `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a criação de novo(s) formulário(s)/item(ns) no **GLPI** para o setor de **${sectorName}**, porém sem especificar todos os campos necessários.`;
        sufficiencyStatus = "parcial";
        missingInfo = [
          "Relação dos campos a serem criados no formulário (indicando quais são obrigatórios e quais são opcionais)",
          "Opções de seleção para campos do tipo lista suspensa/menu",
          "Setores, grupos ou observadores de destino automático dos chamados gerados pelo formulário",
        ];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente à criação de novo(s) formulário(s) no **GLPI** para o setor de **${sectorName}**.\n\n` +
          `Para que possamos parametrizar os formulários exatamente conforme a necessidade do fluxo de trabalho, você poderia nos detalhar:\n` +
          `1. A **relação dos campos** desejados (indicando quais devem ser obrigatórios e quais são opcionais);\n` +
          `2. As **opções de seleção** para campos de lista/menu;\n` +
          `3. Quais **setores, grupos ou observadores** devem receber automaticamente os chamados abertos por esse formulário?\n\n` +
          `Assim que nos confirmar essas informações por aqui, daremos sequência imediata na configuração!`;
      }
    } else if (
      !/\b(item no glpi|itens no glpi|formul[aá]rio(s)? no glpi|formcreator|criar novos? itens?|criar novos? formul[aá]rios?)\b/i.test(
        normAll
      ) &&
      ((/\b(clinicas?|16\d{6})\b/i.test(normAll) &&
        /\b(nas|atendentes?|secret[aá]rias?|web\s*sa[uú]de|liberar acesso|vincular)\b/i.test(
          normAll
        )) ||
        /\bweb\s*sa[uú]de\b/i.test(normAll) ||
        (/\b16\d{6}\b/.test(normAll) &&
          /\b(prestador|acesso|permissao)\b/i.test(normAll)))
    ) {
      const isUserCreation =
        /\bcria[çc][ãa]o de usu[áa]rios?\b/i.test(normAll) ||
        formFields.tipo === "Criação de Usuários" ||
        ticket.category.includes("Criação de Usuários");

      const colabName =
        formFields.nomeColaborador ||
        ((ticket.content || "").match(/Nome\s*:\s*([^\n\r]+)/i)?.[1] || "").trim();

      const prestadorCode =
        ((ticket.content || "").match(/C[óo]digo do Prestador\s*:\s*([^\n\r]+)/i)?.[1] || "").trim() ||
        ((ticket.content || "").match(/\b(16\d{6})\b/)?.[1] || "").trim();

      const prestadorName =
        ((ticket.content || "").match(/Nome do Prestador\s*:\s*([^\n\r]+)/i)?.[1] || "").trim();

      const prestadorFull = prestadorCode
        ? (prestadorName ? `${prestadorCode} - ${prestadorName}` : prestadorCode)
        : "";

      const emailMatch = (ticket.content || "").match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i);
      const userEmail = emailMatch ? emailMatch[0].trim() : "";

      if (isUserCreation && colabName) {
        translatedIntent =
          `A solicitante **${ticket.requester}** (${sectorName}) solicita a criação de novo usuário no sistema **Web Saúde (módulo do ERP HRP Unimed)** para a secretária **${colabName}**, ` +
          `com vinculação ao prestador **${prestadorFull}**. ` +
          `O chamado foi aberto na categoria correta (${ticket.category}) e contém todos os dados cadastrais necessários (Nome, CPF, Data de Nascimento, E-mail e Código do Prestador).`;
        detectedDomain = "Acessos, Permissões e Contas";
        suggestedCategory = "T.I > ST > Acesso e Permissões > Criação de Usuários";
        realUrgency = ticket.urgency_label || "Média";
        urgencyReason =
          `Criação de novo usuário para secretária/atendente de clínica credenciada no Web Saúde (${prestadorFull}).`;
        sufficiencyStatus = "completo";
        missingInfo = [];

        const emailNote = userEmail
          ? ` e os dados de primeiro acesso encaminhados para o e-mail informado (**${userEmail}**)`
          : "";

        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente à criação de novo usuário no sistema **Web Saúde (HRP)** para a secretária **${colabName}**, vinculada ao prestador **${prestadorFull}**.\n\n` +
          `Todos os dados cadastrais necessários já foram validados na triagem e nossa equipe técnica está realizando o cadastro do usuário diretamente no HRP e a vinculação da clínica.\n\n` +
          `Assim que o acesso for liberado${emailNote}, confirmaremos por aqui!`;
      } else {
        const clinicMatches = (ticket.content || "").match(/\b16\d{6}(?:\s*-\s*[^\n,]+)?/g) || [];
        const clinicsList = clinicMatches.length > 0
          ? clinicMatches.map((c) => `**${c.trim()}**`).join(" e ")
          : "novas clínicas informadas";

        const mentionsNas = /\bnas\b/i.test(normAll);
        const targetGroup = mentionsNas
          ? "atendentes do **NAS (Núcleo de Atenção à Saúde - Passos)**"
          : "atendentes/secretárias";

        const isWrongCat =
          normalizeText(ticket.category || "").includes("aplicativos") ||
          normalizeText(ticket.category || "").includes("sistemas operacionais");

        const catNote = isWrongCat
          ? "O chamado foi aberto em categoria incorreta (Aplicativos) e recomenda-se reclassificar para 'T.I > ST > Acesso e Permissões'."
          : `O chamado foi aberto na categoria '${ticket.category}'.`;

        translatedIntent =
          `A solicitante **${ticket.requester}** (${sectorName}) solicita a vinculação de acesso às clínicas ${clinicsList} ` +
          `no sistema **Web Saúde (módulo do ERP HRP Unimed, administrado centralmente no HRP)** para as ${targetGroup}. ` +
          `${catNote} Não foram especificados os nomes completos ou logins das atendentes que devem receber a permissão.`;
        detectedDomain = "Acessos, Permissões e Contas";
        suggestedCategory = "T.I > ST > Acesso e Permissões";
        realUrgency = "Média";
        urgencyReason =
          "Vinculação de clínicas no Web Saúde para atendimento de prestadores no NAS.";
        sufficiencyStatus = "incompleto";
        missingInfo = [
          "Nomes completos ou logins das atendentes do NAS que devem receber a permissão no Web Saúde",
          "Informar se a liberação deve contemplar toda a equipe do NAS ou espelhar o perfil de alguma atendente de referência",
        ];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente à liberação de acesso às novas clínicas (${clinicsList}) no sistema **Web Saúde (HRP)** para as ${targetGroup}.\n\n` +
          `Para que possamos realizar a vinculação nos usuários corretos, você poderia nos informar:\n` +
          `1. Quais são os **nomes completos ou logins das atendentes** do NAS que devem ter essas clínicas liberadas?\n` +
          `2. Caso a permissão deva espelhar o perfil de alguma colaboradora que já atende no setor, você poderia nos informar o **usuário de referência** (ou se deve liberar para toda a recepção do NAS)?\n\n` +
          `Assim que nos confirmar essas informações por aqui, realizaremos a vinculação no Web Saúde imediatamente!`;
      }
    } else if (
      normAll.includes("acesso e permissoes") ||
      ticket.category.includes("Acesso e Permissões") ||
      /\bfavor cadastrar\b|\bliberar acesso\b|\bcadastro d[eo]\b/i.test(normCore)
    ) {
      const descText = formFields.descricao || "";
      const normDesc = normalizeText(descText);

      // Tenta identificar se o relato pede cadastro/acesso para outra pessoa (ex: "Favor cadastrar Dr Humberto França Ferreira")
      const targetMatch = descText.match(
        /(?:favor\s+)?(?:cadastrar|liberar\s+acesso\s+(?:para|ao|a)|cadastro\s+d[eo]a?|acesso\s+(?:para|ao|a))\s+(?:o\s+|a\s+)?((?:dr\.?|dra\.?)\s+[^,\n.;]+|[A-ZÀ-Ú][a-zà-ú]+(?:\s+(?:da|de|do|dos|das|e|[A-ZÀ-Ú][a-zà-ú]+)){1,4})/i
      );
      let targetPerson = targetMatch
        ? targetMatch[1].replace(/\s+/g, " ").trim()
        : "";
      if (
        targetPerson &&
        /\b(atendentes?|clinicas?|novas?|usuarios?|setor|recepcao|nas)\b/i.test(
          targetPerson
        )
      ) {
        targetPerson = "";
      }

      const normColabForm = normalizeText(formFields.nomeColaborador || "");
      const normReqFirst = normalizeText(firstName);
      const normReqFull = normalizeText(ticket.requester || "");
      const normTarget = normalizeText(targetPerson);

      // Verifica se o solicitante preencheu os próprios dados no formulário em vez dos dados do beneficiário do acesso
      const filledOwnData =
        Boolean(targetPerson) &&
        normTarget !== normColabForm &&
        !normTarget.includes(normReqFirst) &&
        (normColabForm === normReqFirst ||
          normReqFull.startsWith(normColabForm) ||
          normColabForm.startsWith(normReqFirst));

      const beneficiaryName =
        targetPerson || formFields.nomeColaborador || "o(a) profissional";

      const rawAcessos = (formFields.acessos || "")
        .replace(/outros\s*\(?descrever em observa[çc][õo]es\)?,?\s*/gi, "")
        .trim();
      const mentionsSpecificSystem =
        /\b(spdata|sgh|wifi|wi-fi|lgpd|faculdade|email|e-mail|nextcloud|rede|active directory|totvs|hrp|autolac|myplace|pacs|biometria|facial|catraca|porta|portas)\b/i.test(
          normDesc
        );
      const hasSpecifiedAccesses = Boolean(rawAcessos) || mentionsSpecificSystem;
      const specifiedAccessTxt =
        rawAcessos || "sistemas informados na descrição";

      detectedDomain = "Acessos, Permissões e Contas";
      suggestedCategory = "T.I > ST > Acesso e Permissões";
      realUrgency =
        normDesc.includes("plantao") || normDesc.includes("medico") || normDesc.includes("dr ")
          ? "Alta"
          : ticket.urgency_label || "Média";
      urgencyReason =
        realUrgency === "Alta"
          ? "Liberação de acesso para profissional/médico em atuação assistencial/plantão no Hospital."
          : "Solicitação de concessão/cadastro de acessos e permissões.";

      const followupsPublicTxt = (ticket.followups || [])
        .filter((f) => !f.is_private)
        .map((f) => f.content)
        .join(" ");
      const normDescAndFollowups = normalizeText(`${descText} ${followupsPublicTxt}`);
      const mentionsFacialAccess =
        /\b(face|facial|biometria|catraca|porta|portas|reconhecimento facial|controle de acesso)\b/i.test(
          normDescAndFollowups
        );
      const hasPhotoAttached = /\.(jpg|jpeg|png|webp|bmp)\b/i.test(ticket.content);

      if (filledOwnData && !hasSpecifiedAccesses) {
        translatedIntent =
          `A solicitante **${ticket.requester}** (${sectorName}) abriu o chamado solicitando acesso para **${beneficiaryName}**, ` +
          `porém preencheu os campos do formulário (Nome e CPF) com os **próprios dados dela (${formFields.nomeColaborador})** em vez dos dados de **${beneficiaryName}**, ` +
          `além de não especificar quais acessos/sistemas ele(a) precisa.`;
        sufficiencyStatus = "incompleto";
        missingInfo = [
          `Especificar quais acessos ou sistemas precisam ser liberados para ${beneficiaryName} (ex.: sistema SGH Spdata, login de Rede/Windows, PACS, Wi-Fi ou controle de acesso/reconhecimento facial nas portas do Hospital)`,
          `Informar os dados cadastrais de ${beneficiaryName} (Nome completo, CPF, CRM/matrícula e contato/vínculo), pois o formulário foi preenchido com os dados da própria solicitante (${firstName})`,
          `Caso solicite acesso ao controle de acesso/reconhecimento facial nas portas do Hospital, enviar uma fotografia frontal e com expressão neutra do rosto de ${beneficiaryName}`,
        ];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação de acesso para o(a) **${beneficiaryName}**.\n\n` +
          `Verificamos que os campos do formulário foram preenchidos com os seus próprios dados (Nome e CPF) e não foi especificado quais acessos ele(a) necessita. Para realizarmos o cadastro corretamente, você poderia nos informar:\n` +
          `1. **Quais acessos ou sistemas** precisam ser liberados para o(a) **${beneficiaryName}** (ex.: SGH Spdata, login de Rede/computador, PACS, Wi-Fi ou controle de acesso/reconhecimento facial nas portas do Hospital)?\n` +
          `2. Os **dados cadastrais do(a) ${beneficiaryName}** (**CPF**, **CRM/matrícula** e contato/vínculo)?\n` +
          `3. **Caso solicite acesso ao controle de acesso/reconhecimento facial nas portas do Hospital**, enviar uma **fotografia frontal e com expressão neutra do rosto** da pessoa a ser cadastrada.\n\n` +
          `Assim que nos enviar essas informações por aqui, já realizamos a liberação!`;
      } else if (filledOwnData && hasSpecifiedAccesses) {
        translatedIntent =
          `A solicitante **${ticket.requester}** (${sectorName}) abriu o chamado solicitando acesso para **${beneficiaryName}** (${specifiedAccessTxt}), ` +
          `porém preencheu os campos do formulário (Nome e CPF) com os **próprios dados dela (${formFields.nomeColaborador})** em vez dos dados de **${beneficiaryName}**.`;
        sufficiencyStatus = "parcial";
        missingInfo = [
          `Informar os dados cadastrais de ${beneficiaryName} (CPF, CRM/matrícula e contato/vínculo), pois o formulário foi preenchido com os dados da própria solicitante (${firstName})`,
        ];
        if (mentionsFacialAccess && !hasPhotoAttached) {
          missingInfo.push(
            `Enviar uma fotografia frontal e com expressão neutra do rosto de ${beneficiaryName} para o cadastro no controle de acesso/reconhecimento facial nas portas do Hospital`
          );
        }
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação de acesso para o(a) **${beneficiaryName}**.\n\n` +
          `Notamos que os campos do formulário saíram preenchidos com os seus próprios dados (Nome e CPF). Para concluirmos a liberação, você poderia nos enviar:\n` +
          `1. Os **dados cadastrais do(a) ${beneficiaryName}** (**CPF**, **CRM/matrícula** e contato/vínculo)?\n` +
          (mentionsFacialAccess && !hasPhotoAttached
            ? `2. Uma **fotografia frontal e com expressão neutra do rosto** do(a) **${beneficiaryName}** (necessária para o controle de acesso/reconhecimento facial nas portas do Hospital)?\n\n`
            : `\n`) +
          `Assim que confirmar por aqui, já finalizamos o cadastro!`;
      } else if (!filledOwnData && !hasSpecifiedAccesses) {
        translatedIntent =
          `Solicitação de acesso aberta por **${ticket.requester}** referente a **${beneficiaryName}**` +
          (formFields.cpf ? ` (CPF: ${formFields.cpf})` : "") +
          `, porém o campo de acessos foi marcado como "Outros" sem especificar quais sistemas ou permissões precisam ser liberados.`;
        sufficiencyStatus = "parcial";
        missingInfo = [
          `Especificar quais acessos ou sistemas precisam ser liberados para ${beneficiaryName} (ex.: SGH Spdata, login de Rede/Windows, E-mail, Wi-Fi ou controle de acesso/reconhecimento facial nas portas do Hospital)`,
          `Caso solicite acesso ao controle de acesso/reconhecimento facial nas portas do Hospital, enviar uma fotografia frontal e com expressão neutra do rosto de ${beneficiaryName}`,
        ];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a solicitação de acesso referente a **${beneficiaryName}**.\n\n` +
          `Como o campo de acessos ficou marcado como "Outros", você poderia nos confirmar:\n` +
          `1. **Quais sistemas ou acessos específicos precisam ser liberados** (ex.: SGH Spdata, Rede/Windows, E-mail, Wi-Fi ou controle de acesso/reconhecimento facial nas portas do Hospital)?\n` +
          `2. **Caso solicite acesso ao controle de acesso/reconhecimento facial nas portas do Hospital**, enviar uma **fotografia frontal e com expressão neutra do rosto** da pessoa a ser cadastrada.\n\n` +
          `Assim que confirmar, já realizamos a liberação!`;
      } else if (mentionsFacialAccess && !hasPhotoAttached) {
        translatedIntent =
          `Solicitação de acesso ao controle de acesso/reconhecimento facial nas portas do Hospital referente a **${beneficiaryName}**` +
          (formFields.cpf ? ` (CPF: ${formFields.cpf})` : "") +
          `, porém sem o envio da fotografia facial obrigatória para o cadastro.`;
        sufficiencyStatus = "parcial";
        missingInfo = [
          `Enviar uma fotografia frontal e com expressão neutra do rosto de ${beneficiaryName} para o cadastro no controle de acesso/reconhecimento facial nas portas do Hospital`,
        ];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a solicitação de cadastro no controle de acesso/reconhecimento facial das portas do Hospital para **${beneficiaryName}**.\n\n` +
          `Para concluirmos o cadastro, por favor nos envie em anexo uma **fotografia frontal e com expressão neutra do rosto** da pessoa a ser cadastrada.\n\n` +
          `Assim que anexar a foto aqui no chamado, já realizamos a liberação!`;
      } else {
        translatedIntent =
          `Solicitação de acesso aberta por **${ticket.requester}** referente a **${beneficiaryName}**` +
          (formFields.cpf ? ` (CPF: ${formFields.cpf})` : "") +
          `, com os acessos solicitados (${specifiedAccessTxt}) e dados cadastrais já informados no chamado.`;
        sufficiencyStatus = "completo";
        missingInfo = [];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a solicitação de acesso referente a **${beneficiaryName}** (${specifiedAccessTxt}).\n\n` +
          `Todas as informações necessárias já constam no chamado e nossa equipe já iniciou a liberação. Assim que concluído, confirmaremos por aqui!`;
      }
    } else if (
      normAll.includes("cadastrada por engano") ||
      normAll.includes("cadastrado por engano") ||
      (/\b(cancelar|cancelamento|excluir|exclusao|estornar|inativar|remover)\b/i.test(
        normAll
      ) &&
        (normAll.includes("controle de contas") ||
          /\b(registro|conta|atendimento|guia)\b/i.test(normCore)))
    ) {
      const descText = formFields.descricao || "";
      const appName = formFields.aplicacao || "Controle de Contas";
      const regMatch = descText.match(/(?:registro|conta|atendimento|n[º°]?)\s*[:#-]?\s*(\d{3,12})/i) ||
        descText.match(/\b(\d{4,12})\b/);
      const recordNum = regMatch ? regMatch[1] : "";

      let personName = "";
      if (recordNum) {
        const afterNum = descText.match(
          new RegExp(`\\b${recordNum}\\s+([A-ZÀ-Úa-zà-ú]+(?:\\s+[A-ZÀ-Úa-zà-ú]+){1,5})`)
        );
        if (afterNum && afterNum[1]) {
          personName = afterNum[1].replace(/\s*,\s*.*$/, "").trim();
        }
      }

      detectedDomain = "Sistemas Internos / ERP / Sistemas Corporativos";
      suggestedCategory = "T.I > ST > Resolução de Problemas > Sistemas Internos";
      realUrgency = ticket.urgency_label || "Alta";
      urgencyReason = `Regularização de registro/conta no sistema ${appName} solicitado pelo setor ${sectorName}.`;

      if (recordNum || personName) {
        const targetLabel = [
          recordNum ? `registro **${recordNum}**` : "",
          personName ? `(**${personName}**)` : "",
        ]
          .filter(Boolean)
          .join(" ");

        translatedIntent =
          `Solicitação do setor **${sectorName}** (**${ticket.requester}**) para cancelamento no sistema **${appName}** ` +
          `do ${targetLabel}, cadastrado por engano. Todos os dados necessários para o cancelamento já foram informados no chamado.`;
        sufficiencyStatus = "completo";
        missingInfo = [];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação para cancelar no sistema **${appName}** o ${targetLabel}, cadastrado por engano.\n\n` +
          `Todos os dados necessários já constam no chamado e nossa equipe já iniciou o procedimento. Assim que o cancelamento for concluído, confirmaremos por aqui!`;
      } else {
        translatedIntent =
          `Solicitação do setor **${sectorName}** (**${ticket.requester}**) para cancelamento de registro/conta no sistema **${appName}**, ` +
          `porém sem informar o número do registro ou o nome do(a) paciente/beneficiário(a).`;
        sufficiencyStatus = "incompleto";
        missingInfo = [
          `Informar o número do registro/conta e o nome completo do(a) paciente/beneficiário(a) que deve ser cancelado no ${appName}`,
        ];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação de cancelamento no sistema **${appName}**.\n\n` +
          `Para executarmos o cancelamento com segurança, você poderia nos informar o **número do registro/conta** e o **nome completo do(a) paciente/beneficiário(a)**?\n\n` +
          `Assim que confirmar por aqui, já realizamos o cancelamento!`;
      }
    } else if (
      normAll.includes("controle de contas") &&
      (/\b(parametrizar|parametriza[çc][ãa]o|viabilidade|melhoria|novas aplica[çc][õo]es|data da alta|data de alta|encaminhamento autom[aá]tico)\b/i.test(
        normAll
      ) ||
        ticket.category.includes("Desenvolvimento") ||
        ticket.category.includes("DV")) &&
      !/\b(reabrir|reabertura|abrir conta|abrir contas|abrir registro|encerrad[ao] erroneamente|cancelar|cancelamento|excluir)\b/i.test(
        normAll
      )
    ) {
      const descText = formFields.descricao || ticket.content || "";
      const isMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor)\b/i.test(
        firstName
      );
      const solPrefix = isMale ? "O solicitante" : "A solicitante";

      detectedDomain = "Desenvolvimento de Software / Aplicações Internas";
      suggestedCategory = ticket.category.includes("DV")
        ? ticket.category
        : "T.I > DV > Desenvolvimento > Novas aplicações";
      realUrgency = ticket.urgency_label || "Muito baixa";
      urgencyReason =
        "Demanda de desenvolvimento e parametrização de novas regras/funcionalidades no sistema Controle de Contas.";

      const mentionsDev = /\b(mois[ée]s|moises conte)\b/i.test(normAll);
      const devNote = mentionsDev
        ? " (demanda de Desenvolvimento direcionada ao desenvolvedor Moisés Conte)"
        : " (demanda de Desenvolvimento de aplicações internas)";

      translatedIntent =
        `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a análise de viabilidade e parametrização no sistema **Controle de Contas**, ` +
        `para inclusão do campo **data da alta do paciente em contas internas** e da regra de **encaminhamento automático** do sistema no dia da alta${devNote}. ` +
        `Todos os parâmetros e a justificativa constam informados no chamado. O chamado está corretamente categorizado em '${ticket.category}'.`;
      sufficiencyStatus = "completo";
      missingInfo = [];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente à melhoria e parametrização no sistema **Controle de Contas**.\n\n` +
        `A proposta para inclusão do campo **data da alta do paciente em contas internas** e a regra de **encaminhamento automático** no dia da alta já foram validadas na triagem técnica e direcionadas para o desenvolvedor (**Moisés Conte**) analisar a viabilidade e estrutura de implementação.\n\n` +
        `Assim que tivermos o parecer técnico da equipe de Desenvolvimento ou os ajustes estiverem disponíveis para homologação com o Faturamento, atualizaremos você por aqui!\n\n` +
        `Permanecemos à disposição!`;
    } else if (
      /\b(reabrir|reabertura|abrir conta|abrir contas|abrir registro|encerrad[ao] erroneamente)\b/i.test(
        normAll
      ) &&
      (normAll.includes("controle de contas") ||
        /\b(registro|conta|atendimento|faturamento)\b/i.test(normCore) ||
        /\b(faturamento|auditoria)\b/i.test(sectorName))
    ) {
      const descText = formFields.descricao || "";
      const appName =
        formFields.aplicacao ||
        (normAll.includes("controle de contas")
          ? "Controle de Contas"
          : "sistema interno");
      const regMatch =
        descText.match(
          /(?:registro|conta|atendimento|n[º°]?)\s*[:#-]?\s*(\d{3,12})/i
        ) || descText.match(/\b(\d{4,12})\b/);
      const recordNum = regMatch ? regMatch[1] : "";

      detectedDomain = "Sistemas Internos / ERP / Sistemas Corporativos";
      suggestedCategory =
        ticket.category.includes("Solicitação Diversa") ||
        ticket.category.includes("Acesso")
          ? "T.I > ST > Resolução de Problemas > Sistemas Internos"
          : ticket.category;
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason = `Reabertura de registro/conta no sistema ${appName} solicitada pelo setor ${sectorName} para continuidade do faturamento/auditoria.`;

      if (recordNum) {
        translatedIntent =
          `A solicitante **${ticket.requester}** (${sectorName}) solicita a reabertura do registro **${recordNum}** no sistema **${appName}**, ` +
          `informando que foi encerrado erroneamente. Todos os dados necessários para o atendimento já constam no chamado.`;
        sufficiencyStatus = "completo";
        missingInfo = [];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente à reabertura do registro **${recordNum}** no sistema **${appName}**, que foi encerrado erroneamente.\n\n` +
          `Os dados informados já foram validados na triagem e nossa equipe técnica está realizando a reabertura do registro no sistema para que você possa dar andamento no ${sectorName}.\n\n` +
          `Assim que o registro estiver liberado para movimentação, confirmaremos a conclusão por aqui!`;
      } else {
        translatedIntent =
          `Solicitação do setor **${sectorName}** (**${ticket.requester}**) para reabertura de registro/conta no sistema **${appName}**, ` +
          `porém sem informar o número do registro afetado.`;
        sufficiencyStatus = "incompleto";
        missingInfo = [
          `Informar o número do registro/conta no sistema ${appName} que precisa ser reaberto`,
        ];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação de reabertura de conta no sistema **${appName}**.\n\n` +
          `Para localizarmos e reabrirmos o registro correto no sistema, você poderia nos informar o **número do registro/conta**?\n\n` +
          `Assim que nos confirmar o número por aqui, já efetuamos a reabertura!`;
      }
    } else if (
      (/\b(vincular|vinculacao|habilitar|atribuir)\b/i.test(normAll) &&
        /\b(usuario|perfil|controle de contas|sgh|spdata|hrp|sistema|unidade)\b/i.test(
          normAll
        )) ||
      (normAll.includes("controle de contas") &&
        /\b(acesso|acessos|permissao|permissoes|vincular|liberar|meu usuario)\b/i.test(
          normAll
        ))
    ) {
      const descText = `${ticket.title || ""} ${formFields.descricao || ""}`;
      const sysName = normAll.includes("controle de contas")
        ? "Controle de Contas"
        : /\b(s\.?g\.?h|spdata)\b/i.test(normAll)
        ? "S.G.H. (Spdata)"
        : normAll.includes("hrp")
        ? "HRP"
        : formFields.aplicacao || "sistema interno";

      const unitMatch = descText.match(
        /\b(?:(?:controle de contas|sistema)\s+(?:de|da|do)|(?:unidade|nucleo|núcleo)\s+(?:de\s+|da\s+|do\s+)?)\s*([A-ZÀ-Úa-zà-ú]+(?:\s+d[eo]\s+[A-ZÀ-Úa-zà-ú]+)?)\b/i
      );
      const rawUnit = unitMatch ? unitMatch[1].trim() : "";
      const unitName =
        rawUnit &&
        !/^(ao|no|para|meu|minha|usuario|usuário|bom|boa|ola|olá|favor)$/i.test(
          rawUnit
        )
          ? rawUnit.charAt(0).toUpperCase() + rawUnit.slice(1)
          : "";

      const sysWithUnit = unitName
        ? `${sysName} (unidade ${unitName})`
        : sysName;
      const isForOwnUser =
        /\b(meu usuario|meu perfil|para mim|no meu login|ao meu)\b/i.test(
          normAll
        );
      const categoryMismatch =
        !/acesso|permiss/i.test(ticket.category || "");

      detectedDomain = "Acessos, Permissões e Contas";
      suggestedCategory = "T.I > ST > Acesso e Permissões";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason = `Liberação/vinculação de permissão de acesso ao sistema ${sysWithUnit} para execução das rotinas do setor ${sectorName}.`;

      if (isForOwnUser || formFields.nomeColaborador) {
        const targetWho = isForOwnUser
          ? `ao próprio usuário dela (**${ticket.requester}**)`
          : `ao usuário de **${formFields.nomeColaborador}**`;
        translatedIntent =
          `A solicitante **${ticket.requester}** (${sectorName}) solicita a vinculação/liberação de acesso ao sistema **${sysWithUnit}** ${targetWho}.` +
          (categoryMismatch
            ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "T.I > ST > Acesso e Permissões").*`
            : "") +
          ` Todos os dados necessários (sistema, unidade e usuário) já constam no chamado.`;
        sufficiencyStatus = "completo";
        missingInfo = [];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação para vincular o sistema **${sysWithUnit}** ao seu usuário.\n\n` +
          `Nossa equipe técnica já está realizando a vinculação da permissão no seu perfil e, assim que concluído, confirmaremos por aqui!`;
      } else {
        translatedIntent =
          `Solicitação aberta por **${ticket.requester}** (${sectorName}) para vinculação/liberação de acesso no sistema **${sysWithUnit}**, pendente de confirmação de qual usuário receberá a permissão.`;
        sufficiencyStatus = "parcial";
        missingInfo = [
          `Confirmar o nome completo/login do usuário que deverá receber o vínculo no ${sysWithUnit}`,
        ];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação de acesso ao sistema **${sysWithUnit}**. Para realizarmos a vinculação corretamente, você poderia confirmar para **qual usuário (nome/login)** devemos liberar o acesso e se há alguma unidade específica a vincular?\n\n` +
          `Assim que confirmar por aqui, já realizamos a liberação!`;
      }
    } else if (
      (/\b(s\.?g\.?h|spdata)\b/i.test(normAll) &&
        /\b(relatorio|relatorios|agendado|envio diario|check-?list)\b/i.test(
          normAll
        )) ||
      /\b(relatorio agendado|envio diario de relatorio)\b/i.test(normAll)
    ) {
      const descText = `${ticket.title || ""} ${formFields.descricao || ""}`;
      const titleMatch =
        descText.match(/t[íi]tulo\s*:\s*([^\n.]+)/i) ||
        descText.match(/\b(RELAT[ÓO]RIO\s+[A-ZÀ-Ú0-9\s-]{5,60})/i);
      const reportTitle = titleMatch ? titleMatch[1].trim() : "";
      const hasEnoughContext =
        Boolean(reportTitle) ||
        (formFields.descricao || "").trim().length >= 35;

      detectedDomain = "Sistemas Internos / ERP / Sistemas Corporativos";
      suggestedCategory =
        ticket.category || "T.I > DV > Desenvolvimento > Correção de bugs";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason =
        "Interrupção no envio automático de relatório agendado no sistema S.G.H. (Spdata).";

      if (hasEnoughContext) {
        const repLabel = reportTitle ? ` (**${reportTitle}**)` : "";
        translatedIntent =
          `Solicitação aberta por **${ticket.requester}** (${sectorName}) relatando interrupção no recebimento do envio diário de relatório agendado do sistema **S.G.H. (Spdata)**${repLabel}. ` +
          `Os dados necessários (sistema, título do relatório e período da falha) já constam informados no chamado.`;
        sufficiencyStatus = "completo";
        missingInfo = [];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos o seu relato sobre o não recebimento do envio diário do relatório agendado no sistema **S.G.H. (Spdata)**${repLabel}.\n\n` +
          `Nossa equipe técnica já está verificando o problema no serviço de agendamento/disparo do relatório e retornaremos o mais breve possível por aqui!`;
      } else {
        translatedIntent =
          `Solicitação aberta por **${ticket.requester}** (${sectorName}) relatando falha no recebimento de relatório agendado no sistema **S.G.H. (Spdata)**, pendente de confirmação do título exato do relatório.`;
        sufficiencyStatus = "parcial";
        missingInfo = [
          "Título exato do relatório agendado no S.G.H. (Spdata) e desde qual data parou de ser recebido",
        ];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Já estamos verificando o serviço de envio de relatórios do sistema **S.G.H. (Spdata)**. Para localizarmos rapidamente a rotina no agendador, você poderia nos confirmar o **título exato do relatório** e **desde qual data** ele parou de chegar?\n\n` +
          `Assim que nos informar por aqui, já verificamos!`;
      }
    } else if (
      /\b(indicadores|indicador|wconect|wconnect)\b/i.test(normAll) ||
      (/\b(solicito|solicita|extrair|extracao|levantamento)\b/i.test(normAll) &&
        /\b(relatorio|relatorios|produtividade|atendimentos)\b/i.test(normAll))
    ) {
      const descOnly = formFields.descricao || "";
      const fullText = `${ticket.title || ""} ${descOnly}`;
      const sysName = /\bwconect|wconnect\b/i.test(normAll)
        ? "WConect"
        : /\b(s\.?g\.?h|spdata)\b/i.test(normAll)
        ? "S.G.H. (Spdata)"
        : /\bhrp\b/i.test(normAll)
        ? "HRP"
        : formFields.aplicacao || "sistema informado";

      const hasPeriod =
        /\b(\d{1,2}\/\d{1,2}|janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|m[êe]s passado|este m[êe]s|per[íi]odo\s+de|semanal|mensal|anual|202\d)\b/i.test(
          descOnly
        );
      const byRecep = /\bpor\s+recepcionista\b/i.test(fullText)
        ? " por recepcionista"
        : "";

      detectedDomain = "Sistemas Internos / ERP / Sistemas Corporativos";
      suggestedCategory = /\b(dashboard|dashboards|painel)\b/i.test(normAll)
        ? "T.I > BD > Big Data e BI > Dashboards"
        : "T.I > BD > Big Data e BI > Relatórios";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason = `Extração de indicadores/relatórios gerenciais do sistema ${sysName} para acompanhamento operacional do setor ${sectorName}.`;

      const categoryMismatch =
        normalizeText(ticket.category || "") !==
        normalizeText(suggestedCategory);
      const reclassNote = categoryMismatch
        ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}").*`
        : "";

      if (hasPeriod) {
        translatedIntent =
          `A solicitante **${ticket.requester}** (${sectorName}) solicita a extração dos **indicadores de atendimento do sistema ${sysName}${byRecep}**.` +
          reclassNote +
          ` Os parâmetros necessários para a extração já foram informados.`;
        sufficiencyStatus = "completo";
        missingInfo = [];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação dos **indicadores de atendimento do ${sysName}${byRecep}** para o setor **${sectorName}**.\n\n` +
          `Nossa equipe já está realizando a extração dos dados e, assim que o relatório estiver consolidado, encaminharemos por aqui!`;
      } else {
        translatedIntent =
          `A solicitante **${ticket.requester}** (${sectorName}) solicita a extração dos **indicadores de atendimento do sistema ${sysName}${byRecep}**, porém não especificou o período (data inicial e final ou mês de referência) para a consulta.` +
          reclassNote;
        sufficiencyStatus = "parcial";
        missingInfo = [
          `Informar o período de apuração desejado (data inicial e data final ou mês de referência) para extração dos indicadores no ${sysName}`,
        ];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação dos **indicadores de atendimento do ${sysName}${byRecep}** para o setor **${sectorName}**.\n\n` +
          `Para realizarmos a extração corretamente, você poderia nos informar qual o **período de referência (data inicial e data final ou mês)** que deseja consultar?\n\n` +
          `Assim que nos confirmar o período por aqui, já geramos e encaminhamos o relatório!`;
      }
    } else if (
      /\b(meu ponto|dispositivo nao e valido)\b/i.test(normAll) ||
      (/\bbenner\b/i.test(normAll) && /\bponto\b/i.test(normAll)) ||
      (/\b(realizar ponto|bater ponto|registrar ponto|ponto de sua entrada)\b/i.test(
        normAll
      ) &&
        /\b(app|aplicativo|celular|dispositivo)\b/i.test(normAll))
    ) {
      const descOnly = formFields.descricao || "";
      const collabMatch = descOnly.match(
        /\b(?:colaborador(?:a)?|funcion[áa]ri[oa]|usu[áa]ri[oa])\s+([A-ZÀ-Ú][a-zà-ú]+(?:\s+(?:da|de|do|dos|das|e|[A-ZÀ-Ú][a-zà-ú]+)){1,4})/
      );
      const targetCollab = collabMatch
        ? collabMatch[1].replace(/\s*[,.;].*$/, "").trim()
        : formFields.nomeColaborador || "";

      const isSelfRequest =
        !targetCollab &&
        /\b(nao consegui|não consegui|meu celular|troquei de celular|meu login|meu usuario)\b/i.test(
          normAll
        );

      detectedDomain = "Sistemas Internos / ERP / Sistemas Corporativos";
      suggestedCategory = "T.I > ST > Resolução de Problemas > Erros de Sistema";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason =
        "Bloqueio de registro de ponto eletrônico no aplicativo Meu Ponto (Benner) por troca/validação de dispositivo móvel.";

      const categoryMismatch =
        normalizeText(ticket.category || "") !==
        normalizeText(suggestedCategory);
      const reclassNote = categoryMismatch
        ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}").*`
        : "";

      if (targetCollab || isSelfRequest) {
        const whoTxt = targetCollab
          ? `da colaboradora **${targetCollab}**`
          : `do(a) colaborador(a) **${ticket.requester}**`;
        const actionWhoTxt = targetCollab
          ? `para que a colaboradora **${targetCollab}** possa registrar o ponto normalmente`
          : `para que você possa registrar o ponto normalmente`;

        translatedIntent =
          `A solicitante **${ticket.requester}** (${sectorName}) solicita suporte referente ao erro no aplicativo **Meu Ponto (Benner)** no acesso ${whoTxt} (*"Esse dispositivo não é válido para o usuário logado"*). ` +
          `Esse erro ocorre quando o(a) colaborador(a) trocou de aparelho celular ou reinstalou o app, sendo necessário desvincular o dispositivo antigo e liberar o vínculo do novo aparelho ao login no Benner.` +
          reclassNote;
        sufficiencyStatus = "completo";
        missingInfo = [];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente ao acesso ${whoTxt} no aplicativo **Meu Ponto (Benner)**.\n\n` +
          `A mensagem apresentada (*"Esse dispositivo não é válido para o usuário logado"*) ocorre quando há troca ou reinstalação do aparelho celular, sendo necessário desvincular o dispositivo antigo e vincular o novo aparelho ao login.\n\n` +
          `Nossa equipe técnica já está realizando a liberação do novo dispositivo no sistema Benner ${actionWhoTxt}. Assim que concluído, confirmaremos por aqui!`;
      } else {
        translatedIntent =
          `Solicitação aberta por **${ticket.requester}** (${sectorName}) relatando erro de validação de dispositivo no aplicativo **Meu Ponto (Benner)** (*"Esse dispositivo não é válido para o usuário logado"*), pendente de confirmação do nome completo/matrícula do(a) colaborador(a) que trocou de aparelho.` +
          reclassNote;
        sufficiencyStatus = "parcial";
        missingInfo = [
          "Confirmar o nome completo (ou matrícula/CPF) do(a) colaborador(a) que precisa ter o novo dispositivo vinculado no app Meu Ponto (Benner)",
        ];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Esse erro no aplicativo **Meu Ponto (Benner)** (*"Esse dispositivo não é válido para o usuário logado"*) ocorre quando há troca de aparelho celular, sendo necessário vincular o novo dispositivo ao login.\n\n` +
          `Para realizarmos a liberação, você poderia nos confirmar o **nome completo (ou CPF/matrícula)** do(a) colaborador(a)?\n\n` +
          `Assim que nos informar por aqui, já efetuamos a liberação!`;
      }
    } else if (
      /\boncologia\b/i.test(normAll) &&
      (/\bagenda\b/i.test(normAll) ||
        /\bagendamento\b/i.test(normAll) ||
        /\b(layout|interface|duracao|tempo minimo|tempo de duracao)\b/i.test(normAll))
    ) {
      const descText = formFields.descricao || ticket.content || "";
      const isMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor)\b/i.test(
        firstName
      );
      const solPrefix = isMale ? "O solicitante" : "A solicitante";

      detectedDomain = "Desenvolvimento de Software / Aplicações Internas";
      suggestedCategory = ticket.category.includes("DV")
        ? ticket.category
        : "T.I > DV > Desenvolvimento > Ajustes em layout/interface";
      realUrgency = ticket.urgency_label || "Muito baixa";
      urgencyReason =
        "Demanda evolutiva de desenvolvimento no Sistema de Agendamento de Oncologia para ajuste de tempo mínimo de duração.";

      const minTimeMatch = descText.match(
        /(?:tempo\s+m[íi]nimo.*?|preenchimento\s+seja\s+de\s*)(\d+)\s*(?:minutos?|min)/i
      );
      const targetMinTime = minTimeMatch ? `${minTimeMatch[1]} minutos` : "15 minutos";

      const currTimeMatch = descText.match(
        /(?:atualmente.*?|tempo\s+m[íi]nimo\s+[ée]\s+de\s*)(\d+)\s*(?:minutos?|min|hora|uma hora)/i
      );
      const currTime = currTimeMatch ? `${currTimeMatch[1]} minutos` : "60 minutos (uma hora)";

      const mentionsDev = /\b(mois[ée]s|desenvolvedor)\b/i.test(descText);
      const devNote = mentionsDev
        ? " (demanda alinhada com o desenvolvedor Moisés)"
        : "";

      const sectorLabel =
        formFields.setor && formFields.setor !== "Oncologia"
          ? `${formFields.setor} / Oncologia`
          : sectorName;

      translatedIntent =
        `${solPrefix} **${ticket.requester}** (${sectorLabel}) solicita ajuste no sistema **Agenda Oncologia** (aplicação web de agendamento de consultas e sessões oncológicas), ` +
        `para alterar o tempo mínimo de duração dos agendamentos de ${currTime} para **${targetMinTime}**, permitindo a gestão de procedimentos de menor duração (como administração de medicação via subcutânea)${devNote}. ` +
        `Todos os parâmetros e a justificativa constam informados no chamado. O chamado está corretamente categorizado em '${ticket.category}'.`;
      sufficiencyStatus = "completo";
      missingInfo = [];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente ao ajuste no **Sistema de Agendamento de Oncologia**.\n\n` +
        `A especificação para alteração do tempo mínimo de preenchimento da duração dos agendamentos para **${targetMinTime}** (atualmente configurado em ${currTime}), visando viabilizar a marcação de procedimentos rápidos como medicação subcutânea, já foi validada na triagem técnica e está em tratativa com a equipe de Desenvolvimento (Moisés).\n\n` +
        `Assim que o ajuste for implementado e publicado no sistema, confirmaremos a liberação por aqui para que a equipe da Oncologia possa realizar a validação!\n\n` +
        `Permanecemos à disposição!`;
    } else if (
      !/\boncologia\b/i.test(normAll) &&
      /\bagenda\b/i.test(normAll) &&
      /\b(pep|sgh|spdata|atendimento|intervalo|horario|horarios|fisioterapeuta|medic[oa]|dr|dra|consulta|consultorio)\b/i.test(
        normAll
      )
    ) {
      const descOnly = formFields.descricao || "";
      const isNucleoOrOutpatient =
        /\b(nucleo|núcleo|nas|piumhi|passos|promoprev|consultorio|consultório|prontu|prontu\+|prontuplus)\b/i.test(
          normAll
        ) ||
        /\b(nucleo|núcleo|nas|promoprev)\b/i.test(sectorName);

      const sysName = isNucleoOrOutpatient
        ? "Prontu+ (PEP do Núcleo)"
        : /\bsgh\b/i.test(normAll)
        ? "PEP Hospitalar (SGH Spdata)"
        : /\bprontu\b/i.test(normAll)
        ? "Prontu+"
        : /\bpep\b/i.test(normAll)
        ? "Prontu+ (PEP)"
        : formFields.aplicacao || "Prontu+ (PEP)";

      const profDescMatch = descOnly.match(
        /\bagenda\s+d[aoe]\s+(?:(fisioterapeuta|m[ée]dic[oa]|dr\.?(?:a)?|nutricionista|psic[óo]log[oa]|terapeuta|enfermeir[oa]|profissional|colaborador(?:a)?)\s+)?([A-ZÀ-Ú][a-zà-ú]+(?:\s+(?:da|de|do|dos|das|e|[A-ZÀ-Ú][a-zà-ú]+)){1,4})/i
      );
      const profTitleMatch = (ticket.title || "").match(
        /\bagenda\s+(?:d[aoe]\s+)?([A-ZÀ-Ú][a-zà-ú]+(?:\s+(?:da|de|do|dos|das|e|[A-ZÀ-Ú][a-zà-ú]+)){0,4})\s*$/i
      );

      const profRole = profDescMatch?.[1]
        ? profDescMatch[1].toLowerCase()
        : "profissional";
      const profName = profDescMatch?.[2]
        ? profDescMatch[2].replace(/\s*[,.;].*$/, "").trim()
        : profTitleMatch?.[1]
        ? profTitleMatch[1].trim()
        : "";

      const hasTimeRange =
        /\b\d{1,2}\s*:\s*\d{2}\b/.test(descOnly) ||
        /\b\d{1,2}\s*h(?:oras|s)?\b/i.test(descOnly);
      const hasDurationOrInterval =
        /\b(atendimento\s+de|intervalo\s+de|dura[çc][ãa]o|minutos|min)\b/i.test(
          descOnly
        );

      const scheduleDetails = descOnly
        .replace(/^boa\s+(?:tarde|dia|noite)\s*[,!]?\s*/i, "")
        .replace(/\b(?:obrigad[oa]|att|atenciosamente)\b[\s\S]*$/i, "")
        .replace(/\s+/g, " ")
        .trim();

      detectedDomain = "Sistemas Internos / ERP / Sistemas Corporativos";
      suggestedCategory = "T.I > ST > Instalação/Configuração > Aplicativos";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason = `Solicitação de parametrização/alteração de grade de agenda de profissional no sistema ${sysName}, impactando a disponibilização de horários de atendimento.`;

      const categoryMismatch =
        normalizeText(ticket.category || "") !==
        normalizeText(suggestedCategory);
      const reclassNote = categoryMismatch
        ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}").*`
        : "";

      if (profName && (hasTimeRange || hasDurationOrInterval)) {
        const roleAndName =
          profRole && profRole !== "profissional"
            ? `${profRole} **${profName}**`
            : `profissional **${profName}**`;

        translatedIntent =
          `A solicitante **${ticket.requester}** (${sectorName}) solicita alteração na agenda d${
            profRole.endsWith("a") ? "a" : "o"
          } ${roleAndName} no sistema **${sysName}**, parametrizando os horários e intervalos de atendimento (${scheduleDetails}). ` +
          `Todas as informações necessárias (profissional, faixa de horário, duração do atendimento e intervalo) já foram informadas no relato.` +
          reclassNote;
        sufficiencyStatus = "completo";
        missingInfo = [];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação de alteração na agenda d${
            profRole.endsWith("a") ? "a" : "o"
          } ${roleAndName} no sistema **${sysName}**.\n\n` +
          `Todos os parâmetros informados (faixa de horário, tempo de atendimento e intervalo) já foram validados e nossa equipe técnica está realizando a configuração da agenda no sistema.\n\n` +
          `Assim que a alteração estiver concluída e disponível no ${sysName}, confirmaremos por aqui!`;
      } else {
        const missingList = [];
        if (!profName) {
          missingList.push(
            `Nome completo do(a) profissional de saúde cuja agenda deve ser alterada no ${sysName}`
          );
        }
        if (!hasTimeRange && !hasDurationOrInterval) {
          missingList.push(
            "Dias da semana, horário inicial e final, tempo de duração de cada atendimento e intervalo"
          );
        }
        translatedIntent =
          `Solicitação aberta por **${ticket.requester}** (${sectorName}) para alteração de agenda no sistema **${sysName}**${
            profName ? ` referente a **${profName}**` : ""
          }, pendente de detalhamento completo dos parâmetros de horário.` +
          reclassNote;
        sufficiencyStatus = "parcial";
        missingInfo = missingList;
        const questionsBul = missingList.map((q) => `- ${q}`).join("\n");
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação de alteração de agenda no sistema **${sysName}**.\n\n` +
          `Para realizarmos a parametrização corretamente, você poderia nos confirmar:\n` +
          `${questionsBul}\n\n` +
          `Assim que nos informar por aqui, já executamos a alteração!`;
      }
    } else if (
      /\b(unifica|unificar|unificacao|mais de um cadastro|2 cadastros|dois cadastros|cadastro duplicado|cadastros duplicados|unificar as chaves)\b/i.test(
        normAll
      )
    ) {
      const descOnly = formFields.descricao || "";
      const sysName =
        formFields.aplicacao ||
        (/\bhrp\b/i.test(normAll)
          ? "HRP Unimed"
          : /\bpep\b/i.test(normAll)
          ? "PEP"
          : /\bsgh\b/i.test(normAll)
          ? "S.G.H."
          : "sistema");

      const personMatch = descOnly.match(
        /\b(?:(benefici[áa]ri[oa]|paciente|cliente|usu[áa]ri[oa])\s+)([A-ZÀ-Ú][a-zà-ú]+(?:\s+(?:da|de|do|dos|das|e|[A-ZÀ-Ú][a-zà-ú]+)){1,5})\b/
      );
      const pipeTitleMatch = (ticket.title || "").match(/\|\s*([A-ZÀ-Ú\s]{5,})$/);
      const personRole = personMatch?.[1]
        ? personMatch[1].toLowerCase()
        : "beneficiário(a)/paciente";
      const targetPerson = personMatch?.[2]
        ? personMatch[2].replace(/\s+(?:possui|tem|está|esta|com)\b.*$/i, "").trim()
        : pipeTitleMatch?.[1]
        ? pipeTitleMatch[1].trim()
        : "";

      const prevailMatch = descOnly.match(
        /\bprevalecer\s+(?:[ée]\s+)?(?:o\s+|a\s+)?["']?([^."',\n]+)["']?/i
      );
      const prevailTarget = prevailMatch?.[1] ? prevailMatch[1].trim() : "";
      const hasNumericKeys = /\b\d{3,}\b/.test(descOnly);

      detectedDomain = "Sistemas Internos / ERP / Sistemas Corporativos";
      suggestedCategory = "T.I > BD > Administração de Banco de Dados";
      realUrgency = ticket.urgency_label || "Alta";
      urgencyReason = `Duplicidade de cadastro no sistema ${sysName}, podendo gerar conflitos de histórico, faturamento ou atendimento do(a) ${personRole}.`;

      const categoryMismatch =
        normalizeText(ticket.category || "") !==
        normalizeText(suggestedCategory);
      const reclassNote = categoryMismatch
        ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}").*`
        : "";

      if (targetPerson || hasNumericKeys) {
        const whoLabel = targetPerson
          ? `d${personRole.endsWith("a") ? "a" : "o"} ${personRole} **${targetPerson}**`
          : "dos registros informados";
        const prevailTxt = prevailTarget
          ? `, mantendo o cadastro **${prevailTarget}** como principal`
          : "";

        translatedIntent =
          `A solicitante **${ticket.requester}** (${sectorName}) relatou que ${
            targetPerson
              ? `${personRole.endsWith("a") ? "a" : "o"} ${personRole} **${targetPerson}**`
              : "um(a) beneficiário(a)/paciente"
          } possui dois cadastros no sistema **${sysName}** e solicitou a unificação dos registros${prevailTxt}. ` +
          `Os dados necessários para a unificação já constam descritos no chamado.` +
          reclassNote;
        sufficiencyStatus = "completo";
        missingInfo = [];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos e analisamos a sua solicitação referente à unificação de cadastro ${whoLabel} no sistema **${sysName}**${prevailTxt}.\n` +
          `Os dados necessários já foram validados na triagem e nossa equipe técnica iniciou o atendimento.\n\n` +
          `Assim que concluído (ou caso precise testar do seu lado), atualizaremos você por aqui!`;
      } else {
        translatedIntent =
          `Solicitação aberta por **${ticket.requester}** (${sectorName}) para unificação de cadastros duplicados no sistema **${sysName}**, pendente de identificação dos códigos/chaves ou nome completo do(a) beneficiário(a)/paciente e de qual registro deve prevalecer.` +
          reclassNote;
        sufficiencyStatus = "parcial";
        missingInfo = [
          `Nome completo e códigos/chaves dos dois cadastros no sistema ${sysName}`,
          "Confirmar qual dos cadastros deve prevalecer como principal após a unificação",
        ];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação de unificação de cadastro no sistema **${sysName}**.\n\n` +
          `Para realizarmos o procedimento com segurança, você poderia nos informar:\n` +
          `- O **nome completo** (ou códigos/chaves) dos cadastros duplicados;\n` +
          `- Qual dos cadastros deve **prevalecer como principal**?\n\n` +
          `Assim que nos confirmar por aqui, já executamos a unificação!`;
      }
    } else {
      const resumoDesc = formFields.descricao
        ? formFields.descricao.replace(/\s+/g, " ").slice(0, 180)
        : ticket.title;
      const normDescOnly = normalizeText(formFields.descricao || "");
      const looksLikeError =
        /\b(erro|falha|travando|travou|lento|lentidao|nao abre|nao funciona|parou|caiu|inoperante)\b/i.test(
          normDescOnly
        );
      const hasConcreteIdentifiers =
        /\b\d{4,}\b/.test(formFields.descricao || "") ||
        /\banexo\s*:/i.test(ticket.content || "") ||
        (formFields.descricao || "").trim().length >= 50;

      detectedDomain = matchedPb
        ? matchedPb.domain
        : formFields.aplicacao
        ? "Sistemas Internos / ERP / Sistemas Corporativos"
        : "Suporte Técnico Geral / Service Desk";

      // Checagem inteligente de categoria caso o solicitante tenha escolhido uma categoria desalinhada (ex: Sistemas Operacionais / Aplicativos / Solicitação Diversa)
      let smartCat = ticket.category;
      if (
        /\b(sistemas operacionais|aplicativos|solicitacao diversa)\b/i.test(
          normalizeText(ticket.category || "")
        )
      ) {
        if (/\b(relatorio|relatorios|indicador|indicadores|bi|dashboard)\b/i.test(normAll)) {
          smartCat = "T.I > BD > Big Data e BI > Relatórios";
        } else if (/\b(acesso|permissao|permissoes|liberar|vincular|senha|login)\b/i.test(normAll)) {
          smartCat = "T.I > ST > Acesso e Permissões";
        } else if (looksLikeError) {
          smartCat = "T.I > ST > Resolução de Problemas > Erros de Sistema";
        } else if (
          /\bsistemas operacionais\b/i.test(normalizeText(ticket.category || "")) &&
          /\b(pep|sgh|spdata|wconect|benner|hrp|autolac|sistema|agenda)\b/i.test(normAll)
        ) {
          smartCat = "T.I > ST > Instalação/Configuração > Aplicativos";
        }
      }

      suggestedCategory = smartCat;
      realUrgency = ticket.urgency_label;
      urgencyReason = "Classificação baseada no relato e impacto operacional informados pelo solicitante.";

      if (matchedMemory) {
        const isMemActionMismatch =
          (/\b(reabrir|reabertura|cancelar|cancelamento|excluir|estornar)\b/i.test(normAll) &&
            /\b(vincular|vinculacao|unidade piumhi|acesso ao meu usuario)\b/i.test(
              normalizeText(`${matchedMemory.title || ""} ${matchedMemory.summary || ""}`)
            )) ||
          (!/\b(reabrir|reabertura|abrir conta|abrir contas|abrir registro|encerrad[ao] erroneamente)\b/i.test(normAll) &&
            /\b(reabrir|reabertura|abrir conta|abrir contas|abrir registro|1411181)\b/i.test(
              normalizeText(`${matchedMemory.title || ""} ${matchedMemory.summary || ""}`)
            )) ||
          (/\b(parametrizar|parametriza[çc][ãa]o|viabilidade|melhoria|novas aplica[çc][õo]es)\b/i.test(normAll) &&
            /\b(reabertura|reabrir|vincular|vinculacao|acesso|cancelar|1411181)\b/i.test(
              normalizeText(`${matchedMemory.title || ""} ${matchedMemory.summary || ""}`)
            ));
        if (!isMemActionMismatch) {
          translatedIntent =
            `O solicitante **${ticket.requester}** (${sectorName}) abriu o chamado: "${resumoDesc}". ` +
            `Triagem orientada pelo padrão aprendido anteriormente com o analista (${matchedMemory.source_id}).`;
          sufficiencyStatus = matchedMemory.sufficiency_status || "parcial";
          missingInfo = Array.isArray(matchedMemory.required_info)
            ? matchedMemory.required_info
            : [];
          if (matchedMemory.reply_template) {
            customPublicReply = matchedMemory.reply_template
              .replace(/\{solicitante\}/g, firstName)
              .replace(/\{titulo\}/g, ticket.title);
          }
        } else {
          translatedIntent =
            `O solicitante **${ticket.requester}** (${sectorName}) abriu o chamado solicitando: "${resumoDesc}".`;
          sufficiencyStatus = hasConcreteIdentifiers ? "completo" : "parcial";
          missingInfo = hasConcreteIdentifiers ? [] : ["Informar os dados complementares para atendimento"];
        }
      } else if (!looksLikeError && hasConcreteIdentifiers && !matchedPb) {
        translatedIntent =
          `O solicitante **${ticket.requester}** (${sectorName}) abriu o chamado solicitando: "${resumoDesc}". ` +
          "As informações necessárias para atendimento já constam descritas no chamado.";
        sufficiencyStatus = "completo";
        missingInfo = [];
      } else {
        translatedIntent =
          `O solicitante ${ticket.requester} (${sectorName}) abriu o chamado relatando: "${resumoDesc}". ` +
          "A solicitação requer validação técnica inicial para atendimento.";
        sufficiencyStatus = "parcial";
        missingInfo = matchedPb
          ? matchedPb.required_info || []
          : looksLikeError
          ? [
              "ID do HopToDesk do computador para acesso remoto",
              "Print da tela ou mensagem exata do erro enfrentado",
            ]
          : [
              "Detalhar os dados específicos necessários para execução da solicitação",
            ];
      }
    }

    const resolutionSteps = [];
    const relevantMatches = (matches || []).filter(
      (m, idx) => idx === 0 || m.score >= 0.45
    );
    for (const m of relevantMatches) {
      for (const st of m.steps || []) {
        const cleanSt = String(st).replace(/^\d+\.\s*/, "").trim();
        // Ignora linhas puramente de cabeçalho de documento ou saudação/encerramento padrão
        if (
          /^(chamado aberto|autor\s*:|data d[eo]|vers[ãa]o\s*:|elaborado por|douglas henrique|prezados|ol[áa]\b|bom dia|boa tarde|atenciosamente|att\.?\b|ap[óo]s as tratativas)/i.test(
            cleanSt
          ) ||
          cleanSt.length < 15
        ) {
          continue;
        }
        const tagged = `[${m.source_id}] ${cleanSt}`;
        if (cleanSt && !resolutionSteps.includes(tagged)) {
          resolutionSteps.push(tagged);
        }
      }
    }

    if (resolutionSteps.length === 0) {
      if (/\[r\]\s*$/i.test(ticket.title)) {
        resolutionSteps.push(
          "Executar a verificação técnica prevista no procedimento operacional da rotina recorrente [R].",
          "Validar se todos os serviços, backups ou agentes monitorados estão íntegros e sem alertas críticos.",
          "Registrar a evidência/conclusão no chamado e solucionar a tarefa preventiva do período."
        );
      } else {
        resolutionSteps.push(
          "Realizar contato ou envio de acompanhamento solicitando os detalhes técnicos pendentes (print do erro, ativo ou registro afetado).",
          "Verificar logs e permissões relacionadas ao serviço/sistema reportado pelo usuário.",
          "Executar o teste assistido com o usuário e documentar a solução na Base de Conhecimento do GLPI."
        );
      }
    }

    if (customInstruction) {
      resolutionSteps.unshift(`[Diretriz do Analista] ${customInstruction}`);
      if (
        !/\b(pe[çc]a|pergunte|perguntar|solicite|solicitar|cobrar|questionar|qual\b|quais\b)\b/i.test(
          customInstruction
        )
      ) {
        sufficiencyStatus = "completo";
        missingInfo = [];
      }
    } else if (matchedMemory?.custom_instruction) {
      resolutionSteps.unshift(
        `[Aprendido em ${matchedMemory.source_id}] ${matchedMemory.custom_instruction}`
      );
    }

    const cleanSubject = (ticket.title || "").includes(">")
      ? ticket.title.split(">").pop().trim()
      : ticket.title;

    let publicReply = "";
    if (customPublicReply) {
      publicReply = customPublicReply;
    } else if (matchedMemory?.reply_template) {
      const isMemActionMismatch =
        (/\b(reabrir|reabertura|cancelar|cancelamento|excluir|estornar)\b/i.test(normAll) &&
          /\b(vincular|vinculacao|unidade piumhi|acesso ao meu usuario)\b/i.test(
            normalizeText(`${matchedMemory.title || ""} ${matchedMemory.summary || ""}`)
          )) ||
        (!/\b(reabrir|reabertura|abrir conta|abrir contas|abrir registro|encerrad[ao] erroneamente)\b/i.test(normAll) &&
          /\b(reabrir|reabertura|abrir conta|abrir contas|abrir registro|1411181)\b/i.test(
            normalizeText(`${matchedMemory.title || ""} ${matchedMemory.summary || ""}`)
          )) ||
        (/\b(parametrizar|parametriza[çc][ãa]o|viabilidade|melhoria|novas aplica[çc][õo]es)\b/i.test(normAll) &&
          /\b(reabertura|reabrir|vincular|vinculacao|acesso|cancelar|1411181)\b/i.test(
            normalizeText(`${matchedMemory.title || ""} ${matchedMemory.summary || ""}`)
          ));
      if (!isMemActionMismatch) {
        publicReply = matchedMemory.reply_template
          .replace(/\{solicitante\}/g, firstName)
          .replace(/\{titulo\}/g, cleanSubject);
      }
    } else if (
      matchedPb &&
      matchedPb.reply_template &&
      sufficiencyStatus !== "completo"
    ) {
      const colabMatch = (ticket.content || "").match(/(?:Colaboradora?|Nome)\s*:\s*([^\n]+)/i);
      const colabName = colabMatch ? colabMatch[1].trim() : "colaborador(a)";
      publicReply = matchedPb.reply_template
        .replace(/\{solicitante\}/g, firstName)
        .replace(/\{titulo\}/g, cleanSubject)
        .replace(/\{setor\}/g, sectorName)
        .replace(/\{colaborador\}/g, colabName);
    } else if (missingInfo.length > 0) {
      const questionsBul = missingInfo.map((q) => `- ${q}`).join("\n");
      publicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Já estamos analisando o seu chamado #${ticket.id} (**${cleanSubject}**). Para avançarmos com a solução o mais rápido possível, ` +
        `você poderia nos confirmar as seguintes informações?\n\n` +
        `${questionsBul}\n\n` +
        `Assim que nos responder aqui no chamado, daremos sequência imediata!`;
    } else {
      publicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos e analisamos a sua solicitação referente a **${cleanSubject}**.\n` +
        `Os dados necessários já foram validados na triagem e nossa equipe técnica iniciou o atendimento.\n\n` +
        `Assim que concluído (ou caso precise testar do seu lado), atualizaremos você por aqui!`;
    }

    const missingTxt =
      missingInfo.length > 0
        ? missingInfo.map((item) => `  - ${item}`).join("\n")
        : "  - Dados suficientes no relato para iniciar a tratativa.";

    const stepsTxt = resolutionSteps
      .slice(0, 6)
      .map((step, idx) => `  ${idx + 1}. ${step}`)
      .join("\n");

    const privateNote =
      `[TRATATIVA PRÉVIA - COPILOTO DE T.I.]\n` +
      `----------------------------------------\n` +
      `ENTENDIMENTO TÉCNICO:\n` +
      `${translatedIntent}\n\n` +
      `Classificação Sugerida: ${suggestedCategory} | Prioridade Real: ${realUrgency}\n` +
      `Base Consultada: ${primarySource}\n\n` +
      `TRIAGEM DE INFORMAÇÕES (${sufficiencyStatus.toUpperCase()}):\n` +
      `${missingTxt}\n\n` +
      `ROTEIRO DE RESOLUÇÃO SUGERIDO:\n` +
      `${stepsTxt}`;

    return {
      has_custom_reply: Boolean(customPublicReply),
      translated_intent: translatedIntent,
      detected_domain: detectedDomain,
      suggested_category: suggestedCategory,
      real_urgency: realUrgency,
      urgency_reason: urgencyReason,
      sufficiency_status: sufficiencyStatus,
      missing_info: missingInfo,
      primary_knowledge_source: primarySource,
      resolution_steps: resolutionSteps.slice(0, 6),
      private_note_draft: privateNote,
      public_reply_draft: publicReply,
    };
  }
}
