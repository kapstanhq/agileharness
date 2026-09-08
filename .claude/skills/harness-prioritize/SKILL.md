---
name: harness-prioritize
description: >-
  AgileHarness automation that PRIORITIZES a story sitting in `priorizar` by REASONING
  (reasoning-first), not by inventing reach numbers: it weighs the card against the
  board's PRD (the digest: positioning, target outcome, business metric, scope) and the OTHER
  backlog items, then writes an ARGUED priority — a `priorityCall` block {rank 0-3,
  rationale, riskiestAssumption, source, assessedAt} — and advances `priorizar ->
  pronta` (passing the hasPrioritization gate, which a priorityCall satisfies). The
  numeric RICE/KANO/funnel path is LEGACY/optional. With no id it processes the whole
  `priorizar` queue of every board. Use when the user says "/harness prioritize",
  "/harness-prioritize", "priorizar story", "classificar story", "avaliar prioridade",
  "definir prioridade", or wants to advance AgileHarness cards sitting in Estimar.
  Edits ONLY storymap data files — never the storymap-ui package.
triggers:
  - /harness prioritize
  - /harness-prioritize
  - priorizar story
  - classificar story
  - avaliar prioridade
  - definir prioridade
  - usm prioritize
---

# /harness-prioritize — AgileHarness: prioridade argumentada (priorizar → pronta)

The `harness-prioritize` trigger automation. It turns a refined, broken-down story into a
**prioritized** one by writing an **argued priority** (`priorityCall`) — a defended TIER,
not an invented reach number — then advances the card past the `hasPrioritization` gate
into `pronta`.

> **Régua:** WSJF ANCORADO. Num produto pré-escala, número de "alcance" é chute — então os eixos são
> ordinais numa escala fechada (1·2·3·5·8·13), estimados por COMPARAÇÃO contra as *reference stories*
> já pontuadas do board, e a ordem do backlog CAI da aritmética. Consequência que importa: pontuar um
> card novo **não mexe no score de nenhum outro** — a ordem é estável e reprodutível, e um card acha
> seu lugar sem ninguém re-ranquear o conjunto.
> This skill edits ONLY data files under `storymap/boards/<board>/cards/`.
> NEVER touch `packages/storymap-ui/` (UI or data layer).

## When to Use

- A card sits in status `priorizar` (the `harness-prioritize` trigger column).
- The user runs `/harness prioritize [<board>/<id>]` or `/harness-prioritize [<board>/<id>]`.
- The user asks to "priorizar", "avaliar/definir a prioridade" of a story.

## Input

```
/harness-prioritize <board>/<id>     # process one card (e.g. demo/story-busca-por-autor)
/harness-prioritize                  # no id = process the ENTIRE `priorizar` queue
```

With **no argument**, scan `storymap/boards/*/cards/*.md` and process every card whose
`status` is `priorizar`, board-by-board, in file order.

If an explicit id is given but the card is NOT in `priorizar`, do not force it: report the
current status and stop (the trigger only owns the `priorizar` slot).

## Workflow

1. **Read the strategy (the norte).** Read the board's PRD — `read_doc({board, docType:"prd"})`,
   or `storymap/boards/<board>/docs/prd.md` — and argue the priority AGAINST it. The sections that
   decide a priority are `posicionamento`, `resultadoAlvo`, `metricaNegocio` and `escopo`: a card
   that serves the target outcome outranks one that merely fits the roadmap, and a card that falls
   under *Fora, por ora* is not a priority question at all. Also read the `personas` (their
   `pains`/`gains`) and `systems` from `board.yaml` for grounding.

2. **Confirm the slot + colha as ÂNCORAS e o já-entregue.** The card must be `status: priorizar`
   (queue mode: every card with that status). Read its `title`, `body`, `acceptance`, `personas`,
   e — quando houver — `severity`/`frequency` e a seção `## Entrevistas` do corpo.

   Depois monte a régua contra a qual você vai estimar:

   - **ÂNCORAS** — 3 a 5 stories do MESMO board que já têm `priorityCall.wsjf`, escolhidas para
     COBRIR a faixa (a de maior WSJF, a de menor, e um ou dois intermediários). São as *reference
     stories*: você lê os ordinais delas e estima o card novo por comparação. **Sem âncoras a
     escala deriva** e a ordem que emerge dos scores vira ficção — é o único jeito de a pontuação
     por card ser comparável.
   - **O QUE O PRODUTO JÁ FAZ** — as stories em status ENTREGUE (`concluida`) são, coletivamente, a
     especificação do que está no ar. Um card que só repete capacidade existente vale pouco; um que
     completa algo entregue pela metade costuma destravar muito.

   Se o board **não tiver nenhuma âncora** (primeiro lote — o caso do PRD que acabou de gerar
   dezenas de cards), diga isso no relatório: os ordinais que você atribuir viram a régua calibrada
   de todos os próximos cards, então distribua com cuidado e use a escala inteira.

