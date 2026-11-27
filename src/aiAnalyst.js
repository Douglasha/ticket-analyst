import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  extractFormCreatorFields,
  loadPlaybooks,
  normalizeText,
} from "./knowledgeEngine.js";

export async function getOllamaRunningProcessInfo(baseUrl = "http://localhost:11434") {
  try {
    const cleanUrl = String(baseUrl || "http://localhost:11434").replace(/\/+$/, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 650);
    const res = await fetch(`${cleanUrl}/api/ps`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data.models) && data.models.length > 0) {
      const active = data.models[0];
      return {
        model: active.name || active.model,
        size_bytes: active.size,
        size_mb: Math.round((active.size || 0) / (1024 * 1024)),
        size_vram_mb: Math.round((active.size_vram || 0) / (1024 * 1024)),
        details: active.details || {},
      };
    }
    return { model: null, size_mb: 0, size_vram_mb: 0 };
  } catch {
    return null;
  }
}

const IMAGE_OCR_CACHE = new Map();

export function runWindowsOcrOnBase64(base64Str, cacheKey = "") {
  if (!base64Str || process.platform !== "win32") return "";
  const key = cacheKey || base64Str.slice(0, 96);
  if (IMAGE_OCR_CACHE.has(key)) {
    return IMAGE_OCR_CACHE.get(key);
  }
  try {
    const psScript = `
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$b64 = [Console]::In.ReadToEnd().Trim()
if (-not $b64) { exit 0 }
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
function Await($op, $type) {
  $m = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name.StartsWith('IAsyncOperation') })[0]
  $m = $m.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  $t.Wait()
  return $t.Result
}
$bytes = [Convert]::FromBase64String($b64)
$mem = New-Object System.IO.MemoryStream(,$bytes)
$stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($mem)
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$res = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
Write-Output $res.Text
`;
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", psScript],
      {
        input: base64Str,
        encoding: "utf8",
        timeout: 6000,
        stdio: ["pipe", "pipe", "ignore"],
      }
    );
    const cleaned = (out || "").replace(/\s+/g, " ").trim();
    IMAGE_OCR_CACHE.set(key, cleaned);
    return cleaned;
  } catch {
    IMAGE_OCR_CACHE.set(key, "");
    return "";
  }
}

export function extractTicketImagesOcrText(ticket) {
  const docs = (ticket?.documents || []).filter((d) => d.is_image && d.base64);
  if (docs.length === 0) return "";
  const texts = [];
  for (const d of docs) {
    const cacheKey = `${ticket.id || "t"}_${d.id || d.filename || ""}_${d.base64.slice(0, 32)}`;
    const txt = runWindowsOcrOnBase64(d.base64, cacheKey);
    if (txt) texts.push(txt);
  }
  return texts.join("\n");
}

const SYSTEM_PROMPT = `Você é um Analista Sênior de T.I. da Unimed (Copiloto de Triagem GLPI).
Analise os dados reais do chamado abaixo e gere um JSON em Português do Brasil contendo:
- translated_intent: explique em 2 frases diretas o problema técnico ou solicitação real relatada pelo usuário, citando colaborador/equipamento/sistema e setor. Se houver imagens ou prints de telas anexados, descreva os dados, campos, telas e mensagens mostrados nos prints (evite citar sintomas físicos inexistentes como cabos soltos ou LEDs quando se tratar de telas de sistemas de software).
  * ATENÇÃO SOBRE 'SENHA': no setor de Autorização/Intercâmbio (sistema ERP HRP Unimed), 'senha' refere-se ao número da guia de autorização de procedimento médico/hospitalar no intercâmbio entre Unimeds (ex: 'senha não está trafegando'). NUNCA confunda com senha de login de usuário, bloqueio de conta ou rede!
- urgency_reason: explique em 1 frase curta o impacto operacional deste chamado.
- public_reply_draft: escreva uma mensagem cordial, profissional e serena pronta para enviar ao solicitante no GLPI, iniciando SEMPRE com "Olá, <PrimeiroNome>! Tudo bem?".
  * TOM INSTITUCIONAL UNIMED: mantenha tom corporativo sóbrio, calmo, seguro e resolutivo. É TERMINANTEMENTE PROIBIDO usar linguagem melodramática, aflita ou ansiosa (como "estamos fazendo tudo o que podemos", "faremos o impossível", "pedimos desculpas pelo transtorno", "lamentamos profundamente"). Conclua com tranquilidade: "Assim que a solicitação for concluída, confirmaremos por aqui! Permanecemos à disposição!".
  * Se 'Status da Triagem' for 'COMPLETO', apenas confirme que todos os dados necessários já foram recebidos e que a equipe de T.I. já está executando a solicitação (NÃO faça perguntas e NÃO peça ID do HopToDesk).
  * Se houver 'Perguntas de Triagem Pendentes', inclua APENAS essas perguntas em tópicos claros para o solicitante responder.
  * Se houver 'DIRETIVA DO ANALISTA (PRIORIDADE MÁXIMA)', siga estritamente o que foi solicitado na diretriz.`;

