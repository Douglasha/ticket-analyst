# Base de Conhecimento GLPI — Artigo #97

> [!NOTE]
> **Artigo Registrado no GLPI com Sucesso:** ID **#97**  
> **Chamado Vinculado:** [#44413](http://192.168.41.125/front/ticket.form.php?id=44413) (Frederico Roosevelt — Faturamento)  
> **Categoria no GLPI:** `HRP Unimed > Querys` (ID 17) & `T.I > BD > Administração de Banco de Dados > Alteração de Dados / Ajustes SQL Pontuais` (ID 148)  
> **Alinhamento Institucional:** Federação das Unimeds de Minas Gerais (FederaçãoMG)

---

## 1. Identificação e Metadados Técnicos

| Parâmetro | Detalhe |
| :--- | :--- |
| **Título do Artigo** | HRP - Alteração de Status de Lote de Credenciado via Banco de Dados (IDE Engine - Tabela slote) |
| **Identificador Técnico** | `KB-HRP-SLOTE-01` / `PB-UNI-78` |
| **Sistema / Versão** | ERP HRP Unimed (Módulo de Faturamento e Processamento de Guias / Engine 82.0.19) |
| **Tabela do Banco** | `slote` (Campos: `chave`, `versao`, `status`, `numero`) |
| **Ambiente de IDE** | `UNI256:80 - Engine 82.0.19` (Console SQL `iDBC s[Q]`) |
| **Solicitante / Setor** | Frederico Roosevelt — Faturamento |
| **Status no GLPI** | Publicado na Base de Conhecimento e Vinculado ao Chamado #44413 |

---

## 2. Cenário e Justificativa Operacional

No sistema **HRP Unimed**, em determinadas situações operacionais (como lotes de exames/guias SP/SADT de prestadores credenciados com origem *21 - Digitação via Web Saúde*), o lote pode ficar retido em um status anterior no fluxo (ex.: *"26/11/2026 - Pronto para faturamento - Operador"* ou *"Em conferência"*), impossibilitando o avanço direto para liquidação e faturamento pela interface web do sistema.

Seguindo as diretrizes técnicas do suporte da **FederaçãoMG (William)**, a equipe de Banco de Dados de T.I. realiza a alteração pontual do status do lote diretamente na tabela `slote` do banco corporativo utilizando a própria **IDE Engine do HRP Unimed**, destravando o lote para que o setor de Faturamento possa processar e auditar as contas.

---

## 3. Passo a Passo da Execução Técnica

### Etapa 1: Localização e Conferência do Lote no HRP Unimed
1. No sistema **HRP Unimed**, navegar pelo menu:
   ```text
   Processamento de guias > Lotes de credenciados
   ```
2. No campo **No. Lote Operadora / No. Lote Prestador**, preencher de forma individual com a numeração do lote informado pelo Faturamento (exemplo: `203316826` ou `207279060`);
3. Clicar no botão **Buscar / Pesquisar**;
4. Validar os dados da capa do lote:
   - **Credenciado / Prestador:** Razão Social, Código e UF/Localidade (ex.: *12000024 - HORMOSUL*);
   - **Tipo de Guias:** *TGS - TISS Guia SP SADT*;
   - **Totalizadores:** Quantidade de guias e valor total do fechamento (ex.: 40 guias, R$ 4.549,38);
   - **Status Atual:** Verificar a descrição no rodapé da tela (ex.: *"26/11/2026 - Pronto para faturamento - Letícia Maxir"*).

---

### Etapa 2: Acesso à IDE Engine e Consulta SQL na Tabela `slote`
1. Abrir a aplicação **IDE Engine** do HRP Unimed (servidor `UNI256:80 - Engine 82.0.19`);
2. Acessar a aba de console de banco: **`iDBC s[Q]`**;
3. Executar o script SQL abaixo informando o número do lote desejado:

```sql
select chave, versao, status from slote where numero = ('203316826');
```

4. **Conferência das Colunas Retornadas:**
   - **`CHAVE`:** Identificador único primário do registro do lote no banco (ex.: `203316826`);
   - **`VERSAO`:** Versão de concorrência/lock otimista do registro (ex.: `81514432`);
   - **`STATUS`:** Código numérico representativo do status atual no banco (ex.: `350`).

---

### Etapa 3: Alteração do Status via IDE Engine
1. Na grid de resultados do console `iDBC s[Q]`, selecionar a célula da coluna **`STATUS`** na linha do lote consultado;
2. Informar o novo código numérico correspondente a *"Em faturamento"* (conforme definido na instrução da FederaçãoMG);
3. Salvar a modificação diretamente na ferramenta da IDE (ou executar o comando equivalente via comando UPDATE com controle transacional):

```sql
-- Exemplo de comando equivalente via SQL:
update slote 
set status = <NOVO_STATUS>, versao = versao + 1 
where chave = '<CHAVE_DO_LOTE>' and numero = ('<NUMERO_DO_LOTE>');

commit;
```

---

### Etapa 4: Validação e Encerramento
1. Retornar à tela do **HRP Unimed** em `Processamento de guias > Lotes de credenciados`;
2. Recarregar a pesquisa do lote e certificar-se de que o campo **Status** no rodapé reflete o novo estado operacional;
3. Notificar o solicitante no chamado do GLPI confirmando a alteração e liberando o lote para as rotinas do Faturamento.

---

> [!TIP]
> **Rastreabilidade e Segurança:** Sempre utilize a cláusula `where numero = ('...')` ou `where chave = '...'` especificando exatamente o lote demandado para evitar atualizações acidentais em outros lotes de prestadores da cooperativa.
