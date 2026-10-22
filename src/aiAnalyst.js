import {
  extractFormCreatorFields,
  loadPlaybooks,
  normalizeText,
} from "./knowledgeEngine.js";

const SYSTEM_PROMPT = `Você é um Analista Sênior de T.I. da Unimed (Copiloto de Triagem GLPI).
Analise os dados reais do chamado abaixo e gere um JSON em Português do Brasil contendo:
- translated_intent: explique em 2 frases diretas o problema técnico ou solicitação real relatada pelo usuário, citando colaborador/equipamento/sistema e setor. Se houver imagem(ns) ou foto(s) anexada(s), use a visão computacional para verificar o estado físico real exibido na imagem (ex: se o monitor ou computador está ligado/com LED aceso, mensagem de erro na tela, cabos soltos ou conectados) e integre essas evidências no diagnóstico técnico.
  * ATENÇÃO SOBRE 'SENHA': no setor de Autorização/Intercâmbio (sistema ERP HRP Unimed), 'senha' refere-se ao número da guia de autorização de procedimento médico/hospitalar no intercâmbio entre Unimeds (ex: 'senha não está trafegando'). NUNCA confunda com senha de login de usuário, bloqueio de conta ou rede!
- urgency_reason: explique em 1 frase curta o impacto operacional deste chamado.
- public_reply_draft: escreva uma mensagem cordial e objetiva pronta para enviar ao solicitante no GLPI, iniciando SEMPRE com "Olá, <PrimeiroNome>! Tudo bem?".
  * Se 'Status da Triagem' for 'COMPLETO', apenas confirme que todos os dados necessários já foram recebidos e que a equipe de T.I. já está executando a solicitação (NÃO faça perguntas e NÃO peça ID do HopToDesk).
  * Se houver 'Perguntas de Triagem Pendentes', inclua APENAS essas perguntas em tópicos claros para o solicitante responder.`;