3. **Pontue os QUATRO eixos do WSJF.** Cada um usa a MESMA escala fechada — `1, 2, 3, 5, 8, 13` —
   e nenhum outro número:

   - **`value`** — quanto isto move o **resultado-alvo declarado** do board.
   - **`urgency`** — quanto o custo **CRESCE com a espera**. Urgência ≠ importância: um defeito que
     bloqueia gente hoje é urgentíssimo mesmo entregando pouco valor novo.
   - **`unlock`** — quantas **OUTRAS coisas** passam a ser possíveis quando isto existe. É aqui que
     trabalho de alicerce (que soa entediante) ganha o peso que merece.
   - **`size`** — o esforço. É o **DENOMINADOR**: item grande precisa de valor proporcionalmente
     maior para subir. Item enorme e importante deve ser **QUEBRADO**, não inflado — um card de
     tamanho 13 não alcança "Alta" por construção, e isso é o WSJF funcionando.

   Regras que não se negociam:
   1. **Pontue contra as ÂNCORAS** (passo 2) — elas são a régua CALIBRADA deste board. Item
      equivalente a uma âncora recebe ordinais equivalentes. Não invente uma escala própria: é isso
      que faz um "8" de hoje significar o mesmo que um "8" de três meses atrás.
   2. **NÃO infle.** Se tudo receber valor alto, a ordem não informa nada. Use a escala inteira,
      inclusive 1 e 2.
   3. **Julgue pelo que está ESCRITO.** Card sem evidência recebe ordinais modestos — isso é honesto,
      e o sistema registra separadamente (em `basis`) que a evidência era fina.
   4. **NÃO repriorize os outros cards.** Você pontua só o card do slot; a ordem do backlog cai da
      aritmética, então o card novo acha seu lugar sem mexer no score de ninguém.

4. **Derive o `rank` da conta** (não o escolha à parte):

   ```
   WSJF = (value + urgency + unlock) / size
   rank = 3 Crítica se WSJF ≥ 8 · 2 Alta se ≥ 4 · 1 Média se ≥ 2 · senão 0 Baixa
   ```

   Um `rank` que não bate com os ordinais é **reprovado pela lint** `board-integrity`
   ("todo rank gravado é exatamente o tier derivado dos ordinais WSJF").

5. **Write the `priorityCall` block** into the card frontmatter (it satisfies `hasPrioritization`).
   Edit the frontmatter in-place, adding:

   ```yaml
   priorityCall:
     rank: 2                    # DERIVADO da conta acima — 0 Baixa · 1 Média · 2 Alta · 3 Crítica
     rationale: "Por que agora / por que antes de X — 1 a 3 frases, linguagem de cliente."
     riskiestAssumption: "A única suposição mais arriscada a testar primeiro (Lean)."
     source: agent
     assessedAt: '2026-06-20T12:00:00.000Z'   # ISO, ENTRE ASPAS (sem aspas o YAML devolve um Date)
     wsjf:
       value: 5
       urgency: 3
       unlock: 8
       size: 3
       basis: [soThat, aceite, personas, entregues]  # que sinais existiam de fato no card
       cohortSize: 12           # quantas stories em aberto havia no board
       cohortAt: '2026-06-20T12:00:00.000Z'
   ```

   **NUNCA sobrescreva um `priorityCall` com `source: human`** — é o veto do Operador. Se o card já
   tiver um, reporte e pare.

   The `rationale` must read as an ARGUMENT a human can challenge ("por que agora / por que
   antes daquela"), grounded in the strategy + evidence. Brand voice: urbano-sofisticado, sem
   gíria; never `rolê`/`zap`/"o que rola". Keep the block sparse — omit `riskiestAssumption`
   only if there genuinely isn't one.

6. **(Legacy/optional) numeric inputs.** RICE/KANO/funnel are LEGADO e não passam mais por aqui —
   não os preencha. `severity`/`frequency` de bug **continuam valendo**: alimentam a ordenação da
   Triagem no Inbox E entram como evidência de `urgency` na sua estimativa. Nunca invente números de
   RICE para preencher campo.

7. **Advance.** With the `priorityCall` present, advance the card by editing the EXISTING
   `status:` line IN-PLACE — change its value from `priorizar` to `pronta` via a targeted
   replace on the current `status:` line. NEVER append a new `status: pronta` line: a second
   `status:` key turns the frontmatter into duplicate-key YAML that fails to parse and corrupts
   the card (title falls back to the id, status disappears, the card leaves its column).
   Likewise bump the existing `updated:` field in-place to today (`YYYY-MM-DD`).

8. **Report.** State the card moved `priorizar → pronta`, os quatro ordinais, o WSJF resultante e o
   TIER derivado, mais a frase do porquê — e contra QUAIS âncoras você calibrou (ou que não havia
   nenhuma). Em modo fila, resuma cada card.

### Gate guardrail

The `hasPrioritization` gate (and the `validate-storymap-gate` pre-write/pre-edit hook) is
satisfied by a `priorityCall` OR by the legacy numeric inputs of the card's TYPE. Write the
`priorityCall` BEFORE flipping `status: pronta` — they only need to be present when the
`status: pronta` write is validated, so separate edits are fine.

⚠️ O gate aceita um `priorityCall` **sem** o sub-bloco `wsjf` (calls legados seguem válidos), mas um
card assim **não aparece na ordem** da tela de Priorização nem desempata no `suggest_work` — ele cai
como "sem avaliação". Escreva sempre os quatro ordinais.

### A régua vive no código, não aqui

A escala, os cortes de tier e a fórmula são de `packages/storymap-ui/src/lib/storymap/wsjf.ts` (e a
lint `board-integrity` os checa contra o disco). Este arquivo os REPETE para o agente headless, que
não importa TypeScript — se um dia divergirem, o código é a verdade e este texto é o bug.