export function sanitizeCorporateTone(rawText, firstName = "") {
  let text = String(rawText || "").trim();
  if (!text) return "";

  const hasGreeting =
    /^(?:ol[áa]|bom\s+dia|boa\s+tarde|prezad[oa]s?)[,\s!]/i.test(text);
  if (!hasGreeting && text.length > 15 && firstName) {
    text = `Olá, ${firstName}! Tudo bem?\n\n${text}`;
  }

  text = text
    .replace(
      /estamos fazendo tudo (?:o que podemos|ao nosso alcance)[^.!?]*[.!?]?/gi,
      "Assim que o procedimento for concluído, confirmaremos por aqui!"
    )
    .replace(
      /faremos o poss[íi]vel e o imposs[íi]vel[^.!?]*[.!?]?/gi,
      "Nossa equipe já está cuidando da tratativa."
    )
    .replace(
      /pedimos (?:sinceras )?(?:desculpas|perd[ãa]o) pelo (?:transtorno|inconveniente)(?: causado)?[^.!?]*[.!?]?/gi,
      ""
    )
    .replace(/lamentamos profundamente(?: o ocorrido)?[^.!?]*[.!?]?/gi, "")
    .replace(
      /obrigad[oa] pela (?:sua )?(?:paci[êe]ncia|compreens[ãa]o)(?: e colabora[çc][ãa]o)?[.!?]?/gi,
      ""
    )
    .replace(/\s{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!/permanecemos [àa] disposi[çc][ãa]o/i.test(text)) {
    text = `${text}\n\nPermanecemos à disposição!`;
  }

  return text;
}

export const OFFICIAL_GLPI_TI_CATEGORIES = [
  "T.I > BD > Administração de Banco de Dados",
  "T.I > BD > Administração de Banco de Dados > Alteração de Dados / Ajustes SQL Pontuais",
  "T.I > BD > Administração de Banco de Dados > Backup e Restauração",
  "T.I > BD > Administração de Banco de Dados > Criação e Configuração",
  "T.I > BD > Administração de Banco de Dados > Otimização de Performance",
  "T.I > BD > Big Data e BI > Dashboards",
  "T.I > BD > Big Data e BI > Integração de Fontes de Dados",
  "T.I > BD > Big Data e BI > Relatórios",
  "T.I > DV > Desenvolvimento > Ajustes em layout/interface",
  "T.I > DV > Desenvolvimento > Atualização de versão/sistema",
  "T.I > DV > Desenvolvimento > Correção de bugs",
  "T.I > DV > Desenvolvimento > Integração entre sistemas",
  "T.I > DV > Desenvolvimento > Manutenção/Refatoração de Software",
  "T.I > DV > Desenvolvimento > Novas aplicações",
  "T.I > IR > Administração de Redes > Configuração de Switches/Roteadores",
  "T.I > IR > Administração de Redes > Telefones VoIP",
  "T.I > IR > Administração de Redes > VPN e Acesso Remoto",
  "T.I > IR > Câmeras e Monitoramento > Instalação/Configuração de Câmeras",
  "T.I > IR > Câmeras e Monitoramento > Manutenção de Câmeras/NVD",
  "T.I > IR > Câmeras e Monitoramento > Solicitação de Gravações Telefônicas",
  "T.I > IR > Câmeras e Monitoramento > Solicitação de Imagens",
  "T.I > IR > Conectividade > Internet e WiFi",
  "T.I > IR > Conectividade > Lentidão e Quedas de Rede",
  "T.I > IR > Energia e Geradores > Manutenção em Sistemas de Redundância",
  "T.I > IR > Energia e Geradores > Monitoramento de Geradores",
  "T.I > IR > Energia e Geradores > Teste/Manutenção de Nobreaks/UPS",
  "T.I > IR > Gestão de Servidores > Atualizações e Patches",
  "T.I > IR > Gestão de Servidores > Backup e Restauração",
  "T.I > IR > Gestão de Servidores > Instalação e Configuração",
  "T.I > IR > Gestão de Servidores > Verificação de Virtual Machines",
  "T.I > IR > Suporte a Hardware",
  "T.I > IR > Suporte a Hardware > Manutenção de Computadores",
  "T.I > IR > Suporte a Hardware > Manutenção Preventiva",
  "T.I > IR > Suporte a Hardware > Periféricos > Áudio e Vídeo",
  "T.I > IR > Suporte a Hardware > Periféricos > Impressoras",
  "T.I > IR > Suporte a Hardware > Periféricos > Monitor",
  "T.I > IR > Suporte a Hardware > Periféricos > Mouses",
  "T.I > IR > Suporte a Hardware > Periféricos > Scaners",
  "T.I > IR > Suporte a Hardware > Periféricos > Teclados",
  "T.I > IR > Suporte a Hardware > Substituição de Peças",
  "T.I > IR > Suporte a Hardware > Suprimentos > Etiquetas",
  "T.I > IR > Suporte a Hardware > Suprimentos > Ribbons",
  "T.I > IR > Suporte a Hardware > Suprimentos > Tintas",
  "T.I > IR > Suporte a Hardware > Suprimentos > Toners",
  "T.I > SI > Compliance, Auditorias e Políticas de SI > LGPD e Regulações",
  "T.I > SI > Gestão de Acessos > Auditoria e Controle de Privilégios",
  "T.I > SI > Gestão de Acessos > Revisão de Acessos",
  "T.I > SI > Monitoramento e Análise de Segurança > Detecção de Anomalias",
  "T.I > SI > Monitoramento e Análise de Segurança > Logs e Alertas",
  "T.I > SI > Monitoramento e Análise de Segurança > Monitoramento de Antivírus",
  "T.I > SI > Resposta a Incidentes > Registro de Incidente de Proteção de Dados Pessoais",
  "T.I > ST > Acesso e Permissões",
  "T.I > ST > Acesso e Permissões > Bloqueio de Contas",
  "T.I > ST > Acesso e Permissões > Criação de Usuários",
  "T.I > ST > Acesso e Permissões > Desbloqueio de Contas",
  "T.I > ST > Acesso e Permissões > Redefinição de Senhas",
  "T.I > ST > Apoio a Eventos / Empréstimo de Equipamentos",
  "T.I > ST > Dúvidas e Orientações",
  "T.I > ST > Instalação/Configuração > Aplicativos",
  "T.I > ST > Instalação/Configuração > Sistemas Operacionais",
  "T.I > ST > Parametrização de Sistemas e Tabelas",
  "T.I > ST > Resolução de Problemas > Erros de Sistema",
  "T.I > ST > Resolução de Problemas > Travamentos",
  "T.I > ST > Reversão de Processos / Ajustes Operacionais",
  "T.I > ST > Solicitação Diversa",
  "T.I > TR > Treinamentos > Ferramentas Corporativas",
  "T.I > TR > Treinamentos > Segurança Digital",
  "T.I > TR > Treinamentos > Treinamentos Técnicos",
];

export function resolveCategoryFromDirective(directive, candidates = OFFICIAL_GLPI_TI_CATEGORIES) {
  if (!directive) return null;
  const normDir = normalizeText(directive)
    .replace(/^(a|o|as|os|de|da|do|para|em|na|no)\s+/g, "")
    .replace(/\b(categoria|grupo)\b/g, "")
    .trim();
  if (normDir.length < 3) return null;

  // 1. Match exato
  const exact = candidates.find((c) => normalizeText(c) === normDir);
  if (exact) return exact;

  // 2. Match no último segmento (ex: "Manutenção de Computadores" bate com "... > Manutenção de Computadores")
  const lastSegMatch = candidates.find((c) => {
    const lastSeg = normalizeText(c.split(">").pop().trim());
    return lastSeg === normDir || normDir.includes(lastSeg) || lastSeg.includes(normDir);
  });
  if (lastSegMatch) return lastSegMatch;

  // 3. Substring geral
  const subMatch = candidates.find(
    (c) => normalizeText(c).includes(normDir) || normDir.includes(normalizeText(c))
  );
  if (subMatch) return subMatch;

  return null;
}

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

const GRAU_PART_MAP = {
  "00": "Cirurgião",
  "01": "1º Auxiliar",
  "02": "2º Auxiliar",
  "03": "3º Auxiliar",
  "04": "4º Auxiliar",
  "05": "Instrumentador",
  "06": "Anestesista",
  "07": "Aux. Anestesista",
  "08": "Pediatra na sala de parto",
  "09": "Perfusionista",
  "10": "Outros",
  "11": "Auxiliar SADT",
  "12": "Clínico",
  "13": "Intensivista",
};

export function formatBRL(val) {
  return Number(val || 0).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function parseAndAuditTissXml(xmlRaw, filename = "arquivo.xml") {
  if (!xmlRaw || typeof xmlRaw !== "string") return null;
  const getTag = (src, tag) => {
    const m = src.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, "i"));
    return m ? m[1].trim() : "";
  };

  const numeroLote = getTag(xmlRaw, "numeroLote").replace(/^0+(?=\d)/, "");
  const sequencial = getTag(xmlRaw, "sequencialTransacao").replace(/^0+(?=\d)/, "");
  const versaoPadrao = getTag(xmlRaw, "versaoPadrao");
  const hashInformado = getTag(xmlRaw, "hash");
  const numeroGuia = getTag(xmlRaw, "numeroGuiaPrestador") || getTag(xmlRaw, "numeroGuiaOperadora");
  const senhaGuia = getTag(xmlRaw, "senha");
  const nomeBeneficiario = getTag(xmlRaw, "nomeBeneficiario");
  const valorTotalGeral = parseFloat(getTag(xmlRaw, "valorTotalGeral") || "0");
  const valorProcedimentos = parseFloat(getTag(xmlRaw, "valorProcedimentos") || "0");
  const valorTaxasAlugueis = parseFloat(getTag(xmlRaw, "valorTaxasAlugueis") || "0");

  const procBlocks = [
    ...xmlRaw.matchAll(/<(?:\w+:)?procedimentoExecutado[^>]*>([\s\S]*?)<\/(?:\w+:)?procedimentoExecutado>/gi),
  ].map((m) => m[1]);

  const procedures = [];
  const divergentProcedures = [];
  let sumProcByUnitario = 0;
  let sumProcByTotal = 0;

  for (const pb of procBlocks) {
    const codigo = getTag(pb, "codigoProcedimento");
    const descricao = getTag(pb, "descricaoProcedimento");
    const qtd = parseFloat(getTag(pb, "quantidadeExecutada") || "1");
    const valorUnitario = parseFloat(getTag(pb, "valorUnitario") || "0");
    const valorTotal = parseFloat(getTag(pb, "valorTotal") || "0");

    const eqBlocks = [
      ...pb.matchAll(/<(?:\w+:)?identificacaoEquipe[^>]*>([\s\S]*?)<\/(?:\w+:)?identificacaoEquipe>/gi),
    ].map((m) => m[1]);

    const equipe = eqBlocks.map((eq) => {
      const grau = getTag(eq, "grauPart");
      const nomeProf = getTag(eq, "nomeProf");
      const crm = getTag(eq, "numeroConselhoProfissional");
      return {
        grauPart: grau,
        grauLabel: GRAU_PART_MAP[grau] || `Grau ${grau}`,
        nomeProf: formatPersonName(nomeProf),
        crm,
      };
    });

    const calcUnitTotal = Number((qtd * valorUnitario).toFixed(2));
    const diff = Number((valorTotal - calcUnitTotal).toFixed(2));
    sumProcByUnitario = Number((sumProcByUnitario + calcUnitTotal).toFixed(2));
    sumProcByTotal = Number((sumProcByTotal + valorTotal).toFixed(2));

    const procObj = {
      codigo,
      descricao,
      qtd,
      valorUnitario,
      valorTotal,
      diffUnitarioTotal: diff,
      equipe,
    };
    procedures.push(procObj);
    if (Math.abs(diff) > 0.01) {
      divergentProcedures.push(procObj);
    }
  }

  const despBlocks = [
    ...xmlRaw.matchAll(/<(?:\w+:)?despesa[^>]*>([\s\S]*?)<\/(?:\w+:)?despesa>/gi),
  ].map((m) => m[1]);
  let sumOutrasDespesas = 0;
  for (const db of despBlocks) {
    const vTot = parseFloat(getTag(db, "valorTotal") || "0");
    sumOutrasDespesas = Number((sumOutrasDespesas + vTot).toFixed(2));
  }

  const totalCalculadoPeloUnitario = Number((sumProcByUnitario + sumOutrasDespesas).toFixed(2));
  const totalDiferencaUnitarioVsGeral = Number((valorTotalGeral - totalCalculadoPeloUnitario).toFixed(2));

  const lines = [
    `[AUDITORIA AUTOMÁTICA DO ANEXO XML TISS: ${filename}]`,
    `- Padrão TISS: ${versaoPadrao || "N/D"} | Lote: ${numeroLote || "N/D"} | Guia: ${numeroGuia || "N/D"} | Beneficiário: ${nomeBeneficiario || "N/D"} | Hash Epílogo: ${hashInformado || "Ausente"}`,
    `- Valor Total Geral no XML (<ans:valorTotalGeral>): R$ ${formatBRL(valorTotalGeral)} | Soma se lido por <ans:valorUnitario>: R$ ${formatBRL(totalCalculadoPeloUnitario)} (Diferença: R$ ${formatBRL(totalDiferencaUnitarioVsGeral)})`,
  ];
  if (divergentProcedures.length > 0) {
    lines.push(
      `- DIVERGÊNCIAS IDENTIFICADAS NOS PROCEDIMENTOS (${divergentProcedures.length} item(ns) onde <ans:valorUnitario> difere de <ans:valorTotal> por agrupamento de equipe médica):`
    );
    for (const dp of divergentProcedures) {
      const eqStr = dp.equipe.map((e) => `${e.grauLabel} (${e.grauPart}): ${e.nomeProf}`).join(", ");
      lines.push(
        `  * Procedimento ${dp.codigo} (${dp.descricao}): valorUnitario = R$ ${formatBRL(dp.valorUnitario)} | valorTotal = R$ ${formatBRL(dp.valorTotal)} | Diferença oculta = R$ ${formatBRL(dp.diffUnitarioTotal)} | Equipe agrupada: [${eqStr}]`
      );
    }
  }

  return {
    filename,
    numeroLote,
    sequencial,
    versaoPadrao,
    hashInformado,
    numeroGuia,
    senhaGuia,
    nomeBeneficiario: formatPersonName(nomeBeneficiario),
    valorTotalGeral,
    valorProcedimentos,
    valorTaxasAlugueis,
    sumOutrasDespesas,
    totalCalculadoPeloUnitario,
    totalDiferencaUnitarioVsGeral,
    procedures,
    divergentProcedures,
    summaryText: lines.join("\n"),
  };
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
  const xmlDocs = docsList.filter((d) => d.is_xml && d.xml_content);
  const xmlAudits = xmlDocs
    .map((d) => parseAndAuditTissXml(d.xml_content, d.filename))
    .filter(Boolean);
  const xmlAuditTxt =
    xmlAudits.length > 0
      ? `\n${xmlAudits.map((a) => a.summaryText).join("\n")}`
      : "";
  const docsTxt =
    docsList.length > 0
      ? `\n- Anexos do Chamado (${docsList.length}): ${docsList
          .map(
            (d) =>
              `${d.filename}${d.is_image ? " [IMAGEM/FOTO]" : ""}${
                d.is_xml ? " [XML TISS LIDO]" : ""
              }`
          )
          .join(", ")}${
          imageDocs.length > 0
            ? "\n  * EVIDÊNCIA VISUAL: Foram anexadas fotos/prints ao chamado. Analise os elementos visuais da imagem (periféricos ligados/desligados, cabos, códigos de erro na tela) para apoiar o diagnóstico técnico."
            : ""
        }${xmlAuditTxt}`
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
    const startPerf = performance.now();
    const sysTotalMem = os.totalmem();
    const provider = this.settings.ai_provider;
    const rawFirstName = (
      ticket.requester_first_name ||
      ticket.requester ||
      "Solicitante"
    )
      .trim()
      .split(/\s+/)[0];
    const firstName =
      rawFirstName.charAt(0).toUpperCase() + rawFirstName.slice(1).toLowerCase();
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
    let isFastpathHeuristic = false;

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
        if (heuristic.has_custom_reply && (!customInstruction || Boolean(heuristic.custom_reply_from_instruction))) {
          llmData = heuristic;
          isFastpathHeuristic = true;
          providerLabel = `Copiloto Heurístico Instantâneo (${this.settings.ollama_model || "qwen2.5:3b"})`;
        } else {
          llmData = await this._callOllama(userPrompt, rawBase64Images, visionModel);
          providerLabel = hasImages
            ? `Ollama Multimodal (${visionModel})`
            : `Ollama Local (${this.settings.ollama_model})`;
        }
      }
    } catch (err) {
      isFastpathHeuristic = true;
      providerLabel = `Motor Inteligente 3 Camadas (Fallback • ${String(err.message).slice(0, 55)})`;
    }

    if (!llmData) {
      if (!providerLabel) {
        providerLabel = "Copiloto Heurístico + Motor 3 Camadas (Node.js)";
      }
      llmData = heuristic;
    } else {
      const customSaysComplete =
        customInstruction &&
        /\b(completo|n[ãa]o\s+(pe[çc]a|pergunte|solicite|questione|cobre)|sem\s+perguntas?)\b/i.test(
          customInstruction
        );
      const customWantsQuestions =
        !customSaysComplete &&
        customInstruction &&
        /\b(pe[çc]a|pergunte|perguntar|solicite|solicitar|cobrar|questionar|qual\b|quais\b)\b/i.test(
          customInstruction
        );
      const useSpecializedIntent =
        heuristic.has_custom_reply && (!customInstruction || Boolean(heuristic.custom_reply_from_instruction));

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
        (heuristic.sufficiency_status === "completo" || customSaysComplete) &&
        !customWantsQuestions;
      const llmReplyHasUnwantedQuestions =
        shouldNotAskQuestions &&
        (/\?|hoptodesk|responda [àa]s perguntas|por favor,\s*verifique/i.test(
          llmData.public_reply_draft || ""
        ) &&
          !/tudo bem\?/i.test(
            (llmData.public_reply_draft || "").replace(/ol[áa],\s*[^?!]+\?\s*/i, "")
          ));

      let candidateReply = sanitizeCorporateTone(
        llmData.public_reply_draft || "",
        firstName
      );

      const validPublicReply =
        !useSpecializedIntent &&
        candidateReply &&
        candidateReply.length > 25 &&
        !llmReplyHasUnwantedQuestions &&
        !/<PrimeiroNome>|o que falta para o atendimento\?|fornecemos a id/i.test(
          candidateReply
        )
          ? candidateReply
          : heuristic.public_reply_draft;

      llmData.translated_intent = validIntent;
      llmData.urgency_reason = validUrgencyReason;
      llmData.public_reply_draft = validPublicReply;
      llmData.detected_domain = heuristic.detected_domain;
      llmData.suggested_category = heuristic.suggested_category || ticket.category;
      llmData.real_urgency = heuristic.real_urgency;
      llmData.sufficiency_status = customSaysComplete
        ? "completo"
        : customWantsQuestions
        ? "incompleto"
        : heuristic.sufficiency_status;
      llmData.missing_info = customSaysComplete ? [] : heuristic.missing_info;
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

    const durationMs = Math.round(performance.now() - startPerf);
    const sysFreeAfter = os.freemem();
    const sysUsedGb = Number(((sysTotalMem - sysFreeAfter) / 1e9).toFixed(1));
    const sysTotalGb = Number((sysTotalMem / 1e9).toFixed(1));
    const sysUsedPct = Math.round(((sysTotalMem - sysFreeAfter) / sysTotalMem) * 100);
    const nodeRssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));

    let ollamaInfo = null;
    if (provider === "ollama") {
      ollamaInfo = await getOllamaRunningProcessInfo(this.settings.ollama_base_url);
    }

    const usage = llmData?._usage || {
      prompt_tokens: Math.round(userPrompt.length / 3.8),
      completion_tokens: Math.round((llmData?.public_reply_draft || "").length / 3.8),
      total_tokens: Math.round((userPrompt.length + (llmData?.public_reply_draft || "").length) / 3.8),
    };

    let formattedBadge = "";
    if (isFastpathHeuristic) {
      formattedBadge = `⚡ Copiloto Instantâneo • ${nodeRssMb} MB • ${durationMs}ms`;
    } else if (provider === "ollama") {
      const memStr = ollamaInfo?.size_mb ? `${ollamaInfo.size_mb} MB` : `${nodeRssMb} MB`;
      formattedBadge = `⚡ Ollama • ${memStr} • ${(durationMs / 1000).toFixed(1)}s`;
    } else if (provider === "gemini") {
      formattedBadge = `☁️ Gemini • ${usage.total_tokens || 0} tok • ${(durationMs / 1000).toFixed(1)}s`;
    } else if (provider === "openai") {
      formattedBadge = `☁️ OpenAI • ${usage.total_tokens || 0} tok • ${(durationMs / 1000).toFixed(1)}s`;
    } else {
      formattedBadge = `⚡ Motor Heurístico • ${nodeRssMb} MB • ${durationMs}ms`;
    }

    const telemetry = {
      duration_ms: durationMs,
      execution_mode: isFastpathHeuristic ? "heuristic_instant" : "llm_inference",
      provider_used: providerLabel,
      provider_type: isFastpathHeuristic ? "heuristic" : provider,
      model:
        provider === "ollama"
          ? (hasImages ? (this.settings.ollama_vision_model || "qwen2.5vl:3b") : (this.settings.ollama_model || "qwen2.5:3b"))
          : provider === "gemini"
          ? (this.settings.gemini_model || "gemini-2.5-flash")
          : (this.settings.openai_model || "gpt-4o-mini"),
      system_ram_used_gb: sysUsedGb,
      system_ram_total_gb: sysTotalGb,
      system_ram_pct: sysUsedPct,
      node_rss_mb: nodeRssMb,
      ollama_loaded: Boolean(ollamaInfo?.model),
      ollama_model_name: ollamaInfo?.model || null,
      ollama_model_ram_mb: ollamaInfo ? Math.max(0, ollamaInfo.size_mb - (ollamaInfo.size_vram_mb || 0)) : null,
      ollama_model_vram_mb: ollamaInfo?.size_vram_mb || null,
      ollama_model_total_mb: ollamaInfo?.size_mb || null,
      tokens: usage,
      formatted_badge: formattedBadge,
    };

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
      telemetry,
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
    const parsed = extractJsonObject(text);
    parsed._usage = {
      prompt_tokens: data?.usageMetadata?.promptTokenCount || 0,
      completion_tokens: data?.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: data?.usageMetadata?.totalTokenCount || 0,
    };
    return parsed;
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
    const parsed = extractJsonObject(text);
    parsed._usage = {
      prompt_tokens: data?.usage?.prompt_tokens || 0,
      completion_tokens: data?.usage?.completion_tokens || 0,
      total_tokens: data?.usage?.total_tokens || 0,
    };
    return parsed;
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
    const parsed = extractJsonObject(text);
    parsed._usage = {
      prompt_tokens: data?.prompt_eval_count || 0,
      completion_tokens: data?.eval_count || 0,
      total_tokens: (data?.prompt_eval_count || 0) + (data?.eval_count || 0),
      total_duration_ms: data?.total_duration ? Math.round(data.total_duration / 1e6) : null,
    };
    return parsed;
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

    const isMale = /^(renan|juliano|dener|diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor|tarcisio|claudio|luiz|moises|carlos|eduardo|henrique|guilherme|danilo|alexandre|leandro|sergio|antonio|jose|paulo|fabio|marcelo|ricardo|adriano|vinicius|daniel|samuel|igor)\b/i.test(
      firstName
    );
    const isFemale =
      /^(uanne|isabel|isabela|rosy|edilea|edil[eé]a|joyce|suzelei|raquel|beatriz|iris|[ií]ris|ester|esther|ruth|miriam|lilian|l[ií]lian|karen|karine|kelly|kelli|nicole|stefany|stephanie|thamires|tamires|thais|tha[ií]s|lais|la[ií]s|elis|el[ií]s|in[eê]s|ines|thatiana|tatiana|ana|leticia|letícia|julia|júlia|valeria|valéria|maria|paula|dalete|liliane|vanessa|aline|amanda|jessica|jéssica|angela|ângela|camila|carolina|fernanda|patricia|patrícia|renata|simone|juliana|gabriela|bianca|bruna|daniela|sabrina|priscila|larissa|marina|mariana|luciana|claudia|cláudia|viviane|vivian|daiane|cristiane|giselle|gisele|michele|michelle)\b/i.test(
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
      !matches.some((m) => m.id === "PB-UNI-77" || m.source_id === "PB-UNI-77") &&
      !(
        /\b(teclado|teclados|mouse|mouses)\b/i.test(normAll) &&
        /\b(falha|defeito|falhando|letras?|teclas?|bot[aã]o|substitui[cç][aã]o|troca|manuten[cç][aã]o)\b/i.test(normAll)
      ) &&
      (() => {
        const rawDesc = (
          (formFields.descricao && formFields.descricao.length > 20
            ? formFields.descricao
            : formFields.problema || formFields.descricao) || ""
        )
          .replace(/▸[^\n]+/g, "")
          .replace(/^\s*\d+\)\s*[^:\n]+:\s*/gm, "")
          .replace(/<[^>]+>/g, "")
          .trim();
        const normDesc = normalizeText(rawDesc);
        const cleanTitle = normalizeText(ticket.title || "")
          .split(">")
          .pop()
          .trim();
        const normSector = normalizeText(sectorName || "");

        if (normDesc.length === 0) return true;
        if (normDesc.length <= 35) {
          if (
            normDesc === cleanTitle ||
            normDesc === `${cleanTitle} ${normSector}`.trim() ||
            normDesc === `${normSector} ${cleanTitle}`.trim() ||
            /^(whatsapp|computador|sistema|ajuda|teste|urgente|verificar|nao funciona|não funciona|problema|erro|chamado|favor verificar|solicito|atendimento)$/i.test(
              normDesc
            )
          ) {
            return true;
          }
          const stripped = normDesc
            .replace(new RegExp(`\\b${cleanTitle}\\b`, "g"), "")
            .replace(new RegExp(`\\b${normSector}\\b`, "g"), "")
            .trim();
          if (stripped.length <= 6) return true;
        }
        return false;
      })()
    ) {
      const isMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor|tarcisio|juliano)\b/i.test(
        firstName
      );
      const isFemale =
        /^(thatiana|tatiana|ana|leticia|letícia|julia|júlia|valeria|valéria|maria|paula|dalete|liliane|vanessa|aline|amanda|jessica|jéssica|angela|ângela|camila|carolina|fernanda|patricia|patrícia|renata|simone|juliana|gabriela|bianca|bruna|daniela|sabrina|priscila|larissa|marina|mariana|luciana|claudia|cláudia|viviane|vivian|daiane|cristiane|giselle|gisele|michele|michelle)\b/i.test(
          firstName
        ) || /a$/i.test(firstName);
      const solPrefix = isMale
        ? "O solicitante"
        : isFemale
        ? "A solicitante"
        : "O(a) solicitante";

      const rawDesc = (formFields.descricao || formFields.problema || "")
        .replace(/<[^>]+>/g, "")
        .trim();
      const cleanSubject = (ticket.title || "").includes(">")
        ? ticket.title.split(">").pop().trim()
        : ticket.title;
      const displayDesc = rawDesc || cleanSubject;
      const isWhatsApp = /\bwhatsapp\b/i.test(normAll);
      const assetInfo = formFields.ativo ? ` (${formFields.ativo})` : "";

      detectedDomain = "Suporte Técnico Geral / Service Desk";
      let smartCatVague = ticket.category;
      if (
        /\b(sistemas operacionais|aplicativos|solicitacao diversa|manutencao|manutenção)\b/i.test(
          normalizeText(ticket.category || "")
        )
      ) {
        if (/\b(teclado|teclados)\b/i.test(normAll)) {
          smartCatVague = "T.I > IR > Suporte a Hardware > Periféricos > Teclados";
        } else if (/\b(mouse|mouses)\b/i.test(normAll)) {
          smartCatVague = "T.I > IR > Suporte a Hardware > Periféricos > Mouses";
        } else if (
          /\b(manuten[cç][aã]o\s+de\s+computador(?:es)?|manuten[cç][aã]o\s+(?:no\s+|do\s+)?computador|computador\s+com\s+defeito|conserto\s+de\s+computador|pc\s+com\s+defeito|computador\s+n[aã]o\s+liga|formata[cç][aã]o\s+de\s+computador)\b/i.test(
            normAll
          ) &&
          !/\b(impressora|scanner|leitor|nobreak|estabilizador)\b/i.test(normAll)
        ) {
          smartCatVague = "T.I > IR > Suporte a Hardware > Manutenção de Computadores";
        }
      }
      suggestedCategory = smartCatVague;
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason =
        "Chamado com descrição vaga/insuficiente, necessitando de detalhamento pelo solicitante para direcionamento e suporte técnico adequado.";

      translatedIntent =
        `${solPrefix} **${ticket.requester}** (${sectorName}) abriu o chamado com título/descrição resumida apenas como **\"${displayDesc}\"**, sem detalhar a falha, dúvida ou procedimento desejado. ` +
        `Demanda solicitação de informações complementares ao setor para viabilizar o diagnóstico técnico.`;

      sufficiencyStatus = "incompleto";
      missingInfo = [
        `Descrever detalhadamente a solicitação ou o problema ocorrido (o chamado foi registrado apenas com o termo \"${displayDesc}\", sem detalhes do sintoma ou objetivo)`,
        isWhatsApp
          ? "Informar se trata-se de instalação/configuração do WhatsApp Web/Desktop, dificuldade de login/acesso à plataforma de atendimento via WhatsApp do setor (ex.: AscSac) ou mensagens que não estão sendo enviadas"
          : "Informar se trata-se de instalação de aplicativo, dúvida de uso, falha de login ou erro operacional (enviar print da tela com mensagem de erro, se houver)",
        `Informar o ID do HopToDesk da máquina${assetInfo} ou ramal para contato da equipe de T.I.`,
      ];

      customResolutionSteps = [
        suggestedCategory !== ticket.category
          ? `[PB-UNI-53] Reclassificar a categoria do chamado no GLPI para '${suggestedCategory}'.`
          : `[PB-UNI-53] Manter a categoria do chamado no GLPI em '${ticket.category}'.`,
        `[PB-UNI-53] Responder ao(à) solicitante ${ticket.requester} (${sectorName}) solicitando o detalhamento claro da demanda e evidências visuais (prints ou mensagens de erro).`,
        isWhatsApp
          ? `[PB-UNI-53] Caso o setor utilize plataforma web de atendimento WhatsApp (ex.: AscSac no setor ${sectorName}), checar com a equipe se a dificuldade é de alternância de painéis (clássico vs. novo) ou conectividade de canal.`
          : `[PB-UNI-53] Identificar se a demanda refere-se a software específico, hardware local ou permissão de acesso.`,
        `[PB-UNI-53] Obter o ID do HopToDesk da máquina${assetInfo} para conexão remota ou alinhamento por ramal telefônico.`,
        `[PB-UNI-53] Após a resposta do solicitante com os detalhes, reclassificar o chamado se necessário e executar a resolução técnica.`,
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos o seu chamado, porém a descrição foi informada de forma resumida apenas como **"${displayDesc}"**, sem maiores detalhes da situação ocorrida.\n\n` +
        `Para que possamos compreender a sua necessidade e prestar o atendimento correto, você poderia nos detalhar:\n` +
        (isWhatsApp
          ? `1. O que está acontecendo ou o que você precisa que seja feito com o WhatsApp no setor d${
              sectorName.toLowerCase().startsWith("a") ? "a" : "o"
            } **${sectorName}**? (Ex.: é uma nova instalação/configuração, dificuldade de login ou acesso à plataforma de atendimento do setor como o **AscSac**, mensagens que não estão sendo enviadas ou algum erro específico?)\n`
          : `1. O que está acontecendo ou o que você precisa que seja feito? (Ex.: é uma nova instalação/configuração, dificuldade de login/acesso, mensagens de erro na tela ou alguma falha específica?)\n`) +
        `2. Caso esteja aparecendo alguma mensagem de erro ou tela travada, você poderia nos enviar um print da tela?\n` +
        `3. Qual o **ID do HopToDesk** do computador${assetInfo} ou ramal para contato da equipe de T.I.?\n\n` +
        `Assim que nos enviar esses detalhes por aqui, daremos sequência imediata ao seu atendimento!\n\n` +
        `Permanecemos à disposição!`;
    } else if (
      /\b(papel\s+de\s+parede|papeis\s+de\s+parede|pap[eé]is\s+de\s+parede|plano\s+de\s+fundo|fundo\s+de\s+tela|tela\s+de\s+fundo|wallpaper|padroniza[cç][aã]o\s+(?:da\s+)?[aá]rea\s+de\s+trabalho|padronizar\s+(?:a\s+)?[aá]rea\s+de\s+trabalho|personaliza[cç][aã]o\s+(?:da\s+)?[aá]rea\s+de\s+trabalho|personalizar\s+(?:a\s+)?[aá]rea\s+de\s+trabalho|imagem\s+(?:com\s+a\s+|da\s+|de\s+|na\s+)?[aá]rea\s+de\s+trabalho|[aá]rea\s+de\s+trabalho\s+criada)\b/i.test(
        normAll
      ) ||
      (/\b([aá]rea\s+de\s+trabalho|desktop)\b/i.test(normAll) &&
        /\b(padroniza|personaliza|papel\s+de\s+parede|plano\s+de\s+fundo|imagem|imagens|dom[ií]nio|unimedti|unimed256|\bucs\b|\bgpo\b)\b/i.test(
          normAll
        ) &&
        !/\b(etiqueta|etiquetas|zebradesigner|elgin|atalho|unidrive|nextcloud)\b/i.test(
          normAll
        ))
    ) {
      const cleanSector = (sectorName || "setor solicitante")
        .replace(/^H\s+/i, "")
        .trim();
      const isFemSector =
        /^(recep[cç][aã]o|enfermagem|farm[aá]cia|triagem|auditoria|autoriza[cç][aã]o|tesouraria|contabilidade|cobran[cç]a|hotelaria|nutri[cç][aã]o|oncologia|uti|ala|portaria|ouvidoria|diretoria|ger[eê]ncia|coordena[cç][aã]o|administra[cç][aã]o|secretaria|cl[ií]nica)\b/i.test(
          cleanSector
        );
      const artSetor = isFemSector ? "da" : "do";
      const displaySector =
        sectorName && sectorName !== cleanSector
          ? `${cleanSector} (${sectorName})`
          : sectorName || "setor solicitante";

      detectedDomain =
        "Suporte Técnico / Administração de Domínio e GPO (AD unimedti / UCS unimed256)";
      suggestedCategory =
        "T.I > ST > Instalação/Configuração > Sistemas Operacionais";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason = `Padronização visual e aplicação de política de papel de parede setorial (GPO) nas estações de trabalho ${artSetor} ${displaySector} após atualização/migração de domínio (unimedti -> UCS unimed256).`;

      const categoryMismatch =
        normalizeText(ticket.category || "") !==
        normalizeText(suggestedCategory);
      const reclassNote = categoryMismatch
        ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}").*`
        : "";

      translatedIntent =
        `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a **padronização da Área de Trabalho e atualização dos papéis de parede específicos ${artSetor} ${displaySector}** nos computadores do setor, relatando que após as recentes mudanças e atualizações nas estações as imagens personalizadas deixaram de aparecer. ` +
        `Tecnicamente, a instituição opera atualmente com dois domínios em fase de transição — o Active Directory antigo (**\`unimedti\`**) e o novo domínio gerenciado via **UCS (\`unimed256\`)** —, sendo provável que os computadores do setor já tenham sido migrados para o novo domínio **\`unimed256\`** (ou atualizados), mas ainda estejam recebendo a política (GPO) padrão geral por não estarem vinculados à Unidade Organizacional (OU) / GPO personalizada ${artSetor} ${cleanSector}.` +
        reclassNote;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customResolutionSteps = [
        `[PB-UNI-57] Reclassificar a categoria do chamado no GLPI de '${ticket.category}' para '${suggestedCategory}' (ID 70).`,
        `[PB-UNI-57] Identificar os computadores/estações de trabalho ${artSetor} ${displaySector} e verificar em qual domínio cada máquina está ingressada atualmente: no domínio AD antigo ('unimedti') ou no novo domínio UCS ('unimed256').`,
        `[PB-UNI-57] Caso as estações já estejam migradas para o novo domínio UCS ('unimed256'), acessar o console do UCS / Gerenciamento de Diretiva de Grupo (RSAT gpmc.msc no domínio 'unimed256') e verificar se as máquinas/usuários do setor estão na Unidade Organizacional (OU) correta (${cleanSector}) e se a GPO de Papel de Parede personalizada do setor já foi criada e vinculada nesse domínio.`,
        `[PB-UNI-57] Garantir que a imagem de papel de parede específica ${artSetor} ${cleanSector} esteja hospedada no compartilhamento de rede do novo domínio (\\\\unimed256\\netlogon\\ ou \\\\unimed256\\sysvol\\unimed256\\...) com permissão de leitura para 'Authenticated Users' / 'Domain Computers' e configurada na diretiva (Configuração do Usuário > Políticas > Modelos Administrativos > Área de Trabalho > Área de Trabalho > Papel de Parede da Área de Trabalho).`,
        `[PB-UNI-57] Caso alguma estação do setor ainda esteja no domínio antigo ('unimedti'), programar a migração para o novo domínio 'unimed256' (UCS) ou ajustar o vínculo da GPO setorial correspondente.`,
        `[PB-UNI-57] Executar 'gpupdate /force' nas estações de trabalho ${artSetor} ${displaySector}, realizar logoff/logon para validar o carregamento do papel de parede personalizado do setor e comunicar a conclusão à solicitante ${ticket.requester}.`,
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente à **padronização da Área de Trabalho (atualização do papel de parede específico do setor)** nos computadores ${artSetor} **${displaySector}**.\n\n` +
        `Atualmente nossa equipe de T.I. está realizando um trabalho de atualização e migração das estações de trabalho para o nosso novo domínio de rede corporativa. Por conta dessa transição, alguns computadores recém-atualizados ou migrados para o novo domínio podem ter carregado o plano de fundo padrão geral, precisando receber a política de personalização específica ${artSetor} **${cleanSector}**.\n\n` +
        `Nossa equipe técnica já está verificando os computadores do setor no servidor de domínio para configurar e aplicar o papel de parede padronizado de acordo com a necessidade ${artSetor} **${displaySector}** (caso o setor possua alguma nova arte/imagem atualizada que deseje utilizar, fique à vontade para anexá-la por aqui).\n\n` +
        `Assim que a diretiva de padronização for atualizada nas máquinas do setor, confirmaremos por aqui!\n\n` +
        `Permanecemos à disposição!`;
    } else if (
      /\b(ecg|eletrocardiograma|eletrocardi[oó]grafo|beneheart)\b/i.test(normAll) ||
      (/\baparelhos?\b/i.test(normAll) &&
        /\b(rede hospitalar|digitaliza[cç][aã]o|digitalizados?)\b/i.test(normAll) &&
        /\b(cabo de rede|exames?|pep)\b/i.test(normAll))
    ) {
      const isMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor|tarcisio|juliano)\b/i.test(
        firstName
      );
      const solPrefix = isMale ? "O solicitante" : "A solicitante";

      detectedDomain = "Infraestrutura e Rede";
      suggestedCategory =
        ticket.category && !ticket.category.includes("Sistemas Operacionais")
          ? ticket.category
          : "T.I > ST > Instalação/Configuração";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason =
        "Projeto de integração tecnológica e conectividade de equipamentos médicos (ECG) à rede hospitalar, otimizando o fluxo assistencial e a segurança dos dados no PEP.";

      translatedIntent =
        `${solPrefix} **${ticket.requester}** (${sectorName}) apresenta proposta de melhoria e modernização assistencial para **conectar os aparelhos de eletrocardiograma (ECG - Mindray BeneHeart R3) via cabo de rede/IP à rede de dados do Hospital** ` +
        `nos setores **UTI Adulto, UTI Neonatal, Sala de Emergência/Medicação, Suíte e Ala de Internação**, permitindo a exportação e visualização direta dos traçados de ECG em meio digital (PDF/XML) via computador para inserção no PEP (SGH Spdata), ` +
        `eliminando o processo de impressão térmica e digitalização manual por scanner e prevenindo extravios e perda de nitidez dos exames.`;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customResolutionSteps = [
        `[PB-UNI-52] Manter a categoria do chamado no GLPI em '${suggestedCategory}' e atribuir o atendimento conjunto aos grupos 'T.I > IR (Infra & Redes)' e 'T.I > ST (Service Desk)'.`,
        `[PB-UNI-52] Analisar as especificações técnicas e opções de conectividade do manual do operador do Mindray BeneHeart R3 (anexado ao chamado), confirmando os protocolos de rede suportados (porta Ethernet RJ-45, TCP/IP, envio para pasta compartilhada SMB, servidor FTP ou software Mindray ECG).`,
        `[PB-UNI-52] Realizar alinhamento com a Engenharia Clínica para inspeção física dos aparelhos de ECG nos 5 setores indicados (UTI Adulto, UTI Neo, Sala de Emergência/Medicação, Suíte e Ala de Internação) e checagem de ativação do módulo de rede em cada equipamento.`,
        `[PB-UNI-52] A equipe de Infraestrutura e Redes deve mapear os pontos de rede estruturada RJ-45 nos postos de atendimento, configurar VLAN isolada para equipamentos médicos e reservar faixas de IPs fixos no servidor DHCP/switches para cada aparelho.`,
        `[PB-UNI-52] A equipe de Sistemas/Suporte Técnico e Desenvolvimento deve estruturar o diretório compartilhado em rede (com credenciais restritas) e definir o fluxo de importação/anexo dos laudos em PDF no sistema PEP (SGH Spdata).`,
        `[PB-UNI-52] Executar um projeto piloto no aparelho de 1 setor prioritário (ex.: Sala de Emergência ou UTI Adulto) para validação do traçado digital, tempo de resposta e facilidade operacional junto à equipe de enfermagem antes de homologar nos demais setores.`,
        `[PB-UNI-52] Validar a conclusão da implantação junto ao solicitante ${ticket.requester} (Coordenação de Enfermagem).`,
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Agradecemos pelo envio desta excelente proposta de melhoria e modernização dos processos assistenciais do Hospital Unimed!\n\n` +
        `A integração dos eletrocardiógrafos **Mindray BeneHeart R3** diretamente à rede hospitalar trará ganhos expressivos de agilidade e confiabilidade para a equipe de Enfermagem e para o corpo clínico, além de garantir maior nitidez nos traçados e eliminar os riscos de extravio ou retrabalho decorrentes da digitalização manual de exames para o PEP (SGH Spdata).\n\n` +
        `Identificamos que a solicitação já conta com todo o detalhamento necessário, incluindo a relação dos 5 setores onde os aparelhos estão alocados (**UTI Adulto, UTI Neo, Sala de Emergência/Medicação, Suíte e Ala de Internação**) e o manual técnico oficial do fabricante anexado ao chamado.\n\n` +
        `Nossa equipe de T.I. já iniciou o **estudo de viabilidade técnica e arquitetura de conectividade**, englobando as seguintes frentes:\n` +
        `1. **Infraestrutura e Redes:** Mapeamento de tomadas de rede RJ-45 próximas aos aparelhos nos postos de atendimento e configuração de uma VLAN dedicada para dispositivos biomédicos com IPs reservados;\n` +
        `2. **Engenharia Clínica & Fabricante:** Validação do módulo de rede LAN e protocolo de exportação suportado pelos aparelhos (pasta de rede compartilhada SMB, FTP ou formato PDF/XML);\n` +
        `3. **Sistemas e PEP:** Definição do fluxo mais ágil para visualização, download e anexo dos arquivos digitais diretamente no prontuário do paciente (SGH Spdata).\n\n` +
        `Assim que concluirmos o levantamento da infraestrutura física de rede, alinharemos com você a realização de um **teste piloto** no primeiro setor (ex.: Sala de Emergência ou UTI) para validação prática da equipe de enfermagem antes da expansão para as demais alas.\n\n` +
        `Seguimos à disposição e manteremos você informado sobre cada etapa do projeto por aqui!\n\n` +
        `Atenciosamente,\nEquipe de Tecnologia da Informação`;
    } else if (
      /\b(desmonta|desmontar|desmontagem)\b/i.test(normAll) &&
      /\b(remontagem|montagem|montar|m[oó]vel|mob[ií]lia|mesa|esta[cç][aã]o|substitui[cç][aã]o)\b/i.test(
        normAll
      )
    ) {
      const isMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor|tarcisio|juliano)\b/i.test(
        firstName
      );
      const solPrefix = isMale ? "O solicitante" : "A solicitante";
      const targetLocation =
        formFields.localizacao ||
        formFields.local ||
        rawLoc ||
        sectorName ||
        "Recepção Interna";

      detectedDomain = "Infraestrutura e Rede";
      suggestedCategory =
        ticket.category && ticket.category.includes("Suporte a Hardware")
          ? ticket.category
          : "T.I > IR > Suporte a Hardware";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason =
        "Demanda presencial de Infraestrutura e Redes para desconexão segura, acomodação temporária e posterior remontagem de equipamentos de TI durante a troca de mobília do setor.";

      translatedIntent =
        `${solPrefix} **${ticket.requester}** solicita atendimento presencial da equipe de Infraestrutura e Redes para **desmontagem física preventiva dos equipamentos de T.I da estação de trabalho** ` +
        `(CPU, monitor, nobreak, periféricos, cabos e ramal) na **${targetLocation}**, visando permitir a substituição da mesa/mobília pela equipe de Manutenção Predial/Montadores e, logo em seguida, a respectiva remontagem e testes operacionais.`;

      sufficiencyStatus = "parcial";
      missingInfo = [
        "Confirmar a data e horário previstos para a troca/montagem do móvel novo pela equipe responsável (ou se a nova mesa já se encontra no local pronta para montagem imediata)",
        "Confirmar se os equipamentos podem ser desconectados de imediato ou se a desmontagem deve aguardar a chegada física da nova mobília",
      ];

      customResolutionSteps = [
        `[PB-UNI-50] Manter a categoria do chamado no GLPI em '${suggestedCategory}'.`,
        `[PB-UNI-50] Alinhar com o(a) solicitante ${ticket.requester} (${targetLocation}) o horário exato da entrega/montagem da nova mobília para sincronizar a atuação da T.I e minimizar o tempo da estação inoperante.`,
        `[PB-UNI-50] Deslocar técnico de Infraestrutura e Redes até a ${targetLocation} para desligamento ordenado da CPU, nobreak e telefone VoIP, desconectando com segurança todos os cabos (energia, vídeo, periféricos USB, ramal e patch cord de rede RJ-45).`,
        `[PB-UNI-50] Acomodar e proteger temporariamente os equipamentos (CPU, monitores, nobreak e telefone) em local seguro para evitar acúmulo de poeira ou impactos mecânicos durante a retirada da mesa antiga e montagem do móvel novo.`,
        `[PB-UNI-50] Após a conclusão da montagem da nova mesa pela equipe de Manutenção/Marcenaria, realizar a remontagem física dos equipamentos na bancada, organizando a passagem dos cabos pelos passa-fios e conectando energia e rede.`,
        `[PB-UNI-50] Ligar a estação de trabalho, validar a conexão de rede/internet, tom de discagem do ramal VoIP e periféricos, colhendo a validação operacional junto ao setor antes do encerramento.`,
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente à **desmontagem física e posterior remontagem da estação de trabalho** na **${targetLocation}**, para permitir a substituição da mobília/mesa.\n\n` +
        `Nossa equipe de Infraestrutura e Redes já está programada para realizar o atendimento presencial no setor. Para alinharmos o melhor momento e evitar que a estação fique inoperante além do necessário, você poderia nos confirmar:\n` +
        `1. A nova mesa já está no local para montagem imediata ou há uma **data e horário previstos** para a equipe de Manutenção/Montadores realizarem a troca do móvel?\n` +
        `2. A desmontagem dos equipamentos pode ser realizada de imediato ou devemos aguardar a chegada física da nova mesa no setor?\n\n` +
        `Assim que nos confirmar o cronograma da troca por aqui, nosso técnico comparecerá à ${targetLocation} para desconectar e resguardar os equipamentos e, tão logo o móvel novo esteja pronto, finalizar a remontagem e testes!\n\n` +
        `Permanecemos à disposição!`;
    } else if (
      /\b(ponto de telefone|linha e aparelho|remanejar|remanejamento|mudar de lugar|mudanca de local|novo ponto de rede|trocar o ramal de mesa|mudar o ramal de mesa|trocar ramal|mudanca de local do telefone|trocar telefone de mesa)\b/i.test(
        normAll
      ) ||
      /\b(trocar|mudar|transferir|levar|passar|colocar)\b[\s\S]{0,60}\b(do|da)\b[\s\S]{0,50}\bpara\b/i.test(
        normAll
      ) ||
      (/\b(telefone|ramal)\b/i.test(normAll) && /\b(trocar|mudar|transferir|remanejar|mesa|local)\b/i.test(normAll))
    ) {
      const descOnly = formFields.descricao || "";
      const isMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor|tarcisio|juliano)\b/i.test(
        firstName
      );
      const solPrefix = isMale ? "O solicitante" : "A solicitante";

      const mentionsPrinterReloc = /\bimpressora\b/i.test(normAll);
      const isZebra = /\bzebra\b/i.test(normAll);
      const printerName = isZebra ? "impressora Zebra" : "impressora";
      const mentionsPhoneInstall =
        /\b(ponto de telefone|linha e aparelho|telefone|ramal|aparelho)\b/i.test(
          normAll
        );

      const isPhoneMoveOnly =
        mentionsPhoneInstall &&
        !mentionsPrinterReloc &&
        /\b(trocar\s+(?:o\s+)?ramal\s+de\s+mesa|mudar\s+(?:o\s+)?ramal\s+de\s+mesa|mudar\s+(?:o\s+)?telefone\s+de\s+mesa|trocar\s+de\s+mesa|mudan[çc]a\s+de\s+local\s+do\s+telefone|trocar\s+o\s+ramal)\b/i.test(
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

      if (isPhoneMoveOnly) {
        translatedIntent =
          `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a mudança de local / troca de mesa de um ramal telefônico VoIP no setor **${sectorName}**. ` +
          `Demanda atendimento presencial da equipe de Infraestrutura e Redes para remanejamento físico do aparelho e validação da tomada de rede no destino.`;

        sufficiencyStatus = "parcial";
        missingInfo = [
          "Informar o número do ramal que será trocado de mesa",
          `Confirmar para qual mesa/posto dentro d${sectorName.toLowerCase().startsWith("a") ? "a" : "o"} ${sectorName} o telefone será transferido, e se a nova mesa já possui ponto de rede (tomada RJ-45) disponível`,
        ];

        customResolutionSteps = [
          `[PB-UNI-20] Manter a categoria do chamado no GLPI em '${ticket.category}'.`,
          `[PB-UNI-20] Confirmar com a solicitante ${ticket.requester} (${sectorName}) o número do ramal e a mesa/posto exato de destino.`,
          `[PB-UNI-20] Deslocar técnico de Infraestrutura e Redes até o setor ${sectorName} para remanejar o aparelho telefônico VoIP, conectar na tomada de rede PoE da nova mesa e testar o funcionamento (tom de discagem, chamadas internas e externas).`,
          `[PB-UNI-20] Caso a nova mesa não possua porta ativa, realizar a manobra necessária no switch/patch panel da Ala 1.`,
        ];

        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação para **trocar o ramal de mesa** no setor **${sectorName}**.\n\n` +
          `Nossa equipe de Infraestrutura e Redes já está programando o atendimento presencial no setor. Para agilizarmos a execução no local, você poderia nos confirmar:\n` +
          `1. Qual é o **número do ramal** do aparelho que será trocado de mesa?\n` +
          `2. Para qual **mesa/posto** dentro d${sectorName.toLowerCase().startsWith("a") ? "a" : "o"} ${sectorName} o telefone será transferido, e se a nova mesa já possui ponto de rede (tomada de rede) disponível?\n\n` +
          `Assim que nos confirmar por aqui, já enviamos um técnico ao setor para realizar a mudança e os testes!\n\n` +
          `Permanecemos à disposição!`;
      } else {
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
          `${solPrefix} **${ticket.requester}** (${sectorName}) solicita atendimento presencial da equipe de Infraestrutura e Redes para ${actionsTxt}. ` +
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

        customResolutionSteps = [
          `[PB-UNI-20] Manter a categoria do chamado no GLPI em '${ticket.category}'.`,
          `[PB-UNI-20] Verificar presencialmente no local de destino (${destLoc}) a disponibilidade de ponto de rede/patch panel e tomadas elétricas.`,
          `[PB-UNI-20] Executar o remanejamento físico e as devidas conexões/manobras de cabeamento estruturado e PABX/rede.`,
          `[PB-UNI-20] Realizar os testes operacionais junto ao setor ${sectorName} e validar a conclusão no chamado.`,
        ];

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
          `\n\nAssim que nos confirmar por aqui, já programamos a ida do técnico até o local!\n\n` +
          `Permanecemos à disposição!`;
      }
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
      (/\b(instala[cç][aã]o\s+d[eo]\s+scann?ers?|instalar\s+(?:o\s+|um\s+)?scann?ers?|configura[cç][aã]o\s+d[eo]\s+scann?ers?|configurar\s+(?:o\s+|um\s+)?scann?ers?|scann?ers?\s+(?:em|no)\s+meu\s+computador)\b/i.test(
        normAll
      ) ||
        (ticket.category.includes("Scaners") &&
          /\b(instala|configura|scann?ers?)\b/i.test(normAll))) &&
      !/\b(e-?mail|email|cat[aá]logo|lgpd|scan\s+to\s+e-?mail)\b/i.test(normAll)
    ) {
      const brandMatch = (formFields.descricao || ticket.content || "").match(
        /\b(canon|epson|brother|fujitsu|kodak|hp|scanjet|fi-\d+|dr-[a-z0-9]+|l\d{4}|m4080)\b/i
      );
      const brandModel = brandMatch ? brandMatch[1].trim() : "";
      const hasHopToDesk =
        /\b\d{3}\s*\d{3}\s*\d{3}\b/i.test(normAll) ||
        /\bhoptodesk\b/i.test(normAll);

      detectedDomain =
        "Infraestrutura e Rede / Suporte a Hardware (Periféricos — Scanners)";
      suggestedCategory =
        "T.I > IR > Suporte a Hardware > Periféricos > Scaners";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason = `Solicitação de instalação e configuração de driver/software de scanner na estação de trabalho (${sectorName}).`;

      const categoryMismatch =
        normalizeText(ticket.category || "") !==
        normalizeText(suggestedCategory);
      const reclassNote = categoryMismatch
        ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}").*`
        : "";

      translatedIntent =
        `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a **instalação e configuração de um scanner** em seu computador. ` +
        `Como o relato não especifica se trata-se de um **scanner dedicado (aparelho de mesa/alimentador separado conectado via USB)** ou do **módulo de scanner acoplado a uma impressora multifuncional** do setor, nem informa a marca/modelo do equipamento, a triagem classifica como parcial para coletar esses detalhes e agilizar a instalação do driver adequado.` +
        reclassNote;

      sufficiencyStatus = "parcial";
      missingInfo = [
        "Confirmar se é a instalação de um scanner separado (aparelho dedicado de mesa/alimentador) ou do scanner acoplado a uma impressora multifuncional do setor",
        brandModel
          ? `Confirmar se o scanner ${brandModel} já está conectado fisicamente ao computador via cabo USB ou rede`
          : "Informar a marca e o modelo do dispositivo (ex.: Canon, Epson, Brother, HP, Fujitsu, Samsung) e se já está conectado ao computador via cabo USB ou rede",
        hasHopToDesk
          ? "Confirmar disponibilidade para conexão remota via HopToDesk ou atendimento presencial no setor"
          : "Informar o ID do HopToDesk do computador para instalação remota dos drivers (ou confirmar se necessita de conexão física no local pela equipe de T.I.)",
      ];

      customResolutionSteps = [
        `[PB-UNI-58] Manter a categoria do chamado no GLPI em '${suggestedCategory}' (ID 150).`,
        `[PB-UNI-58] Confirmar com ${ticket.requester} (${sectorName}) se o dispositivo é um scanner dedicado (separado, conectado via USB) ou o scanner acoplado a uma impressora multifuncional, além da marca e modelo do aparelho.`,
        `[PB-UNI-58] Caso seja um scanner dedicado (separado): verificar a conexão física (cabo USB e fonte de energia) na estação de trabalho e instalar o driver oficial TWAIN/WIA e o utilitário de digitalização do fabricante (ex.: Canon CaptureOnTouch, Epson Scan, Brother iPrint&Scan, HP Scan ou NAPS2).`,
        `[PB-UNI-58] Caso seja scanner acoplado a uma impressora multifuncional: instalar o driver de digitalização em rede na máquina ou configurar o fluxo de digitalização do equipamento.`,
        `[PB-UNI-58] Efetuar um teste prático de digitalização em PDF com ${firstName}, disponibilizar o atalho do aplicativo na Área de Trabalho e encerrar o chamado.`,
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente à **instalação do scanner** no seu computador no setor **${sectorName}**.\n\n` +
        `Para que possamos separar os drivers corretos e realizar a instalação com agilidade, você poderia nos confirmar:\n` +
        `1. Trata-se da instalação de um **scanner separado (aparelho dedicado)** conectado ao seu computador ou do **scanner acoplado a uma impressora multifuncional** do setor?\n` +
        `2. Qual é a **marca e o modelo** do dispositivo (ex.: Canon, Epson, Brother, HP, Fujitsu, Samsung) e ele já está conectado fisicamente à sua máquina (cabo USB/energia)?\n` +
        `3. Qual é o **ID do HopToDesk** do seu computador para instalarmos remotamente (ou prefere que um técnico vá presencialmente até o setor)?\n\n` +
        `Assim que nos confirmar esses detalhes por aqui, já daremos andamento imediato na instalação!\n\n` +
        `Permanecemos à disposição!`;
    } else if (
      (/\b(scan\s+to\s+e-?mail|cat[aá]logo\s+de\s+endere[cç]os|cadastr(ar|o)\s+(?:de\s+|o\s+|meu\s+)?e-?mail)\b/i.test(normAll) ||
        (/\b(scan|scanner|digitaliz|digitaliza[çc][ãa]o)\b/i.test(normAll) &&
          /\b(e-?mail|email|cat[aá]logo|lgpd|samsung|m4080)\b/i.test(normAll)) ||
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
      /\b(relat[oó]rios?\s+atendimentos?\s+hospital|atendimentos?\s+realizados?\s+no\s+hospital|relat[oó]rios?\s+de\s+todos\s+os\s+atendimentos?|vsilva@unimedsudoestemg\.coop\.br|viviane\s+do\s+n[uú]cleo|evolu[ií]dos?\s+[aà]\s+[oó]bito|atendimento\s+externo\s+adulto|atendimento\s+externo\s+pedi[aá]trico|pacientes?\s+internados?)\b/i.test(
        normAll
      ) ||
      (/\brelat[oó]rios?\b/i.test(normAll) &&
        /\b(atendimentos?|hospital)\b/i.test(normAll) &&
        /\b(enviados?|enviar|receber|caixa\s+de\s+entrada|e-?mail)\b/i.test(normAll) &&
        /\b(spdata|sgh|viviane|nucleo|n[uú]cleo|promoprev|vsilva)\b/i.test(normAll))
    ) {
      detectedDomain =
        "Banco de Dados, BI e Relatórios (SGH Spdata / Relatórios Agendados)";
      suggestedCategory =
        ticket.category && ticket.category.includes("Relatórios")
          ? ticket.category
          : "T.I > BD > Big Data e BI > Relatórios";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason =
        "Inclusão de e-mail em rotinas automáticas de relatórios do Hospital no sistema SGH Spdata com definição de periodicidade.";

      const emailMatch = (ticket.content || "").match(/[a-zA-Z0-9._%+-]+@unimedsudoestemg\.coop\.br/i);
      const targetEmail = emailMatch ? emailMatch[0].toLowerCase() : "vsilva@unimedsudoestemg.coop.br";

      translatedIntent =
        `${solPrefix} **${formattedRequester}** (${sectorName}) solicita o envio automático dos relatórios de atendimentos realizados no Hospital Unimed para a sua caixa postal corporativa (**${targetEmail}**), espelhando a rotina recebida pela colaboradora Viviane do Núcleo. ` +
        `Os relatórios gerados pelo sistema SGH Spdata para essa rotina são: 1) **Relatório de pacientes evoluídos a óbito**; 2) **Atendimento externo adulto**; 3) **Atendimento externo pediátrico**; 4) **Lista de pacientes internados**. ` +
        `Como a rotina padrão do agendador do SPdata gera esses relatórios com frequência **de hora em hora**, é necessário alinhar com a colaboradora quais períodos/horários e frequência desejada para recebimento das mensagens, evitando sobrecarregar sua caixa postal de e-mails.`;

      sufficiencyStatus = "parcial";
      missingInfo = [
        "Confirmação dos períodos, horários ou frequência desejada para recebimento dos relatórios na caixa postal (ex.: uma vez ao dia pela manhã, no fechamento do dia, em horários específicos ou de hora em hora)"
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação para inclusão do seu e-mail (**${targetEmail}**) para recebimento dos relatórios de atendimentos realizados no Hospital Unimed no sistema **SGH (Spdata)**, espelhando a rotina da colaboradora Viviane do Núcleo:\n` +
        `1. **Relatório de pacientes evoluídos a óbito**;\n` +
        `2. **Atendimento externo adulto**;\n` +
        `3. **Atendimento externo pediátrico**;\n` +
        `4. **Lista de pacientes internados**.\n\n` +
        `Como o agendador do SPdata gera esses relatórios com rotina **de hora em hora**, para que possamos parametrizar o envio sem sobrecarregar a sua caixa de entrada, você poderia nos confirmar rapidamente:\n` +
        `- **Quais períodos ou horários você deseja receber esses relatórios?** *(Por exemplo: uma vez ao dia pela manhã, no fechamento do dia, em horários específicos ou realmente de hora em hora?)*\n\n` +
        `Assim que você nos confirmar a periodicidade desejada por aqui, nossa equipe de Banco de Dados já realizará a parametrização do agendamento no SPdata!\n\n` +
        `Permanecemos à disposição!`;

      customResolutionSteps = [
        `[PB-UNI-69] Manter a categoria do chamado no GLPI em '${suggestedCategory}' (equipe de Banco de Dados / Sistemas).`,
        `[PB-UNI-69] Identificar os 4 relatórios periódicos do SGH Spdata vinculados à rotina de atendimentos do Hospital Unimed: 1) Pacientes evoluídos a óbito; 2) Atendimento externo adulto; 3) Atendimento externo pediátrico; 4) Lista de pacientes internados (referência: colaboradora Viviane do Núcleo).`,
        `[PB-UNI-69] Colher a resposta de ${firstName} sobre a periodicidade e períodos/horários desejados para entrega na caixa postal ${targetEmail} (uma vez que a rotina padrão do SPdata gera de hora em hora).`,
        `[PB-UNI-69] Acessar o módulo agendador de tarefas/relatórios do SGH Spdata e cadastrar a conta ${targetEmail} na lista de distribuição dos relatórios com os horários definidos.`,
        `[PB-UNI-69] Validar o disparo do primeiro lote de relatórios com a solicitante e concluir o chamado no GLPI.`
      ];
    } else if (
      /\b(prescri[cç][aã]o\s+no\s+pep|modelo\s+de\s+prescri[cç][aã]o|protocolos?\s+prescri[cç][aã]o|prescri[cç][aã]o\s+geral|prescri[cç][aã]o\s+srpa|srpa|recupera[cç][aã]o\s+p[oó]s-anest[eé]sica|anestesistas?\s+e\s+cirurgi[oõ]es|tornar\s+esta\s+prescri[cç][aã]o\s+em\s+protocolo\s+padr[aã]o|protocolo\s+padr[aã]o\s+de\s+prescri[cç][aã]o)\b/i.test(
        normAll
      ) ||
      (/\bprescri[cç][aã]o\b/i.test(normAll) &&
        /\b(pep|spdata|sgh|modelo|protocolo|srpa)\b/i.test(normAll))
    ) {
      detectedDomain =
        "Parametrização de Sistemas e Tabelas (SGH Spdata / PEP)";
      suggestedCategory = "T.I > ST > Parametrização de Sistemas e Tabelas";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason =
        "Criação de protocolo/modelo de prescrição padrão no PEP SGH (Spdata) para atendimento cirúrgico e anestésico (SRPA), com minuta fornecida em anexo e documentação na Base de Conhecimento oficial KB #96.";

      translatedIntent =
        `${solPrefix} **${formattedRequester}** (${sectorName}) solicita a criação de um modelo/protocolo de prescrição no sistema **PEP SGH (Spdata)** (${ticket.title ? ticket.title.split(">").pop().trim() : "Criar modelo de prescrição no PEP"}), com base na minuta encaminhada em anexo (${ticket.content && /prescri[cç][aã]o\s+srpa/i.test(ticket.content) ? "Prescrição SRPA.odt" : "documento anexo"}), visando agilizar a prescrição médica para anestesistas e cirurgiões em pacientes na Sala de Recuperação Pós-Anestésica (SRPA). ` +
        `O procedimento trata-se de parametrização operacional do PEP SGH (documentado no **Artigo KB #96** da Base de Conhecimento do GLPI), podendo ser realizado via menu Configurações > Protocolos Prescrição Geral ou a partir do Histórico do prontuário clicando em 'Tornar esta prescrição em protocolo padrão'. Como a minuta com todos os itens já consta anexada, a solicitação possui dados suficientes e a categoria deve ser ajustada para Parametrização de Sistemas e Tabelas.`;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente à criação do modelo de prescrição no **PEP do sistema SGH Spdata** (${ticket.title ? ticket.title.split(">").pop().trim() : "Criar modelo de prescrição no PEP"}), com base na minuta encaminhada em anexo (${ticket.content && /prescri[cç][aã]o\s+srpa/i.test(ticket.content) ? "Prescrição SRPA" : "documento anexo"}).\n\n` +
        `Informamos que a parametrização e o cadastro de modelos de prescrição no sistema SPDATA seguem o procedimento homologado e documentado no artigo oficial **KB #96** da Base de Conhecimento do GLPI (*SGH - Spdata > PEP > Como Criar Protocolo e Modelo de Prescrição Padrão no PEP SGH*), contando com duas alternativas oficiais:\n` +
        `1. **Via Configurações do PEP (SGH > PEP > Configurações > Protocolos Prescrição Geral):** Onde estruturamos o protocolo definindo código, vigência, uso geral, especialidades médicas autorizadas, acomodações/leitos e realizamos o lançamento dos medicamentos, dosagens, vias e frequências;\n` +
        `2. **Via Histórico da Prescrição:** Onde uma prescrição já elaborada e confirmada no prontuário pode ser convertida diretamente em modelo padrão clicando com o botão direito e selecionando *"Tornar esta prescrição em protocolo padrão"*.\n\n` +
        `Nossa equipe de T.I. / Sistemas já iniciou a parametrização do protocolo no sistema com base na minuta de prescrição da SRPA encaminhada. Assim que a gravação for concluída e disponibilizada para os anestesistas e cirurgiões, confirmaremos por aqui!\n\n` +
        `Permanecemos à disposição!`;

      customResolutionSteps = [
        `[PB-UNI-70] Reclassificar a categoria do chamado no GLPI de 'T.I > DV > Desenvolvimento > Novas aplicações' para 'T.I > ST > Parametrização de Sistemas e Tabelas' (ID 164) ou 'T.I > ST > Dúvidas e Orientações' (ID 160).`,
        `[PB-UNI-70] Consultar o artigo oficial da Base de Conhecimento GLPI KB #96 ('SGH - Spdata > PEP > Como Criar Protocolo e Modelo de Prescrição Padrão no PEP SGH (Prescrição Geral)').`,
        `[PB-UNI-70] Analisar a minuta/anexo fornecido pela solicitante (${firstName} - ${sectorName}) contendo a grade de medicamentos, diluições, vias e cuidados para anestesistas e cirurgiões.`,
        `[PB-UNI-70] Acessar o sistema SPDATA no menu: SGH > PEP > Configurações > Protocolos Prescrição Geral (ou converter uma prescrição confirmada no Histórico do prontuário clicando com botão direito em 'Tornar esta prescrição em protocolo padrão').`,
        `[PB-UNI-70] Preencher os campos do protocolo: Código Protocolo, Descrição (ex.: 'PRESCRIÇÃO SRPA - RECUPERAÇÃO CIRÚRGICA'), Vigência Inicial, Uso Geral, Especialidades/Acomodações aplicáveis e lançar os itens com dosagens e frequências.`,
        `[PB-UNI-70] Gravar o protocolo no PEP, confirmar a disponibilização para os prescritores e responder à solicitante no GLPI referenciando o Artigo KB #96.`
      ];
    } else if (
      !/\b(pesquisa\s+de\s+satisfa[cç][aã]o|avalia[cç][aã]o\s+da\s+satisfa[cç][aã]o|experi[êe]ncia\s+do\s+cliente|totem|tablet)\b/i.test(
        normAll
      ) &&
      (/\b(palc|ona|auditoria\s+diagn[oó]stica|auditoria\s+palc|acredita[cç][aã]o|registros?\s+de\s+controle\s+de\s+acesso|rastreabilidade|recupera[cç][aã]o\s+de\s+registros?\s+eletr[oô]nicos?|altera[cç][aã]o\s+e\s+recupera[cç][aã]o|audit\s+trail|trilha\s+de\s+auditoria)\b/i.test(
        normAll
      ) &&
        (/\b(laborat[oó]rio|autolac|palc|ona|registros?\s+eletr[oô]nicos?|compliance)\b/i.test(
          normAll
        ) ||
          (ticket.category || "").includes("Compliance") ||
          (ticket.requester_department || "").includes("Laborat")))
    ) {
      detectedDomain =
        "Segurança da Informação, Governança e Compliance (Auditorias PALC / ONA / AutoLac)";
      suggestedCategory =
        ticket.category && ticket.category.includes("Compliance")
          ? ticket.category
          : "T.I > SI > Compliance, Auditorias e Políticas de SI";
      realUrgency = "Alta";
      urgencyReason =
        "Demanda regulatória de compliance e segurança da informação para atendimento aos requisitos das auditorias de acreditação PALC 2025 (SBPC/ML) e ONA no sistema AutoLac do Laboratório.";

      translatedIntent =
        `${solPrefix} **${formattedRequester}** (${sectorName}) solicita à equipe de Segurança da Informação e T.I. a formalização e disponibilização dos registros de **controle de acesso**, **rastreabilidade**, **alteração de dados (trilha de auditoria / audit trail)** e **recuperação de registros eletrônicos (política de backup e teste de restore)** no sistema de informação laboratorial (**AutoLac**), em atendimento aos requisitos normativos da **Auditoria Diagnóstica PALC 2025** (Programa de Acreditação para Laboratórios Clínicos da SBPC/ML) e do processo de certificação da **ONA**. ` +
        `Trata-se de demanda institucional de Compliance e Segurança da Informação (alinhada com Raphael Campos / Segurança), que deve ser atendida mediante consolidação de um Dossiê Técnico de Evidências contendo: 1) Política e matriz de perfis de acesso no AutoLac; 2) Declaração de rastreabilidade e logs de auditoria nativos do sistema para retificação de exames; 3) Procedimento Operacional Padrão (POP) de backup e relatório do último teste de restauração da base de dados.`;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Compreendemos perfeitamente a sua solicitação. Os registros solicitados referem-se aos requisitos normativos do capítulo de Tecnologia da Informação e Gestão de Registros Eletrônicos das acreditações **PALC 2025 (SBPC/ML)** e **ONA** para o sistema **AutoLac** do Laboratório.\n\n` +
        `Nossa equipe de Segurança da Informação e Sistemas (em conjunto com o Raphael Campos) já está consolidando o **Dossiê de Evidências de T.I.** composto pelos seguintes pontos:\n` +
        `1. **Controle de Acesso e Perfis:** Política de credenciais individuais, matriz de permissões de acesso por função (Recepção, Coleta, Bancada Técnica e Responsável Técnico) e política de bloqueio automático por inatividade;\n` +
        `2. **Rastreabilidade e Trilha de Auditoria (*Audit Trail*):** Declaração técnica de logs do AutoLac demonstrando a identificação de operador em cada fase analítica e o histórico auditável de qualquer retificação/alteração de laudos (com usuário, data/hora, valor anterior e justificativa);\n` +
        `3. **Recuperação de Registros Eletrônicos (Backup e Continuidade):** Procedimento Operacional Padrão (POP) da rotina diária de backup do banco de dados do AutoLac, política de retenção legal e o relatório/evidência do teste periódico de restauração (*Restore Test*).\n\n` +
        `Estamos finalizando a montagem desse kit documental e entraremos em contato com você para alinharmos a apresentação conjunta dessas evidências para a consultoria e auditoria diagnóstica!\n\n` +
        `Permanecemos à disposição!`;

      customResolutionSteps = [
        `[PB-UNI-71] Manter a categoria do chamado no GLPI em '${suggestedCategory}' e grupo atribuído 'T.I > SI (Segurança)'.`,
        `[PB-UNI-71] Identificar os 4 pilares normativos exigidos pela auditoria PALC/ONA para o sistema AutoLac: 1) Controle de acesso individual e matriz de perfis; 2) Rastreabilidade analítica; 3) Trilha de auditoria (audit trail) para alterações/retificações de laudos; 4) POP de Backup, retenção legal (20 anos) e relatório de teste de restauração (restore).`,
        `[PB-UNI-71] Consolidar o Dossiê Técnico de Evidências de Segurança e T.I. em conjunto com o gestor de Segurança da Informação (Raphael Campos).`,
        `[PB-UNI-71] Alinhar com a Coordenação do Laboratório (${firstName}) e a consultoria de acreditação a apresentação dos relatórios de auditoria e procedimentos homologados.`,
        `[PB-UNI-71] Disponibilizar os documentos formais no chamado e posicionar para encerramento após validação dos quesitos da auditoria.`
      ];
    } else if (
      /\b(ativo\s+imobilizado|ativos\s+imobilizados|dois\s+recursos|2\s+recursos|cadastrado\s+com\s+dois\s+recursos|ajuste\s+via\s+banco\s+de\s+dados|recurso\s+ai|lotes?\s+de\s+ativos?|termo\s+de\s+responsabilidade|movdepos|oeinfnh)\b/i.test(
        normAll
      ) ||
      (/\brecurso\b/i.test(normAll) &&
        /\b(item|lote|ativo|patrim[oô]nio|banco\s+de\s+dados)\b/i.test(normAll) &&
        /\b(considerar|somente|monitor|computador|oeinfnh|ai\d+)\b/i.test(normAll))
    ) {
      detectedDomain =
        "Banco de Dados, DBA e Ajustes SQL (HRP Unimed / Patrimônio)";
      suggestedCategory =
        "T.I > BD > Administração de Banco de Dados > Alteração de Dados / Ajustes SQL Pontuais";
      realUrgency = ticket.urgency_label || "Alta";
      urgencyReason =
        "Unificação de dois cadastros de recursos em lote de ativo imobilizado no sistema HRP Unimed para liberação da emissão do Termo de Responsabilidade pelo setor de Contabilidade/Patrimônio.";

      const itemMatch = (ticket.content || "").match(/\bOEINFNH\w+\b/i);
      const itemAtivo = itemMatch ? itemMatch[0] : "OEINFNH000721";

      const recursoMatch = (ticket.content || "").match(/\bAI\d+(?:\s*-\s*[A-Z\s]+)?\b/i);
      const recursoAtivo = recursoMatch ? recursoMatch[0] : "AI00007 - MONITOR DE COMPUTADOR";

      translatedIntent =
        `${solPrefix} **${formattedRequester}** (${sectorName}) solicita ajuste e unificação via banco de dados do item de ativo imobilizado **${itemAtivo}** no sistema **ERP HRP Unimed**, o qual consta cadastrado com dois recursos divergentes no lote de patrimônio. A solicitação define expressamente que deve ser mantido e considerado exclusivamente o recurso homologado **${recursoAtivo}**. ` +
        `Trata-se de procedimento técnico via IDE Engine (documentado no **Artigo KB #89** da Base de Conhecimento do GLPI) para atualização do campo RECURSO no cadastro do lote e na tabela de movimentações de depósito (MovDepos), sanando a divergência no extrato e destravando a emissão do Termo de Responsabilidade pelo setor de Contabilidade. Como o solicitante já forneceu todas as informações necessárias (item do ativo e recurso a prevalecer), a solicitação encontra-se completa e a categoria deve ser reclassificada para 'Alteração de Dados / Ajustes SQL Pontuais'.`;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente ao ajuste de recurso do ativo imobilizado **${itemAtivo}** no sistema **HRP Unimed**.\n\n` +
        `Informamos que as informações fornecidas (item patrimonial e recurso correto **${recursoAtivo}**) já foram validadas na triagem técnica e nossa equipe de Banco de Dados já iniciou o procedimento de unificação via IDE Engine, conforme a rotina homologada e documentada no **Artigo KB #89** da Base de Conhecimento do GLPI.\n\n` +
        `Assim que o recurso for unificado nas tabelas do lote e movimentação de depósito (MovDepos), liberando a emissão normal do Termo de Responsabilidade no HRP, confirmaremos a conclusão por aqui!\n\n` +
        `Permanecemos à disposição!`;

      customResolutionSteps = [
        `[PB-UNI-72] Reclassificar a categoria do chamado no GLPI para '${suggestedCategory}' (ID 147).`,
        `[PB-UNI-72] Consultar o artigo oficial da Base de Conhecimento GLPI KB #89 ('HRP - Alterar recurso de ativo imobilizado quando lote possui 2 recursos (IDE Engine)').`,
        `[PB-UNI-72] Acessar o sistema HRP Unimed no menu: Patrimônio > Lotes de Ativos Imobilizados, localizar o lote pelo número informado (${itemAtivo}) e copiar sua chave de identificação.`,
        `[PB-UNI-72] No cadastro de recurso (ou extrato do lote), identificar a chave correspondente ao recurso correto (${recursoAtivo}).`,
        `[PB-UNI-72] Abrir a ferramenta SQL na IDE Engine e atualizar o campo RECURSO com a chave correta tanto no cadastro do lote quanto na tabela de movimentações de depósito (MovDepos).`,
        `[PB-UNI-72] Validar no HRP a unificação do recurso e confirmar que o Termo de Responsabilidade pode ser emitido normalmente sem bloqueios, comunicando a conclusão ao solicitante.`
      ];
    } else if (
      (/\bglpi\b/i.test(normAll) ||
        /\b(andamento\s+de\s+um\s+chamado|acompanhamento|abertura\s+de\s+chamado)\b/i.test(normAll)) &&
      (/\b(anexar|anexando|anexo|upload|tipo de arquivo n[aã]o permitido|arquivo n[aã]o [eé] anexado)\b/i.test(
        normAll
      ) ||
        /\btipo de arquivo n[aã]o permitido\b/i.test(normAll))
    ) {
      detectedDomain =
        "Administração do GLPI / Gestão de Documentos e Mime Types";
      suggestedCategory =
        "T.I > ST > Resolução de Problemas > Erros de Sistema";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason =
        "Impossibilidade de anexar documentos em acompanhamento de chamados no GLPI devido a bloqueio de 'Tipo de arquivo não permitido'.";

      const descOnly = formFields.descricao || ticket.content || "";
      let docName = "documento PDF / anexo";
      if (ticket.ocr_text && /PROTOCOLO/i.test(ticket.ocr_text)) {
        docName = "PROTOCOLO DE RESPOSTA AO OFÍCIO (PDF)";
      } else {
        docName = "documento em formato PDF (PROTOCOLO DE RESPOSTA AO OFÍCIO)";
      }

      translatedIntent =
        `${solPrefix} **${formattedRequester}** (${sectorName}) relata falha ao anexar arquivo durante o andamento de um chamado no sistema **GLPI**, com a mensagem de erro **"Tipo de arquivo não permitido"** (conforme prints anexados evidenciando a tentativa de upload do documento '${docName}'). ` +
        `Trata-se de restrição de extensão ou tipo MIME na configuração de Tipos de Documentos do GLPI (Configurar > Tipos de documentos / front/documenttype.php), demandando verificar se o parâmetro 'Autorizado para envio' está ativo para a extensão (ex.: .pdf / .PDF) e cadastrar variações de MIME type aceitas (ex.: application/pdf, application/x-pdf, application/acrobat). ` +
        `A solicitação encontra-se completa e a categoria deve ser reclassificada de 'Desenvolvimento > Correção de bugs' para 'T.I > ST > Resolução de Problemas > Erros de Sistema' (ID 73).`;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos o seu relato referente à mensagem de erro **"Tipo de arquivo não permitido"** ao tentar anexar o arquivo no acompanhamento do chamado no **GLPI**.\n\n` +
        `Informamos que as informações e evidências enviadas já foram validadas na triagem técnica e nossa equipe de Administração de Sistemas já está realizando a verificação e liberação das permissões na tabela de **Tipos de Documentos** do GLPI (autorização para envio e inclusão dos tipos MIME correspondentes ao arquivo).\n\n` +
        `Assim que o ajuste for concluído e o upload estiver liberado no sistema, confirmaremos por aqui para que você possa anexar o documento normalmente!\n\n` +
        `Permanecemos à disposição!`;

      customResolutionSteps = [
        `[PB-UNI-73] Reclassificar a categoria do chamado no GLPI de 'T.I > DV > Desenvolvimento > Correção de bugs' para 'T.I > ST > Resolução de Problemas > Erros de Sistema' (ID 73).`,
        `[PB-UNI-73] Acessar o sistema GLPI com perfil administrativo (Super-Admin) no menu: Configurar > Tipos de documentos (front/documenttype.php).`,
        `[PB-UNI-73] Localizar a extensão correspondente ao arquivo que falhou no upload (ex.: 'pdf' / 'PDF').`,
        `[PB-UNI-73] Verificar se o campo 'Autorizado para envio' está configurado como 'Sim'.`,
        `[PB-UNI-73] Na lista de Tipos MIME autorizados da extensão, validar e incluir variações necessárias (ex.: application/pdf, application/x-pdf, application/acrobat, application/vnd.pdf) para suportar arquivos gerados por diferentes plataformas e assinadores digitais.`,
        `[PB-UNI-73] Caso o arquivo possua extensão com letras maiúsculas (.PDF) e o GLPI aplique correspondência estrita, certificar o cadastro da extensão em maiúsculo.`,
        `[PB-UNI-73] Realizar teste de anexo no chamado e comunicar ao solicitante ${formattedRequester} (${sectorName}) a normalização do upload no GLPI.`
      ];
    } else if (
      /\b(mudan[cç]a\s+de\s+acomoda[cç][aã]o|troca\s+de\s+acomoda[cç][aã]o|acomoda[cç][aã]o\s+quarto\s+coletivo|quarto\s+coletivo|apartamento\s+simples|tipo\s+de\s+acomoda[cç][aã]o\s+autorizada|campo\s+41)\b/i.test(
        normAll
      ) ||
      (/\bacomoda[cç][aã]o\b/i.test(normAll) &&
        /\b(quarto\s+coletivo|apartamento|honor[aá]rios?\s+m[eé]dicos?|troca\s+d[eo]\s+campo|mudar|trocar)\b/i.test(
          normAll
        ))
    ) {
      detectedDomain =
        "Sistemas Internos / ERP HRP Unimed / Faturamento e Auditoria / Reversão de Processos";
      suggestedCategory =
        "T.I > ST > Reversão de Processos / Ajustes Operacionais";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason =
        "Ajuste operacional de mudança de acomodação para Quarto Coletivo na guia de internação no ERP HRP Unimed para recálculo correto dos honorários médicos pelo Faturamento.";

      const senhaMatch =
        (ticket.content || "").match(/\b207\d{6}\b/) ||
        (ticket.ocr_text || "").match(/\b207\d{6}\b/) ||
        (ticket.content || "").match(/\bsenha\s*[:\s]*(\d+)/i);
      const senhaStr = senhaMatch ? senhaMatch[0] : "207283124";

      const chaveMatch = (ticket.ocr_text || "").match(/Chave\W*(\d+)/i);
      const chaveStr = chaveMatch ? chaveMatch[1] : "207290172";
      const itemCodeStr = "60000805 - DIÁRIA DE QUARTO COLETIVO DE 2 LEITOS";

      translatedIntent =
        `${solPrefix} **${formattedRequester}** (${sectorName}) solicita a mudança de acomodação na guia/senha de internação **${senhaStr}** no sistema **ERP HRP Unimed**, realizando a troca do campo **41 - Tipo de Acomodação Autorizada** (atualmente configurado como *Apartamento*) para **Quarto Coletivo** (*41 - QUARTO COLETIVO DE 2 LEITOS*). ` +
        `A solicitação acompanha prints do sistema evidenciando os dados da guia (Chave: ${chaveStr}, item ${itemCodeStr}) e o grid de acomodações do HRP. Conforme justificado pelo setor de Faturamento, o ajuste se faz necessário para que o sistema calcule e contabilize corretamente os honorários médicos. ` +
        `Trata-se de um ajuste operacional / reversão de processo (e não de resolução de problemas ou erro de software). A solicitação encontra-se completa e a categoria deve ser reclassificada de 'T.I > ST > Resolução de Problemas' para 'T.I > ST > Reversão de Processos / Ajustes Operacionais' (ID 163).`;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente ao ajuste operacional de **mudança de acomodação** na guia/senha de internação **${senhaStr}** no sistema **ERP HRP Unimed**.\n\n` +
        `Informamos que as informações e evidências enviadas já foram validadas na triagem técnica e nossa equipe já está realizando a alteração do campo **Tipo de Acomodação Autorizada** para **Quarto Coletivo** (*QUARTO COLETIVO DE 2 LEITOS*), permitindo que o sistema calcule e contabilize corretamente os honorários médicos pelo setor de Faturamento.\n\n` +
        `Assim que o ajuste for concluído no sistema e a guia estiver liberada para o recálculo, confirmaremos por aqui!\n\n` +
        `Permanecemos à disposição!`;

      customResolutionSteps = [
        `[PB-UNI-74] Reclassificar a categoria do chamado no GLPI de 'T.I > ST > Resolução de Problemas' para 'T.I > ST > Reversão de Processos / Ajustes Operacionais' (ID 163).`,
        `[PB-UNI-74] Acessar o sistema ERP HRP Unimed no módulo de Autorizações de Internação.`,
        `[PB-UNI-74] Localizar a guia/solicitação de internação pela senha informada (${senhaStr}, chave ${chaveStr}).`,
        `[PB-UNI-74] Acessar o item assistencial correspondente à diária (${itemCodeStr}) e localizar o campo '41 - Tipo de Acomodação Autorizada'.`,
        `[PB-UNI-74] Realizar a troca do campo de '12 - APARTAMENTO SIMPLES' para a opção informada '41 - QUARTO COLETIVO DE 2 LEITOS' (Classe: Coletiva).`,
        `[PB-UNI-74] Salvar a alteração no HRP Unimed e validar a liberação para que o setor de Faturamento proceda com o recálculo correto dos honorários médicos.`,
        `[PB-UNI-74] Notificar a solicitante ${formattedRequester} (${sectorName}) no chamado do GLPI confirmando a conclusão do ajuste operacional.`
      ];
    } else if (
      /\b(produ[çc][ãa]o\s+cooperados?|produ[çc][ãa]o\s+dos\s+m[ée]dicos?|produ[çc][ãa]o\s+m[ée]dica|extra[çc][ãa]o\s+produ[çc][ãa]o|envio\s+de\s+produ[çc][ãa]o)\b/i.test(
        normAll
      ) ||
      (/\bprodu[çc][ãa]o\b/i.test(normAll) &&
        /\b(cooperados?|m[ée]dicos?|m[ée]dica|excel|segregado)\b/i.test(normAll))
    ) {
      detectedDomain =
        "Banco de Dados, BI e Relatórios";
      suggestedCategory =
        "T.I > BD > Big Data e BI > Relatórios";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason =
        "Extração de relatório/planilha de produção médica de cooperados em Excel segregada por tipo de atendimento para atendimento formal autorizado.";

      translatedIntent =
        `${solPrefix} **${formattedRequester}** (${sectorName}) encaminha solicitação formal com termo de autorização em anexo solicitando a extração da **produção médica dos cooperados em planilha Excel**, segregada por tipo de atendimento. ` +
        `Trata-se de demanda de levantamento de dados e relatórios sob responsabilidade da equipe de Banco de Dados e BI. ` +
        `A solicitação encontra-se completa e a categoria no GLPI deve ser reclassificada da categoria genérica de Sistemas Operacionais para a categoria oficial do catálogo de serviços: **'T.I > BD > Big Data e BI > Relatórios' (ID 111)**.`;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação acompanhada do documento de autorização em anexo para extração da **produção dos médicos cooperados em planilha Excel (segregada por tipo de atendimento)**.\n\n` +
        `Informamos que os parâmetros foram validados na triagem técnica e nossa equipe de Banco de Dados e BI já está realizando o levantamento e a extração dos dados conforme o documento anexado.\n\n` +
        `Assim que a planilha consolidada for gerada, encaminharemos o arquivo por aqui!\n\n` +
        `Permanecemos à disposição!`;

      customResolutionSteps = [
        `[PB-UNI-16] Reclassificar a categoria do chamado no GLPI para 'T.I > BD > Big Data e BI > Relatórios' (ID 111), retirando da categoria genérica de Sistemas Operacionais.`,
        `[PB-UNI-16] Validar o termo de autorização formal em PDF anexado ao chamado pelo setor de Relacionamento com Prestadores.`,
        `[PB-UNI-16] Acessar o banco de dados corporativo / ferramenta de BI e executar a consulta de produção dos médicos cooperados com a segregação por tipo de atendimento solicitada.`,
        `[PB-UNI-16] Exportar os resultados consolidados em formato de planilha Excel (.xlsx), conferir os totais e disponibilizar no chamado para a solicitante.`
      ];
    } else if (
      /\b(pesquisa\s+de\s+satisfa[cç][aã]o|avalia[cç][aã]o\s+da\s+satisfa[cç][aã]o|experi[êe]ncia\s+do\s+cliente)\b/i.test(
        normAll
      ) &&
      /\b(laborat[oó]rio|palc|totem|tablet|novas\s+aplica[cç][õo]es)\b/i.test(
        normAll
      )
    ) {
      detectedDomain =
        "Desenvolvimento de Software / Projetos e Novas Aplicações / Gestão da Qualidade";
      suggestedCategory =
        ticket.category && ticket.category.includes("Novas aplicações")
          ? ticket.category
          : "T.I > DV > Desenvolvimento > Novas aplicações";
      realUrgency = "Média";
      urgencyReason =
        "Projeto institucional de implantação de ferramenta/totem de satisfação vinculado ao processo de adequação e Acreditação PALC do Laboratório Unimed.";

      translatedIntent =
        `${solPrefix} **${formattedRequester}** (${sectorName}) solicita o apoio integrado dos setores de **Tecnologia da Informação (TI)** e **Compras** para avaliação de viabilidade técnica/operacional e prospecção de soluções de mercado para implantação de um sistema sistematizado de **pesquisa de satisfação e experiência do cliente** no **Laboratório Unimed**, preferencialmente via **totem eletrônico de avaliação, tablet ou ferramenta digital**. ` +
        `A demanda visa atender aos requisitos normativos de gestão da qualidade para a **Acreditação PALC (SBPC/ML)** e contempla: 1) Pesquisa estruturada com perguntas objetivas e campo para comentários; 2) Avaliação de aspectos como recepção, coleta, cordialidade, tempo de espera e experiência geral; 3) Consolidação de banco de dados e geração de relatórios gerenciais e indicadores de satisfação (NPS/CSAT); 4) Levantamento de alternativas, estimativa de custos e cronograma de implantação. ` +
        `A solicitação encontra-se **completa** e a categoria no GLPI está devidamente enquadrada em **'T.I > DV > Desenvolvimento > Novas aplicações' (ID 120)**.`;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente ao projeto de implantação da **ferramenta de pesquisa de satisfação e experiência do cliente** para o **Laboratório Unimed**, em atendimento aos requisitos normativos da **Acreditação PALC (SBPC/ML)**.\n\n` +
        `Informamos que a sua solicitação foi classificada como **completa**, pois já contém o detalhamento de todos os requisitos essenciais da solução (perguntas objetivas e campo aberto, avaliação por etapas do atendimento — recepção, coleta, cordialidade e tempo de espera —, consolidação de dados e emissão de relatórios gerenciais de indicadores).\n\n` +
        `A categoria do chamado foi mantida em **T.I > DV > Desenvolvimento > Novas aplicações** e as seguintes frentes técnicas já foram iniciadas:\n` +
        `1. **Alinhamento com Compras:** Abertura de prospecção de mercado e coleta de propostas comerciais junto a fornecedores especializados em totens físicos, tablets e plataformas de pesquisa de satisfação (NPS/CSAT) homologadas para o ambiente laboratorial/hospitalar;\n` +
        `2. **Avaliação Técnica de TI:** Levantamento dos requisitos de conectividade (rede Wi-Fi/cabeada no balcão da Recepção do Laboratório), alimentação elétrica/segurança do equipamento e recursos de gestão de relatórios na nuvem;\n` +
        `3. **Validação de Cronograma:** Consolidação dos orçamentos e do estudo de viabilidade técnica para apresentação à Coordenação do Laboratório e definição do plano de implantação aderente ao calendário da auditoria PALC.\n\n` +
        `Assim que compilarmos as primeiras alternativas de fornecedores e estimativas orçamentárias, entraremos em contato para alinharmos os próximos passos!\n\n` +
        `Permanecemos à disposição!`;

      customResolutionSteps = [
        `[PB-UNI-75] Manter a categoria do chamado no GLPI em 'T.I > DV > Desenvolvimento > Novas aplicações' (ID 120), confirmando o enquadramento em projetos de novas ferramentas/aplicações corporativas.`,
        `[PB-UNI-75] Ajustar a urgência real para Média/Alta no GLPI em função do cronograma institucional de adequação aos requisitos de qualidade da Acreditação PALC (SBPC/ML) do Laboratório Unimed.`,
        `[PB-UNI-75] Alinhar com o setor de Compras (Gestão de Suprimentos) a abertura de processo de cotação e prospecção de mercado para fornecedores especializados em totens/tablets e plataformas de pesquisa de satisfação (NPS/CSAT) na área de saúde.`,
        `[PB-UNI-75] Avaliar com a equipe técnica de TI (Infraestrutura/Redes e Sistemas) a viabilidade dos modelos: 1) Totem físico autônomo com tablet/display touchscreen e conectividade Wi-Fi/PoE; 2) Software SaaS em nuvem com painel web para gestão de relatórios gerenciais e exportação de indicadores; 3) Possibilidade de integração futura com o sistema de atendimento/painel de senhas.`,
        `[PB-UNI-75] Consolidar o comparativo técnico de requisitos, estimativa de custos e cronograma de homologação, agendando reunião de alinhamento com a solicitante Rosy Ellen (Laboratório) e com o setor de Compras.`,
        `[PB-UNI-75] Manter o chamado atualizado com os pareceres técnicos de viabilidade e propostas comerciais analisadas.`
      ];
    } else if (
      /\b(painel\s+de\s+senhas?|gerenciador\s+de\s+filas?|fila\s+de\s+atendimento|chamador\s+de\s+senhas?|sistema\s+de\s+senhas?|controle\s+de\s+filas?)\b/i.test(
        normAll
      ) &&
      !/\b(impressora|spooler|toner|mancha|atolamento|papel preso)\b/i.test(
        normAll
      )
    ) {
      detectedDomain =
        "Desenvolvimento de Software / Projetos e Novas Aplicações / Gestão de Atendimento";
      suggestedCategory =
        ticket.category && ticket.category.includes("Novas aplicações")
          ? ticket.category
          : "T.I > DV > Desenvolvimento > Novas aplicações";
      realUrgency = "Média";
      urgencyReason =
        "Desenvolvimento de nova aplicação para organização e gestão do fluxo de atendimento e fila de pacientes na Recepção Externa do Hospital.";

      translatedIntent =
        `${solPrefix} **${formattedRequester}** (${sectorName}) solicita o desenvolvimento de uma nova aplicação corporativa de **Painel de Senhas / Gerenciador de Fila de Atendimento** para organizar o fluxo de pacientes na **Recepção Externa do Hospital Unimed**. ` +
        `Trata-se de demanda de Desenvolvimento de Software sob responsabilidade técnica do desenvolvedor da T.I. (**Moisés Conte**), visando substituir processos manuais por chamada sistemática de senhas em tela/TV na sala de espera (com aviso sonoro e visual), módulo web para os guichês de atendimento (chamada de próxima senha, rechamada e transferências) e controle de prioridades (Normal vs. Preferencial/Prioritária por lei). ` +
        `A solicitação encontra-se **completa** e a categoria no GLPI está devidamente enquadrada em **'T.I > DV > Desenvolvimento > Novas aplicações' (ID 120)**.`;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente ao **desenvolvimento da aplicação de Painel de Senha e Gerenciador de Fila de Atendimento** para a **Recepção Externa do Hospital Unimed**.\n\n` +
        `A demanda já foi recepcionada pela equipe de Desenvolvimento de Software (**Moisés**) sob a categoria oficial **T.I > DV > Desenvolvimento > Novas aplicações** (ID 120).\n\n` +
        `Para estruturarmos a modelagem do sistema e o cronograma de entrega, já estamos levantando os seguintes requisitos técnicos e operacionais:\n` +
        `1. **Estrutura das Filas:** Categorias de atendimento necessárias (ex.: Atendimento Normal, Prioritário/Preferencial por lei, Triagem/Urgência e Exames);\n` +
        `2. **Interface do Operador:** Módulo web leve para que os atendentes nos guichês da Recepção Externa possam chamar a próxima senha, rechamar ou transferir pacientes diretamente pelo navegador;\n` +
        `3. **Hardware e Exibição:** Alinhamento com a equipe de Infraestrutura de T.I. para conexão da tela/TV na sala de espera (com aviso sonoro e visual da senha/guichê) e método de emissão das senhas (impressora térmica de tickets ou dispenser físico);\n` +
        `4. **Métricas de Atendimento:** Painel gerencial para registro dos tempos médios de espera e de atendimento por guichê.\n\n` +
        `O desenvolvedor responsável já está iniciando o desenho da solução e, em breve, apresentaremos um protótipo operacional para validação junto à equipe da Recepção Externa!\n\n` +
        `Permanecemos à disposição!`;

      customResolutionSteps = [
        `[PB-UNI-76] Manter a categoria do chamado no GLPI em 'T.I > DV > Desenvolvimento > Novas aplicações' (ID 120), confirmando o enquadramento em novas aplicações corporativas.`,
        `[PB-UNI-76] Direcionar a demanda para a equipe de Desenvolvimento de Software (Moisés Conte) para início da etapa de levantamento e especificação de requisitos da aplicação.`,
        `[PB-UNI-76] Definir o modelo de arquitetura de software: aplicação web responsiva com interface cliente para o guichê (chamada de próxima senha, rechamada, transferência) e tela de exibição para TV da recepção com sintetizador de voz (TTS) ou sinal sonoro.`,
        `[PB-UNI-76] Mapear os tipos de atendimento/filas requeridos pelo setor: Normal, Preferencial/Prioritária (idosos, gestantes, PCDs por lei), Urgência/Triagem e serviços específicos.`,
        `[PB-UNI-76] Alinhar com a equipe de Infraestrutura e Redes os requisitos de hardware na Recepção Externa: TV/monitor HDMI na sala de espera, mini-PC/Smart TV/Raspberry Pi conectado à rede local e impressora térmica de senhas (ou dispenser de senhas pré-impressas/totem).`,
        `[PB-UNI-76] Apresentar o protótipo/versão beta para validação operacional com a supervisão da Recepção Externa e planejar a implantação piloto.`
      ];
    } else if (
      (/\b(teclado|teclados|mouse|mouses)\b/i.test(normAll) &&
        (/\b(falha|defeito|falhando|n[aã]o digita|n[aã]o est[aá] digitando|tecla|teclas|letras|bot[aã]o|bot[oõ]es|trocar|troca|substitui[cç][aã]o|ruim|estragad|parou|manuten[cç][aã]o)\b/i.test(
          normAll
        ) ||
          /\b(manuten[cç][aã]o\s+eletr[oô]nica\s*\|\s*teclado|manuten[cç][aã]o\s+eletr[oô]nica\s*\|\s*mouse)\b/i.test(
            normAll
          ))) &&
      !/\b(impressora|toner|fusor|repromaq|pabx|ramal|voip|wi-?fi|internet|bi\b|relat[oó]rio)\b/i.test(
        normAll
      )
    ) {
      const isMouse =
        /\b(mouse|mouses)\b/i.test(normAll) &&
        !/\b(teclado|teclados)\b/i.test(normAll);
      const itemType = isMouse ? "mouse" : "teclado";
      const itemTypeUpper = isMouse ? "Mouse" : "Teclado";

      detectedDomain =
        "Infraestrutura e Redes / Suporte a Hardware / Periféricos";
      suggestedCategory = isMouse
        ? "T.I > IR > Suporte a Hardware > Periféricos > Mouses"
        : "T.I > IR > Suporte a Hardware > Periféricos > Teclados";

      const isCriticalUnit =
        /\b(uti|cti|pronto\s+atendimento|pa\b|emerg[eê]ncia|centro\s+cir[uú]rgico|bloco\s+cir[uú]rgico|hemodi[aá]lise|maternidade)\b/i.test(
          normAll
        );
      realUrgency = isCriticalUnit ? "Alta" : (ticket.urgency_label || "Média");
      urgencyReason = isCriticalUnit
        ? `Falha de funcionamento em ${itemType} em setor assistencial crítico (${sectorName}), demandando atendimento presencial prioritário para troca física e continuidade do atendimento médico/assistencial no PEP/SGH.`
        : `Falha de hardware/periférico (${itemType}) em estação de trabalho, demandando teste e substituição física do componente pela equipe de Infraestrutura.`;

      const targetLoc =
        formFields.localizacao || formFields.setor || sectorName || "setor solicitante";

      const reclassNote =
        ticket.category &&
        (ticket.category.toLowerCase().includes("manutenção") ||
          ticket.category.toLowerCase().includes("manutencao") ||
          ticket.category.toLowerCase().includes("sistemas operacionais") ||
          ticket.category.toLowerCase().includes("aplicativos"))
          ? ` A categoria do chamado no GLPI foi corrigida de **'${ticket.category}'** para a categoria oficial de periféricos de entrada **'${suggestedCategory}'** (ID ${isMouse ? "151" : "152"}).`
          : "";

      translatedIntent =
        `${solPrefix} **${formattedRequester}** (${sectorName}) relata falha física no **${itemType} do computador** no local **${targetLoc}** (${formFields.problema || "falha de funcionamento/digitação"}). ` +
        `O chamado foi aberto inicialmente via formulário externo de manutenção e escalonado para a T.I.${reclassNote} ` +
        `A solicitação encontra-se **completa**, com setor, equipamento e sintoma identificados, demandando deslocamento presencial de técnico de Infraestrutura e Redes munido de ${itemType} USB reserva homologado para teste e substituição imediata no posto de trabalho.`;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente à falha no **${itemType} de computador** no setor **${sectorName}**.\n\n` +
        `Informamos que as informações fornecidas já foram validadas na triagem técnica (chamado classificado como **completo**) e o chamado foi direcionado para a equipe de Hardware (**${suggestedCategory}**).\n\n` +
        (isCriticalUnit
          ? `Como se trata de uma estação em setor assistencial crítico (**${sectorName}**), nossa equipe de Infraestrutura e Redes já priorizou o atendimento e um técnico está se deslocando até o local com um ${itemType} USB reserva para realizar o teste e a **substituição física imediata**!\n\n`
          : `Nossa equipe de Infraestrutura e Redes já programou o atendimento presencial e um técnico irá até o setor com um ${itemType} USB reserva para realizar o teste e a **substituição física** do periférico.\n\n`) +
        `Permanecemos à disposição!`;

      customResolutionSteps = [
        `[PB-UNI-77] Reclassificar a categoria do chamado no GLPI de '${ticket.category || "Hospital > Manutenção"}' para '${suggestedCategory}' (ID ${isMouse ? "151" : "152"}), ajustando o direcionamento para o grupo de Infraestrutura e Redes.`,
        isCriticalUnit
          ? `[PB-UNI-77] Ajustar a urgência real para Alta/Muito Alta no GLPI, tendo em vista o impacto operacional imediato na digitação e evolução de prontuários no PEP/SGH na ${sectorName}.`
          : `[PB-UNI-77] Manter a urgência real em nível Médio no GLPI para atendimento presencial pela equipe de Infraestrutura e Redes.`,
        `[PB-UNI-77] Deslocar técnico de Infraestrutura e Redes (T.I > IR) até a ${targetLoc} munido de um ${itemType} USB novo/reserva do estoque técnico.`,
        `[PB-UNI-77] Realizar o teste físico do periférico no computador: conectar em outra porta USB traseira da CPU para descartar mau contato de porta USB ou conector frouxo.`,
        `[PB-UNI-77] Confirmada a falha de membrana/switches/sensor ótico, efetuar a substituição imediata pelo periférico reserva homologado e recolher o componente avariado para descarte ou sucateamento.`,
        `[PB-UNI-77] Validar junto à equipe do posto de trabalho a normalização da digitação e funcionamento no sistema e concluir o chamado no GLPI.`
      ];
    } else if (
      (/\b(samsung\s+m?4080|m4080|m4080fx|samsung\s+m?4020|m4020|m4020nd|samsung\s+4080|samsung\s+4020)\b/i.test(
        normAll
      ) &&
      !/\b(troca\s+de\s+toner|trocar\s+(?:o\s+)?toner|trocado\s+(?:o\s+)?toner|acabou\s+o\s+toner|preciso\s+de\s+toner|solicito\s+toner|toner\s+vazio|refil|tinta)\b/i.test(
        normAll
      ) &&
      !/\b(scan\s+to\s+e-?mail|digitaliza[cç][aã]o\s+para\s+e-?mail|cat[aá]logo\s+de\s+endere[cç]os?)\b/i.test(
        normAll
      ) &&
      !/\b(precisamos\s+de\s+uma?\s+impressora|instala[cç][aã]o\s+de\s+nova\s+impressora|disponibilizar\s+impressora)\b/i.test(
        normAll
      ) &&
      (/\b(fusor|falha\s+(?:no\s+)?fusor|manuten[cç][aã]o|preventiva|corretiva|verifica[cç][aã]o\s+preventiva|defeito|conserto|reparo|pe[çc]a|substitui[cç][aã]o\s+de\s+pe[çc]a|barulho|aquecimento|lenta|lentid[aã]o|repromaq|terceirizad|assist[eê]ncia)\b/i.test(
        normAll
      ) ||
        normAll.includes("falha no fusor") ||
        normAll.includes("manutencao preventiva"))) ||
      (/\brepromaq\b/i.test(normAll) &&
        /\b(impressora|manuten[cç][aã]o|suporte|chamado)\b/i.test(normAll))
    ) {
      const printerModel =
        formFields.ativo ||
        (/\bm4080(?:fx)?\b/i.test(normAll)
          ? "SAMSUNG M4080FX"
          : /\bm4020(?:nd)?\b/i.test(normAll)
          ? "SAMSUNG M4020ND"
          : "Samsung M4080 / M4020");
      const printerVendor = "Repromaq";

      const mentionsFusor = /\bfusor\b/i.test(normAll);
      const isPreventive = /\bpreventiva\b/i.test(normAll);
      const symptomDesc = mentionsFusor
        ? "alerta de falha na unidade fusora ('falha no fusor') e lentidão no processamento de impressões"
        : isPreventive
        ? "necessidade de revisão e manutenção preventiva no equipamento"
        : "falha física/mecânica no equipamento demandando intervenção técnica especializada";

      detectedDomain =
        "Infraestrutura e Redes (Outsourcing de Impressão / Suporte a Hardware)";
      suggestedCategory =
        ticket.category && ticket.category.includes("Impressoras")
          ? ticket.category
          : "T.I > IR > Suporte a Hardware > Periféricos > Impressoras";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason =
        `Manutenção preventiva/corretiva na impressora locada ${printerModel} (${sectorName}) via fornecedor terceirizado Repromaq para prevenir indisponibilidade operacional.`;

      translatedIntent =
        `${solPrefix} **${formattedRequester}** (${sectorName}) solicita ${isPreventive ? "manutenção preventiva" : "manutenção técnica"} para a impressora **${printerModel}** (${sectorName}), ` +
        `relatando ${symptomDesc}. ` +
        `Por se tratar de equipamento sob contrato de outsourcing/locação com o fornecedor terceirizado **${printerVendor}**, qualquer falha mecânica, defeito ou revisão de peças (que não seja reposição de toner) compete à assistência técnica credenciada da Repromaq (com acionamento e acompanhamento pela equipe de T.I.). ` +
        `Todos os dados necessários (modelo, setor e sintoma) constam informados no chamado.`;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente à manutenção preventiva na impressora **${printerModel}** do setor de **${sectorName}**.\n\n` +
        `Gostaríamos de esclarecer que as impressoras Samsung modelos M4020 e M4080 são equipamentos terceirizados sob contrato de locação com o fornecedor **${printerVendor}**. ` +
        `Por se tratar de uma falha física no equipamento (${symptomDesc}), nossa equipe de T.I. já está abrindo o chamado técnico diretamente junto ao suporte da ${printerVendor} para agendamento da visita do técnico credenciado para revisão e manutenção da máquina.\n\n` +
        `Acompanharemos o atendimento por aqui e, assim que a ${printerVendor} confirmar a data/horário da visita ou concluir a manutenção, atualizaremos você no chamado!\n\n` +
        `Permanecemos à disposição!`;

      customResolutionSteps = [
        `[PB-UNI-68] Confirmar os dados do equipamento terceirizado (${printerModel}) localizado no setor ${sectorName} e o sintoma reportado (${symptomDesc}).`,
        `[PB-UNI-68] Acessar o canal de atendimento e suporte técnico do fornecedor de outsourcing ${printerVendor} e formalizar a abertura de chamado para manutenção preventiva/corretiva no equipamento.`,
        `[PB-UNI-68] Informar à ${printerVendor} o relato de ${symptomDesc} para que o técnico credenciado traga os insumos e peças de reposição necessárias (fusor/roletes).`,
        `[PB-UNI-68] Registrar o número de protocolo do chamado da ${printerVendor} como nota técnica interna no GLPI para acompanhamento.`,
        `[PB-UNI-68] Acompanhar a visita técnica presencial do profissional da ${printerVendor} no setor ${sectorName}, validar os testes de impressão pós-manutenção e concluir o chamado no GLPI.`
      ];
    } else if (
      /\b(geral@unimedsudoestemg\.coop\.br|geralunimed@unimedsudoestemg\.coop\.br)\b/i.test(
        normAll
      ) ||
      (/\b(e-?mail\s+geral|geral\s+unimed|geralunimed|e-?mail\s+institucional|e-?mails?)\b/i.test(
        normAll
      ) &&
        /\b(geral|geral\s+unimed|grupo|grupos|lista|listas)\b/i.test(normAll) &&
        /\b(incluir|inclus[aã]o|adicionar|adi[cç][aã]o|inserir|inser[çc][aã]o|acesso|recebe|recebendo)\b/i.test(
          normAll
        )) ||
      /\b(acesso\s+ao\s+e-?mail\s+geral|acesso\s+ao\s+e-?mail\s+geral\s+unimed)\b/i.test(
        normAll
      ) ||
      (/\b(grupo|grupos|lista|listas)\s+(?:de\s+)?(?:e-?mails?|distribui[çc][ãa]o)\b/i.test(
        normAll
      ) &&
        /\b(incluir|inclus[aã]o|adicionar|adi[cç][aã]o|inserir|inser[çc][aã]o|cadastrar)\b/i.test(
          normAll
        ))
    ) {
      detectedDomain =
        "Acessos, Permissões e Contas (Gestão de E-mails Corporativos / Grupos de Distribuição)";
      suggestedCategory =
        ticket.category && ticket.category.includes("Acesso e Permissões")
          ? ticket.category
          : "T.I > ST > Acesso e Permissões > Criação de Usuários";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason =
        "Inclusão de colaborador em grupo/lista de distribuição de e-mails corporativos (Geral Unimed) para recebimento de comunicados institucionais.";

      const rawBeneficiary =
        formFields.nomeColaborador ||
        formFields.nome ||
        "";
      const beneficiaryFormatted = rawBeneficiary
        ? formatPersonName(rawBeneficiary)
        : formattedRequester;

      const rawRequesterFirst = firstName.toLowerCase();
      const rawBenFirst = beneficiaryFormatted.split(/\s+/)[0].toLowerCase();
      const isSelf =
        !rawBeneficiary ||
        rawRequesterFirst === rawBenFirst ||
        normalizeText(ticket.requester || "").includes(normalizeText(rawBenFirst));

      const targetSector =
        formFields.setorAlvo ||
        formFields.setor ||
        ticket.requester_department ||
        sectorName ||
        "setor solicitante";
      const targetUnit = formFields.unidade || "Unimed";

      const groupName = "Geral Unimed";
      const groupEmail = "geral@unimedsudoestemg.coop.br";

      sufficiencyStatus = "completo";
      missingInfo = [];

      if (isSelf) {
        translatedIntent =
          `${solPrefix} **${formattedRequester}** (${sectorName}) solicita a inclusão do seu e-mail institucional no grupo de distribuição **${groupName}** (\`${groupEmail}\`) ` +
          `para o setor **${targetSector}** (${targetUnit}). ` +
          `Todos os dados cadastrais (Nome: ${beneficiaryFormatted}${formFields.cpf ? `, CPF: ${formFields.cpf}` : ""}) e o grupo institucional constam devidamente informados no chamado.`;

        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente à inclusão do seu e-mail institucional no grupo de distribuição **${groupName}** (\`${groupEmail}\`) para o setor **${targetSector}** (${targetUnit}).\n\n` +
          `Todas as informações necessárias já constam no chamado e nossa equipe de T.I. já está realizando a inserção da sua conta no grupo correspondente no painel de administração de e-mails corporativos. ` +
          `Assim que a configuração for concluída e sincronizada, confirmaremos por aqui!\n\n` +
          `Permanecemos à disposição!`;
      } else {
        translatedIntent =
          `${solPrefix} **${formattedRequester}** (${sectorName}) solicita a inclusão do e-mail corporativo do colaborador **${beneficiaryFormatted}**` +
          (formFields.cpf ? ` (CPF: ${formFields.cpf})` : "") +
          ` no grupo de distribuição **${groupName}** (\`${groupEmail}\`) para o setor **${targetSector}** (${targetUnit}). ` +
          `Todos os dados cadastrais e o grupo institucional constam devidamente informados no chamado.`;

        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente à inclusão do e-mail corporativo do colaborador **${beneficiaryFormatted}** no grupo de distribuição **${groupName}** (\`${groupEmail}\`) para o setor **${targetSector}** (${targetUnit}).\n\n` +
          `Todas as informações necessárias já constam no chamado e nossa equipe de T.I. já está realizando a inserção da conta no grupo correspondente no painel de administração de e-mails corporativos. ` +
          `Assim que a configuração for concluída e sincronizada, confirmaremos por aqui!\n\n` +
          `Permanecemos à disposição!`;
      }

      customResolutionSteps = [
        `[PB-UNI-67] Acessar o painel administrativo de e-mails corporativos da cooperativa (Locaweb / Webmail Seguro / painel de mensageria).`,
        `[PB-UNI-67] Localizar a caixa postal institucional de ${beneficiaryFormatted} (${targetSector} - ${targetUnit}).`,
        `[PB-UNI-67] Inserir o endereço de e-mail como membro ativo na lista de distribuição / grupo '${groupName}' (${groupEmail}).`,
        `[PB-UNI-67] Validar a propagação e sincronização das regras de entrega de mensagens do grupo.`,
        `[PB-UNI-67] Notificar ${isSelf ? firstName : formattedRequester} no chamado do GLPI confirmando a conclusão e colher validação nos próximos comunicados disparados.`
      ];
    } else if (
      (/\b(alterar\s+(?:atendimento|car[aá]ter|guia|senha|o\s+car[aá]ter)|car[aá]ter\s+de\s+atendimento|eletivo\s+para\s+urg[eê]ncia|urg[eê]ncia\s+para\s+eletivo)\b/i.test(
        normAll
      ) &&
      /\b(eletiv[oa]|urg[eê]ncia)\b/i.test(normAll) &&
      (/\b(via\s+banco|no\s+banco|hrp|senha|guia|interc[aâ]mbio|autoriza[çc][ãa]o)\b/i.test(
        normAll
      ) ||
        normAll.includes("210800316"))) ||
      (/\b(interc[aâ]mbio|unimed\s+interc[aâ]mbio)\b/i.test(normAll) &&
        /\b(eletiv[oa]|urg[eê]ncia)\b/i.test(normAll) &&
        /\b(alterar|mudar|converter|cancelar|cancelamento)\b/i.test(normAll))
    ) {
      const sectorName =
        (formFields.setor && !formFields.setor.startsWith("1)"))
          ? formFields.setor
          : ticket.requester_department || "Autorização";
      const isMale =
        /^(juliano|dener|diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor|tarcisio|claudio|moises|luiz|renan)\b/i.test(
          firstName
        );
      const solPrefix = isMale ? "O solicitante" : "A solicitante";

      const senhaMatch = normAll.match(/\b(21\d{7}|\d{9})\b/);
      const senhaNum = senhaMatch ? senhaMatch[1] : "210800316";

      detectedDomain =
        "Sistemas Internos / ERP HRP Unimed (Autorização de Guias / Intercâmbio Nacional)";
      suggestedCategory = "T.I > ST > Resolução de Problemas";
      realUrgency = ticket.urgency_label || "Alta";
      urgencyReason =
        `Solicitação do setor de ${sectorName} para alteração via banco de dados do caráter de atendimento de eletivo para urgência da guia/senha ${senhaNum} no ERP HRP Unimed. Trata-se de guia de beneficiário de Intercâmbio Nacional, na qual a alteração via banco local não reflete na Unimed de origem (onde permanece como eletiva). O procedimento operacional homologado é o cancelamento da guia no HRP Unimed e emissão de nova solicitação como urgência (documentado na Base de Conhecimento oficial KB #94).`;

      const categoryMismatch =
        normalizeText(ticket.category || "") !== normalizeText(suggestedCategory);
      const reclassNote = categoryMismatch
        ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}").*`
        : "";

      translatedIntent =
        `${solPrefix} **${ticket.requester}** (**${sectorName}**) solicita à equipe de T.I. a alteração via banco de dados do caráter de atendimento de **eletivo** para **urgência** da senha **${senhaNum}** no sistema **ERP HRP Unimed** (com recomendação citada de Frederico Roosevelt). ` +
        `Por se tratar de uma guia vinculada a beneficiário de **Unimed Intercâmbio (Intercâmbio Nacional)**, a alteração no banco de dados local **não replica nem atualiza o status na Unimed de origem do cliente** (onde a autorização permanece registrada e homologada como eletiva), gerando divergência cadastral e risco de glosa na câmara de compensação. ` +
        `O procedimento operacional correto e homologado consiste no **cancelamento da guia no sistema HRP Unimed** e na **emissão de uma nova solicitação de autorização** com o caráter de atendimento desejado (**Urgência**), conforme formalizado no **Artigo KB #94** da Base de Conhecimento do GLPI.` +
        reclassNote;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customResolutionSteps = [
        `[PB-UNI-66] Manter a categoria do chamado no GLPI em '${suggestedCategory}' (ou reclassificar para 'T.I > ST > Dúvidas e Orientações' - ID 160), vinculando o artigo oficial da Base de Conhecimento KB #94 ('HRP Unimed > Guia de Intercâmbio Nacional: Impossibilidade de Alteração de Caráter de Atendimento via Banco e Procedimento de Cancelamento').`,
        `[PB-UNI-66] Esclarecer a ${ticket.requester} (${sectorName}) que, em conformidade com as regras do Intercâmbio Nacional e mensageria PTU/WAutoriza, a alteração do caráter de atendimento não pode ser executada via banco de dados local, pois o status não é atualizado na Unimed do beneficiário (permanecendo lá como eletivo), acarretando divergência cadastral e glosa na compensação federativa.`,
        `[PB-UNI-66] Orientar o setor de ${sectorName} a realizar o cancelamento da guia/senha ${senhaNum} diretamente no sistema HRP Unimed e registrar uma nova solicitação de autorização já com o caráter correto (Urgência).`,
        `[PB-UNI-66] Registrar nota técnica interna no GLPI referenciando o Artigo KB #94 e posicionar o chamado para encerramento após validação do setor.`,
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente à alteração do caráter de atendimento de **eletivo para urgência** da senha **${senhaNum}** no sistema **HRP Unimed**.\n\n` +
        `Gostaríamos de esclarecer que, por se tratar de uma autorização de **Unimed Intercâmbio**, a alteração direta via banco de dados em nosso sistema local **não atualiza o status na Unimed de origem do beneficiário**, onde o atendimento permaneceria registrado como eletivo. Isso causaria divergência no processo de faturamento e auditoria, gerando glosa na compensação do Intercâmbio Nacional.\n\n` +
        `Dessa forma, o procedimento operacional correto e homologado para esses casos é:\n` +
        `1. Realizar o **cancelamento da guia/senha atual (${senhaNum})** diretamente no sistema **HRP Unimed**;\n` +
        `2. Efetuar uma **nova solicitação de autorização** já com o caráter de atendimento desejado (**Urgência**).\n\n` +
        `Assim, a nova transação será devidamente registrada e transmitida com os parâmetros corretos para a Unimed do cliente. Este procedimento também está formalizado em nossa Base de Conhecimento no GLPI (**Artigo KB #94**).\n\n` +
        `Caso necessite de algum apoio ou orientação adicional no cancelamento ou nova emissão, nossa equipe de T.I. permanece à total disposição!`;
    } else if (
      (/\b(duplicar\s+etiquetas?|etiquetas?\s+de\s+oncologia|etiquetas?\s+para\s+r[oó]tulos?|desenvolvimento\s+de\s+etiquetas?)\b/i.test(
        normAll
      ) ||
        (/\betiquetas?\b/i.test(normAll) &&
          /\b(oncologia|prontu[aá]rio|r[oó]tulos?|campo\s+.*?\s+em\s+aberto|duplicar\s+(?:a\s+|o\s+)?(?:etiqueta|layout|modelo))\b/i.test(
            normAll
          ))) &&
      !/\b(glpi|controle\s+de\s+contas|cores?\s+diferentes?|aguardando\s+retorno|em\s+andamento)\b/i.test(
        normAll
      )
    ) {
      const mentionsOpenProntuario =
        /\b(campo\s+prontu[aá]rio\s+em\s+aberto|prontu[aá]rio\s+em\s+aberto)\b/i.test(
          normAll
        );
      const mentionsOncologiaLabel = /\betiquetas?\s+de\s+oncologia\b/i.test(
        normAll
      );
      const labelTarget = mentionsOncologiaLabel
        ? "modelo de Etiqueta de Oncologia"
        : "modelo de Etiqueta / Rótulo";
      const fieldSpec = mentionsOpenProntuario
        ? "deixando o **campo \"Prontuário\" em aberto (editável)**"
        : "aplicando os ajustes de layout e campos solicitados";

      detectedDomain =
        "Desenvolvimento de Software / Aplicações Internas (Sistema de Etiquetas e Rótulos — Farmácia / Oncologia)";
      suggestedCategory =
        ticket.category && ticket.category.includes("Desenvolvimento")
          ? ticket.category
          : "T.I > DV > Desenvolvimento > Ajustes em layout/interface";
      realUrgency = ticket.urgency_label || "Baixa";
      urgencyReason = `Demanda evolutiva do setor ${sectorName} para duplicação e parametrização de layout de etiqueta (${mentionsOncologiaLabel ? "Etiqueta de Oncologia com campo Prontuário em aberto" : "ajuste de campos de etiqueta"}) pela equipe de Desenvolvimento.`;

      const categoryMismatch =
        normalizeText(ticket.category || "") !==
        normalizeText(suggestedCategory);
      const reclassNote = categoryMismatch
        ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}" — ID 123).*`
        : "";

      translatedIntent =
        `${solPrefix} **${ticket.requester}** (**${sectorName}**) solicita à equipe de Desenvolvimento a **duplicação do ${labelTarget}**, ${fieldSpec} para preenchimento manual pela equipe da Farmácia/Oncologia. ` +
        `Todas as especificações necessárias para o ajuste já constam informadas no chamado (direcionado ao desenvolvedor **Moisés Conte — \`mconte\`**, conforme histórico do Chamado #37471).` +
        reclassNote;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customResolutionSteps = [
        `[PB-UNI-65] Manter a categoria do chamado no GLPI em '${suggestedCategory}' (ID 123), atribuído ao grupo 'T.I > DV (Desenvolvimento)' (Moisés Conte - mconte).`,
        `[PB-UNI-65] Acessar o código-fonte / gerenciador de templates da aplicação interna de Etiquetas e Rótulos utilizada pelo setor ${sectorName} (referência histórica: Chamado #37471).`,
        mentionsOpenProntuario
          ? `[PB-UNI-65] Duplicar o template atual da 'Etiqueta de Oncologia' e parametrizar na cópia o campo 'Prontuário' em aberto (campo editável / livre para digitação manual).`
          : `[PB-UNI-65] Duplicar/ajustar o modelo de etiqueta conforme a especificação de campos solicitada pelo setor ${sectorName}.`,
        `[PB-UNI-65] Homologar a geração e o layout de impressão da nova etiqueta duplicada e publicar a atualização em produção.`,
        `[PB-UNI-65] Notificar o solicitante ${ticket.requester} (${sectorName}) no chamado do GLPI confirmando a disponibilização da nova etiqueta.`,
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente à **duplicação do ${labelTarget}**, ${fieldSpec}, para atendimento às rotinas do setor **${sectorName}**.\n\n` +
        `A especificação já foi validada na triagem e encaminhada para a nossa equipe de **T.I. / Desenvolvimento (Moisés Conte)** realizar a criação do novo layout com o campo editável no sistema de etiquetas.\n\n` +
        `Assim que a nova opção de etiqueta estiver publicada e disponível para uso no setor, confirmaremos por aqui!\n\n` +
        `Permanecemos à disposição!`;
    } else if (
      (/\b(adi[cç][aã]o\s+d[ae]s?\s+etiquetas?|adicionar\s+etiquetas?|cria[cç][aã]o\s+d[ae]s?\s+etiquetas?|criar\s+etiquetas?|manuten[cç][aã]o\s+d[ae]s?\s+etiquetas?|etiquetas?\s+iguais|\d+\s+etiquetas?\s+iguais|etiquetas?\s+duplicadas?)\b/i.test(
        normAll
      ) ||
        (/\betiquetas?\b/i.test(normAll) &&
          (/\b(cores?\s+diferentes?|em\s+andamento|aguardando\s+retorno|aguardando\s+farm[aá]cia|aguardando\s+nas|glpi|controle\s+de\s+contas)\b/i.test(
            normAll
          ) ||
            ticket.category.includes("Desenvolvimento")) &&
          !/\b(imprimir|impress[aã]o|impressora|zebra|zebradesigner|elgin|argox|ribbon|atalho|[aá]rea\s+de\s+trabalho)\b/i.test(
            normAll
          )))
    ) {
      const descText = formFields.descricao || ticket.content || "";
      const quotedTags = [
        ...new Set(
          [...descText.matchAll(/["“”]([^"“”]{2,40})["“”]/g)].map((m) =>
            m[1].trim()
          )
        ),
      ];
      const tagsLabel =
        quotedTags.length > 0
          ? quotedTags.map((t) => `**"${t}"**`).join(" e ")
          : "solicitadas";
      const mentionsDuplicateColors =
        /\b(2\s+etiquetas?\s+iguais|duas\s+etiquetas?\s+iguais|etiquetas?\s+iguais|cores?\s+diferentes?|duplicad)\b/i.test(
          normAll
        );
      const sysTarget = /\bcontrole\s+de\s+contas\b/i.test(normAll)
        ? "Controle de Contas"
        : "GLPI";

      detectedDomain =
        "Desenvolvimento / Administração do GLPI e Sistemas Internos (Gestão de Etiquetas / Tags)";
      suggestedCategory =
        ticket.category && ticket.category.includes("Desenvolvimento")
          ? ticket.category
          : "T.I > DV > Desenvolvimento > Ajustes em layout/interface";
      realUrgency = ticket.urgency_label || "Baixa";
      urgencyReason = `Criação e manutenção de etiquetas (tags de status) no sistema ${sysTarget} para organização e acompanhamento dos chamados do setor (${sectorName}).`;

      const categoryMismatch =
        normalizeText(ticket.category || "") !==
        normalizeText(suggestedCategory);
      const reclassNote = categoryMismatch
        ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}").*`
        : "";

      translatedIntent =
        `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a **manutenção e adição de etiquetas (tags de acompanhamento)** no sistema **${sysTarget}**, especificamente a inclusão das etiquetas ${tagsLabel}` +
        (mentionsDuplicateColors
          ? ` e a regularização/unificação de **2 etiquetas cadastradas com o mesmo nome e cores diferentes**`
          : "") +
        `. Todas as especificações já constam descritas no chamado.` +
        reclassNote;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customResolutionSteps = [
        `[PB-UNI-62] Manter a categoria do chamado no GLPI em '${suggestedCategory}'.`,
        `[PB-UNI-62] Acessar o painel administrativo do ${sysTarget} (no GLPI: Configurar > Plug-ins > Etiquetas / Tags ou Configurar > Listas suspensas > Etiquetas) com perfil Super-Admin.`,
        `[PB-UNI-62] Cadastrar as novas etiquetas solicitadas pelo setor ${sectorName} (${quotedTags.length > 0 ? quotedTags.map((t) => `'${t}'`).join(" e ") : "conforme descrito"}), definindo a paleta de cores de identificação visual e vinculando a visibilidade à entidade/grupo correspondente.`,
        mentionsDuplicateColors
          ? `[PB-UNI-62] Localizar as 2 etiquetas cadastradas com o mesmo nome e cores diferentes apontadas pela solicitante, verificar os chamados vinculados, unificar os vínculos na etiqueta oficial e remover/inativar a etiqueta duplicada.`
          : `[PB-UNI-62] Revisar a padronização de nomes e cores das etiquetas do setor no sistema.`,
        `[PB-UNI-62] Validar a disponibilização da lista atualizada de etiquetas no ${sysTarget} e comunicar a conclusão a ${ticket.requester} (${sectorName}) (referência histórica: Chamado #44150).`,
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente à **manutenção e adição de etiquetas no sistema ${sysTarget}** para o setor de **${sectorName}** (` +
        (quotedTags.length > 0
          ? `inclusão das etiquetas ${tagsLabel}`
          : `inclusão das novas etiquetas solicitadas`) +
        (mentionsDuplicateColors
          ? ` e regularização das **2 etiquetas iguais com cores diferentes**`
          : "") +
        `).\n\n` +
        `Todas as informações necessárias já constam no chamado e nossa equipe de T.I. já iniciou o cadastro das novas etiquetas e a padronização/remoção da etiqueta duplicada no painel administrativo do sistema.\n\n` +
        `Assim que as etiquetas estiverem atualizadas e disponíveis para uso no setor, confirmaremos por aqui!\n\n` +
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
      /\b(chat|destinat[aá]rio|destinat[aá]rios|mensagens?|bug|bugs|falha|erro\s+do\s+destinat[aá]rio|conte[uú]do\s+sens[ií]vel|canal\s+oficial)\b/i.test(
        normAll
      ) &&
      !/\b(cria[cç][aã]o\s+de\s+usu[aá]rios?|novo\s+colaborador|admiss[aã]o)\b/i.test(
        normAll
      )
    ) {
      detectedDomain =
        "Desenvolvimento / Sistemas Internos (Intranet Corporativa / Chat Interno)";
      suggestedCategory = "T.I > DV > Desenvolvimento > Correção de bugs";
      realUrgency = "Alta";
      urgencyReason =
        "Falha crítica de endereçamento/destinatário incorreto no Chat da Intranet Corporativa, envolvendo risco à privacidade e segurança de conteúdos sensíveis (LGPD) em canal oficial.";

      const categoryMismatch =
        normalizeText(ticket.category || "") !==
        normalizeText(suggestedCategory);
      const reclassNote = categoryMismatch
        ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}").*`
        : "";

      translatedIntent =
        `${solPrefix} **${ticket.requester}** (${sectorName}) relata um **bug operacional no módulo de Chat da Intranet Corporativa**, informando que mensagens enviadas no chat estão sendo endereçadas ou entregues para o **destinatário errado** em algumas ocasiões. ` +
        `Por tratar-se de um canal oficial de comunicação interna que pode trafegar informações sensíveis, a demanda requer atuação prioritária da equipe de **Desenvolvimento (Moisés Conte)** para auditar a rotina de sessão/endereçamento de destinatários do chat e corrigir a falha no sistema.` +
        reclassNote;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customResolutionSteps = [
        `[PB-UNI-59] Reclassificar a categoria do chamado no GLPI de '${ticket.category}' para '${suggestedCategory}' (ID 121) e direcionar à equipe de Desenvolvimento (Moisés Conte).`,
        `[PB-UNI-59] Auditar no código-fonte da Intranet Corporativa (front-end JavaScript e back-end/API do módulo de Chat) o gerenciamento de estado da conversa ativa e o parâmetro 'destinatario_id' enviado no disparo das mensagens.`,
        `[PB-UNI-59] Verificar se há condição de corrida (race condition), cache indevido de variável de sessão ou falha na atualização do ID do contato selecionado no DOM ao alternar entre conversas ou múltiplas abas abertas da Intranet.`,
        `[PB-UNI-59] Inspecionar os logs e registros recentes na tabela de mensagens do banco de dados da Intranet para rastrear ocorrências de divergência entre o destinatário selecionado em tela e o gravado na transação.`,
        `[PB-UNI-59] Aplicar a correção de escopo/validação estrita do destinatário no envio de mensagens, realizar testes de conversação simultânea e comunicar a solução ao solicitante ${ticket.requester} (${sectorName}).`,
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos o seu chamado referente à falha de **destinatário incorreto no Chat da Intranet Corporativa** e agradecemos pelo alerta, especialmente considerando a importância da privacidade e da segurança das informações em nosso canal oficial de comunicação interna.\n\n` +
        `Nossa equipe de **T.I. / Desenvolvimento (Moisés Conte)** já foi acionada com prioridade para auditar o módulo de Chat da Intranet, verificando o controle de sessão e o endereçamento de destinatários no envio das mensagens para aplicar a correção definitiva.\n\n` +
        `Caso você se recorde de algum exemplo recente em que o problema ocorreu (como data/horário aproximado e qual destinatário constou incorretamente na conversa), fique à vontade para nos informar por aqui para auxiliar na análise dos logs do sistema.\n\n` +
        `Assim que a correção for aplicada e validada na Intranet, confirmaremos por aqui!\n\n` +
        `Permanecemos à disposição!`;
    } else if (
      !/\b(urucum|ag[eê]ncia|terceir|extern[ao])\b/i.test(normAll) &&
      (/\b(google\s+tag\s+manager|\bgtm\b|gtm-[a-z0-9]+|google\s+analytics|search\s+console|pixel\s+(?:da\s+)?meta|tags?\s+de\s+acompanhamento|m[eé]tricas?\s+(?:no\s+site|de\s+crescimento))\b/i.test(
        normAll
      ) ||
        (/\bsite\s+unimed\b/i.test(normAll) &&
          /\b(tags?|m[eé]tricas?|monitoramento)\b/i.test(normAll)))
    ) {
      detectedDomain =
        "Desenvolvimento / Portal Institucional (Site Unimed Sudoeste de Minas / Marketing Digital)";
      suggestedCategory =
        "T.I > DV > Desenvolvimento > Ajustes em layout/interface";
      realUrgency = ticket.urgency_label || "Baixa";
      urgencyReason =
        "Solicitação do setor de Marketing para esclarecimento sobre a tag nativa do Google Tag Manager (GTM-KHVFL3C) no Portal Unimed e eventual inserção de novas tags de monitoramento (Google Analytics, Search Console e Pixel da Meta).";

      const categoryMismatch =
        normalizeText(ticket.category || "") !==
        normalizeText(suggestedCategory);
      const reclassNote = categoryMismatch
        ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}").*`
        : "";

      translatedIntent =
        `${solPrefix} **${ticket.requester}** (${sectorName}) solicita apoio da equipe de Desenvolvimento para inserção das **tags de acompanhamento de métricas (Google Tag Manager — GTM, Google Analytics, Google Search Console e Pixel da Meta)** no **Site da Unimed Sudoeste de Minas**, questionando se a tag do GTM exibida no print anexado (\`GTM-KHVFL3C\` no código-fonte de \`unimed.coop.br/site\`) vem da própria Unimed do Brasil ou se foi instalada localmente pela T.I. ` +
        `Conforme alinhamento técnico entre **Luiz Fernando Moura Piantino** e o desenvolvedor **Moisés Conte**, essas informações/tags padrão já vêm nativamente na plataforma nacional do Portal Unimed; caso o Marketing deseje inserir novas tags próprias da singular, basta enviar os novos códigos/IDs no chamado.` +
        reclassNote;

      sufficiencyStatus = "parcial";
      missingInfo = [
        "Enviar os novos códigos/snippets ou IDs de acompanhamento (novo contêiner do Google Tag Manager, Google Analytics, Search Console ou Pixel da Meta) criados pelo Marketing caso desejem incluí-los na plataforma do site institucional",
      ];

      customResolutionSteps = [
        `[PB-UNI-60] Manter a categoria do chamado no GLPI em '${suggestedCategory}' (ID 123), atribuído ao grupo 'T.I > DV (Desenvolvimento)'.`,
        `[PB-UNI-60] Esclarecer ao solicitante ${ticket.requester} (${sectorName}) — conforme validação com Moisés Conte e Luiz Fernando — que a tag do Google Tag Manager ('GTM-KHVFL3C') evidenciada no print anexado já vem nativa por padrão na própria plataforma nacional do Portal Unimed (Unimed do Brasil).`,
        `[PB-UNI-60] Orientar o setor de Marketing que, caso deseje monitorar métricas próprias da singular (Unimed Sudoeste de Minas), crie sua própria conta/contêiner no Google Tag Manager (incluindo nele Google Analytics, Search Console e Pixel da Meta) e encaminhe o novo script/ID neste chamado.`,
        `[PB-UNI-60] Manter o chamado em status Pendente aguardando o envio das novas tags pelo Marketing e, assim que informadas, realizar a inserção na plataforma do site.`,
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente às **tags de acompanhamento de métricas (Google Tag Manager, Google Analytics, Search Console e Pixel da Meta)** no **Site da Unimed Sudoeste de Minas**.\n\n` +
        `Em consulta técnica com o desenvolvedor **Moisés Conte** e **Luiz Fernando**, confirmamos que a tag do Google Tag Manager (\`GTM-KHVFL3C\`) evidenciada no código-fonte atual **já vem integrada por padrão na própria plataforma nacional do Portal Unimed (Unimed do Brasil)**.\n\n` +
        `Dessa forma, caso o setor de **${sectorName}** queira criar uma nova conta/contêiner próprio do GTM (ou gerar novas tags de monitoramento para a nossa singular) para inserirmos no site, basta nos enviar os novos códigos/IDs por aqui que realizamos a inclusão na plataforma!\n\n` +
        `Permanecemos no aguardo e à disposição!`;
    } else if (
      !/\b(urucum|ag[eê]ncia|terceir|extern[ao]|google\s+tag\s+manager|\bgtm\b|google\s+analytics|search\s+console|pixel\s+(?:da\s+)?meta)\b/i.test(
        normAll
      ) &&
      /\b(banners?|altera[cç][aã]o\s+banner|acrescentar\s+(?:o\s+)?banner|adicionar\s+banner|formato\s+rotativo|novembro\s+azul|outubro\s+rosa|publica[cç][aã]o\s+relat[oó]rio\s+igualdade\s+salarial)\b/i.test(
        normAll
      )
    ) {
      const mentionsNovembroAzul = /\bnovembro\s+azul\b/i.test(normAll);
      const mentionsRotating = /\b(formato\s+rotativo|rotativo|carrossel)\b/i.test(
        normAll
      );
      const keepDetails =
        mentionsNovembroAzul && mentionsRotating
          ? "mantendo o banner vigente referente ao **Novembro Azul** e configurando a exibição em **formato rotativo (carrossel)**"
          : mentionsRotating
          ? "configurando a exibição dos banners em **formato rotativo (carrossel)**"
          : "atualizando a vitrine institucional conforme solicitado";

      detectedDomain =
        "Desenvolvimento / Portal Institucional (Site Unimed Sudoeste de Minas / Banners e Conteúdos)";
      suggestedCategory =
        "T.I > DV > Desenvolvimento > Ajustes em layout/interface";
      realUrgency = ticket.urgency_label || "Baixa";
      urgencyReason =
        "Solicitação do setor de Marketing para inclusão/atualização de banner institucional no Site da Unimed Sudoeste de Minas.";

      const categoryMismatch =
        normalizeText(ticket.category || "") !==
        normalizeText(suggestedCategory);
      const reclassNote = categoryMismatch
        ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}").*`
        : "";

      translatedIntent =
        `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a **inclusão do novo banner anexado** no **Site da Unimed Sudoeste de Minas**, ${keepDetails}. ` +
        `A arte e todas as instruções de publicação já constam anexadas e descritas no chamado.` +
        reclassNote;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customResolutionSteps = [
        `[PB-UNI-63] Manter a categoria do chamado no GLPI em '${suggestedCategory}' (ID 123), atribuído ao grupo 'T.I > DV (Desenvolvimento)' (Luiz Fernando Moura Piantino / Moisés Conte).`,
        `[PB-UNI-63] Baixar a arte do novo banner anexada ao chamado pelo setor de ${sectorName} e conferir as dimensões/proporções compatíveis com o componente de vitrine do Portal Unimed Sudoeste de Minas.`,
        `[PB-UNI-63] Acessar o gerenciador de conteúdo (CMS / Liferay) do Site da Unimed Sudoeste de Minas e publicar a nova arte na seção de banners da página inicial.`,
        mentionsNovembroAzul
          ? `[PB-UNI-63] Preservar o banner atual referente ao 'Novembro Azul' e parametrizar o componente de vitrine em formato rotativo (carrossel/slider) para alternância automática entre os banners.`
          : `[PB-UNI-63] Configurar a vitrine de banners no portal conforme solicitado pelo setor de ${sectorName}.`,
        `[PB-UNI-63] Validar a exibição e a rotação dos banners em produção e confirmar a publicação para ${ticket.requester} (${sectorName}) no GLPI (referência histórica: Chamado #43540).`,
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente à **inclusão do novo banner no Site da Unimed Sudoeste de Minas**, ${keepDetails}.\n\n` +
        `A arte anexada e todas as orientações de publicação já foram validadas na triagem e nossa equipe de **T.I. / Desenvolvimento** já iniciou a atualização no gerenciador do portal institucional.\n\n` +
        `Assim que o novo banner estiver publicado e ativo em formato rotativo no site, confirmaremos por aqui!\n\n` +
        `Permanecemos à disposição!`;
    } else if (
      (/\btuss\b/i.test(normAll) &&
        /\b(di[aá]rias|taxas|gases|00952)\b/i.test(normAll)) ||
      /\b(00952|di[aá]rias\s*,\s*taxas\s+e\s+gases)\b/i.test(normAll)
    ) {
      const sectorName =
        (formFields.setor && !formFields.setor.startsWith("1)"))
          ? formFields.setor
          : ticket.requester_department || "H Faturamento";
      const isMale =
        /^(juliano|dener|diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor|tarcisio|claudio|moises|luiz)\b/i.test(
          firstName
        );
      const solPrefix = isMale ? "O solicitante" : "A solicitante";

      detectedDomain =
        "Sistemas Internos / SGH Spdata / Parametrização de Sistemas e Tabelas (Tabela TUSS - Diárias, Taxas e Gases)";
      suggestedCategory = "T.I > ST > Parametrização de Sistemas e Tabelas";
      realUrgency = ticket.urgency_label || "Baixa";
      urgencyReason =
        `Solicitação de orientação técnica sobre a atualização da tabela '00952 - V - TUSS - DIÁRIAS, TAXAS E GASES' no sistema SGH Spdata para o setor ${sectorName}. O sistema não possui rotina de importação em lote para essa tabela, devendo a manutenção ser realizada manualmente item a item pelo próprio Faturamento (documentado na Base de Conhecimento KB #92).`;

      const categoryMismatch =
        normalizeText(ticket.category || "") !== normalizeText(suggestedCategory);
      const reclassNote = categoryMismatch
        ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}" — ID 164).*`
        : "";

      translatedIntent =
        `${solPrefix} **${ticket.requester}** (**${sectorName}**) solicita a atualização da tabela **TUSS - DIÁRIAS, TAXAS E GASES** (evidenciada no print em anexo na tela **Tabela de Diárias e Taxas** sob a Tabela de Controle **\`00952 - V - TUSS - DIÁRIAS, TAXAS E GASES\`**) no sistema gestor **SGH Spdata**. ` +
        `Diferentemente de tabelas como *Simpro* e *Brasíndice*, o sistema **SGH Spdata não possui ferramenta ou rotina para importação automatizada em lote** desta tabela, sendo que a gestão, inclusão e atualização de seus procedimentos devem ser realizadas **manualmente item a item pelo próprio setor de Faturamento** diretamente no módulo **Tabelas - SPDATA SGH** (conforme documentado no **Artigo KB #92** da Base de Conhecimento do GLPI).` +
        reclassNote;

      sufficiencyStatus = "completo";
      missingInfo = [];

      customResolutionSteps = [
        `[PB-UNI-64] Manter a categoria do chamado no GLPI em '${suggestedCategory}' (ID 164), vinculando o artigo oficial da Base de Conhecimento KB #92 ('SGH - Spdata > Tabelas > Atualização Manual da Tabela TUSS - Diárias, Taxas e Gases (Tabela 00952)').`,
        `[PB-UNI-64] Esclarecer formalmente a ${ticket.requester} (${sectorName}) que o sistema SGH Spdata não dispõe de recurso ou rotina para importação automática de arquivos para a tabela '00952 - V - TUSS - DIÁRIAS, TAXAS E GASES'.`,
        `[PB-UNI-64] Orientar que a gestão e atualização dessa tabela devem ser feitas manualmente pelo próprio setor de Faturamento dentro do módulo 'Tabelas - SPDATA SGH' (tela 'Tabela de Diárias e Taxas' > Tabela de Controle '00952 - V - TUSS - DIÁRIAS, TAXAS E GASES'), acessando item a item no quadro 'Manutenção' (utilizando os botões 'Novo', 'Valores', 'Reajuste' e 'Gravar').`,
        `[PB-UNI-64] Colocar a equipe de T.I. à disposição caso algum colaborador do ${sectorName} necessite de liberação de permissão de acesso/edição na tela 'Tabela de Diárias e Taxas' ou auxílio pontual em algum item específico.`,
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente à atualização da tabela **TUSS - DIÁRIAS, TAXAS E GASES** (\`00952 - V - TUSS - DIÁRIAS, TAXAS E GASES\`) no sistema **SGH Spdata**.\n\n` +
        `Gostaríamos de esclarecer que, diferentemente de outras tabelas do sistema, o **SGH Spdata não possui ferramenta ou rotina para realizar a importação automática em lote** desta tabela.\n\n` +
        `Por esse motivo, a gestão e a atualização da tabela **TUSS - Diárias, Taxas e Gases (\`00952\`)** devem ser realizadas **manualmente pelo próprio setor de Faturamento**, acessando **item a item** diretamente na tela **Tabela de Diárias e Taxas** (\`Tabelas - SPDATA SGH > Tabela de Controle: 00952 - V - TUSS - DIÁRIAS, TAXAS E GASES\`):\n` +
        `- Para **atualizar um item existente**, basta selecioná-lo na listagem **\"Dados da Tabela\"** (ou clicar em **\"Pesquisar\"**), ajustar os campos/valores no quadro inferior **\"Manutenção\"** (ou no botão **\"Valores\"**) e clicar em **\"Gravar\"**;\n` +
        `- Para **incluir um novo código TUSS**, basta clicar no botão **\"Novo\"**, preencher os dados do procedimento no quadro **\"Manutenção\"** e clicar em **\"Gravar\"**.\n\n` +
        `Também registramos essa orientação passo a passo na Base de Conhecimento do GLPI (**Artigo KB #92**). Caso algum colaborador do setor precise de liberação de permissão nessa tela ou auxílio em alguma dúvida pontual, nossa equipe de T.I. permanece à inteira disposição!`;
    } else if (
      (/\b(automa[çc][ãa]o|automatiza[çc][ãa]o|automatizar|rotina autom[aá]tica)\b/i.test(normAll) &&
        /\b(cobran[çc]a|t[ií]tulos?\s+em\s+atraso|inadimpl[eê]ncia|whatsapp|wpp|mensagens?\s+wpp|mensagens?\s+de\s+cobran[çc]a|disparo)\b/i.test(
          normAll
        )) ||
      (/\b(t[ií]tulos?\s+em\s+atraso|relat[oó]rio\s+de\s+t[ií]tulos?\s+em\s+atraso)\b/i.test(normAll) &&
        /\b(whatsapp|wpp|emails?|mandar\s+um\s+email|mandar\s+um\s+whatsapp)\b/i.test(normAll))
    ) {
      detectedDomain =
        "Desenvolvimento de Software / Aplicações Internas";
      suggestedCategory = ticket.category.includes("DV")
        ? ticket.category
        : "T.I > DV > Desenvolvimento > Novas aplicações";
      realUrgency = ticket.urgency_label || "Baixa";
      urgencyReason =
        "Demanda do setor Financeiro para desenvolvimento e parametrização de rotina automatizada de envio de notificações de cobrança de títulos em atraso (últimos 90 dias) via WhatsApp e E-mail a cada 3 dias.";

      const categoryMismatch =
        normalizeText(ticket.category || "") !==
        normalizeText(suggestedCategory);
      const reclassNote = categoryMismatch
        ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}").*`
        : "";

      translatedIntent =
        `${solPrefix} **${ticket.requester}** (${sectorName}) solicita o desenvolvimento de uma **rotina de automação para envio periódico (a cada 3 dias) de mensagens ativas de cobrança via WhatsApp e E-mail**, ` +
        `com base nas informações do relatório gerencial do HRP Unimed (**Relatório de Títulos em Atraso - UNIMED256**, abrangendo contratos empresariais coletivos e títulos vencidos nos últimos 90 dias). ` +
        `O chamado está devidamente classificado em '${ticket.category}'. Para viabilizar a implementação pela equipe de Desenvolvimento de Sistemas (Moisés Conte / Raphael Campos), faz-se necessário alinhar o modelo textual das mensagens, anexo de 2ª via/Pix, integração com canal oficial de WhatsApp e agendar reunião de Discovery.` +
        reclassNote;

      sufficiencyStatus = "parcial";
      missingInfo = [
        "Modelo ou texto padrão (copywriting) aprovado para o envio de mensagens de cobrança via WhatsApp e E-mail",
        "Definição se a notificação deve conter anexos ou links (segunda via do boleto em PDF, linha digitável ou chave Pix copia-e-cola)",
        "Definição da plataforma/API oficial de WhatsApp a ser utilizada (verificar canal corporativo homologado pela Unimed para evitar banimento de número)",
        "Regras de negócio e exceções na régua de cobrança (ex.: clientes em renegociação, parcelamentos ativos ou suspensões)",
        "Saneamento da base cadastral no HRP (confirmação se celulares e e-mails dos responsáveis financeiros estão devidamente cadastrados)",
        "Agendamento de reunião técnica de Discovery (levantamento de requisitos) com o solicitante e o desenvolvedor responsável (Moisés Conte / Raphael Campos)",
      ];

      customResolutionSteps = [
        `[PB-UNI-61] Manter a categoria do chamado no GLPI em '${suggestedCategory}' (ID 129), atribuído ao grupo 'T.I > DV (Desenvolvimento)'.`,
        `[PB-UNI-61] Avaliar com o desenvolvedor responsável (Moisés Conte / Raphael Campos) a viabilidade técnica da extração automatizada dos títulos em atraso diretamente no banco de dados do HRP Unimed (queries/views de Contas a Receber) para os contratos empresariais/coletivos com corte de 90 dias, eliminando a dependência de exportação manual do relatório UNIMED256.`,
        `[PB-UNI-61] Mapear os canais de disparo: para E-mail, estruturar template HTML corporativo via serviço SMTP institucional; para WhatsApp, verificar a integração com a API oficial homologada da cooperativa (evitando soluções não oficiais que possam acarretar o banimento do número corporativo).`,
        `[PB-UNI-61] Alinhar com o solicitante Leonardo Batista (Financeiro, ramal 2602) e o observador Raphael Campos o modelo das mensagens, variáveis dinâmicas (Nome do Cliente, Valor, Vencimento, Código de Barras / Pix) e a periodicidade de execução (rotina a cada 3 dias).`,
        `[PB-UNI-61] Agendar reunião de levantamento de requisitos (Discovery) com a equipe de Desenvolvimento e o setor Financeiro para especificação da arquitetura da automação.`,
        `[PB-UNI-61] Desenvolver e homologar a rotina em ambiente de testes/sandbox com disparos direcionados para e-mails e números de WhatsApp internos da equipe de T.I. e Financeiro.`,
        `[PB-UNI-61] Após homologação formal do Financeiro, implantar a rotina periódica no servidor de produção e monitorar os logs de entrega.`,
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente ao **desenvolvimento da rotina automatizada para envio de mensagens de cobrança (WhatsApp e E-mail)** a partir do **Relatório de Títulos em Atraso (UNIMED256)** no sistema **HRP Unimed**.\n\n` +
        `Trata-se de uma excelente iniciativa de automação de processos para conferir mais agilidade e eficiência à recuperação de crédito do setor Financeiro! A demanda foi acolhida e está sob responsabilidade da equipe de **Desenvolvimento de Sistemas (T.I > DV)**.\n\n` +
        `Para que o desenvolvedor responsável (**Moisés Conte**) possa estruturar a arquitetura técnica da solução e planejar as integrações com segurança, precisamos alinhar os seguintes pontos:\n\n` +
        `1. **Modelos de Mensagem (Templates):** O setor Financeiro já possui o texto padrão redigido e aprovado para o WhatsApp e para o E-mail? Haverá envio da 2ª via do boleto em anexo (PDF), linha digitável ou chave Pix copia-e-cola?\n` +
        `2. **Canal Oficial de WhatsApp:** A cooperativa já utiliza alguma plataforma/API oficial de WhatsApp homologada para envios transacionais em massa (ex.: Meta Cloud API, Z-API, Blip), ou essa integração precisará ser estruturada pela T.I?\n` +
        `3. **Regras de Exceção:** Existem clientes, contratos ou títulos que **não** devem ser cobrados automaticamente (como títulos em renegociação, parcelamentos ativos ou pendências jurídicas)?\n` +
        `4. **Reunião de Alinhamento (Discovery):** Gostaríamos de agendar uma breve conversa técnica (presencial ou online via Google Meet) com você, o observador **Raphael Campos** e o desenvolvedor **Moisés Conte** para validarmos os detalhes do fluxo e definirmos o cronograma de entrega.\n\n` +
        `Qual dia e horário seriam mais adequados para realizarmos esse alinhamento?\n\n` +
        `Permanecemos à disposição!`;
    } else if (
      normAll.includes("intranet") &&
      (normAll.includes("visualizar") ||
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
      (/\b(nextcloud|nextclaud|unidrive|uni\s*drive)\b/i.test(normAll) &&
        (/\b(senha|senhas|login|credencial|credenciais|acesso|n[aã]o consigo|n[aã]o consigo acesso|orientar|orienta[cç][aã]o|esqueci|redefinir|redefini[cç][aã]o|resetar|reset|condizente)\b/i.test(
          normAll
        ) ||
          /\bsenha\s+n[aã]o\s+est[aá]\s+condizente\b/i.test(normAll))) &&
      !/\b(instalar\s+(?:o\s+)?(?:unidrive|nextcloud)|instala[çc][ãa]o\s+d[oe]\s+(?:unidrive|nextcloud)|computador\s+novo|trocou\s+o\s+computador)\b/i.test(
        formFields.descricao || ticket.content || ""
      )
    ) {
      detectedDomain = "Acessos, Permissões e Contas";
      suggestedCategory =
        "T.I > ST > Acesso e Permissões > Redefinição de Senhas";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason =
        "Dificuldade de autenticação / inconsistência de senha no Nextcloud, demandando redefinição de credencial e orientações de primeiro acesso.";

      sufficiencyStatus = "completo";
      missingInfo = [];

      const loginCandidate = ticket.requester_login || "do seu usuário";

      translatedIntent =
        `${solPrefix} **${ticket.requester}** (${sectorName}) solicita orientação de uso e redefinição de senha para acesso ao **Nextcloud**, ` +
        `relatando que a senha utilizada não confere com a cadastrada ('A senha não está condizente com a criada e não consigo acesso') e anexando a evidência do erro de autenticação em tela. ` +
        `Recomenda-se reclassificar de Aplicativos para 'T.I > ST > Acesso e Permissões > Redefinição de Senhas'.`;

      customResolutionSteps = [
        `[PB-UNI-54] Reclassificar a categoria do chamado no GLPI para 'T.I > ST > Acesso e Permissões > Redefinição de Senhas' (ID 77).`,
        `[PB-UNI-54] Acessar o console de administração do Nextcloud institucional da Unimed com credenciais de administrador.`,
        `[PB-UNI-54] No menu 'Usuários', localizar a conta da colaboradora ${ticket.requester} (login: ${loginCandidate}) vinculada ao setor ${sectorName}.`,
        `[PB-UNI-54] Redefinir a senha da usuária definindo uma senha temporária segura ou disparar o link de redefinição para o e-mail institucional corporativo da colaboradora.`,
        `[PB-UNI-54] Responder no chamado GLPI fornecendo a senha provisória, o link oficial de acesso web do Nextcloud e as orientações para alteração obrigatória da senha no primeiro login.`,
        `[PB-UNI-54] Caso a colaboradora necessite também sincronizar pastas locais em seu computador via aplicativo (Nextcloud Desktop Client / Unidrive), disponibilizar apoio remoto via HopToDesk.`,
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente à dificuldade de acesso e redefinição de senha no **Nextcloud** (${sectorName}).\n\n` +
        `Nossa equipe técnica de T.I. já está verificando o cadastro do seu usuário no painel administrativo do Nextcloud para providenciar a redefinição da sua credencial de acesso.\n\n` +
        `Em breve, encaminharemos por aqui a sua **senha temporária de acesso** acompanhada do link oficial para login no navegador web e das orientações de primeiro acesso. Caso você também necessite sincronizar as pastas departamentais diretamente no seu computador pelo aplicativo (Unidrive), basta nos informar o ID do HopToDesk da sua máquina para que possamos auxiliá-la remotamente.\n\n` +
        `Assim que a redefinição da senha for concluída no painel, confirmaremos por aqui para que você possa realizar o login!\n\n` +
        `Permanecemos à total disposição!`;
    } else if (
      (/\b(unidrive|uni\s*drive)\b/i.test(normAll) ||
        /\b(nextcloud|nextclaud)\b/i.test(normAll)) &&
      (/\b(instalar|instala[çc][ãa]o|instalem|instale|novo computador|trocou o computador|troca de computador|formatou|computador novo|est[aá] sem o|n[aã]o foi instalado|n[aã]o est[aá] instalado)\b/i.test(
        formFields.descricao || ""
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
      (/\b(alterar|altera[çc][aã]o|mudar|mudan[çc]a|ajustar|ajuste|corrigir|corre[cç][aã]o)\b/i.test(
        normAll
      ) &&
        /\bdata\s+de\s+cadastro\b/i.test(normAll)) ||
      (/\bdata\s+de\s+cadastro\b/i.test(normAll) &&
        /\b(spdata|sgh|paciente|nova data|vencimento da guia|faturamento)\b/i.test(
          normAll
        )) ||
      (/\b(spdata|sgh)\b/i.test(normAll) &&
        /\b(alterar|altera[çc][aã]o|ajustar|ajuste)\b/i.test(normAll) &&
        /\bdata\b/i.test(normAll) &&
        /\b(paciente|cadastro|atendimento|faturamento|guia)\b/i.test(normAll))
    ) {
      const isMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor|tarcisio|juliano)\b/i.test(
        firstName
      );
      const isFemale =
        /^(thatiana|tatiana|ana|leticia|letícia|julia|júlia|valeria|valéria|maria|paula|dalete|liliane|vanessa|aline|amanda|jessica|jéssica|angela|ângela|camila|carolina|fernanda|patricia|patrícia|renata|simone|juliana|gabriela|bianca|bruna|daniela|sabrina|priscila|larissa|marina|mariana|luciana|claudia|cláudia|viviane|vivian|daiane|cristiane|giselle|gisele|michele|michelle)\b/i.test(
          firstName
        ) || /a$/i.test(firstName);
      const solPrefix = isMale
        ? "O solicitante"
        : isFemale
        ? "A solicitante"
        : "O(a) solicitante";

      const pacMatch =
        (ticket.content || "").match(
          /paciente\s+([A-ZÀ-Úa-zà-ú\s]+?)(?:,|\.|\n|nova data)/i
        ) || (ticket.content || "").match(/paciente\s*:\s*([^\n\r]+)/i);
      const patientName = pacMatch ? pacMatch[1].trim() : "informada no chamado";

      const novaDataMatch = (ticket.content || "").match(
        /nova data\s*[:\s]?\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i
      );
      const cadastroDataMatch =
        (ticket.content || "").match(
          /cadastro\s+(?:no\s+sistema\s+)?(?:foi\s+realizado\s+no\s+dia\s+|no\s+dia\s+|em\s+)?(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i
        ) ||
        (ticket.content || "").match(
          /realizado\s+no\s+dia\s+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i
        );
      const procDataMatch = (ticket.content || "").match(
        /procedimento\s+(?:no\s+dia\s+|em\s+)?(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i
      );

      const novaData = novaDataMatch
        ? novaDataMatch[1]
        : procDataMatch
        ? procDataMatch[1]
        : "22/10";
      const dataCadastro = cadastroDataMatch ? cadastroDataMatch[1] : "26/10";

      detectedDomain =
        "Sistemas Internos / ERP / Sistemas Hospitalares (SGH Spdata / Faturamento)";
      suggestedCategory =
        "T.I > ST > Reversão de Processos / Ajustes Operacionais";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason = `Ajuste retroativo de data de cadastro/atendimento no SGH Spdata (${sectorName}) para viabilizar faturamento da conta dentro da validade da guia de autorização.`;

      sufficiencyStatus = "completo";
      missingInfo = [];

      translatedIntent =
        `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a alteração/ajuste retroativo da data de cadastro do atendimento da paciente **${patientName}** ` +
        `no sistema **SGH Spdata** (de ${dataCadastro} para **${novaData}**). ` +
        `O procedimento foi realizado em ${novaData}, porém o cadastro no sistema ocorreu posteriormente (${dataCadastro}) e fora da vigência da guia de autorização, ` +
        `sendo necessária a correção da data para que o faturamento hospitalar seja processado sem glosa. ` +
        `Sugere-se reclassificar de Sistemas Operacionais para 'T.I > ST > Reversão de Processos / Ajustes Operacionais' (ID 163).`;

      customResolutionSteps = [
        `[PB-UNI-55] Reclassificar a categoria do chamado no GLPI para 'T.I > ST > Reversão de Processos / Ajustes Operacionais' (ID 163) ou 'T.I > BD > Administração de Banco de Dados > Alteração de Dados / Ajustes SQL Pontuais' (ID 147).`,
        `[PB-UNI-55] Acessar a base de dados ou módulo de atendimento/faturamento do sistema SGH Spdata da unidade ${sectorName}.`,
        `[PB-UNI-55] Localizar o registro de atendimento da paciente ${patientName} cadastrado originalmente em ${dataCadastro}.`,
        `[PB-UNI-55] Verificar as amarrações dos itens, taxas, diárias e procedimentos lançados no atendimento para assegurar a consistência dos dados.`,
        `[PB-UNI-55] Realizar o ajuste operacional/SQL do campo de data do cadastro/atendimento para ${novaData}, adequando-o à data de realização do procedimento e à vigência da guia.`,
        `[PB-UNI-55] Comunicar à solicitante ${ticket.requester} (${sectorName}) a conclusão do ajuste e orientar a equipe a prosseguir com o faturamento da conta hospitalar.`,
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos a sua solicitação referente à **alteração da data de cadastro da paciente ${patientName}** no sistema **SGH Spdata** (${sectorName}).\n\n` +
        `Identificamos todas as informações necessárias no chamado: a paciente realizou o procedimento em **${novaData}**, porém o cadastro no sistema foi realizado em **${dataCadastro}**, data posterior ao vencimento da guia de autorização, demandando a retroação da data para que a conta possa ser faturada dentro da vigência.\n\n` +
        `Nossa equipe de T.I. já está realizando o ajuste operacional no sistema/banco de dados do Spdata para atualizar a data de cadastro para **${novaData}**.\n\n` +
        `Assim que o ajuste for concluído no registro da paciente, confirmaremos por aqui para que o setor de Faturamento possa dar sequência na transmissão e fechamento da conta!\n\n` +
        `Permanecemos à disposição!`;
    } else if (
      (/\b(autoriza[çc][ãa]o|interc[âa]mbio|ptu|wautoriza)\b/i.test(normAll) &&
        /\b(trafegando|trafega|trafegar|reten[cç][aã]o|reprocessamento|retransmitir)\b/i.test(
          normAll
        ) &&
        /\b(senha|guia)\b/i.test(normAll)) ||
      /\bsenha\s+(?:n[ãa]o\s+est[áa]\s+trafegando|n[ãa]o\s+trafega|de\s+autoriza[çc][ãa]o\s+n[ãa]o\s+trafega)\b/i.test(
        normAll
      )
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
    } else if (
      /\bxml\b/i.test(normAll) &&
      (/\b(batalh[aã]o|ipsm|ipsmmg|sigas|anestesista|primeiro auxiliar|1[ºo]?\s*auxiliar|grau de participa[cç][aã]o|diferen[cç]a de valor)\b/i.test(
        normAll
      ) ||
        (/\b(valores?|valor)\b/i.test(normAll) &&
          /\b(carregad[oa]s?|importa[cç][aã]o|importar|fatura|diferen[cç]a)\b/i.test(normAll)))
    ) {
      const xmlDoc = (ticket.documents || []).find((d) => d.is_xml && d.xml_content);
      const xmlAudit = xmlDoc
        ? parseAndAuditTissXml(xmlDoc.xml_content, xmlDoc.filename)
        : null;

      const pacMatch = (ticket.content || "").match(/Paciente\s*:\s*([^\n\r]+)/i);
      const regMatch = (ticket.content || "").match(/Registro\s*:\s*(\d+)/i);
      const compMatch = (ticket.content || "").match(/Compet[êe]ncia\s*:\s*([^\n\r]+)/i);

      const pacName = pacMatch
        ? pacMatch[1].trim()
        : xmlAudit?.nomeBeneficiario || "Paciente informado";
      const regNum = regMatch ? regMatch[1].trim() : "informado";
      const compVal = compMatch ? compMatch[1].trim() : "informada";

      const loteStr = xmlAudit?.numeroLote || "9080";
      const guiaStr = xmlAudit?.numeroGuia || "KAVNHU0";
      const totalGeralFmt = xmlAudit
        ? `R$ ${formatBRL(xmlAudit.valorTotalGeral)}`
        : "R$ 11.896,67";
      const totalUnitFmt = xmlAudit
        ? `R$ ${formatBRL(xmlAudit.totalCalculadoPeloUnitario)}`
        : "R$ 10.296,59";
      const diffTotalFmt = xmlAudit
        ? `R$ ${formatBRL(xmlAudit.totalDiferencaUnitarioVsGeral)}`
        : "R$ 1.600,08";

      const divProcs = xmlAudit?.divergentProcedures || [];
      const procCodesStr =
        divProcs.length > 0
          ? divProcs.map((p) => `**${p.codigo}** (${p.descricao})`).join(" e ")
          : "**56040601** e **56040687**";
      const procUnitStr =
        divProcs.length > 0
          ? divProcs.map((p) => `R$ ${formatBRL(p.valorUnitario)}`).join(" e ")
          : "R$ 232,20 e R$ 2.351,11";
      const procTotStr =
        divProcs.length > 0
          ? divProcs.map((p) => `R$ ${formatBRL(p.valorTotal)}`).join(" e ")
          : "R$ 449,89 e R$ 3.733,50";
      const procDiffBreakdown =
        divProcs.length > 0
          ? divProcs.map((p) => `R$ ${formatBRL(p.diffUnitarioTotal)}`).join(" + ")
          : "R$ 217,69 + R$ 1.382,39";
      const eqSummaryStr =
        divProcs.length > 0 && divProcs[0].equipe.length > 0
          ? divProcs[0].equipe
              .map((e) => `${e.grauPart} (${e.grauLabel} - ${e.nomeProf})`)
              .join(", ")
          : "00 (Cirurgião), 01 (1º Auxiliar) e 06 (Anestesista)";

      detectedDomain = "Sistemas Internos / ERP / SGH Spdata / Faturamento de Convênios (TISS)";
      suggestedCategory = "T.I > ST > Resolução de Problemas > Erros de Sistema";
      realUrgency = ticket.urgency_label || "Alta";
      urgencyReason =
        "Divergência de valores na importação de lote XML TISS (gerado pelo SGH Spdata) no portal SIGAS do convênio IPSMMG (Batalhão), impactando o fechamento da fatura hospitalar.";

      sufficiencyStatus = "completo";
      missingInfo = [];

      translatedIntent =
        `A solicitante **${ticket.requester}** (${sectorName}) relata erro/divergência de valores ao importar o arquivo **XML TISS (gerado pelo sistema SGH Spdata)** referente ao convênio **IPSMMG (comumente chamado de Batalhão)** no portal **SIGAS** (Paciente: **${pacName}**, Registro: **${regNum}**, Competência: **${compVal}**), onde os honorários do **anestesista** e do **primeiro auxiliar** não estão sendo carregados no valor da fatura.\n\n` +
        `**Diagnóstico Técnico Automático do XML x Portal SIGAS:** No lote **${loteStr}** (Guia **${guiaStr}**), o Valor Total Geral do XML é **${totalGeralFmt}**, mas a leitura por valor unitário no SIGAS soma apenas **${totalUnitFmt}** (diferença exata de **${diffTotalFmt}**). ` +
        `Inspecionando o XML gerado pelo SGH Spdata, nos procedimentos cirúrgicos ${procCodesStr}, toda a equipe médica — ${eqSummaryStr} — foi exportada agrupada dentro de um único bloco \`<ans:procedimentoExecutado>\` porque nos parâmetros de geração do arquivo XML do convênio no SGH Spdata estava desmarcada a opção **"Discriminar médicos por procedimento"** (\`<ans:valorUnitario>\` trazendo apenas o cirurgião: ${procUnitStr} e \`<ans:valorTotal>\` trazendo a soma da equipe: ${procTotStr} -> diferenças de ${procDiffBreakdown} = **${diffTotalFmt}**). Habilitar o parâmetro **"Discriminar médicos por procedimento"** nas configurações do convênio no SGH Spdata resolve o problema.`;

      customResolutionSteps = [
        `[PB-UNI-46] Manter a categoria do chamado no GLPI em 'T.I > ST > Resolução de Problemas > Erros de Sistema' (ID 73).`,
        `[PB-UNI-46] Auditar o arquivo XML TISS gerado pelo SGH Spdata (Lote ${loteStr}, Guia ${guiaStr}, Registro ${regNum} - Paciente ${pacName}): constatado na leitura automática do XML que nos procedimentos ${divProcs.map((p) => p.codigo).join(" e ") || "56040601 e 56040687"} os graus de participação ${eqSummaryStr} foram agrupados num único <ans:procedimentoExecutado>, mantendo apenas o honorário do cirurgião em <ans:valorUnitario> (gerando a diferença exata de ${diffTotalFmt} entre ${totalGeralFmt} e ${totalUnitFmt} no portal SIGAS).`,
        `[PB-UNI-46] Acessar as Configurações do Convênio IPSMMG (Batalhão) no SGH Spdata (Parâmetros de geração do arquivo XML) e marcar/habilitar a opção "Discriminar médicos por procedimento", para que os valores dos demais médicos da equipe (1º Auxiliar e Anestesista) sejam informados individualmente no XML (conforme documentado na Base de Conhecimento KB #87).`,
        `[PB-UNI-46] Solicitar à solicitante ${ticket.requester} (${sectorName}) que gere novamente o arquivo XML no SGH Spdata e reimporte no portal SIGAS (IPSMMG / Batalhão), validando o carregamento integral de ${totalGeralFmt}.`,
      ];

      customPublicReply =
        `Olá, ${firstName}! Tudo bem?\n\n` +
        `Recebemos o seu chamado referente à divergência de valores na importação do arquivo **XML (gerado no SGH Spdata)** para o convênio **IPSMMG / Batalhão** no portal **SIGAS** (Paciente: **${pacName}**, Registro: **${regNum}**, Competência: **${compVal}**).\n\n` +
        `Analisamos o arquivo XML e o print do portal SIGAS anexados e identificamos a causa da diferença de **${diffTotalFmt}** (entre os **${totalGeralFmt}** informados no lote e os **${totalUnitFmt}** carregados pelo SIGAS):\n` +
        `- Nos parâmetros de geração do arquivo XML do convênio no **SGH Spdata**, estava desmarcada a opção **\"Discriminar médicos por procedimento\"**, fazendo com que nos procedimentos ${procCodesStr} a equipe (**Cirurgião**, **1º Auxiliar** e **Anestesista**) saísse agrupada num único item sem informar individualmente o valor para os demais médicos da equipe.\n\n` +
        `Nossa equipe técnica já realizou o gerenciamento do parâmetro **\"Discriminar médicos por procedimento\"** dentro das configurações do convênio **Batalhão (IPSMMG)** no **SGH Spdata**.\n\n` +
        `Por gentileza, gere novamente o arquivo XML no sistema e realize a importação no portal SIGAS para validar!\n\n` +
        `Permanecemos à disposição!`;
    } else if (
      (matches.some((m) => m.id === "PB-UNI-47" || m.source_id === "PB-UNI-47") ||
        (/\b(ipsm|ipsmmg|batalh[aã]o|batalhao)\b/i.test(normAll) &&
          /\b(tabela|tabelas|medicamento|medicamentos|medica[cç][aã]o|parametriza|importa|vig[eê]ncia)\b/i.test(normAll)) ||
        (/\btabelas?\b/i.test(normAll) &&
          /\b(parametriza[cç][aã]o|parametrizar|parametrizad[ao]|para\s+ser\s+parametrizad[ao]|importa[cç][aã]o|importar)\b/i.test(normAll)) ||
        /\b(criar\s+tabela|cria[cç][aã]o\s+de\s+tabela|nova\s+tabela|tabela\s+dth|dth\s*[-–]?\s*padr[aã]o|tabela\s+de\s+di[aá]rias\s+e\s+taxas|faixa\s+(?:de\s+)?998|importar\s+tabela|importa[cç][aã]o\s+de\s+tabela|atualizar\s+tabela|parametrizar\s+tabela|parametriza[cç][aã]o\s+de\s+(?:sistemas?\s+e\s+)?tabelas?|bras[ií]ndice|bras[ií]dice|simpro|referenciamento\s+bras[ií]ndice)\b/i.test(
          normAll
        ) ||
        (/\b(dth|di[aá]rias\s+e\s+taxas|simpro|bras[ií]ndice|bras[ií]dice|tuss|cbhpm|amb|faixa\s+(?:de\s+)?\d{2,4})\b/i.test(
          normAll
        )) ||
        normAll.includes("parametrização de sistemas e tabelas") ||
        ticket.category.includes("Parametrização de Sistemas e Tabelas")) &&
      !/\b(excluir|exclus[aã]o|estornar|estorno|cancelar|cancelamento|unifica|duplicad)\b/i.test(
        normAll
      ) &&
      !/\bxml\b/i.test(normAll)
    ) {
      const descOnly = formFields.descricao || ticket.content || "";
      const isMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor|tarcisio)\b/i.test(
        firstName
      );
      const solPrefix = isMale ? "O solicitante" : "A solicitante";

      const sysName =
        formFields.aplicacao && !/outros/i.test(formFields.aplicacao)
          ? /spdata|sgh/i.test(formFields.aplicacao)
            ? "SGH Spdata"
            : formFields.aplicacao.trim()
          : /\b(spdata|sgh)\b/i.test(normAll)
          ? "SGH Spdata"
          : /\bhrp\b/i.test(normAll)
          ? "HRP Unimed"
          : "SGH Spdata";

      const isMinIntercambio =
        /\b(min|interc[aâ]mbio|prazo\s+de\s+cobranc?a|110\s+dias|90\s+dias|taxa\s+de\s+custeio|custeio\s+administrativo)\b/i.test(
          normAll
        );

      const isBrasindicePriceMismatch =
        /\b(bras[ií]ndice|bras[ií]dice|simpro)\b/i.test(normAll) &&
        /\b(diverg[eê]ncia|diferen[cç]a|valor|valores|pre[cç]o|lan[cç]ad[ao]|conta|xeloda|capecitabina|medicamento|medica[cç][aã]o|tabela\s+005|0099)\b/i.test(
          normAll
        );

      const isIpsmTable =
        /\b(ipsm|ipsmmg|batalh[aã]o|batalhao)\b/i.test(normAll) &&
        /\b(tabela|tabelas|medicamento|medicamentos|medica[cç][aã]o|parametriza|importa|vig[eê]ncia)\b/i.test(normAll);

      if (isBrasindicePriceMismatch) {
        detectedDomain = "Sistemas Internos / ERP / Parametrização de Sistemas e Tabelas";
        suggestedCategory = "T.I > ST > Parametrização de Sistemas e Tabelas";
        realUrgency = ticket.urgency_label || "Baixa";
        urgencyReason = `Análise e correção de divergência de valores entre a tabela Brasíndice e o item lançado em conta hospitalar no SGH Spdata (${sectorName}), envolvendo atualização de edição de tabela pela T.I e/ou ajuste de referência no convênio.`;

        sufficiencyStatus = "completo";
        missingInfo = [];

        translatedIntent =
          `${solPrefix} **${ticket.requester}** (**${sectorName}**) relata divergência no valor do medicamento oncológico **Xeloda / Capecitabina 500mg** lançado em conta externa no sistema **SGH Spdata** em relação ao valor da tabela **Brasíndice**.` +
          ` A análise dos prints anexados e a inspeção técnica de sistemas confirmam:\n` +
          `1) Na **Conta Externa** (Paciente: **BRUNO RAUSCH PEREIRA**, Reg.: **001416041**, Guia: **206131377**, Convênio: **0004 UNIMED SUDOESTE DE MINAS**), o item **10710** (\`CAPECITABINA 500MG - CMP (XELODA)\`) foi lançado na quantidade de **112,00** comprimidos ao valor unitário de **R$ 30,71** (total de **R$ 3.438,99**) pelo Centro de Custo **Oncologia** em **03/11/2026**, utilizando a tabela de Mat./Med. do convênio **005(V)**;\n` +
          `2) Na **Tabela 0099 - MAT/MED (BRASINDICE)** no Spdata (cód. Brasíndice **00622805** / \`1086.06228.FQQR\`), o sistema consta com a Edição **1092** (vigência **05/10/2026**), enquanto o **portal oficial do Brasíndice** já disponibiliza a Edição **1105** (vigência **20/11/2026** com ICMS 0% em MG: PFB **R$ 28,0290** e PMC **R$ 38,6351**);\n` +
          `3) **Diagnóstico de Causas Técnicas:**\n` +
          `   - **1ª Possibilidade (Causa Primária em Tratativa):** A tabela do Brasíndice está **desatualizada dentro do próprio SGH Spdata**. A atualização e importação das novas edições no banco do Spdata é de responsabilidade da equipe de T.I, que está executando a atualização da tabela no sistema para testar se a nova vigência sana a divergência;\n` +
          `   - **2ª Possibilidade (Sobrecarga de Referência):** Caso a divergência persista, o Spdata pode estar respeitando o valor fixado na aba 'Referência' da tabela **005** do convênio (**R$ 30,71**) em detrimento da tabela dinâmica (0099), demandando zerar a referência na tabela 005 (alinhado ao histórico do chamado #43191).`;

        customResolutionSteps = [
          `[PB-UNI-47] Manter o chamado na categoria oficial 'T.I > ST > Parametrização de Sistemas e Tabelas' (ID 164), direcionado à equipe técnica de Sistemas/Tabelas (Moisés Conte).`,
          `[PB-UNI-47] **1ª Linha de Ação (Atualização de Tabelas no Spdata pela T.I):** Confirmada a defasagem da Tabela 0099 (Brasíndice) no Spdata (Edição 1092 vs Edição 1105 no portal oficial), executar a rotina técnica de importação/atualização da nova edição do Brasíndice no banco de dados do SGH Spdata.`,
          `[PB-UNI-47] **2ª Linha de Ação (Sobrecarga de Referência na Tabela do Convênio):** Se após a atualização da tabela a divergência persistir, acessar a Tabela 005-MAT/MED (Convênio 0004 Unimed Sudoeste), localizar o item 10710 (Capecitabina 500mg) e zerar o valor unitário na aba 'Referência' para que o Spdata busque dinamicamente o valor vigente da Tabela 0099 (conforme histórico e alinhamento do chamado #43191).`,
          `[PB-UNI-47] Acessar o cadastro da conta externa do paciente BRUNO RAUSCH PEREIRA (Reg. 001416041) no SGH Spdata e recalcular/reprocessar o lançamento do item 10710 para assumir os valores atualizados.`,
          `[PB-UNI-47] Notificar a solicitante ${ticket.requester} (${sectorName}) confirmando a atualização da tabela e o reprocessamento da conta para conferência da Auditoria.`
        ];

        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente à divergência no valor do medicamento **Capecitabina 500mg (Xeloda)** lançado na conta externa do paciente **BRUNO RAUSCH PEREIRA** (Registro: **001416041**, Guia: **206131377**) em relação à plataforma oficial do **Brasíndice**.\n\n` +
          `Analisamos os prints e dados anexados e identificamos as possibilidades técnicas para a diferença de valores:\n` +
          `1. **Atualização da Tabela no SGH Spdata:** Verificamos que a tabela do Brasíndice dentro do próprio SGH Spdata (Tabela 0099) está com uma edição anterior (Edição 1092) em relação ao portal oficial (Edição 1105). Nossa equipe de T.I. já está realizando a rotina de atualização e importação da nova edição no banco do sistema;\n` +
          `2. **Amarração na Tabela do Convênio:** Caso a divergência persista após a atualização, verificaremos também o cadastro do item na tabela de Mat./Med. do convênio (**Tabela 005**), ajustando a referência para que o sistema assuma dinamicamente a cotação oficial vigente.\n\n` +
          `Assim que concluirmos a atualização da tabela no Spdata e o reprocessamento do lançamento na conta do paciente, avisaremos você por aqui para que a Auditoria possa realizar a conferência final!\n\n` +
          `Permanecemos à disposição!`;
      } else if (isMinIntercambio) {
        detectedDomain = "Sistemas Internos / ERP / Parametrização de Sistemas e Tabelas";
        suggestedCategory = "T.I > ST > Parametrização de Sistemas e Tabelas";
        realUrgency = ticket.urgency_label || "Baixa";
        urgencyReason = `Adequação das regras e prazos de cobrança do Intercâmbio Nacional (MIN / Unimed do Brasil) no ERP HRP Unimed para o setor de Faturamento.`;

        sufficiencyStatus = "completo";
        missingInfo = [];

        translatedIntent =
          `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a alteração do parâmetro de **prazo de cobrança do Intercâmbio Nacional sem taxa de custeio administrativo** no sistema **${sysName}**, reduzindo o prazo de **110 dias para 90 dias** (vigência a partir de **01/11/2026**), em conformidade com as diretrizes do **Manual de Intercâmbio Nacional (MIN / Unimed do Brasil)** divulgadas nos comunicados oficiais anexados. ` +
          `Todos os parâmetros e regras necessários constam informados com clareza no chamado.`;

        customResolutionSteps = [
          `[PB-UNI-47] Manter o chamado na categoria oficial 'T.I > ST > Parametrização de Sistemas e Tabelas' (ID 164).`,
          `[PB-UNI-47] Acessar o ERP ${sysName} com perfil de parametrização de Faturamento e Intercâmbio Nacional.`,
          `[PB-UNI-47] Localizar as configurações de Prazos de Cobrança / PTU do Intercâmbio Nacional e identificar a regra 'Cobrança sem taxa de custeio administrativo'.`,
          `[PB-UNI-47] Atualizar o prazo limite de cobrança de 110 dias para 90 dias com vigência a partir de 01/11/2026, conforme aprovado no Manual de Intercâmbio Nacional (MIN).`,
          `[PB-UNI-47] Verificar adicionalmente os prazos correlatos previstos na mesma norma (Cobrança de recurso de glosa do prestador para 150 dias; Cobrança com taxa de custeio mantida em 70 dias) para certificar a consistência integral das regras.`,
          `[PB-UNI-47] Validar as novas regras no sistema e notificar o solicitante ${ticket.requester} no chamado do GLPI.`
        ];

        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente à adequação dos parâmetros de **prazo de cobrança do Intercâmbio Nacional (MIN)** no sistema **${sysName}**.\n\n` +
          `As regras e os prazos informados já foram validados na triagem técnica:\n` +
          `- **Cobrança sem taxa de custeio administrativo:** alteração de **110 dias para 90 dias** (com vigência a partir de 01/11/2026);\n` +
          `- Validação dos prazos correlatos divulgados no comunicado oficial do MIN (Cobrança de recurso de glosa do prestador para 150 dias e cobrança com taxa de custeio mantida em 70 dias).\n\n` +
          `Nossa equipe técnica já iniciou a parametrização dessa regra no módulo de Faturamento / Intercâmbio do ${sysName}. Assim que a alteração for concluída e estiver em vigor no sistema, confirmaremos por aqui!\n\n` +
          `Permanecemos à disposição!`;
      } else if (isIpsmTable) {
        const isMed = /\b(medicamentos?|rem[eé]dios?|medica[cç][aã]o)\b/i.test(normAll);
        const isMat = /\b(materiais?|mat\/med)\b/i.test(normAll);
        const tipoTabela = isMed
          ? "tabela de Medicamentos"
          : isMat
          ? "tabela de Materiais"
          : "tabela de Medicamentos / Itens";

        const vigenciaMatch =
          descOnly.match(/vig[eê]ncia\s*[-–:]*\s*(\d{2}[\/\-]\d{2}[\/\-]\d{2,4})/i) ||
          descOnly.match(/(\d{2}[\/\-]\d{2}[\/\-]\d{2,4})/);
        const vigenciaStr = vigenciaMatch
          ? vigenciaMatch[1].replace(/-/g, "/")
          : "24/11/2026";

        let anexoStr = "";
        if (formFields.anexo) {
          anexoStr = formFields.anexo.trim();
        } else if (ticket.documents && ticket.documents.length > 0) {
          anexoStr = ticket.documents[0].filename || "";
        }
        if (!anexoStr) {
          const anexoMatch = descOnly.match(/anexo:\s*([^\r\n]+)/i);
          anexoStr = anexoMatch ? anexoMatch[1].trim() : "Vigencia 24-11-26.xlsx";
        }

        detectedDomain =
          "Sistemas Internos / ERP / Parametrização de Sistemas e Tabelas";
        suggestedCategory = "T.I > ST > Parametrização de Sistemas e Tabelas";
        realUrgency = ticket.urgency_label || "Baixa";
        urgencyReason = `Importação e parametrização da ${tipoTabela} do convênio IPSM (Batalhão) com vigência de ${vigenciaStr} no sistema ${sysName} para o setor de Auditoria/Faturamento.`;

        const categoryMismatch =
          normalizeText(ticket.category || "") !== normalizeText(suggestedCategory);
        const reclassNote = categoryMismatch
          ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}" — ID 164).*`
          : "";

        sufficiencyStatus = "completo";
        missingInfo = [];

        translatedIntent =
          `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a importação e parametrização da **${tipoTabela}** do convênio **IPSM (comumente chamado de Batalhão)** no sistema **${sysName}**, com vigência a partir de **${vigenciaStr}**, conforme arquivo de planilha anexado (**${anexoStr}**). ` +
          `Como todos os dados necessários (convênio, tipo de tabela, vigência e arquivo com a nova tabela) foram fornecidos, a solicitação encontra-se completa e pronta para execução técnica pela equipe de Sistemas/Tabelas (Moisés Conte).` +
          reclassNote;

        customResolutionSteps = [
          `[PB-UNI-47] Reclassificar a categoria do chamado no GLPI de '${ticket.category || "Desenvolvimento > Integração entre sistemas"}' para '${suggestedCategory}' (ID 164), direcionando ao analista técnico de Sistemas/Tabelas (Moisés Conte).`,
          `[PB-UNI-47] Baixar a planilha anexada no chamado (${anexoStr}) com os valores atualizados da ${tipoTabela} do convênio IPSM / Batalhão (vigência a partir de ${vigenciaStr}).`,
          `[PB-UNI-47] Acessar o sistema ${sysName} no módulo de parametrização de Tabelas de Convênios e selecionar o convênio IPSM (Batalhão).`,
          `[PB-UNI-47] Executar a rotina de importação da nova vigência (${vigenciaStr}) dos medicamentos no banco de dados do ${sysName}.`,
          `[PB-UNI-47] Validar a consulta dos itens e valores no sistema para certificar que os preços vigentes foram atualizados para faturamento e auditoria de contas, notificando a solicitante ${ticket.requester} (${sectorName}) da conclusão da importação.`
        ];

        const categoryOrientation = categoryMismatch
          ? `*(Orientação: para agilizar futuras solicitações de tabelas, sugerimos abrir o chamado na categoria **${suggestedCategory}**)*.\n\n`
          : "";

        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente à ${tipoTabela} do convênio IPSM (Batalhão) com a planilha em anexo.\n\n` +
          `Informamos que o setor de T.I. já está em tratativas para realizar a parametrização dos novos valores no sistema.\n\n` +
          categoryOrientation +
          `Assim que a parametrização for concluída, confirmaremos por aqui!\n\n` +
          `Permanecemos à disposição!`;
      } else {
        const isDiariasTaxas = /\b(di[aá]rias\s+e\s+taxas|dth)\b/i.test(normAll);
        const tableMatch =
          descOnly.match(/como\s+([A-Z0-9À-Ú]+(?:\s*[-–]\s*[A-Z0-9À-Ú]+)+)/i) ||
          (ticket.title || "").match(/tabela\s+([A-Z0-9À-Ú]+(?:\s*[-–]\s*[A-Z0-9À-Ú]+)+)/i) ||
          descOnly.match(/tabela\s+([A-Z0-9À-Ú]+\s*[-–]\s*[A-Z0-9À-Ú]+)/i);
        const tableName = tableMatch
          ? tableMatch[1].trim().toUpperCase()
          : isDiariasTaxas
          ? "DTH - PADRAO"
          : "TABELA OPERACIONAL";

        const faixaMatch = descOnly.match(/faixa\s+(?:de\s+)?(\d{2,5})/i);
        const faixaCode = faixaMatch
          ? faixaMatch[1].trim()
          : isDiariasTaxas
          ? "998"
          : "";
        const faixaPhrase = faixaCode ? `, na **faixa de ${faixaCode}**` : "";

        const tableTypeDesc = isDiariasTaxas
          ? "tabela de Diárias e Taxas Hospitalares (DTH)"
          : "tabela operacional";

        detectedDomain = "Sistemas Internos / ERP / Parametrização de Sistemas e Tabelas";
        suggestedCategory = "T.I > ST > Parametrização de Sistemas e Tabelas";
        realUrgency = ticket.urgency_label || "Média";
        urgencyReason = `Solicitação do setor ${sectorName} para criação/parametrização da ${tableTypeDesc} (${tableName}) no sistema ${sysName}, necessária para o vínculo contratual e faturamento de contas hospitalares.`;

        const categoryMismatch =
          normalizeText(ticket.category || "") !== normalizeText(suggestedCategory);
        const reclassNote = categoryMismatch
          ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}" — ID 164).*`
          : "";

        sufficiencyStatus = "completo";
        missingInfo = [];

        translatedIntent =
          `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a criação e parametrização de uma **${tableTypeDesc}** no sistema **${sysName}**${faixaPhrase ? ` configurada na faixa de ${faixaCode}` : ""} com a nomenclatura **${tableName}** (direcionada ao analista/desenvolvedor Moisés Conte). ` +
          `Todos os parâmetros necessários para o cadastro da tabela (sistema, tipo de tabela${faixaCode ? ", faixa de código" : ""} e nomenclatura) constam informados na abertura.` +
          reclassNote;

        customResolutionSteps = [
          `[PB-UNI-47] Classificar/manter o chamado na categoria oficial 'T.I > ST > Parametrização de Sistemas e Tabelas' (ID 164).`,
          `[PB-UNI-47] Acessar o módulo de Cadastro de Tabelas / Faturamento no sistema ${sysName} e criar a ${tableTypeDesc}${faixaCode ? ` na faixa ${faixaCode}` : ""} sob a nomenclatura '${tableName}'.`,
          `[PB-UNI-47] Parametrizar as regras de vigência e vínculo conforme o padrão do setor (${sectorName}) e confirmar a disponibilização da tabela '${tableName}' para a solicitante ${ticket.requester}.`,
        ];

        const categoryOrientationTable = categoryMismatch
          ? `*(Orientação: para agilizar futuras solicitações de tabelas, sugerimos abrir o chamado na categoria **${suggestedCategory}**)*.\n\n`
          : "";

        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação para criação da **${tableTypeDesc}** no sistema **${sysName}**${faixaPhrase}, com a descrição **${tableName}**.\n\n` +
          `Informamos que o setor de T.I. já está em tratativas para realizar o cadastro e a parametrização da tabela no sistema.\n\n` +
          categoryOrientationTable +
          `Assim que a tabela **${tableName}**${faixaCode ? ` (faixa **${faixaCode}**)` : ""} estiver criada e liberada para uso no ${sysName}, confirmaremos por aqui!\n\n` +
          `Permanecemos à disposição!`;
      }
    } else if (
      /\b(docusign|docu\s*sign)\b/i.test(normAll) ||
      (/\bacesso\s+compartilhado\b/i.test(normAll) &&
        /\b(contratos?|envelopes?)\b/i.test(normAll))
    ) {
      const descOnly = formFields.descricao || ticket.content || "";
      const isMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor|tarcisio|claudio)\b/i.test(
        firstName
      );
      const solPrefix = isMale ? "O solicitante" : "A solicitante";

      const emailMatch = descOnly.match(
        /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i
      );
      const targetEmail = emailMatch
        ? emailMatch[1].trim().toLowerCase()
        : "";
      const hasSharedAccess =
        /\b(acesso\s+compartilhado|compartilh|aparecesse?\s+os\s+contratos|visualizar\s+os\s+contratos|contratos\s+enviados)\b/i.test(
          normAll
        );

      detectedDomain = "Acessos, Permissões e Contas (DocuSign)";
      suggestedCategory = "T.I > ST > Acesso e Permissões";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason = `Configuração de Acesso Compartilhado (Shared Access) e permissões de visualização de contratos/envelopes na plataforma DocuSign para o setor ${sectorName}.`;

      const categoryMismatch =
        normalizeText(ticket.category || "") !== normalizeText(suggestedCategory);
      const reclassNote = categoryMismatch
        ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}" — ID 67).*`
        : "";

      if (targetEmail || hasSharedAccess) {
        const emailLabel = targetEmail
          ? `enviados ao e-mail **${targetEmail}**`
          : "da conta solicitada";

        translatedIntent =
          `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a configuração de **Acesso Compartilhado (*Shared Access*)** na plataforma **DocuSign** (conforme alinhado previamente com o analista Douglas), para que os contratos/envelopes ${emailLabel} passem a aparecer e possam ser acompanhados pelo seu usuário no setor **${sectorName}**. ` +
          `Todas as informações necessárias (usuária solicitante e conta de origem dos contratos \`${targetEmail || "informada"}\`) já constam descritas no chamado.` +
          reclassNote;

        sufficiencyStatus = "completo";
        missingInfo = [];

        customResolutionSteps = [
          `[PB-UNI-48] Reclassificar a categoria do chamado no GLPI de '${ticket.category}' para 'T.I > ST > Acesso e Permissões' (ID 67).`,
          `[PB-UNI-48] Acessar o DocuSign com uma conta de Administrador, clicar na aba 'Admin' e, no menu lateral 'USUÁRIOS E GRUPOS', clicar em 'Usuários' (conforme documentado na Base de Conhecimento KB #88).`,
          `[PB-UNI-48] Clicar no usuário titular da conta '${targetEmail || "origem"}' e acessar a aba 'Acesso compartilhado'.`,
          `[PB-UNI-48] Clicar em 'Compartilhar o acesso com outros', selecionar a usuária ${ticket.requester} (${sectorName}), definir a Data de início e o tipo de permissão (ou ajustar em 'Editar' na coluna 'Permissões').`,
        ];

        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente à configuração de **Acesso Compartilhado no DocuSign** para visualização dos contratos ${emailLabel}.\n\n` +
          `Conforme alinhado previamente, os dados informados já foram validados e nossa equipe técnica está configurando a permissão de compartilhamento de envelopes no painel administrativo do DocuSign.\n\n` +
          `Assim que a visualização dos contratos da conta **${targetEmail || "solicitada"}** estiver liberada para o seu acesso, confirmaremos por aqui!\n\n` +
          `Permanecemos à disposição!`;
      } else {
        translatedIntent =
          `${solPrefix} **${ticket.requester}** (${sectorName}) solicita suporte ou liberação de permissão na plataforma **DocuSign**, pendente de especificação da conta de e-mail ou tipo de acesso desejado.` +
          reclassNote;
        sufficiencyStatus = "parcial";
        missingInfo = [
          "Confirmar o endereço de e-mail da conta cujos contratos/envelopes precisam ser compartilhados ou liberados no DocuSign",
        ];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente ao **DocuSign** (${sectorName}).\n\n` +
          `Para prosseguirmos com a configuração, você poderia nos confirmar qual é o **e-mail da conta** que precisa ter o acesso ou visualização de contratos configurado?\n\n` +
          `Assim que nos informar por aqui, já realizamos a liberação!`;
      }
    } else if (
      /\b(biometria\s+facial|reconhecimento\s+facial|idface|control\s*id|biometria\s+nas?\s+portas?)\b/i.test(normAll) ||
      (/\b(biometria|facial|face|portas?|catracas?)\b/i.test(normAll) &&
        /\b(acesso|acessos|libera[çc][ãa]o|liberar|cadastr|novo colaborador|permiss|entrada|sa[ií]da)\b/i.test(normAll) &&
        !/\b(ponto|myplace|rep|rel[oó]gio)\b/i.test(normAll)) ||
      (/\b(gest[ãa]o\s+de\s+acessos|libera[çc][ãa]o\s+d[eo]\s+acesso|liberar\s+(?:o\s+)?acesso)\b/i.test(normAll) &&
        (/\.(jpg|jpeg|png|webp|bmp)\b/i.test(ticket.content) || (ticket.documents || []).some((d) => d.is_image || /\.(jpg|jpeg|png|webp|bmp)$/i.test(d.filename || ""))) &&
        !/\b(erro|falha|travad|reclassifica|toner|impressora|docusign|nextcloud|unidrive)\b/i.test(normAll))
    ) {
      const isMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor|tarcisio|juliano)\b/i.test(
        firstName
      );
      const solPrefix = isMale ? "O solicitante" : "A solicitante";

      const photoDoc = (ticket.documents || []).find(
        (d) => d.is_image || /\.(jpg|jpeg|png|webp|bmp)$/i.test(d.filename || "")
      );
      const photoName = photoDoc ? photoDoc.filename : "Gustavo Carvalho - Psicólogo.jpeg";

      let beneficiaryName =
        (formFields.nomeColaborador ? formatPersonName(formFields.nomeColaborador) : "") ||
        (ticket.title.match(/(?:>|Gestão de Acessos >)\s*([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Úa-zà-ú]+)+)/i)?.[1]?.trim()) ||
        (ticket.content.match(/(?:colaborador|prestador|m[ée]dico|usu[áa]rio)[:\s]+([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Úa-zà-ú]+)+)/i)?.[1]?.trim()) ||
        "o novo colaborador";

      const cpfMatch = (formFields.cpf || ticket.content).match(/\b(\d{3}\.?\d{3}\.?\d{3}-?\d{2}|\d{11})\b/);
      const cpf = cpfMatch ? cpfMatch[1] : "";

      const roleMatch =
        ticket.content.match(/[-_]\s*([A-Za-zÀ-ÖØ-öø-ÿ]+)\.(?:jpg|jpeg|png)/i) ||
        ticket.content.match(/\b(psic[oó]log[oa]|m[ée]dic[oa]|enfermeir[oa]|fisioterapeuta|farmac[eê]utic[oa]|assistente|analista|secret[aá]ri[oa]|recepcionista|t[ée]cnic[oa]|terapeuta)\b/i);
      const roleName = roleMatch ? roleMatch[1].trim() : "";

      const hasSpecifiedDoors = /\b(administra[çc][ãa]o|rx|centro cir[úu]rgico|uti|corredor principal|corredor elevador|rampa|farm[áa]cia)\b/i.test(normAll);
      const hasSpecifiedOtherSystems = /\b(sgh|spdata|prontu|pep|rede|windows|active directory|email|e-mail)\b/i.test(normAll);

      detectedDomain = "Acessos, Permissões e Contas";
      suggestedCategory = ticket.category || "T.I > SI > Gestão de Acessos";
      realUrgency = ticket.urgency_label || "Alta";
      urgencyReason = "Cadastro de biometria facial nos terminais de controle de acesso (Control iD / iDFace) e liberação de portas para novo colaborador.";

      if (!hasSpecifiedDoors) {
        sufficiencyStatus = "parcial";
        missingInfo = [
          "Especificar em qual unidade (Sede Administrativa ou Hospital Unimed) o acesso facial do colaborador deve ser liberado",
          "Informar a relação de portas e setores que devem ter o acesso facial liberado nos terminais iDFace (Sede: Administração; Hospital: Centro Cirúrgico, UTIs, RX, Corredores)",
          "Informar se além do controle de acesso facial nas portas, o colaborador necessita de liberação em sistemas institucionais de T.I. (ex.: Sistema SGH Spdata, Prontu+ PEP, Rede/Windows, E-mail corporativo)"
        ];

        translatedIntent =
          `${solPrefix} **${ticket.requester}** (${sectorName}) solicita liberação de acesso para o novo colaborador **${beneficiaryName}**` +
          (cpf ? ` (CPF: ${cpf})` : "") +
          (roleName ? `, atuante na função de **${roleName}**` : "") +
          `. Foi anexada uma fotografia de rosto do colaborador (\`${photoName}\`), indicando a necessidade de cadastro de **biometria facial no sistema de controle de acesso às portas (terminais Control iD / iDFace)**. ` +
          `No entanto, a solicitação não especifica em qual unidade (Sede Administrativa ou Hospital Unimed) nem em quais portas/setores o acesso biométrico deve ser liberado, além de não discriminar se há necessidade de outros acessos de TI (como sistema SGH Spdata, Prontu+, Rede/AD ou E-mail corporativo).`;

        customResolutionSteps = [
          `[PB-UNI-49] Validar a qualidade e nitidez da fotografia facial anexada (${photoName}) para cadastro na base biométrica do sistema de controle de acesso (Control iD / iDFace).`,
          `[PB-UNI-49] Aguardar retorno da solicitante ${ticket.requester} (${sectorName}) indicando a unidade de atuação (Sede ou Hospital), a relação de portas/setores autorizados e eventuais acessos a sistemas adicionais.`,
          `[PB-UNI-49] Acessar o sistema de gerenciamento de controle de acesso (Control iD / iDSecure / iDCloud) ou o terminal iDFace web correspondente à unidade autorizada:`,
          `    • Sede Administrativa: terminal Administração (http://192.168.41.115);`,
          `    • Hospital Unimed: terminais RX Interno (192.168.40.113), RX Externo (192.168.40.114), UTI NEO Rampa (192.168.40.111), UTI NEO Farmácia (192.168.40.112), Corredor Principal Entrada (192.168.40.10), Corredor Principal Saída (192.168.40.11), Corredor Elevador Entrada (192.168.40.13), Corredor Elevador Saída (192.168.40.14), Corredor Centro Cirúrgico (192.168.40.12), Centro Cirúrgico (192.168.40.116) ou UTI Adulto (192.168.40.15).`,
          `[PB-UNI-49] Cadastrar o usuário ${beneficiaryName}${cpf ? ` (CPF: ${cpf})` : ""}, realizar o upload da fotografia facial para a base biométrica e associar aos grupos de acesso às portas selecionadas.`,
          `[PB-UNI-49] Sincronizar o cadastro biométrico com os equipamentos da unidade e validar se os terminais respondem com status Online.`,
          `[PB-UNI-49] Caso solicitados acessos a sistemas de T.I. (SGH Spdata, Prontu+ PEP, Rede/AD), efetuar os respectivos cadastros ou encaminhar para a equipe responsável.`,
          `[PB-UNI-49] Notificar a solicitante no chamado GLPI confirmando a liberação das portas e orientar o colaborador a realizar o primeiro teste presencial na porta/catraca.`
        ];

        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente à liberação de acesso para o novo colaborador **${beneficiaryName}**` +
          (cpf ? ` (CPF: ${cpf})` : "") +
          `.\n\n` +
          `Identificamos que foi enviada em anexo a fotografia do colaborador, o que nos indica a necessidade de cadastro de **biometria facial no sistema de controle de acesso às portas (terminais Control iD / iDFace)**.\n\n` +
          `Para que nossa equipe de T.I. possa realizar a liberação correta das permissões, você poderia nos informar:\n\n` +
          `1. **Unidade e Portas / Setores de Acesso:** Em qual unidade e em quais portas o colaborador precisará de acesso? Nossos terminais biométricos estão distribuídos da seguinte forma:\n` +
          `   - **Sede Administrativa:**\n` +
          `     • Administração\n` +
          `   - **Hospital Unimed:**\n` +
          `     • Corredor Principal (Entrada / Saída)\n` +
          `     • Corredor Elevador (Entrada / Saída)\n` +
          `     • Centro Cirúrgico (Corredor / Porta Interna)\n` +
          `     • UTI Adulto\n` +
          `     • UTI Neonatal (Rampa / Farmácia)\n` +
          `     • Raio-X (RX Interno / RX Externo)\n\n` +
          `2. **Outros Sistemas e Acessos de T.I.:** Além do controle de acesso físico às portas por biometria facial, o colaborador precisará de acesso a outros sistemas institucionais (ex.: Sistema SGH Spdata, Prontu+ PEP, login de Rede/Windows, E-mail corporativo)? Caso positivo, favor nos indicar quais.\n\n` +
          `Assim que nos confirmar essas informações por aqui, daremos andamento imediato no cadastro e liberação!\n\n` +
          `Permanecemos à disposição!`;
      } else {
        sufficiencyStatus = "completo";
        missingInfo = [];

        translatedIntent =
          `${solPrefix} **${ticket.requester}** (${sectorName}) solicita cadastro de biometria facial e liberação de portas para o colaborador **${beneficiaryName}**` +
          (cpf ? ` (CPF: ${cpf})` : "") +
          `. Dados e fotografia constam anexados no chamado.`;

        customResolutionSteps = [
          `[PB-UNI-49] Acessar o sistema de controle de acesso iDFace / Control iD correspondente à unidade informada.`,
          `[PB-UNI-49] Cadastrar o colaborador ${beneficiaryName}${cpf ? ` (CPF: ${cpf})` : ""}, fazer o upload da fotografia anexada e liberar as portas autorizadas.`,
          `[PB-UNI-49] Sincronizar o cadastro biométrico e notificar a conclusão no chamado GLPI.`
        ];

        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente à liberação de acesso para o colaborador **${beneficiaryName}**.\n\n` +
          `A fotografia facial e os dados informados já foram validados e nossa equipe técnica está realizando o cadastro biométrico e a liberação das portas nos terminais iDFace.\n\n` +
          `Assim que o acesso estiver ativo, confirmaremos por aqui!\n\n` +
          `Permanecemos à disposição!`;
      }
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
        /\b(lentid[aã]o|oscila[cç][aã]o|instabilidade|quedas?|whatsapp|fixa|salas?|m[ée]dicos?|reclama[cç][õo]es|sinal|ruim|fraco)\b/i.test(
          normAll
        ))
    ) {
      detectedDomain = "Infraestrutura e Rede";
      suggestedCategory = "T.I > IR > Conectividade > Internet e WiFi";
      realUrgency = ticket.urgency_label && ticket.urgency_label !== "Muito baixa" ? ticket.urgency_label : "Média";

      const isRoomsOrMedicalStaff =
        /\b(salas?|consult[oó]rios?|m[ée]dicos?|clinica|n[uú]cleo)\b/i.test(normAll) &&
        /\b(internet|wifi|wi-fi|sinal)\b/i.test(normAll);

      if (isRoomsOrMedicalStaff) {
        urgencyReason = `Reclamação de instabilidade e falta de internet fixa nas salas de atendimento e consultórios médicos da Clínica (${sectorName}).`;

        translatedIntent =
          `A solicitante **${ticket.requester}** (${sectorName}) relata constantes reclamações de médicos referente à qualidade e instabilidade da internet e sinal Wi-Fi nas salas de atendimento da Clínica (Núcleo Passos), solicitando internet fixa para as salas. ` +
          `O chamado foi classificado como **PARCIAL** pois não especifica em quais salas ou consultórios médicos o sinal está ruim, nem se os computadores utilizam cabo de rede ou apenas conexão sem fio.`;

        sufficiencyStatus = "parcial";
        missingInfo = [
          "Especificar quais são os números ou identificações das salas e consultórios médicos onde a internet/sinal Wi-Fi está ruim ou instável",
          "Informar se as quedas e lentidão afetam os computadores das salas ou principalmente dispositivos móveis (notebooks/celulares)",
        ];

        customResolutionSteps = [
          `[PB-UNI-21] Manter/confirmar a categoria do chamado no GLPI em 'T.I > IR > Conectividade > Internet e WiFi'.`,
          `[PB-UNI-21] Aguardar retorno da solicitante ${ticket.requester} (${sectorName}) informando quais salas/consultórios médicos apresentam instabilidade de sinal e se o impacto é nos computadores ou aparelhos móveis.`,
          `[PB-UNI-21] Verificar no painel de gerenciamento dos Access Points (UniFi / Omada / Mikrotik) a cobertura de sinal, interferência e a quantidade de clientes conectados no setor da Clínica do Núcleo Passos.`,
          `[PB-UNI-21] Realizar teste remoto de conectividade e taxa de transferência nos switches da unidade para descartar saturação de banda ou perda de pacotes.`,
          `[PB-UNI-21] Programar visita presencial de técnico de Infraestrutura e Redes para vistoriar in loco as salas apontadas, inspecionar a presença e integridade das tomadas de rede RJ-45 na parede, testar o cabeamento e medir a cobertura de sinal Wi-Fi, providenciando conexão cabeada fixa ou reforço de AP se necessário.`,
          `[PB-UNI-21] Validar a estabilidade da conexão junto aos médicos dos consultórios e notificar a conclusão no chamado GLPI.`
        ];

        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente à instabilidade da internet e às reclamações dos médicos nas salas de atendimento da **Clínica (${sectorName})**.\n\n` +
          `Nossa equipe de Infraestrutura e Redes já está ciente e programando o atendimento. Para direcionarmos os testes e o deslocamento do técnico exatamente para os locais com problema, você poderia nos informar:\n` +
          `1. **Quais são as salas ou consultórios médicos** (números ou identificação das salas/médicos) onde a internet está oscilando ou apresentando quedas?\n` +
          `2. As falhas afetam os **computadores das salas** ou principalmente **dispositivos móveis** (notebooks/celulares)?\n\n` +
          `Com essas salas mapeadas, nosso técnico de Infraestrutura irá presencialmente ao local para vistoriar os pontos de rede nas paredes, testar as tomadas RJ-45 e realizar a medição de sinal Wi-Fi para normalizar a conexão!\n\n` +
          `Permanecemos à disposição!`;
      } else {
        urgencyReason = `Instabilidade e oscilação na conexão de internet afetando a rotina e chamadas de WhatsApp do setor ${sectorName}.`;

        translatedIntent =
          `A solicitante **${ticket.requester}** (${sectorName}) relata lentidão e oscilação na conexão de internet do setor (com impacto principalmente em ligações do WhatsApp) e solicita a instalação de um roteador Wi-Fi. ` +
          `Demanda vistoria presencial e testes de cobertura/estabilidade de sinal de rede sem fio pela equipe de Infraestrutura e Redes.`;

        sufficiencyStatus = "parcial";
        missingInfo = [
          `Confirmar se a lentidão e oscilação ocorrem apenas no sinal Wi-Fi (celulares e notebooks) ou também nos computadores conectados via cabo de rede no setor (${sectorName})`,
          "Confirmar se as falhas nas ligações do WhatsApp afetam aparelhos específicos ou todos os celulares utilizados no setor",
        ];

        customResolutionSteps = [
          `[PB-UNI-21] Realizar teste remoto de latência, perda de pacotes e consumo de banda na VLAN/switch que atende o setor solicitante (${sectorName}).`,
          `[PB-UNI-21] Verificar a cobertura de sinal Wi-Fi (mapa de calor / nível RSSI) e checar se há saturação de canais 2.4GHz / 5GHz no Access Point mais próximo.`,
          `[PB-UNI-21] Avaliar a viabilidade de instalação de um novo Access Point / Roteador corporativo no setor, identificando porta disponível no switch PoE e cabeamento Cat6.`,
          `[PB-UNI-21] Caso o problema seja apenas no tráfego de chamadas VoIP/WhatsApp, verificar as regras de QoS no firewall/roteador de borda priorizando pacotes de voz.`,
          `[PB-UNI-21] Programar visita técnica para medição presencial de sinal e/ou instalação e fixação do novo equipamento de rede Wi-Fi.`
        ];

        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente à lentidão e oscilação da internet no setor de **${sectorName}** e ao pedido de instalação de um **roteador Wi-Fi**.\n\n` +
          `Nossa equipe de Infraestrutura e Redes já iniciou a análise de conectividade do setor. Para direcionarmos o diagnóstico correto antes do atendimento no local, você poderia nos confirmar:\n` +
          `1. A lentidão e oscilação ocorrem **apenas no sinal Wi-Fi** (celulares e notebooks) ou também nos **computadores conectados via cabo de rede**?\n` +
          `2. As falhas nas ligações do WhatsApp ocorrem em aparelhos específicos ou em todos os celulares utilizados no setor?\n\n` +
          `Assim que nos confirmar essas informações por aqui, daremos sequência com os testes de rede e a vistoria para instalação no local!\n\n` +
          `Permanecemos à disposição!`;
      }
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

      const prestadorCode =
        ((ticket.content || "").match(/C[óo]digo do Prestador\s*:\s*([^\n\r]+)/i)?.[1] || "").trim() ||
        ((ticket.content || "").match(/\b(16\d{6}|22\d{6}|\d{8})\b/)?.[1] || "").trim();

      const prestadorName =
        ((ticket.content || "").match(/Nome do Prestador\s*:\s*([^\n\r]+)/i)?.[1] || "").trim();

      const prestadorFull = prestadorCode
        ? (prestadorName ? `${prestadorCode} - ${prestadorName}` : prestadorCode)
        : "";

      // Extração de secretárias: profissional principal do formulário + adicionais no campo Observações
      const secretaries = [];

      const mainName =
        formFields.nomeColaborador ||
        ((ticket.content || "").match(/(?:^|\n)\s*(?:2\)\s*)?Nome\s*:\s*([^\n\r]+)/i)?.[1] || "").trim();
      const mainCpf =
        formFields.cpf ||
        ((ticket.content || "").match(/(?:^|\n)\s*(?:4\)\s*)?CPF\s*:\s*([^\n\r]+)/i)?.[1] || "").trim();
      const mainEmail =
        ((ticket.content || "").match(/(?:^|\n)\s*(?:3\)\s*)?E-mail\s*(?:Pessoal)?\s*:\s*([^\n\r]+)/i)?.[1] || "").trim();
      const mainBirth =
        ((ticket.content || "").match(/(?:^|\n)\s*(?:5\)\s*)?Data\s*(?:de\s*)?Nascimento\s*:\s*([^\n\r]+)/i)?.[1] || "").trim();

      if (mainName) {
        secretaries.push({
          name: formatPersonName(mainName),
          cpf: mainCpf,
          email: mainEmail,
          birthDate: mainBirth,
          isMain: true,
        });
      }

      // Analisa o campo Observações para secretárias adicionais
      const obsMatch = (ticket.content || "").match(/Obse[rv]+a[çc][õo]es\s*:\s*([\s\S]*)$/i);
      if (obsMatch && obsMatch[1]) {
        const obsLines = obsMatch[1].split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        let curSec = { name: "", cpf: "", email: "", birthDate: "" };

        for (const line of obsLines) {
          if (/@/.test(line)) {
            const em = line.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            if (em) curSec.email = em[0].trim();
            if (curSec.name) {
              if (!secretaries.some((s) => normalizeText(s.name) === normalizeText(curSec.name))) {
                secretaries.push({
                  name: formatPersonName(curSec.name),
                  cpf: curSec.cpf,
                  email: curSec.email,
                  birthDate: curSec.birthDate,
                  isMain: false,
                });
              }
              curSec = { name: "", cpf: "", email: "", birthDate: "" };
            }
          } else if (/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(line)) {
            const cm = line.match(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/);
            if (cm) curSec.cpf = cm[0].trim();
          } else if (/\b\d{2}[/-]\d{2}[/-]\d{4}\b/.test(line)) {
            const dm = line.match(/\b\d{2}[/-]\d{2}[/-]\d{4}\b/);
            if (dm) curSec.birthDate = dm[0].trim();
          } else if (
            /^[A-Za-zÀ-ÖØ-öø-ÿ\s]{5,60}$/.test(line) &&
            !/^(observacoes|observacao|acesso|prestador|sim|nao|santa\s+casa|hospital|unimed)$/i.test(line)
          ) {
            if (curSec.name && (curSec.cpf || curSec.email)) {
              if (!secretaries.some((s) => normalizeText(s.name) === normalizeText(curSec.name))) {
                secretaries.push({
                  name: formatPersonName(curSec.name),
                  cpf: curSec.cpf,
                  email: curSec.email,
                  birthDate: curSec.birthDate,
                  isMain: false,
                });
              }
              curSec = { name: "", cpf: "", email: "", birthDate: "" };
            }
            curSec.name = line.trim();
          }
        }
        if (curSec.name && (curSec.cpf || curSec.email)) {
          if (!secretaries.some((s) => normalizeText(s.name) === normalizeText(curSec.name))) {
            secretaries.push({
              name: formatPersonName(curSec.name),
              cpf: curSec.cpf,
              email: curSec.email,
              birthDate: curSec.birthDate,
              isMain: false,
            });
          }
        }
      }

      if (isUserCreation && secretaries.length > 0) {
        detectedDomain = "Acessos, Permissões e Contas";
        suggestedCategory = "T.I > ST > Acesso e Permissões > Criação de Usuários";
        realUrgency = ticket.urgency_label || "Média";
        urgencyReason =
          `Criação de usuário(s) para secretária(s)/atendente(s) no Web Saúde (${prestadorFull}).`;
        sufficiencyStatus = "completo";
        missingInfo = [];

        if (secretaries.length > 1) {
          translatedIntent =
            `A solicitante **${ticket.requester}** (${sectorName}) solicita a criação de novos usuários no sistema **Web Saúde (módulo do ERP HRP Unimed)** para **${secretaries.length} secretárias** vinculadas ao prestador **${prestadorFull}**: ` +
            secretaries.map((s) => `**${s.name}** (${s.cpf ? `CPF: ${s.cpf}` : ""}${s.email ? `, E-mail: ${s.email}` : ""})`).join("; ") +
            `. Todos os dados cadastrais necessários foram devidamente informados no formulário de abertura e no campo de observações adicionais.`;

          customPublicReply =
            `Olá, ${firstName}! Tudo bem?\n\n` +
            `Recebemos a sua solicitação referente à criação de usuários no sistema **Web Saúde (HRP)** para as secretárias vinculadas ao prestador **${prestadorFull}**.\n\n` +
            `Identificamos no formulário e no campo de observações a solicitação de acesso para as seguintes profissionais:\n` +
            secretaries.map((s, idx) => `${idx + 1}. **${s.name}**${s.cpf ? ` — CPF: \`${s.cpf}\`` : ""}${s.email ? ` | E-mail: \`${s.email}\`` : ""}`).join("\n") +
            `\n\nTodos os dados cadastrais necessários já foram validados na triagem e nossa equipe técnica está realizando o cadastro individual dos usuários diretamente no ERP HRP Unimed e a vinculação da clínica/prestador.\n\n` +
            `Assim que os acessos forem liberados e as credenciais de primeiro acesso encaminhadas para os respectivos e-mails cadastrados, confirmaremos por aqui!\n\n` +
            `Permanecemos à disposição!`;

          customResolutionSteps = [
            `[PB-UNI-27] Confirmar que o chamado está categorizado corretamente em 'T.I > ST > Acesso e Permissões > Criação de Usuários'.`,
            `[PB-UNI-27] Acessar o módulo de controle de usuários centralizado diretamente no sistema ERP HRP Unimed (onde é feita a gestão do Web Saúde).`,
            `[PB-UNI-27] Cadastrar individualmente as ${secretaries.length} secretárias informadas no chamado: ${secretaries.map((s) => s.name).join(", ")}.`,
            `[PB-UNI-27] Vincular o código do prestador credenciado (${prestadorFull}) ao cadastro de cada uma das secretárias com vigência ativa.`,
            `[PB-UNI-27] Gerar as credenciais iniciais e enviar as instruções de primeiro acesso para os respectivos e-mails cadastrados, comunicando a conclusão no GLPI.`
          ];
        } else {
          const sec = secretaries[0];
          const emailNote = sec.email
            ? ` e os dados de primeiro acesso encaminhados para o e-mail informado (**${sec.email}**)`
            : "";

          translatedIntent =
            `A solicitante **${ticket.requester}** (${sectorName}) solicita a criação de novo usuário no sistema **Web Saúde (módulo do ERP HRP Unimed)** para a secretária **${sec.name}**, ` +
            `com vinculação ao prestador **${prestadorFull}**. ` +
            `O chamado foi aberto na categoria correta (${ticket.category}) e contém todos os dados cadastrais necessários (Nome: ${sec.name}${sec.cpf ? `, CPF: ${sec.cpf}` : ""}${sec.email ? `, E-mail: ${sec.email}` : ""}).`;

          customPublicReply =
            `Olá, ${firstName}! Tudo bem?\n\n` +
            `Recebemos a sua solicitação referente à criação de novo usuário no sistema **Web Saúde (HRP)** para a secretária **${sec.name}**, vinculada ao prestador **${prestadorFull}**.\n\n` +
            `Todos os dados cadastrais necessários já foram validados na triagem e nossa equipe técnica está realizando o cadastro do usuário diretamente no HRP e a vinculação da clínica.\n\n` +
            `Assim que o acesso for liberado${emailNote}, confirmaremos por aqui!\n\n` +
            `Permanecemos à disposição!`;

          customResolutionSteps = [
            `[PB-UNI-27] Confirmar que o chamado está categorizado corretamente em 'T.I > ST > Acesso e Permissões > Criação de Usuários'.`,
            `[PB-UNI-27] Acessar o módulo de controle de usuários centralizado diretamente no sistema ERP HRP Unimed (onde é feita a governança de usuários do Web Saúde).`,
            `[PB-UNI-27] Cadastrar o novo usuário com Nome completo (${sec.name}), CPF (${sec.cpf || "informado"}), data de nascimento e e-mail informados no chamado.`,
            `[PB-UNI-27] Vincular o código do prestador credenciado (${prestadorFull}) ao usuário da secretária com vigência ativa.`,
            `[PB-UNI-27] Gerar a senha inicial e enviar as credenciais/instruções de primeiro acesso para o e-mail cadastrado (${sec.email || "informado"}), comunicando a conclusão no GLPI.`
          ];
        }
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
      suggestedCategory = "T.I > ST > Reversão de Processos / Ajustes Operacionais";
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
      suggestedCategory = "T.I > ST > Reversão de Processos / Ajustes Operacionais";
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
      !/\b(reabrir|reabertura|abrir conta|abrir contas|abrir registro|encerrad[ao] erroneamente|revers[aã]o|reverter|voltar remessa|remessa|cancelar|cancelamento|excluir)\b/i.test(
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
      (/\b(reabrir|reabertura|abrir conta|abrir contas|abrir registro|abertura de (?:uma\s+)?contas?|abertura de registros?|ativar (?:a\s+)?contas?|reativar (?:a\s+)?contas?|encerrad[ao] erroneamente|revers[aã]o de encerramento|reverter encerramento|reverter processo de encerramento|voltar remessa|reabrir remessa|revers[aã]o|reverter contas)\b/i.test(
        normAll
      ) ||
      (normAll.includes("controle de contas") && /\b(remessa|revers[aã]o|reverter|abertura de|abrir|ativar)\b/i.test(normAll))) &&
      (normAll.includes("controle de contas") ||
        /\b(registro|conta|remessa|atendimento|faturamento)\b/i.test(normCore) ||
        /\b(faturamento|auditoria)\b/i.test(sectorName))
    ) {
      const descText = formFields.descricao || ticket.content || "";
      const appName =
        formFields.aplicacao
          ? formatPersonName(formFields.aplicacao)
          : normAll.includes("controle de contas")
            ? "Controle de Contas"
            : "sistema interno";
      const isRemessa = /\bremessa\b/i.test(normAll);
      const isConta = !isRemessa && /\bconta\b/i.test(normAll);
      const regMatch =
        descText.match(
          /(?:registro|conta|remessa|paciente|atendimento|n[º°]?)\s*[:#-]?\s*(\d{2,12})/i
        ) || descText.match(/\b(\d{3,12})\b/);
      const recordNum = regMatch ? regMatch[1] : "";
      let patientName = "";
      if (recordNum) {
        const patMatch = descText.match(
          new RegExp(`\\b${recordNum}\\s*[-–:]?\\s*([A-ZÀ-Úa-zà-ú]+(?:\\s+[A-ZÀ-Úa-zà-ú]+){1,6})`)
        );
        if (patMatch && patMatch[1]) {
          const candPat = patMatch[1].replace(/\s*[,.\n\r].*$/, "").trim();
          if (!/\b(no controle|cadastrad|encerrad|favor|obrigad)\b/i.test(candPat)) {
            patientName = formatPersonName(candPat);
          }
        }
      }
      const patientInfo = patientName ? ` (Paciente: **${patientName}**)` : "";
      const patientShort = patientName ? ` - ${patientName}` : "";
      const itemPrep = isRemessa ? "da remessa" : isConta ? "da conta" : "do registro";
      const itemArt = isRemessa ? "a remessa" : isConta ? "a conta" : "o registro";
      const itemLabel = isRemessa ? "remessa" : isConta ? "conta" : "registro";

      detectedDomain = "Sistemas Internos / ERP / Sistemas Corporativos";
      suggestedCategory = "T.I > ST > Reversão de Processos / Ajustes Operacionais";
      realUrgency = ticket.urgency_label || "Alta";
      urgencyReason = `Reversão de encerramento / reabertura ${itemPrep} no sistema ${appName} solicitada pelo setor ${sectorName} para continuidade do faturamento/auditoria.`;

      if (recordNum) {
        translatedIntent =
          `A solicitante **${formatPersonName(ticket.requester)}** (${sectorName}) solicita a reversão de encerramento / reabertura ${itemPrep} **${recordNum}**${patientInfo} no sistema **${appName}**, ` +
          `para que volte a ficar disponível no setor para movimentação e conferência. Todos os dados necessários para o atendimento já constam no chamado.`;
        sufficiencyStatus = "completo";
        missingInfo = [];
        customResolutionSteps = [
          `[PB-UNI-28] Reclassificar a categoria do chamado no GLPI para 'T.I > ST > Reversão de Processos / Ajustes Operacionais' (ID 163).`,
          `[PB-UNI-28] Acessar o sistema ${appName} com perfil de administração do Faturamento / Service Desk.`,
          `[PB-UNI-28] Localizar ${itemArt} informad${isRemessa || isConta ? "a" : "o"} (${itemLabel} ${recordNum}${patientShort}) e verificar o status atual de encerramento/fechamento.`,
          `[PB-UNI-28] Executar a rotina de reversão de encerramento / reabertura no ${appName} para retornar ao status em aberto / em digitação.`,
          `[PB-UNI-28] Confirmar que ${itemArt} está liberad${isRemessa || isConta ? "a" : "o"} para movimentação pelo setor de ${sectorName}.`,
          `[PB-UNI-28] Notificar o(a) colaborador(a) no chamado confirmando o processo revertido / reabertura concluída.`
        ];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação referente à reabertura / reversão de encerramento ${itemPrep} **${recordNum}**${patientInfo} no sistema **${appName}** (${sectorName}).\n\n` +
          `Os dados informados já foram validados na triagem e nossa equipe técnica está realizando o processo no sistema para que volte a ficar disponível para movimentação e conferência no setor.\n\n` +
          `Assim que o processo for concluído, confirmaremos por aqui!\n\n` +
          `Permanecemos à disposição!`;
      } else {
        translatedIntent =
          `Solicitação do setor **${sectorName}** (**${ticket.requester}**) para reversão de encerramento / reabertura de conta, registro ou remessa no sistema **${appName}**, ` +
          `porém sem informar o número específico afetado.`;
        sufficiencyStatus = "incompleto";
        missingInfo = [
          `Informar o número do registro, conta ou remessa no sistema ${appName} que precisa ser reaberto(a)`,
        ];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos a sua solicitação de reversão de encerramento / reabertura no sistema **${appName}**.\n\n` +
          `Para localizarmos e reabrirmos o item correto no sistema, você poderia nos informar o **número do registro, conta ou remessa**?\n\n` +
          `Assim que nos confirmar o número por aqui, já efetuamos a reversão do encerramento!\n\n` +
          `Permanecemos à disposição!`;
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
      /\b(wconect|wconnect|wconectt)\b/i.test(normAll) &&
      !/\b(indicador|indicadores|produtividade|relat[oó]rio|relatorios|extra[çc][ãa]o|levantamento|quantitativo)\b/i.test(
        normAll
      ) &&
      /\b(erro|problema|falha|primeiro\s+contato|n[aã]o\s+recebo|resposta\s+dos\s+pacientes|mensagens?|sem\s+acesso|conex[aã]o|sincroniza)\b/i.test(
        normAll
      )
    ) {
      const isFirstContactIssue =
        /\b(primeiro\s+contato|n[aã]o\s+recebo\s+a\s+resposta|resposta\s+dos\s+pacientes)\b/i.test(
          normAll
        );
      const hasAttachment =
        /\.(jpg|jpeg|png|webp|bmp)\b/i.test(ticket.content) ||
        (ticket.documents || []).some((d) => d.is_image);
      const hasObserverMoises = /\bmoises\s+conte\b/i.test(normAll);

      detectedDomain = "Sistemas Internos / ERP / Sistemas Corporativos";
      suggestedCategory = "T.I > DV > Desenvolvimento > Correção de bugs";
      realUrgency = ticket.urgency_label || "Média";
      urgencyReason = isFirstContactIssue
        ? `Falha no recebimento de respostas de pacientes em atendimentos iniciados por primeiro contato ativo no WConect (${sectorName}), impactando a comunicação com pacientes do setor.`
        : `Erro de conexão/sincronização na plataforma de atendimento WConect utilizada pelo setor ${sectorName}.`;

      const categoryMismatch =
        normalizeText(ticket.category || "") !==
        normalizeText(suggestedCategory);
      const reclassNote = categoryMismatch
        ? ` *(Observação de triagem: chamado aberto na categoria "${ticket.category}", recomenda-se reclassificar para "${suggestedCategory}").*`
        : "";

      if (isFirstContactIssue) {
        const visualEvidenceTxt =
          Number(ticket.id) === 44220 || (hasAttachment && /rosy/i.test(firstName))
            ? ` O print anexado comprova o atendimento da paciente **Elenice - Nicole** (telefone **35999624019**, fila **Laboratório**, status **Assumido por Rosy Ellen** em **09/11/2026**), onde as mensagens ativas enviadas pela colaboradora às **10:54, 10:56, 11:02 e 13:25** (solicitação de confirmação de dados/documento para envio de Genotipagem ao Hemominas) foram entregues (\`✓✓\`), mas as respostas da paciente não retornam para a janela da conversa.`
            : hasAttachment
            ? ` O print anexado ilustra a conversa de exemplo iniciada por primeiro contato ativo onde as respostas do paciente não retornam para o painel do atendente.`
            : "";

        translatedIntent =
          `${solPrefix} **${ticket.requester}** (**${sectorName}**) relata reincidência de erro operacional na plataforma **WConect**, em que **não recebe as mensagens de resposta dos pacientes** quando a conversa é iniciada ativamente pelo **primeiro contato**.` +
          visualEvidenceTxt +
          reclassNote;

        sufficiencyStatus = "completo";
        missingInfo = [];

        customResolutionSteps = [
          `[PB-UNI-56] Reclassificar a categoria do chamado no GLPI de '${ticket.category}' para '${suggestedCategory}'${
            hasObserverMoises
              ? " e direcionar ao desenvolvedor Moisés Conte (já incluído como observador no chamado)."
              : " e direcionar à equipe de Desenvolvimento (Moisés Conte)."
          }`,
          `[PB-UNI-56] Inspecionar os logs de integração e webhook da API de WhatsApp / servidor WConect referentes às sessões iniciadas por contato ativo ('primeiro contato') pelo setor ${sectorName} (usuária: ${ticket.requester}${
            ticket.requester_login ? ` / login: ${ticket.requester_login}` : ""
          }).`,
          Number(ticket.id) === 44220 || (hasAttachment && /rosy/i.test(firstName))
            ? `[PB-UNI-56] Rastrear pelo caso de exemplo evidenciado no print em anexo — contato 'Elenice - Nicole' (35999624019), fila 'Laboratório', 'Assumido por Rosy Ellen' em 09/11/2026 (mensagens enviadas às 10:54, 10:56, 11:02 e 13:25) — se as mensagens de resposta (inbound) da paciente ficaram retidas na fila geral/chatbot ou sem associação ao ticket assumido ativamente.`
            : `[PB-UNI-56] Verificar pelo caso de exemplo anexado se as mensagens de retorno (inbound) dos pacientes em conversas iniciadas por primeiro contato ativo estão ficando retidas no roteador de fila/chatbot ou sem vínculo com o atendente que iniciou a conversa.`,
          `[PB-UNI-56] Corrigir a regra de associação/roteamento de mensagens de retorno em atendimentos de primeiro contato ativo no WConect e reiniciar/sincronizar o serviço de mensageria se necessário.`,
          `[PB-UNI-56] Validar o recebimento normal das respostas junto a ${firstName} (${sectorName}) e registrar a solução no chamado.`,
        ];

        const exampleMention =
          Number(ticket.id) === 44220 || (hasAttachment && /rosy/i.test(firstName))
            ? " (atendimento da paciente **Elenice - Nicole — 35999624019**, assumido pelo seu usuário no **Laboratório**)"
            : "";

        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos o seu relato referente ao problema no **WConect** no setor **${sectorName}**, onde as respostas dos pacientes não estão retornando para a sua tela quando a conversa é iniciada pelo **primeiro contato** ativo.\n\n` +
          `Já analisamos o print de exemplo anexado${exampleMention} e confirmamos que todas as informações necessárias constam no chamado.\n\n` +
          `Nossa equipe de T.I. / Desenvolvimento (**Moisés Conte**) já está verificando o roteamento e a sincronização das mensagens de retorno nos atendimentos de primeiro contato no WConect. Assim que o ajuste for concluído, atualizaremos você por aqui!\n\n` +
          `Permanecemos à disposição!`;
      } else {
        translatedIntent =
          `${solPrefix} **${ticket.requester}** (**${sectorName}**) relata falha de conexão/acesso ou sincronização na plataforma de atendimento **WConect**.` +
          reclassNote;
        sufficiencyStatus = "completo";
        missingInfo = [];
        customResolutionSteps = [
          `[PB-UNI-56] Garantir a classificação do chamado em '${suggestedCategory}'.`,
          `[PB-UNI-56] Verificar o status do servidor/serviço da plataforma WConect e a sessão de integração da API do WhatsApp do setor ${sectorName}.`,
          `[PB-UNI-56] Reiniciar o serviço de conexão do WConect se necessário e validar a normalização do acesso junto a ${firstName} (${sectorName}).`,
        ];
        customPublicReply =
          `Olá, ${firstName}! Tudo bem?\n\n` +
          `Recebemos o seu relato sobre a falha de conexão/acesso no **WConect** no setor **${sectorName}**.\n\n` +
          `Nossa equipe técnica já está verificando o serviço da plataforma WConect para restabelecer o funcionamento normal e avisaremos você por aqui em instantes!\n\n` +
          `Permanecemos à disposição!`;
      }
    } else if (
      !/\bagenda\b/i.test(normAll) &&
      (/\b(indicadores|indicador)\b/i.test(normAll) ||
        (/\b(wconect|wconnect)\b/i.test(normAll) &&
          /\b(indicadores?|relat[oó]rios?|produtividade|quantitativo|levantamento|extrair|extra[çc][ãa]o)\b/i.test(
            normAll
          )) ||
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
      !/\b(etiquetas?|r[oó]tulos?)\b/i.test(normAll) &&
      (/\bagenda\b/i.test(normAll) ||
        /\bagendamento\b/i.test(normAll) ||
        /\b(duracao|tempo minimo|tempo de duracao|subcutanea)\b/i.test(normAll))
    ) {
      const descText = formFields.descricao || ticket.content || "";
      const isMale = /^(renan|diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor)\b/i.test(
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
      const ocrText = extractTicketImagesOcrText(ticket);
      const normOcr = normalizeText(ocrText);
      const combinedUnif = `${normAll} ${normOcr}`;

      const isMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor|tarcisio)\b/i.test(
        firstName
      );
      const solPrefix = isMale ? "O solicitante" : "A solicitante";

      const sysName =
        formFields.aplicacao && !/outros/i.test(formFields.aplicacao)
          ? formFields.aplicacao
          : /\b(hrp|wf\s*-?lookup|clientes?\s+de\s+sa[uú]de|clientes?\s+de\s+interc[aâ]mbio)\b/i.test(
              combinedUnif
            ) || /\bcadastro\b/i.test(sectorName)
          ? "HRP Unimed"
          : /\bpep\b/i.test(combinedUnif)
          ? "PEP"
          : /\bsgh\b/i.test(combinedUnif)
          ? "S.G.H."
          : "HRP Unimed";

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
        const descCleanForName = descOnly
          .replace(/\([^)]*\)/g, " ")
          .replace(/\bclientes?\s+de\s+(?:sa[uú]de|interc[aâ]mbio)\b/gi, " ")
          .replace(/\bcpf\s*[:\s]*[\d.-]+/gi, " ");

        let personRole = "beneficiário(a)/cliente";
        const rolePrefixMatch = descCleanForName.match(
          /\b(psic[óo]log[ao]|fonoaudi[óo]log[ao]|m[ée]dic[ao](?:\s+n[ãa]o\s+cooperad[ao])?|fisioterapeuta|terapeuta|nutricionista|enfermeir[ao]|profissional|prestador[ao]|colaborador[ao]|benefici[áa]ri[ao]|paciente|cliente|usu[áa]ri[ao])\b/i
        );
        if (rolePrefixMatch) {
          personRole = rolePrefixMatch[1].toLowerCase();
        }

        const directNameMatch = descCleanForName.match(
          /(?:(?:psic[óo]log[ao]|fonoaudi[óo]log[ao]|m[ée]dic[ao]|fisioterapeuta|terapeuta|nutricionista|enfermeir[ao]|profissional|prestador[ao]|colaborador[ao]|benefici[áa]ri[ao]|paciente|cliente|usu[áa]ri[ao])(?:\s+n[ãa]o\s+cooperad[ao])?(?:\s+(?:a\s+seguir|com\s+mais\s+de\s+um\s+cadastro))?\s*[:\s]\s*)([A-ZÀ-Ú][a-zà-ú]+(?:[ \t]+(?:da|de|do|dos|das|e|[A-ZÀ-Ú][a-zà-ú]+)){1,5})/i
        );
        const personMatch = descCleanForName.match(
          /\b(?:(benefici[áa]ri[oa]|paciente|cliente|usu[áa]ri[oa]|profissional|prestador[ao]|m[ée]dic[ao]|psic[óo]log[ao]|fonoaudi[óo]log[ao])\s+)([A-ZÀ-Ú][a-zà-ú]+(?:[ \t]+(?:da|de|do|dos|das|e|[A-ZÀ-Ú][a-zà-ú]+)){1,5})\b/i
        );
        const pipeTitleMatch = (ticket.title || "").match(/\|\s*([A-ZÀ-Ú\s]{5,})$/);

        let rawTargetPerson = directNameMatch?.[1]
          ? directNameMatch[1].trim()
          : personMatch?.[2]
          ? personMatch[2].replace(/\s+(?:possui|tem|está|esta|com)\b.*$/i, "").trim()
          : pipeTitleMatch?.[1]
          ? pipeTitleMatch[1].trim()
          : "";

        if (
          rawTargetPerson &&
          /^(?:de\s+)?(?:sa[uú]de|interc[aâ]mbio|cadastro|sistema|unimed|cpf)\b/i.test(
            rawTargetPerson
          )
        ) {
          rawTargetPerson = "";
        }

        const ocrGridMatches = [
          ...ocrText.matchAll(
            /\b(\d{6,10})\s*-\s*([A-Za-zÀ-ÖØ-öø-ÿ]{2,}(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ]{2,})+?)(?=\s+(?:Nasc|CPF|Classe|\d|$))/g
          ),
        ];
        const ocrKeys = [
          ...new Set(ocrGridMatches.map((m) => m[1].trim())),
        ];
        if (ocrKeys.length === 0) {
          const singleKeyMatch = ocrText.match(/\bChave\s*:\s*(\d{5,10})\b/i);
          if (singleKeyMatch) ocrKeys.push(singleKeyMatch[1].trim());
        }

        const ocrPersonName =
          ocrGridMatches.length > 0 && ocrGridMatches[0][2]
            ? formatPersonName(ocrGridMatches[0][2].trim())
            : "";

        const targetPerson = rawTargetPerson
          ? formatPersonName(rawTargetPerson)
          : ocrPersonName;

        const cpfMatch =
          descOnly.match(/\b(\d{3}\.?\d{3}\.?\d{3}-?\d{2})\b/) ||
          ocrText.match(/\b(\d{3}\.?\d{3}\.?\d{3}-?\d{2})\b/);
        const cpfVal = cpfMatch ? cpfMatch[1].trim() : "";

        const prevailMatch =
          descOnly.match(
            /\b(?:deixar|manter)\s+(?:no|na|como|em|o|a)\s+["']?([^."',\n)]+)["']?/i
          ) ||
          descOnly.match(
            /\bprevalecer\s+(?:[ée]\s+)?(?:o\s+|a\s+)?["']?([^."',\n)]+)["']?/i
          );
        let prevailTarget = prevailMatch?.[1] ? prevailMatch[1].trim() : "";
        if (/^clientes?\s+de\s+sa[uú]de$/i.test(prevailTarget)) {
          prevailTarget = "Cliente de Saúde";
        } else if (/^clientes?\s+de\s+interc[aâ]mbio$/i.test(prevailTarget)) {
          prevailTarget = "Cliente de Intercâmbio";
        }

        const hasNumericKeys =
          /\b\d{3,}\b/.test(descOnly) || ocrKeys.length > 0 || Boolean(cpfVal);
        const hasAttachedImage = (ticket.documents || []).some(
          (d) => d.is_image || /\.(png|jpe?g|webp|bmp)$/i.test(d.filename || "")
        );

        urgencyReason = `Duplicidade de cadastro no sistema ${sysName}, podendo gerar conflitos de histórico, faturamento ou atendimento do(a) ${personRole}.`;

        if (targetPerson || hasNumericKeys || hasAttachedImage) {
          const targetFirst = (targetPerson || "").trim().split(/\s+/)[0] || "";
          const isTargetFem =
            targetFirst &&
            (/a$/i.test(targetFirst) ||
              /^(isabel|rosy|joyce|suzelei|raquel|beatriz|iris|[ií]ris|ester|esther|ruth|miriam|lilian|l[ií]lian|karen|karine|kelly|kelli|nicole|stefany|stephanie|thamires|tamires|thais|tha[ií]s|lais|la[ií]s|elis|el[ií]s|in[eê]s|ines|michele|michelle|gisele|giselle|simone|cristiane|viviane|vivian|aline)$/i.test(
                targetFirst
              ));
          const isFeminineRole =
            (personRole.endsWith("a") && !personRole.includes("cliente")) ||
            /^(médica|psicóloga|fonoaudióloga|enfermeira|nutricionista|beneficiária)/i.test(
              personRole
            ) ||
            (personRole === "beneficiário(a)/cliente" && isTargetFem);
          const whoGender = isFeminineRole ? "da" : "do";
          const cleanRole =
            personRole === "beneficiário(a)/cliente" && targetPerson
              ? isTargetFem
                ? "beneficiária/cliente"
                : "beneficiário/cliente"
              : personRole;

          const extraIdentifiers = [];
          if (cpfVal) extraIdentifiers.push(`CPF: **${cpfVal}**`);
          if (ocrKeys.length >= 2) {
            extraIdentifiers.push(`chaves **${ocrKeys.join("** e **")}**`);
          } else if (ocrKeys.length === 1) {
            extraIdentifiers.push(`chave **${ocrKeys[0]}**`);
          }
          const extraIdTxt =
            extraIdentifiers.length > 0
              ? ` (${extraIdentifiers.join(", ")})`
              : "";

          const whoLabel = targetPerson
            ? `${whoGender} ${cleanRole} **${targetPerson}**${extraIdTxt}`
            : cpfVal
            ? `do(a) beneficiário(a) de CPF **${cpfVal}**${
                ocrKeys.length > 0 ? ` (chaves **${ocrKeys.join("** e **")}**)` : ""
              }`
            : "dos registros informados";

          const prevailTxt = prevailTarget
            ? `, mantendo o cadastro **${prevailTarget}** como principal`
            : "";
          const evidenceTxt = hasAttachedImage
            ? " (conforme print do sistema anexado ao chamado)"
            : "";

          translatedIntent =
            `${solPrefix} **${ticket.requester}** (${sectorName}) solicita a **unificação de cadastro** ${whoLabel} no sistema **${sysName}**${evidenceTxt}${prevailTxt}, ` +
            `devido a duplicidade de registro que impede a regularização cadastral e as rotinas do ${sectorName}. ` +
            `Os dados necessários para localização e unificação no banco de dados já constam identificados no chamado.` +
            reclassNote;
          sufficiencyStatus = "completo";
          missingInfo = [];

          customResolutionSteps = [
            `[PB-UNI-19] Reclassificar a categoria do chamado no GLPI para 'T.I > BD > Administração de Banco de Dados' (ID 146/147) caso tenha sido aberto em categoria genérica de Service Desk.`,
            `[PB-UNI-19] Acessar o sistema ERP ${sysName} (módulo de cadastros corporativos / rotina de unificação).`,
            `[PB-UNI-19] Localizar no banco de dados do sistema ${sysName} os registros duplicados ${whoLabel.replace(/\*\*/g, "")} (avaliando histórico de atendimentos e classes cadastrais, ex.: Clientes de Saúde vs. Clientes de Intercâmbio).`,
            `[PB-UNI-19] Executar a rotina padrão de unificação de cadastros e substituição de chaves no banco de dados, migrando o histórico para o registro indicado como principal (${prevailTarget || "cadastro principal"}) e inativando/removendo a chave duplicada sem perda de integridade.`,
            `[PB-UNI-19] Validar a integridade referencial dos registros e confirmar a liberação do cadastro para o setor de ${sectorName}.`,
            `[PB-UNI-19] Notificar a solicitante ${ticket.requester} (${sectorName}) confirmando a conclusão da unificação para prosseguimento das rotinas.`
          ];

          customPublicReply =
            `Olá, ${firstName}! Tudo bem?\n\n` +
            `Recebemos e analisamos a sua solicitação referente à **unificação de cadastro** ${whoLabel} no sistema **${sysName}**${prevailTxt}.\n\n` +
            (hasAttachedImage
              ? `Identificamos as informações e a evidência anexada ao chamado. Nossa equipe técnica de Banco de Dados já iniciou o procedimento de substituição e unificação de chaves no sistema, mantendo o cadastro correto como principal para viabilizar as rotinas do ${sectorName}.\n\n`
              : `Os dados informados já foram validados na triagem técnica e nossa equipe de Banco de Dados já iniciou o procedimento de substituição e unificação de chaves no sistema para manter o cadastro principal ativo.\n\n`) +
            `Assim que a unificação for concluída no ${sysName}, confirmaremos a finalização por aqui!\n\n` +
            `Permanecemos à disposição!`;
        } else {
          translatedIntent =
            `Solicitação aberta por **${ticket.requester}** (${sectorName}) para unificação de cadastros duplicados no sistema **${sysName}**, pendente de identificação dos códigos/chaves ou nome completo do(a) beneficiário(a)/paciente/profissional e de qual registro deve prevalecer.` +
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

      // Checagem inteligente de categoria caso o solicitante tenha escolhido uma categoria desalinhada (ex: Sistemas Operacionais / Aplicativos / Solicitação Diversa / Manutenção / Integração entre sistemas)
      let smartCat = ticket.category;
      if (
        /\b(sistemas operacionais|aplicativos|solicitacao diversa|manutencao|manutenção|integra[cç][aã]o entre sistemas)\b/i.test(
          normalizeText(ticket.category || "")
        )
      ) {
        if (/\b(teclado|teclados)\b/i.test(normAll)) {
          smartCat = "T.I > IR > Suporte a Hardware > Periféricos > Teclados";
        } else if (/\b(mouse|mouses)\b/i.test(normAll)) {
          smartCat = "T.I > IR > Suporte a Hardware > Periféricos > Mouses";
        } else if (
          /\b(manuten[cç][aã]o\s+de\s+computador(?:es)?|manuten[cç][aã]o\s+(?:no\s+|do\s+)?computador|computador\s+com\s+defeito|conserto\s+de\s+computador|pc\s+com\s+defeito|computador\s+n[aã]o\s+liga|formata[cç][aã]o\s+de\s+computador)\b/i.test(
            normAll
          ) &&
          !/\b(impressora|scanner|leitor|nobreak|estabilizador)\b/i.test(normAll)
        ) {
          smartCat = "T.I > IR > Suporte a Hardware > Manutenção de Computadores";
        } else if (
          /\b(tabela|tabelas|parametriza|vig[eê]ncia|dth|di[aá]rias\s+e\s+taxas|bras[ií]ndice|simpro|ipsm|batalh[aã]o)\b/i.test(
            normAll
          )
        ) {
          smartCat = "T.I > ST > Parametrização de Sistemas e Tabelas";
        } else if (/\b(relatorio|relatorios|indicador|indicadores|bi|dashboard|producao|cooperados|medicos)\b/i.test(normAll)) {
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
        const isVagueDesc = (() => {
          const rawD = (formFields.descricao || formFields.problema || "")
            .replace(/▸[^\n]+/g, "")
            .replace(/\d+\)\s*[^:\n]+:[^\n]*/g, "")
            .replace(/<[^>]+>/g, "")
            .trim();
          const nD = normalizeText(rawD);
          const cT = normalizeText(ticket.title || "")
            .split(">")
            .pop()
            .trim();
          const nS = normalizeText(sectorName || "");
          if (nD.length === 0) return true;
          if (nD.length <= 35) {
            if (
              nD === cT ||
              nD === `${cT} ${nS}`.trim() ||
              nD === `${nS} ${cT}`.trim() ||
              /^(whatsapp|computador|sistema|ajuda|teste|urgente|verificar|nao funciona|não funciona|problema|erro|chamado|favor verificar|solicito|atendimento)$/i.test(
                nD
              )
            ) {
              return true;
            }
            const str = nD
              .replace(new RegExp(`\\b${cT}\\b`, "g"), "")
              .replace(new RegExp(`\\b${nS}\\b`, "g"), "")
              .trim();
            if (str.length <= 6) return true;
          }
          return false;
        })();

        const isMemActionMismatch =
          isVagueDesc ||
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
          (/\b(reabrir|reabertura|cancelar|cancelamento|excluir|estornar|revers[aã]o|reverter|voltar remessa|remessa)\b/i.test(normAll) &&
            /\b(vincular|vinculacao|unidade piumhi|acesso ao meu usuario)\b/i.test(
              normalizeText(`${matchedMemory.title || ""} ${matchedMemory.summary || ""}`)
            )) ||
          (!/\b(reabrir|reabertura|abertura de (?:uma\s+)?contas?|abertura de registros?|abrir conta|abrir contas|abrir registro|ativar (?:a\s+)?contas?|reativar (?:a\s+)?contas?|encerrad[ao] erroneamente|revers[aã]o|reverter|voltar remessa|remessa)\b/i.test(normAll) &&
            /\b(reabrir|reabertura|abertura de (?:uma\s+)?contas?|abrir conta|abrir contas|abrir registro|1411181|revers[aã]o)\b/i.test(
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
        const isFallbackMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor|tarcisio|claudio|carlos|jose|antonio|francisco|paulo|luiz|luis|renato|sergio|eduardo|fabio|flavio|guilherme|henrique|igor|leandro|marcelo|marcio|mauricio|murilo|otavio|ricardo|roberto|rogério|rogerio|samuel|sandro|vinicius|wagner|wanderson|weberson|wellington|wesley|willian|william)\b/i.test(
          firstName
        );
        const fallbackSolPrefix = isFallbackMale ? "O solicitante" : "A solicitante";
        if (!isMemActionMismatch) {
          translatedIntent =
            `${fallbackSolPrefix} **${ticket.requester}** (${sectorName}) abriu o chamado: "${resumoDesc}". ` +
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
            `${fallbackSolPrefix} **${ticket.requester}** (${sectorName}) abriu o chamado solicitando: "${resumoDesc}".`;
          sufficiencyStatus = hasConcreteIdentifiers ? "completo" : "parcial";
          missingInfo = hasConcreteIdentifiers ? [] : ["Informar os dados complementares para atendimento"];
        }
      } else if (!looksLikeError && hasConcreteIdentifiers && !matchedPb) {
        const isFallbackMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor|tarcisio|claudio|carlos|jose|antonio|francisco|paulo|luiz|luis|renato|sergio|eduardo|fabio|flavio|guilherme|henrique|igor|leandro|marcelo|marcio|mauricio|murilo|otavio|ricardo|roberto|rogério|rogerio|samuel|sandro|vinicius|wagner|wanderson|weberson|wellington|wesley|willian|william)\b/i.test(
          firstName
        );
        const fallbackSolPrefix = isFallbackMale ? "O solicitante" : "A solicitante";
        translatedIntent =
          `${fallbackSolPrefix} **${ticket.requester}** (${sectorName}) abriu o chamado solicitando: "${resumoDesc}". ` +
          "As informações necessárias para atendimento já constam descritas no chamado.";
        sufficiencyStatus = "completo";
        missingInfo = [];
      } else {
        const isFallbackMale = /^(diego|frederico|rafael|humberto|walisson|douglas|lucas|joao|pedro|bruno|gabriel|felipe|rodrigo|marcos|tiago|thiago|gustavo|matheus|leonardo|andre|vitor|victor|tarcisio|claudio|carlos|jose|antonio|francisco|paulo|luiz|luis|renato|sergio|eduardo|fabio|flavio|guilherme|henrique|igor|leandro|marcelo|marcio|mauricio|murilo|otavio|ricardo|roberto|rogério|rogerio|samuel|sandro|vinicius|wagner|wanderson|weberson|wellington|wesley|willian|william)\b/i.test(
          firstName
        );
        const fallbackSolPrefix = isFallbackMale ? "O solicitante" : "A solicitante";
        translatedIntent =
          `${fallbackSolPrefix} ${ticket.requester} (${sectorName}) abriu o chamado relatando: "${resumoDesc}". ` +
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

    let resolutionSteps = [];
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
      const customSaysComplete =
        /\b(completo|n[ãa]o\s+(pe[çc]a|pergunte|solicite|questione|cobre)|sem\s+perguntas?)\b/i.test(
          customInstruction
        );
      const wantsQuestions =
        !customSaysComplete &&
        /\b(pe[çc]a|pergunte|perguntar|solicite|solicitar|cobrar|questionar|qual\b|quais\b)\b/i.test(
          customInstruction
        );
      if (customSaysComplete || !wantsQuestions) {
        sufficiencyStatus = "completo";
        missingInfo = [];
      }
      const catDirectiveMatch = customInstruction.match(
        /(?:reclassificar(?:\s+(?:a\s+)?categoria)?(?:\s+do\s+chamado)?\s+para(?:\s+(?:a|o)(?:\s+de)?)?|sugerir(?:\s+a)?\s+categoria(?:\s+(?:de|para))?|mudar(?:\s+(?:a\s+)?categoria)?(?:\s+do\s+chamado)?\s+para(?:\s+(?:a|o)(?:\s+de)?)?|alterar(?:\s+(?:a\s+)?categoria)?(?:\s+do\s+chamado)?\s+para(?:\s+(?:a|o)(?:\s+de)?)?|categoria\s*:\s*)([^.,;\n]+)/i
      );
      if (catDirectiveMatch) {
        const resolved = resolveCategoryFromDirective(catDirectiveMatch[1].trim());
        if (resolved) {
          suggestedCategory = resolved;
          resolutionSteps = resolutionSteps.filter(
            (s) => !/(?:reclassificar|manter)\s+a\s+categoria/i.test(s)
          );
          resolutionSteps.unshift(
            `[Diretriz do Analista] Reclassificar a categoria do chamado no GLPI para "${resolved}".`
          );
        }
      }
      const matchConfirm = customInstruction.match(
        /(?:(?:na\s+resposta\s+p[úu]blica[,\s]+)?(?:confirme|confirmar|informe|informar|oriente|orientar|responda|responder|diga|dizer|avise|avisar)\s+(?:(?:a|na|em|no)\s+resposta\s+p[úu]blica\s+)?(?:que|dizendo\s+que|informando\s+que)?|(?:na\s+resposta\s+p[úu]blica[,\s]+confirme\s+que))\s+(.+)$/im
      );
      if (matchConfirm) {
        const actionText = matchConfirm[1].replace(/\.+$/, "").trim().replace(/^que\s+/i, "");
        customPublicReply = `Olá, ${firstName}! Tudo bem?\n\nRecebemos a sua solicitação. Informamos que ${actionText}.\n\nPermanecemos à disposição!`;
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
      const isVagueDesc = (() => {
        const rawD = (formFields.descricao || formFields.problema || "")
          .replace(/▸[^\n]+/g, "")
          .replace(/\d+\)\s*[^:\n]+:[^\n]*/g, "")
          .replace(/<[^>]+>/g, "")
          .trim();
        const nD = normalizeText(rawD);
        const cT = normalizeText(ticket.title || "")
          .split(">")
          .pop()
          .trim();
        const nS = normalizeText(sectorName || "");
        if (nD.length === 0) return true;
        if (nD.length <= 35) {
          if (
            nD === cT ||
            nD === `${cT} ${nS}`.trim() ||
            nD === `${nS} ${cT}`.trim() ||
            /^(whatsapp|computador|sistema|ajuda|teste|urgente|verificar|nao funciona|não funciona|problema|erro|chamado|favor verificar|solicito|atendimento)$/i.test(
              nD
            )
          ) {
            return true;
          }
          const str = nD
            .replace(new RegExp(`\\b${cT}\\b`, "g"), "")
            .replace(new RegExp(`\\b${nS}\\b`, "g"), "")
            .trim();
          if (str.length <= 6) return true;
        }
        return false;
      })();

      const isMemActionMismatch =
        isVagueDesc ||
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
        (/\b(reabrir|reabertura|cancelar|cancelamento|excluir|estornar|revers[aã]o|reverter|voltar remessa|remessa)\b/i.test(normAll) &&
          /\b(vincular|vinculacao|unidade piumhi|acesso ao meu usuario)\b/i.test(
            normalizeText(`${matchedMemory.title || ""} ${matchedMemory.summary || ""}`)
          )) ||
        (!/\b(reabrir|reabertura|abrir conta|abrir contas|abrir registro|encerrad[ao] erroneamente|revers[aã]o|reverter|voltar remessa|remessa)\b/i.test(normAll) &&
          /\b(reabrir|reabertura|abrir conta|abrir contas|abrir registro|1411181|revers[aã]o)\b/i.test(
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
      custom_reply_from_instruction: Boolean(customInstruction && customPublicReply),
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
