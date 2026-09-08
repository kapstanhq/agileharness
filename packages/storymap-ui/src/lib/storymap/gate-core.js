// @ts-nocheck
/**
 * gate-core — the SINGLE SOURCE of the AgileHarness pipeline gates. Pure CommonJS with ZERO
 * imports, so it is ISOMORPHIC: the TS app imports it (typed via gate-core.d.ts — gates.ts /
 * rice.ts / priority.ts are thin re-export barrels over this file) AND the pre-write hook
 * (`.claude/hooks/checks/pre-write/validate-storymap-gate.js`) `require()`s it directly,
 * after a js-yaml parse, instead of re-implementing the predicates in ~200 lines of regex.
 *
 * A gate is a pure predicate over a card + the PT-BR `label` (UI chip), `message` (why the
 * move is blocked) and `fix` (how to unblock). board.yaml's `gate:` per status declares WHICH
 * gate guards it; this file maps the id → predicate. checkGate() returns the message string
 * (the app's historical API); evaluateGate() returns the rich object the hook wraps. Keeping
 * ONE implementation is the whole point of B4 — there is no second copy to drift from.
 */

/** RICE score — DERIVED, never persisted. score = (reach*impact*confidence)/effort; null unless
 *  all four are present AND effort > 0. (Was lib/storymap/rice.ts — now re-exported from here.) */
function riceScore(rice) {
  if (!rice) return null;
  const { reach, impact, confidence, effort } = rice;
  if (reach == null || impact == null || confidence == null || effort == null) return null;
  if (!(effort > 0)) return null;
  return (reach * impact * confidence) / effort;
}

/** Which prioritization shape a card scores under (DERIVED, so a reopened feature keeps its bet).
 *  (Was the head of lib/storymap/priority.ts — now re-exported from here.) */
function priorityKind(card) {
  if (card.kano != null && card.funnelStage != null && riceScore(card.rice) != null) return "feature";
  if (card.storyType === "bug" || card.mode === "fix") return "bug";
  if (card.mode === "refine") return "melhoria";
  return "feature";
}

/** Canonical bug severity for prioritization: first-class `severity` (ADR-056), falling back to a
 *  reopened story's `bugReport.severity`. (Was lib/storymap/priority.ts — now re-exported.) */
function bugSeverityOf(card) {
  return card.severity ?? card.bugReport?.severity ?? null;
}

/** The Agile narrative is complete when all three clauses are written (non-empty after trim). */
function hasNarrative(card) {
  const n = card.narrative;
  return !!(n && n.role?.trim() && n.want?.trim() && n.soThat?.trim());
}

/** A pipeline date-stamp (stagedAt/releasedAt) is PRESENT iff it survives toDateString (repo.ts):
 *  non-null AND non-empty once stringified. A raw `false`/`0` — which the app coerces to the truthy
 *  "false"/"0" — therefore reads as PRESENT on BOTH paths, so the hook never FALSE-BLOCKS a stamped
 *  card (a naive `!!stagedAt` would). Pure. */
function stamped(v) {
  return v != null && String(v) !== "";
}

/**
 * deploy-truth (D-DT4) — does this card DECLARE code? The POSITIVE rule that replaces the fail-open
 * "no stagedAt ⇒ pass" escape hatch: a card is code-bearing when the pipeline staged it (`stagedAt`,
 * merge-train stamp) OR it carries a reviewed/QA'd `commitRange` (the skills' durable delta record).
 * A card with NEITHER is affirmatively no-code (chore/doc/spike/board-only) — that ABSENCE-OF-CLAIM,
 * not absence of measurement, is what exempts it from release/deploy proof. The distinction matters:
 * before, `!stamped(stagedAt)` alone let exactly the class of card that never deployed pass vacuously
 * (a card whose code rode a run branch but was never staged has a commitRange and no stagedAt — the
 * eqpdtz/xfleex shape). Shared by hasReleased + hasDeployProof AND by the server settle handler
 * (deploy-reconcile), so "has code" is ONE ruler everywhere. Parity-safe: `stamped` is string-safe and
 * the commitRange check requires both non-empty base+head — the same drop-rule coerceCommitRange
 * applies, so a malformed range (missing half) reads as no-range on BOTH the raw-yaml (hook) and the
 * coerced (app) path. Pure, zero imports (isomorphic — the pre-write hook require()s this file).
 */
function declaresCode(card) {
  if (stamped(card.stagedAt)) return true;
  const r = card.commitRange;
  return !!(r && typeof r === "object" && stamped(r.base) && stamped(r.head));
}

