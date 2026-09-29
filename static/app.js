let state = {
  user: null,
  tickets: [],
  analyses: {},
  groups: [],
  selectedTicketId: null,
  activeDraftMode: "public", // 'public' | 'private'
  knowledge: {
    layer1_glpi_kb: [],
    layer2_glpi_history: [],
    layer3_local_playbooks: [],
  },
  glpiCategories: [],
  dismissedCategoryTickets: {},
  settings: null,
};

let searchTimeout = null;

async function apiFetch(url, options = {}) {
  const token = localStorage.getItem("ta_auth_token");
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(url, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  if (res.status === 401 && !url.startsWith("/api/auth/")) {
    showLoginScreen();
    throw new Error("Sessão expirada. Faça login novamente.");
  }
  return res;
}

document.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  await checkAuthStatus();
  // Sincroniza a fila automaticamente a cada 60s para remover chamados solucionados/fechados no GLPI
  setInterval(() => {
    if (state.user && !document.getElementById("tab-triage")?.classList.contains("hidden")) {
      loadTickets(false);
    }
  }, 60000);
});

async function checkAuthStatus() {
  try {
    const res = await apiFetch("/api/auth/me");
    if (!res.ok) {
      showLoginScreen();
      return;
    }
    const data = await res.json();
    if (data.authenticated && data.user) {
      applyAuthenticatedUser(data.user);
      hideLoginScreen();
      await loadSettingsData();
      await loadTickets(true);
    } else {
      showLoginScreen();
    }
  } catch {
    showLoginScreen();
  }
}

function showLoginScreen() {
  const screen = document.getElementById("login-screen");
  if (screen) screen.classList.remove("hidden");
  const userInput = document.getElementById("login-username");
  if (userInput) setTimeout(() => userInput.focus(), 50);
}

function hideLoginScreen() {
  const screen = document.getElementById("login-screen");
  if (screen) screen.classList.add("hidden");
}

function applyAuthenticatedUser(user) {
  state.user = user;
  const nameEl = document.getElementById("sidebar-user-name");
  const roleEl = document.getElementById("sidebar-user-role");
  const avatarEl = document.getElementById("sidebar-user-avatar");

  const displayName = user.fullName || user.username || "Analista T.I.";
  if (nameEl) nameEl.textContent = displayName;
  if (roleEl) roleEl.textContent = user.role || "Analista T.I.";
  if (avatarEl) {
    const parts = displayName.trim().split(/\s+/);
    const initials =
      parts.length >= 2
        ? `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
        : displayName.slice(0, 2).toUpperCase();
    avatarEl.textContent = initials;
  }
}

function toggleLoginPasswordVisibility() {
  const input = document.getElementById("login-password");
  const icon = document.getElementById("login-pass-icon");
  if (!input) return;
  if (input.type === "password") {
    input.type = "text";
    if (icon) icon.textContent = "visibility_off";
  } else {
    input.type = "password";
    if (icon) icon.textContent = "visibility";
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;
  const errBox = document.getElementById("login-error");
  const errText = document.getElementById("login-error-text");
  const btn = document.getElementById("btn-login-submit");

  errBox.classList.add("hidden");
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="material-symbols-outlined icon-sm animate-spin-slow">progress_activity</span><span>Autenticando no GLPI...</span>`;

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      errText.textContent = data.detail || "Falha na autenticação.";
      errBox.classList.remove("hidden");
      return;
    }

    if (data.token) {
      localStorage.setItem("ta_auth_token", data.token);
    }

    document.getElementById("login-password").value = "";
    applyAuthenticatedUser(data.user);
    hideLoginScreen();
    showToast(`Bem-vindo(a), ${data.user.firstName || data.user.fullName}!`);

    await loadSettingsData();
    await loadTickets(true);
  } catch (err) {
    errText.textContent = "Erro ao conectar ao servidor: " + err.message;
    errBox.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHtml;
  }
}

async function logoutUser() {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } catch {
    // ignora erro
  }
  localStorage.removeItem("ta_auth_token");
  state.user = null;
  state.tickets = [];
  showLoginScreen();
  showToast("Sessão encerrada com segurança.", "info");
}

function initTheme() {
  const savedTheme = localStorage.getItem("ticket_analyst_theme_v2") || "light";
  applyTheme(savedTheme);
}

function toggleTheme() {
  const isDark = document.documentElement.classList.contains("dark");
  const next = isDark ? "light" : "dark";
  localStorage.setItem("ticket_analyst_theme_v2", next);
  applyTheme(next);
}

function applyTheme(theme) {
  const iconEl = document.getElementById("theme-icon");
  const labelEl = document.getElementById("theme-label");
  const metaScheme = document.getElementById("meta-color-scheme");
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
    document.documentElement.style.colorScheme = "dark";
    if (metaScheme) metaScheme.setAttribute("content", "dark");
    if (iconEl) iconEl.textContent = "light_mode";
    if (labelEl) labelEl.textContent = "Claro";
  } else {
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "only light";
    if (metaScheme) metaScheme.setAttribute("content", "only light");
    document.querySelectorAll("style.darkreader").forEach((el) => el.remove());
    if (iconEl) iconEl.textContent = "dark_mode";
    if (labelEl) labelEl.textContent = "Escuro";
  }
}

function showToast(message, type = "success") {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  const colors =
    type === "error"
      ? "bg-[#dc2626] text-white border-red-700"
      : type === "info"
      ? "bg-[#01473e] text-white border-teal-800"
      : "bg-[#0f4c43] text-white border-teal-800";

  const iconName =
    type === "error" ? "error" : type === "info" ? "info" : "check_circle";

  el.className = `flex items-center gap-2 px-4 py-2.5 rounded-xl border text-xs font-medium shadow-lg transition-all ${colors}`;
  el.innerHTML = `
    <span class="material-symbols-outlined icon-sm text-emerald-300">${iconName}</span>
    <span>${escapeHtml(message)}</span>
  `;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 4000);
}

