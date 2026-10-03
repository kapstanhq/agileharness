# Guardrails de reabertura + ciclo de vida do `mode`

> **Fonte única** referenciada pelas skills de triagem de reabertura (`harness-refine`,
> `harness-fix`) para os **guardrails comuns**, e por `harness-review` + `harness-qa` para o
> **ciclo de vida do `mode`**. Conteúdo específico de cada skill (a reprodução do bug
> no fix, o WSJF por eixo, as lentes do review, o sweep do QA) permanece no respectivo
> `SKILL.md`.

## Guardrails comuns

Valem para as skills de triagem de reabertura (`harness-refine`, `harness-fix`), que
DIAGNOSTICAM uma story já entregue e a ROTEIAM de volta ao pipeline:

1. **Nunca recriar do zero.** A implementação já existe — melhore/corrija **in-place**.
   Não reconstrua componentes/rotas/handlers que já entregam a story. Ancore-se sempre
   ao diagnóstico (`@.claude/skills/harness-triage-shared/DIAGNOSIS.md`). Se não achar o que
   entregou a story, diga-o no corpo (`## Refino` / `## Bug`) e roteie conservadoramente.

2. **Reconcilie as build tasks — nunca deixe vazar.** As `tasks` no card são do build
   ORIGINAL (em geral todas `done: true`); elas não descrevem o delta/fix. SEMPRE OU
   regenere-as a partir do novo `acceptance` (rota `desenvolver`) OU limpe-as
   (`tasks: []`) para re-derivação após o design (rota `design-ux`) — um `harness-do` a
   jusante nunca pode re-executar uma task de build obsoleta.

3. **Uma reabertura NÃO re-prioriza a story entregue.** Para uma REABERTURA (o card já
   tem `rice`/`kano`/`funnelStage` da feature entregue): **PRESERVE-os intactos** — o
   card mantém o `priorityScore` original. Um item NOVO vindo da Triagem (sem rice)
   carrega os eixos WSJF do seu tipo (melhoria: `rice.impact` + `rice.effort`; bug:
   `severity` + `frequency` + `hasWorkaround`) — preencha esses, nunca invente um RICE.
   Se a reabertura for grande o bastante para mudar a aposta inteira (ou for uma
   capacidade nunca construída), é uma feature/story NOVA, não um refino/fix — diga-o e
   pare, sem reaproveitar o card.

4. **Read-only no código de produto.** As skills de triagem DIAGNOSTICAM; não editam
   `packages/<pkg>/`. Os únicos arquivos escritos são o card `.md` (+ o sidecar de
   wireframe, quando há). Quem escreve código de produto é o `harness-do`, depois, em modo
   refine/fix.

5. **Mantenha o `mode`.** É o marcador que toda skill a jusante lê. NÃO o limpe ao
   rotear — ver **[Ciclo de vida do `mode`](#mode-lifecycle)** para quem mantém e quem
   limpa.

6. **Não auto-execute escritas de código.** Rotear só DEFINE o status alvo; se aquela
   coluna então auto-roda é decidido pela flag `autorun` dela no `board.yaml`
   (`false` = espera um humano; `true` = a cascata segue). A skill de triagem em si
   NUNCA escreve código de produto — ela para após rotear.

7. **Nunca toque em `packages/storymap-ui/`** a menos que a própria AgileHarness UI SEJA o
   alvo da reabertura.

### Por que não rotear por `quebrar-tasks` / `priorizar`?

No board default essas colunas são `autorun: true` — pousar um card de refino/fix ali
cascateia para o `harness-prioritize`, que **sobrescreve** o `rice`/`kano`/`funnelStage` já
decidido (ferindo o guardrail #3). Por isso refino/fix mantêm a priorização original e
reconciliam as tasks **in-place** na própria coluna de triagem (`refinar`/`corrigir`),
em vez de repassar por `quebrar-tasks`/`priorizar`.

## Ciclo de vida do `mode` {#mode-lifecycle}

`mode: refine` (melhoria) e `mode: fix` (correção) marcam uma story reaberta como uma
melhoria/correção **in-place** de algo que já existe — não um build do zero. O marcador
é um campo tipado (renderiza como o chip **REFINO**/**BUG** no card) e tem um dono claro
em cada estação do pipeline:

- **Quem SETA** — a **UI**. O botão **Refinar** grava `mode: refine` + o bloco
  `refinement` e move o card para `refinar`; o botão **Reportar bug** grava `mode: fix` +
  `bugReport` e move para `corrigir`. Um card carrega **um** bloco de reabertura por vez
  (reportar um bug limpa um refino pendente, e vice-versa).

- **Quem MANTÉM** — `harness-refine` / `harness-fix` (triagem) mantêm o `mode` ao rotear para
  `design-ux`/`desenvolver`; `harness-ux` / `harness-do` o mantêm ao desenhar/implementar
  in-place; `harness-review` o mantém ao avançar `revisar-codigo → qa-automatizado`. O
  `harness-sync-card`, se reconciliar um card reaberto, também PRESERVA `mode` + o bloco de
  reabertura (não arranca um card de um refino/fix em voo).

- **Quem LÊ** — toda skill a jusante escopa pelo `mode`: `harness-ux`/`harness-do`
  melhoram/corrigem in-place (o `harness-do` em modo `fix` escreve PRIMEIRO o teste que
  reproduz o bug — TDD ao contrário); `harness-review` pesa a revisão para REGRESSÃO (e exige
  o teste de regressão no modo fix); `harness-qa` testa só o DELTA refinado (modo refine) /
  exige o teste de repro (modo fix), não a story inteira.

- **Quem LIMPA** — o **`harness-qa`**, e somente ele, ao avançar `qa-automatizado → revisao`
  com o QA verde: limpa `mode` + `refinement`/`bugReport`, e a story volta a ser uma
  `concluida` comum. O `harness-review` **NÃO** limpa o marcador — a coluna seguinte
  (`qa-automatizado`) ainda precisa do `mode` para escopar o QA ao delta/regressão; o
  review é a última estação que apenas o MANTÉM. Ao entregar via `revisar-codigo →
  qa-automatizado`, deixe o marcador no lugar.