/**
 * Does this card touch a USER-VISIBLE UI surface? Drives hasQaPassed: a card WITH a surface must
 * pass the VISUAL QA sweep; one WITHOUT is exempt — REGARDLESS of storyType.
 *
 * THREE sources, in descending order of trustworthiness:
 *
 *  1. **EVIDENCE** (`uiSurfaceEvidence.touched`) — server-stamped by the ENGINE from the run's real
 *     diff (runner/staging.ts `pathsTouchUiSurface`). A FACT, so it outranks every declaration,
 *     including an explicit `hasUiSurface: false`: when the run provably rewrote a screen, a card
 *     saying otherwise is drift, and a SAFETY gate must fail toward looking at the screen. Evidence
 *     that says `touched: false` is equally a measurement — it exempts.
 *  2. **DECLARATION** (`hasUiSurface`) — the human/skill opinion. Still honoured when nothing was
 *     measured (a card whose work hasn't run yet, or a board-only card).
 *  3. **FALLBACK** (`storyType === "user"`) — the legacy rule, kept byte-identical so a card with
 *     neither evidence nor declaration behaves exactly as before (zero migration).
 *
 * Why evidence had to be added: the declaration was set on 1 of 311 real cards, so tier 2 was
 * effectively dead and tier 3 decided everything — and tier 3 under-classifies by construction, since
 * a `chore`/`technical`/`bug` that rewrites a component is NOT a `user` story. That is not
 * theoretical: a 12-file, 100%-UI `chore` passed this gate with zero visual QA (2026-07-22).
 *
 * NON-story cards (activity/step) never have a QA-able surface. String/number-SAFE: a malformed
 * (non-boolean) value falls through to the next tier, so the raw-yaml hook and the coerced app agree
 * (parity contract). Pure, zero imports (isomorphic — the pre-write hook require()s this file).
 */
function hasUiSurface(card) {
  if (card.type !== "story") return false;
  const ev = card.uiSurfaceEvidence;
  if (ev && typeof ev === "object" && typeof ev.touched === "boolean") return ev.touched;
  if (card.hasUiSurface === true) return true;
  if (card.hasUiSurface === false) return false;
  return (card.storyType ?? "user") === "user";
}

/**
 * Did the QA that stamped this card actually LOOK AT THE SCREEN?
 *
 * `qaPassed` is ONE bit carrying TWO different proofs: the `harness-qa` browser branch (E2E + visual
 * sweep) and its suite-only branch ("the package's test suite green — NOT a browser") both set it,
 * as does a human `approve_qa`. So a gate asking `qaPassed === true` cannot tell "the screen was
 * checked" from "vitest was green", and the visual sweep was never actually enforceable — the
 * comment claiming it was, was wrong for as long as it existed.
 *
 * `qaEvidence.visual` is the missing distinction, written by whoever ran the QA. ABSENT ⇒ null
 * (unknown, NOT false): a card stamped before this field existed is not retroactively accused of
 * skipping the sweep — hasQaPassed decides what to do with the unknown.
 */
function qaVisualProof(card) {
  const ev = card.qaEvidence;
  if (!ev || typeof ev !== "object") return null;
  return typeof ev.visual === "boolean" ? ev.visual : null;
}

/**
 * The gate map. Each entry: ok (predicate), label (UI chip), message (why blocked), fix (how to
 * unblock — surfaced by the pre-write hook). PT-BR throughout. Mirrors storymap/frameworks.md §4
 * for the prioritization rubric. THIS is the source; the hook reads board.yaml for which gate
 * guards which status and runs these predicates on the parsed card.
 *
 * PARITY CONTRACT (raw js-yaml in the hook vs coerceCard() in the app) — proven by
 * gate-core-parity.test.ts. The predicates here check PRESENCE + the core gate logic, written to
 * be string/number/null-SAFE so a raw value and its coerced form reach the SAME verdict for every
 * WELL-FORMED card. They deliberately do NOT re-validate enums (kano/funnelStage/severity/frequency/
 * finding-status) nor re-coerce numbers to finite — that validation lives in coerceCard, and
 * duplicating those constants here would re-create the drift B4 removed. So for MALFORMED inputs
 * (an invalid enum value, a non-finite RICE number) the hook is intentionally LENIENT: it never
 * FALSE-BLOCKS, and defers the strict check to the app's authoritative checkGate on the board move.
 */
