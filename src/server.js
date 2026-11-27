import path from "node:path";
import os from "node:os";
import express from "express";
import cors from "cors";

import {
  STATIC_DIR,
  loadAnalysesCache,
  loadLearnedFeedback,
  loadSettings,
  saveAnalysisToCache,
  saveLearnedFeedbackEntry,
  saveSettings,
} from "./config.js";
import { GLPIClient } from "./glpiClient.js";
import {
  KnowledgeEngine,
  extractFormCreatorFields,
  extractTokens,
  loadPlaybooks,
  savePlaybooks,
} from "./knowledgeEngine.js";
import { AIAnalyst, getOllamaRunningProcessInfo } from "./aiAnalyst.js";
import { runRegressionTests } from "../scripts/test_playbook_regressions.js";
import {
  COOKIE_NAME,
  authenticateUser,
  createSessionToken,
  extractUserFromRequest,
  requireAuth,
} from "./auth.js";

const app = express();
const PORT = Number(process.env.PORT || 8000);

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(
  "/static",
  express.static(STATIC_DIR, {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    },
  })
);

// ====================================================================
// ROTAS DE AUTENTICAÇÃO (LOGIN GLPI + ADMIN LOCAL DE CONTINGÊNCIA)
// ====================================================================
app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const settings = loadSettings();
    const result = await authenticateUser(username, password, settings);

    if (!result.ok) {
      return res.status(result.status || 401).json({
        ok: false,
        detail: result.message,
      });
    }

    const secret = settings.auth_secret || "ticket-analyst-unimed-secret-key-2026";
    const token = createSessionToken(result.user, secret);

    res.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
        12 * 3600
      }`
    );

    res.json({
      ok: true,
      token,
      user: result.user,
    });
  } catch (err) {
    res.status(500).json({ ok: false, detail: err.message });
  }
});

app.post("/api/auth/logout", (_req, res) => {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const user = extractUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ authenticated: false });
  }
  res.json({ authenticated: true, user });
});

// Protege todas as demais rotas /api/* com autenticação obrigatória
app.use("/api", requireAuth);

// Lista chamados filtrados por grupo, status e busca textual
app.get("/api/tickets", async (req, res) => {
  try {
    const settings = loadSettings();
    const client = new GLPIClient(settings);
    const cache = loadAnalysesCache();

    const allTickets = await client.listTickets();
    const groups = Array.from(
      new Set(allTickets.map((t) => t.assigned_group).filter(Boolean))
    ).sort();

    let filtered = allTickets;
    const groupFilter = req.query.group || null;
    const statusFilter = req.query.status ? Number(req.query.status) : null;
    const searchQuery = req.query.q || null;

    if (groupFilter && !["todos", "all", ""].includes(groupFilter.toLowerCase())) {
      const gf = groupFilter.toLowerCase();
      filtered = filtered.filter((t) =>
        (t.assigned_group || "").toLowerCase().includes(gf)
      );
    }
    if (statusFilter && statusFilter > 0) {
      filtered = filtered.filter((t) => t.status_id === statusFilter);
    }
    if (searchQuery && searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      filtered = filtered.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.content.toLowerCase().includes(q) ||
          t.requester.toLowerCase().includes(q) ||
          t.category.toLowerCase().includes(q) ||
          String(t.id) === q
      );
    }

    const analysesMap = {};
    for (const t of filtered) {
      const key = String(t.id);
      if (cache[key]) {
        t.has_analysis = true;
        analysesMap[key] = cache[key];
      }
    }

    res.json({
      mode: settings.glpi_demo_mode ? "demo" : "production",
      groups,
      tickets: filtered,
      analyses: analysesMap,
    });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// Detalhe de um chamado específico
app.get("/api/tickets/:ticketId", async (req, res) => {
  try {
    const ticketId = Number(req.params.ticketId);
    const settings = loadSettings();
    const client = new GLPIClient(settings);
    const ticket = await client.getTicket(ticketId);
    if (!ticket) {
      return res
        .status(404)
        .json({ detail: `Chamado #${ticketId} não encontrado.` });
    }

    const cache = loadAnalysesCache();
    const analysis = cache[String(ticketId)] || null;
    if (analysis) {
      ticket.has_analysis = true;
    }

    res.json({ ticket, analysis });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// Download ou visualização de anexo/imagem de um chamado
