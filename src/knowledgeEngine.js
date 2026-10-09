import fs from "node:fs";
import { PLAYBOOKS_FILE, loadLearnedFeedback } from "./config.js";

const STOPWORDS = new Set([
  "a", "ao", "aos", "aquela", "aquelas", "aquele", "aqueles", "aquilo", "as", "ate",
  "com", "como", "da", "das", "de", "dela", "delas", "dele", "deles", "depois",
  "do", "dos", "e", "ela", "elas", "ele", "eles", "em", "entre", "era", "eram",
  "essa", "essas", "esse", "esses", "esta", "estao", "estar", "estas", "este",
  "estes", "estou", "eu", "foi", "for", "foram", "ha", "isso", "isto", "ja", "la",
  "lhe", "lhes", "mais", "mas", "me", "mesmo", "meu", "meus", "minha", "minhas",
  "muito", "na", "nao", "nas", "nem", "no", "nos", "nossa", "nossas", "nosso",
  "nossos", "num", "numa", "o", "os", "ou", "para", "pela", "pelas", "pelo",
  "pelos", "por", "qual", "quando", "que", "quem", "sao", "se", "seja", "sem",
  "ser", "seu", "seus", "so", "sua", "suas", "tambem", "te", "tem", "tendo",
  "tenho", "ter", "teu", "teus", "ti", "toda", "todas", "todo", "todos", "tu",
  "tua", "tuas", "tudo", "um", "uma", "umas", "uns", "voce", "voces", "bom",
  "dia", "boa", "tarde", "noite", "favor", "pessoal", "preciso", "ajuda", "oi",
  // Termos genéricos de cabeçalho do FormCreator / Categorias GLPI / Saudação
  "suporte", "tecnico", "service", "desk", "solicitacao", "solicitacoes", "diversa",
  "tipo", "setor", "solicitante", "dados", "descricao", "observacoes", "obsevacoes",
  "anexo", "ativos", "ativo", "chamado", "unimed", "hospital", "realizado", "realizada",
  "conforme", "solicitado", "atendimento", "usuario", "usuarios", "favor", "verificar",
  "infraestrutura", "redes", "hardware", "perifericos", "periferico", "observador",
  "localizacao", "titulo", "solicito", "urgencia", "urgente", "sistema", "sistemas",
  "operacionais", "operacional", "aplicativos", "aplicativo", "instalacao", "configuracao",
  "resolucao", "problemas", "problema", "prezados", "prezado", "prezada", "gentileza",
  "compreensao", "agradeco", "atencao", "presteza", "atenciosamente", "att", "obrigado",
  "obrigada", "segue", "hoje", "data", "colaboradora", "colaborador", "devido", "certa",
  "certo", "vossa", "arquivos", "arquivo", "print"
]);

export function normalizeText(text) {
  if (!text) return "";
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function extractTokens(text) {
  const norm = normalizeText(text);
  const matches = norm.match(/[a-z0-9_:-]{2,}/g) || [];
  return [
    ...new Set(matches.filter((t) => !STOPWORDS.has(t) && !/^\d+$/.test(t))),
  ];
}

export function extractFormCreatorFields(rawContent) {
  const text = String(rawContent || "");
  const getField = (regex) => {
    const m = text.match(regex);
    if (!m || !m[1]) return "";
    const val = m[1].trim();
    if (/^\d+\)\s*/.test(val) || /^▸/.test(val)) return "";
    return val;
  };

  const tipo = getField(/Tipo de Solicita[çc][ãa]o\s*:\s*([^\n]+)/i);
  const setor = getField(/Setor Solicitante\s*:\s*([^\n]+)/i);
  const localizacao = getField(/Localiza[çc][ãa]o\s*:\s*([^\n]+)/i);
  const tituloInterno = getField(/\d+\)\s*T[íi]tulo\s*:\s*([^\n]+)/i);
  const ativo = getField(/\bAtivos?\s*:\s*([^\n▸]+)/i);
  const nomeColaborador = getField(/\d+\)\s*(?:Nome|Colaboradora?)\s*:\s*([^\n]+)/i);
  const cpf = getField(/\bCPF\s*:\s*([^\n]+)/i);
  const unidade = getField(/\bUnidade\s*:\s*([^\n]+)/i);
  const setorAlvo = getField(/\d+\)\s*Setor\s*:\s*([^\n]+)/i);
  const acessos = getField(/\bAcessos?\s*:\s*([^\n▸]+)/i);
  const motivo = getField(/\bMotivo\s*:\s*([^\n▸]+)/i);
  const problema = getField(/\bProblema\s*:\s*([^\n▸]+)/i);
  const aplicacao = getField(/\bAplica[çc][ãa]o\s*:\s*([^\n▸]+)/i);

  let descricao = "";
  const descMatch = text.match(
    /(?:Descri[çc][ãa]o|Obseva[çc][õo]es|Observa[çc][õo]es)\s*:\s*([\s\S]*?)(?:\n\s*\d+\)\s*(?:Anexo|Arquivos?|Ativos?)|\n\s*▸|$)/i
  );
  if (descMatch && descMatch[1]) {
    descricao = descMatch[1].replace(/\n{2,}/g, "\n").trim();
  } else {
    descricao = text.trim();
  }

  return {
    tipo,
    setor,
    localizacao,
    tituloInterno,
    ativo,
    nomeColaborador,
    cpf,
    unidade,
    setorAlvo,
    acessos,
    motivo,
    problema,
    aplicacao,
    descricao,
  };
}

