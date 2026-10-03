---
name: harness-cycle
description: >-
  Ciclo de conserto e melhoria do AgileHarness (a PRÓPRIA ferramenta), conduzido por uma SESSÃO: mede a saúde com a
  tool `ah_health`, escolhe o sinal vermelho de maior retorno, conserta DIRETO no repositório da ferramenta (worktree
  próprio, teste primeiro), roda a suíte inteira e o typecheck, integra na main, tagueia, libera por
  `contrib/ah-release` e prova o efeito com o delta do sinal em dado vivo. Os cards de um board de produto servem SÓ para validar (observados, nunca
  puxados como trabalho), e nada vira card na ferramenta como veículo da obra. Use quando o usuário disser
  "/harness-cycle", "ciclo de conserto", "consertar a ferramenta", "melhorar o AgileHarness", "rodar o ciclo de
  saúde", "o que está vermelho na ferramenta". Edita código da ferramenta, nunca dados de board.
triggers:
  - /harness-cycle
  - ciclo de conserto
  - ciclo de saúde
  - consertar a ferramenta
  - melhorar o agileharness
  - rodar o ciclo
---

# harness-cycle — o ciclo de conserto e melhoria do AgileHarness

Uma sessão leva de **1 a 3 sinais de saúde vermelhos** da ferramenta até o ar, com prova. O ciclo é **direto**: o
trabalho acontece no repositório da ferramenta, não dentro dos cards dela. A ferramenta mede a si mesma (os 12 sinais do
relatório de saúde, com limiar declarado) e é essa medida — antes e depois, pelo mesmo instrumento — que diz se o
conserto funcionou. Nenhum passo pede o dono: o que é dele fica de fora (ver o fim).

> Esta skill não tem coluna: nenhum board a dispara. Quem a conduz é uma sessão com acesso ao repositório da ferramenta
> e ao MCP (a medida usa a tool `ah_health`). A ferramenta é GENÉRICA: nada do que você escrever nela pode conter nome
> de produto, de board ou de usuário — as regras vêm do `board.yaml` e do `settings.yaml` de quem a instala.

## Princípios (o que não muda)

- **Medir, consertar, medir.** Sem a medida de antes não há prova de depois. Guarde a saída (e o instante `at`) do
  passo 1.
- **Direto, sem dogfood.** Não crie card na ferramenta para carregar o conserto, e não mova card dela para "andar". Um
  card `[saude:<id>]` que o tick de saúde tenha aberto no board próprio é só o rótulo do mesmo problema.
- **Teste primeiro.** O conserto começa por um teste que reproduz o sinal com os dados de hoje e falha pelo motivo
  certo. Nunca enfraqueça uma asserção para passar; se um teste existente trava o comportamento ERRADO que o sinal
  denuncia, reescreva-o de propósito e diga isso na mensagem do commit.
- **Cards do board de produto só validam.** Quando for preciso ver o efeito em cards reais, você os lê (`list_cards`,
  `get_card`); não os move, não responde a pergunta deles, não os edita.
- **Um ciclo de cada vez, curto.** No máximo 3 sinais. Se algo sair do roteiro (dado de board estranho, sinal novo
  vermelho que você não entende), pare e relate — não improvise.

## Os 8 passos

### 1. DETECTAR — medir a linha de base

Chame `ah_health`. Anote: o `at` da medida (será o `since` do passo 6), os sinais `red`, `amber` e `unknown`, a
`evidence` de cada um e o campo `release` (a tag que está no ar agora). Complemente com `service_health` (o serviço está
vivo?) e `list_boards`. `unknown` é «não medível», **nunca verde**: um sinal que não mede é uma lacuna de medição, não
uma boa notícia.

### 2. ESCOLHER — no máximo 3, pelo retorno

Ordem de escolha:

1. **Integridade do dado antes de tudo**: churn de status (S8) e card × ledger (S9) vermelhos põem em risco o que as
   outras medidas leem.
2. **Vermelho antes de âmbar**, e dentro do vermelho o que **mais destrava cards do produto** (conte os ids em
   `evidence`; `ah_health` com `board` mostra o recorte de um board).
3. **Menor risco e menor custo** para o mesmo retorno. Prefira o conserto que corrige a CAUSA para todas as ocorrências
   ao que remove o sintoma de uma.

Antes de codar, escreva a **prova esperada** de cada sinal escolhido: o valor-alvo e quais cards do produto devem andar.
Ela vai no corpo do commit — não num card.

### 3. CONSERTAR — worktree próprio, teste primeiro

- Trabalhe num **worktree próprio** do repositório da ferramenta (`git worktree add`), em branch própria. Nunca edite
  arquivo à mão no checkout principal nem no clone de release (a única escrita no checkout principal é a integração do
  passo 5); nunca dê push.
- Reproduza o sinal num teste (fixture com os números reais da medida do passo 1) e veja-o falhar.
- Decisão em função **pura**, IO na borda; invariante imposto num ponto só. Comentários em português que expliquem o
  PORQUÊ e o caso real que motivou. Nada de código morto, de flag nova sem necessidade, de dependência nova.
- Dado vivo para entender o caso: somente-leitura (`ah_health`, `get_card`, `list_cards`). Nunca escreva em dado de
  board pelo sistema de arquivos.

### 4. PROVAR NO CÓDIGO — suíte inteira e typecheck, uma vez

