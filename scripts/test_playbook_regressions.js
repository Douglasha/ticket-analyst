import { loadSettings } from "../src/config.js";
import { GLPIClient } from "../src/glpiClient.js";
import { KnowledgeEngine } from "../src/knowledgeEngine.js";
import { AIAnalyst } from "../src/aiAnalyst.js";

export async function runRegressionTests() {
  const startTime = performance.now();
  const settings = loadSettings();
  const client = new GLPIClient(settings);

  // Mock cache local para teste rápido 100% offline
  GLPIClient._kbCacheTime = Date.now();
  GLPIClient._kbCache = [
    { id: "KB-94", kb_id: 94, title: "HRP Unimed > Guia de Intercâmbio Nacional", summary: "Intercâmbio cancelamento" },
    { id: "KB-92", kb_id: 92, title: "SGH - Spdata > Tabelas > Atualização Manual da Tabela TUSS", summary: "TUSS 00952" },
  ];
  GLPIClient._resolvedCacheTime = Date.now();
  GLPIClient._resolvedCache = [];

  const engine = new KnowledgeEngine(client);
  const analyst = new AIAnalyst(settings);

  const testCases = [
    {
      id: "TEST-01-PB-UNI-66",
      name: "Alteração de Guia de Intercâmbio (Eletivo para Urgência)",
      ticket: {
        id: 44364,
        title: "Alterar atendimento para urgência.",
        content: "Conforme recomendado pelo Frederico, por gentileza, alterar via banco, o caráter de atendimento de eletivo para urgência da senha à seguir. Senha: 210800316",
        category: "T.I > ST > Resolução de Problemas",
        requester: "Suyane Costa Batista",
        requester_department: "Autorização",
      },
      expectedPlaybook: "PB-UNI-66",
      expectedSufficiency: "completo",
      preventedPlaybooks: ["PB-UNI-45", "PB-UNI-12", "PB-UNI-34", "PB-UNI-37"],
    },
    {
      id: "TEST-02-PB-UNI-65",
      name: "Duplicação de Etiqueta de Oncologia com Prontuário em Aberto",
      ticket: {
        id: 43898,
        title: "Suporte Técnico e Service Desk > Desenvolvimento > duplicar etiqueta",
        content: "duplicar etiqueta de oncologia com campo prontuario em aberto",
        category: "T.I > DV > Desenvolvimento > Ajustes em layout/interface",
        requester: "Renan Oliveira",
        requester_department: "H Farmácia",
      },
      expectedPlaybook: "PB-UNI-65",
      expectedSufficiency: "completo",
      preventedPlaybooks: ["PB-UNI-30", "PB-UNI-39", "PB-SD-02", "PB-UNI-62"],
    },
    {
      id: "TEST-03-PB-UNI-64",
      name: "Atualização Manual da Tabela TUSS 00952 no Spdata",
      ticket: {
        id: 43841,
        title: "Parametrização de Sistemas e Tabelas > atualizar tabela TUSS - DIÁRIAS, TAXAS E GASES",
        content: "atualizar tabela de controle 00952 no spdata",
        category: "T.I > ST > Parametrização de Sistemas e Tabelas",
        requester: "Priscila Santos",
        requester_department: "H Faturamento",
      },
      expectedPlaybook: "PB-UNI-64",
      expectedSufficiency: "completo",
      preventedPlaybooks: ["PB-UNI-47", "PB-UNI-34"],
    },
    {
      id: "TEST-04-PB-UNI-63",
      name: "Banner Rotativo no Site Institucional (Novembro Azul)",
      ticket: {
        id: 44341,
        title: "Alteração de banner site",
        content: "acrescentar novo banner em anexo no site mantendo o banner do novembro azul em formato rotativo carrossel",
        category: "T.I > DV > Desenvolvimento > Ajustes em layout/interface",
        requester: "Juliano Augusto de Melo",
        requester_department: "Marketing",
      },
      expectedPlaybook: "PB-UNI-63",
      expectedSufficiency: "completo",
      preventedPlaybooks: ["PB-UNI-60", "PB-UNI-62"],
    },
    {
      id: "TEST-05-PB-UNI-62",
      name: "Criação e Manutenção de Etiquetas de Status no GLPI",
      ticket: {
        id: 44325,
        title: "Criação de etiquetas no GLPI",
        content: "adicionar etiquetas de status no GLPI e remover etiqueta duplicada",
        category: "T.I > DV > Desenvolvimento > Ajustes em layout/interface",
        requester: "Uanne Reis",
        requester_department: "Compras",
      },
      expectedPlaybook: "PB-UNI-62",
      expectedSufficiency: "completo",
      preventedPlaybooks: ["PB-UNI-39", "PB-UNI-65"],
    },
    {
      id: "TEST-06-PB-UNI-61",
      name: "Automação de Disparo de Cobrança WhatsApp / E-mail",
      ticket: {
        id: 44300,
        title: "Automação de cobrança WhatsApp",
        content: "criar automação para disparar mensagens de títulos em atraso pelo whatsapp para clientes empresariais",
        category: "T.I > DV > Desenvolvimento > Novas aplicações",
        requester: "Leonardo Batista",
        requester_department: "Financeiro",
      },
      expectedPlaybook: "PB-UNI-61",
      expectedSufficiency: "parcial",
      preventedPlaybooks: ["PB-UNI-38", "PB-UNI-16"],
    },
    {
      id: "TEST-07-PB-UNI-59",
      name: "Bug no Chat da Intranet Corporativa",
      ticket: {
        id: 44279,
        title: "Bug no chat da intranet",
        content: "chat da intranet apresenta erro e mensagens não carregam",
        category: "T.I > ST > Resolução de Problemas",
        requester: "Marcos Vinicius",
        requester_department: "Comercial",
      },
      expectedPlaybook: "PB-UNI-59",
      expectedSufficiency: "completo",
      preventedPlaybooks: ["PB-UNI-22"],
    },
    {
      id: "TEST-08-PB-UNI-58",
      name: "Instalação de Scanner Dedicado",
      ticket: {
        id: 44268,
        title: "Instalar scanner no computador",
        content: "preciso instalar scanner na minha máquina para digitalizar documentos",
        category: "T.I > ST > Instalação/Configuração > Aplicativos",
        requester: "Aline Cristina",
        requester_department: "Recepção",
      },
      expectedPlaybook: "PB-UNI-58",
      expectedSufficiency: "parcial",
      preventedPlaybooks: ["PB-SD-02", "PB-UNI-07"],
    },
    {
      id: "TEST-09-PB-UNI-57",
      name: "Padronização de Papel de Parede e Domínio UCS",
      ticket: {
        id: 44257,
        title: "Atualizar papel de parede recepção",
        content: "atualizar papel de parede e plano de fundo dos computadores da recepção unimed256 ucs",
        category: "T.I > ST > Instalação/Configuração > Sistemas Operacionais",
        requester: "Patrícia Lima",
        requester_department: "Recepção",
      },
      expectedPlaybook: "PB-UNI-57",
      expectedSufficiency: "completo",
      preventedPlaybooks: ["PB-UNI-07"],
    },
    {
      id: "TEST-10-PB-UNI-56",
      name: "Falha de Conexão ou Primeiro Contato no WConect",
      ticket: {
        id: 44220,
        title: "WConect não recebe respostas",
        content: "pacientes não conseguem responder mensagem de primeiro contato ativo no wconect",
        category: "T.I > ST > Instalação/Configuração > Aplicativos",
        requester: "Rosy Ellen",
        requester_department: "Laboratório",
      },
      expectedPlaybook: "PB-UNI-56",
      expectedSufficiency: "completo",
      preventedPlaybooks: ["PB-UNI-16", "PB-UNI-14"],
    },
    {
      id: "TEST-11-PB-UNI-67",
      name: "Inclusão de Colaborador em Grupos e Listas de E-mails Corporativos (Geral Unimed)",
      ticket: {
        id: 44402,
        title: "Acesso e Permissões - Izabel Heloisa Duarte da Silva",
        content: "Nome: Izabel heloisa Duarte da silva | CPF: 03690586666 | Unidade: Unimed | Setor: Auditoria | Acessos: Outros (Descrever em observações) | Observações: Acesso ao email GERAL UNIMED",
        category: "T.I > ST > Acesso e Permissões",
        requester: "Izabel Heloisa Duarte Silva",
        requester_department: "Auditoria",
      },
      expectedPlaybook: "PB-UNI-67",
      expectedSufficiency: "completo",
      preventedPlaybooks: ["PB-UNI-12", "PB-UNI-38", "PB-UNI-40", "PB-UNI-41"],
    },
    {
      id: "TEST-12-PB-UNI-68",
      name: "Manutenção Preventiva / Corretiva em Samsung M4080 / M4020 (Repromaq)",
      ticket: {
        id: 44401,
        title: "Infraestrutura e Redes > Impressoras > Manutenção preventiva em impressora SAMSUNG M4080FX",
        content: "Título: Manutenção preventiva em impressora | Localização: Compras | Ativo: SAMSUNG M4080FX | Descrição: Bom dia pessoal, ontem de manhã a nossa impressora apresentou uma mensagem de \"falha no fusor\", não queria imprimir e pediu que fosse reiniciada. Reiniciamos e ela voltou a normalidade, mas a tarde estava com mais lentidão para impressões. Gostaríamos de solicitar uma verificação preventiva antes que possa dar algum problema futuro e fiquemos sem ela rsrs.",
        category: "T.I > IR > Suporte a Hardware > Periféricos > Impressoras",
        requester: "Uanne Reis",
        requester_department: "Compras",
      },
      expectedPlaybook: "PB-UNI-68",
      expectedSufficiency: "completo",
      preventedPlaybooks: ["PB-SD-02", "PB-UNI-31", "PB-UNI-36"],
    },
    {
      id: "TEST-13-PB-UNI-27-MULTIPLE",
      name: "Criação de Usuários de Múltiplas Secretárias no Web Saúde via Observações",
      ticket: {
        id: 44394,
        title: "Suporte Técnico e Service Desk > Criação de Usuários > SIMONE KELLY DIAS TERRA",
        content: "Tipo de Solicitação: Criação de Usuários | Origem: Acesso secretária | Nome: SIMONE KELLY DIAS TERRA | E-mail Pessoal: Simonekely454@gmail.com | CPF: 13604336600 | Data Nascimento: 26-05-2003 | Acessos: HRP Web Saúde | Código do Prestador: 22000000 | Nome do Prestador: Santa Casa de Misericordia de Piumhi | Obsevações: EVELYN EDUARDA BARBOSA DE OLIVEIRA\n06/09/2005\n138.289.996-38\nevelyneduarda218@gmail.com\nHeloá Garcia Leite Damaceno\n109.622.136-59\n31/10/2006\nheloagarcialeitedamaceno@gmail.com\nDrielli Ananda Duarte Silva\n114.577.196-30\n15/10/1992\ndrielliananda777@gmail.com",
        category: "T.I > ST > Acesso e Permissões > Criação de Usuários",
        requester: "Jessica Rosa",
        requester_department: "Relacionamento Prestadores",
      },
      expectedPlaybook: "PB-UNI-27",
      expectedSufficiency: "completo",
      preventedPlaybooks: ["PB-UNI-01", "PB-UNI-12"],
    },
    {
      id: "TEST-14-PB-UNI-69",
      name: "Inclusão de E-mail em Relatórios Periódicos do Hospital (SGH Spdata)",
      ticket: {
        id: 44426,
        title: "Banco de Dados e Análise de Dados > Relatórios > Relatórios Atendimentos Hospital",
        content: "Tipo de Solicitação: Relatórios | Setor Solicitante: Promoprev | Título: Relatórios Atendimentos Hospital | Localização: Promoprev | Descrição: Solicito que os relatórios de todos os atendimentos realizados no hospital sejam enviados para o e-mail vsilva@unimedsudoestemg.coop.br, da mesma forma que a colaboradora Viviane do Núcleo os recebe em sua caixa de entrada.",
        category: "T.I > BD > Big Data e BI > Relatórios",
        requester: "Vanessa Alves Salgado Silva Pimenta",
        requester_department: "Promoprev",
      },
      expectedPlaybook: "PB-UNI-69",
      expectedSufficiency: "parcial",
      preventedPlaybooks: ["PB-UNI-38", "PB-UNI-16", "PB-UNI-14"],
    },
    {
      id: "TEST-15-PB-UNI-70",
      name: "Criação de Modelo/Protocolo de Prescrição Padrão no PEP SGH (SRPA)",
      ticket: {
        id: 44464,
        title: "Desenvolvimento e Qualidade > Novas aplicações > Criar modelo de prescrição no PEP",
        content: "1) Tipo de Solicitação: Novas aplicações\n2) Setor Solicitante: H Centro Cirúrgico\n4) Título: Criar modelo de prescrição no PEP\n5) Localização: Centro Cirurgico\n6) Sistema: SPDATA/PEP\n7) Descrição: Bom dia\npreciso que crie um modelo de prescrição, conforme anexo, para que facilite para o anestesistas e cirurgiões fazerem a prescrição para pacientes que irão ficar na sala de recuperação por mais tempo ou serem liberados dela.\n8) Anexo: Prescrição SRPA.odt",
        category: "T.I > DV > Desenvolvimento > Novas aplicações",
        requester: "Fernanda Cristina da Costa Padua",
        requester_department: "H Centro Cirúrgico",
      },
      expectedPlaybook: "PB-UNI-70",
      expectedSufficiency: "completo",
      preventedPlaybooks: ["PB-UNI-18", "PB-UNI-09", "PB-UNI-32"],
    },
    {
      id: "TEST-16-PB-UNI-71",
      name: "Evidências de TI para Acreditação PALC 2025 / ONA no AutoLac (Laboratório)",
      ticket: {
        id: 44502,
        title: "Segurança da Informação > Compliance, Auditorias e Políticas de SI >",
        content: "1) Tipo de Solicitação: Compliance, Auditorias e Políticas de SI\n3) Setor Solicitante: Laboratório\n4) Localização: Coordenação\n5) Solicitação: Boa tarde, prezados.\nSolicito a criação dos Registros de controle de acesso, rastreabilidade, alteração e recuperação de registros eletrônicos para fins de Auditoria Diagnóstica PALC 2025.\nAt.te",
        category: "T.I > SI > Compliance, Auditorias e Políticas de SI",
        requester: "Rosy Ellen Freire Viana",
        requester_department: "Laboratório > Coordenação",
      },
      expectedPlaybook: "PB-UNI-71",
      expectedSufficiency: "completo",
      preventedPlaybooks: ["PB-UNI-27", "PB-UNI-12", "PB-UNI-04"],
    },
    {
      id: "TEST-17-PB-UNI-72",
      name: "Unificação de Recursos de Ativo Imobilizado no HRP (Ajuste via IDE Engine)",
      ticket: {
        id: 44577,
        title: "Banco de Dados e Análise de Dados > Administração de Banco de Dados > AJUSTE VIA BANCO DE DADOS",
        content: "1) Tipo de Solicitação: Administração de Banco de Dados\n2) Setor Solicitante: Contabilidade\n3) Observador: Raphael Campos\n1) Título: AJUSTE VIA BANCO DE DADOS\n2) Localização: Contabilidade\n3) Descrição: Boa tarde !!\nConforme já conversado, solicito ajuste via banco de dados do item OEINFNH000721. \nResponsável: Frederico.\nO item consta cadastrado com dois recursos. Considerar somente recurso AI00007 - MONITOR DE COMPUTADOR.\nObrigado !!",
        category: "T.I > BD > Administração de Banco de Dados",
        requester: "Christian Dominiquini Deleposte",
        requester_department: "Unimed > Contabilidade",
      },
      expectedPlaybook: "PB-UNI-72",
      expectedSufficiency: "completo",
      preventedPlaybooks: ["PB-UNI-19", "PB-UNI-20", "PB-UNI-07"],
    },
    {
      id: "TEST-18-PB-UNI-47-IPSM",
      name: "Parametrização e Importação da Tabela de Medicamentos do Convênio IPSM / Batalhão (SGH Spdata)",
      ticket: {
        id: 44578,
        title: "Desenvolvimento e Qualidade > Integração entre sistemas > Parametrização de Tabelas - IPSM",
        content: "1) Tipo de Solicitação: Integração entre sistemas\n2) Setor Solicitante: H Auditoria\n3) Observador: Bruna Ferreira Costa\n4) Título: Parametrização de Tabelas - IPSM\n5) Localização: Auditoria\n6) Sistema: SPDATA\n7) Descrição: Boa Tarde!\n\nSegue em anexo a tabela do IPSM para parametrização no sistema.\n\nMedicamentos-Vigência -24/11/2026 \n\n8) Anexo: Vigencia 24-11-26.xlsx",
        category: "Desenvolvimento e Qualidade > Integração entre sistemas",
        requester: "Mayra Morais",
        requester_department: "Hospital > Auditoria",
      },
      expectedPlaybook: "PB-UNI-47",
      expectedSufficiency: "completo",
      preventedPlaybooks: ["PB-UNI-46", "PB-UNI-64", "PB-UNI-32"],
    },
    {
      id: "TEST-19-PB-UNI-73",
      name: "Falha de Upload / Anexo de Arquivos no GLPI (Tipo de arquivo não permitido)",
      ticket: {
        id: 44637,
        title: "Desenvolvimento e Qualidade > Correção de bugs > Arquivo não está anexando",
        content: "1) Tipo de Solicitação: Correção de bugs\n2) Setor Solicitante: Regulação\n3) Observador: \n4) Título: Arquivo não está anexando\n5) Localização: Regulação\n6) Sistema: glpi\n7) Descrição: O arquivo não é anexado ao tentar realizar o upload durante o andamento de um chamado.",
        category: "T.I > DV > Desenvolvimento > Correção de bugs",
        requester: "Douglas Henrique Amaral",
        requester_department: "Unimed > Regulação",
        ocr_text: "Tipo de arquivo não permitido PROTOCOLO DE RESPOSTA AO OFÍCIO",
      },
      expectedPlaybook: "PB-UNI-73",
      expectedSufficiency: "completo",
      preventedPlaybooks: ["PB-UNI-14", "PB-UNI-32", "PB-UNI-29"],
    },
    {
      id: "TEST-20-PB-UNI-74",
      name: "Mudança de Acomodação em Guia de Internação no HRP (Reversão de Processo / Ajuste Operacional)",
      ticket: {
        id: 44639,
        title: "Suporte Técnico e Service Desk > Resolução de Problemas > Mudança de Acomodação",
        content: "1) Tipo de Solicitação: Resolução de Problemas\n2) Setor Solicitante: Faturamento\n3) Observador: Frederico Roosevelt\n\n1) Problema: Mudança de Acomodação\n2) Aplicação: HRP Unimed\n3) Descrição: Boa tarde!\nSobre a senha de internação a seguir:\nPor gentileza realizar a troca do campo em destaque para a acomodação QUARTO COLETIVO.\nA troca se faz necessária para que o sistema calcule corretamente os honorários médicos",
        category: "T.I > ST > Resolução de Problemas",
        requester: "Luana Tozzi",
        requester_department: "Faturamento",
        ocr_text: "Solicitação de Internação Senha 207283124 Chave 207290172 41 - Tipo de Acomodação Autorizada 12 - APARTAMENTO SIMPLES 41 - QUARTO COLETIVO DE 2 LEITOS",
      },
      expectedPlaybook: "PB-UNI-74",
      expectedSufficiency: "completo",
      preventedPlaybooks: ["PB-UNI-66", "PB-SD-02", "PB-UNI-12", "PB-UNI-19"],
    },
    {
      id: "TEST-21-PB-UNI-16-PRODUCAO",
      name: "Extração de Produção Médica de Cooperados em Excel (Big Data e BI > Relatórios)",
      ticket: {
        id: 44575,
        title: "Suporte Técnico e Service Desk > Sistemas Operacionais > Extração produção cooperados via excel",
        content: "Prezados(a) boa tarde. Recebi a solicitação em anexo no qual pede que seja enviado a produção dos médicos em excel e também segregado por tipo de atendimento.",
        category: "T.I > ST > Instalação/Configuração > Sistemas Operacionais",
        requester: "Jessica Rosa",
        requester_department: "Relacionamento Prestadores",
        documents: [{ filename: "Autorização envio de produção RTS Cont.pdf" }],
      },
      expectedPlaybook: "PB-UNI-16",
      expectedSufficiency: "completo",
      preventedPlaybooks: ["PB-SD-02", "PB-UNI-12", "PB-UNI-18", "PB-UNI-32"],
    },
    {
      id: "TEST-22-PB-UNI-75",
      name: "Implantação de Totem/Ferramenta de Pesquisa de Satisfação no Laboratório (PALC / Novas Aplicações)",
      ticket: {
        id: 44698,
        title: "Desenvolvimento e Qualidade > Novas aplicações > Solicitação de implantação de ferramenta de avaliação da satisfação e experiência do cliente – Laboratório Unimed",
        content: "1) Tipo de Solicitação: Novas aplicações\n2) Setor Solicitante: Laboratório\n3) Observador: \n4) Título: Solicitação de implantação de ferramenta de avaliação da satisfação e experiência do cliente – Laboratório Unimed\n5) Localização: Recepção\n6) Sistema: -\n7) Descrição: Considerando o processo de adequação e acreditação do Laboratório Unimed junto ao Programa de Acreditação de Laboratórios Clínicos (PALC), identificamos a necessidade de implantação de um mecanismo sistematizado para avaliação da satisfação e da experiência dos clientes atendidos pelo laboratório.\n\nSolicitamos o apoio dos setores de Tecnologia da Informação (TI) e Compras para avaliação da viabilidade técnica e operacional e levantamento de soluções disponíveis para implantação de um sistema de pesquisa de satisfação, preferencialmente por meio de totem eletrônico de avaliação, tablet ou outra ferramenta digital.",
        category: "T.I > DV > Desenvolvimento > Novas aplicações",
        requester: "Rosy Ellen Freire Viana",
        requester_department: "Laboratório > Recepção",
      },
      expectedPlaybook: "PB-UNI-75",
      expectedSufficiency: "completo",
      preventedPlaybooks: ["PB-UNI-71", "PB-UNI-12", "PB-UNI-04", "PB-UNI-38"],
    },
    {
      id: "TEST-23-PB-UNI-76",
      name: "Desenvolvimento de Painel de Senha e Gerenciador de Fila (Recepção Externa / Novas Aplicações)",
      ticket: {
        id: 44632,
        title: "Desenvolvimento e Qualidade > Novas aplicações > Painel de Senha",
        content: "1) Tipo de Solicitação: Novas aplicações\n2) Setor Solicitante: H Administração\n3) Observador: \n4) Título: Painel de Senha \n5) Localização: Recepção Externa\n6) Sistema: Nova aplicação\n7) Descrição: Desenvolvimento de uma aplicação para gerenciar a fila de atendimento na recepção externa",
        category: "T.I > DV > Desenvolvimento > Novas aplicações",
        requester: "Douglas Henrique Amaral",
        requester_department: "Hospital > Recepção Externa",
      },
      expectedPlaybook: "PB-UNI-76",
      expectedSufficiency: "completo",
      preventedPlaybooks: ["PB-SD-02", "PB-UNI-36", "PB-UNI-39", "PB-UNI-31"],
    },
  ];

  const results = [];
  let passedCount = 0;

  for (const tc of testCases) {
    const matches = await engine.searchAllLayers(tc.ticket, 4);
    const topPlaybook = matches.find((m) => m.layer === "local_playbook");
    const topPbId = topPlaybook ? topPlaybook.source_id : null;

    const analysis = await analyst.analyzeTicket(tc.ticket, matches);

    const pbMatch = topPbId === tc.expectedPlaybook;
    const suffMatch = analysis.sufficiency_status === tc.expectedSufficiency;

    const preventedCollisions = tc.preventedPlaybooks.every(
      (pbId) => !matches.some((m) => m.source_id === pbId)
    );

    const isPassed = pbMatch && suffMatch && preventedCollisions;
    if (isPassed) passedCount += 1;

    results.push({
      test_id: tc.id,
      name: tc.name,
      passed: isPassed,
      expected_playbook: tc.expectedPlaybook,
      actual_playbook: topPbId,
      expected_sufficiency: tc.expectedSufficiency,
      actual_sufficiency: analysis.sufficiency_status,
      prevented_collisions_ok: preventedCollisions,
      telemetry: analysis.telemetry,
    });
  }

  const durationMs = Math.round(performance.now() - startTime);

  return {
    total_tests: testCases.length,
    passed_tests: passedCount,
    failed_tests: testCases.length - passedCount,
    all_passed: passedCount === testCases.length,
    duration_ms: durationMs,
    results,
  };
}