function toggleCustomPrompt() {
  const bar = document.getElementById("custom-instruction-bar");
  bar.classList.toggle("hidden");
  if (!bar.classList.contains("hidden")) {
    document.getElementById("custom-instruction-input").focus();
  }
}

function switchTab(tabName) {
  ["triage", "knowledge", "settings"].forEach((t) => {
    const sec = document.getElementById(`tab-${t}`);
    const btn = document.getElementById(`tab-btn-${t}`);
    if (t === tabName) {
      sec.classList.remove("hidden");
      btn.classList.add("active");
    } else {
      sec.classList.add("hidden");
      btn.classList.remove("active");
    }
  });

  if (tabName === "knowledge") {
    loadKnowledgeLayers();
  } else if (tabName === "settings") {
    loadSettingsData();
  }
}

function debounceLoadTickets() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => loadTickets(false), 240);
}

async function loadTickets(autoSelectFirst = false) {
  const group = document.getElementById("filter-group").value;
  const status = document.getElementById("filter-status").value;
  const q = document.getElementById("filter-search").value;

  const params = new URLSearchParams();
  if (group && group !== "Todos") params.set("group", group);
  if (status && status !== "0") params.set("status", status);
  if (q && q.trim()) params.set("q", q.trim());

  try {
    const res = await apiFetch(`/api/tickets?${params.toString()}`);
    const data = await res.json();

    state.tickets = (data.tickets || []).filter(
      (t) =>
        t.status_id !== 5 &&
        t.status_id !== 6 &&
        !t.is_closed_or_solved &&
        !/solucionado|fechado/i.test(t.status_label || "")
    );
    state.analyses = { ...state.analyses, ...(data.analyses || {}) };

    // Atualiza indicador de modo (Simulação vs Produção)
    const connBadge = document.getElementById("connection-badge");
    const sideMode = document.getElementById("sidebar-mode-text");
    if (data.mode === "demo") {
      connBadge.textContent = "Central GLPI • Modo Simulação";
      if (sideMode) sideMode.textContent = "Simulação";
    } else {
      connBadge.textContent = "Central GLPI • Produção Conectada";
      if (sideMode) sideMode.textContent = "Online";
    }

    // Popula dropdown de grupos dinamicamente
    const groupSelect = document.getElementById("filter-group");
    const currentVal = groupSelect.value;
    if (data.groups && data.groups.length > 0) {
      groupSelect.innerHTML = `<option value="Todos">Todos os Grupos</option>`;
      data.groups.forEach((g) => {
        const opt = document.createElement("option");
        opt.value = g;
        opt.textContent = g;
        groupSelect.appendChild(opt);
      });
      if (data.groups.includes(currentVal)) {
        groupSelect.value = currentVal;
      } else {
        groupSelect.value = "Todos";
      }
    }

    updateKpiCards();
    renderTicketList();

    const stillExists = state.tickets.find((t) => t.id === state.selectedTicketId);
    if (stillExists) {
      renderTicketWorkspace(stillExists);
    } else if (state.tickets.length > 0) {
      await selectTicket(state.tickets[0].id);
    }
  } catch (err) {
    showToast("Erro ao carregar chamados: " + err.message, "error");
  }
}

function updateKpiCards() {
  const total = state.tickets.length;
  let missingCount = 0;
  let readyCount = 0;

  state.tickets.forEach((t) => {
    const a = state.analyses[String(t.id)];
    if (a) {
      readyCount += 1;
      if (a.sufficiency_status === "incompleto" || (a.missing_info && a.missing_info.length > 0)) {
        missingCount += 1;
      }
    }
  });

  document.getElementById("kpi-total-tickets").textContent = total;
  document.getElementById("kpi-missing-info").textContent = missingCount;
  document.getElementById("kpi-ready-count").textContent = readyCount;
}

function getStatusBadgeClass(statusId) {
  if (statusId === 1) return "pill-status-active";
  if (statusId === 2 || statusId === 3) return "pill-brand-soft";
  if (statusId === 4)
    return "bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30";
  return "surface-sub";
}

function getUrgencyBadgeClass(urgencyLabel) {
  const u = (urgencyLabel || "").toLowerCase();
  if (u.includes("muito alta") || u.includes("crítica"))
    return "bg-[#dc2626] text-white";
  if (u.includes("alta"))
    return "bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-500/30";
  return "surface-sub";
}

function renderTicketList() {
  const listEl = document.getElementById("ticket-list");

  if (state.tickets.length === 0) {
    listEl.innerHTML = `
      <div class="p-8 text-center text-xs" style="color: var(--text-muted);">
        Nenhum chamado encontrado para o filtro selecionado.
      </div>`;
    return;
  }

  listEl.innerHTML = state.tickets
    .map((t) => {
      const isSelected = t.id === state.selectedTicketId;
      const analysis = state.analyses[String(t.id)];

      // Pílula de status no padrão Counters ("• Ativa" -> "• Pronta" / "• Pedir Dados")
      let statusPill = `
        <span class="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-0.5 rounded-full surface-sub" style="color: var(--text-muted);">
          • Pendente
        </span>`;

      if (analysis) {
        if (analysis.sufficiency_status === "incompleto") {
          statusPill = `
            <span class="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-500/30">
              • Pedir Dados
            </span>`;
        } else {
          statusPill = `
            <span class="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full pill-status-active">
              • Pronta
            </span>`;
        }
      }

      return `
        <div
          onclick="selectTicket(${t.id})"
          class="ticket-row cursor-pointer px-4 py-3.5 ${isSelected ? "active" : ""}"
        >
          <div class="flex items-center justify-between gap-2 mb-1">
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-xs font-mono font-bold" style="color: var(--brand-soft-text);">#${
                t.id
              }</span>
              <span class="text-xs font-semibold truncate" style="color: var(--text-main);">
                ${escapeHtml(t.title)}
              </span>
            </div>
            <div class="shrink-0">${statusPill}</div>
          </div>

          <div class="flex items-center justify-between text-[11px]" style="color: var(--text-muted);">
            <span class="truncate">${escapeHtml(t.requester)} • ${escapeHtml(
        t.status_label
      )}</span>
            <span class="font-medium shrink-0">${escapeHtml(t.assigned_group)}</span>
          </div>
        </div>
      `;
    })
    .join("");
}

