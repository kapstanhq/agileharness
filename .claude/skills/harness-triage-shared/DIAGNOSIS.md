# Diagnóstico de implementação viva — procedimento canônico

> **Fonte única** do procedimento de diagnóstico, referenciada por `harness-refine`,
> `harness-fix`, `harness-sync-card` e `harness-retire`. Antes de respecificar, reconciliar ou
> remover, cada uma dessas skills precisa se ancorar no que o código REALMENTE faz
> hoje. Este é o procedimento compartilhado, agnóstico de intenção; cada `SKILL.md`
> adiciona apenas o seu overlay (a reprodução do bug no `harness-fix`, o scan de inbound
> refs no `harness-retire`, a seção `## Estado atual` + o teto conservador no
> `harness-sync-card`, a seção `## Refino`/`## Bug` no refine/fix).

## Procedimento de diagnóstico (read-only)

Encontre o que, se algo, já implementa o card em `packages/<pkg>/` (o `package:` do
`board.yaml`):

- **Superfícies a mapear:** rotas/páginas, componentes, server actions, Cloud
  Functions, feature flags e o fluxo relevante de ponta a ponta.
- **Ferramentas:** `Grep` / `Read` / `git log` — e `git blame` quando precisar do
  commit/mudança culpada. **NUNCA** rode builds ou testes só para escanear: diagnóstico
  é leitura, não execução.
- **Fixe nos arquivos reais:** capture os arquivos-chave encontrados. O resultado do
  diagnóstico aponta para caminhos concretos, não para suposições.

## Regra: presença de código ≠ shipped

Monte um retrato **honesto** do estado — não otimista:

- **Existe hoje?** Totalmente, parcialmente, ou não existe?
- **Há evidência de que está no ar / validado** — não apenas presente no código?
  Código presente **não** é o mesmo que entregue/validado: um componente pode existir
  no repo sem estar plugado, sem rota registrada, sem estar publicado, ou sem ter
  passado por QA/validação humana.

Na dúvida, **sub-declare**: registre a incerteza no diagnóstico (ex.: `## Estado atual`,
`## Refino`, `## Bug`) e escolha o status/escopo mais conservador, em vez de assumir que
o que está no código está vivo.

> **⚠️ Staged release — o INVERSO de "presença ≠ shipped".** Se o card carrega `stagedAt`
> SEM `releasedAt`, o código recém-construído dele pode estar na branch **`stage`**, NÃO na
> árvore que você está lendo (o worktree nasce de `main`, e o split de release mantém o código
> em `stage` até a publicação humana). Então `não existe / não encontrei` pode ser FALSO. Antes
> de concluir que uma feature "não existe hoje" — ou de **repor o card PARA TRÁS** — confira o
> stage: `git log stage --oneline -10` / `git diff main..stage -- 'packages/**'`. Para um card
> `stagedAt && !releasedAt`, NUNCA o reposicione para trás só pela ausência em `main`.

## ANTÍDOTO: nunca recriar do zero

Este passo é o ANTÍDOTO a **recriar do zero** e a **mexer na coisa errada**: ele prende
o trabalho — melhoria, correção, reconciliação ou remoção — à implementação que JÁ
existe. Toda skill a jusante parte daqui e atua **in-place**, sem reconstruir
componentes/rotas/handlers que já entregam a story. Se você não encontrar o que entregou
a story, diga-o explicitamente no corpo do card e seja conservador (não invente um
rebuild greenfield nem um status inflado).