app.get("/api/tickets/:ticketId/documents/:docId", async (req, res) => {
  try {
    const docId = Number(req.params.docId);
    const settings = loadSettings();
    const client = new GLPIClient(settings);
    const doc = await client.downloadDocument(docId);
    if (!doc || !doc.buffer) {
      return res.status(404).send("Documento não encontrado");
    }
    res.setHeader("Content-Type", doc.mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(doc.filename)}"`);
    res.send(doc.buffer);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Analisa todos os chamados visíveis em lote
app.post("/api/tickets/analyze-batch", async (req, res) => {
  try {
    const ticketIds = Array.isArray(req.body) ? req.body : [];
    const settings = loadSettings();
    const client = new GLPIClient(settings);
    const kbEngine = new KnowledgeEngine(client);
    const analyst = new AIAnalyst(settings);

    const allOpen = await client.listTickets();
    const openMap = new Map(allOpen.map((t) => [Number(t.id), t]));

    const results = {};
    for (const rawId of ticketIds) {
      const tid = Number(rawId);
      const ticket = openMap.get(tid) || (await client.getTicket(tid));
      if (!ticket) continue;
      const matches = await kbEngine.searchAllLayers(ticket, 4);
      const analysis = await analyst.analyzeTicket(ticket, matches);
      saveAnalysisToCache(analysis);
      results[String(tid)] = analysis;
    }

    res.json({
      analyzed_count: Object.keys(results).length,
      analyses: results,
    });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// Analisa um chamado individual usando as 3 camadas + IA
app.post("/api/tickets/:ticketId/analyze", async (req, res) => {
  try {
    const ticketId = Number(req.params.ticketId);
    const forceRefresh = Boolean(req.body?.force_refresh);
    const customInstruction = req.body?.custom_instruction || null;

    const settings = loadSettings();
    const client = new GLPIClient(settings);
    const ticket = await client.getTicket(ticketId);
    if (!ticket) {
      return res
        .status(404)
        .json({ detail: `Chamado #${ticketId} não encontrado.` });
    }

    const cache = loadAnalysesCache();
    if (!forceRefresh && !customInstruction && cache[String(ticketId)]) {
      return res.json({ analysis: cache[String(ticketId)], cached: true });
    }

    const kbEngine = new KnowledgeEngine(client);
    const matches = await kbEngine.searchAllLayers(ticket, 4);

    const analyst = new AIAnalyst(settings);
    const analysis = await analyst.analyzeTicket(
      ticket,
      matches,
      customInstruction
    );
    saveAnalysisToCache(analysis);

    if (customInstruction) {
      const formFields = extractFormCreatorFields(ticket.content);
      const cleanTitle = ticket.title.includes(">")
        ? ticket.title.split(">").slice(-2).join(" - ").trim()
        : ticket.title;
      const firstName = (ticket.requester_first_name || ticket.requester || "")
        .trim()
        .split(/\s+/)[0];
      const replyTpl = firstName
        ? (analysis.public_reply_draft || "").replace(
            new RegExp(`\\b${firstName}\\b`, "gi"),
            "{solicitante}"
          )
        : analysis.public_reply_draft || "";

      saveLearnedFeedbackEntry({
        ticket_id: ticketId,
        title: cleanTitle,
        category: analysis.suggested_category || ticket.category,
        keywords: extractTokens(
          `${cleanTitle} ${formFields.tipo} ${formFields.problema} ${formFields.aplicacao} ${formFields.descricao}`
        ).slice(0, 8),
        problem_summary: formFields.descricao || ticket.title,
        custom_instruction: customInstruction,
        reply_template: replyTpl,
        required_info: analysis.missing_info || [],
        resolution_steps: analysis.resolution_steps || [],
        sufficiency_status: analysis.sufficiency_status || "parcial",
      });
    }

    res.json({ analysis, cached: false });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// Envia Acompanhamento Público ou Nota Privada para o GLPI
app.post("/api/tickets/:ticketId/followup", async (req, res) => {
  try {
    const ticketId = Number(req.params.ticketId);
    const content = String(req.body?.content || "").trim();
    const isPrivate = Boolean(req.body?.is_private);
    const markPending = Boolean(req.body?.mark_pending);
    const ticketMeta = req.body?.ticket_meta || null;

    if (!content) {
      return res
        .status(400)
        .json({ detail: "O conteúdo do acompanhamento não pode estar vazio." });
    }

    const settings = loadSettings();
    const client = new GLPIClient(settings);
    const result = await client.addFollowup(
      ticketId,
      content,
      isPrivate,
      markPending
    );

    // Aprendizado Contínuo: grava como o analista respondeu a este tipo de chamado
    if (!isPrivate) {
      const cache = loadAnalysesCache();
      const cachedAnalysis = cache[String(ticketId)] || {};
      const titleRaw = ticketMeta?.title || `Chamado #${ticketId}`;
      const cleanTitle = titleRaw.includes(">")
        ? titleRaw.split(">").slice(-2).join(" - ").trim()
        : titleRaw;
      const firstName = (ticketMeta?.requester_first_name || "")
        .trim()
        .split(/\s+/)[0];
      const replyTpl =
        firstName && firstName.length >= 2
          ? content.replace(new RegExp(`\\b${firstName}\\b`, "gi"), "{solicitante}")
          : content;
      const formFields = extractFormCreatorFields(ticketMeta?.content || "");

      const extractedQuestions = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^(\d+\.|[-•*])\s+/.test(l))
        .map((l) => l.replace(/^(\d+\.|[-•*])\s+/, "").replace(/\*\*/g, "").trim());

      const learnedSufficiency =
        markPending || extractedQuestions.length > 0 ? "parcial" : "completo";

      saveLearnedFeedbackEntry({
        ticket_id: ticketId,
        title: cleanTitle,
        category: ticketMeta?.category || cachedAnalysis.suggested_category || "Aprendizado Contínuo",
        keywords: extractTokens(
          `${cleanTitle} ${formFields.tipo} ${formFields.problema} ${formFields.aplicacao} ${formFields.descricao}`
        ).slice(0, 8),
        problem_summary: formFields.descricao || cleanTitle,
        reply_template: replyTpl,
        required_info:
          extractedQuestions.length > 0
            ? extractedQuestions
            : learnedSufficiency === "completo"
            ? []
            : cachedAnalysis.missing_info || [],
        resolution_steps: cachedAnalysis.resolution_steps || [],
        sufficiency_status: learnedSufficiency,
      });

      if (cache[String(ticketId)]) {
        cache[String(ticketId)].public_reply_draft = content;
        saveAnalysisToCache(cache[String(ticketId)]);
      }
    }

    res.json({
      ok: result.ok,
      message: result.message,
      followup: result.followup,
      status_id: result.status_id,
      status_label: result.status_label,
    });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// Lista as Categorias ITIL do GLPI para Reclassificação
app.get("/api/glpi/categories", async (_req, res) => {
  try {
    const settings = loadSettings();
    const client = new GLPIClient(settings);
    const categories = await client.fetchCategories();
    res.json({ categories });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// Atualiza a Categoria do Chamado no GLPI
app.put("/api/tickets/:ticketId/category", async (req, res) => {
  try {
    const ticketId = Number(req.params.ticketId);
    const categoryId = Number(req.body?.category_id);
    const categoryName = String(req.body?.category_name || "").trim();

    if (!ticketId || !categoryId) {
      return res
        .status(400)
        .json({ detail: "Informe o ID do chamado e o ID da categoria." });
    }

    const settings = loadSettings();
    const client = new GLPIClient(settings);
    const result = await client.updateTicketCategory(
      ticketId,
      categoryId,
      categoryName
    );

    const cache = loadAnalysesCache();
    if (cache[String(ticketId)]) {
      cache[String(ticketId)].suggested_category =
        result.category || cache[String(ticketId)].suggested_category;
      saveAnalysisToCache(cache[String(ticketId)]);
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// Lista as 3 Camadas de Conhecimento
app.get("/api/knowledge", async (_req, res) => {
  try {
    const settings = loadSettings();
    const client = new GLPIClient(settings);
    const kbArticles = await client.fetchKbArticles();
    const resolvedHistory = await client.fetchResolvedHistory();
    const playbooks = loadPlaybooks();
    const learnedFeedback = loadLearnedFeedback();

    res.json({
      layer1_glpi_kb: kbArticles,
      layer2_glpi_history: resolvedHistory,
      layer3_local_playbooks: playbooks,
      learned_feedback: learnedFeedback,
    });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// Proxy autenticado de imagens/documentos da Base de Conhecimento do GLPI
app.get("/api/glpi/documents/:docId/media", async (req, res) => {
  try {
    const docId = Number(req.params.docId);
    const settings = loadSettings();
    const client = new GLPIClient(settings);
    const media = await client.downloadDocumentMedia(docId);
    if (!media) {
      return res.status(404).send("Documento não encontrado no GLPI.");
    }
    res.setHeader("Content-Type", media.contentType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(media.buffer);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Cria ou atualiza um Playbook Local (3ª Camada)
app.post("/api/playbooks", (req, res) => {
  try {
    const item = req.body;
    const playbooks = loadPlaybooks();
    const idx = playbooks.findIndex((p) => p.id === item.id);
    if (idx !== -1) {
      playbooks[idx] = item;
    } else {
      playbooks.unshift(item);
    }
    savePlaybooks(playbooks);
    res.json({
      ok: true,
      message: `Playbook '${item.title}' salvo com sucesso!`,
      playbooks,
    });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// Remove um Playbook Local
app.delete("/api/playbooks/:playbookId", (req, res) => {
  try {
    const pbId = req.params.playbookId;
    const playbooks = loadPlaybooks().filter((p) => p.id !== pbId);
    savePlaybooks(playbooks);
    res.json({
      ok: true,
      message: `Playbook ${pbId} removido.`,
      playbooks,
    });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// Obtém configurações atuais
app.get("/api/settings", (_req, res) => {
  res.json(loadSettings());
});

// Atualiza configurações
app.put("/api/settings", (req, res) => {
  try {
    const saved = saveSettings(req.body || {});
    res.json({
      ok: true,
      message: "Configurações salvas com sucesso!",
      settings: saved,
    });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// Testa conexão com a API REST do GLPI
app.post("/api/settings/test-glpi", async (req, res) => {
  try {
    const settings =
      req.body && Object.keys(req.body).length > 0
        ? { ...loadSettings(), ...req.body }
        : loadSettings();
    const client = new GLPIClient(settings);
    const status = await client.testConnection();
    res.json(status);
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ====================================================================
// TELEMETRIA E RECURSOS DO SISTEMA / LLMS EM TEMPO REAL
// ====================================================================
app.get("/api/system/telemetry", async (_req, res) => {
  try {
    const settings = loadSettings();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const procMem = process.memoryUsage();

    let ollamaInfo = null;
    if (settings.ai_provider === "ollama") {
      ollamaInfo = await getOllamaRunningProcessInfo(settings.ollama_base_url);
    }

    res.json({
      timestamp: Date.now(),
      platform: os.platform(),
      system_ram: {
        total_gb: Number((totalMem / 1e9).toFixed(1)),
        free_gb: Number((freeMem / 1e9).toFixed(1)),
        used_gb: Number((usedMem / 1e9).toFixed(1)),
        used_pct: Math.round((usedMem / totalMem) * 100),
      },
      host_memory: {
        total_gb: Number((totalMem / 1e9).toFixed(1)),
        free_gb: Number((freeMem / 1e9).toFixed(1)),
        used_gb: Number((usedMem / 1e9).toFixed(1)),
        usage_percent: Math.round((usedMem / totalMem) * 100),
      },
      process_memory: {
        rss_mb: Math.round(procMem.rss / (1024 * 1024)),
        heap_used_mb: Math.round(procMem.heapUsed / (1024 * 1024)),
      },
      node_process_memory: {
        rss_mb: Math.round(procMem.rss / (1024 * 1024)),
        heap_used_mb: Math.round(procMem.heapUsed / (1024 * 1024)),
      },
      provider: settings.ai_provider,
      active_provider: settings.ai_provider,
      model: settings.ai_provider === "ollama" ? settings.ollama_model : (settings.ai_provider === "gemini" ? settings.gemini_model : settings.openai_model),
      ollama: ollamaInfo || { model: null, size_mb: 0, size_vram_mb: 0 },
      ollama_model: ollamaInfo?.model ? {
        name: ollamaInfo.model,
        size_mb: ollamaInfo.size_mb,
        size_vram_mb: ollamaInfo.size_vram_mb,
      } : null,
    });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// ====================================================================
// DETECÇÃO E AGRUPAMENTO DE INCIDENTES EM MASSA (CLUSTERING)
// ====================================================================
function detectIncidentClusters(tickets = [], analyses = {}) {
  const clustersDef = [
    {
      id: "cluster_wconect",
      name: "Instabilidade no WConect WhatsApp",
      icon: "chat",
      severity: "high",
      regex: /\b(wconect|wconnect|disparo\s+whatsapp|mensagens?\s+wpp|mensageria)\b/i,
    },
    {
      id: "cluster_network",
      name: "Queda ou Instabilidade de Rede / Conectividade Wi-Fi",
      icon: "wifi_off",
      severity: "high",
      regex: /\b(internet|wi-?fi|wifi|sem\s+rede|queda\s+de\s+link|sem\s+conex[aã]o|roteador|access\s+point)\b/i,
    },
    {
      id: "cluster_voip",
      name: "Telefonia / Ramais VoIP Inoperantes",
      icon: "phone_disabled",
      severity: "medium",
      regex: /\b(telefone\s+mudo|ramal\s+sem\s+sinal|telefone\s+sem\s+sinal|pabx|linha\s+muda|trocar\s+ramal)\b/i,
    },
    {
      id: "cluster_hrp",
      name: "ERP HRP Unimed / Guias e Autorizações de Intercâmbio",
      icon: "local_hospital",
      severity: "high",
      regex: /\b(hrp|guia\s+de\s+autoriza|senha\s+de\s+autoriza|interc[aâ]mbio|ptu|wautoriza|car[aá]ter\s+de\s+atendimento)\b/i,
    },
    {
      id: "cluster_spdata",
      name: "SGH Spdata / Faturamento e Tabelas",
      icon: "table_chart",
      severity: "medium",
      regex: /\b(spdata|sgh|tuss|di[aá]rias,\s*taxas\s+e\s+gases|00952|ipsm|ipsmmg)\b/i,
    },
    {
      id: "cluster_printers",
      name: "Impressoras / Periféricos e Suprimentos",
      icon: "print",
      severity: "low",
      regex: /\b(impressora|toner|recarga|tinta|etiquetas?\s+de\s+impress[aã]o|zebra)\b/i,
    },
    {
      id: "cluster_nextcloud",
      name: "Nextcloud / Unidrive / Conflito de Pastas",
      icon: "cloud_sync",
      severity: "medium",
      regex: /\b(nextcloud|unidrive|sincroniza[çc][ãa]o|pasta\s+g|pasta\s+h)\b/i,
    },
  ];

  const detected = [];
  for (const c of clustersDef) {
    const matchingTickets = [];
    const depts = new Set();

    for (const t of tickets) {
      const text = `${t.title || ""} ${t.content || ""} ${t.category || ""}`;
      if (c.regex.test(text)) {
        matchingTickets.push({
          id: t.id,
          title: t.title,
          requester: t.requester,
          department: t.requester_department || "Setor",
        });
        if (t.requester_department) {
          depts.add(t.requester_department);
        }
      }
    }

    if (matchingTickets.length >= 2) {
      detected.push({
        id: c.id,
        name: c.name,
        icon: c.icon,
        severity: c.severity,
        count: matchingTickets.length,
        ticket_ids: matchingTickets.map((m) => m.id),
        tickets: matchingTickets,
        departments: Array.from(depts),
        description: `${matchingTickets.length} chamados correlacionados detectados nos setores: ${Array.from(depts).join(", ") || "diversos"}.`,
      });
    }
  }

  return detected;
}

app.get("/api/tickets/incident-clusters", async (_req, res) => {
  try {
    const settings = loadSettings();
    const client = new GLPIClient(settings);
    const tickets = await client.listTickets();
    const cache = loadAnalysesCache();
    const clusters = detectIncidentClusters(tickets, cache);
    res.json({ clusters, total_clusters: clusters.length });
  } catch (err) {
    res.status(500).json({ detail: err.message, clusters: [] });
  }
});

// ====================================================================
// TRIAGEM AUTOMÁTICA EM SEGUNDO PLANO (BACKGROUND AUTO-TRIAGE)
// ====================================================================
const autoTriageState = {
  enabled: false,
  timerId: null,
  lastRun: null,
  lastCount: 0,
  totalAnalyzed: 0,
};

async function executeAutoTriageRun() {
  if (!autoTriageState.enabled) return;
  try {
    const settings = loadSettings();
    const client = new GLPIClient(settings);
    const kbEngine = new KnowledgeEngine(client);
    const analyst = new AIAnalyst(settings);

    const openTickets = await client.listTickets();
    const cache = loadAnalysesCache();
    let analyzedThisRun = 0;

    for (const ticket of openTickets) {
      if (!cache[String(ticket.id)]) {
        const matches = await kbEngine.searchAllLayers(ticket, 4);
        const analysis = await analyst.analyzeTicket(ticket, matches);
        saveAnalysisToCache(analysis);
        analyzedThisRun += 1;
        autoTriageState.totalAnalyzed += 1;
      }
    }

    autoTriageState.lastRun = new Date().toISOString();
    autoTriageState.lastCount = analyzedThisRun;
    if (analyzedThisRun > 0) {
      console.log(`[AutoTriage] Triagem em segundo plano analisou ${analyzedThisRun} novos chamados.`);
    }
  } catch (err) {
    console.error("[AutoTriage] Erro na execução da auto-triagem:", err.message);
  }
}

app.get("/api/system/auto-triage/status", (_req, res) => {
  res.json({
    enabled: autoTriageState.enabled,
    last_run: autoTriageState.lastRun,
    last_count: autoTriageState.lastCount,
    total_auto_analyzed: autoTriageState.totalAnalyzed,
  });
});

app.post("/api/system/auto-triage/toggle", async (req, res) => {
  const desired = typeof req.body?.enabled === "boolean" ? req.body.enabled : !autoTriageState.enabled;
  autoTriageState.enabled = desired;

  if (autoTriageState.enabled) {
    if (autoTriageState.timerId) clearInterval(autoTriageState.timerId);
    executeAutoTriageRun();
    autoTriageState.timerId = setInterval(executeAutoTriageRun, 180000); // a cada 3 minutos
  } else {
    if (autoTriageState.timerId) {
      clearInterval(autoTriageState.timerId);
      autoTriageState.timerId = null;
    }
  }

  res.json({
    ok: true,
    enabled: autoTriageState.enabled,
    message: autoTriageState.enabled
      ? "Auto-triagem em segundo plano ATIVADA (executa a cada 3 min)."
      : "Auto-triagem em segundo plano DESATIVADA.",
  });
});

// ====================================================================
// TESTES DE REGRESSÃO HEURÍSTICA VIA API
// ====================================================================
app.get("/api/system/test-regressions", async (_req, res) => {
  try {
    const report = await runRegressionTests();
    res.json(report);
  } catch (err) {
    res.status(500).json({ detail: err.message, all_passed: false });
  }
});

// Serve a interface principal sem cache para refletir atualizações imediatamente
app.get("/", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.sendFile(path.join(STATIC_DIR, "index.html"));
});

const HOST = process.env.HOST || "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(
    `GLPI Ticket Analyst (Node.js) rodando em http://${HOST}:${PORT}`
  );
});
