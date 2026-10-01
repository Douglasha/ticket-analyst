import path from "node:path";
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
import { AIAnalyst } from "./aiAnalyst.js";
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
        category: ticket.category,
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

// Serve a interface principal sem cache para refletir atualizações imediatamente
app.get("/", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.sendFile(path.join(STATIC_DIR, "index.html"));
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(
    `GLPI Ticket Analyst (Node.js) rodando em http://localhost:${PORT}`
  );
});