async function selectTicket(ticketId) {
  state.selectedTicketId = ticketId;
  renderTicketList();

  const ticket = state.tickets.find((t) => t.id === ticketId);
  if (!ticket) return;

  renderTicketWorkspace(ticket);

  if (!state.analyses[String(ticketId)]) {
    await analyzeCurrentTicket(false);
  } else {
    renderAnalysisBox(state.analyses[String(ticketId)]);
  }

  // Sincroniza status real e acompanhamentos do chamado no GLPI
  try {
    const res = await apiFetch(`/api/tickets/${ticketId}`);
    if (res.ok) {
      const data = await res.json();
      const liveTicket = data.ticket;
      if (liveTicket) {
        if (
          liveTicket.is_closed_or_solved ||
          liveTicket.status_id === 5 ||
          liveTicket.status_id === 6 ||
          /solucionado|fechado/i.test(liveTicket.status_label || "")
        ) {
          state.tickets = state.tickets.filter((t) => t.id !== ticketId);
          updateKpiCards();
          renderTicketList();
          showToast(
            `Chamado #${ticketId} já está ${liveTicket.status_label} no GLPI e saiu da fila.`,
            "info"
          );
          if (state.tickets.length > 0) {
            await selectTicket(state.tickets[0].id);
          } else {
            document.getElementById("active-workspace").classList.add("hidden");
            document.getElementById("empty-workspace").classList.remove("hidden");
          }
          return;
        }
        const idx = state.tickets.findIndex((t) => t.id === ticketId);
        if (idx !== -1) {
          state.tickets[idx] = { ...state.tickets[idx], ...liveTicket };
        }
        if (state.selectedTicketId === ticketId) {
          renderTicketWorkspace(liveTicket);
        }
      }
    }
  } catch {
    // mantém dados em memória caso ocorra falha momentânea de rede
  }
}

function renderTicketWorkspace(ticket) {
  document.getElementById("empty-workspace").classList.add("hidden");
  document.getElementById("active-workspace").classList.remove("hidden");

  document.getElementById("detail-id").textContent = `#${ticket.id}`;
  const stEl = document.getElementById("detail-status");
  stEl.textContent = `• ${ticket.status_label}`;
  stEl.className = `text-[11px] font-semibold px-2.5 py-0.5 rounded-full ${getStatusBadgeClass(
    ticket.status_id
  )}`;

  const urgEl = document.getElementById("detail-urgency");
  urgEl.textContent = `Urgência: ${ticket.urgency_label}`;
  urgEl.className = `text-[11px] font-semibold px-2.5 py-0.5 rounded-full ${getUrgencyBadgeClass(
    ticket.urgency_label
  )}`;

  document.getElementById("detail-group").textContent = ticket.assigned_group;
  document.getElementById("detail-title").textContent = ticket.title;
  document.getElementById("detail-requester").textContent = ticket.requester;
  document.getElementById("detail-dept").textContent = ticket.requester_department
    ? `(${ticket.requester_department})`
    : "";
  document.getElementById("detail-category").textContent = ticket.category;
  document.getElementById("detail-date").textContent = ticket.created_at;
  document.getElementById("detail-content").textContent = ticket.content;

  // Followups
  const fBox = document.getElementById("detail-followups-box");
  const fList = document.getElementById("detail-followups-list");
  if (ticket.followups && ticket.followups.length > 0) {
    fBox.classList.remove("hidden");
    fList.innerHTML = ticket.followups
      .map(
        (f) => `
      <div class="rounded-lg px-3 py-2 text-xs ${
        f.is_private ? "alert-counters-warning" : "surface-sub"
      }">
        <div class="flex items-center justify-between text-[11px] mb-1 opacity-80">
          <span class="inline-flex items-center gap-1 font-semibold">
            <span class="material-symbols-outlined icon-sm">${
              f.is_private ? "lock" : "chat_bubble"
            }</span>
            <span>${f.is_private ? "Nota Privada (T.I.)" : "Público"} • ${escapeHtml(
          f.author
        )}</span>
          </span>
          <span>${escapeHtml(f.date)}</span>
        </div>
        <div class="whitespace-pre-line leading-relaxed">${escapeHtml(f.content)}</div>
      </div>`
      )
      .join("");
  } else {
    fBox.classList.add("hidden");
    fList.innerHTML = "";
  }
}