export function loadPlaybooks() {
  if (!fs.existsSync(PLAYBOOKS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(PLAYBOOKS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

export function savePlaybooks(playbooks) {
  fs.writeFileSync(PLAYBOOKS_FILE, JSON.stringify(playbooks, null, 2), "utf-8");
  return playbooks;
}

export function computeRelevance(
  ticketText,
  ticketTokens,
  candidateTitle,
  candidateSummary,
  candidateKeywords = []
) {
  const normTicket = normalizeText(ticketText);
  const normCandidate = normalizeText(`${candidateTitle} ${candidateSummary}`);
  const candTokens = new Set(extractTokens(normCandidate));
  const tTokens = new Set(ticketTokens);

  if (tTokens.size === 0) return 0.0;

  const uniqueKws = [
    ...new Set(
      (candidateKeywords || []).map((kw) => normalizeText(kw)).filter(Boolean)
    ),
  ];

  let kwHits = 0;
  for (const nKw of uniqueKws) {
    if (!nKw.includes(" ") && nKw.length <= 5) {
      const escaped = nKw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\b`).test(normTicket)) {
        kwHits += 1;
      }
    } else if (normTicket.includes(nKw)) {
      kwHits += 1;
    }
  }

  const kwScore =
    uniqueKws.length > 0 ? Math.min(1.0, kwHits / 2.0) : 0.0;

  let overlap = 0;
  for (const tok of tTokens) {
    if (candTokens.has(tok)) overlap += 1;
  }
  const tokenScore = Math.min(1.0, overlap / 5.0);

  const finalScore =
    uniqueKws.length > 0
      ? Number((kwScore * 0.75 + tokenScore * 0.25).toFixed(2))
      : Number((tokenScore * 0.85).toFixed(2));

  return Math.min(0.99, finalScore);
}

export class KnowledgeEngine {
  constructor(glpiClient) {
    this.glpiClient = glpiClient;
  }

  async searchAllLayers(ticket, topK = 4) {
    const isRoutine = /\[r\]\s*$/i.test(ticket.title);
    const formFields = extractFormCreatorFields(ticket.content);
    const publicFollowups = (ticket.followups || [])
      .filter((f) => !f.is_private)
      .map((f) => f.content)
      .join(" ");

    // Usa apenas o título útil, tipo, ativo, motivo e a descrição real do usuário (evitando nomes de observadores e cabeçalhos)
    const cleanTitle = ticket.title.split(">").slice(-2).join(" ");
    const fullTicketText = [
      cleanTitle,
      formFields.tipo,
      formFields.tituloInterno,
      formFields.problema,
      formFields.aplicacao,
      formFields.ativo,
      formFields.motivo,
      formFields.acessos,
      formFields.descricao,
      publicFollowups,
    ]
      .filter(Boolean)
      .join(" ");

    const normTicket = normalizeText(fullTicketText);
    const ticketTokens = extractTokens(fullTicketText);
    const matches = [];

    // 3ª Camada: Playbooks Locais da Equipe de TI
    let bestPlaybookScore = 0;
    if (!isRoutine) {
      const playbooks = loadPlaybooks();
      for (const pb of playbooks) {
        // Evita parear Playbook exclusivo do HRP/TNUMM quando o chamado é de outro sistema (ex: S.G.H. / Spdata) ou unificação de cadastro
        if (
          pb.id === "PB-UNI-05" &&
          (!/\b(hrp|tnumm|promoprev|0256)\b/i.test(normTicket) ||
            /\b(unifica|unificar|unificacao|mais de um cadastro|2 cadastros|dois cadastros|duplicad)\b/i.test(
              normTicket
            ))
        ) {
          continue;
        }
        // Evita parear Playbook de Cancelamento de Registro (PB-UNI-13) quando o chamado é de acesso/vinculação no Controle de Contas
        if (
          pb.id === "PB-UNI-13" &&
          !/\b(cancelar|cancelamento|excluir|exclusao|engano|estornar|inativar|remover)\b/i.test(
            normTicket
          )
        ) {
          continue;
        }
        // Evita parear Playbook exclusivo do AutoLac (PB-UNI-04) quando o chamado não cita AutoLac
        if (pb.id === "PB-UNI-04" && !normTicket.includes("autolac")) {
          continue;
        }
        // Evita parear Playbook de Formulários Clínicos de Enfermagem (PB-UNI-09) quando o chamado pede apenas indicadores/relatórios ou agenda no PEP
        if (
          pb.id === "PB-UNI-09" &&
          !/\b(formulario|sonda|folley|cateterismo|passagem de plantao|enfermagem)\b/i.test(
            normTicket
          )
        ) {
          continue;
        }
        // Evita parear Playbook de Agenda no PEP (PB-UNI-18) quando o chamado não menciona agenda ou quando trata da Agenda Oncologia (PB-UNI-30)
        if (
          pb.id === "PB-UNI-18" &&
          (!/\bagenda\b/i.test(normTicket) || /\boncologia\b/i.test(normTicket))
        ) {
          continue;
        }
        // Evita parear Playbook de Unificação de Cadastro (PB-UNI-19) quando o chamado não trata de unificação/duplicidade de cadastro
        if (
          pb.id === "PB-UNI-19" &&
          !/\b(unifica|unificar|unificacao|mais de um cadastro|2 cadastros|dois cadastros|cadastro duplicado|cadastros duplicados|unificar as chaves)\b/i.test(
            normTicket
          )
        ) {
          continue;
        }
        // Evita parear PB-UNI-12 (Médico/Prestador/Acesso) quando o chamado trata de clínicas no Web Saúde, de hardware/infraestrutura (nobreak, impressora, telefone, etc.), unificação de cadastros, erros de sistema no HRP/SGH ou quando não possui contexto de concessão de acesso/permissão
        if (pb.id === "PB-UNI-12") {
          const isHardwareOrInfra =
            /\b(nobreak|no-break|ups|bateria|gerador|energia|impressora|toner|papel|telefone|ramal|pabx|cabo de rede|wifi|wi-fi|remanejamento|formatar|computador)\b/i.test(
              normTicket
            );
          const isUnification =
            /\b(unifica|unificar|unificacao|duplicad|duplicidade)\b/i.test(
              normTicket
            );
          const isSystemError =
            /\b(dando erro|aparece este erro|erro ao salvar|erro para eu salvar|erro para salvar|falha ao salvar|erros de sistema|abrir um chamado na federa[çc][ãa]o)\b/i.test(
              normTicket
            ) ||
            ticket.category.includes("Erros de Sistema");
          const hasAccessContext =
            (/\b(acesso|acessos|permissao|permissoes|liberar|usuario|login|facial|catraca|porta|portas|biometria)\b/i.test(
              normTicket
            ) ||
              /\bfavor cadastrar\b|\bliberar acesso\b/i.test(normTicket)) &&
            !isSystemError;
          const isWebSaudeNas =
            /\b(web\s*sa[uú]de|clinicas?|16\d{6}|atendentes?\s+do\s+nas|nas\s+passos)\b/i.test(
              normTicket
            );

          if (isWebSaudeNas || isHardwareOrInfra || isUnification || !hasAccessContext || isSystemError) {
            continue;
          }
        }
        // Evita parear PB-UNI-35 (Erro de Sistema no HRP / Federação) quando o chamado não trata de erro no HRP ou contratos/prestador/Federação
        if (
          pb.id === "PB-UNI-35" &&
          (!/\b(hrp|federa[çc][ãa]o)\b/i.test(normTicket) ||
            !/\b(contrato|contratos|prestador|prestadores|salvar|erro|dando erro)\b/i.test(
              normTicket
            ))
        ) {
          continue;
        }
        // Evita parear PB-UNI-25 quando o chamado NÃO trata de clínicas, Web Saúde ou atendentes do NAS, ou quando se trata de CRIAÇÃO DE USUÁRIO de secretária (PB-UNI-27) ou criação de formulários no GLPI
        if (
          pb.id === "PB-UNI-25" &&
          (!/\b(web\s*sa[uú]de|clinicas?|16\d{6}|atendentes?\s+do\s+nas|nas\s+passos|nas\b)\b/i.test(
            normTicket
          ) ||
            /\bcria[çc][ãa]o de usu[áa]rios?\b/i.test(normTicket) ||
            /\borigem\s*:\s*acesso secret[aá]ria\b/i.test(normTicket) ||
            /\b(item no glpi|itens no glpi|formul[aá]rio(s)? no glpi|formcreator|criar novos? itens?|criar novos? formul[aá]rios?)\b/i.test(
              normTicket
            ))
        ) {
          continue;
        }
        // Evita parear PB-UNI-27 quando o chamado NÃO trata de criação de usuário de secretária/prestador no Web Saúde ou trata de formulários no GLPI
        if (
          pb.id === "PB-UNI-27" &&
          (!/\b(secret[aá]ria|prestador|web\s*sa[uú]de|16\d{6})\b/i.test(normTicket) ||
            !/\b(cria[çc][ãa]o de usu[áa]rios?|cadastr(ar|o)|novo usu[áa]rio)\b/i.test(normTicket) ||
            /\b(item no glpi|itens no glpi|formul[aá]rio(s)? no glpi|formcreator|criar novos? itens?|criar novos? formul[aá]rios?)\b/i.test(
              normTicket
            ))
        ) {
          continue;
        }
        // Evita parear PB-UNI-16 (Extração de Indicadores/Relatórios) quando o chamado trata de agenda de profissional ou não cita indicadores/relatórios/wconect
        if (
          pb.id === "PB-UNI-16" &&
          (/\bagenda\b/i.test(normTicket) ||
            !/\b(indicador|indicadores|wconect|wconnect|produtividade|relat[oó]rio|extra[çc][ãa]o|levantamento)\b/i.test(
              normTicket
            ))
        ) {
          continue;
        }
        // Evita parear PB-UNI-18 (Agenda de Profissional no Prontu+) quando o chamado trata de Oncologia ou não cita agenda
        if (
          pb.id === "PB-UNI-18" &&
          (/\boncologia\b/i.test(normTicket) || !/\bagenda\b/i.test(normTicket))
        ) {
          continue;
        }
        // Evita parear PB-UNI-26 (Nobreak/UPS) quando o chamado não trata de nobreak, ups ou energia
        if (
          pb.id === "PB-UNI-26" &&
          !/\b(nobreak|no-break|ups|energia|bateria|estabilizador)\b/i.test(normTicket)
        ) {
          continue;
        }
        // Evita parear PB-UNI-28 (Reabertura de Registro) quando o chamado não trata de reabertura de conta/registro ou quando trata de desenvolvimento/parametrização
        if (
          pb.id === "PB-UNI-28" &&
          (!/\b(reabrir|reabertura|abrir conta|abrir contas|abrir registro|encerrad[ao] erroneamente)\b/i.test(
            normTicket
          ) ||
            /\b(parametrizar|parametriza[çc][ãa]o|viabilidade|melhoria|novas aplica[çc][õo]es)\b/i.test(
              normTicket
            ))
        ) {
          continue;
        }
        // Evita parear PB-UNI-32 (Melhoria Controle de Contas / Desenvolvimento) quando o chamado não trata de parametrização/melhoria no Controle de Contas
        if (
          pb.id === "PB-UNI-32" &&
          (!normTicket.includes("controle de contas") ||
            !/\b(parametrizar|parametriza[çc][ãa]o|viabilidade|melhoria|novas aplica[çc][õo]es|data da alta|data de alta|encaminhamento autom[aá]tico)\b/i.test(
              normTicket
            ))
        ) {
          continue;
        }
        // Evita parear PB-UNI-29 (Criação de Formulários GLPI) quando o chamado não trata de itens/formulários no GLPI
        if (
          pb.id === "PB-UNI-29" &&
          !/\b(item no glpi|itens no glpi|formul[aá]rio(s)? no glpi|formcreator|criar novos? itens?|criar novos? formul[aá]rios?|novo item no glpi|novos itens no glpi|op[çc][õo]es do faturamento|destino autom[aá]tico do chamado)\b/i.test(
            normTicket
          )
        ) {
          continue;
        }
        // Evita parear PB-UNI-30 (Agenda Oncologia) quando o chamado não trata do sistema ou agendamento de Oncologia
        if (
          pb.id === "PB-UNI-30" &&
          !/\boncologia\b/i.test(normTicket)
        ) {
          continue;
        }
        // Evita parear PB-UNI-33 (Videoconferência / Reunião Online) quando o chamado não trata de videoconferência / meet / teams / zoom
        if (
          pb.id === "PB-UNI-33" &&
          !/\b(google\s*meet|meet|teams|zoom|videoconfer[eê]ncia|reuni[aã]o\s+online|link\s+(?:d[ea]|para)\s+reuni[aã]o|link\s+no\s+meet)\b/i.test(
            normTicket
          )
        ) {
          continue;
        }
        // Evita parear PB-UNI-14 (Relatórios Agendados SGH) quando o chamado não trata de relatório agendado
        if (
          pb.id === "PB-UNI-14" &&
          !/\b(relat[oó]rio|agendad[ao]|envio|disparo|checklist|check-list|di[aá]ri[ao]|smtp)\b/i.test(
            normTicket
          )
        ) {
          continue;
        }
        // Evita parear PB-UNI-13 (Cancelamento de Registro) quando o chamado trata de exclusão de taxa/serviço no faturamento ou não trata de cancelamento
        if (
          pb.id === "PB-UNI-13" &&
          (/\b(taxa|taxas|diaria|di[aá]rias|procedimento|c[oó]digo\s*\d+|3028)\b/i.test(
            normTicket
          ) ||
            !/\b(cancelar|cancelamento|excluir|exclusao|estornar|cadastrad[ao] por engano)\b/i.test(
              normTicket
            ))
        ) {
          continue;
        }
        // Evita parear PB-UNI-34 (Exclusão de Taxa no Faturamento SGH Spdata) quando não trata de taxa
        if (
          pb.id === "PB-UNI-34" &&
          (!/\b(taxa|taxas)\b/i.test(normTicket) ||
            !/\b(excluir|exclus[aã]o|estornar|estorno|cancelar|cancelamento|retirar|remover|lan[çc]ad[ao]|equivocad)\b/i.test(
              normTicket
            ))
        ) {
          continue;
        }
        const isRelocationOrPhoneInstall =
          /\b(ponto de telefone|linha e aparelho|remanejar|remanejamento|mudar de lugar|mudanca de local|novo ponto de rede)\b/i.test(
            normTicket
          ) ||
          /\b(trocar|mudar|transferir|levar|passar|colocar)\b[\s\S]{0,60}\b(do|da)\b[\s\S]{0,50}\bpara\b/i.test(
            normTicket
          );
        const isScanToEmail =
          (/\b(scan|scanner|digitaliz|digitalizacao)\b/i.test(normTicket) ||
            /\b(cadastr(ar|o))\b[\s\S]{0,30}\b(e-?mail|email)\b/i.test(normTicket) ||
            /\b(e-?mail|email)\b[\s\S]{0,30}\b(impressora|scanner|scan)\b/i.test(normTicket)) &&
          !/\b(nao esta imprimindo|parou de imprimir|spooler|mancha|atolamento|papel preso|qualidade|fila)\b/i.test(
            normTicket
          );
        const isSupplyOrTonerRequest =
          /\b(troca de tonn?er|trocar tonn?er|troca do tonn?er|trocado o tonn?er|substitui[çc][ãa]o de tonn?er|tonn?er vazio|tonn?er fraco|acabou o tonn?er|novo tonn?er)\b/i.test(
            normTicket
          ) ||
          (/\b(tonn?er|toners)\b/i.test(normTicket) &&
            (/\b(troca|trocar|trocado|troque|substitui|substituir|substituicao|substituição|solicito|solicitar|solicitacao|solicitação|colocar|acabou|fornecer)\b/i.test(
              normTicket
            ) ||
              normTicket.includes("suprimentos") ||
              normTicket.includes("toners") ||
              normTicket.includes("impressora"))) ||
          /\b(reposi[çc][ãa]o de tintas?|troca de tintas?|abastecimento de tintas?|refil de tintas?|tintas? da impressora|acabou a tinta|tinta acabou|n[íi]vel de tinta)\b/i.test(
            normTicket
          ) ||
          (/\b(tinta|tintas)\b/i.test(normTicket) &&
            (/\b(impressora|reposi[çc][ãa]o|suprimentos?|epson|ecotank|recarga|abastecer)\b/i.test(normTicket) ||
              normTicket.includes("suprimentos") ||
              normTicket.includes("hardware")));

        // Evita parear Playbook de Falha de Impressão (PB-SD-02) quando o chamado pede remanejamento físico de equipamento ou instalação de ponto de telefone/rede ou cadastro de e-mail/scan ou troca de toner/tintas/suprimentos
        if (
          (pb.id === "PB-SD-02" || pb.id === "PB-UNI-08") &&
          (isRelocationOrPhoneInstall || isScanToEmail || isSupplyOrTonerRequest)
        ) {
          continue;
        }
        // Evita parear PB-UNI-31 (Troca de Toner / Tintas) quando o chamado NÃO trata de toner/tinta/suprimentos
        if (pb.id === "PB-UNI-31" && !isSupplyOrTonerRequest) {
          continue;
        }
        // Evita parear Playbook de Ligações Caindo (PB-UNI-08) quando o chamado NÃO menciona queda/instabilidade de chamadas
        if (
          pb.id === "PB-UNI-08" &&
          !/\b(caindo|queda|quedas|interromp|desconect|cortando|chiando|oscila|instabilidade)\b/i.test(
            normTicket
          )
        ) {
          continue;
        }
        // Evita parear Playbook de Telefone Inoperante (PB-UNI-24) quando o chamado trata de queda/instabilidade ou não trata de telefone
        if (
          pb.id === "PB-UNI-24" &&
          (!/\b(telefone|ramal|voip)\b/i.test(normTicket) ||
            /\b(caindo|quedas?|interromp|ligacoes caindo|ligações caindo)\b/i.test(
              normTicket
            ))
        ) {
          continue;
        }
        // Evita parear Playbook de Scan to E-mail (PB-UNI-23) quando não trata de scan/cadastro de e-mail na impressora
        if (pb.id === "PB-UNI-23" && !isScanToEmail) {
          continue;
        }
        // Evita parear Playbook de XML TISS (PB-UNI-03) quando o chamado não trata de XML, TISS ou Hash
        if (pb.id === "PB-UNI-03" && !/\b(xml|tiss|hash)\b/i.test(normTicket)) {
          continue;
        }
        // Evita parear Playbook de Remanejamento / Ponto de Telefone (PB-UNI-20) quando não há solicitação de mudança de local ou ponto físico
        if (pb.id === "PB-UNI-20" && !isRelocationOrPhoneInstall) {
          continue;
        }
        // Evita parear Playbook de Instalação de Roteador / Wi-Fi (PB-UNI-21) quando não se trata de internet/wifi/roteador
        if (
          pb.id === "PB-UNI-21" &&
          !/\b(roteador|access point|ap wifi|wifi|wi-fi|internet|oscilacao|whatsapp)\b/i.test(
            normTicket
          )
        ) {
          continue;
        }
        // Evita parear Playbook de Onboarding/Ponto/MyPlace (PB-UNI-01) quando o chamado trata de Intranet, permissões de usuário já existente ou secretária externa no Web Saúde
        if (
          pb.id === "PB-UNI-01" &&
          (/\bintranet\b/i.test(normTicket) ||
            /\b(acesso secret[aá]ria|web\s*sa[uú]de|c[oó]digo do prestador|16\d{6})\b/i.test(
              normTicket
            ) ||
            (/\b(ja foi liberado|já foi liberado)\b/i.test(normTicket) &&
              !/\b(ponto|myplace|rep|biometria)\b/i.test(normTicket)))
        ) {
          continue;
        }
        // Evita parear Playbook de Intranet (PB-UNI-22) quando o chamado não cita Intranet
        if (pb.id === "PB-UNI-22" && !/\bintranet\b/i.test(normTicket)) {
          continue;
        }
        let score = computeRelevance(
          fullTicketText,
          ticketTokens,
          pb.title || "",
          `${pb.symptoms || ""} ${(pb.resolution_steps || []).join(" ")}`,
          pb.keywords || []
        );
        if (
          pb.id === "PB-UNI-34" &&
          /\b(taxa|taxas)\b/i.test(normTicket) &&
          (/\b(excluir|exclus[aã]o|estornar|estorno|cancelar|cancelamento|lan[çc]ad[ao]|3028|hospitalar|ambulatorial)\b/i.test(
            normTicket
          ) ||
            normTicket.includes("taxa de registro"))
        ) {
          score = Math.max(score, 0.85);
        }
        if (
          pb.id === "PB-UNI-35" &&
          /\b(hrp|federa[çc][ãa]o)\b/i.test(normTicket) &&
          /\b(contrato|contratos|prestador|prestadores|salvar|erro|dando erro)\b/i.test(
            normTicket
          )
        ) {
          score = Math.max(score, 0.85);
        }
        if (score >= 0.35) {
          if (score > bestPlaybookScore) bestPlaybookScore = score;
          matches.push({
            layer: "local_playbook",
            layer_label: "3ª Camada • Playbook Local de Processos TI",
            source_id: pb.id,
            title: pb.title,
            category: pb.domain,
            summary: pb.symptoms,
            steps: pb.resolution_steps || [],
            score,
          });
        }
      }
    }

    // 1ª Camada: Base de Conhecimento Oficial do GLPI
    const kbArticles = await this.glpiClient.fetchKbArticles();
    for (const kb of kbArticles) {
      const normKbTitle = normalizeText(kb.title || "");
      // Evita falso positivo de "Print to PDF" quando o chamado é de impressora física sem citar PDF
      if (normKbTitle.includes("print to pdf") && !normTicket.includes("pdf")) {
        continue;
      }
      // Evita falso positivo de assinatura de e-mail (KB-12) quando o chamado não é sobre assinatura de e-mail
      if (normKbTitle.includes("assinatura") && !normTicket.includes("assinatura")) {
        continue;
      }
      // Evita falso positivo de Nextcloud (KB-13) quando o chamado não cita Nextcloud
      if (normKbTitle.includes("next cloud") && !normTicket.includes("nextcloud") && !normTicket.includes("next cloud")) {
        continue;
      }

      const score = computeRelevance(
        fullTicketText,
        ticketTokens,
        kb.title || "",
        kb.summary || "",
        kb.keywords || []
      );
      const minKbScore = isRoutine ? 0.65 : bestPlaybookScore >= 0.75 ? 0.55 : 0.45;
      if (score >= minKbScore) {
        matches.push({
          layer: "glpi_kb",
          layer_label: "1ª Camada • Base de Conhecimento GLPI",
          source_id: String(kb.id || "KB"),
          title: kb.title || "",
          category: kb.category || "",
          summary: kb.summary || "",
          steps: kb.steps || [],
          score,
        });
      }
    }

    // 2ª Camada: Histórico de Chamados Resolvidos no GLPI
    const resolvedTickets = await this.glpiClient.fetchResolvedHistory();
    for (const hist of resolvedTickets) {
      // Nunca pareia o próprio chamado consigo mesmo no histórico
      if (String(hist.id || "").includes(String(ticket.id))) {
        continue;
      }
      const score = computeRelevance(
        fullTicketText,
        ticketTokens,
        hist.title || "",
        hist.summary || "",
        hist.keywords || []
      );
      const minHistScore = isRoutine ? 0.65 : bestPlaybookScore >= 0.75 ? 0.50 : 0.42;
      if (score >= minHistScore) {
        matches.push({
          layer: "glpi_history",
          layer_label: "2ª Camada • Histórico de Chamados Resolvidos",
          source_id: String(hist.id || "Histórico"),
          title: hist.title || "",
          category: hist.category || "",
          summary: hist.summary || "",
          steps: hist.steps || [],
          score,
        });
      }
    }

    // Memória Contínua: Aprendizado com as respostas/orientações enviadas pelo Analista
    if (!isRoutine) {
      const learnedList = loadLearnedFeedback();
      for (const mem of learnedList) {
        if (String(mem.ticket_id) === String(ticket.id)) continue;
        // Evita parear memórias de outros sistemas (ex: PEP / Dalete) quando o chamado é de clínicas / Web Saúde
        if (
          /\b(web\s*sa[uú]de|clinicas?|16\d{6})\b/i.test(normTicket) &&
          !/\b(web\s*sa[uú]de|clinicas?|16\d{6})\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de vinculação de unidade/perfil (ex: MEM-#41992) quando o chamado trata de reabertura ou cancelamento de registro no Controle de Contas
        if (
          /\b(reabrir|reabertura|cancelar|cancelamento|excluir|exclusao|estornar)\b/i.test(normTicket) &&
          /\b(vincular|vinculacao|unidade piumhi|acesso ao meu usuario)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de reabertura/ativação de contas quando o chamado NÃO trata de reabrir/ativar conta
        if (
          !/\b(reabrir|reabertura|abrir conta|abrir contas|abrir registro|ativar conta|reativar conta|encerrad[ao] erroneamente)\b/i.test(normTicket) &&
          /\b(reabrir|reabertura|abrir conta|abrir contas|abrir registro|ativar conta|reativar conta|1411181)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary} ${mem.reply_template || ""}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de suporte operacional quando o chamado trata de desenvolvimento/melhoria/parametrização
        if (
          /\b(parametrizar|parametriza[çc][ãa]o|viabilidade|melhoria|novas aplica[çc][õo]es|encaminhamento autom[aá]tico)\b/i.test(normTicket) &&
          /\b(reabertura|reabrir|vincular|vinculacao|senha|acesso|cancelar|ativar conta)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de Web Saúde / secretárias / acessos quando o chamado trata de criação de formulários no GLPI
        if (
          /\b(item no glpi|itens no glpi|formul[aá]rio(s)? no glpi|formcreator|criar novos? itens?|criar novos? formul[aá]rios?)\b/i.test(normTicket) &&
          /\b(web\s*sa[uú]de|secret[aá]ria|prestador|16\d{6}|acesso e permiss[õo]es|cria[çc][ãa]o de usu[áa]rios?)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de formulários no GLPI quando o chamado NÃO trata de GLPI
        if (
          !/\b(item no glpi|itens no glpi|formul[aá]rio(s)? no glpi|formcreator|criar novos? itens?|criar novos? formul[aá]rios?)\b/i.test(normTicket) &&
          /\b(item no glpi|itens no glpi|formul[aá]rio(s)? no glpi|formcreator)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de nobreak/energia (ex: MEM-#42158) quando o chamado NÃO trata de nobreak/energia
        if (
          !/\b(nobreak|no-break|ups|bateria|gerador|energia)\b/i.test(normTicket) &&
          /\b(nobreak|no-break|ups|bateria|gerador)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de unificação de cadastros (beneficiário ou insumos) quando o chamado NÃO trata de unificação
        if (
          !/\b(unifica|unificar|unificacao|duplicad|duplicidade|mesmo cadastro|mais de um cadastro)\b/i.test(normTicket) &&
          /\b(unifica|unificar|unificacao|duplicad|duplicidade)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de unificação de beneficiário/pessoa quando o chamado trata de insumos/materiais
        if (
          /\b(insumo|insumos|material|materiais|medicamento|medicamentos|produto)\b/i.test(normTicket) &&
          /\b(benefici[áa]ri[oa]|paciente|cliente)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias do Controle de Contas (ex: MEM-#42272, MEM-#42249, MEM-#42198, MEM-#41992) quando o chamado NÃO trata de Controle de Contas
        if (
          !normTicket.includes("controle de contas") &&
          /\b(controle de contas|data da alta|data de alta|1411181)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary} ${mem.custom_instruction || ""}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de outros assuntos quando o chamado trata de videoconferência / reunião online / Google Meet / Teams / Zoom
        if (
          /\b(google\s*meet|meet|teams|zoom|videoconfer[eê]ncia|reuni[aã]o\s+online|link\s+(?:d[ea]|para)\s+reuni[aã]o|link\s+no\s+meet)\b/i.test(normTicket) &&
          !/\b(google\s*meet|meet|teams|zoom|videoconfer[eê]ncia|reuni[aã]o)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de telefonia/VoIP/ramal (ex: MEM-#42139) quando o chamado NÃO trata de telefone/VoIP/ramal
        if (
          !/\b(telefone|telefonia|voip|ramal|pabx|ligac|discagem|mudo|sem sinal|sem tom)\b/i.test(normTicket) &&
          /\b(telefone|telefonia|voip|ramal|pabx)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de impressora/toner/suprimentos quando o chamado NÃO trata de impressora/toner/suprimentos
        if (
          !/\b(impressora|impressao|imprimir|toner|tonner|tinta|tintas|cartucho|spooler|zebra|epson|samsung)\b/i.test(normTicket) &&
          /\b(impressora|impressao|toner|tonner|tinta|tintas)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        const cleanMemKws = (mem.keywords || []).filter(
          (k) => !STOPWORDS.has(normalizeText(k))
        );
        const score = computeRelevance(
          fullTicketText,
          ticketTokens,
          mem.title || "",
          `${mem.problem_summary || ""} ${mem.custom_instruction || ""}`,
          cleanMemKws
        );
        if (score >= 0.65) {
          matches.push({
            layer: "learned_memory",
            layer_label: "Memória Contínua • Aprendido com o Analista",
            source_id: `MEM-#${mem.ticket_id}`,
            title: mem.title || `Padrão aprendido no Chamado #${mem.ticket_id}`,
            category: mem.category || "Aprendizado Contínuo",
            summary: mem.reply_template || mem.custom_instruction || "",
            steps: mem.resolution_steps || [],
            reply_template: mem.reply_template || "",
            required_info: mem.required_info || [],
            sufficiency_status: mem.sufficiency_status || "",
            custom_instruction: mem.custom_instruction || "",
            score,
          });
        }
      }
    }

    const layerPriority = {
      learned_memory: 4,
      local_playbook: 3,
      glpi_kb: 2,
      glpi_history: 1,
    };
    matches.sort((a, b) => {
      const sDiff = Number(b.score.toFixed(1)) - Number(a.score.toFixed(1));
      if (sDiff !== 0) return sDiff;
      const pDiff = (layerPriority[b.layer] || 0) - (layerPriority[a.layer] || 0);
      if (pDiff !== 0) return pDiff;
      return b.score - a.score;
    });

    return matches.slice(0, topK);
  }
}