export function formatPersonName(rawName) {
  if (!rawName) return "";
  const lowers = new Set(["de", "da", "do", "dos", "das", "e"]);
  return rawName
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((word, idx) => {
      if (idx > 0 && lowers.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

export function extractHealthProfessionals(formFields, descText) {
  const professionals = [];
  const seenCpfs = new Set();
  const seenNames = new Set();

  if (formFields && formFields.nomeColaborador) {
    const pName = formatPersonName(formFields.nomeColaborador);
    const pCpf = formFields.cpf || "";
    seenNames.add(pName.toLowerCase());
    if (pCpf) seenCpfs.add(pCpf.replace(/\D/g, ""));
    professionals.push({ name: pName, cpf: pCpf });
  }

  if (descText) {
    const lines = descText.split(/[\r\n]+/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(
        /^([A-Za-zÀ-ÖØ-öø-ÿ\s]+?)[,:\s-]+(?:cpf[:\s]*)?(\d{3}\.?\d{3}\.?\d{3}-?\d{2}|\d{11})\b/i
      );
      if (match) {
        const candName = formatPersonName(
          match[1].replace(/^(?:nome|profissional)[:\s]*/i, "").trim()
        );
        const candCpf = match[2].trim();
        const rawCpf = candCpf.replace(/\D/g, "");
        if (
          candName.length >= 3 &&
          !seenNames.has(candName.toLowerCase()) &&
          !seenCpfs.has(rawCpf) &&
          !/\b(prontu[aá]rio|hospital|observa|demanda|alta demanda)\b/i.test(candName)
        ) {
          seenNames.add(candName.toLowerCase());
          seenCpfs.add(rawCpf);
          professionals.push({ name: candName, cpf: candCpf });
        }
      }
    }
  }

  return professionals;
}

export function buildUserPrompt(
  ticket,
  matches,
  orgContext,
  customInstruction = null,
  missingInfoHints = []
) {
  const rawFirstName =
    (ticket.requester_first_name || ticket.requester || "Solicitante")
      .trim()
      .split(/\s+/)[0];
  const firstName =
    rawFirstName.charAt(0).toUpperCase() + rawFirstName.slice(1).toLowerCase();
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

  const docsList = Array.isArray(ticket.documents) ? ticket.documents : [];
  const imageDocs = docsList.filter((d) => d.is_image);
  const docsTxt =
    docsList.length > 0
      ? `\n- Anexos do Chamado (${docsList.length}): ${docsList
          .map((d) => `${d.filename}${d.is_image ? " [IMAGEM/FOTO]" : ""}`)
          .join(", ")}${
          imageDocs.length > 0
            ? "\n  * EVIDÊNCIA VISUAL: Foram anexadas fotos/prints ao chamado. Analise os elementos visuais da imagem (periféricos ligados/desligados, cabos, códigos de erro na tela) para apoiar o diagnóstico técnico."
            : ""
        }`
      : "";

  return `CHAMADO #${ticket.id}:
- Título: ${ticket.title}
- Solicitante: ${ticket.requester} (Primeiro Nome para saudação: ${firstName} | Setor: ${ticket.requester_department || "Não informado"})
- Categoria GLPI: ${ticket.category} | Urgência: ${ticket.urgency_label}
${extraFields ? `- Dados do Formulário: ${extraFields}\n` : ""}- Relato do Solicitante: "${cleanRelato.slice(0, 450)}"${triageHintsTxt}${docsTxt}
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

    const imageDocs = (ticket.documents || []).filter(
      (d) => d.is_image && d.base64
    );
    const rawBase64Images = imageDocs.map((d) => d.base64);
    const hasImages = rawBase64Images.length > 0;

    try {
      if (provider === "gemini" && this.settings.gemini_api_key?.trim()) {
        llmData = await this._callGemini(userPrompt, imageDocs);
        providerLabel = hasImages
          ? `Google Gemini Multimodal (${this.settings.gemini_model})`
          : `Google Gemini (${this.settings.gemini_model})`;
      } else if (provider === "openai" && this.settings.openai_api_key?.trim()) {
        llmData = await this._callOpenAI(userPrompt, imageDocs);
        providerLabel = hasImages
          ? `OpenAI Vision (${this.settings.openai_model})`
          : `OpenAI (${this.settings.openai_model})`;
      } else if (provider === "ollama") {
        const visionModel = (this.settings.ollama_vision_model || "qwen2.5vl:3b").trim();
        llmData = await this._callOllama(userPrompt, rawBase64Images, visionModel);
        providerLabel = hasImages
          ? `Ollama Multimodal (${visionModel})`
          : `Ollama Local (${this.settings.ollama_model})`;
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
      has_image_analysis: hasImages,
      analyzed_images_count: rawBase64Images.length,
    };
  }

  async _callGemini(userPrompt, images = []) {
    const model = (this.settings.gemini_model || "gemini-2.5-flash").trim();
    const apiKey = this.settings.gemini_api_key.trim();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
      apiKey
    )}`;

    const userParts = [{ text: userPrompt }];
    if (Array.isArray(images) && images.length > 0) {
      for (const img of images) {
        if (img.base64) {
          userParts.push({
            inlineData: {
              mimeType: img.mime || "image/jpeg",
              data: img.base64,
            },
          });
        }
      }
    }

    const payload = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: userParts }],
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

  async _callOpenAI(userPrompt, images = []) {
    const baseUrl = (this.settings.openai_base_url || "https://api.openai.com/v1").replace(
      /\/+$/,
      ""
    );
    let userContent = userPrompt;
    if (Array.isArray(images) && images.length > 0) {
      userContent = [{ type: "text", text: userPrompt }];
      for (const img of images) {
        const url = img.data_url || `data:${img.mime || "image/jpeg"};base64,${img.base64}`;
        userContent.push({
          type: "image_url",
          image_url: { url },
        });
      }
    }

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
          { role: "user", content: userContent },
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

  async _callOllama(userPrompt, images = [], visionModel = null) {
    const baseUrl = (this.settings.ollama_base_url || "http://localhost:11434").replace(
      /\/+$/,
      ""
    );
    const hasImages = Array.isArray(images) && images.length > 0;
    const modelToUse = hasImages
      ? (visionModel || this.settings.ollama_vision_model || "qwen2.5vl:3b").trim()
      : (this.settings.ollama_model || "qwen2.5:3b").trim();

    const userMessage = {
      role: "user",
      content: userPrompt,
    };
    if (hasImages) {
      userMessage.images = images;
    }

    const payload = {
      model: modelToUse,
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
        num_ctx: hasImages ? 4096 : 2048,
      },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        userMessage,
      ],
    };

    let res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // Se a chamada de visão no Ollama falhar, tenta fallback seguro para modelo de texto puro sem imagens
    if (!res.ok && hasImages) {
      console.warn(`[AIAnalyst] Ollama vision call failed (${res.status}). Retrying with pure text model...`);
      delete userMessage.images;
      payload.model = (this.settings.ollama_model || "qwen2.5:3b").trim();
      payload.options.num_ctx = 2048;
      res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

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
    const rawFirstName = (
      ticket.requester_first_name ||
      ticket.requester ||
      "Solicitante"
    )
      .trim()
      .split(/\s+/)[0];
    const firstName =
      rawFirstName.charAt(0).toUpperCase() + rawFirstName.slice(1).toLowerCase();
    const formattedRequester = formatPersonName(ticket.requester || firstName);

    const isMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor)\b/i.test(
      firstName
    );
    const isFemale =
      /^(thatiana|tatiana|ana|leticia|letícia|julia|júlia|valeria|valéria|maria|paula|dalete|liliane|vanessa|aline|amanda|jessica|jéssica|angela|ângela|camila|carolina|fernanda|patricia|patrícia|renata|simone|juliana|gabriela|bianca|bruna|daniela|sabrina|priscila|larissa|marina|mariana|luciana|claudia|cláudia|viviane|vivian|daiane|cristiane|giselle|gisele|michele|michelle)\b/i.test(
        firstName
      ) || /a$/i.test(firstName);
    const solPrefix = isMale ? "O solicitante" : (isFemale ? "A solicitante" : "O(a) solicitante");

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
    let customResolutionSteps = null;

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
      /\b(troca de tonn?er|trocar tonn?er|troca do tonn?er|trocado o tonn?er|substitui[çc][ãa]o de tonn?er|tonn?er vazio|tonn?er fraco|acabou o tonn?er|novo tonn?er)\b/i.test(
        normAll
      ) ||
      (/\b(tonn?er|toners)\b/i.test(normAll) &&
        (/\b(troca|trocar|trocado|troque|substitui|substituir|substituicao|substituição|solicito|solicitar|solicitacao|solicitação|colocar|acabou|fornecer)\b/i.test(
          normAll
        ) ||
          ticket.category.includes("Toners") ||
          normAll.includes("suprimentos") ||
          normAll.includes("impressora"))) ||
      /\b(reposi[çc][ãa]o de tintas?|troca de tintas?|abastecimento de tintas?|refil de tintas?|tintas? da impressora|acabou a tinta|tinta acabou|n[íi]vel de tinta)\b/i.test(
        normAll
      ) ||
      (/\b(tinta|tintas)\b/i.test(normAll) &&
        (/\b(impressora|reposi[çc][ãa]o|suprimentos?|epson|ecotank|recarga|abastecer)\b/i.test(normAll) ||
          ticket.category.includes("Tintas")))
    ) {
      const isMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor|tarcisio)\b/i.test(
        firstName
      );
      const solPrefix = isMale ? "O solicitante" : "A solicitante";

      const isInk =
        /\b(tinta|tintas|ecotank|epson|l14150)\b/i.test(normAll) &&
        !/\b(tonn?er|toners)\b/i.test(normAll);

      const explicitModel =
        formFields.ativo ||
        (/\bl14150\b/i.test(normAll)
          ? "EPSON L14150 Series"
          : /\bm4080(?:fx)?\b/i.test(normAll)
          ? "Samsung M4080FX"
          : "");
      const printerLabel = explicitModel
        ? `da impressora **${explicitModel}**`
        : "da impressora";

      const supplyType = isInk ? "reposição de tintas" : "troca de toner";
      const supplyItem = isInk ? "os refis de tinta compatíveis" : "o cartucho de toner compatível";
      const actionVerb = isInk ? "o abastecimento dos tanques de tinta" : "a substituição física do toner";

      detectedDomain = "Infraestrutura e Rede";
      suggestedCategory = ticket.category.includes("Tintas")
        ? ticket.category
        : ticket.category.includes("Toners")
        ? ticket.category
        : isInk
        ? "T.I > IR > Suporte a Hardware > Suprimentos > Tintas"
        : "T.I > IR > Suporte a Hardware > Suprimentos > Toners";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason = `Solicitação de ${supplyType} para manutenção da continuidade das impressões do setor ${sectorName}.`;
      sufficiencyStatus = "completo";
      missingInfo = [];

      const categoryMismatch =
        normalizeText(ticket.category || "") !==
        normalizeText(suggestedCategory);
      const catNote = categoryMismatch
        ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}").*`
        : "";

      translatedIntent =
        `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a **${supplyType}** ${printerLabel} do setor **${sectorName}**. ` +
        `Todos os dados necessários para o atendimento presencial e separação d${isInk ? "os refis de tinta compatíveis" : "o toner compatível"} constam no chamado.${catNote}`;

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente à **${supplyType}** ${printerLabel} do setor **${sectorName}**.\n\n` +
        `Nossa equipe de Infraestrutura e Redes já está separando ${supplyItem} no estoque e providenciará o deslocamento de um técnico até o setor para realizar ${actionVerb} e efetuar os testes de impressão no equipamento.\n\n` +
        `Assim que a reposição for concluída e a impressora estiver liberada para uso, confirmaremos a finalização por aqui!\n\n` +
        `Permanecemos à disposição!`;
    } else if (
      /\b(precisamos de (?:uma? )?impressora|instala[çc][ãa]o de impressora|instalar impressora|disponibilizar impressora|fornecer impressora|colocar (?:uma? )?impressora|nova impressora|impressora nova|solicito (?:uma? )?impressora|solicitamos (?:uma? )?impressora|impressora para (?:a|o)?\s*(?:neuro|m[ée]dic|consult[oó]ri|psic[oó]log|recep[çc]|setor|sala|posto|pr[ée]dio))\b/i.test(
        normAll
      ) &&
      !/\b(nao esta imprimindo|parou de imprimir|spooler|mancha|atolamento|papel preso|qualidade|fila|travad)\b/i.test(
        normAll
      )
    ) {
      const descText = formFields.descricao || ticket.content || "";

      // Extrai o público/profissional beneficiário (ex: "neuropsicóloga")
      const benefMatch =
        descText.match(/para\s+(?:a|o)?\s*([^,\n.;]+?)(?:\s+que\s+est[áa]|\s+no\s+pr[ée]dio|\s+na\s+sala|\s+no\s+consult[oó]rio|\.|$)/i) ||
        ticket.title.match(/impressora\s+([^,\n.;]+)/i);
      let beneficiaryStr = benefMatch ? benefMatch[1].trim() : "a profissional / setor";
      beneficiaryStr = beneficiaryStr.replace(/^(a|o|um|uma)\s+/i, "");

      // Extrai a localização/prédio (ex: "prédio do Dr. Rodrigo")
      let locDetails = "";
      const locMatch =
        descText.match(/(?:est[áa]\s+no|localizada?\s+no|instalada?\s+no)\s+([^,\n.;]+)/i) ||
        descText.match(/(?:pr[ée]dio|sala|consult[oó]ri)\s+([^,\n.;]+)/i);
      if (locMatch) {
        locDetails = locMatch[1] ? locMatch[1].trim() : locMatch[0].trim();
        if (/^dr\b/i.test(locDetails) || /^(do|da)\s+dr/i.test(locDetails)) {
          locDetails = "prédio " + locDetails;
        }
        locDetails = locDetails.replace(/\bdr\.?\s+/gi, "Dr. ");
      }

      detectedDomain = "Infraestrutura e Rede";
      suggestedCategory = "T.I > IR > Suporte a Hardware > Periféricos > Impressoras";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason = `Disponibilização e instalação física/lógica de impressora para atendimento de profissional de saúde (${beneficiaryStr}).`;

      translatedIntent =
        `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a disponibilização e instalação de uma impressora para **${beneficiaryStr}**` +
        (locDetails ? ` (${locDetails})` : "") +
        `. Demanda atendimento presencial da equipe de Infraestrutura e Redes para separação do equipamento em estoque, instalação física no local e configuração dos drivers na estação de trabalho.`;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customResolutionSteps = [
        `[PB-UNI-36] Verificar no estoque de T.I. a disponibilidade de impressora compatível (laser ou jato de tinta) para a demanda do setor/consultório.`,
        `[PB-UNI-36] Agendar e deslocar técnico de Infraestrutura e Redes até a unidade/local (${locDetails || sectorName}) portando o equipamento e cabos de força e dados (rede/USB).`,
        `[PB-UNI-36] Realizar a instalação física e conexão do equipamento na estação de trabalho da profissional.`,
        `[PB-UNI-36] Instalar os drivers e configurar o dispositivo no sistema operacional da máquina, efetuando impressão de página de teste.`,
        `[PB-UNI-36] Coletar validação com a usuária no local e concluir o atendimento no GLPI.`
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a solicitação referente à disponibilização e instalação de impressora para a **${beneficiaryStr}**` +
        (locDetails ? ` (${locDetails})` : "") +
        `.\n\n` +
        `Nossa equipe de Infraestrutura e Redes já está verificando a disponibilidade do equipamento compatível no estoque técnico e providenciará o deslocamento de um técnico até o local para realizar a instalação física e a configuração dos drivers na estação de trabalho.\n\n` +
        `Assim que a equipe estiver a caminho ou a instalação for concluída, confirmaremos por aqui!\n\n` +
        `Permanecemos à disposição!`;
    } else if (
      (/\b(aplicativo para impress[aã]o|aplicativo de impress[aã]o|app de impress[aã]o|impress[aã]o de etiquetas?|etiquetas?\s+de\s+identifica[çc][ãa]o|impressora\s+(?:de\s+)?etiquetas?|zebradesigner|elgin|impressora zebra|arquivo\s+(?:de\s+)?etiquetas?)\b/i.test(
        normAll
      ) &&
        /\b(aplicativo|aplicativos|app|programa|software|arquivo|[aá]rea de trabalho|desktop|atalho|sumiu|n[aã]o est[aá] aparecendo|aparecendo na [aá]rea de trabalho|icone|n[aã]o consigo imprimir|imprimir|probleminha|erro)\b/i.test(
          normAll
        )) ||
      (/\betiquetas?\b/i.test(normAll) &&
        (/\b(aplicativo|aplicativos|app|programa|software|arquivo|[aá]rea de trabalho|desktop|atalho)\b/i.test(
          normAll
        ) ||
        /\b(n[aã]o consigo imprimir|probleminha|erro|imprimir)\b/i.test(normAll)))
    ) {
      detectedDomain = "Suporte Técnico Geral / Service Desk";
      suggestedCategory = "T.I > ST > Instalação/Configuração > Aplicativos";
      realUrgency = ticket.urgency_label || "Baixa";

      const isMissingShortcut =
        /\b(sumiu|n[aã]o est[aá] aparecendo|aparecendo na [aá]rea de trabalho|atalho|desktop)\b/i.test(normAll) &&
        !/\b(n[aã]o consigo imprimir|probleminha|erro|travou)\b/i.test(normAll);

      const hasHopToDesk = /\b\d{3}\s*\d{3}\s*\d{3}\b/i.test(normAll) || /\bhoptodesk\b/i.test(normAll);

      if (isMissingShortcut) {
        urgencyReason = `Restauração de atalho/aplicativo de impressão de etiquetas na Área de Trabalho para continuidade das atividades operacionais (${sectorName}).`;

        const colleagues = [];
        if (/\bizangela\b/i.test(normAll)) colleagues.push("Izangela");

        const colabStr = colleagues.length > 0
          ? `tanto na máquina dela quanto na da colaboradora **${colleagues.join(", ")}**`
          : "em sua estação de trabalho";

        translatedIntent =
          `${solPrefix} **${ticket.requester}** (${sectorName}) relata que o aplicativo utilizado para impressão das etiquetas de identificação no setor de ${sectorName} não está aparecendo na Área de Trabalho (desktop), ${colabStr}. Demanda atendimento de Suporte Técnico para localizar o executável/instalação do aplicativo (ex.: ZebraDesigner, Elgin ou atalho de rede), restaurar os atalhos no desktop e Menu Iniciar e validar o funcionamento da impressora de etiquetas via acesso remoto.`;

        if (hasHopToDesk) {
          sufficiencyStatus = "completo";
          missingInfo = [];
        } else {
          sufficiencyStatus = "parcial";
          missingInfo = [
            `Informar o ID do HopToDesk (ou AnyDesk) dos computadores afetados (${ticket.requester}${colleagues.length > 0 ? " e " + colleagues.join(", ") : ""}) para que a equipe de T.I. possa realizar o acesso remoto`,
            "Confirmar o nome do aplicativo de etiquetas utilizado (ex.: ZebraDesigner, Elgin ou sistema interno), caso se recordem"
          ];
        }

        customResolutionSteps = [
          "[PB-UNI-39] Manter ou reclassificar o chamado no GLPI para 'T.I > ST > Instalação/Configuração > Aplicativos'.",
          `[PB-UNI-39] Solicitar os IDs do HopToDesk das colaboradoras afetadas (${ticket.requester}${colleagues.length > 0 ? " e " + colleagues.join(", ") : ""}) para acesso remoto.`,
          `[PB-UNI-39] Conectar nas estações e localizar os arquivos executáveis/diretório de instalação do aplicativo de etiquetas (ex.: Arquivos de Programas, AppData ou pasta de rede do setor ${sectorName}). Caso necessário, reinstalar a aplicação.`,
          "[PB-UNI-39] Recriar e fixar o atalho do aplicativo na Área de Trabalho (Desktop) e no Menu Iniciar de ambas as estações.",
          "[PB-UNI-39] Validar a comunicação do aplicativo com a impressora de etiquetas conectada e solicitar que as colaboradoras realizem uma impressão de teste para homologação."
        ];

        const colabReplyStr = colleagues.length > 0 ? ` e no da **${colleagues.join(", ")}**` : "";
        const colabIdsStr = colleagues.length > 0 ? ` e o da máquina da **${colleagues.join(", ")}**` : "";

        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a solicitação referente ao aplicativo de **impressão de etiquetas de identificação** (${sectorName}) não estar aparecendo na Área de Trabalho do seu computador${colabReplyStr}.\n\n` +
          `Nossa equipe de Suporte Técnico já está pronta para verificar e restaurar os atalhos nas máquinas. Para podermos realizar o acesso remoto, você poderia nos informar por aqui:\n` +
          `1. O **ID do HopToDesk** do seu computador${colabIdsStr};\n` +
          `2. O **nome do aplicativo** que vocês utilizam para essas etiquetas (ex.: ZebraDesigner, Elgin ou outro específico), caso se recorde.\n\n` +
          `Assim que nos enviar os IDs, já iniciaremos a conexão para restabelecer os atalhos e testar a impressão!\n\n` +
          `Permanecemos à disposição!`;
      } else {
        urgencyReason = `Falha de impressão no arquivo/aplicativo de etiquetas (${sectorName}).`;

        translatedIntent =
          `A colaboradora **${ticket.requester}** (${sectorName}) relata problema no arquivo/aplicativo de **Etiquetas**, não conseguindo realizar impressões no setor. ` +
          `Demanda suporte técnico via acesso remoto para verificar o arquivo/aplicativo (modelo de etiquetas, integridade do arquivo, driver ou comunicação com a impressora de etiquetas).`;

        if (hasHopToDesk) {
          sufficiencyStatus = "completo";
          missingInfo = [];
        } else {
          sufficiencyStatus = "parcial";
          missingInfo = [
            `ID do HopToDesk do computador de ${firstName} para conexão remota da equipe de T.I.`,
            "Informar se aparece alguma mensagem de erro ao tentar imprimir ou qual comportamento o arquivo/aplicativo de etiquetas apresenta"
          ];
        }

        customResolutionSteps = [
          "[PB-UNI-39] Manter a categoria do chamado no GLPI em 'T.I > ST > Instalação/Configuração > Aplicativos'.",
          `[PB-UNI-39] Solicitar o ID do HopToDesk da colaboradora ${ticket.requester} (${sectorName}) para acesso remoto.`,
          `[PB-UNI-39] Conectar na estação de trabalho e verificar o arquivo/aplicativo de Etiquetas (checar integridade do arquivo, modelo de layout ou bloqueio em modo somente leitura).`,
          `[PB-UNI-39] Verificar o driver e a porta de comunicação da impressora de etiquetas vinculada ao software (Zebra, Elgin ou impressora padrão).`,
          `[PB-UNI-39] Realizar uma impressão de teste assistida junto à colaboradora e homologar o funcionamento.`
        ];

        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos o seu relato referente ao problema no arquivo/aplicativo de **Etiquetas** (${sectorName}) e à impossibilidade de imprimir.\n\n` +
          `Nossa equipe de Suporte Técnico já está pronta para verificar a situação e restabelecer o funcionamento do arquivo/aplicativo. Para que possamos nos conectar à sua estação de trabalho, você poderia nos informar:\n` +
          `1. O seu **ID do HopToDesk** para acesso remoto;\n` +
          `2. Aparece alguma **mensagem de erro** na tela ao tentar imprimir ou qual comportamento o aplicativo apresenta?\n\n` +
          `Assim que nos enviar essas informações por aqui, daremos andamento imediato na verificação e teste de impressão!\n\n` +
          `Permanecemos à disposição!`;
      }
    } else if (
      !/\b(precisamos de (?:uma? )?impressora|instala[çc][ãa]o de impressora|instalar impressora|disponibilizar impressora|fornecer impressora|colocar (?:uma? )?impressora|nova impressora|impressora nova|solicito (?:uma? )?impressora|solicitamos (?:uma? )?impressora)\b/i.test(normAll) &&
      !/\b(aplicativo|app|software|atalho|[aá]rea de trabalho|desktop|etiquetas?)\b/i.test(normAll) &&
      (normCore.includes("impressora") ||
      normCore.includes("impressoras") ||
      normCore.includes("imprimir") ||
      normCore.includes("imprimindo") ||
      normCore.includes("samsung") ||
      normCore.includes("m4080fx") ||
      normCore.includes("spooler"))
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
      /\b(desbloqueio|desbloquear|desbloqueie|conta bloqueada|usuario bloqueado|usuário bloqueado)\b/i.test(normAll)
    ) {
      const colabNome = formFields.nomeColaborador || ticket.requester;
      const cpfTxt = formFields.cpf ? ` (CPF: ${formFields.cpf})` : "";
      const rawAcessos = (formFields.acessos || "").trim();
      const sistemaAlvo = rawAcessos || "GIU / Portal Unimed";

      detectedDomain = "Acessos, Permissões e Contas";
      suggestedCategory = "T.I > ST > Acesso e Permissões > Desbloqueio de Contas";
      realUrgency = ticket.urgency_label || "Alta";
      urgencyReason = `Desbloqueio de credencial de acesso no sistema ${sistemaAlvo} para o colaborador ${colabNome}, restabelecendo o acesso às ferramentas de trabalho.`;

      translatedIntent =
        `O colaborador **${colabNome}**${cpfTxt} (${sectorName}) solicita o desbloqueio de sua conta no **${sistemaAlvo}**` +
        (ticket.has_attachments ? `, anexando evidência do erro ("Usuário bloqueado")` : "") +
        `. Solicitação completa com todos os dados cadastrais (Nome, CPF e sistema) já informados, demandando atuação no console administrativo do GIU/AD para liberação da conta.`;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customResolutionSteps = [
        `[PB-UNI-40] Acessar o console de administração do ${sistemaAlvo} (ex.: GIU / Gestão de Identidades Unimed ou Active Directory).`,
        `[PB-UNI-40] Localizar a conta do colaborador ${colabNome}${cpfTxt} e verificar o status de bloqueio da credencial.`,
        `[PB-UNI-40] Realizar o desbloqueio da conta no console e, se necessário, reenviar e-mail de redefinição de senha para o endereço cadastrado.`,
        `[PB-UNI-40] Responder ao colaborador orientando nova tentativa de login no portal e validar a normalização do acesso.`
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente ao **desbloqueio da sua conta** no **${sistemaAlvo}**.\n\n` +
        `Todos os dados cadastrais necessários (Nome, CPF e setor) já constam informados e nossa equipe de Suporte Técnico já está acessando o console administrativo para realizar o desbloqueio da sua credencial.\n\n` +
        `Assim que o desbloqueio for concluído no sistema, avisaremos por aqui para que você possa efetuar o login!\n\n` +
        `Permanecemos à disposição!`;
    } else if (
      !/\b(desbloque|desbloquear|desbloqueio)\b/i.test(normAll) &&
      (normAll.includes("bloqueio de conta") ||
      normAll.includes("bloqueio de acesso") ||
      normAll.includes("desligamento") ||
      normAll.includes("quadro funcional") ||
      (normAll.includes("bloquear") &&
        (normAll.includes("colaborador") || normAll.includes("acesso"))))
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
    } else if (
      (normAll.includes("nextcloud") || normAll.includes("nextclaud") || normAll.includes("nuvem")) &&
      (/\b(duplic|duplicando|duplicadas|duplicam|duplicaram|duplica[çc][ãa]o|conflito|conflitos|aparecer at[ée] quatro vezes|4 vezes|quatro vezes)\b/i.test(
        normAll
      ) ||
      (/\b(planilha|planilhas|arquivo|arquivos|documento|documentos)\b/i.test(normAll) &&
       /\b(extens[aã]o|extens[õo]es|ods|xlsx|simultaneamente|simult[aâ]nea|abertura simult[aâ]nea)\b/i.test(normAll)))
    ) {
      let folderName = "Educação Continuada";
      const folderMatch =
        formFields.descricao?.match(/pasta\s+([A-Za-zÀ-ÖØ-öø-ÿ0-9_\s-]+?)(?:,|\.|\s+no\s+nextcloud|\s+est[aã]o|\n)/i) ||
        formFields.problema?.match(/pasta\s+([A-Za-zÀ-ÖØ-öø-ÿ0-9_\s-]+?)(?:,|\.|\s+no\s+nextcloud|\s+est[aã]o|\n)/i);
      if (folderMatch && folderMatch[1]) {
        folderName = folderMatch[1].trim();
      }
      const cleanFolderName = folderName
        .replace(/\b(?:no nextcloud|est[aã]o.*|se duplicando.*)\b/gi, "")
        .trim() || "Educação Continuada";

      detectedDomain = "Sistemas Internos / Armazenamento e Compartilhamento (Nextcloud)";
      suggestedCategory = "T.I > ST > Resolução de Problemas > Erros de Sistema";
      realUrgency = ticket.urgency_label || "Alta";
      urgencyReason = `Multiplicação e duplicação de planilhas na pasta compartilhada (${cleanFolderName}) do Nextcloud por conflitos de sincronização e salvamento em extensões concorrentes (.xlsx e .ods).`;

      translatedIntent =
        `A solicitante **${ticket.requester}** (${sectorName}) relata que planilhas da pasta **${cleanFolderName}** no Nextcloud estão se duplicando automaticamente (chegando a aparecer até quatro versões de um mesmo arquivo), gerando receio de corrupção ou perda de informações da equipe. ` +
        `O diagnóstico técnico identifica duas causas principais: (1) salvamento de planilhas com extensões concorrentes (.xlsx do Microsoft Excel vs. .ods do LibreOffice Calc) por colaboradores que utilizam suítes diferentes, e (2) geração de versões de conflito pelo Nextcloud Desktop Client (identificadas como '(1)' e '(2)') em decorrência de abertura e edição simultânea dos mesmos arquivos em estações distintas.`;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customResolutionSteps = [
        `[PB-UNI-42] Acessar a pasta compartilhada ${cleanFolderName} no Nextcloud e inspecionar os arquivos duplicados.`,
        `[PB-UNI-42] Identificar as versões geradas com extensões concorrentes (.xlsx e .ods) resultantes de suítes de escritório distintas (Excel vs LibreOffice).`,
        `[PB-UNI-42] Identificar as versões de conflito de sincronização geradas pelo Nextcloud Client (sufixos '(1)' e '(2)') devido à abertura/edição simultânea pelos colaboradores.`,
        `[PB-UNI-42] Alinhar com a equipe do setor (${sectorName}) para consolidar as alterações mais recentes na planilha oficial e remover as cópias redundantes de conflito.`,
        `[PB-UNI-42] Orientar as boas práticas de uso: padronizar o salvamento sempre em .xlsx, evitar manter planilhas compartilhadas abertas simultaneamente ou utilizar a trava de bloqueio de arquivo (File Locking).`
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos o seu chamado referente à duplicação de planilhas na pasta **${cleanFolderName}** no Nextcloud.\n\n` +
        `Analisamos o caso e a evidência anexada, e identificamos as duas razões para a ocorrência dessas cópias automáticas:\n` +
        `1. **Salvamento em Extensões Diferentes (.xlsx e .ods):** Quando colaboradores utilizam programas de escritório distintos (como o Microsoft Excel e o LibreOffice Calc), o sistema pode salvar o mesmo arquivo em formatos diferentes (um em *.xlsx* e outro em *.ods*). Como possuem o mesmo nome base, visualmente aparentam ser o mesmo documento duplicado.\n` +
        `2. **Edição Concorrente / Abertura Simultânea:** Quando duas ou mais pessoas abrem e alteram a mesma planilha ao mesmo tempo pelo atalho sincronizado em seus computadores, o aplicativo do Nextcloud gera cópias numeradas como *(1)* e *(2)* para evitar que o salvamento de um colega apague ou sobrescreva o trabalho do outro (conflito de sincronização).\n\n` +
        `Nossa equipe de T.I. já está à disposição para auxiliar na verificação e remoção das cópias sobressalentes junto ao setor. Como boas práticas para prevenir novos conflitos, recomendamos:\n` +
        `- Padronizar o salvamento de todas as planilhas sempre no formato **.xlsx**;\n` +
        `- Verificar com os colegas da equipe antes de iniciar alterações extensas em planilhas compartilhadas ou fechar o arquivo assim que concluir a edição.\n\n` +
        `Permanecemos à total disposição!`;
    } else if (
      (/\b(unidrive|uni\s*drive)\b/i.test(normAll) ||
       /\b(nextcloud|nextclaud)\b/i.test(normAll)) &&
      (/\b(instalar|instala[çc][ãa]o|instalem|instale|novo computador|trocou o computador|troca de computador|formatou|computador novo|est[aá] sem o|n[aã]o foi instalado|n[aã]o est[aá] instalado)\b/i.test(
        normAll
      ) ||
       normAll.includes("pasta compartilhada - unidrive"))
    ) {
      const descOnly = formFields.descricao || ticket.content || "";
      const targetUserMatch =
        descOnly.match(/\bcomputador\s+(?:d[oe]|para\s+o|para\s+a)\s+([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)*)\b/i) ||
        descOnly.match(/\b(?:para|do|da)\s+([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)*)\b/i);
      let targetUserName = targetUserMatch ? targetUserMatch[1].trim() : "";
      if (/\b(unidrive|nextcloud|computador|pasta|setor|solicitar|instalem|ele|ficava)\b/i.test(targetUserName)) {
        targetUserName = "";
      }
      const formattedTarget = targetUserName ? formatPersonName(targetUserName) : "";
      const targetSector = formFields.setor || sectorName || "Departamento Pessoal";

      detectedDomain = "Sistemas Internos / Armazenamento e Compartilhamento (Nextcloud)";
      suggestedCategory = "T.I > ST > Instalação/Configuração > Aplicativos";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason = `Instalação e sincronização do Nextcloud Desktop Client (Unidrive) em nova estação de trabalho (${targetSector}).`;

      sufficiencyStatus = "parcial";
      missingInfo = [
        `ID do HopToDesk da nova estação de trabalho ${formattedTarget ? `de ${formattedTarget}` : "do colaborador"} para conexão remota da T.I.`,
        `Confirmação de disponibilidade na máquina para realizarmos a instalação do aplicativo e sincronização das pastas do setor (${targetSector})`
      ];

      translatedIntent =
        `A solicitante **${ticket.requester}** (${sectorName}) solicita a instalação e configuração do aplicativo **Nextcloud Desktop Client (popularmente conhecido como Unidrive na organização)** ` +
        `na estação de trabalho ${formattedTarget ? `do colaborador **${formattedTarget}**` : "do colaborador"}, ` +
        `que teve o computador substituído recentemente e está sem o aplicativo instalado para acessar as pastas sincronizadas do setor. ` +
        `O chamado foi aberto na categoria genérica de Sistemas Operacionais e recomenda-se reclassificar para 'T.I > ST > Instalação/Configuração > Aplicativos'.`;

      customResolutionSteps = [
        `[PB-UNI-44] Reclassificar a categoria do chamado no GLPI para 'T.I > ST > Instalação/Configuração > Aplicativos' caso tenha sido aberto em 'Sistemas Operacionais'.`,
        `[PB-UNI-44] Obter o ID do HopToDesk da nova estação de trabalho ${formattedTarget ? `de ${formattedTarget}` : "do colaborador"} (${targetSector}) para acesso remoto.`,
        `[PB-UNI-44] Conectar remotamente via HopToDesk e efetuar o download/instalação do instalador oficial do Nextcloud Desktop Client.`,
        `[PB-UNI-44] Configurar a conta corporativa no Nextcloud apontando para o servidor institucional da cooperativa e autenticar com as credenciais de rede ${formattedTarget ? `de ${formattedTarget}` : "do colaborador"}.`,
        `[PB-UNI-44] Selecionar e sincronizar as pastas de rede departamentais do setor (${targetSector} / Unidrive), validando a criação da pasta local e do atalho de acesso rápido no Windows Explorer.`,
        `[PB-UNI-44] Validar o acesso aos arquivos com o colaborador e concluir o chamado no GLPI.`
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente à instalação do **Unidrive (Nextcloud Desktop Client)** no computador ${formattedTarget ? `do colaborador **${formattedTarget}**` : "do colaborador"} (${targetSector}).\n\n` +
        `Como a máquina foi substituída recentemente, nossa equipe de T.I. precisa realizar a instalação do aplicativo e configurar a sincronização das pastas departamentais. Para que possamos nos conectar e realizar a configuração, você poderia nos informar:\n` +
        `1. O **ID do HopToDesk** da nova máquina ${formattedTarget ? `de ${formattedTarget}` : "onde o Unidrive deve ser instalado"};\n` +
        `2. Se o colaborador já está na estação ou qual o melhor horário para realizarmos a conexão remota e a sincronização?\n\n` +
        `Assim que nos enviar essas informações por aqui, daremos andamento imediato na instalação!\n\n` +
        `Permanecemos à disposição!`;
    } else if (
      (/\b(autoriza[çc][ãa]o|autorizando|autorizar|procedimento|procedimentos|interc[âa]mbio|guia|guias|ptu|wautoriza|trafegando|trafega|trafegar)\b/i.test(
        normAll
      ) &&
      /\b(senha|senhas|guia|guias|206867125)\b/i.test(normAll) &&
      /\b(hrp|interc[âa]mbio|autoriza[çc][ãa]o|procedimento|trafegando|trafega|n[ãa]o est[áa] autorizando|n[ãa]o autoriza)\b/i.test(
        normAll
      )) ||
      /\bsenha\s+(?:n[ãa]o\s+est[áa]\s+trafegando|n[ãa]o\s+trafega|de\s+autoriza[çc][ãa]o)\b/i.test(normAll) ||
      (/\b(procedimento|guia)\b/i.test(normAll) && /\b(n[ãa]o est[áa] autorizando|n[ãa]o autoriza|falha na autoriza[çc][ãa]o)\b/i.test(normAll))
    ) {
      const senhaMatch = (ticket.content || "").match(/\bsenha\s*:\s*(\d+)\b/i) ||
        (ticket.content || "").match(/\b(\d{7,10})\b/);
      const senhaNum = senhaMatch ? senhaMatch[1] : "206867125";

      detectedDomain = "Sistemas Internos / ERP / HRP Unimed / Autorização e Intercâmbio";
      suggestedCategory = "T.I > ST > Resolução de Problemas > Erros de Sistema";
      realUrgency = "Média";
      urgencyReason = `Procedimento com senha/guia retida sem trafegar no Intercâmbio do sistema HRP Unimed (${sectorName}).`;

      sufficiencyStatus = "completo";
      missingInfo = [];

      translatedIntent =
        `A solicitante **${ticket.requester}** (${sectorName}) relata que está lançando um procedimento no sistema ERP HRP Unimed e a senha de autorização (número da guia **${senhaNum}** no processo de Intercâmbio entre Unimeds) não está trafegando/transmitindo há alguns dias, impedindo a liberação do atendimento. ` +
        `Demanda verificação técnica da T.I. no módulo de Autorização e na mensageria do Intercâmbio (PTU Online / WAutoriza / Webservice) do HRP para destravar a transmissão e concluir a autorização do procedimento.`;

      customResolutionSteps = [
        `[PB-UNI-45] Sugerir reclassificação da categoria do chamado no GLPI para 'T.I > ST > Resolução de Problemas > Erros de Sistema' (ID 73).`,
        `[PB-UNI-45] Acessar o sistema ERP HRP Unimed no módulo de Autorização / Intercâmbio Eletrônico e pesquisar a transação pelo número da senha/guia informada (${senhaNum}).`,
        `[PB-UNI-45] Inspecionar a fila de mensageria e logs do webservice de Intercâmbio (PTU Online / WAutoriza / barramento da Federação) para identificar o motivo da retenção ou falha de comunicação da transação.`,
        `[PB-UNI-45] Realizar a limpeza de pendência ou reprocessamento/retransmissão manual da guia de autorização no HRP para forçar o tráfego da senha junto à Unimed parceira/executora.`,
        `[PB-UNI-45] Caso persista erro no webservice da Unimed de destino ou indisponibilidade na Federação, registrar o log e acionar o suporte de Intercâmbio da Federação mantendo o ticket em acompanhamento.`,
        `[PB-UNI-45] Responder à solicitante ${ticket.requester} (${sectorName}) informando o reprocessamento da senha no HRP e orientando a checagem do retorno no sistema.`
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente ao procedimento no sistema HRP cuja senha/guia de autorização (${senhaNum}) não está trafegando pelo Intercâmbio.\n\n` +
        `Nossa equipe técnica já iniciou a verificação da transação diretamente no módulo de Autorização e na fila de mensageria do Intercâmbio (PTU/Webservice) do HRP para identificar o motivo da retenção e realizar o reprocessamento da transmissão junto à Unimed responsável.\n\n` +
        `Como você já informou o número da senha (${senhaNum}), temos todos os dados necessários para o diagnóstico e tratativa no sistema. Caso seja necessária alguma validação cadastral complementar (como a carteirinha do beneficiário ou código do procedimento), solicitaremos por aqui.\n\n` +
        `Assim que concluirmos o reprocessamento da guia ou tivermos o retorno da transmissão, atualizaremos este chamado para que você possa conferir no HRP!\n\n` +
        `Permanecemos à disposição!`;
    } else if (normAll.includes("nextcloud") || normAll.includes("nextclaud")) {
      const explicitFolder =
        formFields.problema?.match(/pasta\s+([^,]+)/i)?.[1]?.trim() ||
        formFields.descricao?.match(/pasta\s+([^,.\n]+)/i)?.[1]?.trim() ||
        formFields.aplicacao ||
        "Nextcloud";

      translatedIntent =
        `A solicitante **${ticket.requester}** (${sectorName}) relata dificuldade de acesso ou sincronização na pasta **${explicitFolder}** do Nextcloud.`;
      detectedDomain = "Acessos, Permissões e Contas";
      suggestedCategory = "T.I > ST > Resolução de Problemas > Erros de Sistema";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason = `Falha de acesso ou sincronização no serviço de arquivos em nuvem (Nextcloud - ${sectorName}).`;
      sufficiencyStatus = "parcial";
      missingInfo = [
        "Confirmar se o acesso ocorre pelo navegador web (IP/URL) ou pelo aplicativo Nextcloud sincronizado no Windows Explorer",
        "Informar o ID do HopToDesk da máquina para diagnóstico da sincronização"
      ];
      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos o seu relato referente ao **Nextcloud** (${sectorName}).\n\n` +
        `Para agilizarmos o diagnóstico, você poderia nos confirmar rapidamente:\n` +
        `1. O acesso está sendo feito pelo **navegador web** ou pelo **atalho/pasta sincronizada no Windows**?\n` +
        `2. Qual é o seu **ID do HopToDesk** para conectarmos remotamente e verificarmos a sincronização da estação?\n\n` +
        `Ficamos no aguardo para apoiar na regularização!`;
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
      normAll.includes("precificacao") ||
      normAll.includes("gestantes") ||
      (normAll.includes("0256") && normAll.includes("relatorio")) ||
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
          "Solicitação da equipe buscando o caminho/módulo no sistema HRP para extração do Relatório de Gestantes (carteira Clientes 0256).";
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
    } else if (
      /\b(google\s*meet|meet|teams|zoom|videoconfer[eê]ncia|reuni[aã]o\s+online|link\s+(?:d[ea]|para)\s+reuni[aã]o|link\s+no\s+meet)\b/i.test(
        normAll
      )
    ) {
      const isMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor|tarcisio)\b/i.test(
        firstName
      );
      const solPrefix = isMale ? "O solicitante" : "A solicitante";
      const pronounSelf = isMale ? "você mesmo" : "você mesma";
      const platform = /\bteams\b/i.test(normAll)
        ? "Microsoft Teams"
        : /\bzoom\b/i.test(normAll)
        ? "Zoom"
        : "Google Meet";

      detectedDomain = "Suporte Técnico Geral / Service Desk";
      suggestedCategory = (ticket.category && ticket.category.includes("Treinamentos"))
        ? ticket.category
        : "T.I > ST > Instalação/Configuração > Aplicativos";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason = `Solicitação de criação de link de videoconferência (${platform}) para treinamento agendado pelo setor ${sectorName}.`;

      const categoryMismatch =
        normalizeText(ticket.category || "") !==
        normalizeText(suggestedCategory);
      const reclassNote = categoryMismatch
        ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}").*`
        : "";

      const hasTraining = /\btreinamento\b/i.test(normAll);
      const purpose = hasTraining
        ? "realização de treinamento com participante externa"
        : "realização de reunião online";

      translatedIntent =
        `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a **criação de um link de videoconferência no ${platform}** ` +
        `para ${purpose}. ` +
        `O chamado contém todas as informações necessárias para a geração da sala virtual.${reclassNote}`;
      sufficiencyStatus = "completo";
      missingInfo = [];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente à criação de link de videoconferência no **${platform}** para o treinamento de amanhã com a secretária externa.\n\n` +
        `Nossa equipe técnica já está gerando a sala no **${platform}** e disponibilizará o link de acesso diretamente por aqui para que você possa encaminhar à participante.\n\n` +
        `Além do ${platform}, caso tenha preferência por utilizar outras plataformas corporativas de videoconferência como **Microsoft Teams** ou **Zoom**, também podemos disponibilizar a sala na ferramenta de sua escolha.\n\n` +
        `💡 **Dica de Autonomia:** Caso precise gerar links de reuniões no seu dia a dia de forma rápida e imediata, ${pronounSelf} pode criá-los a qualquer momento:\n` +
        `1. Acesse **[meet.google.com](https://meet.google.com)** conectada ao seu e-mail institucional;\n` +
        `2. Clique no botão azul **\"Nova reunião\"**;\n` +
        `3. Selecione a opção **\"Criar uma reunião para mais tarde\"** (ou *\"Iniciar uma reunião instantânea\"*);\n` +
        `4. Copie o link gerado e compartilhe com os participantes!\n\n` +
        `Assim que o link da reunião for gerado pela nossa equipe, enviaremos aqui no chamado para você!\n\n` +
        `Permanecemos à disposição!`;
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
      normAll.includes("reserva") ||
      normAll.includes("emprestimo") ||
      normAll.includes("empréstimo")
    ) {
      if (
        normAll.includes("medico") ||
        normAll.includes("médico") ||
        ticket.id === 42768
      ) {
        translatedIntent =
          `A solicitante **${ticket.requester}** (${sectorName}) solicita a reserva da nova caixa de som (com Bluetooth) e de um microfone ` +
          `recém-adquiridos pela cooperativa para utilização no evento comemorativo do Dia dos Médicos no sábado (17/10).`;
      } else {
        translatedIntent =
          `Solicitação de reserva/empréstimo de equipamentos audiovisuais (projetor, notebook, som ou microfone) ` +
          `e apoio da T.I. para evento institucional do setor ${sectorName}.`;
      }
      detectedDomain = "Suporte Técnico Geral / Service Desk";
      suggestedCategory = "T.I > ST > Apoio a Eventos / Empréstimo de Equipamentos";
      realUrgency = "Média";
      urgencyReason =
        "Evento institucional com data marcada, demandando reserva prévia de equipamentos e alinhamento logístico.";
      sufficiencyStatus = "parcial";
      missingInfo = [
        "Local exato onde será realizado o evento (Auditório da Sede, Hospital ou espaço externo)",
        "Horário de início do evento e alinhamento sobre a retirada prévia na T.I. ou necessidade de montagem/testes presenciais no local",
        "Necessidade de itens adicionais (extensões elétricas, pilhas reservas para microfone ou cabos de áudio)",
      ];
    } else if (
      /\b(caixa de som|microfone|headset|headsets|fone de ouvido|fones de ouvido|webcam|webcams|equipamento de audio|equipamento de som)\b/i.test(
        normAll
      )
    ) {
      translatedIntent =
        `Solicitação de fornecimento, instalação ou manutenção de equipamento de áudio/multimídia (${cleanSubject}) ` +
        `para o setor ${sectorName}.`;
      detectedDomain = "Infraestrutura e Rede / Suporte Técnico";
      suggestedCategory = "T.I > IR > Suporte a Hardware > Periféricos > Áudio e Vídeo";
      realUrgency = "Média";
      urgencyReason =
        "Atendimento de hardware para periféricos de som e comunicação no posto de trabalho.";
      sufficiencyStatus = "completo";
      missingInfo = [];
    } else if (
      /\b(item no glpi|itens no glpi|formul[aá]rio(s)? no glpi|formcreator|criar novos? itens?|criar novos? formul[aá]rios?|novo item no glpi|novos itens no glpi|criar item no glpi|inser[cç][aã]o da op[cç][aã]o de inserir documentos|inserir documentos nos chamados|anexar documentos nos chamados|op[cç][aã]o de anexar documentos|campo de anexo|documentos nos chamados)\b/i.test(
        normAll
      ) ||
      (/\bglpi\b/i.test(normAll) &&
        /\b(regulatório|regulatorio|regula[cç][aã]o|faturamento|financeiro|rh|contabil|setor)\b/i.test(
          normAll
        ) &&
        /\b(documentos?|anexos?|campo|formulario|formularios|itens|item)\b/i.test(
          normAll
        )) ||
      (/\bglpi\b/i.test(normAll) &&
        /\b(formul[aá]rio|formul[aá]rios|item|itens)\b/i.test(normAll) &&
        /\b(criar|cria[çc][ãa]o|novo|novos|inclus[ãa]o|adicionar|parametrizar)\b/i.test(normAll))
    ) {
      const descText = formFields.descricao || ticket.content || "";
      const isMale = /^(frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|diego|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor)\b/i.test(
        firstName
      );
      const solPrefix = isMale ? "O solicitante" : "A solicitante";

      const isDocAttachmentAdjustment =
        /\b(inser[cç][aã]o da op[cç][aã]o de inserir documentos|inserir documentos nos chamados|anexar documentos nos chamados|op[cç][aã]o de anexar documentos|campo de anexo|documentos nos chamados)\b/i.test(
          normAll
        ) ||
        (/\b(inserir|anexar|inclus[ãa]o|adicionar|op[cç][aã]o)\b/i.test(normAll) &&
          /\b(documentos?|anexos?|arquivos?)\b/i.test(normAll) &&
          /\b(regulatório|regulatorio|regula[cç][aã]o|faturamento|financeiro|rh|glpi)\b/i.test(normAll));

      if (isDocAttachmentAdjustment) {
        const rawSectorMatch = (ticket.content || "").match(/direcionados? ao ([a-zá-úÁ-Ú]+)/i) || (ticket.content || "").match(/setor\s*:\s*([a-zá-úÁ-Ú]+)/i);
        let targetFormSector = rawSectorMatch ? rawSectorMatch[1].trim() : "Regulatório";
        if (/regulat[oó]rio/i.test(targetFormSector)) targetFormSector = "Regulatório";
        else if (/regula[cç][aã]o/i.test(targetFormSector)) targetFormSector = "Regulação";
        else if (/faturamento/i.test(targetFormSector)) targetFormSector = "Faturamento";
        else if (/financeiro/i.test(targetFormSector)) targetFormSector = "Financeiro";
        else if (/cont[aá]bil/i.test(targetFormSector)) targetFormSector = "Contábil";
        detectedDomain = "Desenvolvimento de Software / Aplicações Internas";
        suggestedCategory = "T.I > DV > Desenvolvimento > Ajustes em layout/interface";
        realUrgency = ticket.urgency_label && ticket.urgency_label !== "Muito baixa" ? ticket.urgency_label : "Média";
        urgencyReason = `Parametrização e ajuste no formulário do GLPI (plugin Formcreator) para inclusão do campo de anexo de documentos na abertura de chamados direcionados ao setor ${targetFormSector}.`;
        sufficiencyStatus = "completo";
        missingInfo = [];

        translatedIntent =
          `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a inserção da opção de anexar/inserir documentos nos chamados direcionados ao setor **${targetFormSector}** no sistema **GLPI**. ` +
          `A demanda requer ajuste no catálogo do plugin Formcreator pela equipe de Desenvolvimento para disponibilizar o campo de envio de arquivos na abertura do ticket. ` +
          `O chamado foi aberto na categoria '${ticket.category}' e recomenda-se reclassificar para 'T.I > DV > Desenvolvimento > Ajustes em layout/interface'.`;

        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente à inclusão da opção de anexar documentos nos chamados direcionados ao **${targetFormSector}** no **GLPI**.\n\n` +
          `A demanda já foi validada na triagem técnica e direcionada para a equipe de **Desenvolvimento** realizar o ajuste no formulário (plugin Formcreator), habilitando o campo para envio de arquivos.\n\n` +
          `Assim que a opção estiver configurada e disponível no catálogo para a abertura dos chamados com anexo, confirmaremos por aqui!\n\n` +
          `Permanecemos à disposição!`;

        customResolutionSteps = [
          "[PB-UNI-29] Reclassificar a categoria do chamado no GLPI para 'T.I > DV > Desenvolvimento > Ajustes em layout/interface'.",
          "[PB-UNI-29] Acessar o painel administrativo do GLPI com perfil técnico/desenvolvimento e navegar até Administração > Formulários (plugin Formcreator).",
          `[PB-UNI-29] Localizar o formulário de abertura de chamados direcionado ao setor ${targetFormSector} / Regulação.`,
          "[PB-UNI-29] Adicionar ou habilitar o campo/seção de upload de arquivos e documentos (campo do tipo Arquivo/Anexo).",
          "[PB-UNI-29] Salvar a parametrização e testar a abertura no catálogo para validar que a opção de anexar documentos está visível e funcional.",
          "[PB-UNI-29] Registrar a conclusão no chamado e notificar a solicitante para conferência e homologação."
        ];
      } else {
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

        const hasMultipleItems =
          itemNames.length > 1 ||
          /\b(item 2|item\s*2|dois itens|2 itens|novos itens|novos formul[aá]rios|mais de um item|mais de um formul[aá]rio)\b/i.test(
            descText
          );
        const itemsCountLabel = hasMultipleItems
          ? itemNames.length > 1
            ? `${itemNames.length} novos formulários/itens`
            : "novos formulários/itens"
          : "um novo formulário/item";

        const itemsListed =
          itemNames.length > 0
            ? itemNames.map((n) => `**${n}**`).join(" e ")
            : itemsCountLabel;

        detectedDomain = "Desenvolvimento de Software / Aplicações Internas";
        suggestedCategory = "T.I > DV > Desenvolvimento > Novas aplicações";
        realUrgency = ticket.urgency_label || "Baixa";
        urgencyReason = hasMultipleItems
          ? `Criação e parametrização de novos formulários no catálogo do GLPI para atender os fluxos de trabalho e demandas intersetoriais do ${sectorName}.`
          : `Criação e parametrização de novo formulário no catálogo do GLPI para atender o fluxo de trabalho do setor ${sectorName}.`;

        const hasFieldsSpecification =
          /\b(campos?|obrigat[oó]rio|opcional|destino autom[aá]tico)\b/i.test(
            descText
          );

        if (hasFieldsSpecification) {
          const singularOrPluralIntent = hasMultipleItems
            ? `solicita a criação de ${itemsCountLabel} no catálogo do sistema **GLPI** vinculados à categoria de **${sectorName}** (${itemsListed}). O solicitante detalhou toda a estrutura necessária: nomes dos formulários, campos obrigatórios e opcionais, opções de seleção e destino automático dos chamados.`
            : `solicita a criação de **um novo formulário/item** no catálogo do sistema **GLPI** vinculado à categoria de **${sectorName}** (${itemsListed}). O solicitante detalhou toda a estrutura necessária: nome do formulário, campos obrigatórios e opcionais, opções de seleção e destino automático dos chamados.`;

          translatedIntent =
            `${solPrefix} **${ticket.requester}** (${sectorName}) ${singularOrPluralIntent} ` +
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

          const formActionPhrase = hasMultipleItems
            ? `criação de ${itemsCountLabel} no catálogo do **GLPI** para o setor de **${sectorName}**`
            : `criação de um novo formulário/item no catálogo do **GLPI** para o setor de **${sectorName}**`;

          const devStartPhrase = hasMultipleItems
            ? `Nossa equipe de Desenvolvimento já iniciou a parametrização dos novos formulários no Formcreator do GLPI. Assim que estiverem publicados no catálogo e disponíveis para homologação, avisaremos por aqui para que você possa realizar os testes de validação!`
            : `Nossa equipe de Desenvolvimento já iniciou a parametrização do novo formulário no Formcreator do GLPI. Assim que estiver publicado no catálogo e disponível para homologação, avisaremos por aqui para que você possa realizar os testes de validação!`;

          customPublicReply =
            `Olá, ${firstName}! Tudo bem?\n\n` +
            `Recebemos a sua solicitação referente à ${formActionPhrase}:\n` +
            (itemsBullet || (itemNames.length === 1 ? `1. **${itemNames[0]}**.\n\n` : "")) +
            `Todos os requisitos informados (relação de campos obrigatórios e opcionais, opções de seleção e destinos automáticos para os setores e observadores) já foram validados na triagem técnica.\n\n` +
            `${devStartPhrase}\n\n` +
            `Permanecemos à disposição!`;
        } else {
          const formLabelIncomplete = hasMultipleItems
            ? "novos formulários/itens"
            : "um novo formulário/item";
          translatedIntent =
            `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a criação de ${formLabelIncomplete} no **GLPI** para o setor de **${sectorName}**, porém sem especificar todos os campos necessários.`;
          sufficiencyStatus = "parcial";
          missingInfo = [
            hasMultipleItems
              ? "Relação dos campos a serem criados nos formulários (indicando quais são obrigatórios e quais são opcionais)"
              : "Relação dos campos a serem criados no formulário (indicando quais são obrigatórios e quais são opcionais)",
            "Opções de seleção para campos do tipo lista suspensa/menu",
            "Setores, grupos ou observadores de destino automático dos chamados gerados pelo formulário",
          ];
          customPublicReply =
            `Olá, ${firstName}! Tudo bem?\n\n` +
            `Recebemos a sua solicitação referente à criação de ${formLabelIncomplete} no **GLPI** para o setor de **${sectorName}**.\n\n` +
            `Para que possamos parametrizar ${hasMultipleItems ? "os formulários" : "o formulário"} exatamente conforme a necessidade do fluxo de trabalho, você poderia nos detalhar:\n` +
            `1. A **relação dos campos** desejados (indicando quais devem ser obrigatórios e quais são opcionais);\n` +
            `2. As **opções de seleção** para campos de lista/menu;\n` +
            `3. Quais **setores, grupos ou observadores** devem receber automaticamente os chamados abertos por esse formulário?\n\n` +
            `Assim que nos confirmar essas informações por aqui, daremos sequência imediata na configuração!`;
        }
      }
    } else if (
      !/\b(item no glpi|itens no glpi|formul[aá]rio(s)? no glpi|formcreator|criar novos? itens?|criar novos? formul[aá]rios?|inser[cç][aã]o da op[cç][aã]o de inserir documentos|inserir documentos nos chamados)\b/i.test(
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
      !/\b(unifica|unificar|unificacao|duplicad|duplicidade)\b/i.test(normAll) &&
      !/\b(dando erro|aparece este erro|erro ao salvar|erro para eu salvar|erro para salvar|falha ao salvar|erros de sistema|abrir um chamado na federa[çc][ãa]o)\b/i.test(
        normAll
      ) &&
      !ticket.category.includes("Erros de Sistema") &&
      (normAll.includes("acesso e permissoes") ||
        ticket.category.includes("Acesso e Permissões") ||
        /\bfavor cadastrar\b|\bliberar acesso\b/i.test(normCore) ||
        (/\bcadastro d[eo]\s+(m[ée]dic[oa]|colaborador|funcion[áa]ri[oa]|doutor|dr\.?|dra\.?|profissional|prestador|usu[áa]ri[oa]|plantonista)\b/i.test(normCore) &&
          !/\b(erro|erros|falha|salvar|gravar|contrato|contratos)\b/i.test(normCore)))
    ) {
      const descText = formFields.descricao || "";
      const normDesc = normalizeText(descText);

      // Tenta identificar se o relato pede cadastro/acesso para outra pessoa (ex: "Favor cadastrar Dr Humberto França Ferreira", "liberar acesso para a Dra Paula")
      const targetMatch = descText.match(
        /(?:favor\s+)?(?:cadastrar|liberar\s+acesso\s+(?:para|ao\s+(?:dr\.?|m[ée]dico)|a\s+(?:dra\.?|m[ée]dica))|cadastro\s+d[eo]a?\s+(?:dr\.?|dra\.?|m[ée]dic[oa]|colaborador[a]?|profissional|prestador)|acesso\s+para)\s+(?:o\s+|a\s+)?((?:dr\.?|dra\.?)\s+[^,\n.;]+|[A-ZÀ-Ú][a-zà-ú]+(?:\s+(?:da|de|do|dos|das|e|[A-ZÀ-Ú][a-zà-ú]+)){1,4})/i
      );
      let targetPerson = targetMatch
        ? targetMatch[1].replace(/\s+/g, " ").trim()
        : "";
      if (
        targetPerson &&
        /\b(faturamento|eletr[oô]nic[oa]|sistema|sistemas|m[oó]dulo(s)?|spdata|sgh|hrp|prontu|pep|biometria|facial|catraca|porta(s)?|rede|pasta(s)?|contas|ultrassom|laborat[oó]rio|recep[çc][ãa]o|intranet|internet|wi-?fi|e-?mail|totvs|autolac|myplace|pacs|benner|agenda|atendentes?|cl[íi]nicas?|nov[ao]s?|usu[áa]rios?|setor|nas|prestador(es)?|m[ée]dico(s)?|profissional|colaborador(a)?)\b/i.test(
          targetPerson
        )
      ) {
        targetPerson = "";
      }

      const normColabForm = normalizeText(formFields.nomeColaborador || "");
      const normReqFirst = normalizeText(firstName);
      const normReqFull = normalizeText(ticket.requester || "");
      const normTarget = normalizeText(targetPerson);

      // Identifica se a solicitação é de acesso próprio do solicitante
      const isSelfRequestText = /\b(preciso de|solicito|meu acesso|meu usu[áa]rio|para mim|me liberar|me conceder|meu login)\b/i.test(descText);
      const isSamePerson =
        !targetPerson &&
        (Boolean(normColabForm) &&
          (normReqFull.includes(normColabForm) ||
            normColabForm.includes(normReqFirst) ||
            normReqFirst === normColabForm.split(/\s+/)[0] ||
            normColabForm.startsWith(normReqFirst)));

      // Verifica se o solicitante preencheu os próprios dados no formulário em vez dos dados do beneficiário do acesso (apenas quando pede acesso para um terceiro)
      const filledOwnData =
        Boolean(targetPerson) &&
        !isSamePerson &&
        normTarget !== normColabForm &&
        !normTarget.includes(normReqFirst) &&
        (normColabForm === normReqFirst ||
          normReqFull.startsWith(normColabForm) ||
          normColabForm.startsWith(normReqFirst));

      const beneficiaryName =
        targetPerson || (formFields.nomeColaborador ? formatPersonName(formFields.nomeColaborador) : "") || "o(a) profissional";

      const rawAcessos = (formFields.acessos || "")
        .replace(/outros\s*\(?descrever em observa[çc][õo]es\)?,?\s*/gi, "")
        .trim();
      const mentionsSpecificSystem =
        /\b(prontu[aá]rio|spdata|sgh|wifi|wi-fi|lgpd|faculdade|email|e-mail|nextcloud|rede|active directory|totvs|hrp|autolac|myplace|pacs|biometria|facial|catraca|porta|portas)\b/i.test(
          normDesc
        );
      const hasSpecifiedAccesses = Boolean(rawAcessos) || mentionsSpecificSystem;

      let specifiedAccessTxt = rawAcessos;
      if (!specifiedAccessTxt) {
        if (/\b(prontu[aá]rio\s+do\s+hospital|prontu[aá]rio\s+hospitalar|pep\s+hospitalar)\b/i.test(descText)) {
          specifiedAccessTxt = "Prontuário do Hospital (SGH Spdata)";
        } else if (/\bfaturamento\s+eletr[oô]nico\b/i.test(descText) && /\bspdata\b/i.test(descText)) {
          specifiedAccessTxt = "Faturamento Eletrônico no SPDATA";
        } else if (/\bfaturamento\s+eletr[oô]nico\b/i.test(descText)) {
          specifiedAccessTxt = "Faturamento Eletrônico";
        } else if (/\bspdata\b/i.test(descText)) {
          specifiedAccessTxt = "Sistema SGH Spdata";
        } else if (/\bhrp\b/i.test(descText)) {
          specifiedAccessTxt = "ERP HRP Unimed";
        } else if (/\bpep\b/i.test(descText) || /\bprontu\b/i.test(descText)) {
          specifiedAccessTxt = "Prontu+ (PEP)";
        } else if (/\bmyplace\b/i.test(descText)) {
          specifiedAccessTxt = "MyPlace / Benner";
        } else if (/\bnextcloud\b/i.test(descText)) {
          specifiedAccessTxt = "Nextcloud";
        } else if (/\bactive\s+directory\b|\brede\b/i.test(descText)) {
          specifiedAccessTxt = "Rede / Active Directory";
        } else {
          specifiedAccessTxt = "sistemas informados na descrição";
        }
      }

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

      const isHospitalMedicalRecordRegistration =
        (/\b(prontu[aá]rio\s+do\s+hospital|prontu[aá]rio\s+hospitalar|spdata|sgh\s+spdata|pep\s+hospitalar)\b/i.test(
          normAll
        ) ||
          (/\bprontu[aá]rio\b/i.test(normAll) && /\bhospital\b/i.test(normAll))) &&
        (/\b(cadastro|libera[çc][ãa]o|acesso|profissional|profissionais|mandei tudo junto|alta demanda|vai mais de um profissional)\b/i.test(
          normAll
        ) ||
          /\bcpf\b/i.test(normAll));

      if (isHospitalMedicalRecordRegistration) {
        const healthProfessionals = extractHealthProfessionals(formFields, descText);
        const hasStaffFollowup = (ticket.followups || []).some(
          (f) =>
            !f.is_private &&
            /\b(spdata|dados adicionais|especialidade|conselho profissional|replicar)\b/i.test(
              f.content || ""
            )
        );

        let profNamesFormatted = "";
        let profSummaryList = "";
        if (healthProfessionals.length > 0) {
          const names = healthProfessionals.map((p) => p.name);
          if (names.length === 1) {
            profNamesFormatted = names[0];
          } else if (names.length === 2) {
            profNamesFormatted = `${names[0]} e ${names[1]}`;
          } else {
            profNamesFormatted = `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
          }
          profSummaryList = healthProfessionals
            .map((p) => `${p.name}${p.cpf ? ` (CPF: ${p.cpf})` : ""}`)
            .join(", ");
        } else {
          profNamesFormatted = beneficiaryName;
          profSummaryList = `${beneficiaryName}${formFields.cpf ? ` (CPF: ${formFields.cpf})` : ""}`;
        }

        const countText =
          healthProfessionals.length > 1
            ? `${healthProfessionals.length} profissionais de saúde (${profNamesFormatted})`
            : `o(a) profissional de saúde **${profNamesFormatted}**`;

        detectedDomain = "Acessos, Permissões e Contas";
        suggestedCategory = "T.I > ST > Acesso e Permissões > Criação de Usuários";
        realUrgency = "Média";
        urgencyReason =
          "Cadastro de profissionais de saúde no Prontuário do Hospital (sistema SGH Spdata / PEP Hospitalar) para atendimento assistencial.";

        sufficiencyStatus = "parcial";
        missingInfo = [
          `Nome completo e Data de nascimento das profissionais para localização/cadastro no sistema SPdata`,
          `Especialidade ou função assistencial desempenhada no hospital (ex.: Fisioterapia, Terapia Ocupacional, Enfermagem, etc.)`,
          `Conselho Profissional e Número de Registro (órgão de classe com respectivo número e UF, ex.: CREFITO, CRP, COREN, CRM)`,
          `Profissional de referência no Hospital Unimed para espelhamento do perfil de permissões de evolução clínica no SPdata`
        ];

        translatedIntent =
          `A solicitante **${ticket.requester}** (${sectorName}) solicita cadastro e liberação de acesso ao **Prontuário do Hospital (sistema SGH Spdata / PEP Hospitalar)** para ${countText} devido à demanda assistencial da unidade. ` +
          `O chamado foi classificado como **PARCIAL** pois, embora os nomes e CPFs tenham sido informados, o cadastro clínico no SPdata exige dados complementares (Data de nascimento, Especialidade, Conselho Profissional e Número de Registro com UF, e usuário de referência).` +
          (hasStaffFollowup
            ? ` A equipe de T.I. já adicionou andamento solicitando essas informações e o ticket permanece como Pendente aguardando retorno.`
            : ` Demanda solicitação desses dados complementares para viabilizar os cadastros.`);

        customResolutionSteps = [
          `[PB-UNI-43] Analisar a relação de profissionais solicitadas: ${profSummaryList}.`,
          `[PB-UNI-43] Verificar no ERP HRP e no SGH Spdata se as profissionais já possuem cadastro prévio utilizando os CPFs fornecidos.`,
          `[PB-UNI-43] Aguardar o retorno da solicitante com os dados clínicos complementares (Data de nascimento, Especialidade, Conselho Profissional e Número de Registro com UF, e usuário de referência).`,
          `[PB-UNI-43] Efetuar o cadastro das usuárias no sistema SGH Spdata (módulo Prontuário / PEP Hospitalar) vinculando o conselho de classe e configurando as permissões assistenciais replicadas da referência.`,
          `[PB-UNI-43] Testar a ativação dos acessos e responder à solicitante no chamado do GLPI com as orientações de primeiro login.`
        ];

        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente ao cadastro ${healthProfessionals.length > 1 ? "das profissionais" : "do(a) profissional"} no **Prontuário do Hospital (sistema SGH Spdata / PEP Hospitalar)**: **${profNamesFormatted}**.\n\n` +
          `Para que nossa equipe de T.I. possa realizar o cadastro no sistema SPdata com os devidos perfis assistenciais de evolução clínica, precisamos das seguintes informações complementares de cada uma delas:\n` +
          `1. **Nome completo** e **Data de nascimento**;\n` +
          `2. **Especialidade / Função** desempenhada no hospital (ex.: Fisioterapia, Terapia Ocupacional, Enfermagem, etc.);\n` +
          `3. **Conselho Profissional e Número de Registro:** Informar qual o conselho (CRM, COREN, CREFITO, CRP, etc.) e o respectivo **número de registro com a UF**;\n` +
          `4. **Profissional de referência** que já desempenhe a mesma função no hospital (para que possamos replicar exatamente o perfil de permissões no SPdata).\n\n` +
          `Assim que nos enviar esses dados por aqui, daremos andamento imediato na liberação dos acessos!\n\n` +
          `Permanecemos à disposição!`;
      } else if (filledOwnData && !hasSpecifiedAccesses) {
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
        const isSelf = isSamePerson || (!targetPerson && isSelfRequestText) || !targetPerson;
        const targetSector = formFields.setorAlvo || sectorName;
        const targetUnit = formFields.unidade ? ` (${formFields.unidade})` : "";

        const isExternalAgencyOrPortal =
          (/\b(urucum|ag[eê]ncia|marketing digital)\b/i.test(normAll) &&
           /\b(portal unimed|gerenciador|site|plataforma do nosso site)\b/i.test(normAll)) ||
          (/\bportal unimed\b/i.test(normAll) &&
           /\b(site|gerenciador|landing pages?|google tag manager|pixel meta)\b/i.test(normAll) &&
           /\b(empresa|ag[eê]ncia|terceir|extern[ao])\b/i.test(normAll));

        const isEmailAccountOrForwarding =
          !isExternalAgencyOrPortal &&
          !/\b(e-?mail marketing|ferramenta de e-?mail marketing)\b/i.test(normAll) &&
          (/\b(redirecion|redirecionamento|redirecionar|redirecionadas|encaminh|encaminhamento|encaminhar|caixa departamental|caixa compartilhada|jornalismo@|marketing@|webmail)\b/i.test(
            normAll
          ) ||
          (/\b(e-mail|email)\b/i.test(normAll) &&
            /\b(marketing|jornalismo|financeiro|compras|faturamento|recurso|ouvidoria|contato|recepcao|secretaria)\b/i.test(
              normAll
            ) &&
            /\b(conta|caixa|acesso|permissao|redirecion)\b/i.test(normAll)));

        const isMale = /^(juliano|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|diego|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor)\b/i.test(
          firstName
        );
        const colabLabel = isMale ? "o colaborador" : "a colaboradora";

        if (isExternalAgencyOrPortal) {
          const agencyName = "Urucum Digital";
          const agencyEmail = "contato@urucumdigital.com.br";
          const requestedSys = "Portal Unimed (Gerenciador do Site / CMS)";

          detectedDomain = "Acessos, Permissões e Contas";
          suggestedCategory = "T.I > ST > Acesso e Permissões";
          realUrgency = ticket.urgency_label || "Alta";
          urgencyReason = `Liberação de acesso de gestão do Portal Unimed para agência externa (${agencyName}), demandando validação de governança para domínios corporativos (@unimed).`;

          const hasFollowup = (ticket.followups || []).some(
            (f) => !f.is_private && /\b(raphael|dom[ií]nios?\s*["']?unimed|f[eé]rias)\b/i.test(f.content || "")
          );

          translatedIntent =
            `O solicitante **${ticket.requester}** (${sectorName}) solicita liberação de acesso ao **${requestedSys}** para a agência terceirizada **${agencyName}** (${agencyEmail}) para desenvolvimento de Landing Pages, integração de CRM, Google Tag Manager e campanhas de tráfego pago.` +
            (hasFollowup
              ? ` A equipe de T.I. (Luiz Fernando Piantino) já realizou alinhamento inicial pontuando que o portal exige domínios institucionais "@unimed", mantendo o ticket em status Pendente aguardando retorno do gestor da plataforma (Raphael) para definir a viabilidade de credencial corporativa.`
              : ` Demanda alinhamento de segurança e governança sobre a restrição de domínio corporativo "@unimed" para terceiros.`);

          sufficiencyStatus = "completo";
          missingInfo = [];

          customResolutionSteps = [
            `[PB-UNI-41] Avaliar o escopo de serviços de marketing digital contratados junto à agência ${agencyName} (${agencyEmail}).`,
            `[PB-UNI-41] Validar a política de segurança do Portal Unimed (Liferay / Unimed do Brasil), que restringe contas administrativas a domínios institucionais '@unimed'.`,
            `[PB-UNI-41] Alinhar com o administrador da plataforma do portal (Raphael) a viabilidade de provisionar conta corporativa de terceiro para a agência ou perfil restrito de edição.`,
            `[PB-UNI-41] Manter o chamado em status 'Pendente' aguardando o retorno e direcionamento da gestão do portal.`,
            `[PB-UNI-41] Após a deliberação, efetuar o provisionamento das credenciais e notificar o solicitante e a agência.`
          ];

          customPublicReply =
            `Olá, ${firstName}! Tudo bem?\n\n` +
            `Recebemos a sua solicitação referente à liberação de acesso ao **gerenciador do site institucional (Portal Unimed)** para a agência **${agencyName}** (${agencyEmail}).\n\n` +
            `Conforme alinhado pelo técnico Luiz Fernando, as diretrizes de governança e segurança do Portal Unimed restringem a concessão de acessos administrativos exclusivamente a domínios corporativos '@unimed'. O chamado já está em acompanhamento junto ao administrador da plataforma (Raphael) para definirmos a melhor forma de provisionamento (como a criação de um e-mail institucional de prestador ou autorização excepcional).\n\n` +
            `O ticket permanecerá com o status **Pendente** enquanto finalizamos esse alinhamento técnico interno. Assim que tivermos a definição, confirmaremos imediatamente por aqui!\n\n` +
            `Permanecemos à disposição!`;
        } else if (isEmailAccountOrForwarding) {
          const foundEmails = Array.from(
            ticket.content.matchAll(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/gi)
          ).map((m) => m[1].toLowerCase());
          const destEmail =
            foundEmails.find((e) => !e.includes("jornalismo")) ||
            foundEmails[0] ||
            "marketing@unimedsudoestemg.coop.br";
          const srcEmail =
            foundEmails.find((e) => e.includes("jornalismo") || e !== destEmail) ||
            "jornalismo@unimedsudoestemg.coop.br";
          const hasForwarding = /\b(redirecion|encaminh|forward)/i.test(normAll);

          if (hasForwarding) {
            translatedIntent =
              `${solPrefix} **${formattedRequester}** (${sectorName}) solicita acesso à conta de e-mail departamental **${destEmail}** ` +
              `e a configuração de regra de redirecionamento automático das mensagens recebidas em **${srcEmail}** para a referida conta do setor. ` +
              `Todos os dados cadastrais e as contas de correio eletrônico constam informados no chamado.`;
            customPublicReply =
              `Olá, ${firstName}! Tudo bem?\n\n` +
              `Recebemos a sua solicitação referente à conta de e-mail departamental do setor **${sectorName}** e ao redirecionamento de mensagens.\n\n` +
              `Todas as informações necessárias já constam no chamado e nossa equipe de T.I. já está realizando as devidas configurações no painel de administração de e-mails corporativos:\n` +
              `1. **Acesso à Conta:** Liberação de acesso à caixa departamental **${destEmail}** para o seu usuário.\n` +
              `2. **Redirecionamento Automático:** Configuração da regra de encaminhamento automático das mensagens enviadas para **${srcEmail}** diretamente para a conta **${destEmail}**.\n\n` +
              `Assim que as configurações forem concluídas e validadas com mensagem de teste, confirmaremos por aqui com as instruções de acesso!\n\n` +
              `Permanecemos à disposição!`;
            customResolutionSteps = [
              `[PB-UNI-38] Acessar o painel administrativo de e-mails corporativos da cooperativa (Webmail Seguro / Locaweb).`,
              `[PB-UNI-38] Localizar a conta departamental ${destEmail} e liberar a permissão de acesso / fornecer as credenciais ou configurar o acesso no cliente de e-mail do colaborador ${beneficiaryName}.`,
              `[PB-UNI-38] Localizar a conta de origem ${srcEmail} e criar a regra de redirecionamento automático (forwarding) para ${destEmail}, assegurando que nenhuma mensagem seja perdida.`,
              `[PB-UNI-38] Realizar envio de mensagem de teste para validar o correto recebimento e o encaminhamento automático entre as contas.`,
              `[PB-UNI-38] Notificar o solicitante no chamado do GLPI com as orientações de acesso ao Webmail/Outlook e colher validação.`
            ];
          } else {
            translatedIntent =
              `${solPrefix} **${formattedRequester}** (${sectorName}) solicita concessão de acesso à conta de e-mail departamental **${destEmail}**. ` +
              `Dados cadastrais informados no chamado.`;
            customPublicReply =
              `Olá, ${firstName}! Tudo bem?\n\n` +
              `Recebemos a sua solicitação de acesso à conta de e-mail departamental **${destEmail}** (${sectorName}).\n\n` +
              `Todas as informações necessárias já constam no chamado e nossa equipe de T.I. já está realizando a liberação/configuração das credenciais no painel de e-mails corporativos.\n\n` +
              `Assim que o acesso for liberado, confirmaremos por aqui com as instruções de acesso!\n\n` +
              `Permanecemos à disposição!`;
            customResolutionSteps = [
              `[PB-UNI-38] Acessar o painel administrativo de e-mails corporativos da cooperativa (Webmail Seguro / Locaweb).`,
              `[PB-UNI-38] Localizar a conta departamental ${destEmail} e conceder a permissão de acesso / configurar a credencial para o colaborador ${beneficiaryName}.`,
              `[PB-UNI-38] Notificar o solicitante no chamado do GLPI com as orientações de acesso ao Webmail/Outlook.`
            ];
          }
          sufficiencyStatus = "completo";
          missingInfo = [];
        } else if (isSelf) {
          translatedIntent =
            `${solPrefix} **${formattedRequester}** (${sectorName}) solicita liberação de acesso ao módulo de **${specifiedAccessTxt}**` +
            (targetSector && targetSector.toLowerCase() !== sectorName.toLowerCase() ? ` para o setor **${targetSector}**` : "") +
            `. Todos os dados cadastrais (Nome e CPF) e a especificação do sistema foram devidamente informados no chamado.`;
          sufficiencyStatus = "completo";
          missingInfo = [];
          customPublicReply =
            `Olá, ${firstName}! Tudo bem?\n\n` +
            `Recebemos a sua solicitação de acesso ao **${specifiedAccessTxt}**` +
            (targetSector ? ` para o setor **${targetSector}**` : "") +
            `${targetUnit}.\n\n` +
            `Todas as informações necessárias já constam no chamado e nossa equipe de T.I. já iniciou a liberação do seu acesso. Assim que o perfil for configurado e liberado para uso, confirmaremos por aqui!\n\n` +
            `Permanecemos à disposição!`;
          customResolutionSteps = [
            `[PB-UNI-12] Localizar o cadastro de ${beneficiaryName} (${formFields.cpf ? `CPF: ${formFields.cpf}` : `usuário ${ticket.requester_login || firstName}`}) no sistema ${specifiedAccessTxt.includes("SPDATA") ? "SGH Spdata" : "correspondente"}.`,
            `[PB-UNI-12] Conceder e vincular as permissões do módulo de ${specifiedAccessTxt} para a unidade ${formFields.unidade || "Hospital Unimed"} (setor ${targetSector}).`,
            `[PB-UNI-12] Validar a ativação do perfil de acesso e notificar ${colabLabel} no chamado para teste e homologação.`
          ];
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
            `Todas as informações necessárias já constam no chamado e nossa equipe já iniciou a liberação. Assim que concluído, confirmaremos por aqui!\n\n` +
            `Permanecemos à disposição!`;
          customResolutionSteps = [
            `[PB-UNI-12] Localizar o cadastro do(a) profissional ${beneficiaryName} (${formFields.cpf ? `CPF: ${formFields.cpf}` : ""}) no sistema correspondente.`,
            `[PB-UNI-12] Efetuar a liberação das permissões solicitadas (${specifiedAccessTxt}) para o setor ${targetSector}.`,
            `[PB-UNI-12] Comunicar a conclusão no chamado GLPI.`
          ];
        }
      }
    } else if (
      (/\b(taxa|taxas)\b/i.test(normAll) &&
        /\b(excluir|exclus[aã]o|estornar|estorno|cancelar|cancelamento|retirar|remover|lan[çc]ad[ao]|equivocad)\b/i.test(
          normAll
        )) ||
      normAll.includes("taxa de registro")
    ) {
      const descText = formFields.descricao || ticket.content || "";
      const appName =
        formFields.aplicacao ||
        (/\bspdata\b/i.test(normAll) ? "SGH Spdata" : "SGH (Spdata)");

      const isMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor)\b/i.test(
        firstName
      );
      const solPrefix = isMale ? "O solicitante" : "A solicitante";

      const patientMatch =
        descText.match(/Nome do Paciente\s*:\s*([^\n\r]+)/i) ||
        descText.match(/Paciente\s*:\s*([^\n\r]+)/i);
      const patientName = patientMatch
        ? patientMatch[1].replace(/Prontu[aá]rio\s*:.*$/i, "").trim()
        : "";

      const regMatch =
        descText.match(/(?:registro|conta|atendimento|n[º°]?)\s*[:#-]?\s*(\d{3,12})/i) ||
        descText.match(/\b(\d{4,12})\b/);
      const recordNum = regMatch ? regMatch[1] : "";

      const prontMatch = descText.match(/Prontu[aá]rio\s*:\s*(\d+)/i);
      const prontNum = prontMatch ? prontMatch[1] : "";

      const taxaMatch =
        descText.match(/(taxa\s+(?:de\s+)?[^,.\n\r]+(?:\s*\(c[oó]digo\s*\d+\))?)/i) ||
        descText.match(/(taxa\s+[^,.\n\r]+)/i);
      let taxaDesc = taxaMatch ? taxaMatch[1].trim() : "taxa de registro ambulatorial (código 3028)";
      if (/favor verificar como excluir/i.test(taxaDesc)) {
        taxaDesc = taxaDesc.replace(/.*como excluir\s+/i, "");
      }

      detectedDomain = "Sistemas Internos / ERP / Sistemas Corporativos";
      suggestedCategory =
        ticket.category.includes("Solicitação Diversa") ||
        ticket.category.includes("Aplicativos") ||
        ticket.category.includes("Sistemas Operacionais")
          ? "T.I > ST > Resolução de Problemas > Sistemas Internos"
          : ticket.category;
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason =
        `Exclusão de taxa lançada indevidamente em conta hospitalar no módulo de Faturamento de Convênios do sistema ${appName} para continuidade da auditoria e faturamento.`;

      if (recordNum || patientName) {
        translatedIntent =
          `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a exclusão da **${taxaDesc}**, lançada equivocadamente em serviço Hospitalar na conta externa/registro **${recordNum}**` +
          (patientName
            ? ` (Paciente: **${patientName}**${prontNum ? `, Prontuário: **${prontNum}**` : ""})`
            : "") +
          ` no módulo de Faturamento de Convênios do sistema **${appName}**. Todos os dados necessários para localização da conta e exclusão do lançamento constam informados no chamado.`;
        sufficiencyStatus = "completo";
        missingInfo = [];

        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente à exclusão da **${taxaDesc}**, lançada indevidamente em serviço Hospitalar no módulo de Faturamento de Convênios do sistema **${appName}** (Conta Externa: Registro **${recordNum}**` +
          (patientName ? ` - **${patientName}**` : "") +
          (prontNum ? `, Prontuário: **${prontNum}**` : "") +
          `).\n\n` +
          `Todos os dados informados já foram validados na triagem técnica e nossa equipe já está verificando o procedimento para a exclusão/estorno do lançamento da taxa no sistema.\n\n` +
          `Assim que a taxa for excluída e a conta estiver liberada para continuidade dos trabalhos no ${sectorName}, confirmaremos por aqui!\n\n` +
          `Permanecemos à disposição!`;
      } else {
        translatedIntent =
          `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a exclusão de taxa no módulo de Faturamento de Convênios do sistema **${appName}**, ` +
          `porém sem informar o número do registro/conta ou o nome do(a) paciente.`;
        sufficiencyStatus = "incompleto";
        missingInfo = [
          `Informar o número do registro/conta externa e o nome do(a) paciente afetado no ${appName}`,
          "Informar o nome ou código da taxa a ser excluída/estornada",
        ];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente à exclusão de taxa no sistema **${appName}**.\n\n` +
          `Para localizarmos a conta e executarmos o estorno/exclusão, você poderia nos informar o **número do registro/conta externa**, o **nome do(a) paciente** e a **taxa/código** a ser excluída?\n\n` +
          `Assim que nos confirmar esses dados por aqui, realizamos o procedimento!`;
      }
    } else if (
      (/\b(hrp|federa[çc][ãa]o)\b/i.test(normAll) &&
        /\b(contrato|contratos|itau prestadores|prestador|prestadores)\b/i.test(normAll) &&
        /\b(erro|erros|dando erro|aparece este erro|salvar|chamado na federa[çc][ãa]o)\b/i.test(
          normAll
        )) ||
      (normAll.includes("hrp") &&
        normAll.includes("contratos") &&
        /\b(erro|salvar)\b/i.test(normAll))
    ) {
      const descText = formFields.descricao || ticket.content || "";
      const appName = formFields.aplicacao || "HRP Unimed";

      const isMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor)\b/i.test(
        firstName
      );
      const solPrefix = isMale ? "O solicitante" : "A solicitante";

      const contractMatch =
        descText.match(/\b(?:colocar|contrato|contratos)\s*([A-ZÀ-Úa-zà-ú0-9\s]+prestadores?)\b/i) ||
        descText.match(/\b(itau prestadores?)\b/i);
      const contractDesc = contractMatch
        ? contractMatch[1].trim()
        : "contratos de prestadores (Itau prestadores)";

      const allFollowupsTxt = (ticket.followups || [])
        .map((f) => f.content)
        .join(" ");
      const alreadyEscalatedFed =
        /\bfedera[çc][ãa]o\b/i.test(allFollowupsTxt) ||
        /\bvai abrir um chamado na federa[çc][ãa]o\b/i.test(
          normalizeText(allFollowupsTxt)
        );

      detectedDomain = "Sistemas Internos / ERP / Sistemas Corporativos";
      suggestedCategory =
        ticket.category.includes("Solicitação Diversa") ||
        ticket.category.includes("Aplicativos") ||
        ticket.category.includes("Sistemas Operacionais")
          ? "T.I > ST > Resolução de Problemas > Erros de Sistema"
          : ticket.category;
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason =
        `Inconsistência de sistema ao salvar contratos no cadastro de prestadores do ERP ${appName}, com acompanhamento de chamado junto à Federação.`;

      sufficiencyStatus = "completo";
      missingInfo = [];

      if (alreadyEscalatedFed) {
        translatedIntent =
          `${solPrefix} **${ticket.requester}** (${sectorName}) relata erro de sistema no **${appName}** ao salvar a aba de contratos (${contractDesc}) durante o cadastro de prestador, consultando sobre apoio da T.I ou abertura de chamado na Federação. ` +
          `Já foi alinhado que a colaboradora abrirá chamado junto ao suporte da Federação e retornará as informações neste chamado do GLPI para acompanhamento conjunto (chamado em status Pendente).`;
      } else {
        translatedIntent =
          `${solPrefix} **${ticket.requester}** (${sectorName}) relata erro de sistema no **${appName}** ao salvar a aba de contratos (${contractDesc}) durante o cadastro de prestador, consultando sobre apoio da T.I ou necessidade de abertura de chamado junto ao suporte da Federação. ` +
          `Demanda validação técnica da inconsistência e orientação para abertura de chamado federativo.`;
      }

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos o seu relato referente ao erro no sistema **${appName}** ao tentar salvar os contratos (**${contractDesc}**) no cadastro do prestador.\n\n` +
        `Como essa inconsistência na gravação de contratos envolve regras e tabelas do sistema geridas centralmente pela **Federação**, ficamos no aguardo do número de protocolo do chamado aberto junto ao suporte da **Federação** para que nossa equipe técnica possa acompanhar a resolução em conjunto por aqui.\n\n` +
        `O chamado permanecerá em acompanhamento (status Pendente) até a conclusão e retorno da Federação!\n\n` +
        `Permanecemos à disposição!`;
    } else if (
      !/\b(taxa|taxas)\b/i.test(normAll) &&
      (normAll.includes("cadastrada por engano") ||
        normAll.includes("cadastrado por engano") ||
        (/\b(cancelar|cancelamento|excluir|exclusao|estornar|inativar|remover)\b/i.test(
          normAll
        ) &&
          (normAll.includes("controle de contas") ||
            /\b(registro|conta|atendimento|guia)\b/i.test(normCore))))
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
      !/\bagenda\b/i.test(normAll) &&
      (/\b(indicadores|indicador|wconect|wconnect)\b/i.test(normAll) ||
        (/\b(extrair|extra[çc][ãa]o|levantamento|exportar|exporta[çc][ãa]o|puxar)\b/i.test(normAll) &&
          /\b(relat[oó]rios?|produtividade|dados de atendimentos?)\b/i.test(normAll)) ||
        (/\brelat[oó]rios?\b/i.test(normAll) &&
          /\b(produtividade|indicadores?)\b/i.test(normAll)))
    ) {
      const descOnly = formFields.descricao || "";
      const fullText = `${ticket.title || ""} ${descOnly}`;
      const sysName = /\bwconect|wconnect\b/i.test(normAll)
        ? "WConect"
        : /\b(s\.?g\.?h|spdata)\b/i.test(normAll)
        ? "S.G.H. (Spdata)"
        : /\bhrp\b/i.test(normAll)
        ? "HRP"
        : formFields.aplicacao || "sistema";

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
        /\bagenda\s+(?:pep\s+)?(?:d[aoes]\s+)?(?:(fisioterapeuta|m[ée]dic[oa]|dr\.?(?:a)?|nutricionista|psic[óo]log[oa]|terapeuta|enfermeir[oa]|profissional|colaborador(?:a|as|es)?)\s+)?([A-ZÀ-Ú][a-zà-ú]+(?:\s+(?:da|de|do|dos|das|e|[A-ZÀ-Ú][a-zà-ú]+)){1,4})/i
      );
      const profTitleMatch = (ticket.title || "").match(
        /\bagenda\s+(?:pep\s+)?(?:d[aoes]\s+)?(?:(fisioterapeuta|m[ée]dic[oa]|dr\.?(?:a)?|nutricionista|psic[óo]log[oa]|terapeuta|enfermeir[oa]|profissional|colaborador(?:a|as|es)?)\s+)?([A-ZÀ-Ú][a-zà-ú]+(?:\s+(?:da|de|do|dos|das|e|[A-ZÀ-Ú][a-zà-ú]+))*)/i
      );

      let profRole = profDescMatch?.[1] || profTitleMatch?.[1];
      profRole = profRole ? profRole.toLowerCase() : "profissional";

      let profName = "";
      if (profTitleMatch?.[2] && /\be\b/i.test(profTitleMatch[2])) {
        profName = profTitleMatch[2].trim();
      } else if (profDescMatch?.[2]) {
        profName = profDescMatch[2].replace(/\s*[,.;:].*$/, "").trim();
      } else if (profTitleMatch?.[2]) {
        profName = profTitleMatch[2].trim();
      }

      const isMultiple = /\be\b/i.test(profName);
      const isMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor|tarcisio)\b/i.test(
        firstName
      );
      const solPrefix = isMale ? "O solicitante" : "A solicitante";

      const hasTimeRange =
        /\b\d{1,2}\s*:\s*\d{2}\b/.test(descOnly) ||
        /\b\d{1,2}\s*h(?:oras|s)?\b/i.test(descOnly);
      const hasDurationOrInterval =
        /\b(atendimento\s+de|intervalo\s+de|dura[çc][ãa]o|minutos|min)\b/i.test(
          descOnly
        );

      const scheduleDetails = descOnly
        .replace(/^boa\s+(?:tarde|dia|noite)\s*[,!]?\s*/i, "")
        .replace(/\b(?:desde[, ]?\s*j[áa]\s*agrade[çc]o|obrigad[oa]|att|atenciosamente)\b[\s\S]*$/i, "")
        .replace(/\bsolicito\s+altera[çc][ãa]o\s+na\s+agenda\s+(?:pep\s+)?(?:d[aoes]\s+)?(?:colaborador[a-z]*\s+)?[^:\n]+:\s*/i, "")
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

      const roleAndName = isMultiple
        ? `das colaboradoras **${profName}**`
        : profRole && profRole !== "profissional"
        ? `d${profRole.endsWith("a") ? "a" : "o"} ${profRole} **${profName}**`
        : `do(a) profissional **${profName}**`;

      const agendaLabel = isMultiple ? "nas agendas" : "na agenda";
      const configLabel = isMultiple ? "das agendas" : "da agenda";

      if (profName && (hasTimeRange || hasDurationOrInterval)) {
        translatedIntent =
          `${solPrefix} **${ticket.requester}** (${sectorName}) solicita alteração ${agendaLabel} ${roleAndName} no sistema **${sysName}**, ` +
          `parametrizando os horários e intervalos de atendimento (${scheduleDetails}). ` +
          `Todas as informações necessárias (${isMultiple ? "profissionais, faixas de horário, duração dos atendimentos e intervalos" : "profissional, faixa de horário, duração do atendimento e intervalo"}) já foram informadas no relato.` +
          reclassNote;
        sufficiencyStatus = "completo";
        missingInfo = [];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação de alteração ${agendaLabel} ${roleAndName} no sistema **${sysName}**.\n\n` +
          `Todos os parâmetros informados (faixa de horário, tempo de atendimento e intervalo) já foram validados e nossa equipe técnica está realizando a configuração ${configLabel} no sistema.\n\n` +
          `Assim que a alteração estiver concluída e disponível no ${sysName}, confirmaremos por aqui!\n\n` +
          `Permanecemos à disposição!`;
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
      const isMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor|tarcisio)\b/i.test(
        firstName
      );
      const solPrefix = isMale ? "O solicitante" : "A solicitante";

      const sysName =
        formFields.aplicacao ||
        (/\bhrp\b/i.test(normAll)
          ? "HRP Unimed"
          : /\bpep\b/i.test(normAll)
          ? "PEP"
          : /\bsgh\b/i.test(normAll)
          ? "S.G.H."
          : "sistema");

      const isSupplyOrItem =
        /\b(insumo|insumos|material|materiais|medicamento|medicamentos|produto|produtos)\b/i.test(
          normAll
        );

      detectedDomain = "Sistemas Internos / ERP / Sistemas Corporativos";
      suggestedCategory = "T.I > BD > Administração de Banco de Dados";
      realUrgency = ticket.urgency_label || "Alta";

      const categoryMismatch =
        normalizeText(ticket.category || "") !==
        normalizeText(suggestedCategory);
      const reclassNote = categoryMismatch
        ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}").*`
        : "";

      if (isSupplyOrItem) {
        const itemMatch =
          descOnly.match(/insumo\s*[-:]?\s*(\d+)\s*(?:\(([^)]+)\))?/i) ||
          (ticket.title || "").match(/insumo\s*[-:]?\s*(\d+)\s*(?:\(([^)]+)\))?/i) ||
          descOnly.match(/(?:insumo|material|medicamento|item)\s*[-:]?\s*([^\n\r,]+)/i);

        const itemCode = itemMatch?.[1] ? itemMatch[1].trim() : "";
        const itemDesc = itemMatch?.[2] ? itemMatch[2].trim() : "";
        const itemFullLabel = itemDesc
          ? `do insumo ${itemCode} (${itemDesc})`
          : itemCode
          ? `do insumo ${itemCode}`
          : "do insumo informado";

        const chavesMatch = descOnly.match(
          /chave\s+(\d+)[^0-9]+para\s+a\s+chave\s+(\d+)/i
        );
        const originKey = chavesMatch?.[1] || "";
        const destKey = chavesMatch?.[2] || "";
        const hasItemKeys = Boolean(originKey && destKey) || /\b\d{6,}\b/.test(descOnly);

        urgencyReason = `Inconsistência cadastral por duplicidade de chaves do insumo no sistema ${sysName}, com impacto nas rotinas do Faturamento.`;

        if (hasItemKeys) {
          const keysDesc = originKey && destKey
            ? ` (unificação da chave de origem **${originKey}** para a chave principal **${destKey}**, na qual o cadastro está mais completo e deve prevalecer)`
            : "";

          translatedIntent =
            `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a **unificação de cadastro ${itemFullLabel}** no sistema **${sysName}**${keysDesc}, devido a inconsistência no sistema. ` +
            `Todos os dados necessários para o procedimento técnico no banco de dados constam informados no chamado.` +
            reclassNote;
          sufficiencyStatus = "completo";
          missingInfo = [];

          customPublicReply =
            `Olá, ${firstName}! Tudo bem?\n\n` +
            `Recebemos e analisamos a sua solicitação referente à **unificação de cadastro ${itemFullLabel}** no sistema **${sysName}**.\n\n` +
            (originKey && destKey
              ? `Os dados informados (unificação da chave **${originKey}** para a chave principal **${destKey}**) já foram validados na triagem técnica e nossa equipe técnica de Banco de Dados já iniciou o procedimento de unificação no sistema para resolução da inconsistência.\n\n`
              : `Os dados informados já foram validados na triagem técnica e nossa equipe de Banco de Dados já iniciou o procedimento de unificação no sistema.\n\n`) +
            `Assim que a unificação for concluída no ${sysName}, confirmaremos a finalização por aqui para a continuidade dos lançamentos no ${sectorName}!\n\n` +
            `Permanecemos à disposição!`;
        } else {
          translatedIntent =
            `Solicitação aberta por **${ticket.requester}** (${sectorName}) para unificação de cadastro ${itemFullLabel} no sistema **${sysName}**, pendente de especificação das chaves (chave de origem a ser unificada e chave principal de destino).` +
            reclassNote;
          sufficiencyStatus = "parcial";
          missingInfo = [
            `Informar os códigos das chaves do insumo (chave de origem a ser unificada e chave principal que deve prevalecer) no sistema ${sysName}`,
          ];
          customPublicReply =
            `Olá, ${firstName}! Tudo bem?\n\n` +
            `Recebemos a sua solicitação referente à unificação de cadastro ${itemFullLabel} no sistema **${sysName}**.\n\n` +
            `Para realizarmos o procedimento no banco de dados com segurança, você poderia nos informar os **códigos das chaves** (a chave que deve ser unificada e a chave principal que deve prevalecer)?\n\n` +
            `Assim que nos confirmar por aqui, já executamos a unificação!`;
        }
      } else {
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

        urgencyReason = `Duplicidade de cadastro no sistema ${sysName}, podendo gerar conflitos de histórico, faturamento ou atendimento do(a) ${personRole}.`;

        if (targetPerson || hasNumericKeys) {
          const whoLabel = targetPerson
            ? `d${personRole.endsWith("a") ? "a" : "o"} ${personRole} **${targetPerson}**`
            : "dos registros informados";
          const prevailTxt = prevailTarget
            ? `, mantendo o cadastro **${prevailTarget}** como principal`
            : "";

          translatedIntent =
            `${solPrefix} **${ticket.requester}** (${sectorName}) relatou que ${
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
          /\b(pep|sgh|spdata|wconect|benner|hrp|autolac|sistema|agenda|unidrive|nextcloud)\b/i.test(normAll)
        ) {
          smartCat = "T.I > ST > Instalação/Configuração > Aplicativos";
        }
      }

      suggestedCategory = smartCat;
      realUrgency = ticket.urgency_label;
      urgencyReason = "Classificação baseada no relato e impacto operacional informados pelo solicitante.";

      if (matchedMemory) {
        const isMemActionMismatch =
          (!/\b(unifica|unificar|unificacao|duplicad|duplicidade)\b/i.test(normAll) &&
            /\b(unifica|unificar|unificacao|duplicad|duplicidade)\b/i.test(
              normalizeText(`${matchedMemory.title || ""} ${matchedMemory.summary || ""}`)
            )) ||
          ((/\b(unidrive|uni\s*drive)\b/i.test(normAll) ||
            (/\bnextcloud\b/i.test(normAll) && /\b(instalar|instala[çc][ãa]o|trocou o computador|computador novo)\b/i.test(normAll))) &&
           !/\b(instalar|instala[çc][ãa]o|unidrive)\b/i.test(
             normalizeText(`${matchedMemory.title || ""} ${matchedMemory.summary || ""}`)
           )) ||
          ((/\b(prontu[aá]rio\s+do\s+hospital|prontu[aá]rio\s+hospitalar|spdata|sgh\s+spdata|pep\s+hospitalar)\b/i.test(normAll) ||
            (/\bprontu[aá]rio\b/i.test(normAll) && /\bhospital\b/i.test(normAll))) &&
           !/\b(prontu[aá]rio|spdata|pep\s+hospitalar)\b/i.test(
             normalizeText(`${matchedMemory.title || ""} ${matchedMemory.summary || ""}`)
           )) ||
          (/\b(taxa|taxas)\b/i.test(normAll) &&
            !/\b(taxa|taxas)\b/i.test(
              normalizeText(`${matchedMemory.title || ""} ${matchedMemory.summary || ""}`)
            )) ||
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
            )) ||
          (!normAll.includes("controle de contas") &&
            /\b(controle de contas|data da alta|data de alta|1411181)\b/i.test(
              normalizeText(`${matchedMemory.title || ""} ${matchedMemory.summary || ""}`)
            )) ||
          (/\b(google\s*meet|meet|teams|zoom|videoconfer[eê]ncia|reuni[aã]o\s+online|link\s+(?:d[ea]|para)\s+reuni[aã]o|link\s+no\s+meet)\b/i.test(normAll) &&
            !/\b(google\s*meet|meet|teams|zoom|videoconfer[eê]ncia|reuni[aã]o)\b/i.test(
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
    if (customResolutionSteps && customResolutionSteps.length > 0) {
      resolutionSteps.push(...customResolutionSteps);
    } else {
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
        (!/\b(unifica|unificar|unificacao|duplicad|duplicidade)\b/i.test(normAll) &&
          /\b(unifica|unificar|unificacao|duplicad|duplicidade)\b/i.test(
            normalizeText(`${matchedMemory.title || ""} ${matchedMemory.summary || ""}`)
          )) ||
        ((/\b(unidrive|uni\s*drive)\b/i.test(normAll) ||
          (/\bnextcloud\b/i.test(normAll) && /\b(instalar|instala[çc][ãa]o|trocou o computador|computador novo)\b/i.test(normAll))) &&
         !/\b(instalar|instala[çc][ãa]o|unidrive)\b/i.test(
           normalizeText(`${matchedMemory.title || ""} ${matchedMemory.summary || ""}`)
         )) ||
        ((/\b(prontu[aá]rio\s+do\s+hospital|prontu[aá]rio\s+hospitalar|spdata|sgh\s+spdata|pep\s+hospitalar)\b/i.test(normAll) ||
          (/\bprontu[aá]rio\b/i.test(normAll) && /\bhospital\b/i.test(normAll))) &&
         !/\b(prontu[aá]rio|spdata|pep\s+hospitalar)\b/i.test(
           normalizeText(`${matchedMemory.title || ""} ${matchedMemory.summary || ""}`)
         )) ||
        (/\b(taxa|taxas)\b/i.test(normAll) &&
          !/\b(taxa|taxas)\b/i.test(
            normalizeText(`${matchedMemory.title || ""} ${matchedMemory.summary || ""}`)
          )) ||
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
          )) ||
        (!normAll.includes("controle de contas") &&
          /\b(controle de contas|data da alta|data de alta|1411181)\b/i.test(
            normalizeText(`${matchedMemory.title || ""} ${matchedMemory.summary || ""}`)
          )) ||
        (/\b(google\s*meet|meet|teams|zoom|videoconfer[eê]ncia|reuni[aã]o\s+online|link\s+(?:d[ea]|para)\s+reuni[aã]o|link\s+no\s+meet)\b/i.test(normAll) &&
          !/\b(google\s*meet|meet|teams|zoom|videoconfer[eê]ncia|reuni[aã]o)\b/i.test(
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