Rode **a suíte inteira** e o **typecheck** do pacote da ferramenta, sempre com `nice` e nunca em laço: a máquina é a
mesma dos condutores, e carga alta quebra a vaga deles. Os arquivos que você tocou e os vizinhos rodam enquanto
trabalha; a suíte inteira e o typecheck rodam **uma vez**, no fim. Vermelho de teste que você não causou: pare e
relate, não contorne.

### 5. LIBERAR — integrar na main, tag local e `contrib/ah-release`

1. Commit em português, no estilo do repositório, com a prova esperada no corpo.
2. **Integre a sua branch na main ANTES de taguear**: no checkout principal, com a árvore limpa, pelo caminho de
   integração do repositório (o merge da branch, como os anteriores; fast-forward quando der). Tag de branch não
   integrada apaga em silêncio o conserto do ciclo anterior quando o próximo for cortado da main — o `contrib/ah-release`
   recusa (saída 2) uma tag que não descende do que está no ar.
3. `git tag` local da versão **no commit da main** (a tag **não** é empurrada: push é do dono).
4. `contrib/ah-release <tag> --dry-run` (plano; recusa tag inexistente, árvore suja e tag que não descende do que está
   no ar) e depois `contrib/ah-release <tag>`, **em segundo plano** (o parâmetro run_in_background do Bash): build, suíte
   e o `ah-safe-restart` — que espera o runner e o merge train ociosos por até 15 min — passam do tempo de um comando em
   primeiro plano, e o script morto no meio deixa o swap feito e o restart por fazer. É o **único** caminho de
   reinício. Nunca reinicie o serviço por outro meio.
5. Interrompido? **Não reexecute às cegas.** Leia `ah_health`: `release` é a versão que o processo RODA (a foto do
   boot), e `releaseNote` diz «restart pendente» quando o swap aconteceu e o restart não. Nesse caso,
   `contrib/ah-release <tag> --force`, de novo em segundo plano.
6. Leia a saída: **0** — no ar e a versão viva conferida (tag e build); **2** — pré-condição (tag inexistente, árvore
   suja ou não descende do que está no ar: integre na main); **5** — rollback feito (a versão viva divergiu ou o restart
   falhou; o clone voltou junto), volte ao passo 3 do ciclo; **6** — no ar, mas a versão NÃO foi conferida (sem
   credencial): confirme com `ah_health` (`release.tag` é a tag e `releaseNote` não diz restart pendente) antes de seguir;
   **7** — o disco diz a tag e o processo roda outra (restart pendente: veja o item 5).

### 6. PROVAR EM DADO VIVO — o delta do sinal

Espere **2 leituras do tick** (com `health.tickMinutes: 5`, pelo menos 10 minutos) e chame `ah_health` com
`since` = o `at` do passo 1. Tem de valer, em **2 leituras seguidas**: o sinal-alvo no valor esperado e **nenhum outro
sinal subiu de nível** (`delta.worsenedLevel` vazio). `delta.worsened` lista também a oscilação de número dentro do mesmo
nível — fila, churn e ruído sobem e descem o tempo todo, sem release nenhum — e não é critério: leia, não julgue por
ele. Só se precisar ver o efeito em cards reais: `ah_health` com o `board` do produto e a leitura (`get_card`,
`list_cards`) dos cards que a prova esperada citou — observação, nunca trabalho.

### 7. FECHAR OU REABRIR — critérios de saída

**Fecha** quando, juntos: o sinal-alvo está no valor esperado em 2 leituras seguidas; nenhum outro sinal subiu de nível
(`delta.worsenedLevel` vazio); a suíte inteira e o typecheck passaram no sha liberado; a versão viva conferida é a tag;
os cards do produto da prova esperada andaram (quando a prova os citou). **Não validou em 2 horas**: volte à versão
anterior com `contrib/ah-release <tag-anterior> --rollback` ou conserte à frente com UM novo commit e tag (integrado na
main), e **não comece ciclo novo**.

### 8. AVISAR — status em 5 linhas

O que mediu (sinal e valor) · o que mudou (commit, tag) · o delta medido · o que ficou em aberto · o próximo sinal.
Nada vai ao Inbox: o Inbox é do dono, e isto é trabalho técnico.

## O que é do dono — e o que este ciclo nunca faz

O dono só decide **negócio**: dinheiro e preço (gasto novo, fornecedor, plano pago, API paga), falar em nome da marca
fora do produto, PRD e metas, dados de pessoas. Se o conserto esbarrar nisso, ele vira uma decisão com classe do dono (um
item de Decidir pelo caminho normal) — nunca uma suposição sua. Além disso, este ciclo **nunca**:

- empurra para o repositório público, cria tag remota ou publica pacote;
- reinicia o serviço fora do `contrib/ah-release`;
- toca credenciais, regras de acesso a dados ou qualquer trava de segurança do ambiente;
- cria, move ou edita card (da ferramenta ou do produto) para conduzir a própria obra;
- grava em `storymap/boards/**` do checkout onde o serviço roda.

## Critérios de saída (resumo para conferir antes do passo 8)

- [ ] linha de base guardada (valor e `at` de cada sinal escolhido)
- [ ] teste que reproduzia o sinal, visto falhar antes e passar depois
- [ ] suíte inteira e typecheck verdes no sha liberado
- [ ] branch integrada na main e a tag no commit da main
- [ ] `contrib/ah-release` saiu 0 (ou 6 com a versão confirmada em `ah_health`: `release.tag` é a tag, sem restart pendente)
- [ ] `ah_health` com `since`: sinal-alvo no valor esperado em 2 leituras seguidas, `worsenedLevel` vazio
- [ ] nenhum card criado, movido ou editado; nada empurrado; status em 5 linhas entregue
