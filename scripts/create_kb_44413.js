import { loadSettings } from "../src/config.js";
import { GLPIClient } from "../src/glpiClient.js";

async function createKb() {
  const settings = loadSettings();
  const client = new GLPIClient(settings);
  const sessionToken = await client._initSession();
  const headers = client._authHeaders(sessionToken);
  headers["Content-Type"] = "application/json";

  const answerHtml = `<h2>Rotina para Alteração de Status de Lote de Credenciado via Banco de Dados (IDE Engine - HRP Unimed)</h2>
<p><strong>Identificador Técnico:</strong> KB-HRP-SLOTE-01 / Chamado #44413<br>
<strong>Sistema:</strong> ERP HRP Unimed (Módulo de Faturamento e Processamento de Guias / Engine 82.0.19)<br>
<strong>Setor Solicitante:</strong> Faturamento / Contas Médicas<br>
<strong>Alinhamento Externo:</strong> Federação das Unimeds de Minas Gerais (FederaçãoMG)</p>
<hr>
<h3>1. Cenário e Justificativa Operacional</h3>
<p>Em determinados cenários no sistema <strong>HRP Unimed</strong>, um lote de credenciado/prestador (por exemplo, guias SP/SADT com origem <em>21 - Digitação via Web Saúde</em>) pode ficar retido em um status anterior (como <em>"Pronto para faturamento"</em> ou <em>"Em conferência"</em>) sem possibilitar a movimentação direta pelo operador.</p>
<p>Nesses casos, seguindo as recomendações técnicas do suporte da FederaçãoMG (William), a equipe de Banco de Dados da T.I. realiza a alteração pontual do status do lote diretamente na tabela <code>slote</code> utilizando a própria <strong>IDE Engine do HRP Unimed</strong>.</p>
<hr>
<h3>2. Localização e Validação do Lote na Interface do HRP Unimed</h3>
<ol>
  <li>No sistema <strong>HRP Unimed</strong>, navegar pelo menu:<br>
      <code>Processamento de guias &gt; Lotes de credenciados</code>.</li>
  <li>No campo <strong>No. Lote Operadora / No. Lote Prestador</strong>, preencher de forma individual com a numeração do lote informado pelo Faturamento (exemplo: <code>203316826</code> ou <code>207279060</code>).</li>
  <li>Clicar no botão <strong>Buscar / Pesquisar</strong>.</li>
  <li>Validar os dados da capa do lote:
    <ul>
      <li><strong>Credenciado / Prestador:</strong> Razão Social, Código e UF/Localidade (ex.: <em>12000024 - HORMOSUL</em>);</li>
      <li><strong>Tipo de Guias:</strong> TGS - TISS Guia SP SADT;</li>
      <li><strong>Totalizadores:</strong> Quantidade de guias e valor total do fechamento;</li>
      <li><strong>Status Atual:</strong> Verificar o status em que o lote se encontra no rodapé da tela (ex.: <em>"26/11/2026 - Pronto para faturamento - Operador"</em>).</li>
    </ul>
  </li>
</ol>
<hr>
<h3>3. Execução Técnica na IDE Engine (Acesso ao Banco de Dados)</h3>
<ol>
  <li>Abrir a aplicação <strong>IDE Engine</strong> do HRP Unimed (ambiente <code>UNI256:80 - Engine 82.0.19</code>).</li>
  <li>Acessar a aba de console SQL: <strong><code>iDBC s[Q]</code></strong>.</li>
  <li>Executar o comando de consulta (SELECT) para localizar o registro do lote e conferir a <strong>chave</strong>, a <strong>versão</strong> e o <strong>status atual</strong>:
    <pre style="background-color: #f4f6f8; border: 1px solid #dcdfe6; padding: 12px; border-radius: 4px; font-family: Consolas, monospace; font-size: 13px; color: #2c3e50;"><code>select chave, versao, status from slote where numero = ('203316826');</code></pre>
  </li>
  <li><strong>Conferência do Retorno na Grid da IDE:</strong>
    <ul>
      <li><code>CHAVE</code>: Identificador único primário do lote no banco (ex.: <code>203316826</code>);</li>
      <li><code>VERSAO</code>: Versão de concorrência/lock otimista do registro (ex.: <code>81514432</code>);</li>
      <li><code>STATUS</code>: Código numérico do status no banco (ex.: status atual <code>350</code>).</li>
    </ul>
  </li>
  <li><strong>Alteração do Status:</strong>
    <ul>
      <li>Na grid de dados da ferramenta <code>iDBC s[Q]</code> da IDE Engine, selecionar a célula da coluna <strong><code>STATUS</code></strong> correspondente ao lote;</li>
      <li>Informar o novo código de status solicitado pelo Faturamento / FederaçãoMG (para liberação em <em>"Em faturamento"</em> ou conforme especificado na demanda);</li>
      <li>Salvar a alteração no menu/botão da IDE (ou executar o comando UPDATE com cláusula WHERE explícita por chave e versão):
        <pre style="background-color: #f4f6f8; border: 1px solid #dcdfe6; padding: 12px; border-radius: 4px; font-family: Consolas, monospace; font-size: 13px; color: #2c3e50;"><code>-- Exemplo de comando equivalente via SQL:
update slote 
set status = &lt;NOVO_STATUS&gt;, versao = versao + 1 
where chave = '&lt;CHAVE_DO_LOTE&gt;' and numero = ('&lt;NUMERO_DO_LOTE&gt;');
commit;</code></pre>
      </li>
    </ul>
  </li>
</ol>
<hr>
<h3>4. Validação e Conclusão do Atendimento</h3>
<ol>
  <li>Retornar à tela do <strong>HRP Unimed</strong> em <code>Processamento de guias &gt; Lotes de credenciados</code>.</li>
  <li>Recarregar/pesquisar novamente o lote e certificar-se de que o campo <strong>Status</strong> no rodapé foi atualizado com sucesso.</li>
  <li>Notificar o solicitante do Faturamento no chamado do GLPI confirmando a alteração de status do lote para prosseguimento do faturamento.</li>
</ol>
<hr>
<h3>5. Referências e Rastreabilidade</h3>
<ul>
  <li><strong>Chamado de Origem no GLPI:</strong> Chamado #44413 (Frederico Roosevelt - Faturamento)</li>
  <li><strong>Tabela de Banco de Dados:</strong> <code>slote</code> (Campos: <code>chave</code>, <code>numero</code>, <code>versao</code>, <code>status</code>)</li>
  <li><strong>Ferramenta Utilizada:</strong> IDE Engine HRP Unimed (Console iDBC s[Q])</li>
  <li><strong>Suporte Federativo:</strong> Atendimento alinhado junto ao suporte da FederaçãoMG (William)</li>
</ul>`;

  const payload = {
    input: {
      name: "HRP - Alteração de Status de Lote de Credenciado via Banco de Dados (IDE Engine - Tabela slote)",
      description:
        "<p>Rotina técnica realizada via <strong>IDE Engine</strong> na tabela <code>slote</code> para alteração de status de lote de credenciado no sistema <strong>HRP Unimed</strong> (ex.: liberação para status <em>Em Faturamento</em>), conforme alinhamento com a FederaçãoMG.</p>",
      answer: answerHtml,
      knowbaseitemcategories_id: 17,
      is_faq: 1,
      show_in_service_catalog: 1,
      entities_id: 0,
      is_recursive: 1,
    },
  };

  try {
    const res = await fetch(client.baseUrl + "/KnowbaseItem", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    console.log("POST /KnowbaseItem status:", res.status);
    const data = await res.json();
    console.log("Result:", data);

    if (data.id) {
      console.log(`✅ Base de Conhecimento criada com sucesso no GLPI com ID #${data.id}!`);

      // Link to ticket 44413 via KnowbaseItem_Item
      const linkPayload = {
        input: {
          knowbaseitems_id: data.id,
          itemtype: "Ticket",
          items_id: 44413,
        },
      };
      const resLink = await fetch(client.baseUrl + "/KnowbaseItem_Item", {
        method: "POST",
        headers,
        body: JSON.stringify(linkPayload),
      });
      console.log("Link to Ticket #44413 status:", resLink.status, await resLink.json());
    }
  } catch (err) {
    console.error("Error creating KB:", err);
  } finally {
    await client._killSession(sessionToken);
  }
}

createKb();