async function analyzeCurrentTicket(forceRefresh = false) {
  if (!state.selectedTicketId) return;
  const ticketId = state.selectedTicketId;
  const customInstruction = document
    .getElementById("custom-instruction-input")
    .value.trim();

  const btn = document.getElementById("btn-analyze-single");
  const originalText = btn.innerHTML;
  btn.innerHTML = `<span class="material-symbols-outlined icon-sm animate-spin-slow">progress_activity</span><span>Analisando...</span>`;
  btn.disabled = true;

  try {
    const res = await apiFetch(`/api/tickets/${ticketId}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        force_refresh: forceRefresh,
        custom_instruction: customInstruction || null,
      }),
    });
    const data = await res.json();
    if (data.analysis) {
      state.analyses[String(ticketId)] = data.analysis;
      updateKpiCards();
      renderTicketList();
      renderAnalysisBox(data.analysis);
      if (forceRefresh) {
        showToast(`Tratativa do chamado #${ticketId} atualizada.`);
      }
    }
  } catch (err) {
    showToast("Falha ao analisar chamado: " + err.message, "error");
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

async function analyzeAllVisible() {
  if (state.tickets.length === 0) return;
  const btn = document.getElementById("btn-analyze-batch");
  const original = btn.innerHTML;
  btn.innerHTML = `<span class="material-symbols-outlined icon-sm animate-spin-slow">progress_activity</span><span>Analisando...</span>`;
  btn.disabled = true;

  try {
    const ids = state.tickets.map((t) => t.id);
    const res = await apiFetch("/api/tickets/analyze-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ids),
    });
    const data = await res.json();
    state.analyses = { ...state.analyses, ...(data.analyses || {}) };
    updateKpiCards();
    renderTicketList();
    if (state.selectedTicketId && state.analyses[String(state.selectedTicketId)]) {
      renderAnalysisBox(state.analyses[String(state.selectedTicketId)]);
    }
    showToast(`${data.analyzed_count} chamados analisados com sucesso.`);
  } catch (err) {
    showToast("Erro ao analisar fila: " + err.message, "error");
  } finally {
    btn.innerHTML = original;
    btn.disabled = false;
  }
}

function normalizeCatText(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

async function ensureGlpiCategoriesLoaded() {
  if (state.glpiCategories && state.glpiCategories.length > 0) {
    return state.glpiCategories;
  }
  try {
    const res = await apiFetch("/api/glpi/categories");
    if (res.ok) {
      const data = await res.json();
      state.glpiCategories = Array.isArray(data.categories)
        ? data.categories
        : [];
    }
  } catch {
    // fallback silencioso
  }
  return state.glpiCategories;
}

function findBestCategoryMatch(categories, targetText) {
  if (!categories || categories.length === 0 || !targetText) return null;
  const normTarget = normalizeCatText(targetText);
  const targetLastPart = normalizeCatText(
    String(targetText).split(">").slice(-1)[0] || ""
  );

  // 1. Match exato pelo completename
  let found = categories.find(
    (c) => normalizeCatText(c.completename) === normTarget
  );
  if (found) return found;

  // 2. Match pelo nome final da subcategoria
  if (targetLastPart.length >= 4) {
    found = categories.find(
      (c) =>
        normalizeCatText(c.name) === targetLastPart ||
        normalizeCatText(c.completename).endsWith(`> ${targetLastPart}`)
    );
    if (found) return found;
  }

  // 3. Match parcial / inclusão
  if (targetLastPart.length >= 4) {
    found = categories.find((c) =>
      normalizeCatText(c.completename).includes(targetLastPart)
    );
    if (found) return found;
  }

  // 4. Maior sobreposição de tokens
  const targetTokens = normTarget
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && w !== "para" && w !== "com");
  let bestCat = null;
  let bestScore = 0;
  for (const c of categories) {
    const normCand = normalizeCatText(c.completename);
    let hits = 0;
    for (const tok of targetTokens) {
      if (normCand.includes(tok)) hits += 1;
    }
    if (hits > bestScore) {
      bestScore = hits;
      bestCat = c;
    }
  }
  return bestScore > 0 ? bestCat : categories[0];
}

async function setupCategoryReclassUI(ticket, suggestedCat, autoShowIfMismatch = true) {
  const box = document.getElementById("category-reclass-box");
  const select = document.getElementById("reclass-category-select");
  const currentSpan = document.getElementById("category-reclass-current");
  const titleSpan = document.getElementById("category-reclass-title");
  if (!box || !select || !ticket) return;

  const normCurrent = normalizeCatText(ticket.category);
  const normSuggested = normalizeCatText(suggestedCat);
  const isMismatch =
    Boolean(normSuggested) &&
    normSuggested !== "-" &&
    normCurrent !== normSuggested;

  currentSpan.textContent = `Atual no GLPI: ${ticket.category || "Não categorizado"}`;

  if (autoShowIfMismatch) {
    if (isMismatch && !state.dismissedCategoryTickets[String(ticket.id)]) {
      titleSpan.textContent = "Sugestão de Reclassificação de Categoria no GLPI";
      box.classList.remove("hidden");
    } else {
      box.classList.add("hidden");
      return;
    }
  } else {
    titleSpan.textContent = isMismatch
      ? "Sugestão de Reclassificação de Categoria no GLPI"
      : "Alterar Categoria do Chamado no GLPI";
    box.classList.remove("hidden");
  }

  const categories = await ensureGlpiCategoriesLoaded();
  if (!categories || categories.length === 0) {
    select.innerHTML = `<option value="">Não foi possível carregar as categorias do GLPI</option>`;
    return;
  }

  const bestMatch = findBestCategoryMatch(
    categories,
    isMismatch ? suggestedCat : ticket.category
  );

  select.innerHTML = categories
    .map(
      (c) =>
        `<option value="${c.id}" data-completename="${escapeHtml(
          c.completename
        )}" ${bestMatch && bestMatch.id === c.id ? "selected" : ""}>${escapeHtml(
          c.completename
        )}</option>`
    )
    .join("");
}

async function toggleCategoryReclassBox(forceOpen = false) {
  const box = document.getElementById("category-reclass-box");
  if (!box || !state.selectedTicketId) return;
  const ticket = state.tickets.find((t) => t.id === state.selectedTicketId);
  const analysis = state.analyses[String(state.selectedTicketId)];
  if (!ticket) return;

  if (!forceOpen && !box.classList.contains("hidden")) {
    box.classList.add("hidden");
    return;
  }
  await setupCategoryReclassUI(
    ticket,
    analysis?.suggested_category || ticket.category,
    false
  );
}

function dismissCategorySuggestion() {
  if (state.selectedTicketId) {
    state.dismissedCategoryTickets[String(state.selectedTicketId)] = true;
  }
  const box = document.getElementById("category-reclass-box");
  if (box) box.classList.add("hidden");
}

