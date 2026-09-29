import { loadResolvedHistoryCache, saveResolvedHistoryCache } from "./config.js";

export const STATUS_MAP = {
  1: "Novo",
  2: "Em atendimento (atribuído)",
  3: "Em atendimento (planejado)",
  4: "Pendente",
  5: "Solucionado",
  6: "Fechado",
};

export const URGENCY_MAP = {
  1: "Muito baixa",
  2: "Baixa",
  3: "Média",
  4: "Alta",
  5: "Muito alta",
};

export function cleanGlpiHtml(rawText) {
  if (!rawText) return "";
  let text = String(rawText);
  const entities = {
    "&lt;": "<",
    "&gt;": ">",
    "&amp;": "&",
    "&quot;": '"',
    "&#039;": "'",
    "&#39;": "'",
    "&nbsp;": " ",
  };
  for (let i = 0; i < 2; i++) {
    text = text.replace(/&(lt|gt|amp|quot|#039|#39|nbsp);/gi, (m) => entities[m.toLowerCase()] || m);
  }
  text = text.replace(/\u00a0/g, " ");
  text = text.replace(/<h[1-6][^>]*>/gi, "\n\n▸ ");
  text = text.replace(/<\/h[1-6]\s*>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p\s*>/gi, "\n\n");
  text = text.replace(/<\/li\s*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/[ \t]{2,}/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export const DEMO_TICKETS = [
  {
    id: 10482,
    title: "URGENTE!! O sistema não funciona e preciso faturar agora",
    content:
      "Bom dia pessoal do TI, desde as 08h30 estou tentando soltar a nota do cliente lá no sistema " +
      "e só dá um erro estranho na tela e fecha ou trava tudo. O caminhão já está na portaria esperando " +
      "a nota fiscal sair!! Me ajudem com urgência por favor!",
    status_id: 1,
    status_label: "Novo",
    urgency_id: 5,
    urgency_label: "Muito alta",
    priority_id: 4,
    category: "Sistemas > ERP > Faturamento",
    requester: "Carlos Eduardo Mendes",
    requester_department: "Faturamento / Logística",
    assigned_group: "TI - Sistemas / ERP",
    assigned_tech: "",
    created_at: "2026-09-25 08:42",
    updated_at: "2026-09-25 08:42",
    followups: [],
  },
  {
    id: 10481,
    title: "Liberar acesso igual ao da Fernanda para estagiário novo",
    content:
      "Oi TI, o Lucas começou hoje aqui no setor Financeiro. Preciso que liberem pra ele na rede " +
      "tudo igual ao que a Fernanda tem nas pastas e no sistema pra ele já conseguir trabalhar hoje à tarde. " +
      "Obrigado!",
    status_id: 1,
    status_label: "Novo",
    urgency_id: 3,
    urgency_label: "Média",
    priority_id: 3,
    category: "Acessos > Pastas de Rede / AD",
    requester: "Roberto Tavares",
    requester_department: "Financeiro",
    assigned_group: "TI - Acessos e Redes",
    assigned_tech: "",
    created_at: "2026-09-25 09:15",
    updated_at: "2026-09-25 09:15",
    followups: [],
  },
  {
    id: 10479,
    title: "Minha internet caiu mas o WhatsApp Web funciona (Pasta G sumiu)",
    content:
      "Pessoal, meu computador está sem rede nenhuma desde que liguei hoje. Consigo abrir o Google e " +
      "falar no WhatsApp Web normal, mas quando clico na pasta G: (Pública) ou na pasta do RH aparece um " +
      "X vermelho dizendo que o caminho não foi encontrado. Estou usando o notebook na sala de reunião 2.",
    status_id: 2,
    status_label: "Em atendimento (atribuído)",
    urgency_id: 4,
    urgency_label: "Alta",
    priority_id: 3,
    category: "Suporte > Rede / Conectividade",
    requester: "Juliana Costa",
    requester_department: "Recursos Humanos",
    assigned_group: "TI - Service Desk",
    assigned_tech: "Analista TI",
    created_at: "2026-09-25 09:50",
    updated_at: "2026-09-25 10:05",
    followups: [
      {
        id: 501,
        author: "Juliana Costa",
        date: "2026-09-25 10:05",
        content: "Tentei reiniciar o notebook mas continua dando erro na pasta G: e não abre a intranet.",
        is_private: false,
      },
    ],
  },
  {
    id: 10476,
    title: "Voltei de férias e não entra na VPN nem no e-mail",
    content:
      "Bom dia! Voltei de férias hoje (estou em home office) e quando tento conectar na VPN FortiClient " +
      "para trabalhar dá falha de autenticação (691 / credenciais inválidas). Meu Outlook também fica pedindo " +
      "senha toda hora e não atualiza a caixa de entrada.",
    status_id: 1,
    status_label: "Novo",
    urgency_id: 4,
    urgency_label: "Alta",
    priority_id: 4,
    category: "Acessos > VPN / Active Directory",
    requester: "Marcos Vinícius Rocha",
    requester_department: "Comercial",
    assigned_group: "TI - Acessos e Redes",
    assigned_tech: "",
    created_at: "2026-09-25 10:30",
    updated_at: "2026-09-25 10:30",
    followups: [],
  },
  {
    id: 10472,
    title: "Impressora da recepção piscando luz laranja e não imprime",
    content:
      "Mandei imprimir 3 contratos da recepção há meia hora e não sai nada na impressora Brother/HP do balcão. " +
      "Ela está com uma luz laranja piscando sem parar, mas já olhei a gaveta e tem papel A4 normal lá dentro.",
    status_id: 2,
    status_label: "Em atendimento (atribuído)",
    urgency_id: 3,
    urgency_label: "Média",
    priority_id: 3,
    category: "Suporte > Impressoras",
    requester: "Beatriz Almeida",
    requester_department: "Recepção / Administrativo",
    assigned_group: "TI - Service Desk",
    assigned_tech: "",
    created_at: "2026-09-25 11:10",
    updated_at: "2026-09-25 11:10",
    followups: [],
  },
  {
    id: 10468,
    title: "Erro 'ORA-00001: restrição exclusiva violada' ao aprovar Pedido de Compra #8841",
    content:
      "Ao tentar aprovar o Pedido de Compra nº 8841 no módulo Suprimentos do ERP, o sistema apresenta a mensagem:\n" +
      "'Erro de Banco de Dados: ORA-00001: unique constraint (ERP.PK_APROV_PEDIDO) violated'.\n" +
      "Outros pedidos consegui aprovar normalmente hoje, só esse 8841 está travado.",
    status_id: 4,
    status_label: "Pendente",
    urgency_id: 3,
    urgency_label: "Média",
    priority_id: 3,
    category: "Sistemas > ERP > Suprimentos",
    requester: "Andréia Nogueira",
    requester_department: "Compras / Suprimentos",
    assigned_group: "TI - Sistemas / ERP",
    assigned_tech: "Analista TI",
    created_at: "2026-09-25 11:45",
    updated_at: "2026-09-25 12:00",
    followups: [],
  },
];

export const DEMO_KB_ARTICLES = [
  {
    id: "KB-104",
    title: "Procedimento: Conta Bloqueada no AD / Senha Expirada em Home Office (VPN FortiClient + Outlook)",
    category: "Acessos > Active Directory & VPN",
    summary:
      "Artigo oficial da Base de Conhecimento do GLPI para tratamento de falha de autenticação na VPN (Erro 691) " +
      "e loop de senha no Outlook após retorno de férias ou expiração da política de 60 dias.",
    keywords: ["vpn", "forticlient", "férias", "senha", "outlook", "e-mail", "691", "autenticação", "bloqueado", "home office"],
    steps: [
      "1. No Active Directory (AD Users and Computers), abrir as propriedades do usuário na aba 'Conta' (Account).",
      "2. Verificar se a flag 'Desbloquear conta' está marcada e se a senha expirou durante o período de férias.",
      "3. ATENÇÃO HOME OFFICE: Ao redefinir a senha temporária para usuário remoto, NÃO marque 'O usuário deve alterar a senha no próximo logon' caso o FortiClient VPN não suporte troca de senha pré-logon.",
      "4. Orientar o usuário a limpar o 'Gerenciador de Credenciais do Windows' (Credenciais do Windows > remover entradas do Office/Exchange) e atualizar a senha no celular para evitar novo bloqueio automático.",
    ],
  },
  {
    id: "KB-119",
    title: "Solução: Impressora com Luz Laranja Piscando (Conflito Tamanho de Papel Carta vs A4)",
    category: "Suporte > Impressoras Corporativas",
    summary:
      "Mesmo com papel A4 na bandeja 1, a impressora pisca o alerta laranja quando um documento PDF/Word é " +
      "enviado configurado como 'Carta (Letter)' ou 'Bandeja Manual'.",
    keywords: ["impressora", "luz laranja", "piscando", "papel", "a4", "carta", "recepção", "balcão", "imprimir", "contratos"],
    steps: [
      "1. Acessar o painel web da impressora pelo IP da recepção (ex: http://192.168.10.45) para ler o alerta exato no display virtual.",
      "2. Se o aviso for 'Colocar papel Carta (Letter) na Bandeja 1', pressionar o botão 'OK / Continuar' no painel físico ou cancelar o job na fila do servidor de impressão.",
      "3. No computador do usuário (Painel de Controle > Dispositivos e Impressoras > Preferências de Impressão), alterar o padrão de 'Letter' para 'A4' em 'Preferências' e também em 'Propriedades da Impressora > Avançado > Padrões de Impressão'.",
    ],
  },
  {
    id: "KB-205",
    title: "Diagnóstico de Queda de Mapeamento de Rede (Unidades G: e H: com X Vermelho em Notebooks)",
    category: "Suporte > Rede e File Server",
    summary:
      "Usuários em salas de reunião com Wi-Fi frequentemente conectam no SSID 'Visitantes' (isolado da VLAN interna), " +
      "mantendo acesso à Internet/WhatsApp mas perdendo acesso ao File Server (Pasta G:) e Intranet.",
    keywords: ["pasta g", "x vermelho", "whatsapp", "internet", "sala de reunião", "notebook", "intranet", "caminho não encontrado", "rede"],
    steps: [
      "1. Confirmar em qual rede Wi-Fi (SSID) o notebook está conectado. Na Sala de Reunião 2, o sinal do Wi-Fi 'Visitantes' é forte e os notebooks costumam trocar automaticamente se tiverem a senha salva.",
      "2. Orientar a reconexão no Wi-Fi 'Corporativo' e desmarcar 'Conectar automaticamente' na rede Visitantes.",
      "3. Caso já esteja na rede Corporativa, executar `ipconfig /flushdns` e `net use * /delete /y && gpupdate /force`.",
    ],
  },
];

export const DEMO_RESOLVED_HISTORY = [
  {
    id: "Chamado #9814 (Resolvido)",
    title: "Erro ORA-00001 (PK_APROV_PEDIDO) ao aprovar Pedido de Compra no Suprimentos",
    category: "Sistemas > ERP > Suprimentos",
    summary:
      "Chamado histórico resolvido pela equipe de Sistemas: Ocorre quando o aprovador clica duas vezes seguidas " +
      "em 'Aprovar' com lentidão de rede, gerando registro órfão na tabela `TB_LOG_APROVACAO_PEDIDO` sem atualizar o cabeçalho do pedido.",
    keywords: ["ora-00001", "pk_aprov_pedido", "pedido de compra", "suprimentos", "aprovar", "restrição exclusiva", "erp"],
    steps: [
      "1. Conectar no banco do ERP (leitura) e consultar: `SELECT * FROM TB_LOG_APROVACAO_PEDIDO WHERE NUM_PEDIDO = <ID_PEDIDO>;`",
      "2. Verificar se o status na `TB_PEDIDO_COMPRA` permaneceu como 'Em Aprovação (status=2)' enquanto a linha de assinatura já foi inserida na `TB_LOG_APROVACAO_PEDIDO`.",
      "3. Executar a procedure homologada de ressincronização `EXEC SP_REPROCESSA_APROVACAO_PEDIDO(<ID_PEDIDO>);` (ou remover o registro duplicado pendente de commit) e confirmar com o comprador.",
    ],
  },
  {
    id: "Chamado #9920 (Resolvido)",
    title: "Erro ao emitir Nota Fiscal no Faturamento (Tela trava / Rejeição SEFAZ ou Certificado)",
    category: "Sistemas > ERP > Faturamento",
    summary:
      "Chamado histórico resolvido: Usuário abriu chamado urgente dizendo que 'o sistema de faturamento travou'. " +
      "Na triagem, verificou-se que era sessão presa no Terminal Server (TS/Citrix) combinada com NCM inválido no item do pedido.",
    keywords: ["faturar", "nota fiscal", "faturamento", "caminhão", "trava", "erro", "sistema não funciona"],
    steps: [
      "1. Solicitar imediatamente ao usuário o Número do Pedido/Nota e print do erro (para saber se é travamento da sessão RemoteApp/TS ou erro de validação fiscal).",
      "2. Verificar no servidor de aplicação/TS se a sessão do usuário está travada (`taskkill` no processo `erp_fat.exe` da sessão do usuário).",
      "3. Conferir no monitor de NFe do ERP se a nota entrou em fila de contingência ou apresentou rejeição de cadastro.",
    ],
  },
];

export class GLPIClient {
  constructor(settings) {
    this.settings = settings;
    let rawUrl = (settings.glpi_api_url || "").trim().replace(/\/+$/, "");
    if (rawUrl && !rawUrl.endsWith(".php") && !rawUrl.includes("/apirest.php")) {
      rawUrl = `${rawUrl}/apirest.php`;
    }
    this.baseUrl = rawUrl;
    if (settings.glpi_verify_ssl === false) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
  }

  async testConnection() {
    if (this.settings.glpi_demo_mode) {
      return {
        ok: true,
        mode: "demo",
        message:
          "Modo Simulação ativo! Desative a chave 'Modo Simulação' logo acima para testar a conexão real com o seu servidor GLPI.",
      };
    }

    if (!this.settings.glpi_user_token || !this.settings.glpi_user_token.trim()) {
      return {
        ok: false,
        mode: "production",
        message: "User-Token do GLPI não informado. Preencha o campo GLPI User-Token.",
      };
    }

    try {
      const sessionToken = await this._initSession();
      await this._killSession(sessionToken);
      return {
        ok: true,
        mode: "production",
        message: `Conectado com sucesso à API REST do GLPI em ${this.baseUrl}!`,
      };
    } catch (err) {
      const causeMsg = err.cause ? ` (${err.cause.message || err.cause.code || ""})` : "";
      return {
        ok: false,
        mode: "production",
        message: `Falha ao conectar no GLPI (${this.baseUrl}): ${err.message}${causeMsg}`,
      };
    }
  }

  async _initSession() {
    // Permite certificados SSL internos corporativos por padrão caso necessário
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    const headers = {
      "Content-Type": "application/json",
      Authorization: `user_token ${this.settings.glpi_user_token.trim()}`,
    };
    if (this.settings.glpi_app_token && this.settings.glpi_app_token.trim()) {
      headers["App-Token"] = this.settings.glpi_app_token.trim();
    }

    const res = await fetch(`${this.baseUrl}/initSession`, { headers });
    const rawBody = await res.text();
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = null;
    }

    if (!res.ok) {
      const glpiDetail = Array.isArray(parsedBody)
        ? parsedBody.join(" - ")
        : parsedBody?.message || rawBody.slice(0, 180);
      throw new Error(`HTTP ${res.status}: ${glpiDetail}`);
    }

    if (!parsedBody || !parsedBody.session_token) {
      throw new Error(`Resposta do GLPI não retornou session_token: ${rawBody.slice(0, 150)}`);
    }

    const sessionToken = parsedBody.session_token;
    await this._activateTechProfile(sessionToken);
    return sessionToken;
  }

  async _activateTechProfile(sessionToken) {
    const authHeaders = this._authHeaders(sessionToken);
    try {
      if (GLPIClient._lastBaseUrl !== this.baseUrl) {
        GLPIClient._preferredProfileId = null;
        GLPIClient._kbCache = null;
        GLPIClient._resolvedCache = null;
        GLPIClient._usersMap = null;
        GLPIClient._lastBaseUrl = this.baseUrl;
      }

      if (!GLPIClient._preferredProfileId) {
        const pRes = await fetch(`${this.baseUrl}/getMyProfiles`, {
          headers: authHeaders,
        });
        if (pRes.ok) {
          const pData = await pRes.json();
          const profiles = pData?.myprofiles || [];
          // Prioriza perfil técnico de T.I. (ex: U-Tecnologia) ou Super-Admin em vez de U-Solicitante
          const techProfile =
            profiles.find((p) => /tecnologia|t\.i|suporte|tecnico/i.test(p.name || "")) ||
            profiles.find((p) => /super-admin|admin/i.test(p.name || ""));
          if (techProfile && techProfile.id) {
            GLPIClient._preferredProfileId = techProfile.id;
          }
        }
      }

      if (GLPIClient._preferredProfileId) {
        await fetch(`${this.baseUrl}/changeActiveProfile`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ profiles_id: GLPIClient._preferredProfileId }),
        });
      }
    } catch {
      // ignora se o GLPI não exigir troca de perfil
    }
  }

  async _ensureUsersMap(headers) {
    const now = Date.now();
    if (GLPIClient._usersMap && now - (GLPIClient._usersMapTime || 0) < 600000) {
      return GLPIClient._usersMap;
    }

    const map = new Map();
    try {
      const res = await fetch(`${this.baseUrl}/User?range=0-999`, { headers });
      if (res.ok) {
        const users = await res.json();
        if (Array.isArray(users)) {
          for (const u of users) {
            const login = String(u.name || "").trim();
            const firstRaw = cleanGlpiHtml(u.firstname || "").trim();
            const lastRaw = cleanGlpiHtml(u.realname || "").trim();
            const fullName =
              [firstRaw, lastRaw].filter(Boolean).join(" ").replace(/\s+/g, " ").trim() ||
              login ||
              "Solicitante";
            const firstName = (firstRaw || fullName).split(/\s+/)[0] || login || "Solicitante";
            const entry = {
              login,
              firstName,
              fullName,
              displayName: fullName,
            };
            if (login) map.set(login.toLowerCase(), entry);
            if (u.id !== undefined && u.id !== null) map.set(String(u.id), entry);
          }
        }
      }
      if (map.size > 0) {
        GLPIClient._usersMap = map;
        GLPIClient._usersMapTime = now;
      }
    } catch {
      // ignora falha caso endpoint User não esteja acessível
    }
    return map;
  }

  _resolveUser(rawUser) {
    const rawStr = cleanGlpiHtml(String(rawUser || "Solicitante")).trim();
    const map = GLPIClient._usersMap;
    if (map) {
      const found = map.get(rawStr.toLowerCase()) || map.get(rawStr);
      if (found) return found;
    }
    const firstName = rawStr.split(/\s+/)[0] || "Solicitante";
    return {
      login: rawStr,
      firstName,
      fullName: rawStr,
      displayName: rawStr,
    };
  }

  async _killSession(sessionToken) {
    try {
      await fetch(`${this.baseUrl}/killSession`, {
        headers: this._authHeaders(sessionToken),
      });
    } catch {
      // ignora erro ao encerrar sessão
    }
  }

  _authHeaders(sessionToken) {
    const headers = {
      "Content-Type": "application/json",
      "Session-Token": sessionToken,
    };
    if (this.settings.glpi_app_token && this.settings.glpi_app_token.trim()) {
      headers["App-Token"] = this.settings.glpi_app_token.trim();
    }
    return headers;
  }

  async listTickets({ groupFilter = null, statusFilter = null, searchQuery = null } = {}) {
    let items = [];
    if (this.settings.glpi_demo_mode) {
      items = DEMO_TICKETS.map((t) => structuredClone(t));
    } else {
      items = await this._fetchRealTickets();
    }

    // Garante que chamados Solucionados (5), Fechados (6) ou Excluídos nunca permaneçam na fila
    items = items.filter(
      (t) =>
        t.status_id !== 5 &&
        t.status_id !== 6 &&
        !t.is_closed_or_solved &&
        !/solucionado|fechado/i.test(t.status_label || "")
    );

    if (groupFilter && !["todos", "all", ""].includes(groupFilter.toLowerCase())) {
      const gf = groupFilter.toLowerCase();
      items = items.filter((t) => (t.assigned_group || "").toLowerCase().includes(gf));
    }

    if (statusFilter && Number(statusFilter) > 0) {
      items = items.filter((t) => t.status_id === Number(statusFilter));
    }

    if (searchQuery && searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      items = items.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.content.toLowerCase().includes(q) ||
          t.requester.toLowerCase().includes(q) ||
          (t.requester_login || "").toLowerCase().includes(q) ||
          t.category.toLowerCase().includes(q) ||
          String(t.id) === q
      );
    }

    return items;
  }

  async getTicket(ticketId) {
    const idNum = Number(ticketId);
    if (this.settings.glpi_demo_mode) {
      const found = DEMO_TICKETS.find((t) => t.id === idNum);
      return found ? structuredClone(found) : null;
    }

    const tickets = await this._fetchRealTickets(idNum);
    return tickets.length > 0 ? tickets[0] : null;
  }

  _deriveGroupFromCategory(categoryStr, rawGroupAssign) {
    if (rawGroupAssign && String(rawGroupAssign) !== "0") {
      return cleanGlpiHtml(String(rawGroupAssign));
    }
    const cat = cleanGlpiHtml(String(categoryStr || ""));
    if (!cat || cat === "0" || cat === "Não categorizado") return "T.I - Geral";
    const parts = cat.split(">").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2 && parts[0].toUpperCase().includes("T.I")) {
      const sub = parts[1].toUpperCase();
      const map = {
        ST: "T.I > ST (Service Desk)",
        IR: "T.I > IR (Infra & Redes)",
        DV: "T.I > DV (Desenvolvimento)",
        SI: "T.I > SI (Segurança)",
        BD: "T.I > BD (Banco de Dados)",
        TR: "T.I > TR (Treinamentos)",
      };
      return map[sub] || `${parts[0]} > ${parts[1]}`;
    }
    return parts.slice(0, 2).join(" > ") || "T.I - Geral";
  }

  async _fetchRealTickets(specificId = null) {
    const sessionToken = await this._initSession();
    const headers = this._authHeaders(sessionToken);
    const results = [];

    try {
      await this._ensureUsersMap(headers);

      let rawTickets = [];
      if (specificId) {
        const res = await fetch(`${this.baseUrl}/Ticket/${specificId}?expand_dropdowns=true`, {
          headers,
        });
        if (res.ok) {
          rawTickets = [await res.json()];
        }
      } else {
        const res = await fetch(
          `${this.baseUrl}/Ticket?expand_dropdowns=true&sort=id&order=DESC&range=0-180`,
          { headers }
        );
        if (res.ok) {
          const parsed = await res.json();
          rawTickets = Array.isArray(parsed) ? parsed : [];
        }
      }

      for (const rt of rawTickets) {
        const tid = Number(rt.id || 0);
        const isDeleted = Number(rt.is_deleted || 0) === 1;
        const statusId = Number(rt.status || 1);
        const hasCloseDate = Boolean(
          rt.closedate &&
            String(rt.closedate).trim() !== "" &&
            String(rt.closedate) !== "null"
        );
        const hasSolveDate = Boolean(
          rt.solvedate &&
            String(rt.solvedate).trim() !== "" &&
            String(rt.solvedate) !== "null" &&
            statusId >= 5
        );
        const isClosedOrSolved =
          isDeleted ||
          statusId === 5 ||
          statusId === 6 ||
          hasCloseDate ||
          hasSolveDate ||
          /solucionado|fechado|solved|closed/i.test(String(rt.status || ""));

        if (!specificId && isClosedOrSolved) {
          continue;
        }

        const urgencyId = Number(rt.urgency || 3);
        const rawCat = rt.itilcategories_id;
        const categoryVal =
          rawCat && String(rawCat) !== "0"
            ? cleanGlpiHtml(String(rawCat))
            : "Não categorizado";

        const followups = [];
        // Busca acompanhamentos apenas quando consulta um chamado específico (deixa a listagem 20x mais rápida)
        if (specificId) {
          try {
            const fRes = await fetch(
              `${this.baseUrl}/Ticket/${tid}/ITILFollowup?expand_dropdowns=true`,
              { headers }
            );
            if (fRes.ok) {
              const fJson = await fRes.json();
              if (Array.isArray(fJson)) {
                for (const f of fJson) {
                  const fAuthor = this._resolveUser(f.users_id || "Usuário");
                  followups.push({
                    id: Number(f.id || 0),
                    author: fAuthor.displayName,
                    date: String(f.date || ""),
                    content: cleanGlpiHtml(f.content || ""),
                    is_private: Boolean(Number(f.is_private || 0)),
                  });
                }
              }
            }
          } catch {
            // ignora erro ao buscar followups individuais
          }
        }

        const titleClean = cleanGlpiHtml(rt.name || `Chamado #${tid}`);
        const contentClean = cleanGlpiHtml(rt.content || "");

        const rawLoc = rt.locations_id;
        let locationClean =
          rawLoc && String(rawLoc) !== "0" ? cleanGlpiHtml(String(rawLoc)) : "";
        if (!locationClean) {
          const setorMatch = contentClean.match(/Setor Solicitante:\s*([^\n]+)/i);
          if (setorMatch && setorMatch[1]) {
            locationClean = setorMatch[1].trim();
          }
        }

        const userResolved = this._resolveUser(rt.users_id_recipient || "Solicitante");

        results.push({
          id: tid,
          title: titleClean,
          content: contentClean,
          status_id: statusId,
          status_label: STATUS_MAP[statusId] || "Aberto",
          is_closed_or_solved: isClosedOrSolved,
          urgency_id: urgencyId,
          urgency_label: URGENCY_MAP[urgencyId] || "Média",
          priority_id: Number(rt.priority || 3),
          category: categoryVal,
          requester: userResolved.displayName,
          requester_first_name: userResolved.firstName,
          requester_login: userResolved.login,
          requester_department: locationClean,
          assigned_group: this._deriveGroupFromCategory(categoryVal, rt.groups_id_assign),
          assigned_tech: "",
          created_at: String(rt.date || ""),
          updated_at: String(rt.date_mod || ""),
          followups,
          has_analysis: false,
        });
      }

      if (!specificId) {
        results.sort((a, b) => {
          const aIsRoutine = /\[R\]\s*$/i.test(a.title);
          const bIsRoutine = /\[R\]\s*$/i.test(b.title);
          if (aIsRoutine !== bIsRoutine) {
            return aIsRoutine ? 1 : -1;
          }
          return b.id - a.id;
        });
      }
    } finally {
      await this._killSession(sessionToken);
    }

    return results;
  }

  async addFollowup(ticketId, content, isPrivate = true, markPending = false) {
    const idNum = Number(ticketId);
    const now = new Date();
    const nowStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate()
    ).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(
      now.getMinutes()
    ).padStart(2, "0")}`;

    const newFollowup = {
      id: Date.now(),
      author: "Copiloto TI (Analista)",
      date: nowStr,
      content,
      is_private: Boolean(isPrivate),
    };

    if (this.settings.glpi_demo_mode) {
      const t = DEMO_TICKETS.find((item) => item.id === idNum);
      if (t) {
        t.followups.push(newFollowup);
        t.updated_at = nowStr;
        if (markPending) {
          t.status_id = 4;
          t.status_label = STATUS_MAP[4];
        } else if (!isPrivate && t.status_id === 1) {
          t.status_id = 2;
          t.status_label = STATUS_MAP[2];
        }
      }
      const tipo = isPrivate
        ? "Nota Privada (Técnica)"
        : "Acompanhamento Público (Resposta ao Solicitante)";
      return {
        ok: true,
        message: `${tipo} registrado com sucesso no Chamado #${idNum} (Modo Simulação)!`,
        followup: newFollowup,
      };
    }

    const sessionToken = await this._initSession();
    const headers = this._authHeaders(sessionToken);
    try {
      const payload = {
        input: {
          itemtype: "Ticket",
          items_id: idNum,
          content: content.replace(/\n/g, "<br>"),
          is_private: isPrivate ? 1 : 0,
        },
      };
      const res = await fetch(`${this.baseUrl}/Ticket/${idNum}/ITILFollowup`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ao enviar acompanhamento para o GLPI`);
      }

      let newStatusId = null;
      let newStatusLabel = null;

      if (markPending) {
        const putRes = await fetch(`${this.baseUrl}/Ticket/${idNum}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ input: { id: idNum, status: 4 } }),
        });
        if (!putRes.ok) {
          await fetch(`${this.baseUrl}/Ticket`, {
            method: "PUT",
            headers,
            body: JSON.stringify({ input: [{ id: idNum, status: 4 }] }),
          });
        }
        newStatusId = 4;
        newStatusLabel = STATUS_MAP[4];
      }

      const tipo = isPrivate
        ? "Nota Privada (Técnica)"
        : "Acompanhamento Público (Resposta ao Solicitante)";
      const statusSuffix = markPending ? " Status alterado para Pendente." : "";
      return {
        ok: true,
        message: `${tipo} enviado para o GLPI no Chamado #${idNum}!${statusSuffix}`,
        followup: newFollowup,
        status_id: newStatusId,
        status_label: newStatusLabel,
      };
    } finally {
      await this._killSession(sessionToken);
    }
  }

  async fetchCategories() {
    if (this.settings.glpi_demo_mode) {
      return [
        { id: 75, name: "Acesso e Permissões", completename: "T.I > ST > Acesso e Permissões" },
        { id: 71, name: "Aplicativos", completename: "T.I > ST > Instalação/Configuração > Aplicativos" },
        { id: 73, name: "Erros de Sistema", completename: "T.I > ST > Resolução de Problemas > Erros de Sistema" },
        { id: 121, name: "Correção de bugs", completename: "T.I > DV > Desenvolvimento > Correção de bugs" },
        { id: 149, name: "Impressoras", completename: "T.I > IR > Suporte a Hardware > Periféricos > Impressoras" },
      ];
    }

    const now = Date.now();
    if (GLPIClient._catCache && now - GLPIClient._catCacheTime < 600000) {
      return GLPIClient._catCache;
    }

    const sessionToken = await this._initSession();
    const headers = this._authHeaders(sessionToken);
    const categories = [];
    try {
      const res = await fetch(`${this.baseUrl}/ITILCategory?range=0-250`, {
        headers,
      });
      if (res.ok) {
        const items = await res.json();
        if (Array.isArray(items)) {
          for (const item of items) {
            const id = Number(item.id || 0);
            const name = cleanGlpiHtml(item.name || "");
            const completename = cleanGlpiHtml(item.completename || name);
            if (id > 0 && completename) {
              categories.push({ id, name, completename });
            }
          }
        }
      }
      categories.sort((a, b) => a.completename.localeCompare(b.completename, "pt-BR"));
      if (categories.length > 0) {
        GLPIClient._catCache = categories;
        GLPIClient._catCacheTime = now;
      }
      return categories;
    } finally {
      await this._killSession(sessionToken);
    }
  }

  async updateTicketCategory(ticketId, categoryId, categoryName = "") {
    const idNum = Number(ticketId);
    const catIdNum = Number(categoryId);
    if (!idNum || !catIdNum) {
      throw new Error("ID do chamado e ID da categoria são obrigatórios.");
    }

    let resolvedCategoryName = categoryName;
    if (!resolvedCategoryName) {
      const cats = await this.fetchCategories();
      const found = cats.find((c) => c.id === catIdNum);
      if (found) resolvedCategoryName = found.completename;
    }

    const assignedGroup = this._deriveGroupFromCategory(
      resolvedCategoryName,
      null
    );

    if (this.settings.glpi_demo_mode) {
      const t = DEMO_TICKETS.find((item) => item.id === idNum);
      if (t) {
        t.category = resolvedCategoryName || t.category;
        t.assigned_group = assignedGroup;
      }
      return {
        ok: true,
        ticket_id: idNum,
        category_id: catIdNum,
        category: resolvedCategoryName,
        assigned_group: assignedGroup,
        message: `Categoria do Chamado #${idNum} atualizada para "${resolvedCategoryName}" (Modo Simulação)!`,
      };
    }

    const sessionToken = await this._initSession();
    const headers = this._authHeaders(sessionToken);
    try {
      const putRes = await fetch(`${this.baseUrl}/Ticket/${idNum}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          input: { id: idNum, itilcategories_id: catIdNum },
        }),
      });
      if (!putRes.ok) {
        const fallbackRes = await fetch(`${this.baseUrl}/Ticket`, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            input: [{ id: idNum, itilcategories_id: catIdNum }],
          }),
        });
        if (!fallbackRes.ok) {
          throw new Error(
            `HTTP ${putRes.status} ao atualizar categoria do chamado no GLPI`
          );
        }
      }

      return {
        ok: true,
        ticket_id: idNum,
        category_id: catIdNum,
        category: resolvedCategoryName,
        assigned_group: assignedGroup,
        message: `Categoria do Chamado #${idNum} alterada no GLPI para "${resolvedCategoryName}"!`,
      };
    } finally {
      await this._killSession(sessionToken);
    }
  }

  async fetchKbArticles() {
    if (this.settings.glpi_demo_mode) {
      return DEMO_KB_ARTICLES;
    }

    const now = Date.now();
    if (GLPIClient._kbCache && now - GLPIClient._kbCacheTime < 60000) {
      return GLPIClient._kbCache;
    }

    const sessionToken = await this._initSession();
    const headers = this._authHeaders(sessionToken);
    const articles = [];
    try {
      const res = await fetch(`${this.baseUrl}/KnowbaseItem?range=0-80&expand_dropdowns=true`, {
        headers,
      });
      if (res.ok) {
        const items = await res.json();
        if (Array.isArray(items)) {
          for (const item of items) {
            const answerClean = cleanGlpiHtml(item.answer || "");
            const lines = answerClean
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean);
            const rawCat = item.knowbaseitemcategories_id;
            const catClean =
              rawCat && String(rawCat) !== "0"
                ? cleanGlpiHtml(String(rawCat))
                : "Base de Conhecimento GLPI";
            articles.push({
              id: `KB-${item.id}`,
              title: cleanGlpiHtml(item.name || "Artigo KB"),
              category: catClean,
              summary:
                answerClean.slice(0, 320) + (answerClean.length > 320 ? "..." : ""),
              keywords: [],
              steps: lines.length > 0 ? lines.slice(0, 6) : [answerClean],
            });
          }
        }
      }
      GLPIClient._kbCache = articles;
      GLPIClient._kbCacheTime = now;
    } catch {
      // ignora erro de leitura da KB
    } finally {
      await this._killSession(sessionToken);
    }
    return articles;
  }

  async fetchResolvedHistory() {
    if (this.settings.glpi_demo_mode) {
      return DEMO_RESOLVED_HISTORY;
    }

    const now = Date.now();
    if (GLPIClient._resolvedCache && now - GLPIClient._resolvedCacheTime < 60000) {
      return GLPIClient._resolvedCache;
    }

    // Carrega a base histórica cumulativa já persistida localmente (apenas itens já validados como T.I)
    const existingList = loadResolvedHistoryCache();
    const byId = new Map();
    for (const item of existingList) {
      if (item && item.id && item.is_ti_group === true) {
        byId.set(item.id, item);
      }
    }

    const sessionToken = await this._initSession();
    const headers = this._authHeaders(sessionToken);
    try {
      // 1. Busca os IDs de chamados atribuídos ao Grupo T.I (Group ID = 12, type = 2 [Atribuído])
      const tiTicketIds = new Set();
      const gtRes = await fetch(
        `${this.baseUrl}/Group/12/Group_Ticket?range=0-1500&sort=id&order=DESC`,
        { headers }
      );
      if (gtRes.ok) {
        const gtItems = await gtRes.json();
        if (Array.isArray(gtItems)) {
          for (const gt of gtItems) {
            if (Number(gt.type) === 2 && Number(gt.tickets_id) > 0) {
              tiTicketIds.add(Number(gt.tickets_id));
            }
          }
        }
      }

      // Revalida entradas antigas do cache local caso ainda não tivessem a flag is_ti_group
      if (tiTicketIds.size > 0) {
        for (const item of existingList) {
          const tid =
            Number(item?.ticket_id) ||
            Number((String(item?.id || "").match(/(\d+)/) || [])[1]) ||
            0;
          if (tid > 0 && tiTicketIds.has(tid)) {
            byId.set(item.id, { ...item, is_ti_group: true });
          }
        }
      }

      // 2. Busca soluções no GLPI e retém exclusivamente as de chamados atribuídos ao Grupo T.I
      const res = await fetch(
        `${this.baseUrl}/ITILSolution?range=0-500&sort=id&order=DESC&expand_dropdowns=true`,
        { headers }
      );
      if (res.ok) {
        const items = await res.json();
        if (Array.isArray(items)) {
          for (const sol of items) {
            if (sol.itemtype && sol.itemtype !== "Ticket") continue;
            const solText = cleanGlpiHtml(sol.content || "");
            if (!solText) continue;

            // Extrai o ID numérico do chamado pelo link href
            let ticketIdNum = 0;
            const ticketLink = (sol.links || []).find((l) => l.rel === "Ticket");
            if (ticketLink && ticketLink.href) {
              const match = ticketLink.href.match(/\/Ticket\/(\d+)/);
              if (match) ticketIdNum = Number(match[1]);
            }

            // Filtra estritamente chamados atribuídos ao grupo T.I
            if (!ticketIdNum || !tiTicketIds.has(ticketIdNum)) {
              continue;
            }

            const titleClean = cleanGlpiHtml(
              String(sol.items_id || `Chamado #${ticketIdNum}`)
            );
            const steps = solText
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean);

            const entryId = `Chamado #${ticketIdNum} (Resolvido)`;
            byId.set(entryId, {
              id: entryId,
              ticket_id: ticketIdNum,
              solution_id: Number(sol.id) || 0,
              title: titleClean,
              category: sol.users_id
                ? `T.I • Solucionado por ${sol.users_id}`
                : "T.I • Histórico GLPI",
              is_ti_group: true,
              summary: solText.slice(0, 350),
              keywords: [],
              steps: steps.length > 0 ? steps.slice(0, 6) : [solText],
            });
          }
        }
      }
    } catch {
      // Se houver falha momentânea de rede, usa a base cumulativa salva em disco
    } finally {
      await this._killSession(sessionToken);
    }

    const mergedList = Array.from(byId.values()).sort((a, b) => {
      const idA = a.ticket_id || Number((String(a.id).match(/(\d+)/) || [])[1]) || 0;
      const idB = b.ticket_id || Number((String(b.id).match(/(\d+)/) || [])[1]) || 0;
      return idB - idA;
    });

    saveResolvedHistoryCache(mergedList);

    GLPIClient._resolvedCache = mergedList;
    GLPIClient._resolvedCacheTime = now;
    return mergedList;
  }
}
