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
