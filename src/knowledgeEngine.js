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
  "certo", "vossa", "arquivos", "arquivo", "print", "gostaria", "solicitar", "poderia", "poderiam",
  "unimedsudoestemg", "unimed256", "coop", "br", "com", "gov", "org", "net", "http", "https", "www",
  "link", "login", "webmail", "seguro", "desenvolvimento", "qualidade", "ajustes", "layout", "interface", "solicitamos"
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

    // Apenas considera followups públicos do próprio solicitante para complementar o relato inicial
    // (ignora andamentos e notas de técnicos/analistas de TI que investigaram o chamado posteriormente)
    const requesterFollowups = (ticket.followups || [])
      .filter(
        (f) =>
          !f.is_private &&
          (f.author === ticket.requester ||
            (ticket.requester_first_name &&
              f.author?.toLowerCase().includes(ticket.requester_first_name.toLowerCase())))
      )
      .map((f) => f.content)
      .join(" ");

    // Usa apenas o título útil, tipo, ativo, motivo e a descrição real do usuário (evitando nomes de observadores e cabeçalhos)
    const cleanTitle = (ticket.title || ticket.name || "").split(">").slice(-2).join(" ");
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
      requesterFollowups,
    ]
      .filter(Boolean)
      .join(" ");

    const normTicket = normalizeText(fullTicketText);
    const ticketTokens = extractTokens(fullTicketText);
    const matches = [];

    const isFormcreatorOrGlpiForm =
      /\b(item no glpi|itens no glpi|formul[aá]rio(s)? no glpi|formcreator|criar novos? itens?|criar novos? formul[aá]rios?|novo item no glpi|novos itens no glpi|criar item no glpi|inser[cç][aã]o da op[cç][aã]o de inserir documentos|inserir documentos nos chamados|anexar documentos nos chamados|op[cç][aã]o de anexar documentos|campo de anexo|documentos nos chamados)\b/i.test(
        normTicket
      ) ||
      (/\bglpi\b/i.test(normTicket) &&
        /\b(regulatório|regulatorio|regula[cç][aã]o|faturamento|financeiro|rh|contabil|setor)\b/i.test(
          normTicket
        ) &&
        /\b(documentos?|anexos?|campo|formulario|formularios|itens|item)\b/i.test(
          normTicket
        ));

    const isLabelAppOrDesktopShortcut =
      (/\b(aplicativo para impress[aã]o|aplicativo de impress[aã]o|app de impress[aã]o|impress[aã]o de etiquetas?|etiquetas?\s+de\s+identifica[çc][ãa]o|impressora\s+(?:de\s+)?etiquetas?|zebradesigner|elgin|impressora zebra|arquivo\s+(?:de\s+)?etiquetas?)\b/i.test(
        normTicket
      ) &&
        /\b(aplicativo|aplicativos|app|programa|software|arquivo|[aá]rea de trabalho|desktop|atalho|sumiu|n[aã]o est[aá] aparecendo|aparecendo na [aá]rea de trabalho|icone|n[aã]o consigo imprimir|imprimir|probleminha|erro)\b/i.test(
          normTicket
        )) ||
      (/\betiquetas?\b/i.test(normTicket) &&
        (/\b(aplicativo|aplicativos|app|programa|software|arquivo|[aá]rea de trabalho|desktop|atalho)\b/i.test(
          normTicket
        ) ||
        /\b(n[aã]o consigo imprimir|probleminha|erro|imprimir)\b/i.test(normTicket)));

    const isUnlockAccount =
      /\b(desbloque|desbloquear|desbloqueio|conta bloqueada|usuario bloqueado|usuário bloqueado)\b/i.test(
        normTicket
      );

    const isExternalAgencyOrPortal =
      (/\b(urucum|ag[eê]ncia|marketing digital)\b/i.test(normTicket) &&
       /\b(portal unimed|gerenciador|site|plataforma do nosso site)\b/i.test(normTicket)) ||
      (/\bportal unimed\b/i.test(normTicket) &&
       /\b(site|gerenciador|landing pages?|google tag manager|pixel meta)\b/i.test(normTicket) &&
       /\b(empresa|ag[eê]ncia|terceir|extern[ao])\b/i.test(normTicket));

    const isNextcloudDuplicationOrConflict =
      /\bnext\s*cloud\b/i.test(normTicket) &&
      (/\b(duplic|duplicando|duplicadas|duplicam|duplicaram|duplica[çc][ãa]o|conflito|conflitos|aparecer at[ée] quatro vezes|4 vezes|quatro vezes)\b/i.test(
        normTicket
      ) ||
      (/\b(planilha|planilhas|arquivo|arquivos|documento|documentos)\b/i.test(normTicket) &&
       /\b(duplic|conflito|extens[aã]o|extens[õo]es|simultaneamente|simult[aâ]nea)\b/i.test(normTicket)));

    const isHospitalMedicalRecordRegistration =
      (/\b(prontu[aá]rio\s+do\s+hospital|prontu[aá]rio\s+hospitalar|spdata|sgh\s+spdata|pep\s+hospitalar)\b/i.test(
        normTicket
      ) ||
        (/\bprontu[aá]rio\b/i.test(normTicket) && /\bhospital\b/i.test(normTicket))) &&
      (/\b(cadastro|libera[çc][ãa]o|acesso|profissional|profissionais|mandei tudo junto|alta demanda|vai mais de um profissional)\b/i.test(
        normTicket
      ) ||
        /\bcpf\b/i.test(normTicket));

    const isNextcloudInstallOrUnidrive =
      (/\b(unidrive|uni\s*drive)\b/i.test(normTicket) ||
       /\b(nextcloud|nextclaud)\b/i.test(normTicket)) &&
      (/\b(instalar|instala[çc][ãa]o|instalem|instale|novo computador|trocou o computador|troca de computador|formatou|computador novo|est[aá] sem o|n[aã]o foi instalado|n[aã]o est[aá] instalado)\b/i.test(
        normTicket
      ) ||
       normTicket.includes("pasta compartilhada - unidrive"));

    const isHrpIntercambioGuiaStatusChange =
      (/\b(alterar\s+(?:atendimento|car[aá]ter|guia|senha|o\s+car[aá]ter)|car[aá]ter\s+de\s+atendimento|eletivo\s+para\s+urg[eê]ncia|urg[eê]ncia\s+para\s+eletivo)\b/i.test(
        normTicket
      ) &&
      /\b(eletiv[oa]|urg[eê]ncia)\b/i.test(normTicket) &&
      (/\b(via\s+banco|no\s+banco|hrp|senha|guia|interc[aâ]mbio|autoriza[çc][ãa]o)\b/i.test(
        normTicket
      ) ||
        normTicket.includes("210800316"))) ||
      (/\b(interc[aâ]mbio|unimed\s+interc[aâ]mbio)\b/i.test(normTicket) &&
        /\b(eletiv[oa]|urg[eê]ncia)\b/i.test(normTicket) &&
        /\b(alterar|mudar|converter|cancelar|cancelamento)\b/i.test(normTicket));

    const isHrpAuthorizationOrIntercambio =
      !isHrpIntercambioGuiaStatusChange &&
      ((/\b(autoriza[çc][ãa]o|autorizando|autorizar|procedimento|procedimentos|interc[âa]mbio|guia|guias|ptu|wautoriza|trafegando|trafega|trafegar)\b/i.test(
        normTicket
      ) &&
      /\b(senha|senhas|guia|guias|206867125)\b/i.test(normTicket) &&
      /\b(hrp|interc[âa]mbio|autoriza[çc][ãa]o|procedimento|trafegando|trafega|n[ãa]o est[áa] autorizando|n[ãa]o autoriza)\b/i.test(
        normTicket
      )) ||
      /\bsenha\s+(?:n[ãa]o\s+est[áa]\s+trafegando|n[ãa]o\s+trafega|de\s+autoriza[çc][ãa]o)\b/i.test(normTicket) ||
      (/\b(procedimento|guia)\b/i.test(normTicket) && /\b(n[ãa]o est[áa] autorizando|n[ãa]o autoriza|falha na autoriza[çc][ãa]o)\b/i.test(normTicket)));

    const isReopenOrRevertAccount =
      (/\b(reabrir|reabertura|abrir conta|abrir contas|abrir registro|abertura de (?:uma\s+)?contas?|abertura de registros?|ativar (?:a\s+)?contas?|reativar (?:a\s+)?contas?|encerrad[ao] erroneamente|revers[aã]o de encerramento|reverter encerramento|reverter processo de encerramento|voltar remessa|reabrir remessa|revers[aã]o da remessa|revers[aã]o no controle de contas|reverter contas|contas reabertas|processo revertido)\b/i.test(
        normTicket
      ) ||
      (/\bcontrole de contas\b/i.test(normTicket) && /\b(remessa|revers[aã]o|reverter|voltar remessa|abertura de|abrir|ativar)\b/i.test(normTicket))) &&
      !/\b(parametrizar|parametriza[çc][ãa]o|viabilidade|melhoria|novas aplica[çc][õo]es|encaminhamento autom[aá]tico)\b/i.test(
        normTicket
      );

    const isXmlBatalhaoOrSghValueMismatch =
      /\bxml\b/i.test(normTicket) &&
      (/\b(batalh[aã]o|ipsm|ipsmmg|sigas|anestesista|primeiro auxiliar|1[ºo]?\s*auxiliar|grau de participa[cç][aã]o|diferen[cç]a de valor)\b/i.test(
        normTicket
      ) ||
        (/\b(valores?|valor)\b/i.test(normTicket) &&
          /\b(carregad[oa]s?|importa[cç][aã]o|importar|fatura|diferen[cç]a)\b/i.test(normTicket)));

    const isTussDiariasTaxasGasesManualUpdate =
      (/\btuss\b/i.test(normTicket) &&
        /\b(di[aá]rias|taxas|gases|00952)\b/i.test(normTicket)) ||
      /\b(00952|di[aá]rias\s*,\s*taxas\s+e\s+gases)\b/i.test(normTicket);

    const isIpsmTable =
      /\b(ipsm|ipsmmg|batalh[aã]o|batalhao)\b/i.test(normTicket) &&
      /\b(tabela|tabelas|medicamento|medicamentos|parametriza|importa|vig[eê]ncia)\b/i.test(normTicket) &&
      !isXmlBatalhaoOrSghValueMismatch;

    const isSystemTableParameterization =
      isIpsmTable ||
      (!isTussDiariasTaxasGasesManualUpdate &&
      !isXmlBatalhaoOrSghValueMismatch &&
      !isFormcreatorOrGlpiForm &&
      !isReopenOrRevertAccount &&
      (/\b(criar\s+tabela|cria[cç][aã]o\s+de\s+tabela|nova\s+tabela|tabela\s+dth|dth\s*[-–]?\s*padr[aã]o|tabela\s+de\s+di[aá]rias\s+e\s+taxas|faixa\s+(?:de\s+)?998|importar\s+tabela|importa[cç][aã]o\s+de\s+tabela|atualizar\s+tabela|parametrizar\s+tabela|parametriza[cç][aã]o\s+de\s+(?:sistemas?\s+e\s+)?tabelas?|regras?\s+do\s+min|manual\s+de\s+interc[aâ]mbio|prazo\s+de\s+cobranc?a|bras[ií]ndice|bras[ií]dice|simpro|referenciamento\s+bras[ií]ndice)\b/i.test(
        normTicket
      ) ||
        (/\b(dth|di[aá]rias\s+e\s+taxas|simpro|bras[ií]ndice|bras[ií]dice|tuss|cbhpm|amb|faixa\s+(?:de\s+)?\d{2,4})\b/i.test(
          normTicket
        ) &&
        !/\b(excluir|exclus[aã]o|estornar|estorno|cancelar|cancelamento|unifica|duplicad)\b/i.test(
          normTicket
        )) ||
        normTicket.includes("parametrização de sistemas e tabelas") ||
        ticket.category.includes("Parametrização de Sistemas e Tabelas")));

    const isDocusignAccessOrShared =
      /\b(docusign|docu\s*sign)\b/i.test(normTicket) ||
      (/\bacesso\s+compartilhado\b/i.test(normTicket) &&
        /\b(contratos?|envelopes?)\b/i.test(normTicket));

    const isRelocationOrPhoneInstall =
      /\b(ponto de telefone|linha e aparelho|remanejar|remanejamento|mudar de lugar|mudanca de local|novo ponto de rede|trocar o ramal de mesa|mudar o ramal de mesa|trocar ramal|mudanca de local do telefone|trocar telefone de mesa)\b/i.test(
        normTicket
      ) ||
      /\b(trocar|mudar|transferir|levar|passar|colocar)\b[\s\S]{0,60}\b(do|da)\b[\s\S]{0,50}\bpara\b/i.test(
        normTicket
      ) ||
      (/\b(telefone|ramal)\b/i.test(normTicket) && /\b(trocar|mudar|transferir|remanejar|mesa|local)\b/i.test(normTicket));

    const hasPhotoOrImageAttachment =
      /\.(jpg|jpeg|png|webp|bmp)\b/i.test(ticket.content) ||
      (ticket.documents || []).some(
        (d) => d.is_image || /\.(jpg|jpeg|png|webp|bmp)$/i.test(d.filename || "")
      );

    const isFacialBiometricOrDoorAccess =
      /\b(biometria\s+facial|reconhecimento\s+facial|idface|control\s*id|biometria\s+nas?\s+portas?)\b/i.test(
        normTicket
      ) ||
      (/\b(biometria|facial|face|portas?|catracas?)\b/i.test(normTicket) &&
        /\b(acesso|acessos|libera[çc][ãa]o|liberar|cadastr|novo colaborador|permiss|entrada|sa[ií]da)\b/i.test(
          normTicket
        ) &&
        !/\b(ponto|myplace|rep|rel[oó]gio)\b/i.test(normTicket)) ||
      (/\b(gest[ãa]o\s+de\s+acessos|libera[çc][ãa]o\s+d[eo]\s+acesso|liberar\s+(?:o\s+)?acesso)\b/i.test(
        normTicket
      ) &&
        hasPhotoOrImageAttachment &&
        !/\b(erro|falha|travad|reclassifica|toner|impressora|docusign|nextcloud|unidrive)\b/i.test(
          normTicket
        ));

    const isWconectErrorOrMessageSync =
      /\b(wconect|wconnect|wconectt)\b/i.test(normTicket) &&
      !/\b(indicador|indicadores|produtividade|relat[oó]rio|relatorios|extra[çc][ãa]o|levantamento|quantitativo)\b/i.test(
        normTicket
      ) &&
      /\b(erro|problema|falha|primeiro\s+contato|n[aã]o\s+recebo|resposta\s+dos\s+pacientes|mensagens?|sem\s+acesso|conex[aã]o|sincroniza)\b/i.test(
        normTicket
      );

    const isDesktopWallpaperOrDomainPersonalization =
      /\b(papel\s+de\s+parede|papeis\s+de\s+parede|pap[eé]is\s+de\s+parede|plano\s+de\s+fundo|fundo\s+de\s+tela|tela\s+de\s+fundo|wallpaper|padroniza[cç][aã]o\s+(?:da\s+)?[aá]rea\s+de\s+trabalho|padronizar\s+(?:a\s+)?[aá]rea\s+de\s+trabalho|personaliza[cç][aã]o\s+(?:da\s+)?[aá]rea\s+de\s+trabalho|personalizar\s+(?:a\s+)?[aá]rea\s+de\s+trabalho|imagem\s+(?:com\s+a\s+|da\s+|de\s+|na\s+)?[aá]rea\s+de\s+trabalho|[aá]rea\s+de\s+trabalho\s+criada)\b/i.test(
        normTicket
      ) ||
      (/\b([aá]rea\s+de\s+trabalho|desktop)\b/i.test(normTicket) &&
        /\b(padroniza|personaliza|papel\s+de\s+parede|plano\s+de\s+fundo|imagem|imagens|dom[ií]nio|unimedti|unimed256|\bucs\b|\bgpo\b)\b/i.test(
          normTicket
        ) &&
        !/\b(etiqueta|etiquetas|zebradesigner|elgin|atalho|unidrive|nextcloud)\b/i.test(
          normTicket
        ));

    const isScannerDeviceInstall =
      (/\b(instala[cç][aã]o\s+d[eo]\s+scann?ers?|instalar\s+(?:o\s+|um\s+)?scann?ers?|configura[cç][aã]o\s+d[eo]\s+scann?ers?|configurar\s+(?:o\s+|um\s+)?scann?ers?|scann?ers?\s+(?:em|no)\s+meu\s+computador)\b/i.test(
        normTicket
      ) ||
        (ticket.category.includes("Scaners") &&
          /\b(instala|configura|scann?ers?)\b/i.test(normTicket))) &&
      !/\b(e-?mail|email|cat[aá]logo|lgpd|scan\s+to\s+e-?mail)\b/i.test(normTicket);

    const isIntranetChatOrSystemBug =
      /\bintranet\b/i.test(normTicket) &&
      /\b(chat|destinat[aá]rio|destinat[aá]rios|mensagens?|bug|bugs|falha|erro\s+do\s+destinat[aá]rio|conte[uú]do\s+sens[ií]vel|canal\s+oficial)\b/i.test(
        normTicket
      ) &&
      !/\b(cria[cç][aã]o\s+de\s+usu[aá]rios?|novo\s+colaborador|admiss[aã]o)\b/i.test(normTicket);

    const isSiteMetricsOrGtmTags =
      !isExternalAgencyOrPortal &&
      (/\b(google\s+tag\s+manager|\bgtm\b|gtm-[a-z0-9]+|google\s+analytics|search\s+console|pixel\s+(?:da\s+)?meta|tags?\s+de\s+acompanhamento|m[eé]tricas?\s+(?:no\s+site|de\s+crescimento))\b/i.test(
        normTicket
      ) ||
        (/\bsite\s+unimed\b/i.test(normTicket) &&
          /\b(tags?|m[eé]tricas?|monitoramento)\b/i.test(normTicket)));

    const isAutomationBillingOrMessaging =
      (/\b(automa[çc][ãa]o|automatiza[çc][ãa]o|automatizar|rotina autom[aá]tica)\b/i.test(normTicket) &&
        /\b(cobran[çc]a|t[ií]tulos?\s+em\s+atraso|inadimpl[eê]ncia|whatsapp|wpp|mensagens?\s+wpp|mensagens?\s+de\s+cobran[çc]a|disparo)\b/i.test(
          normTicket
        )) ||
      (/\b(t[ií]tulos?\s+em\s+atraso|relat[oó]rio\s+de\s+t[ií]tulos?\s+em\s+atraso)\b/i.test(normTicket) &&
        /\b(whatsapp|wpp|emails?|mandar\s+um\s+email|mandar\s+um\s+whatsapp)\b/i.test(normTicket));

    const isCustomLabelLayoutOrFieldDev =
      (/\b(duplicar\s+etiquetas?|etiquetas?\s+de\s+oncologia|etiquetas?\s+para\s+r[oó]tulos?|desenvolvimento\s+de\s+etiquetas?)\b/i.test(
        normTicket
      ) ||
        (/\betiquetas?\b/i.test(normTicket) &&
          /\b(oncologia|prontu[aá]rio|r[oó]tulos?|campo\s+.*?\s+em\s+aberto|duplicar\s+(?:a\s+|o\s+)?(?:etiqueta|layout|modelo))\b/i.test(
            normTicket
          ))) &&
      !/\b(glpi|controle\s+de\s+contas|cores?\s+diferentes?|aguardando\s+retorno|em\s+andamento)\b/i.test(
        normTicket
      );

    const isGlpiOrSystemTagManagement =
      !isCustomLabelLayoutOrFieldDev &&
      (/\b(adi[cç][aã]o\s+d[ae]s?\s+etiquetas?|adicionar\s+etiquetas?|cria[cç][aã]o\s+d[ae]s?\s+etiquetas?|criar\s+etiquetas?|manuten[cç][aã]o\s+d[ae]s?\s+etiquetas?|etiquetas?\s+iguais|\d+\s+etiquetas?\s+iguais|etiquetas?\s+duplicadas?)\b/i.test(
        normTicket
      ) ||
      (/\betiquetas?\b/i.test(normTicket) &&
        (/\b(cores?\s+diferentes?|em\s+andamento|aguardando\s+retorno|aguardando\s+farm[aá]cia|aguardando\s+nas|glpi|controle\s+de\s+contas)\b/i.test(
          normTicket
        ) ||
          ticket.category.includes("Desenvolvimento")) &&
        !/\b(imprimir|impress[aã]o|impressora|zebra|zebradesigner|elgin|argox|ribbon|atalho|[aá]rea\s+de\s+trabalho)\b/i.test(
          normTicket
        )));

    const isSiteBannerOrContentUpdate =
      !isSiteMetricsOrGtmTags &&
      !isExternalAgencyOrPortal &&
      /\b(banners?|altera[cç][aã]o\s+banner|acrescentar\s+(?:o\s+)?banner|adicionar\s+banner|formato\s+rotativo|novembro\s+azul|outubro\s+rosa|publica[cç][aã]o\s+relat[oó]rio\s+igualdade\s+salarial)\b/i.test(
        normTicket
      );

    const isEmailDistributionGroup =
      !isExternalAgencyOrPortal &&
      (/\b(geral@unimedsudoestemg\.coop\.br|geralunimed@unimedsudoestemg\.coop\.br)\b/i.test(
        normTicket
      ) ||
      (/\b(e-?mail\s+geral|geral\s+unimed|geralunimed|e-?mail\s+institucional|e-?mails?)\b/i.test(
        normTicket
      ) &&
        /\b(geral|geral\s+unimed|grupo|grupos|lista|listas)\b/i.test(normTicket) &&
        /\b(incluir|inclus[aã]o|adicionar|adi[cç][aã]o|inserir|inser[çc][aã]o|acesso|recebe|recebendo)\b/i.test(
          normTicket
        )) ||
      /\b(acesso\s+ao\s+e-?mail\s+geral|acesso\s+ao\s+e-?mail\s+geral\s+unimed)\b/i.test(
        normTicket
      ) ||
      (/\b(grupo|grupos|lista|listas)\s+(?:de\s+)?(?:e-?mails?|distribui[çc][ãa]o)\b/i.test(
        normTicket
      ) &&
        /\b(incluir|inclus[aã]o|adicionar|adi[cç][aã]o|inserir|inser[çc][aã]o|cadastrar)\b/i.test(
          normTicket
        )));

    const isRepromaqSamsungMaintenance =
      (/\b(samsung\s+m?4080|m4080|m4080fx|samsung\s+m?4020|m4020|m4020nd|samsung\s+4080|samsung\s+4020)\b/i.test(
        normTicket
      ) &&
      !/\b(troca\s+de\s+toner|trocar\s+(?:o\s+)?toner|trocado\s+(?:o\s+)?toner|acabou\s+o\s+toner|preciso\s+de\s+toner|solicito\s+toner|toner\s+vazio|refil|tinta)\b/i.test(
        normTicket
      ) &&
      !/\b(scan\s+to\s+e-?mail|digitaliza[cç][aã]o\s+para\s+e-?mail|cat[aá]logo\s+de\s+endere[cç]os?)\b/i.test(
        normTicket
      ) &&
      !/\b(precisamos\s+de\s+uma?\s+impressora|instala[cç][aã]o\s+de\s+nova\s+impressora|disponibilizar\s+impressora)\b/i.test(
        normTicket
      ) &&
      (/\b(fusor|falha\s+(?:no\s+)?fusor|manuten[cç][aã]o|preventiva|corretiva|verifica[cç][aã]o\s+preventiva|defeito|conserto|reparo|pe[çc]a|substitui[cç][aã]o\s+de\s+pe[çc]a|barulho|aquecimento|lenta|lentid[aã]o|repromaq|terceirizad|assist[eê]ncia)\b/i.test(
        normTicket
      ) ||
        normTicket.includes("falha no fusor") ||
        normTicket.includes("manutencao preventiva"))) ||
      (/\brepromaq\b/i.test(normTicket) &&
        /\b(impressora|manuten[cç][aã]o|suporte|chamado)\b/i.test(normTicket));

    const isHospitalSpdataScheduledReports =
      /\b(relat[oó]rios?\s+atendimentos?\s+hospital|atendimentos?\s+realizados?\s+no\s+hospital|relat[oó]rios?\s+de\s+todos\s+os\s+atendimentos?|vsilva@unimedsudoestemg\.coop\.br|viviane\s+do\s+n[uú]cleo|evolu[ií]dos?\s+[aà]\s+[oó]bito|atendimento\s+externo\s+adulto|atendimento\s+externo\s+pedi[aá]trico|pacientes?\s+internados?)\b/i.test(
        normTicket
      ) ||
      (/\brelat[oó]rios?\b/i.test(normTicket) &&
        /\b(atendimentos?|hospital)\b/i.test(normTicket) &&
        /\b(enviados?|enviar|receber|caixa\s+de\s+entrada|e-?mail)\b/i.test(normTicket) &&
        /\b(spdata|sgh|viviane|nucleo|n[uú]cleo|promoprev|vsilva)\b/i.test(normTicket));

    const isPepPrescriptionProtocol =
      /\b(prescri[cç][aã]o\s+no\s+pep|modelo\s+de\s+prescri[cç][aã]o|protocolos?\s+prescri[cç][aã]o|prescri[cç][aã]o\s+geral|prescri[cç][aã]o\s+srpa|srpa|recupera[cç][aã]o\s+p[oó]s-anest[eé]sica|anestesistas?\s+e\s+cirurgi[oõ]es|tornar\s+esta\s+prescri[cç][aã]o\s+em\s+protocolo\s+padr[aã]o|protocolo\s+padr[aã]o\s+de\s+prescri[cç][aã]o)\b/i.test(
        normTicket
      ) ||
      (/\bprescri[cç][aã]o\b/i.test(normTicket) &&
        /\b(pep|spdata|sgh|modelo|protocolo|srpa)\b/i.test(normTicket));

    const isPalcOnaLaboratorioAudit =
      !/\b(pesquisa\s+de\s+satisfa[cç][aã]o|avalia[cç][aã]o\s+da\s+satisfa[cç][aã]o|experi[êe]ncia\s+do\s+cliente|totem|tablet)\b/i.test(
        normTicket
      ) &&
      /\b(palc|ona|auditoria\s+diagn[oó]stica|auditoria\s+palc|acredita[cç][aã]o|registros?\s+de\s+controle\s+de\s+acesso|rastreabilidade|recupera[cç][aã]o\s+de\s+registros?\s+eletr[oô]nicos?|altera[cç][aã]o\s+e\s+recupera[cç][aã]o|audit\s+trail|trilha\s+de\s+auditoria)\b/i.test(
        normTicket
      ) &&
      (/\b(laborat[oó]rio|autolac|palc|ona|registros?\s+eletr[oô]nicos?|compliance)\b/i.test(
        normTicket
      ) ||
        (ticket.category || "").includes("Compliance") ||
        (ticket.requester_department || "").includes("Laborat"));

    const isLaboratorioCustomerSatisfactionTool =
      /\b(pesquisa\s+de\s+satisfa[cç][aã]o|avalia[cç][aã]o\s+da\s+satisfa[cç][aã]o|experi[êe]ncia\s+do\s+cliente)\b/i.test(
        normTicket
      ) &&
      /\b(laborat[oó]rio|palc|totem|tablet|novas\s+aplica[cç][õo]es)\b/i.test(
        normTicket
      );

    const isHrpAtivoImobilizadoRecurso =
      /\b(ativo\s+imobilizado|ativos\s+imobilizados|dois\s+recursos|2\s+recursos|cadastrado\s+com\s+dois\s+recursos|ajuste\s+via\s+banco\s+de\s+dados|recurso\s+ai|lotes?\s+de\s+ativos?|termo\s+de\s+responsabilidade|movdepos|oeinfnh)\b/i.test(
        normTicket
      ) ||
      (/\brecurso\b/i.test(normTicket) &&
        /\b(item|lote|ativo|patrim[oô]nio|banco\s+de\s+dados)\b/i.test(normTicket) &&
        /\b(considerar|somente|monitor|computador|oeinfnh|ai\d+)\b/i.test(normTicket));

    const isGlpiAttachmentOrUploadError =
      (/\bglpi\b/i.test(normTicket) ||
        /\b(andamento\s+de\s+um\s+chamado|acompanhamento|abertura\s+de\s+chamado)\b/i.test(normTicket)) &&
      (/\b(anexar|anexando|anexo|upload|tipo de arquivo n[aã]o permitido|arquivo n[aã]o [eé] anexado)\b/i.test(
        normTicket
      ) ||
        /\btipo de arquivo n[aã]o permitido\b/i.test(normTicket));

    const isHrpAccommodationChange =
      /\b(mudan[cç]a\s+de\s+acomoda[cç][aã]o|troca\s+de\s+acomoda[cç][aã]o|acomoda[cç][aã]o\s+quarto\s+coletivo|quarto\s+coletivo|apartamento\s+simples|tipo\s+de\s+acomoda[cç][aã]o\s+autorizada|campo\s+41)\b/i.test(
        normTicket
      ) ||
      (/\bacomoda[cç][aã]o\b/i.test(normTicket) &&
        /\b(quarto\s+coletivo|apartamento|honor[aá]rios?\s+m[eé]dicos?|troca\s+d[eo]\s+campo|mudar|trocar)\b/i.test(
          normTicket
        ));

    const isMedicalProductionExtraction =
      /\b(produ[çc][ãa]o\s+cooperados?|produ[çc][ãa]o\s+dos\s+m[ée]dicos?|produ[çc][ãa]o\s+m[ée]dica|extra[çc][ãa]o\s+produ[çc][ãa]o|envio\s+de\s+produ[çc][ãa]o)\b/i.test(
        normTicket
      ) ||
      (/\bprodu[çc][ãa]o\b/i.test(normTicket) &&
        /\b(cooperados?|m[ée]dicos?|m[ée]dica|excel|segregado)\b/i.test(normTicket));

    const isQueueOrPainelSenhaDev =
      /\b(painel\s+de\s+senhas?|gerenciador\s+de\s+filas?|fila\s+de\s+atendimento|chamador\s+de\s+senhas?|sistema\s+de\s+senhas?|controle\s+de\s+filas?)\b/i.test(
        normTicket
      ) &&
      !/\b(impressora|spooler|toner|mancha|atolamento|papel preso)\b/i.test(
        normTicket
      );

    // 3ª Camada: Playbooks Locais da Equipe de TI
    let bestPlaybookScore = 0;
    if (!isRoutine) {
      const playbooks = loadPlaybooks();
      for (const pb of playbooks) {
        // Evita parear Playbook exclusivo do HRP/TNUMM quando o chamado é de outro sistema (ex: S.G.H. / Spdata), unificação de cadastro ou GLPI Formcreator
        if (
          pb.id === "PB-UNI-05" &&
          (isFormcreatorOrGlpiForm ||
            (!/\b(hrp|tnumm|0256)\b/i.test(normTicket) && !/\bgestantes\b/i.test(normTicket)) ||
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

          const isEmailManagement =
            !isExternalAgencyOrPortal &&
            (/\b(redirecion|redirecionamento|redirecionar|redirecionadas|encaminh|encaminhamento|encaminhar|caixa departamental|caixa compartilhada|marketing@|jornalismo@)\b/i.test(
              normTicket
            ) ||
            (/\b(e-mail|email)\b/i.test(normTicket) &&
              !/\b(e-?mail marketing|ferramenta de e-?mail marketing)\b/i.test(normTicket) &&
              /\b(marketing|jornalismo|financeiro|compras|faturamento|recurso|ouvidoria|contato|recepcao|secretaria)\b/i.test(
                normTicket
              ) &&
              /\b(conta|caixa|acesso|permissao|redirecion)\b/i.test(normTicket)));

          if (isWebSaudeNas || isHardwareOrInfra || isUnification || !hasAccessContext || isSystemError || isFormcreatorOrGlpiForm || isEmailManagement || isUnlockAccount || isExternalAgencyOrPortal || isHospitalMedicalRecordRegistration || isFacialBiometricOrDoorAccess || isHrpIntercambioGuiaStatusChange || isEmailDistributionGroup) {
            continue;
          }
        }
        // Evita parear PB-UNI-49 (Biometria Facial / Portas) quando o chamado NÃO trata de biometria facial ou controle de acesso às portas
        if (pb.id === "PB-UNI-49" && !isFacialBiometricOrDoorAccess) {
          continue;
        }
        // Evita parear PB-UNI-11 (Bloqueio de Contas) quando o chamado trata de DESBLOQUEIO ou não trata de bloqueio/desligamento
        if (
          pb.id === "PB-UNI-11" &&
          (isUnlockAccount ||
            !/\b(bloquear|bloqueio|desligamento|desligada|afastamento|ferias)\b/i.test(normTicket))
        ) {
          continue;
        }
        // Evita parear PB-UNI-40 (Desbloqueio de Contas) quando o chamado NÃO trata de desbloqueio ou quando se trata de senha de autorização
        if (
          pb.id === "PB-UNI-40" &&
          (!isUnlockAccount || isHrpAuthorizationOrIntercambio)
        ) {
          continue;
        }
        // Evita parear PB-UNI-41 (Acesso Agência / Portal Unimed) quando o chamado NÃO trata de agência externa ou gerenciador do portal
        if (
          pb.id === "PB-UNI-41" &&
          !isExternalAgencyOrPortal
        ) {
          continue;
        }
        // Evita parear PB-UNI-02 (Falha de Acesso ao Nextcloud) quando o chamado trata de duplicação/conflito de arquivos no Nextcloud ou instalação do Unidrive/Nextcloud
        if (pb.id === "PB-UNI-02" && (isNextcloudDuplicationOrConflict || isNextcloudInstallOrUnidrive)) {
          continue;
        }
        // Evita parear PB-UNI-42 (Duplicação e Conflitos no Nextcloud) quando o chamado NÃO trata de duplicação/conflito
        if (pb.id === "PB-UNI-42" && !isNextcloudDuplicationOrConflict) {
          continue;
        }
        // Evita parear PB-UNI-43 (Cadastro no Prontuário do Hospital - SPdata / PEP) quando o chamado NÃO trata de prontuário hospitalar / SPdata
        if (pb.id === "PB-UNI-43" && !isHospitalMedicalRecordRegistration) {
          continue;
        }
        // Evita parear PB-UNI-44 (Instalação do Nextcloud / Unidrive) quando o chamado NÃO trata de instalação do Unidrive / Nextcloud
        if (pb.id === "PB-UNI-44" && !isNextcloudInstallOrUnidrive) {
          continue;
        }
        // Evita parear PB-UNI-45 (Autorização e Intercâmbio HRP) quando o chamado NÃO trata de autorização de procedimento / senha / intercâmbio
        if (pb.id === "PB-UNI-45" && !isHrpAuthorizationOrIntercambio) {
          continue;
        }
        // Evita parear PB-UNI-35 (Erro de Sistema no HRP / Federação) quando o chamado não trata de erro no HRP ou contratos/prestador/Federação ou trata de autorização/intercâmbio
        if (
          pb.id === "PB-UNI-35" &&
          (isHrpAuthorizationOrIntercambio ||
            !/\b(hrp|federa[çc][ãa]o)\b/i.test(normTicket) ||
            !/\b(contrato|contratos|prestador|prestadores|salvar|erro|dando erro)\b/i.test(
              normTicket
            ))
        ) {
          continue;
        }
        // Evita parear PB-UNI-25 quando o chamado NÃO trata de clínicas, Web Saúde ou atendentes do NAS, ou quando se trata de CRIAÇÃO DE USUÁRIO de secretária (PB-UNI-27) ou criação/ajuste de formulários no GLPI
        if (
          pb.id === "PB-UNI-25" &&
          (!/\b(web\s*sa[uú]de|clinicas?|16\d{6}|atendentes?\s+do\s+nas|nas\s+passos|nas\b)\b/i.test(
            normTicket
          ) ||
            /\bcria[çc][ãa]o de usu[áa]rios?\b/i.test(normTicket) ||
            /\borigem\s*:\s*acesso secret[aá]ria\b/i.test(normTicket) ||
            isFormcreatorOrGlpiForm)
        ) {
          continue;
        }
        // Evita parear PB-UNI-27 quando o chamado NÃO trata de criação de usuário de secretária/prestador no Web Saúde ou trata de formulários no GLPI
        if (
          pb.id === "PB-UNI-27" &&
          (!/\b(secret[aá]ria|prestador|web\s*sa[uú]de|16\d{6})\b/i.test(normTicket) ||
            !/\b(cria[çc][ãa]o de usu[áa]rios?|cadastr(ar|o)|novo usu[áa]rio)\b/i.test(normTicket) ||
            isFormcreatorOrGlpiForm)
        ) {
          continue;
        }
        // Evita parear PB-UNI-56 (Erro/Falha no WConect) quando o chamado não trata de falha/erro no WConect
        if (pb.id === "PB-UNI-56" && !isWconectErrorOrMessageSync) {
          continue;
        }
        // Evita parear PB-UNI-57 (Padronização Área de Trabalho / Papel de Parede / Domínio UCS) quando o chamado não trata de papel de parede ou padronização de área de trabalho
        if (pb.id === "PB-UNI-57" && !isDesktopWallpaperOrDomainPersonalization) {
          continue;
        }
        // Evita parear PB-UNI-58 (Instalação de Scanner no Computador) quando o chamado não trata de instalação/configuração de scanner
        if (pb.id === "PB-UNI-58" && !isScannerDeviceInstall) {
          continue;
        }
        // Evita parear PB-UNI-59 (Bug no Chat da Intranet) quando o chamado não trata de bug/falha no chat da Intranet
        if (pb.id === "PB-UNI-59" && !isIntranetChatOrSystemBug) {
          continue;
        }
        // Evita parear PB-UNI-60 (Tags de Métricas / GTM no Site Unimed) quando o chamado não trata de tags/métricas no site
        if (pb.id === "PB-UNI-60" && !isSiteMetricsOrGtmTags) {
          continue;
        }
        // Evita parear PB-UNI-61 (Automação de Cobrança / WhatsApp) quando o chamado não trata de automação de cobrança/mensageria
        if (pb.id === "PB-UNI-61" && !isAutomationBillingOrMessaging) {
          continue;
        }
        // Evita parear PB-UNI-62 (Criação/Manutenção de Etiquetas no GLPI / Controle de Contas) quando o chamado não trata de gestão de etiquetas de sistema
        if (pb.id === "PB-UNI-62" && !isGlpiOrSystemTagManagement) {
          continue;
        }
        // Evita parear PB-UNI-63 (Banners e Conteúdos no Site Unimed) quando o chamado não trata de banner/conteúdo no site
        if (pb.id === "PB-UNI-63" && !isSiteBannerOrContentUpdate) {
          continue;
        }
        // Evita parear PB-UNI-64 (Atualização Manual da Tabela TUSS - Diárias, Taxas e Gases no Spdata) quando o chamado não trata dessa tabela
        if (pb.id === "PB-UNI-64" && !isTussDiariasTaxasGasesManualUpdate) {
          continue;
        }
        // Evita parear PB-UNI-65 (Criação/Duplicação de Modelos de Etiquetas e Rótulos — Farmácia / Oncologia) quando o chamado não trata disso
        if (pb.id === "PB-UNI-65" && !isCustomLabelLayoutOrFieldDev) {
          continue;
        }
        // Evita parear PB-UNI-66 (Alteração de Caráter de Atendimento em Guia de Intercâmbio Nacional) quando o chamado não trata disso
        if (pb.id === "PB-UNI-66" && !isHrpIntercambioGuiaStatusChange) {
          continue;
        }
        // Evita parear PB-UNI-67 (Inclusão de Colaborador em Grupos e Listas de Distribuição de E-mails) quando o chamado não trata disso
        if (pb.id === "PB-UNI-67" && !isEmailDistributionGroup) {
          continue;
        }
        // Evita parear PB-UNI-68 (Manutenção em Samsung M4020/M4080 via Repromaq) quando o chamado não trata disso
        if (pb.id === "PB-UNI-68" && !isRepromaqSamsungMaintenance) {
          continue;
        }
        // Evita parear PB-UNI-69 (Inclusão de E-mail em Relatórios do Hospital no SGH Spdata) quando o chamado não trata disso
        if (pb.id === "PB-UNI-69" && !isHospitalSpdataScheduledReports) {
          continue;
        }
        // Evita parear PB-UNI-70 (Criação de Prescrição Padrão no PEP SGH) quando o chamado não trata disso
        if (pb.id === "PB-UNI-70" && !isPepPrescriptionProtocol) {
          continue;
        }
        // Evita parear playbooks de agenda, formulários ou desenvolvimento de novas aplicações quando o chamado trata de prescrição padrão no PEP SGH (PB-UNI-70)
        if (
          isPepPrescriptionProtocol &&
          (pb.id === "PB-UNI-18" || pb.id === "PB-UNI-09" || pb.id === "PB-UNI-32" || pb.id === "PB-UNI-30")
        ) {
          continue;
        }
        // Evita parear PB-UNI-71 (Auditorias PALC / ONA / AutoLac) quando o chamado não trata disso
        if (pb.id === "PB-UNI-71" && !isPalcOnaLaboratorioAudit) {
          continue;
        }
        // Evita parear playbooks de acessos, secretárias ou integração quando o chamado trata de auditoria PALC/ONA do Laboratório (PB-UNI-71)
        if (
          isPalcOnaLaboratorioAudit &&
          (pb.id === "PB-UNI-27" || pb.id === "PB-UNI-12" || pb.id === "PB-UNI-04" || pb.id === "PB-UNI-01")
        ) {
          continue;
        }
        // Evita parear PB-UNI-72 (Unificação de Ativos Imobilizados / Recursos no HRP) quando o chamado não trata disso
        if (pb.id === "PB-UNI-72" && !isHrpAtivoImobilizadoRecurso) {
          continue;
        }
        // Evita parear PB-UNI-73 (Falha no Upload / Anexo de Arquivos no GLPI) quando o chamado não trata disso
        if (pb.id === "PB-UNI-73" && !isGlpiAttachmentOrUploadError) {
          continue;
        }
        // Evita parear PB-UNI-74 (Mudança de Acomodação no HRP) quando o chamado não trata disso
        if (pb.id === "PB-UNI-74" && !isHrpAccommodationChange) {
          continue;
        }
        // Evita parear PB-UNI-66, PB-SD-02, PB-UNI-12 ou PB-UNI-19 quando o chamado trata de mudança de acomodação (PB-UNI-74)
        if (
          isHrpAccommodationChange &&
          (pb.id === "PB-UNI-66" || pb.id === "PB-SD-02" || pb.id === "PB-UNI-12" || pb.id === "PB-UNI-19" || pb.id === "PB-UNI-20")
        ) {
          continue;
        }
        // Evita parear relatórios agendados do SGH ou desenvolvimento de bugs quando o chamado trata de falha de anexo no GLPI (PB-UNI-73)
        if (
          isGlpiAttachmentOrUploadError &&
          (pb.id === "PB-UNI-14" || pb.id === "PB-UNI-32" || pb.id === "PB-UNI-29")
        ) {
          continue;
        }
        // Evita parear unificação genérica de pessoas/insumos, hardware físico ou acessos quando o chamado trata de unificação de recursos de ativo imobilizado (PB-UNI-72)
        if (
          isHrpAtivoImobilizadoRecurso &&
          (pb.id === "PB-UNI-19" || pb.id === "PB-UNI-20" || pb.id === "PB-UNI-07" || pb.id === "PB-UNI-12")
        ) {
          continue;
        }
        // Evita parear PB-SD-02 (Falha de Impressão Genérica) quando o chamado trata de manutenção/defeito físico em Samsung M4020/M4080 (PB-UNI-68 - Repromaq)
        if (pb.id === "PB-SD-02" && isRepromaqSamsungMaintenance) {
          continue;
        }
        // Evita parear PB-UNI-39 (Impressão Física de Etiquetas / ZebraDesigner) e PB-SD-02 (Falha de Impressão) quando o chamado trata de etiquetas de status do GLPI (PB-UNI-62) ou desenvolvimento de layout/campos de etiqueta (PB-UNI-65)
        if ((pb.id === "PB-UNI-39" || pb.id === "PB-SD-02") && (isGlpiOrSystemTagManagement || isCustomLabelLayoutOrFieldDev)) {
          continue;
        }
        // Evita parear PB-UNI-38 (Gestão de E-mails Corporativos) quando o chamado trata de automação de cobrança/mensageria, inclusão em grupos de distribuição ou relatórios do hospital
        if (pb.id === "PB-UNI-38" && (isAutomationBillingOrMessaging || isEmailDistributionGroup || isHospitalSpdataScheduledReports)) {
          continue;
        }
        // Evita parear PB-UNI-07 (Periféricos / Hardware) e PB-UNI-06 (Apoio a Eventos) quando o chamado trata de padronização de área de trabalho, scanner, tags/métricas no site, etiquetas do GLPI, banner no site, tabela TUSS ou layout de etiqueta
        if (
          (pb.id === "PB-UNI-07" || pb.id === "PB-UNI-06") &&
          (isDesktopWallpaperOrDomainPersonalization || isScannerDeviceInstall || isSiteMetricsOrGtmTags || isGlpiOrSystemTagManagement || isSiteBannerOrContentUpdate || isTussDiariasTaxasGasesManualUpdate || isCustomLabelLayoutOrFieldDev)
        ) {
          continue;
        }
        // Evita parear PB-UNI-16 (Extração de Indicadores/Relatórios) quando o chamado trata de relatórios agendados do hospital, agenda de profissional, erro do WConect ou não cita indicadores/relatórios
        if (
          pb.id === "PB-UNI-16" &&
          (isHospitalSpdataScheduledReports ||
            /\bagenda\b/i.test(normTicket) ||
            isWconectErrorOrMessageSync ||
            (!isMedicalProductionExtraction &&
              !/\b(indicador|indicadores|produtividade|relat[oó]rio|relatorios|extra[çc][ãa]o|levantamento|quantitativo)\b/i.test(
                normTicket
              )))
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
        // Evita parear PB-UNI-28 (Reabertura de Registro / Reversão de Encerramento) quando o chamado não trata de reabertura/reversão ou trata de desenvolvimento
        if (
          pb.id === "PB-UNI-28" &&
          (!isReopenOrRevertAccount ||
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
        // Evita parear PB-UNI-29 (Criação ou Parametrização de Formulários GLPI) quando o chamado não trata de itens/formulários no GLPI
        if (
          pb.id === "PB-UNI-29" &&
          !isFormcreatorOrGlpiForm
        ) {
          continue;
        }
        // Evita parear PB-UNI-30 (Agenda Oncologia) quando o chamado não trata do sistema ou agendamento de Oncologia
        if (
          pb.id === "PB-UNI-30" &&
          (!/\boncologia\b/i.test(normTicket) ||
            isCustomLabelLayoutOrFieldDev ||
            !/\b(agenda|agendamento|dura[cç][aã]o|tempo\s+m[ií]nimo|hor[aá]rios?|subcut[aâ]nea|procedimentos?)\b/i.test(
              normTicket
            ))
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
        // Evita parear PB-UNI-14 (Relatórios Agendados SGH) quando o chamado não trata de relatório agendado, trata de novos relatórios do hospital ou trata de falha no WConect
        if (
          pb.id === "PB-UNI-14" &&
          (isWconectErrorOrMessageSync ||
            isHospitalSpdataScheduledReports ||
            !/\b(relat[oó]rio|relatorios|agendad[ao]|disparo|checklist|check-list|di[aá]ri[ao]|smtp)\b/i.test(
              normTicket
            ))
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
          !isScannerDeviceInstall &&
          (/\b(scan\s+to\s+e-?mail|cat[aá]logo\s+de\s+endere[cç]os|cadastr(ar|o)\s+(?:de\s+|o\s+|meu\s+)?e-?mail)\b/i.test(normTicket) ||
            (/\b(scan|scanner|digitaliz|digitalizacao)\b/i.test(normTicket) &&
              /\b(e-?mail|email|cat[aá]logo|lgpd|samsung|m4080)\b/i.test(normTicket)) ||
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
        const isPrinterInstallOrNewRequest =
          /\b(precisamos de (?:uma? )?impressora|instala[çc][ãa]o de impressora|instalar impressora|disponibilizar impressora|fornecer impressora|colocar (?:uma? )?impressora|nova impressora|impressora nova|solicito (?:uma? )?impressora|solicitamos (?:uma? )?impressora|impressora para (?:a|o)?\s*(?:neuro|m[ée]dic|consult[oó]ri|psic[oó]log|recep[çc]|setor|sala|posto|pr[ée]dio))\b/i.test(
            normTicket
          ) &&
          !/\b(nao esta imprimindo|parou de imprimir|spooler|mancha|atolamento|papel preso|qualidade|fila|travad)\b/i.test(
            normTicket
          );

        // Evita parear Playbook de Falha de Impressão (PB-SD-02) quando o chamado pede remanejamento físico de equipamento ou instalação de ponto de telefone/rede ou cadastro de e-mail/scan ou troca de toner/tintas/suprimentos ou instalação/fornecimento de nova impressora ou aplicativo de etiquetas/atalho ou desenvolvimento de painel de senhas
        if (
          (pb.id === "PB-SD-02" || pb.id === "PB-UNI-08") &&
          (isQueueOrPainelSenhaDev || isRelocationOrPhoneInstall || isScanToEmail || isSupplyOrTonerRequest || isPrinterInstallOrNewRequest || isLabelAppOrDesktopShortcut || isGlpiOrSystemTagManagement)
        ) {
          continue;
        }
        // Evita parear PB-UNI-36 (Instalação/Disponibilização de Impressora) quando o chamado NÃO trata de instalação/pedido de impressora ou quando trata de aplicativo de etiquetas/atalho
        if (pb.id === "PB-UNI-36" && (!isPrinterInstallOrNewRequest || isLabelAppOrDesktopShortcut)) {
          continue;
        }
        // Evita parear PB-UNI-39 (Aplicativo de Impressão de Etiquetas / Atalho) quando o chamado NÃO trata de aplicativo de etiquetas/atalho
        if (pb.id === "PB-UNI-39" && !isLabelAppOrDesktopShortcut) {
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
            isRelocationOrPhoneInstall ||
            /\b(caindo|quedas?|interromp|ligacoes caindo|ligações caindo|remanej|mudan[çc]a|trocar (?:o\s+)?ramal|mesa)\b/i.test(
              normTicket
            ))
        ) {
          continue;
        }
        // Evita parear Playbook de Scan to E-mail (PB-UNI-23) quando não trata de scan/cadastro de e-mail na impressora
        if (pb.id === "PB-UNI-23" && !isScanToEmail) {
          continue;
        }
        // Evita parear Playbook de XML TISS Hash (PB-UNI-03) quando o chamado não trata de XML/TISS/Hash ou quando trata de divergência de valores no Batalhão/SIGAS (PB-UNI-46)
        if (
          pb.id === "PB-UNI-03" &&
          (!/\b(xml|tiss|hash)\b/i.test(normTicket) ||
            (isXmlBatalhaoOrSghValueMismatch && !/\bhash\b/i.test(normTicket)))
        ) {
          continue;
        }
        // Evita parear PB-UNI-46 (Importação XML SGH Spdata / Batalhão / SIGAS) quando não trata de XML com Batalhão/IPSM/SIGAS ou divergência de valores de equipe
        if (pb.id === "PB-UNI-46" && !isXmlBatalhaoOrSghValueMismatch) {
          continue;
        }
        // Evita parear PB-UNI-47 (Criação/Parametrização de Tabelas e Regras em Sistemas) quando não trata de criação/parametrização de tabelas
        if (pb.id === "PB-UNI-47" && !isSystemTableParameterization) {
          continue;
        }
        // Evita parear PB-UNI-48 (DocuSign - Acesso Compartilhado e Permissões de Contratos) quando não trata de DocuSign
        if (pb.id === "PB-UNI-48" && !isDocusignAccessOrShared) {
          continue;
        }
        // Evita parear PB-UNI-38 (Gestão de E-mails Corporativos / Redirecionamento) quando o chamado trata de DocuSign
        if (pb.id === "PB-UNI-38" && isDocusignAccessOrShared) {
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
          (isFacialBiometricOrDoorAccess ||
            /\bintranet\b/i.test(normTicket) ||
            /\b(acesso secret[aá]ria|web\s*sa[uú]de|c[oó]digo do prestador|16\d{6})\b/i.test(
              normTicket
            ) ||
            (/\b(ja foi liberado|já foi liberado)\b/i.test(normTicket) &&
              !/\b(ponto|myplace|rep|biometria)\b/i.test(normTicket)))
        ) {
          continue;
        }
        // Evita parear Playbook de Intranet (PB-UNI-22) quando o chamado não cita Intranet ou quando trata de bug no chat / falha na Intranet (PB-UNI-59)
        if (pb.id === "PB-UNI-22" && (!/\bintranet\b/i.test(normTicket) || isIntranetChatOrSystemBug)) {
          continue;
        }
        const isDoubtOrOrientation =
          /\b(d[uú]vidas?|orienta[cç][aã]o|orienta[cç][õo]es|como fazer|onde fica|onde encontro|n[aã]o encontrei|n[aã]o achei|como preencher|onde anexar|instru[cç][aã]o de uso|passo a passo|desapercebid[ao])\b/i.test(
            normTicket
          );
        // Evita parear PB-UNI-37 (Dúvidas e Orientações) quando o chamado não trata de dúvidas ou orientações ou quando se trata de autorização/senha/guia no HRP
        if (pb.id === "PB-UNI-37" && (!isDoubtOrOrientation || isHrpAuthorizationOrIntercambio || isHrpIntercambioGuiaStatusChange)) {
          continue;
        }
        // Evita parear PB-UNI-71 (Evidências de Segurança/AutoLac para PALC) quando se trata de pesquisa de satisfação/totem
        if (
          pb.id === "PB-UNI-71" &&
          (isLaboratorioCustomerSatisfactionTool || !isPalcOnaLaboratorioAudit)
        ) {
          continue;
        }
        // Evita parear PB-UNI-75 (Pesquisa de Satisfação/Totem no Laboratório) quando não se trata de pesquisa de satisfação/totem
        if (
          pb.id === "PB-UNI-75" &&
          !isLaboratorioCustomerSatisfactionTool
        ) {
          continue;
        }
        // Evita parear PB-UNI-76 (Painel de Senhas / Gerenciador de Filas) quando não se trata de painel de senhas/fila de atendimento
        if (
          pb.id === "PB-UNI-76" &&
          !isQueueOrPainelSenhaDev
        ) {
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
        if (
          pb.id === "PB-UNI-36" &&
          isPrinterInstallOrNewRequest
        ) {
          score = Math.max(score, 0.90);
        }
        if (
          pb.id === "PB-UNI-29" &&
          isFormcreatorOrGlpiForm
        ) {
          score = Math.max(score, 0.92);
        }
        if (
          pb.id === "PB-UNI-37" &&
          isDoubtOrOrientation
        ) {
          score = Math.max(score, 0.90);
        }
        const isEmailMgmt =
          !isExternalAgencyOrPortal &&
          (/\b(redirecion|redirecionamento|redirecionar|redirecionadas|encaminh|encaminhamento|encaminhar|caixa departamental|caixa compartilhada|marketing@|jornalismo@)\b/i.test(
            normTicket
          ) ||
          (/\b(e-mail|email)\b/i.test(normTicket) &&
            !/\b(e-?mail marketing|ferramenta de e-?mail marketing)\b/i.test(normTicket) &&
            /\b(marketing|jornalismo|financeiro|compras|faturamento|recurso|ouvidoria|contato|recepcao|secretaria)\b/i.test(
              normTicket
            ) &&
            /\b(conta|caixa|acesso|permissao|redirecion)\b/i.test(normTicket)));
        if (
          pb.id === "PB-UNI-38" &&
          isEmailMgmt
        ) {
          score = Math.max(score, 0.95);
        }
        if (
          pb.id === "PB-UNI-39" &&
          isLabelAppOrDesktopShortcut
        ) {
          score = Math.max(score, 0.95);
        }
        if (
          pb.id === "PB-UNI-40" &&
          isUnlockAccount
        ) {
          score = Math.max(score, 0.95);
        }
        if (
          pb.id === "PB-UNI-41" &&
          isExternalAgencyOrPortal
        ) {
          score = Math.max(score, 0.95);
        }
        if (
          pb.id === "PB-UNI-42" &&
          isNextcloudDuplicationOrConflict
        ) {
          score = Math.max(score, 0.95);
        }
        if (
          pb.id === "PB-UNI-43" &&
          isHospitalMedicalRecordRegistration
        ) {
          score = Math.max(score, 0.95);
        }
        if (
          pb.id === "PB-UNI-44" &&
          isNextcloudInstallOrUnidrive
        ) {
          score = Math.max(score, 0.95);
        }
        if (
          pb.id === "PB-UNI-45" &&
          isHrpAuthorizationOrIntercambio
        ) {
          score = Math.max(score, 0.95);
        }
        if (
          pb.id === "PB-UNI-28" &&
          isReopenOrRevertAccount
        ) {
          score = Math.max(score, 0.95);
        }
        if (
          pb.id === "PB-UNI-46" &&
          isXmlBatalhaoOrSghValueMismatch
        ) {
          score = Math.max(score, 0.96);
        }
        if (
          pb.id === "PB-UNI-47" &&
          (isSystemTableParameterization || isIpsmTable)
        ) {
          score = Math.max(score, isIpsmTable ? 0.98 : 0.96);
        }
        if (
          pb.id === "PB-UNI-48" &&
          isDocusignAccessOrShared
        ) {
          score = Math.max(score, 0.96);
        }
        if (
          pb.id === "PB-UNI-49" &&
          isFacialBiometricOrDoorAccess
        ) {
          score = Math.max(score, 0.98);
        }
        if (
          pb.id === "PB-UNI-20" &&
          isRelocationOrPhoneInstall
        ) {
          score = Math.max(score, 0.96);
        }
        if (
          pb.id === "PB-UNI-21" &&
          /\b(internet|wifi|wi-fi|roteador|access point|sinal|salas?|m[ée]dicos?)\b/i.test(normTicket)
        ) {
          score = Math.max(score, 0.98);
        }
        if (
          pb.id === "PB-UNI-56" &&
          isWconectErrorOrMessageSync
        ) {
          score = Math.max(score, 0.98);
        }
        if (
          pb.id === "PB-UNI-57" &&
          isDesktopWallpaperOrDomainPersonalization
        ) {
          score = Math.max(score, 0.98);
        }
        if (
          pb.id === "PB-UNI-58" &&
          isScannerDeviceInstall
        ) {
          score = Math.max(score, 0.98);
        }
        if (
          pb.id === "PB-UNI-59" &&
          isIntranetChatOrSystemBug
        ) {
          score = Math.max(score, 0.98);
        }
        if (
          pb.id === "PB-UNI-60" &&
          isSiteMetricsOrGtmTags
        ) {
          score = Math.max(score, 0.98);
        }
        if (
          pb.id === "PB-UNI-61" &&
          isAutomationBillingOrMessaging
        ) {
          score = Math.max(score, 0.98);
        }
        if (
          pb.id === "PB-UNI-62" &&
          isGlpiOrSystemTagManagement
        ) {
          score = Math.max(score, 0.99);
        }
        if (
          pb.id === "PB-UNI-63" &&
          isSiteBannerOrContentUpdate
        ) {
          score = Math.max(score, 0.99);
        }
        if (
          pb.id === "PB-UNI-64" &&
          isTussDiariasTaxasGasesManualUpdate
        ) {
          score = Math.max(score, 0.99);
        }
        if (
          pb.id === "PB-UNI-65" &&
          isCustomLabelLayoutOrFieldDev
        ) {
          score = Math.max(score, 0.99);
        }
        if (
          pb.id === "PB-UNI-66" &&
          isHrpIntercambioGuiaStatusChange
        ) {
          score = Math.max(score, 0.99);
        }
        if (
          pb.id === "PB-UNI-67" &&
          isEmailDistributionGroup
        ) {
          score = Math.max(score, 0.99);
        }
        if (
          pb.id === "PB-UNI-68" &&
          isRepromaqSamsungMaintenance
        ) {
          score = Math.max(score, 0.99);
        }
        if (
          pb.id === "PB-UNI-69" &&
          isHospitalSpdataScheduledReports
        ) {
          score = Math.max(score, 0.99);
        }
        if (
          pb.id === "PB-UNI-70" &&
          isPepPrescriptionProtocol
        ) {
          score = Math.max(score, 0.99);
        }
        if (
          pb.id === "PB-UNI-71" &&
          isPalcOnaLaboratorioAudit
        ) {
          score = Math.max(score, 0.99);
        }
        if (
          pb.id === "PB-UNI-72" &&
          isHrpAtivoImobilizadoRecurso
        ) {
          score = Math.max(score, 0.99);
        }
        if (
          pb.id === "PB-UNI-73" &&
          isGlpiAttachmentOrUploadError
        ) {
          score = Math.max(score, 0.99);
        }
        if (
          pb.id === "PB-UNI-74" &&
          isHrpAccommodationChange
        ) {
          score = Math.max(score, 0.99);
        }
        if (
          pb.id === "PB-UNI-16" &&
          isMedicalProductionExtraction
        ) {
          score = Math.max(score, 0.99);
        }
        if (
          pb.id === "PB-UNI-75" &&
          isLaboratorioCustomerSatisfactionTool
        ) {
          score = Math.max(score, 0.99);
        }
        if (
          pb.id === "PB-UNI-76" &&
          isQueueOrPainelSenhaDev
        ) {
          score = Math.max(score, 0.99);
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

      let score = computeRelevance(
        fullTicketText,
        ticketTokens,
        kb.title || "",
        kb.summary || "",
        kb.keywords || []
      );
      if (isXmlBatalhaoOrSghValueMismatch && /\b(batalh[aã]o|ipsmmg|sigas)\b/i.test(normKbTitle)) {
        score = Math.max(score, 0.96);
      }
      if (isDocusignAccessOrShared && /\b(docusign|acesso compartilhado)\b/i.test(normKbTitle)) {
        score = Math.max(score, 0.96);
      }
      if (
        isTussDiariasTaxasGasesManualUpdate &&
        /\b(tuss|00952|di[aá]rias,\s*taxas\s+e\s+gases)\b/i.test(normKbTitle)
      ) {
        score = Math.max(score, 0.96);
      }
      if (
        isHrpIntercambioGuiaStatusChange &&
        /\b(interc[aâ]mbio|eletivo|urg[eê]ncia|hrp)\b/i.test(normKbTitle)
      ) {
        score = Math.max(score, 0.98);
      }
      if (
        isPepPrescriptionProtocol &&
        /\b(prescri[cç][aã]o|protocolo|pep|sgh)\b/i.test(normKbTitle)
      ) {
        score = Math.max(score, 0.98);
      }
      if (
        isHrpAtivoImobilizadoRecurso &&
        /\b(ativo\s+imobilizado|recurso|ide\s+engine|lote)\b/i.test(normKbTitle)
      ) {
        score = Math.max(score, 0.98);
      }
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
      if (
        /\b(internet|wi-?fi|wifi|sinal|roteador|access point)\b/i.test(normTicket) &&
        /\b(desenvolvimento|layout|interface|painel acompanhamento|banner|confer[eê]ncia patrimonial|adequa[cç][aã]o painel)\b/i.test(
          normalizeText(`${hist.title} ${hist.summary}`)
        )
      ) {
        continue;
      }
      if (
        isWconectErrorOrMessageSync &&
        /\b(indicadores?|relat[oó]rios?)\b/i.test(normalizeText(`${hist.title} ${hist.summary}`))
      ) {
        continue;
      }
      if (
        !/\b(wconect|wconnect|wconectt)\b/i.test(normTicket) &&
        /\b(wconect|wconnect|wconectt)\b/i.test(normalizeText(`${hist.title} ${hist.summary}`))
      ) {
        continue;
      }
      if (
        isDesktopWallpaperOrDomainPersonalization &&
        !/\b(papel\s+de\s+parede|plano\s+de\s+fundo|padroniza[cç][aã]o\s+(?:da\s+)?[aá]rea\s+de\s+trabalho|unimed256|unimedti|\bucs\b|\bgpo\b)\b/i.test(
          normalizeText(`${hist.title} ${hist.summary}`)
        )
      ) {
        continue;
      }
      if (
        isScannerDeviceInstall &&
        !/\b(instala[cç][aã]o\s+d[eo]\s+scann?ers?|instalar\s+(?:o\s+|um\s+)?scann?ers?|scann?ers?\s+separado)\b/i.test(
          normalizeText(`${hist.title} ${hist.summary}`)
        )
      ) {
        continue;
      }
      if (
        isIntranetChatOrSystemBug &&
        !/\b(chat\s+da\s+intranet|chat\s+intranet|destinat[aá]rio\s+errado)\b/i.test(
          normalizeText(`${hist.title} ${hist.summary}`)
        )
      ) {
        continue;
      }
      if (
        isSiteMetricsOrGtmTags &&
        !/\b(google\s+tag\s+manager|\bgtm\b|google\s+analytics|search\s+console|pixel\s+(?:da\s+)?meta|tags?\s+de\s+acompanhamento)\b/i.test(
          normalizeText(`${hist.title} ${hist.summary}`)
        )
      ) {
        continue;
      }
      if (
        isGlpiOrSystemTagManagement &&
        (!/\betiquetas?\b/i.test(normalizeText(`${hist.title} ${hist.summary}`)) ||
          /\b(bitdefender|antiv[ií]rus|zebra|impressora)\b/i.test(
            normalizeText(`${hist.title} ${hist.summary}`)
          ))
      ) {
        continue;
      }
      if (
        isSiteBannerOrContentUpdate &&
        !/\b(banners?|igualdade\s+salarial)\b/i.test(normalizeText(`${hist.title} ${hist.summary}`))
      ) {
        continue;
      }
      if (
        isTussDiariasTaxasGasesManualUpdate &&
        !/\b(tuss|00952|di[aá]rias,\s*taxas\s+e\s+gases)\b/i.test(
          normalizeText(`${hist.title} ${hist.summary}`)
        )
      ) {
        continue;
      }
      if (
        isCustomLabelLayoutOrFieldDev &&
        !/\b(etiquetas?\s+para\s+r[oó]tulos?|duplicar\s+etiqueta)\b/i.test(
          normalizeText(`${hist.title} ${hist.summary}`)
        )
      ) {
        continue;
      }
      if (
        isHrpIntercambioGuiaStatusChange &&
        !/\b(interc[aâ]mbio|guia|urg[eê]ncia|eletiv|senha\s+de\s+autoriza|car[aá]ter)\b/i.test(
          normalizeText(`${hist.title} ${hist.summary}`)
        )
      ) {
        continue;
      }
      let score = computeRelevance(
        fullTicketText,
        ticketTokens,
        hist.title || "",
        hist.summary || "",
        hist.keywords || []
      );
      if (
        isCustomLabelLayoutOrFieldDev &&
        /\betiquetas?\s+para\s+r[oó]tulos?\b/i.test(normalizeText(hist.title || ""))
      ) {
        score = Math.max(score, 0.86);
      }
      if (
        isGlpiOrSystemTagManagement &&
        /\bcria[cç][aã]o\s+de\s+etiquetas?\b/i.test(normalizeText(hist.title || ""))
      ) {
        score = Math.max(score, 0.85);
      }
      if (
        isHrpAccommodationChange &&
        /\bacomoda[cç][aã]o\b/i.test(normalizeText(hist.title || ""))
      ) {
        score = Math.max(score, 0.88);
      }
      if (
        isSiteBannerOrContentUpdate &&
        /\baltera[cç][aã]o\s+banner\s+site\b/i.test(normalizeText(hist.title || ""))
      ) {
        score = Math.max(score, 0.88);
      }
      if (
        isWconectErrorOrMessageSync &&
        /\b(erro\s+de\s+conex[aã]o\s+wconect|corre[cç][aã]o\s+de\s+bugs.*wconect)/i.test(
          normalizeText(hist.title || "")
        )
      ) {
        score = Math.max(score, 0.72);
      }
      if (
        isSystemTableParameterization &&
        /\bbras[ií]ndice\b/i.test(normTicket) &&
        /\bbras[ií]ndice\b/i.test(normalizeText(`${hist.title} ${hist.summary}`))
      ) {
        score = Math.max(score, 0.78);
      }
      if (
        isIpsmTable &&
        /\b(ipsm|batalh[aã]o)\b/i.test(normalizeText(`${hist.title} ${hist.summary}`))
      ) {
        score = Math.max(score, 0.88);
      }
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
        // Evita parear memórias de Tags de Métricas / GTM no site (ex.: MEM-#44128) quando o chamado NÃO trata de tags/métricas no site
        if (
          !isSiteMetricsOrGtmTags &&
          /\b(google\s+tag\s+manager|\bgtm\b|gtm-khvfl3c|tags?\s+de\s+acompanhamento\s+de\s+m[eé]tricas)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary} ${mem.reply_template || ""}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de Etiquetas no GLPI (ex.: MEM-#44325) quando o chamado NÃO trata de etiquetas no GLPI
        if (
          !isGlpiOrSystemTagManagement &&
          /\b(adicionar\s+etiqueta\s+no\s+glpi|manuten[cç][aã]o\s+e\s+adi[cç][aã]o\s+de\s+etiquetas)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary} ${mem.reply_template || ""}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de outros temas quando o chamado trata de banner/conteúdo no site
        if (
          isSiteBannerOrContentUpdate &&
          !/\bbanners?\b/i.test(normalizeText(`${mem.title} ${mem.problem_summary}`))
        ) {
          continue;
        }
        // Evita parear memórias de outros temas quando o chamado trata da tabela TUSS - Diárias, Taxas e Gases (00952)
        if (
          isTussDiariasTaxasGasesManualUpdate &&
          !/\b(tuss|00952|di[aá]rias,\s*taxas\s+e\s+gases)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de outros temas quando o chamado trata de desenvolvimento/duplicação de layout de etiqueta (ex.: etiqueta de oncologia)
        if (
          isCustomLabelLayoutOrFieldDev &&
          !/\b(duplicar\s+etiqueta|etiquetas?\s+de\s+oncologia|etiquetas?\s+para\s+r[oó]tulos?)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de outros temas quando o chamado trata de criação/manutenção de etiquetas no GLPI
        if (
          isGlpiOrSystemTagManagement &&
          (!/\betiquetas?\b/i.test(normalizeText(`${mem.title} ${mem.problem_summary}`)) ||
            /\b(zebra|impressora|bitdefender|atalho)\b/i.test(
              normalizeText(`${mem.title} ${mem.problem_summary}`)
            ))
        ) {
          continue;
        }
        // Evita parear memórias de Oncologia (ex.: MEM-#42241) quando o chamado NÃO cita Oncologia
        if (
          !/\boncologia\b/i.test(normTicket) &&
          /\boncologia\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary} ${mem.reply_template || ""}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de Internet/Wi-Fi/Salas médicas (ex.: MEM-#43498) quando o chamado NÃO trata de internet/wifi
        if (
          !/\b(internet|wi-?fi|wifi|roteador|access point)\b/i.test(normTicket) &&
          /\b(instabilidade da internet|reclama[cç][oõ]es dos m[eé]dicos|salas de atendimento)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary} ${mem.reply_template || ""}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de outros temas quando o chamado trata de tags de métricas / GTM no site
        if (
          isSiteMetricsOrGtmTags &&
          !/\b(google\s+tag\s+manager|\bgtm\b|google\s+analytics|search\s+console|pixel\s+(?:da\s+)?meta|tags?\s+de\s+acompanhamento)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de relatórios assistenciais/cateteres ou e-mail quando o chamado trata de automação de cobrança/mensageria
        if (
          isAutomationBillingOrMessaging &&
          !/\b(automa[çc][ãa]o|cobran[çc]a|whatsapp|wpp|t[ií]tulos?\s+em\s+atraso)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de WConect (ex.: MEM-#44220) quando o chamado NÃO cita WConect
        if (
          !/\b(wconect|wconnect|wconectt)\b/i.test(normTicket) &&
          /\b(wconect|wconnect|wconectt)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary} ${mem.reply_template || ""}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de outros temas quando o chamado trata de bug no chat da Intranet
        if (
          isIntranetChatOrSystemBug &&
          !/\b(chat\s+da\s+intranet|chat\s+intranet|destinat[aá]rio\s+errado)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de outros temas quando o chamado trata de instalação de scanner no computador
        if (
          isScannerDeviceInstall &&
          !/\b(instala[cç][aã]o\s+d[eo]\s+scann?ers?|instalar\s+(?:o\s+|um\s+)?scann?ers?|scann?ers?\s+separado)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de periféricos/hardware/outros temas quando o chamado trata de padronização de área de trabalho / papel de parede / domínio UCS
        if (
          isDesktopWallpaperOrDomainPersonalization &&
          !/\b(papel\s+de\s+parede|plano\s+de\s+fundo|padroniza[cç][aã]o\s+(?:da\s+)?[aá]rea\s+de\s+trabalho|unimed256|unimedti|\bucs\b|\bgpo\b)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary} ${mem.reply_template || ""}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de papel de parede / padronização de área de trabalho quando o chamado NÃO trata desse tema
        if (
          !isDesktopWallpaperOrDomainPersonalization &&
          /\b(papel\s+de\s+parede|plano\s+de\s+fundo|padroniza[cç][aã]o\s+(?:da\s+)?[aá]rea\s+de\s+trabalho)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de indicadores do WConect (ex.: MEM-#42012) quando o chamado trata de erro/bug operacional no WConect
        if (
          isWconectErrorOrMessageSync &&
          /\b(indicadores?|relat[oó]rios?|per[ií]odo de refer[eê]ncia)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary} ${mem.reply_template || ""}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de onboarding interno ou acessos genéricos quando o chamado trata de agência externa / gerenciador do portal
        if (
          isExternalAgencyOrPortal &&
          !/\b(urucum|ag[eê]ncia|portal unimed|gerenciador do site)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de onboarding ou bloqueio quando o chamado trata de desbloqueio de contas
        if (
          isUnlockAccount &&
          !/\b(desbloque|desbloquear|desbloqueio)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de falha de acesso/pasta sumida do Nextcloud (ex.: MEM-#42404, MEM-#42159) quando o chamado trata de duplicação/conflito de arquivos
        if (
          isNextcloudDuplicationOrConflict &&
          !/\b(duplic|conflito|extens[aã]o)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de outros temas quando o chamado trata de alteração de caráter de atendimento em guia de Intercâmbio Nacional
        if (
          isHrpIntercambioGuiaStatusChange &&
          !/\b(interc[aâ]mbio|guia|urg[eê]ncia|eletiv|senha\s+de\s+autoriza|car[aá]ter)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de outros temas quando o chamado trata de importação/divergência de XML TISS no Batalhão/SIGAS
        if (
          isXmlBatalhaoOrSghValueMismatch &&
          !/\b(xml|batalh[aã]o|ipsm|ipsmmg|sigas)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de XML TISS / Hash (ex.: MEM-#42071) quando o chamado NÃO trata de XML
        if (
          !/\b(xml|tiss|sigas)\b/i.test(normTicket) &&
          /\b(xml|hash\s+tiss|recalculador\s+de\s+hash)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary} ${(mem.resolution_steps || []).join(" ")}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de outros temas (ex.: exclusão de taxa ou desenvolvimento controle de contas) quando o chamado trata de criação/parametrização de tabela (ex.: DTH - PADRAO, Brasíndice, Simpro)
        if (
          isSystemTableParameterization &&
          !/\b(criar\s+tabela|tabela\s+dth|dth\s*[-–]?\s*padr[aã]o|tabela\s+de\s+di[aá]rias|faixa\s+(?:de\s+)?998|parametriza[cç][aã]o\s+de\s+sistemas\s+e\s+tabelas|bras[ií]ndice|simpro)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memória de atualização manual de TUSS 00952 quando o chamado trata de tabela de medicamentos IPSM/Batalhão (que é importada pela TI)
        if (
          isIpsmTable &&
          /\b(00952|tuss.*00952|manuten[cç][aã]o.*manual|atualiza[cç][aã]o\s+manual)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary} ${(mem.resolution_steps || []).join(" ")}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de outros temas quando o chamado trata de DocuSign / Acesso Compartilhado de Contratos
        if (
          isDocusignAccessOrShared &&
          !/\b(docusign|docu\s*sign|acesso\s+compartilhado)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de outros temas quando o chamado trata de autorização de procedimento / senha / intercâmbio no HRP
        if (
          isHrpAuthorizationOrIntercambio &&
          !/\b(senha|interc[âa]mbio|autoriza[çc][ãa]o|guia|ptu)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de formulários do GLPI / Formcreator (ex: MEM-#42472) quando o chamado NÃO trata de itens/formulários no GLPI
        if (
          !isFormcreatorOrGlpiForm &&
          /\b(novo formul[aá]rio|cria[cç][aã]o de formul[aá]rio|formcreator|novo item no glpi)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        if (
          /\b(web\s*sa[uú]de|clinicas?|16\d{6})\b/i.test(normTicket) &&
          !/\b(web\s*sa[uú]de|clinicas?|16\d{6})\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de vinculação de unidade/perfil (ex: MEM-#41992) quando o chamado trata de reabertura, reversão de encerramento ou cancelamento de registro no Controle de Contas
        if (
          (/\b(reabrir|reabertura|cancelar|cancelamento|excluir|exclusao|estornar|revers[aã]o|reverter|voltar remessa|remessa)\b/i.test(normTicket) ||
            isReopenOrRevertAccount) &&
          /\b(vincular|vinculacao|unidade piumhi|acesso ao meu usuario)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de reabertura/ativação de contas quando o chamado NÃO trata de reabrir/ativar/reverter conta
        if (
          (!isReopenOrRevertAccount && !/\b(reabrir|reabertura|abrir conta|abrir contas|abrir registro|ativar conta|reativar conta|encerrad[ao] erroneamente)\b/i.test(normTicket)) &&
          /\b(reabrir|reabertura|abrir conta|abrir contas|abrir registro|ativar conta|reativar conta|1411181|revers[aã]o)\b/i.test(
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
        // Evita parear memórias de faturamento, XML ou acessos comuns quando o chamado é de cadastro de profissionais no Prontuário do Hospital / PEP Hospitalar
        if (
          isHospitalMedicalRecordRegistration &&
          !/\b(prontu[aá]rio|pep\s+hospitalar)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de "pasta sumiu" ou falha de leitura (ex: MEM-#42404, MEM-#42159) quando o chamado é de INSTALAÇÃO do Unidrive / Nextcloud em nova máquina
        if (
          isNextcloudInstallOrUnidrive &&
          !/\b(instalar|instala[çc][ãa]o|unidrive)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de Unidrive / Nextcloud (ex: MEM-#43047) quando o chamado NÃO cita Unidrive ou Nextcloud
        if (
          !/\b(unidrive|uni\s*drive|nextcloud|nextclaud|next\s*cloud)\b/i.test(normTicket) &&
          /\b(unidrive|uni\s*drive|nextcloud|nextclaud|next\s*cloud)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary} ${mem.reply_template || ""}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de Desbloqueio de Contas (ex: MEM-#42953) quando o chamado NÃO trata de desbloqueio
        if (
          !isUnlockAccount &&
          /\b(desbloqueio|desbloquear|conta bloqueada|usuario bloqueado)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de Web Saúde / secretárias / acessos quando o chamado trata de criação ou ajuste de formulários no GLPI
        if (
          isFormcreatorOrGlpiForm &&
          /\b(web\s*sa[uú]de|secret[aá]ria|prestador|16\d{6}|acesso e permiss[õo]es|cria[çc][ãa]o de usu[áa]rios?|libera[çc][ãa]o de acesso|faturamento eletr[oô]nico|senha|bloqueada|dalete olivira)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de formulários no GLPI quando o chamado NÃO trata de GLPI
        if (
          !isFormcreatorOrGlpiForm &&
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
        // Evita parear memórias de telefonia com defeito/transferência (ex: MEM-#42293) quando o chamado é de remanejamento/mudança de local
        if (
          isRelocationOrPhoneInstall &&
          /\b(transferindo|transferir|caindo|quedas?|mudo|sem sinal|chiado|inoperante|trocar os telefones)\b/i.test(
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
        // Evita parear memórias de hardware de impressora/remanejamento/toner/scan quando o chamado trata de aplicativo de etiquetas ou atalho na Área de Trabalho
        if (
          isLabelAppOrDesktopShortcut &&
          !/\b(aplicativo|app|software|atalho|[aá]rea de trabalho|desktop)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de Desenvolvimento/Oncologia/Agenda quando o chamado trata de Internet/Wi-Fi/Redes
        if (
          /\b(internet|wi-?fi|wifi|sinal|roteador|access point)\b/i.test(normTicket) &&
          /\b(oncologia|agenda|duracao|tempo minimo|medica[çc][aã]o|subcutanea|desenvolvimento|layout|interface)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de outros colaboradores quando o chamado trata de Inclusão em Grupos/Listas de E-mail (PB-UNI-67)
        if (
          isEmailDistributionGroup &&
          mem.ticket_id !== ticket.id
        ) {
          continue;
        }
        // Evita parear memórias de Redefinição de Senhas quando o chamado NÃO trata de redefinição ou esquecimento de senha
        if (
          !/\b(senha|redefini|redefinir|resetar|esqueci|desbloqueio\s+de\s+senha)\b/i.test(normTicket) &&
          /\b(redefini[çc][ãa]o\s+de\s+senhas?|reset\s+de\s+senha)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de Troca de Toner quando o chamado trata de manutenção/defeito físico em impressora Samsung Repromaq (PB-UNI-68)
        if (
          isRepromaqSamsungMaintenance &&
          /\b(troca\s+de\s+toner|toner|tonner)\b/i.test(
            normalizeText(`${mem.title} ${mem.problem_summary}`)
          )
        ) {
          continue;
        }
        // Evita parear memórias de outros relatórios quando o chamado trata de Inclusão em Relatórios do Hospital no SGH Spdata (PB-UNI-69)
        if (
          isHospitalSpdataScheduledReports &&
          mem.ticket_id !== ticket.id
        ) {
          continue;
        }
        // Evita parear memórias de outros chamados quando o chamado trata de criação de protocolo/prescrição no PEP SGH (PB-UNI-70)
        if (
          isPepPrescriptionProtocol &&
          mem.ticket_id !== ticket.id
        ) {
          continue;
        }
        // Evita parear memórias de outros chamados quando o chamado trata de auditoria PALC/ONA do Laboratório (PB-UNI-71)
        if (
          isPalcOnaLaboratorioAudit &&
          mem.ticket_id !== ticket.id
        ) {
          continue;
        }
        // Evita parear memórias de outros chamados quando o chamado trata de unificação de recursos de ativo imobilizado no HRP (PB-UNI-72)
        if (
          isHrpAtivoImobilizadoRecurso &&
          mem.ticket_id !== ticket.id
        ) {
          continue;
        }
        // Evita parear memórias de outros chamados quando o chamado trata de falha no upload/anexo de arquivos no GLPI (PB-UNI-73)
        if (
          isGlpiAttachmentOrUploadError &&
          mem.ticket_id !== ticket.id
        ) {
          continue;
        }
        // Evita parear memórias de outros chamados quando o chamado trata de mudança de acomodação no HRP (PB-UNI-74)
        if (
          isHrpAccommodationChange &&
          mem.ticket_id !== ticket.id
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
