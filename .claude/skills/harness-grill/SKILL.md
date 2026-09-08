---
name: harness-grill
description: >-
  AgileHarness automation that GRILLS a freshly-captured story: reads a card in status
  `grill` (title + body + any fields) from storymap/boards/<board>/cards/<id>.md,
  INVESTIGATES the codebase and real data FIRST (reads the relevant code, opens the
  bug screenshot when one exists, runs read-only spikes/queries), and only THEN
  writes the FEW genuine QUESTIONS the human must answer — the unknowns it could
  NOT resolve itself and whose answer would materially change design/scope (who the
  user is, the problem/JTBD, in/out scope, constraints, success metric, edge cases).
  It writes them as STRUCTURED `questions:` entries in the card frontmatter (NOT
  prose) WITHOUT inventing answers, records what it found in an `## Investigação`
  body section, and is human-in-the-loop: it does NOT advance the card — the human
  answers on the `/perguntas` queue, then a human moves it to Spec. Asking ZERO
  questions is a VALID result. With no id it processes the whole `grill` queue of
  every board. Use when the user says "/harness grill", "/harness-grill", "grill story",
  "perguntas da story", "levantar incógnitas", or wants to grill AgileHarness cards
  sitting in Dúvidas. Edits ONLY storymap data files — never the storymap-ui package.
triggers:
  - /harness grill
  - /harness-grill
  - grill story
  - grill card
  - perguntas da story
  - perguntas ao operador
  - levantar incógnitas
  - usm grill
---

# /harness-grill — AgileHarness: investigate, then grill a story (Grill, human-in-the-loop)

The `harness-grill` trigger automation for the AgileHarness pipeline. A card has just
been captured (it sits in the `grill` step of Backlog) and is still thin. This
skill **investigates the real code and data first**, then writes a **short, sharp
list of the questions the human ACTUALLY needs to answer** — only the unknowns it
could not resolve itself and whose answer would materially change the design or
scope. It does **not** answer the questions and it does **not** advance the card:
the human answers in the card, then a human moves it on to Spec.

> Read `storymap/README.md` first — it is the canonical schema/pipeline source.
> This skill edits ONLY the data files under `storymap/boards/<board>/cards/`.
> NEVER touch `packages/storymap-ui/` (UI or data layer). Investigation is
> READ-ONLY: you may read code and run read-only queries, but you NEVER edit
> product code.

## When to Use

- A card sits in status `grill` (the `harness-grill` slot in Backlog).
- The user runs `/harness grill [<board>/<id>]` or `/harness-grill [<board>/<id>]`.
- The user asks to "grill", "fazer as perguntas", or "levantar as incógnitas" of a
  AgileHarness story before it is specified.

## Input

```
/harness-grill <board>/<id>     # process one card (e.g. storymap/story-a1b2c3)
/harness-grill                  # no id = process the ENTIRE `grill` queue
```

- `<board>` = a folder under `storymap/boards/` (e.g. `demo`; list that directory for the boards this repo has).
- `<id>` = the card id == the markdown filename without `.md`.
- With **no argument**, scan `storymap/boards/*/cards/*.md` and process every card
  whose `status` is `grill`, board-by-board, in file order.

If an explicit id is given but the card is NOT in `grill`, do not force it: report
the current status and stop (the trigger only owns the `grill` slot).

## The core principle — INVESTIGATE before you interrogate

A question you send to the human is expensive: it stalls the card and pulls the
operator off their work. **Most "unknowns" on a fresh card are things a competent
agent can find out itself** — from the code, from the data, from the attached
screenshot. Sending those back to the human is the failure mode this skill exists
to prevent.

The bar is binary. Before writing ANY question, ask yourself:

> **Is the answer a FACT I can look up, or a CHOICE only the human can make?**
> Fact → investigate it and record the finding. Choice → ask.

If the probable human answer is *"investigate that"* or *"tanto faz"*, the
question is **forbidden** — you should have investigated, or it does not matter.

**Asking ZERO questions is a valid, often ideal outcome.** There is no floor and
no quota. A card where you investigated, found the answers, and have nothing left
that genuinely needs the human is a card done well — report the findings and stop.

## Human-in-the-loop — this skill does NOT advance the card

`grill` is a **manual stop** (`autorun: false`, no gate). The point is to gather
what the human (and only the human) can give, before specification. So:

- **NEVER call `bun "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/scripts/advance-card.ts"`.** Unlike the other harness-* skills, this one does
  not move the card. It leaves it in `grill`.