async function applySuggestedCategory() {
  if (!state.selectedTicketId) return;
  const ticketId = state.selectedTicketId;
  const select = document.getElementById("reclass-category-select");
  const btn = document.getElementById("btn-apply-category");
  if (!select || !select.value) {
    showToast("Selecione uma categoria válida do GLPI.", "error");
    return;
  }

  const categoryId = Number(select.value);
  const selectedOpt = select.options[select.selectedIndex];
  const categoryName =
    selectedOpt?.getAttribute("data-completename") ||
    selectedOpt?.textContent ||
    "";

  const originalHtml = btn.innerHTML;
  btn.innerHTML = `<span class="material-symbols-outlined icon-sm animate-spin-slow">progress_activity</span><span>Alterando...</span>`;
  btn.disabled = true;

  try {
    const res = await apiFetch(`/api/tickets/${ticketId}/category`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category_id: categoryId,
        category_name: categoryName,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || "Falha ao atualizar categoria no GLPI.");
    }

    const ticket = state.tickets.find((t) => t.id === ticketId);
    if (ticket) {
      ticket.category = data.category || categoryName;
      if (data.assigned_group) {
        ticket.assigned_group = data.assigned_group;
      }
      document.getElementById("detail-category").textContent = ticket.category;
      document.getElementById("detail-group").textContent = ticket.assigned_group;
    }

    const analysis = state.analyses[String(ticketId)];
    if (analysis) {
      analysis.suggested_category = data.category || categoryName;
      document.getElementById("analysis-suggested-cat").textContent =
        analysis.suggested_category;
    }

    document.getElementById("category-reclass-box")?.classList.add("hidden");
    renderTicketList();
    showToast(
      data.message || `Categoria do chamado #${ticketId} alterada no GLPI!`
    );
  } catch (err) {
    showToast("Erro ao alterar categoria: " + err.message, "error");
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
}

function renderAnalysisBox(analysis) {
  document.getElementById("analysis-domain-badge").textContent =
    analysis.detected_domain;
  document.getElementById("analysis-provider-label").textContent =
    analysis.provider_used;

  document.getElementById("analysis-intent").textContent =
    analysis.translated_intent;
  document.getElementById("analysis-suggested-cat").textContent =
    analysis.suggested_category || "-";
  document.getElementById("analysis-urgency-reason").textContent =
    analysis.urgency_reason || "-";

  const currentTicket = state.tickets.find(
    (t) => t.id === state.selectedTicketId
  );
  if (currentTicket) {
    setupCategoryReclassUI(currentTicket, analysis.suggested_category, true);
  }

  const urgBadge = document.getElementById("analysis-real-urgency");
  urgBadge.textContent = `Prioridade Real: ${analysis.real_urgency}`;
  urgBadge.className = `text-[11px] font-semibold px-2.5 py-0.5 rounded-full ${getUrgencyBadgeClass(
    analysis.real_urgency
  )}`;

  // Banner Amarelo de Dados Faltantes (Estilo Counters)
  const suffBox = document.getElementById("sufficiency-box");
  const missingList = document.getElementById("missing-info-list");

  if (analysis.missing_info && analysis.missing_info.length > 0) {
    suffBox.classList.remove("hidden");
    missingList.innerHTML = analysis.missing_info
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("");
    document.getElementById("chk-mark-pending").checked = true;
  } else {
    suffBox.classList.add("hidden");
    document.getElementById("chk-mark-pending").checked = false;
  }

  // Fonte primária
  document.getElementById("analysis-primary-source").textContent =
    analysis.primary_knowledge_source || "Conhecimento Técnico T.I.";

  // Passo a passo de resolução (Checklist)
  const stepsEl = document.getElementById("resolution-steps-list");
  stepsEl.innerHTML = (analysis.resolution_steps || [])
    .map(
      (step, idx) => `
      <label class="flex items-start gap-2.5 py-1.5 px-2.5 rounded-lg hover:opacity-90 cursor-pointer transition surface-sub">
        <input type="checkbox" class="step-checkbox mt-0.5 rounded accent-[#0f4c43]" />
        <span class="text-xs leading-relaxed" style="color: var(--text-main);">
          <strong class="font-mono mr-1.5" style="color: var(--brand-soft-text);">${
            idx + 1
          }.</strong>${escapeHtml(step)}
        </span>
      </label>
    `
    )
    .join("");

  // Fontes das 3 Camadas (Acordeão compacto)
  const matchesEl = document.getElementById("knowledge-matches-list");
  if (analysis.knowledge_matches && analysis.knowledge_matches.length > 0) {
    matchesEl.innerHTML = analysis.knowledge_matches
      .map((m) => {
        let iconName = "library_books";
        let shortLayer = "1ª Camada • KB GLPI";

        if (m.layer === "glpi_history") {
          iconName = "history";
          shortLayer = "2ª Camada • Histórico";
        } else if (m.layer === "local_playbook") {
          iconName = "description";
          shortLayer = "3ª Camada • Playbook";
        }

        return `
          <details class="group surface-sub rounded-lg px-3.5 py-2">
            <summary class="flex flex-wrap items-center justify-between gap-2 cursor-pointer list-none text-xs">
              <div class="flex items-center gap-2 min-w-0">
                <span class="material-symbols-outlined icon-sm" style="color: var(--brand-soft-text);">${iconName}</span>
                <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full pill-brand-soft shrink-0">${shortLayer}</span>
                <span class="font-semibold truncate" style="color: var(--text-main);">${escapeHtml(
                  m.title
                )}</span>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <span class="text-[11px] font-mono" style="color: var(--text-muted);">${Math.round(
                  m.score * 100
                )}%</span>
                <span class="material-symbols-outlined icon-sm group-open:rotate-180 transition-transform" style="color: var(--text-muted);">expand_more</span>
              </div>
            </summary>
            <p class="mt-2 pt-2 border-t text-[11px] leading-relaxed" style="border-color: var(--border-color); color: var(--text-secondary);">
              <strong class="font-mono">${escapeHtml(m.source_id)}:</strong> ${escapeHtml(
          m.summary
        )}
            </p>
          </details>
        `;
      })
      .join("");
  } else {
    matchesEl.innerHTML = `
      <div class="text-xs italic" style="color: var(--text-muted);">
        Nenhuma referência direta na KB; passos baseados em boas práticas de T.I.
      </div>`;
  }

  switchDraftMode(state.activeDraftMode);
}