// Execução direta via CLI
if (process.argv[1] && process.argv[1].includes("test_playbook_regressions.js")) {
  console.log("Iniciando Suite de Testes de Regressão Heurística (Playbooks Unimed)...");
  runRegressionTests().then((res) => {
    console.log(`\n================ RESULTADOS DOS TESTES (${res.duration_ms}ms) ================`);
    console.log(`Total: ${res.total_tests} | Sucesso: ${res.passed_tests} | Falhas: ${res.failed_tests}`);
    res.results.forEach((r) => {
      const statusIcon = r.passed ? "✔ [PASS]" : "✖ [FAIL]";
      console.log(`${statusIcon} ${r.test_id}: ${r.name}`);
      if (!r.passed) {
        console.log(`   Esperado Playbook: ${r.expected_playbook} | Obtido: ${r.actual_playbook}`);
        console.log(`   Esperado Suficiência: ${r.expected_sufficiency} | Obtido: ${r.actual_sufficiency}`);
      }
    });
    if (res.all_passed) {
      console.log("\n🎉 TODOS OS TESTES PASSARAM COM SUCESSO!");
      process.exit(0);
    } else {
      console.error("\n❌ HOUVE FALHAS NA REGRESSÃO!");
      process.exit(1);
    }
  }).catch((err) => {
    console.error("Erro fatal nos testes:", err);
    process.exit(1);
  });
}