- **NEVER change the `status:` field.** The card stays `status: grill` — even when
  you ask zero questions (a human still promotes it to Spec).
- **NEVER invent or pre-answer a QUESTION.** Findings from real code/data are not
  fabrication — they are evidence. But you never write an `answer` to a question,
  and you never manufacture a fact you did not verify.

## Workflow

1. **Locate the board + card.** Read `storymap/boards/<board>/board.yaml` to learn
   the board's `personas` (with their `jobs`/`pains`/`gains`) and `systems` — they
   are the vocabulary the questions should probe against. Read the target card
   file: its `title`, `storyType`, `body`, and any populated fields (`narrative`,
   `labels`, `bugReport`/`refinement`, the triage reasoning note, etc.).

2. **Confirm the slot.** The card must be `status: grill`. (Queue mode: pick every
   card with that status.)

3. **Investigate first (READ-ONLY).** Before formulating a single question, resolve
   everything you can yourself. This is the highest-leverage step — especially for a
   BUG, where the right move is investigation, not an interrogation of the reporter.

   - **Read the relevant code.** Map the card to its package via the board's
     `package:` field in `storymap/boards/<board>/board.yaml` (the root `CLAUDE.md`
     documents the repo's package layout). Read the routes/components/actions/functions
     the card is about. `Grep`/`Glob`/`Read` are free — use them liberally.
   - **Open the bug screenshot when one exists.** `bugReport.screenshot` (and
     `bugReport.contextScreenshots[]`) is a **FILENAME**, not a path — resolve it to
     `storymap/boards/<board>/bugs/<id>/<filename>` and open it with `Read` (the CLI
     renders the image). The refine flow mirrors this under
     `storymap/boards/<board>/refine/<id>/<filename>`. If the card cites a "print
     anexado" but `screenshot` is null, note that gap as a finding (the evidence
     never reached the card — see the report-issue/BugModal capture surface).
   - **Run read-only spikes/queries when the card points to data.** Follow the repo
     convention (`diag-*`/`spike-*`, per `CLAUDE.md`): a read-only script or query
     against real data beats human memory (a catalog comparison, a timestamp lookup,
     an audit query for duplicate pairs, an empirical distribution). Write any scratch
     script under `.artifacts/scratch/` (auto-rotated — no `rm` needed).
   - **Record findings** in an `## Investigação` section in the card body: short,
     each with its evidence (file:line, query result, what the screenshot shows).
     These are findings, NOT questions and NOT answers to the `questions:` list.

   > **Permission envelope (execution note).** This skill runs under
   > `--permission-mode acceptEdits` (NOT full-autonomy). That is enough for
   > read-only investigation: `Read`/`Grep`/`Glob` are free everywhere, and the
   > project `.claude/settings.json` allowlist pre-approves the read-only Bash you
   > need (`git status`/`log`/`diff`/`show`, `grep`, `bun`, `bunx`, `just`, `ls`,
   > `node -e`). But **exotic commands are DENIED** under acceptEdits — command
   > substitution `$(...)`, pipelines/compounds (`&&`, `|`), and `rm`. So: prefer
   > simple, allowlisted, single commands; write any multi-step probe as a scratch
   > script under `.artifacts/scratch/` and run it directly (`node .artifacts/scratch/spike-x.js`);
   > never reach for `rm` (the dir auto-rotates).