function switchDraftMode(mode) {
  state.activeDraftMode = mode;
  const pubBtn = document.getElementById("draft-tab-public");
  const privBtn = document.getElementById("draft-tab-private");
  const textarea = document.getElementById("draft-textarea");

  const analysis = state.analyses[String(state.selectedTicketId)];
  if (!analysis) return;

  if (mode === "public") {
    pubBtn.className =
      "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold btn-counters-primary";
    privBtn.className =
      "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium";
    textarea.value = analysis.public_reply_draft || "";
  } else {
    privBtn.className =
      "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold btn-counters-primary";
    pubBtn.className =
      "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium";
    textarea.value = analysis.private_note_draft || "";
  }
}

async function copyActiveDraft() {
  const text = document.getElementById("draft-textarea").value;
  if (!text) return;
  await navigator.clipboard.writeText(text);
  showToast("Texto copiado para a área de transferência.");
}

async function sendFollowupToGLPI(isPrivate) {
  if (!state.selectedTicketId) return;
  const ticketId = state.selectedTicketId;
  const analysis = state.analyses[String(ticketId)];

  let contentToSend = document.getElementById("draft-textarea").value.trim();
  if (isPrivate && state.activeDraftMode !== "private" && analysis) {
    contentToSend = analysis.private_note_draft || contentToSend;
  } else if (!isPrivate && state.activeDraftMode !== "public" && analysis) {
    contentToSend = analysis.public_reply_draft || contentToSend;
  }

  const markPending = document.getElementById("chk-mark-pending").checked;
  showToast(
    markPending
      ? `Enviando ao GLPI e alterando status do Chamado #${ticketId} para Pendente...`
      : `Enviando acompanhamento ao GLPI no Chamado #${ticketId}...`,
    "info"
  );

  const currentTicket = state.tickets.find((t) => t.id === ticketId) || null;

  try {
    const res = await apiFetch(`/api/tickets/${ticketId}/followup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: contentToSend,
        is_private: isPrivate,
        mark_pending: markPending,
        ticket_meta: currentTicket
          ? {
              title: currentTicket.title,
              category: currentTicket.category,
              requester_first_name:
                currentTicket.requester_first_name || currentTicket.requester,
              content: currentTicket.content,
            }
          : null,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || "Falha ao enviar acompanhamento.");
    }

    showToast(data.message, "success");

    const idx = state.tickets.findIndex((t) => t.id === ticketId);
    if (idx !== -1) {
      if (data.ticket) {
        state.tickets[idx] = data.ticket;
      } else {
        if (!Array.isArray(state.tickets[idx].followups)) {
          state.tickets[idx].followups = [];
        }
        if (data.followup) {
          state.tickets[idx].followups.push(data.followup);
        }
        if (data.status_id) {
          state.tickets[idx].status_id = data.status_id;
          state.tickets[idx].status_label = data.status_label || "Pendente";
        }
      }
      renderTicketList();
      renderTicketWorkspace(state.tickets[idx]);
    }
  } catch (err) {
    showToast("Erro ao enviar para o GLPI: " + err.message, "error");
  }
}

// ====================================================================
// TAB 2: BASE EM 3 CAMADAS & PLAYBOOKS LOCAIS (BOTÕES ESTILO COUNTERS)
// ====================================================================
async function loadKnowledgeLayers() {
  try {
    const res = await apiFetch("/api/knowledge");
    const data = await res.json();
    state.knowledge = data;

    const l1 = data.layer1_glpi_kb || [];
    document.getElementById("kb-layer1-count").textContent = l1.length;
    document.getElementById("kb-layer1-list").innerHTML = l1
      .map(
        (item) => `
      <div class="surface-sub rounded-xl p-3.5 space-y-1">
        <div class="flex items-center justify-between text-[11px]">
          <span class="font-mono font-bold" style="color: var(--brand-soft-text);">${escapeHtml(
            item.id
          )}</span>
          <span style="color: var(--text-muted);">${escapeHtml(
            item.category || ""
          )}</span>
        </div>
        <h4 class="text-xs font-bold" style="color: var(--text-main);">${escapeHtml(
          item.title
        )}</h4>
        <p class="text-[11px] leading-relaxed" style="color: var(--text-secondary);">${escapeHtml(
          item.summary
        )}</p>
      </div>`
      )
      .join("");

    const l2 = data.layer2_glpi_history || [];
    document.getElementById("kb-layer2-count").textContent = l2.length;
    document.getElementById("kb-layer2-list").innerHTML = l2
      .map(
        (item, idx) => `
      <div class="surface-sub rounded-xl p-3.5 space-y-1.5">
        <div class="flex items-center justify-between text-[11px] gap-2">
          <span class="font-mono font-bold" style="color: var(--brand-soft-text);">${escapeHtml(
            item.id
          )}</span>
          <div class="flex items-center gap-1.5">
            <span class="truncate max-w-[130px]" style="color: var(--text-muted);">${escapeHtml(
              item.category || ""
            )}</span>
            <button onclick="createPlaybookFromHistoryItem(${idx})" class="btn-counters-outline inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold" title="Criar um Playbook a partir desta solução">
              <span class="material-symbols-outlined" style="font-size: 12px;">bookmark_add</span>
              <span>Virar Playbook</span>
            </button>
          </div>
        </div>
        <h4 class="text-xs font-bold" style="color: var(--text-main);">${escapeHtml(
          item.title
        )}</h4>
        <p class="text-[11px] leading-relaxed" style="color: var(--text-secondary);">${escapeHtml(
          item.summary
        )}</p>
      </div>`
      )
      .join("");

    const l3 = data.layer3_local_playbooks || [];
    document.getElementById("kb-layer3-count").textContent = l3.length;
    document.getElementById("kb-layer3-list").innerHTML = l3
      .map(
        (pb) => `
      <div class="surface-sub rounded-xl p-3.5 space-y-2">
        <div class="flex items-center justify-between text-[11px]">
          <span class="font-mono font-bold" style="color: var(--brand-soft-text);">${escapeHtml(
            pb.id
          )}</span>
          <div class="flex items-center gap-1.5">
            <button onclick='editPlaybook(${JSON.stringify(pb).replace(
              /'/g,
              "&#39;"
            )})' class="btn-counters-primary inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium">
              <span class="material-symbols-outlined" style="font-size: 13px;">edit</span>
              <span>Editar</span>
            </button>
            <button onclick="deletePlaybook('${escapeHtml(
              pb.id
            )}')" class="bg-[#dc2626] hover:bg-red-700 text-white inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-medium transition">
              <span>Excluir</span>
            </button>
          </div>
        </div>
        <h4 class="text-xs font-bold" style="color: var(--text-main);">${escapeHtml(
          pb.title
        )}</h4>
        <p class="text-[11px]" style="color: var(--text-secondary);">${escapeHtml(
          pb.symptoms
        )}</p>
      </div>`
      )
      .join("");
  } catch (err) {
    showToast("Erro ao carregar camadas: " + err.message, "error");
  }
}

function nextPlaybookId() {
  const existing = state.knowledge?.layer3_local_playbooks || [];
  let maxNum = 11;
  for (const pb of existing) {
    const m = String(pb.id || "").match(/(\d+)/);
    if (m) {
      const n = Number(m[1]);
      if (n > maxNum) maxNum = n;
    }
  }
  return `PB-UNI-${String(maxNum + 1).padStart(2, "0")}`;
}

function extractSuggestedKeywords(text) {
  const stop = new Set([
    "para", "como", "este", "esta", "isso", "pelo", "pela", "chamado", "solicitacao",
    "suporte", "tecnico", "service", "desk", "unimed", "hospital", "setor", "dados",
    "favor", "realizar", "usuario", "colaborador", "solicita", "problema", "erro"
  ]);
  const words = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[a-z0-9_-]{4,}/g) || [];
  const uniq = [];
  for (const w of words) {
    if (!stop.has(w) && !/^\d+$/.test(w) && !uniq.includes(w)) {
      uniq.push(w);
      if (uniq.length >= 6) break;
    }
  }
  return uniq;
}

function createPlaybookFromCurrentTicket() {
  const ticket = state.tickets.find((t) => t.id === state.selectedTicketId);
  if (!ticket) {
    showToast("Selecione um chamado primeiro.", "error");
    return;
  }
  const analysis = state.analyses[String(ticket.id)] || {};
  const cleanTitle = ticket.title.includes(">")
    ? ticket.title.split(">").slice(-2).join(" - ").trim()
    : ticket.title;

  const firstName = String(ticket.requester_name || "")
    .trim()
    .split(/\s+/)[0] || "";

  let replyTemplate =
    document.getElementById("draft-textarea")?.value ||
    analysis.public_reply_draft ||
    `Olá {solicitante}! Recebemos sua solicitação referente a "${cleanTitle}" e já iniciamos a tratativa.`;

  if (firstName && firstName.length >= 2) {
    const regexName = new RegExp(`\\b${firstName}\\b`, "gi");
    replyTemplate = replyTemplate.replace(regexName, "{solicitante}");
  }

  const validDomains = [
    "Suporte Técnico Geral / Service Desk",
    "Acessos, Permissões e Contas",
    "Sistemas Internos / ERP / Sistemas Corporativos",
  ];
  const domain = validDomains.includes(analysis.domain)
    ? analysis.domain
    : "Suporte Técnico Geral / Service Desk";

  openPlaybookModal({
    id: nextPlaybookId(),
    domain,
    title: cleanTitle,
    keywords: extractSuggestedKeywords(`${cleanTitle} ${analysis.suggested_category || ""} ${analysis.intent_summary || ""}`),
    symptoms: analysis.intent_summary || cleanTitle,
    required_info: analysis.missing_info || [],
    resolution_steps: analysis.resolution_steps || [],
    reply_template: replyTemplate,
  });
  showToast(`Rascunho de Playbook preenchido a partir do Chamado #${ticket.id}! Revise e clique em Salvar.`, "info");
}