const GATES = {
  hasAcceptance: {
    label: "critérios de aceite",
    ok: (card) => (card.acceptance?.length ?? 0) >= 1,
    message: "Adicione ao menos 1 critério de aceite antes de marcar como Refinada.",
    fix: "Preencha `acceptance:` com >= 1 critério (rode /harness-enrich — ou via update_card no MCP).",
  },
  hasRefinement: {
    label: "narrativa + aceite",
    ok: (card) => hasNarrative(card) && (card.acceptance?.length ?? 0) >= 1,
    message:
      "Para entrar em Priorizar: escreva a narrativa da story (papel + quero/precisamos + para/de modo que) e ao menos 1 critério de aceite. Rode /harness-enrich — ou preencha os campos direto via update_card (MCP).",
    fix: "Escreva `narrative:` (role/want/soThat) + `acceptance:` (>= 1) no card (rode /harness-enrich, ou update_card no MCP). O gate valida o conteúdo final, não só a linha alterada.",
  },
  hasTasks: {
    label: "tasks",
    ok: (card) => (card.tasks?.length ?? 0) >= 1,
    message:
      "Quebre a story em ao menos 1 task antes de mandá-la para Em desenvolvimento. Rode /harness-tasks (tasks NÃO é settável via update_card).",
    fix: "Preencha `tasks:` com >= 1 task — rode /harness-tasks (tasks NÃO está no update_card; é o único caminho). O gate valida o conteúdo final, não só a linha alterada.",
  },
  hasRice: {
    label: "Prioridade",
    // Prioridade argumentada (reasoning-first) satisfaz o gate — ninguém é forçado a inventar alcance/RICE.
    ok: (card) => card.priorityCall != null || riceScore(card.rice) != null,
    message: "Avalie a prioridade (rode /harness-prioritize) OU preencha o RICE (reach, impact, confidence e effort > 0) antes de marcar como Pronta p/ build.",
    fix: "Rode /harness-prioritize (atribui um tier argumentado) OU complete os 4 campos de `rice:` (effort > 0). O gate valida o conteúdo final, não só a linha alterada.",
  },
  hasPrioritization: {
    label: "Prioridade",
    ok: (card) => {
      // Prioridade ARGUMENTADA (reasoning-first) satisfaz o gate — ninguém é forçado a inventar alcance/RICE.
      if (card.priorityCall) return true;
      const kind = priorityKind(card);
      if (kind === "bug") return bugSeverityOf(card) != null && card.frequency != null;
      if (kind === "melhoria")
        return card.rice?.impact != null && card.rice?.effort != null && card.rice.effort > 0;
      return riceScore(card.rice) != null && card.kano != null && card.funnelStage != null;
    },
    message:
      "Para marcar como Pronta p/ build, avalie a prioridade — rode /harness-prioritize (o agente atribui um TIER argumentado). Alternativa legada: preencher a priorização numérica do TIPO (feature → RICE+KANO+funil; bug → severidade+frequência; melhoria → impacto+esforço).",
    fix: "Rode /harness-prioritize — grava a prioridade argumentada (priorityCall) e satisfaz o gate. Alternativa legada: feature → RICE+`kano`+`funnelStage` (update_card); bug → `severity`+`frequency` (SÓ via /harness-prioritize); melhoria → `impact`+`effort`. Espelha storymap/frameworks.md §4.",
  },
  hasTechPlan: {
    label: "plano técnico",
    ok: (card) => card.techPlanReady === true,
    message: "Rode /harness-plan para escrever o plano técnico (plans/<id>.md) antes de ir para Quebrar em tasks.",
    fix: "Rode /harness-plan — é o ÚNICO caminho (escreve plans/<id>.md + grava `techPlanReady`). `techPlanReady` NÃO é settável via update_card.",
  },
  hasWireframe: {
    label: "wireframe escolhido",
    ok: (card) => !!card.wireframeChosen,
    message: "Escolha uma opção de wireframe via choose_wireframe (MCP), ou rode /harness-ux, antes de marcar como Com design.",
    fix: "Escolha um wireframe com choose_wireframe(optionId) (MCP) — ou rode /harness-ux. `wireframeChosen` NÃO é settável via update_card.",
  },
  hasCriteriaSpecs: {
    label: "specs de aceite",
    // ADR-063 (2c) SHIFT-LEFT: a UI-observable card carries an acceptance→spec map BEFORE code review /
    // QA, so QA is a RUNNER (a missing spec ROUTES BACK, not re-authored). DEFAULT-SATISFIED when the
    // field is absent/empty (ZERO-MIGRATION — never freezes a legacy card or a UI-less card); only a card
    // that DECLARED criteriaSpecs with an entry missing its specPath blocks. Parity-safe: array/string/
    // null-safe, never throws, never false-blocks a well-formed card (gate-core-parity.test). hasUiSurface
    // is the SAME kernel guard hasQaPassed uses, so the two QA gates agree on what "has a UI surface" means.
    ok: (card) => {
      if (!hasUiSurface(card)) return true;
      const specs = card.criteriaSpecs;
      if (!Array.isArray(specs) || specs.length === 0) return true;
      return specs.every((s) => s && typeof s.specPath === "string" && s.specPath.trim() !== "");
    },
    message:
      "Há critério(s) de aceite UI sem spec autorado. Rode /harness-tests (autora os specs + preenche criteriaSpecs) antes da Revisão de código / QA — o QA é um RUNNER, não re-autora spec faltante.",
    fix: "Preencha `criteriaSpecs:` com um `specPath` para cada critério UI-observável (rode /harness-tests). O gate é satisfeito quando o campo está ausente/vazio (cards legados nunca travam) — só bloqueia uma entrada declarada SEM specPath.",
  },
  hasBuildEvidence: {
    label: "evidência de build",
    // C2 (2026-07-08, ny4v26): um card chegou a revisar-codigo SEM implementação — o avanço sancionado
    // foi engolido (C1) e a skill flipou `status:` na mão. Este gate faz a aresta desenvolver→revisar-codigo
    // exigir EVIDÊNCIA: toda task declarada concluída (o harness-do marca todas ao terminar). (autonomo-liberdade-
    // humana M4, 2026-07-18: o carimbo manual `mark_tasks_done` foi APOSENTADO — não há mais flip à mão para
    // humano nem agente; a evidência é a conclusão real das tasks OU a convergência de conteúdo, abaixo.)
    // DEFAULT-SATISFIED com tasks ausentes/vazias (zero-migration —
    // hasTasks já guarda a entrada de desenvolver; um card legado/sem-tasks nunca congela). Como todo gate,
    // vale para QUALQUER escritor via o hook pre-write — inclusive o flip manual de status, o vetor exato
    // do ny4v26. Compõe hasCriteriaSpecs (o gate anterior deste step) porque um step carrega UM gate id.
    // Parity-safe: array/entry-safe, nunca lança; entrada de task malformada conta como não-done (bloqueia),
    // o mesmo espírito fail-closed-no-declarado do hasCriteriaSpecs.
    //
    // WS-5.2 (colisão #4 / story-uae2ag): as tasks são um PROXY de evidência, e o proxy tem um ponto cego —
    // quando o código do card JÁ ATERRISSOU num run anterior, o comportamento CORRETO do run seguinte é não
    // implementar nada: nenhuma task vira done, nenhuma evidência aparece, e o card deadlocka em Desenvolver
    // para sempre (todo harness-do futuro re-bate no mesmo no-op). Por isso o gate aceita (tasks todas done) OU
    // (`buildEvidence` carimbado). Isto NÃO afrouxa a C2: o carimbo é escrito EXCLUSIVAMENTE pelo engine
    // quando `deltaLanded` devolve `landed` — PROVA POSITIVA por conteúdo de que o delta está na base. O gate
    // continua exigindo evidência; passou a aceitar a prova direta além do proxy. `criteriaSpecs` segue
    // exigido nos dois caminhos (o carimbo prova o build, não o spec).
    // Parity: checa SÓ a `provenance` (string idêntica no yaml cru e no card coerçido) — `at` vira Date no
    // js-yaml e string no app, então depender dele quebraria a paridade.
    ok: (card) => {
      const tasks = Array.isArray(card.tasks) ? card.tasks : [];
      const allDone = tasks.length === 0 || tasks.every((t) => t && t.done === true);
      const ev = card.buildEvidence;
      const proven = !!ev && typeof ev === "object" && String(ev.provenance || "").trim() === "already-landed";
      return (allDone || proven) && GATES.hasCriteriaSpecs.ok(card);
    },
    message:
      "Sem evidência de build: há task(s) declarada(s) não concluída(s) (ou spec de aceite UI faltante). Rode /harness-do até concluir as tasks. Não há carimbo manual (mark_tasks_done foi aposentado): a evidência é a conclusão real das tasks OU a convergência de conteúdo do run.",
    fix: "Conclua as tasks (`done: true` em todas — o /harness-do faz isso ao terminar) e garanta `criteriaSpecs` completos (/harness-tests). O gate valida o conteúdo final, não só a linha alterada. Um card cujo código já aterrissou num run anterior é destravado pelo próprio engine (carimbo `buildEvidence: already-landed`, provado por conteúdo). Card half-landed (código em stage, metade de dados ausente em main): o auto-heal da metade de dados (WS-3) aterrissa o resto e a convergência prova — se persistir, re-rode o card pelo pipeline.",
  },
  hasNoBlockers: {
    label: "sem blocker aberto",
    // A finding only counts if it is WELL-FORMED — same rule coerceFindings applies (a finding
    // with no title is dropped). Encoding it in the predicate makes the verdict identical whether
    // it runs on a coerceCard()-normalized card (app) or a raw js-yaml parse (the pre-write hook):
    // a malformed/titleless blocker is ignored by BOTH, so the hook never false-blocks. (Verified
    // by gate-core-parity.test.ts.) The app is unaffected — its coerced findings always have a title.
    //
    // `failureClass: "infra"` is EXCLUDED — an environment defect is a DIAGNOSIS, never a veto on the
    // card. This is the same doctrine buildRunDeathFinding already states in prose ("não-bloqueante, o
    // card NÃO foi movido"); here it becomes structural, so a skill that files an infra failure as a
    // blocker cannot wedge a card the way the chrome-devtools incident did — a card sat behind
    // `qa-infra-chrome-devtools-unavailable`, a veto no card-level change could ever lift, because the
    // HOST lacked a browser. Nothing advances dishonestly: the step's real gate (hasQaPassed, which
    // demands the visual evidence) still holds the card, and holds it with the accurate message.
    ok: (card) =>
      !(card.findings ?? []).some(
        (f) =>
          f &&
          f.severity === "blocker" &&
          f.status === "open" &&
          f.failureClass !== "infra" &&
          f.title != null &&
          String(f.title).trim() !== "",
      ),
    message:
      "Há finding(s) de severidade 'blocker' em aberto. Resolva (marque fixed/wontfix) ou rode /harness-review antes de ir para o QA automatizado. (Findings de AMBIENTE — `failureClass: infra` — não contam: conserte o host, não o card.)",
    fix: "Resolva os finding(s) `severity: blocker` (marque `status: fixed`/`wontfix`) ou rode /harness-review.",
  },
  hasQaPassed: {
    label: "QA (aceite + visual) verde",
    // Exempt cards with NO UI SURFACE from QA (not "non-user" — see hasUiSurface). This fixes the
    // root leak: a `bug` fixing a VISUAL regression (hasUiSurface:true) now REQUIRES the visual sweep
    // instead of shipping unproven; a UI-less `user` story (hasUiSurface:false) isn't deadlocked by a
    // pointless visual QA. With the field absent, hasUiSurface falls back to storyType==="user", so the
    // verdict is IDENTICAL to the previous user-only rule (zero migration). Parity-safe (gate-core-parity.test).
    // Duas perguntas, não uma. (a) ESTE card tem superfície? — por EVIDÊNCIA do diff antes de qualquer
    // declaração (ver hasUiSurface). (b) O QA que carimbou olhou para a TELA? — `qaPassed` sozinho não
    // responde: os dois ramos do harness-qa (browser e só-suíte) carimbam o MESMO bit, então exigi-lo nunca
    // exigiu sweep nenhum. Só cobramos a prova visual de quem tem superfície MEDIDA: para um card sem
    // medição (anterior a este campo, ou sem run de código) o veredito é byte-idêntico ao de antes —
    // fechar o vazamento não pode travar card em voo.
    ok: (card) => {
      if (!hasUiSurface(card)) return true;
      if (card.qaPassed !== true) return false;
      const ev = card.uiSurfaceEvidence;
      const measured = !!(ev && typeof ev === "object" && ev.touched === true);
      return measured ? qaVisualProof(card) === true : true;
    },
    message:
      "Rode /harness-qa para validar os critérios de aceite de ponta a ponta (E2E + visual) e marcar qaPassed antes de ir para a Revisão humana. " +
      "Se o diff deste card tocou tela (uiSurfaceEvidence.touched), o QA precisa REGISTRAR que o sweep visual rodou — um qaPassed vindo só da suíte não prova tela.",
    fix:
      "Rode /harness-qa (aceite end-to-end + sweep visual) e grave `qaPassed: true` + `qaEvidence: { suite, visual: true, at }`. " +
      "Se você validou a tela na mão, use approve_qa com `visual: true` (é você afirmando que olhou).",
  },
  hasRefineBrief: {
    label: "brief de refino",
    // String(...)-safe (matches coerceRefinement's String(brief).trim()): a raw brief that parses to
    // a non-string (e.g. `brief: []`) would THROW on `.trim()` — String() coerces it instead, so the
    // hook agrees with the app AND never throws (a thrown predicate only "passes" via the outer catch).
    ok: (card) => !!String(card.refinement?.brief ?? "").trim(),
    message:
      "Para entrar em Refinar, o card precisa de um feedback de refino. Use o botão “Refinar” em um card concluído — ele captura o brief + o tipo (UI/UX/copy/funcionalidade).",
    fix: "Use a ação “Refinar” num card concluído — ela grava `refinement.brief` + o tipo.",
  },
  hasBugReport: {
    label: "relato de bug",
    ok: (card) => !!String(card.bugReport?.brief ?? "").trim(),
    message:
      "Para entrar em Corrigir, o card precisa de um relato de bug. Use o botão “Reportar bug” em um card em Revisão ou Concluída — ele captura o relato + a severidade + o esperado×atual.",
    fix: "Use a ação “Reportar bug” — ela grava `bugReport.brief` + severidade + esperado×atual.",
  },
  hasRetireBrief: {
    label: "motivo de descontinuação",
    ok: (card) => !!String(card.retirement?.brief ?? "").trim(),
    message:
      "Para entrar em Descontinuar, o card precisa de um motivo de descontinuação. Use o botão “Descontinuar” num card — ele captura o motivo + a disposição + o nível de remoção.",
    fix: "Use a ação “Descontinuar” num card — ela grava `retirement.brief` + a disposição + o nível de remoção.",
  },
  hasDuplicateOf: {
    label: "aponta o card canônico",
    ok: (card) => !!String(card.duplicateOf ?? "").trim(),
    message:
      "Para entrar em Duplicado, o card precisa apontar o card canônico em `duplicateOf`. Use a ação de triagem “Marcar duplicado”.",
    fix: "Grave `duplicateOf: <id-canônico>` (ação de triagem “Marcar duplicado”).",
  },
  hasStaged: {
    label: "código na branch stage",
    ok: (card) => stamped(card.stagedAt),
    message:
      "O código desta story ainda não foi integrado na branch `stage`. Ele é staged quando o build (harness-do) integra — aguarde a integração antes do release.",
    fix: "Aguarde o merge train integrar o código na branch `stage` (stamp `stagedAt`).",
  },
  hasReleased: {
    label: "promovido para main (release)",
    // deploy-truth (D-DT4) — FAIL-CLOSED. The old escape `|| !stamped(stagedAt)` encoded "absence of
    // evidence = authorization": a card that NEVER staged (exactly the class that never deployed) passed
    // vacuously. The rule is now the POSITIVE no-code affirmation ({@link declaresCode}): a card passes
    // when `releasedAt` is stamped (the release promoted its code to main) OR it declares NO code at all
    // (no stagedAt AND no commitRange — chore/doc/spike). A card with a commitRange but no stagedAt is
    // code that never reached the pipeline's release path — it BLOCKS, it does not slip through. Who
    // acts needs proof; silence is not a license (the deltaLanded/steward asymmetry, applied here).
    ok: (card) => stamped(card.releasedAt) || !declaresCode(card),
    message:
      "Esta story tem código não liberado (staged e/ou com commitRange) sem `releasedAt`. Promova o código `stage` → `main` pelo caminho de release do board antes de concluir — sem prova de release, um card com código não termina.",
    fix: "Publique pelo pipeline (o release carimba `releasedAt` na promoção stage → main). Um card genuinamente SEM código (sem `stagedAt` e sem `commitRange`) passa sozinho — não invente carimbo na mão.",
  },
  // deploy-truth WS-1 (D-DT1/D-DT8) — a PROVA de produção que o terminal "No ar" exige. O gate é um
  // predicado PURO sobre o carimbo `deployProof`: quem MEDE é o handler de settle/reconcile no servidor
  // (deploy-reconcile.ts, reusando a régua de ancestralidade releasedSha ⊆ sha publicado — nunca uma
  // régua nova, nunca igualdade), e quem EXIGE é este gate. Gates jamais rodam git/rede (isomorfismo do
  // pre-write hook); a separação medição-no-settle × exigência-no-gate é a decisão D-DT1. Um card
  // sem código (mesma régua positiva do hasReleased — {@link declaresCode}) passa sem prova: um chore/
  // spike não publica nada, logo não há o que provar (D-DT8). Parity-safe: só o campo string `sha` é
  // checado (o `at` vira Date no js-yaml cru — depender dele quebraria a paridade, o mesmo racional do
  // hasBuildEvidence); um carimbo malformado sem sha não é prova em NENHUM dos dois caminhos.
  hasDeployProof: {
    label: "prova de deploy (No ar)",
    ok: (card) => {
      const p = card.deployProof;
      const proven = !!p && typeof p === "object" && String(p.sha || "").trim() !== "";
      return proven || !declaresCode(card);
    },
    message:
      "Sem prova de publicação: o deploy deste card ainda não foi CONFIRMADO (o settle não carimbou `deployProof`). O card fica em Publicar até o deploy settlar ok em todos os alvos — aguarde a confirmação (ou veja a demanda deploy-unsettled se ela passou do SLA).",
    fix: "Aguarde o settle do deploy confirmar (o handler mede a ancestralidade e carimba `deployProof` sozinho). Se a publicação foi feita fora do board (CLI), a reconciliação por evidência também carimba. NUNCA escreva `deployProof` na mão — carimbo sem medição é a mentira que este gate existe para impedir. Card sem código (sem `stagedAt`/`commitRange`) passa sem prova.",
  },
  // WS6 (F5): uma story só entra em CONSTRUÇÃO com lugar decidido — tem um `parent` (step do mapa), um
  // `serves` (entrega ancorada a uma user-story), OU um `unplacedAck` explícito ("sem lugar, decidido").
  // Órfã não-decidida circula por triagem/descoberta mas para aqui. Non-story (activity/step, que são
  // raízes válidas do mapa) e legado sem tipo passam sempre. CJS puro, zero imports (roda no pre-write hook).
  hasPlacement: {
    label: "lugar no mapa",
    // DELEGA à invariante (placementViolation) — não há segunda definição de "ter lugar". Com `ctx`
    // (o board à mão) o gate valida existência e TIPO da âncora; sem ele, só a forma. A perna
    // `unplacedAck != null` foi APOSENTADA: era ela que deixava um órfão atravessar o pipeline
    // "aceito sem lugar", e foi assim que 83 cards ficaram fora da hierarquia.
    ok: (card, ctx) => placementViolation(card, ctx && ctx.lookup, ctx && ctx.config) == null,
    message:
      "Este card não tem lugar na hierarquia. Abra o card → bloco Posição no mapa e defina onde ele vive: uma user story fica sob um PASSO; uma entrega (técnica/bug/chore/spike) fica sob a USER STORY que ela serve.",
    fix: "No card → Posição no mapa: escolha o pai (o passo que a story detalha) ou o serves (a story base que a entrega serve). O gate valida o estado final do card.",
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// HIERARQUIA — a invariante de ancoragem do Story Map
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Um card do Story Map tem SEMPRE um lugar na hierarquia de Patton. Não existe "card solto":
 *
 *   activity  → é a raiz (não tem pai)
 *   step      → filho de uma ACTIVITY
 *   user story→ filha de um STEP
 *   entrega   → filha de uma USER STORY (a "story base"), por `serves` ou por `parent`
 *   (entrega = story com storyType technical/bug/chore/spike — o "como", não o "o quê")
 *
 * Três — e apenas três — classes de card ficam legitimamente FORA do backbone, cada uma por um
 * motivo declarado:
 *
 *   1. CONTÊINER efêmero (`capture` / `container`): texto livre revisado no Inbox/Estilo, some
 *      depois. Nunca foi item de trabalho.
 *   2. `idea`: a camada do meio da Idea Solution Tree (ADR-060), que tem superfície
 *      própria e por desenho não fica no backbone.
 *   3. Card em status de QUARENTENA (`staging`, hoje a Triagem) ou TERMINAL:
 *      • a quarentena é a caixa de entrada — quem chega por texto livre (report_issue) ainda não
 *        sabe onde encaixa, e é justamente o aceite da triagem que exige a decisão de lugar;
 *      • o terminal é HISTÓRIA. Os cards concluídos antes desta regra não são reancorados à força
 *        (decisão explícita do operador); em compensação, REVIVER um card terminal o traz para uma
 *        coluna viva, onde a invariante volta a valer e a âncora passa a ser exigida.
 *
 * PURA e isomórfica, como o resto deste arquivo. `lookup(id)` devolve o card daquele id (ou
 * null/undefined). Sem `lookup` a checagem degrada para SÓ A FORMA (tem âncora declarada?) — é o
 * que o gate consegue ver do cliente; a checagem completa (a âncora existe? é do tipo certo?) roda
 * no chokepoint de ESCRITA, que é quem tem o board inteiro à mão e é onde a regra é fail-closed.
 *
 * Devolve `null` quando o card está em ordem, ou `{ code, message }` descrevendo a violação.
 */
function placementViolation(card, lookup, config) {
  const spec = placementSpec(card, config);
  if (!spec) return null; // isento por desenho, ou tipo desconhecido (forward-compatible)

  if (spec.rootOnly) {
    return spec.anchorId
      ? { code: "activity-com-pai", message: "Uma ação (activity) é raiz do mapa e não pode ter pai." }
      : null;
  }
  if (!spec.anchorId) {
    return {
      code: "sem-ancora",
      message: `Este card não tem lugar na hierarquia: falta ${spec.field} apontando para ${spec.wanted}.`,
    };
  }
  if (typeof lookup !== "function") return null; // modo forma-apenas (ver doc acima)

  const anchor = lookup(spec.anchorId);
  if (!anchor) {
    return {
      code: "ancora-inexistente",
      message: `O ${spec.field} deste card aponta para "${spec.anchorId}", que não existe neste board.`,
    };
  }
  if (!spec.accepts(anchor)) {
    return {
      code: "ancora-de-tipo-errado",
      message: `O ${spec.field} deste card aponta para "${spec.anchorId}", que é ${describeCardKind(anchor)} — precisa ser ${spec.wanted}.`,
    };
  }
  return null;
}

/**
 * O que ESTE card precisa como âncora — a decisão de "qual campo manda e que tipo ele deve apontar",
 * isolada para ter UM dono. Devolve null quando o card é isento (contêiner/ideia/quarentena/
 * terminal ou tipo desconhecido). `rootOnly` marca a activity, que não deve ter âncora nenhuma.
 *
 * Existe separada de {@link placementViolation} porque o caminho de ESCRITA precisa saber QUAL card
 * carregar do disco para validar a âncora — sem isso ele teria de ler o board inteiro a cada escrita,
 * ou (pior) reimplementar a escolha do campo e virar uma segunda verdade.
 */
function placementSpec(card, config) {
  if (!card || typeof card !== "object") return null;
  // Fora do backbone por desenho: contêiner efêmero e ideia (OST).
  if (card.capture === true || card.container != null) return null;
  if (card.type === "idea") return null;
  // Quarentena (a caixa de entrada) e história (terminal) — ver o doc de placementViolation.
  const def =
    card.status && config && Array.isArray(config.statuses)
      ? config.statuses.find((s) => s && s.id === card.status)
      : null;
  if (def && (def.staging === true || def.terminal === true)) return null;

  const clean = (v) => (v != null && String(v).trim() !== "" ? String(v).trim() : null);
  const isUserStory = (c) => !!c && c.type === "story" && (c.storyType == null || c.storyType === "user");
  const isDelivery = card.type === "story" && card.storyType != null && card.storyType !== "user";

  if (card.type === "activity") return { rootOnly: true, anchorId: clean(card.parent), field: "parent" };
  if (isDelivery) {
    // A entrega prefere `serves` (o override do dual-track) e cai no `parent`.
    const serves = clean(card.serves);
    return {
      anchorId: serves ?? clean(card.parent),
      field: serves ? "serves" : "parent",
      accepts: isUserStory,
      wanted: "uma user story (a story base que esta entrega serve)",
    };
  }
  if (card.type === "story") {
    return {
      anchorId: clean(card.parent),
      field: "parent",
      accepts: (c) => !!c && c.type === "step",
      wanted: "um passo (step)",
    };
  }
  if (card.type === "step") {
    return {
      anchorId: clean(card.parent),
      field: "parent",
      accepts: (c) => !!c && c.type === "activity",
      wanted: "uma ação (activity)",
    };
  }
  return null;
}

/** Rótulo PT-BR do que um card É, para as mensagens da invariante. */
function describeCardKind(card) {
  if (!card || typeof card !== "object") return "algo desconhecido";
  if (card.type === "activity") return "uma ação (activity)";
  if (card.type === "step") return "um passo (step)";
  if (card.type === "idea") return "uma ideia";
  if (card.type === "story") {
    return card.storyType == null || card.storyType === "user" ? "uma user story" : `uma entrega (${card.storyType})`;
  }
  return `um card do tipo "${card.type}"`;
}

/** Rótulo curto de cada gate, DERIVADO de GATES (substitui o Record paralelo que vivia na UI). */
const GATE_LABELS = Object.fromEntries(Object.entries(GATES).map(([id, spec]) => [id, spec.label]));

/** Resolve the gate id declared on a status in the board config, if any. Defensive: tolerates a
 *  malformed config (no statuses array) by returning undefined → "allow". */
function gateForStatus(config, statusId) {
  if (!statusId || !config || !Array.isArray(config.statuses)) return undefined;
  return config.statuses.find((s) => s && s.id === statusId)?.gate;
}

/**
 * Rich gate verdict for a transition into `statusId`: null when allowed, else
 * { gate, label, message, fix }. A status with no gate, an unknown status, or a gate id absent
 * from GATES all return null (allow) — forward-compatible & never throws. Used by the hook.
 */
function evaluateGate(card, statusId, config, lookup) {
  const gate = gateForStatus(config, statusId);
  if (!gate) return null;
  const spec = GATES[gate];
  if (!spec) return null;
  // `ctx` é OPCIONAL e só o hasPlacement o lê hoje: com ele o gate resolve a âncora (existe? é do
  // tipo certo?), sem ele checa só a forma. Quem tem a lista de cards à mão deve passá-la.
  if (spec.ok(card, { lookup, config })) return null;
  // A invariante de hierarquia sabe dizer QUAL é o defeito (sem âncora / âncora inexistente / âncora
  // do tipo errado); usar essa frase em vez da genérica é a diferença entre o operador saber o que
  // arrastar e ficar adivinhando.
  const detail = gate === "hasPlacement" ? placementViolation(card, lookup, config) : null;
  return { gate, label: spec.label, message: detail ? detail.message : spec.message, fix: spec.fix };
}

/**
 * Check whether `card` may ENTER `statusId`. Returns null when allowed, or the PT-BR message
 * string when blocked. The app's historical API (string | null) — a thin view over evaluateGate.
 */
function checkGate(card, statusId, config, lookup) {
  return evaluateGate(card, statusId, config, lookup)?.message ?? null;
}

/**
 * Board inheritance (B5): merge two id-keyed RAW lists — BASE order preserved; a `board` item with
 * the same id SHALLOW-overrides the base one (board fields win, base fields fill gaps); a board-only
 * item is appended in order; id-less items pass through. THE single algorithm behind both the app
 * (repo.ts `mergeRawById`, for statuses+columns) and the pre-write gate hook (resolving the gate
 * map) — kept in this isomorphic source so the two never drift. Pure.
 */
function mergeById(base, board) {
  const baseArr = Array.isArray(base) ? base : [];
  const boardArr = Array.isArray(board) ? board : [];
  if (!baseArr.length) return boardArr;
  if (!boardArr.length) return baseArr;
  const idOf = (x) => (x && typeof x === "object" && typeof x.id === "string" ? x.id : null);
  const boardById = new Map();
  for (const it of boardArr) {
    const id = idOf(it);
    if (id) boardById.set(id, it);
  }
  const taken = new Set();
  const merged = baseArr.map((it) => {
    const id = idOf(it);
    if (id && boardById.has(id)) {
      taken.add(id);
      return Object.assign({}, it, boardById.get(id));
    }
    return it;
  });
  for (const it of boardArr) {
    const id = idOf(it);
    if (!id || !taken.has(id)) merged.push(it);
  }
  return merged;
}

/**
 * Resolve a board's pipeline STATUSES from its raw board.yaml over the raw _base template — the
 * gate-relevant slice of repo.ts `mergeRawConfig`, isomorphic for the pre-write hook (which only
 * needs the {id, gate} entries). A board may OPT OUT (`inheritPipeline: false`) and own its statuses
 * outright; otherwise it inherits the canonical _base pipeline via {@link mergeById}. Returns the
 * merged array (possibly empty). Pure.
 */
function resolveBoardStatuses(baseRaw, boardRaw) {
  const board = boardRaw && Array.isArray(boardRaw.statuses) ? boardRaw.statuses : [];
  if (boardRaw && boardRaw.inheritPipeline === false) return board;
  const base = baseRaw && Array.isArray(baseRaw.statuses) ? baseRaw.statuses : [];
  return mergeById(base, board);
}

module.exports = {
  placementViolation,
  placementSpec,
  describeCardKind,
  riceScore,
  priorityKind,
  bugSeverityOf,
  hasNarrative,
  hasUiSurface,
  qaVisualProof,
  declaresCode,
  GATES,
  GATE_LABELS,
  gateForStatus,
  evaluateGate,
  checkGate,
  mergeById,
  resolveBoardStatuses,
};