4. **Ask only what survives the filter.** After investigating, look at what is
   LEFT. A question earns a spot ONLY if BOTH hold:
   - (a) you could NOT get the answer from code/data/screenshot with reasonable
     effort, AND
   - (b) different answers would genuinely change design or scope.

   Use the classic dimensions as a **LENS, not an agenda** — walk them to check
   whether any hides a real human decision, then discard the ones you already
   answered or that don't apply (never generate one mechanically to "cover" a
   dimension):
   - **Quem** — qual persona/usuário exato? (ancore nos `personas` do board.)
   - **Problema / JTBD** — que dor ou job está por trás? Por que agora?
   - **Escopo in/out** — o que ESTÁ e o que NÃO está incluído nesta story?
   - **Restrições** — técnicas, de prazo, de dependência (`systems` do board),
     legais/dados.
   - **Sucesso** — como saberemos que deu certo? (Normalmente você DERIVA o critério
     verificável da investigação — não pergunte ao humano o óbvio.)
   - **Edge cases** — estados vazios, erro, concorrência, permissão, o caso raro.

   Write **0–5** questions — there is **no floor**. One crisp question per genuine
   unknown; merge near-duplicates; cut anything the card or your investigation
   already answers. PT-BR, brand voice urbano-sofisticado (never `rolê`/`zap`/"o que
   rola"). The overwhelmingly common shape of a legitimate question is a **product/
   design decision with a real trade-off** — the kind where you can lay out the paths
   but must NOT choose for the human. For each question, name the **stakes** (what
   changes by the answer) — that becomes the `context:` the Inbox reads.

   ### Negative examples — do NOT ask these (from a real case)

   A bug "evento duplicado no feed" got 5 grill questions; **4 should never have
   reached the human**:

   - ❌ *"O nome do local é igual nas duas entradas do print?"* — **auto-respondível**:
     open the print and/or query the catalog and compare the two entries. (The human
     answered "é necessário investigar" — proof the question bounced right back.)
   - ❌ *"Há quanto tempo aparece duplicado?"* — **auto-respondível**: creation
     timestamps of the two catalog entries answer better than human memory.
   - ❌ *"Caso isolado ou padrão recorrente?"* — **auto-respondível (and better)**: an
     audit query for duplicate pairs answers with data, not a guess.
   - ❌ *"Como saberemos que funcionou?"* — **checklist filler**: you derive the
     verifiable criterion yourself (an audit of the feed/catalog with no duplicate
     pairs). It is the "Sucesso" dimension applied mechanically — cut it.
   - ✅ *"Dedup no feed curado vs. corrigir o pipeline?" (options w/ pros/cons)* — the
     **only** legitimate one: a genuine design trade-off. Note: the human chose the
     NON-recommended option — proof that `recommended: true` never authorizes a
     machine to decide; a product choice ALWAYS stays with the human.

5. **Write the questions into the card FRONTMATTER (`questions:`).** The questions are
   STRUCTURED data on the card (not prose), so they aggregate on the `/perguntas` queue,
   round-trip as part of the card spec, and the next skill (`harness-enrich`) reads the answers.
   Add — or, on a RE-RUN, refresh WITHOUT duplicating a still-open question verbatim — a
   `questions:` list in the YAML frontmatter, one entry per question, ONE field per line:

   ```yaml
   questions:
     - id: q1
       text: <pergunta de alto impacto, aberta — SEM opções discretas; CURTO: 1–3 frases, sem IDs/hashes/log>
       askedBy: harness-grill
       askedAt: <YYYY-MM-DD de hoje>
       status: open
       context: <o PORQUÊ — as stakes/o que muda conforme a resposta (1-2 linhas)>   # SEMPRE
       recommendation: <a recomendação do agente em PROSA — análise honesta do caminho mais plausível>
     - id: q2
       text: <pergunta com alternativas claras — CURTO: 1–3 frases>
       askedBy: harness-grill
       askedAt: <YYYY-MM-DD de hoje>
       status: open
       context: <o PORQUÊ — o que está em jogo entre os caminhos (1-2 linhas)>        # SEMPRE
       mode: single            # single (uma) | multi (várias)
       options:                 # CAMINHOS plausíveis pro humano escolher num toque (não respostas factuais inventadas)
         - id: o1
           label: <alternativa A>
           pros: [<por que é bom — curto>, <…>]
           cons: [<o custo/contra — curto>]
           recommended: true     # NO MÁXIMO uma opção em toda a pergunta
         - id: o2
           label: <alternativa B>
           pros: [<…>]
           cons: [<…>]
   ```

   Use sequential ids (`q1`, `q2`, …) that don't collide with an existing question. Leave
   every `status: open` and DO NOT write an `answer` — you surface unknowns, never resolve
   them.

   **O `text` é a PERGUNTA, não a investigação — CURTO (1–3 frases).** É o CORPO que o
   operador lê primeiro no Inbox: comece pela pergunta aberta e dê só o mínimo pra
   entender o que se pergunta e por que importa. A investigação (o que você achou no
   código/dados: `file:line`, IDs, timestamps, queries) vai no `## Investigação`; as stakes/o
   PORQUÊ vão no `context:`. **NUNCA** cole hashes de commit, branch/run IDs, caminhos de
   arquivo como evidência, "N commits atrás" ou log de terminal dentro do `text` — esse
   "vazamento de terminal" soterra a decisão real. Bom `text`: *"Quando o usuário salva um
   evento, o recompute da curadoria dispara na hora (background) ou fica só marcado como
   'sujo' e roda quando ele reabre o feed?"* — uma pergunta, nenhum ID.

   **SEMPRE preencha `context:`** — o PORQUÊ da pergunta: as stakes, o que muda no design/escopo
   conforme a resposta (1-2 linhas). É isso que deixa o Inbox decidir num toque sem reabrir o card.

   **Quando a pergunta tem opções discretas**, SUGIRA-as como `options:` (2–5, ids `o1`, `o2`, …)
   com `mode: single|multi`, e para CADA opção dê `pros:`/`cons:` curtos (1–3 bullets cada) e marque
   a melhor com `recommended: true` — **no máximo UMA** opção recomendada em toda a pergunta. São
   plausible PATHS que o operador escolhe num tap, NOT fabricated facts; o free-text answer está
   sempre disponível ao lado, então as opções são um atalho, não uma jaula.

   **Quando NÃO há opções discretas** (pergunta puramente aberta), pode dar `recommendation:` em
   PROSA — a sua leitura do caminho mais plausível.

   **Princípio inviolável — nunca fabricar fatos.** `context`, `pros`/`cons` e `recommendation`/
   `recommended` são **análise honesta de caminhos plausíveis**, não respostas inventadas. Você está
   ajudando o humano a decidir mais rápido, não decidindo por ele nem afirmando fatos que não sabe; o
   texto livre do humano está sempre disponível e sobrepõe qualquer sugestão. Se você não tem base
   para recomendar, deixe `recommended`/`recommendation` de fora — apresentar os caminhos com
   prós/contras já é o serviço.

   A frontmatter list is the SINGLE source; do NOT scatter questions through the body and do NOT add
   a prose "## Grill" section (legacy cards may still carry one — leave it, but author new questions
   only as `questions:` entries). Findings go in `## Investigação`; questions go in `questions:` —
   never blur the two.

   **When you have ZERO questions:** write NO `questions:` entries (or leave the existing list
   untouched on a re-run). The `## Investigação` section carries your findings and the derived
   success criterion. This is a complete, valid result.

6. **Do NOT advance — leave the card in `grill`.** Edit the card **in place** at
   its existing path `storymap/boards/<board>/cards/<id>.md`. Bump the existing
   `updated:` field in-place to today (`YYYY-MM-DD`); keep one field per line. Do
   NOT change `status`, do NOT call `bun "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/scripts/advance-card.ts"`, do NOT touch
   `narrative`/`acceptance`/`tasks`/`rice` (those belong to later steps). The only
   body write is the `## Investigação` section.

7. **Report.** State that you grilled the card, SUMMARIZE the investigation findings
   (what you resolved yourself, with evidence), that it STAYS in `grill` awaiting the
   operator's answers on the `/perguntas` queue, the `id` (unchanged — it is
   immutable), and list the questions you wrote (or say plainly "nada a perguntar —
   a investigação resolveu os pontos abertos"). Remind the operator that, after
   answering, a human moves the card to Spec. In queue mode, summarize each card
   processed.

### Id is immutable

The card id is **permanent** — it was minted once at capture (`story-<hash>`) and
stays exactly that for the card's whole life. Do **NOT** rewrite it to a title
slug, do **NOT** create a `<slug>.md` + delete the old file. Edit the card in
place, keeping `id` untouched (a mid-pipeline rename breaks `parent`/`links[].to`
references and run tracking).

### Guardrail

This skill is read-mostly on DATA and read-ONLY on code. It INVESTIGATES (reads
product code, opens screenshots, runs read-only spikes/queries) but NEVER edits
product code and NEVER edits `packages/storymap-ui/`. Its only card writes are the
`questions:` frontmatter list, the `## Investigação` body section, and the `updated`
date. It MUST NOT advance the card, change its `status`, call `bun "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/scripts/advance-card.ts"`,
or fabricate answers (`status: open`, no `answer`). Findings from real code/data
are evidence, not answers — record them in `## Investigação`, never as a resolved
question. The richer question fields (`context`, `pros`/`cons`, `recommended`,
`recommendation`) are honest analysis of plausible paths to help the human decide;
never assert facts you don't know, and prefer omitting a recommendation over
inventing one. A genuine product/design CHOICE always stays with the human — even
when you have a recommendation. If you find yourself filling
narrative/acceptance, you have left this skill's scope — that is `harness-enrich`,
which runs AFTER the human answers and a human promotes the card to Spec.