function createPlaybookFromHistoryItem(idx) {
  const list = state.knowledge?.layer2_glpi_history || [];
  const item = list[idx];
  if (!item) return;

  const cleanTitle = item.title.includes(">")
    ? item.title.split(">").slice(-2).join(" - ").trim()
    : item.title;

  openPlaybookModal({
    id: nextPlaybookId(),
    domain: "Suporte Técnico Geral / Service Desk",
    title: cleanTitle,
    keywords: extractSuggestedKeywords(`${cleanTitle} ${item.summary || ""}`),
    symptoms: `Chamados similares a ${item.id}: ${cleanTitle}`,
    required_info: [],
    resolution_steps: item.steps && item.steps.length > 0 ? item.steps : [item.summary],
    reply_template: `Olá {solicitante}! Recebemos seu chamado referente a "${cleanTitle}". ${item.summary}`,
  });
  showToast(`Playbook pré-preenchido com a solução de ${item.id}!`, "info");
}

function openPlaybookModal(pb = null) {
  document.getElementById("playbook-modal").classList.remove("hidden");
  document.getElementById("pb-id").value =
    pb?.id || nextPlaybookId();
  document.getElementById("pb-domain").value =
    pb?.domain || "Suporte Técnico Geral / Service Desk";
  document.getElementById("pb-title").value = pb?.title || "";
  document.getElementById("pb-keywords").value = (pb?.keywords || []).join(", ");
  document.getElementById("pb-symptoms").value = pb?.symptoms || "";
  document.getElementById("pb-req-info").value = (pb?.required_info || []).join("\n");
  document.getElementById("pb-steps").value = (pb?.resolution_steps || []).join("\n");
  document.getElementById("pb-reply").value = pb?.reply_template || "";
}

function editPlaybook(pb) {
  openPlaybookModal(pb);
}

function closePlaybookModal() {
  document.getElementById("playbook-modal").classList.add("hidden");
}

async function savePlaybookModal() {
  const payload = {
    id: document.getElementById("pb-id").value.trim(),
    domain: document.getElementById("pb-domain").value,
    title: document.getElementById("pb-title").value.trim(),
    keywords: document
      .getElementById("pb-keywords")
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    symptoms: document.getElementById("pb-symptoms").value.trim(),
    required_info: document
      .getElementById("pb-req-info")
      .value.split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    resolution_steps: document
      .getElementById("pb-steps")
      .value.split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    reply_template: document.getElementById("pb-reply").value.trim(),
  };

  if (!payload.id || !payload.title) {
    showToast("Preencha o ID e o Título do Playbook.", "error");
    return;
  }

  const res = await apiFetch("/api/playbooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (data.ok) {
    showToast(data.message);
    closePlaybookModal();
    loadKnowledgeLayers();
  }
}

async function deletePlaybook(pbId) {
  const res = await apiFetch(`/api/playbooks/${encodeURIComponent(pbId)}`, {
    method: "DELETE",
  });
  const data = await res.json();
  if (data.ok) {
    showToast(data.message, "info");
    loadKnowledgeLayers();
  }
}

// ====================================================================
// TAB 3: CONFIGURAÇÕES (GLPI REST API & PROVEDOR IA)
// ====================================================================
async function loadSettingsData() {
  try {
    const res = await apiFetch("/api/settings");
    const s = await res.json();
    state.settings = s;

    document.getElementById("cfg-demo-mode").checked = Boolean(s.glpi_demo_mode);
    document.getElementById("cfg-glpi-url").value = s.glpi_api_url || "";
    document.getElementById("cfg-glpi-user-token").value = s.glpi_user_token || "";
    document.getElementById("cfg-glpi-app-token").value = s.glpi_app_token || "";

    document.getElementById("cfg-ai-provider").value = s.ai_provider || "gemini";
    document.getElementById("cfg-gemini-model").value = s.gemini_model || "gemini-2.5-flash";
    document.getElementById("cfg-gemini-key").value = s.gemini_api_key || "";
    document.getElementById("cfg-openai-key").value = s.openai_api_key || "";
    document.getElementById("cfg-openai-model").value = s.openai_model || "gpt-4o-mini";
    document.getElementById("cfg-ollama-url").value = s.ollama_base_url || "http://localhost:11434";
    document.getElementById("cfg-ollama-model").value = s.ollama_model || "llama3.1";
    document.getElementById("cfg-org-context").value = s.org_context || "";

    const localUserEl = document.getElementById("cfg-auth-local-user");
    const localPassEl = document.getElementById("cfg-auth-local-pass");
    if (localUserEl) localUserEl.value = s.auth_local_user || "admin";
    if (localPassEl) localPassEl.value = s.auth_local_password || "";
  } catch (err) {
    console.error("Erro ao carregar configurações:", err);
  }
}

function collectSettingsFromUI() {
  const localUserEl = document.getElementById("cfg-auth-local-user");
  const localPassEl = document.getElementById("cfg-auth-local-pass");

  return {
    glpi_demo_mode: document.getElementById("cfg-demo-mode").checked,
    glpi_api_url: document.getElementById("cfg-glpi-url").value.trim(),
    glpi_user_token: document.getElementById("cfg-glpi-user-token").value.trim(),
    glpi_app_token: document.getElementById("cfg-glpi-app-token").value.trim(),
    glpi_default_group: "Todos",
    glpi_verify_ssl: true,
    ai_provider: document.getElementById("cfg-ai-provider").value,
    gemini_model: document.getElementById("cfg-gemini-model").value.trim(),
    gemini_api_key: document.getElementById("cfg-gemini-key").value.trim(),
    openai_api_key: document.getElementById("cfg-openai-key").value.trim(),
    openai_model: document.getElementById("cfg-openai-model").value.trim(),
    openai_base_url: "https://api.openai.com/v1",
    ollama_base_url: document.getElementById("cfg-ollama-url").value.trim(),
    ollama_model: document.getElementById("cfg-ollama-model").value.trim(),
    org_context: document.getElementById("cfg-org-context").value.trim(),
    auth_local_user: localUserEl ? localUserEl.value.trim() || "admin" : "admin",
    auth_local_password:
      localPassEl && localPassEl.value
        ? localPassEl.value
        : state.settings?.auth_local_password || "admin123",
  };
}

async function testGlpiConnectionUI() {
  const resultEl = document.getElementById("glpi-test-result");
  resultEl.textContent = "Testando conexão com o GLPI...";
  resultEl.className = "text-xs";

  const payload = collectSettingsFromUI();
  if (payload.glpi_user_token) {
    payload.glpi_demo_mode = false;
  }
  const res = await apiFetch("/api/settings/test-glpi", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  resultEl.textContent = data.message;
  resultEl.className = data.ok
    ? "text-xs font-semibold text-emerald-600"
    : "text-xs font-semibold text-rose-600";
}

async function saveSettingsUI() {
  const payload = collectSettingsFromUI();
  const res = await apiFetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (data.ok) {
    showToast(data.message);
    await loadTickets(true);
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
