---
name: harness-qa
description: >-
  AgileHarness automation that runs AUTOMATED QA on a freshly reviewed story before
  human review. Reads a card in status `qa-automatizado` from
  storymap/boards/<board>/cards/<id>.md, brings up a seeded dev stack, turns the
  card's `acceptance[]` (already Gherkin Dado/Quando/Então) into runnable
  Playwright E2E specs (the criterion text IS the test title — BDD-readable, no
  cucumber/playwright-bdd framework), executes them, and — for `user` stories with
  a UI surface — drives a headless visual sweep via the chrome-devtools MCP
  (mobile + desktop, empty/erro/loading states). On green it sets `qaPassed: true`
  (+ qaRanAt/qaCommit/commitRange), clears any refine/fix `mode`, and advances
  `qa-automatizado` -> `revisao` (gate hasQaPassed). On red it records a `testing`
  blocker finding and keeps the card in `qa-automatizado` (or routes it back). With
  no id it processes the whole `qa-automatizado` queue. Use when the user says
  "/harness qa", "/harness-qa", "QA automatizado", "rodar o QA", "validar aceite",
  "testes de aceite", "E2E da story", or wants to advance AgileHarness cards sitting in
  QA automatizado. Edits storymap data (the card .md) AND product test code (the
  E2E specs, in the board package's existing E2E folder). It does NOT edit the storymap-ui package —
  EXCEPT when the board under QA IS `storymap` itself (dogfood): there the product under
  test IS storymap-ui, so it runs storymap-ui from the run's worktree (which carries the
  staged code, since runs are cut from `stage`) and may add storymap-ui E2E/visual specs.
triggers:
  - /harness qa
  - /harness-qa
  - QA automatizado
  - rodar o QA
  - validar aceite
  - testes de aceite
  - usm qa
---

# /harness-qa — AgileHarness: QA automatizado de aceite (qa-automatizado → revisao)

The `harness-qa` trigger automation. After `harness-review` leaves the diff clean, this
**proves the story's acceptance criteria end-to-end** against a real seeded stack
and gives the human reviewer a card whose experience is already green — not just a
card whose code compiles.

> Read `storymap/README.md` first. Testing rules: the target repo's own testing
> guidelines (FIX THE APP, never weaken assertions, prefer the cheapest layer that proves the
> criterion). Dev stack: the target repo's dev-environment notes. Browser test-auth
> recipe and the experience rubric: whatever UI-validation skill the target repo ships
> (the target's declared `docs.conventions` points to it, when it declares one). Logs for debugging: the target repo's
> operational-scripts notes. This skill edits the card
> (`qaPassed`/`qaRanAt`/`qaCommit`/`commitRange`/`findings[]`/status) under
> `storymap/boards/<board>/cards/` AND product test code under
> the board package's existing E2E folder (found through the target's `docs.testing`, or by
> looking at where the package already keeps its specs). Permission mode: dangerously-skip-permissions (it
> boots the stack, runs tests and drives the browser MCP).

## Input

```
/harness-qa <board>/<id>     # QA one card
/harness-qa                  # no id = process the ENTIRE `qa-automatizado` queue
```

The card must be `status: qa-automatizado` (it got here from `harness-review`, clean —
gate hasNoBlockers). The column declares the **`browser` capability** (`board.yaml` →
`toolConfigs.browser`, `toolkit.expect: required when uiSurface`); the engine PROVES a
provider on this host before spawning you and mounts whichever one passed. So a browser
you can see is a browser that PROVED ITSELF ON THIS HOST — and when none does, you are not
spawned at all.

That guarantee is about the HOST, and it stops there. It does NOT promise the browser can
reach what YOU are serving: reachability belongs to the call, not to the host, and no probe
can measure it (the one that runs does so from the service process, on the host). Concretely
— the chrome-devtools MCP runs OUTSIDE your Bash sandbox and cannot see a dev server you
booted inside a call. Read the ACTIVE-provider note in your system prompt, and when you are
serving the product yourself, use the in-jail script route. See "Execute + visual sweep".

## Decide scope FIRST (don't over-test)

1. **Read the card + board.** Read `board.yaml` (`package:` → the app package) and
   the card: `storyType`, `acceptance[]`, `mode`, `tasks`, the plan sidecar
   `plans/<id>.md` for intent.
2. **Route by the ACCEPTANCE's surface, not the storyType label alone.** `storyType` is a
   strong default, but the real question is *"can this criterion only be proven in a
   browser?"* — a `bug` whose acceptance is UI-observable (e.g. "the confirm button on the checkout form is not hidden behind the on-screen keyboard") is a UI criterion and gets the visual verification, NOT a suite-only
   rubber-stamp; a `user` story whose criteria are all API/data can skip the browser. Decide:
   - **Acceptance is UI-observable (any storyType, incl. a UI `bug`/`refine`)** → prove it at
     the CHEAPEST layer that actually renders the surface: prefer a **component/render test**
     (does the form footer stay sticky once the viewport shrinks to phone height) or a mock E2E; escalate to a real-stack browser sweep
     ONLY for criteria a component test can't prove. Right-size the stack per "Bring up the
     stack" (the web app plus the sign-in it needs for a layout/visual check — do NOT boot the backing services).
   - **A superfície manda, NÃO o `storyType`.** Antes de escolher o ramo, leia nesta ordem:
     `uiSurfaceEvidence.touched` (MEDIDO pelo engine sobre o diff do run — é FATO, vence tudo),
     senão `hasUiSurface`, senão `storyType === "user"`. **`touched: true` ⇒ o ramo é o de
     browser, mesmo num `chore`/`technical`/`bug`** — ramificar por tipo foi o furo: um card
     100% de UI rotulado `chore` passava direto para o ramo "sem browser" e era carimbado como
     aprovado sem ninguém olhar a tela. `uiSurfaceEvidence.paths` diz QUAIS
     arquivos decidiram; se o veredito estiver errado, é isso que você contesta.
   - **Carimbe O QUE você provou, não um bit genérico.** Junto de `qaPassed`, grave
     `qaEvidence: { suite: <rodou a suíte?>, visual: <OLHOU a tela renderizada?>, at: <ISO> }`.
     Um card com superfície MEDIDA só passa o gate `hasQaPassed` com `visual: true` — e
     `visual: true` é uma AFIRMAÇÃO: só marque se um sweep/render de fato aconteceu. Se a suíte
     passou mas você não conseguiu olhar a tela, grave `visual: false` e deixe o card parado;
     é a resposta honesta, e o operador destrava com `approve_qa visual:true` depois de olhar.
   - `storyType: user` (build) → run the full QA below (E2E + visual sweep for UI criteria).
     **DOGFOOD exception** — if `board.yaml.package` is `storymap-ui` (the board IS
     `storymap`), the product under test IS storymap-ui itself: there is NO backing-service/seed
     stack (it's a board tool that reads files) — instead run storymap-ui
     from THIS run's worktree (which carries the staged code, since runs are cut from
     `stage`) on an isolated port + the chrome-devtools visual sweep. See the Dogfood
     path in "Bring up the stack" below; you MAY edit storymap-ui E2E/visual specs here.
   - `technical` / `spike` / `chore` / `bug` **SEM superfície** (a leitura acima deu
     "sem tela") → **the concrete QA gate is the package's test suite green + the
     `harness-review` lenses** — NOT a browser. Um destes COM superfície medida não entra
     aqui: vai para o ramo de browser acima. Do this, in order:
     1. Run the board package's suite: read the check `test` (`target.checks.test`) in the
        `target` block of `storymap/settings.yaml` (the run's context note lists the declared
        check names; fill `{package}` / `{pkg}` / `{board}` from `board.yaml`; if the storymap MCP
        is mounted, `target_profile({board})` returns the same already resolved) and run the
        declared command yourself with Bash IN YOUR WORKTREE (`run_check` runs in the runtime
        checkout, never in your worktree). If
        the target declares none, discover the command in the repository's own instructions
        (README, CLAUDE.md/AGENTS.md, the package manifest) — never assume an executor. The
        package comes from `board.yaml.package`. Read the full output.
     2. **GREEN** → the suite proves the delta. Set `qaPassed: true` + `qaRanAt` +
        `qaEvidence: { suite: true, visual: false, at }` (honesto: este ramo NÃO abre
        browser — e para um card sem superfície `visual: false` não bloqueia nada) +
        `qaCommit` + the durable `commitRange: { base, head }` (base = `git rev-parse
        <earliest card-id commit>^`, head = HEAD sha — see harness-review; a lone sha rots
        once `main` advances, SM-05), write a `## QA` body note (which suite ran, the
        green result, and that the `harness-review` lenses already cleared the diff), clear
        any `mode`, and advance to `revisao`. Do NOT seed a stack or drive the browser.
     3. **RED** → record a `findings[]` entry `{ lens: "testing", severity: "blocker",
        status: "open", title, detail }`, leave `qaPassed` unset, and keep the card in
        `qa-automatizado` (or route it back to `desenvolver`). The `hasQaPassed` gate no
        longer passes a CODE card "by type": a card that carries code (`stagedAt`/
        `commitRange`) needs `qaPassed: true` **and** `qaEvidence.suite: true` to enter
        `revisao` — so the green-suite stamp above is load-bearing, and a red suite can
        never be papered over.
     If the suite genuinely has no coverage of the delta, extend it at the cheapest
     layer (unit/integration) so the acceptance is actually verified before going
     green — never set `qaPassed` on an unproven delta.
3. **Mode-aware** (read `mode`; ciclo de vida canônico em
   **`@.claude/skills/harness-triage-shared/GUARDRAILS.md#mode-lifecycle`** — o `harness-qa` é a
   estação que LÊ o `mode` para escopar o QA e a ÚNICA que o LIMPA):
   - `mode: refine` → the `acceptance[]` is a DELTA over shipped behaviour. Test ONLY
     the delta + a regression guard around the surface in `refinement.target`.
   - `mode: fix` → DEMAND the regression test the `harness-do` (fix) wrote as task #1:
     confirm it reproduces the bug (red→green) and lives in the diff. A fix without a
     guarding test is NOT QA-green → record a blocker.
   - else (`build`) → cover every UI-observable `acceptance[]` criterion.

## Bring up the stack (headless, no TTY)

> **THE ONE RULE THAT GOVERNS THIS WHOLE SECTION — a process does not survive a Bash call.**
> Your Bash calls run inside an OS sandbox with their OWN PID and network namespaces. When the
> call returns, the jail's PID-1 exits and takes the entire process tree with it. `setsid`,
> `nohup` and `disown` do NOT save it. The FILESYSTEM crosses calls; the PROCESS does not.
>
> That asymmetry does not fail loudly — it fails GREEN. Start a server in call N, grep its log
> for `ready` in call N+1, and you will read "ready" off a file while the thing it describes is
> already dead. Measured: `QA_DEV_PORT=<port>` is printed at once and the server does not answer
> for a good while longer, so even WITHIN one call that line is not readiness.
>
> So: **boot, readiness, sweep, specs and teardown are ONE script in ONE Bash call.** You judge
> the PNGs afterwards, in your own turns, by `Read`-ing them off disk — artifacts are exactly
> what is allowed to cross the boundary.

> **DOGFOOD path (board `storymap` — product under test IS storymap-ui).** SKIP the whole
> backing-service/seed section below — storymap-ui has NO backing-service dependency (it's a
> board tool that reads files). Write ONE script and run it in ONE call:
>
> 1. **Boot + readiness + sweep in a single script.** You run in an ISOLATED worktree that
>    ALREADY carries the staged code (runs are cut from `stage`). Serve storymap-ui FROM THIS
>    WORKTREE. From `packages/storymap-ui`, `bun run qa-dev` derives a DETERMINISTIC, FREE,
>    non-3008 port from THIS run's id and prints `QA_DEV_PORT=<port>`. **NEVER** `bun run dev` /
>    `bun run start`, **NEVER** a manual `PORT=`/`-p` — those hard-code `-p 3008`.
>    Shape (adapt the routes, keep the structure):
>    ```sh
>    cd "$WORKTREE/packages/storymap-ui"
>    bun run qa-dev > /tmp/qa-dev.log 2>&1 &
>    for i in $(seq 1 90); do
>      # sed, não `grep -oP`: PCRE não existe no grep de macOS/BSD, e esta skill viaja.
>      P=$(sed -n 's/.*QA_DEV_PORT=\([0-9]\{1,\}\).*/\1/p' /tmp/qa-dev.log 2>/dev/null | head -1)
>      [ -n "$P" ] && break
>      sleep 1
>    done
>    [ -n "$P" ] || { echo "FALHOU: sem porta"; tail -40 /tmp/qa-dev.log; exit 1; }
>    # READINESS IS AN HTTP CODE, NEVER THE PORT LINE. Bounded, and it reports which way it ended.
>    for i in $(seq 1 180); do
>      C=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$P/" || echo 000)
>      [ "$C" != "000" ] && break
>      sleep 1
>    done
>    [ "$C" != "000" ] || { echo "FALHOU: servidor não respondeu em 180s"; tail -40 /tmp/qa-dev.log; exit 1; }
>    echo "PRONTO http=$C porta=$P"
>    cd "$WORKTREE"   # visual-sweep.mjs belongs to the TOOL (not to the target repo); it writes .artifacts/screenshots/ relative to cwd
>    node "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/../../scripts/visual-sweep.mjs" --url "http://127.0.0.1:$P/<rota>" --label "harness-qa-<id>-<step>" \
>      --breakpoints 375x812,1440x900 --wait-selector "<seletor que só existe DEPOIS dos dados>" --require-ready
>    ```
>    **Budget — measured, and the naive version of this measurement lies.** First HTTP lands
>    somewhere between 21s and 85s (it depends on how warm the page cache is; a cold box is the
>    slow end). After that the dev server compiles EACH surface on first visit, and that is where
>    the time goes:
>
>    | surface | first compile | modules |
>    |---|---|---|
>    | `/login` | ~58s | 1 208 |
>    | `/api/health` | ~4s | — |
>    | `/board/[boardId]` | ~21s | 1 599 |
>    | `/kanban` | ~32s | 2 503 |
>    | `/mapa` | ~8s | 2 492 |
>    | `/inbox` | ~11s | 2 620 |
>    | `/canvas` | **~76s** | 8 262 |
>
>    Boot + auth + six surfaces measured **284s of the 600s ceiling** — real slack ~316s. Revisits
>    are 0–2s.
>
>    **THE TRAP, because it already fooled one measurement:** hitting a board route WITHOUT a
>    session returns **307** in a couple of seconds — the Edge middleware bounces you to `/login`
>    before Next ever touches the page. Nothing compiled. Time that and you will record "`/board`
>    costs 2s", conclude you have 441s of slack, and be wrong by more than an order of magnitude
>    on every surface that matters. **Authenticate first** (`POST /api/auth/login`, keep the
>    `ah_session` cookie) and only then time anything, and treat a 307 as "not yet measured".
>
>    Plan against the real numbers: one heavy unseen surface can cost over a minute by itself.
>    Sweep the surfaces the criteria need, not every screen you can think of.
>
> 2. **Acceptance E2E — same call or none.** storymap-ui has NO Playwright harness today. If the
>    unit suite (`bun run test:unit` in the storymap-ui package, on Linux) + the visual sweep prove the criteria, that
>    IS the gate — do NOT scaffold Playwright. If a criterion genuinely needs a browser
>    assertion, add a minimal spec under `packages/storymap-ui/tests/e2e/` and run it INSIDE THE
>    SAME script, after readiness, against `http://127.0.0.1:$P`. A spec run from a later call
>    finds a dead port.
>
> 3. **Teardown: there is nothing to tear down.** The dev server dies when the call returns —
>    that is the same namespace rule, working in your favour. Do NOT `kill` by PID, do NOT
>    port-kill, do NOT `systemctl stop` anything (from inside the jail it would not reach the
>    host's systemd anyway). If your script must stop it early, `trap 'kill 0' EXIT` inside the
>    script is enough, and it never reaches beyond your own call.
>
> 4. **3008 needs no guarding from you, and a probe would lie.** Your call has its own network
>    namespace: port 3008 is ALWAYS free in there, so a "is 3008 taken?" probe reports free no
>    matter what and proves nothing. It is also unnecessary — a bind inside your namespace CANNOT
>    collide with the production service on the host. What survives is the rule, not the probe:
>    never pass `-p 3008`, never use `bun run dev`/`start`.

The Playwright configs auto-start the Next dev server IN-PROCESS, in the same call as the
specs — which is exactly what containment requires. Do NOT try to reuse a stack from an
earlier call: nothing survives one.

### Infra discipline — FAIL FAST, never repair (read before you boot anything)

You are QA, **not** platform on-call. The stack is a MEANS to prove the acceptance — a
broken/slow toolchain is an operator BLOCKER, not your homework. Hard rules:

- **NEVER repair the environment.** Do NOT `rm -rf` / rewrite `node_modules`, the bun
  store/cache, `.bin/*` symlinks, or lockfiles; do NOT `pkill`/`kill`/`kill -9` stray
  processes; do NOT reinstall deps. Those mutate state SHARED with the live storymap
  service (3008) and every other worktree — a blast radius QA must never touch. If the
  toolchain is broken (`MODULE_NOT_FOUND`, a crashed loader, a corrupt install), STOP and
  file the blocker (below). One exception you MAY do: create a **local** dev env file the
  boot needs (e.g. a `.env.local` copied from the package's `.env.example`) — that is
  config you own, not a shared-state repair.
- **ONE bounded readiness wait, IN THE SAME CALL as the boot — and readiness is a response,
  not a log line.** Wait with a SINGLE bounded loop (hard ceiling ~180s) that asks the server
  itself (`curl -s -o /dev/null -w '%{http_code}'`) and stops the instant it answers or the
  ceiling hits. Do NOT `ScheduleWakeup`, do NOT `sleep N; tail` in a loop, and do NOT `tail -60`
  the log into your context every turn (that is what balloons cost to millions of tokens for
  zero QA). Keep the log in a file and read its tail ONLY to explain a failure.
  Grepping a log for a READY marker is the trap this section used to recommend: the log is a
  FILE and crosses calls, the server is a PROCESS and does not. In a later call you would read
  "ready" about something already dead — a green that measured nothing. Even inside one call,
  `QA_DEV_PORT=` appears long before the server answers, so the port line is not readiness
  either. The only honest signal is a response.
- **Circuit-breaker.** If the stack is not healthy after the bounded wait, OR the boot log
  shows a crash / an interactive prompt waiting for a value / a persistent
  `MODULE_NOT_FOUND`, you are DONE with this card: record a `findings[]` entry `{ lens:
  "testing", severity: "blocker", status: "open", title: "QA infra: <stack> não sobe",
  detail: "<the exact log line>" }`, KEEP the card in `qa-automatizado`, and report it for
  the human. Two or three failed boot attempts is the CAP — never grind to max-turns.
- **A max-turns / repeated-resume with no forward progress IS a failure signal** — if you
  find yourself resuming into the same infra wall, stop and file the infra blocker instead.

### Right-size the stack to the criteria (don't boot what you won't assert against)

Boot the CHEAPEST stack that proves THIS card's criteria. Every extra backing service is boot time and one more thing
that can crash, and a criterion about layout or copy never reads from it:

- **Layout / navigation / visual / copy criteria** (e.g. "the sticky footer keeps the Save
  button reachable on a 640px-high viewport") → the **web app plus the sign-in it needs** (when the target runs one locally) is the
  whole stack. Leave every other backing service (a functions runtime, file storage, queues…) down: they only add boot time and
  interactive prompts. Use the target's declared dev command (`target.dev.up` in `storymap/settings.yaml`) scoped to web+sign-in,
  or reuse a stack that is already healthy.
- **Criteria that call a backend function / read seeded data** → add the service that holds the data (+ a server-side
  functions runtime only if a criterion actually invokes one). Seed with the agent toolkit if present.
- **If a local dev port (sign-in, data) is shared** → never boot a second standalone stack concurrently; the QA column
  is capped to one run at a time (`costGuard`).

> Note: prefer the target's declared dev command (`target.dev.up` in `storymap/settings.yaml`, or whatever the repository's own instructions name) over hand-rolled invocations, and if a helper the step names is missing, boot the scoped web+sign-in dev path rather than improvising a full-stack bring-up.

## Run the acceptance E2E (authored by harness-tests; BDD without the framework)

`harness-tests` already authored a FAILING Playwright spec per UI-observable criterion
(test-first, title = the criterion verbatim) in the package's E2E folder, and
`harness-do` turned it green. Your job is to RUN them as the gate. Do NOT add cucumber or
playwright-bdd (the target repo already standardised on plain Playwright specs; read the E2E folder's README when it has one, and
the target's `docs.testing` when it declares one). Concretely:

- **Prefer the spec harness-tests authored** — locate the card's `test-e*` tasks / the
  spec path listed in `## Plano de testes` and RUN it. Only write/refresh a spec
  yourself if harness-tests didn't author one (missing/stale), keeping the same shape:
  **`test('<criterion text verbatim>', …)` title IS the Gherkin criterion** — this
  yields BDD-readable `list`/`html` reports with zero new dependency and traces the
  test straight back to the card.
- Place specs in the package's EXISTING layout (per the target repo's testing guidelines),
  cheapest layer first: the mocked layer for UI logic (fast), escalating to the layer that
  runs against the real seeded stack only for criteria that need it — follow the folder and
  file-name pattern the package's existing specs already use. Use the existing auth/storageState
  setup the package already has.
- A criterion that isn't Gherkin-shaped still gets a spec; if it can't be automated,
  note it explicitly in the `## QA` section (no silent skips).
- **Commit any spec you write/refresh with the card-id convention** so it's discoverable +
  revertible: `test(<scope>): aceite E2E … · <board>/<cardId> [qa]`. You run in an isolated
  worktree; just `git add` + `git commit` in the worktree cwd (small commits, one per spec is
  fine) — the engine integrates the branch at the end (no `git push`).

## Execute + visual sweep

1. **Run the specs**: the target's `e2e` check (`target.checks.e2e` in the `target` block of
   `storymap/settings.yaml`; `target_profile({board})` returns the same when the MCP is mounted;
   run the declared command yourself with Bash IN YOUR WORKTREE; with no declaration, discover
   the command in the repository's own instructions — never assume an executor). Read the full
   output; a connection error usually means the stack/seed isn't ready (go back to
   readiness), NOT a real failure.
2. **Visual sweep (UI stories only)** — the requirement is a CAPABILITY, not a tool:
   *render each screen the story touches and LOOK at it*, at **375×812** and
   **1440×900**, covering the **empty / erro / loading** states (per the rubric —
   missing a required state is an experience FAIL even when the happy path works).

   The engine PROVED a provider for the `browser` capability before spawning you, and
   the system prompt names the ACTIVE one when it is not the primary. Follow that note
   — it beats this prose, which describes the capability, not the route.
   - **`browser-script` (THE route for anything this run is serving — deterministic script)**:
     ```
     node "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/../../scripts/visual-sweep.mjs" --url <url> --label harness-qa-<id>-<step> \
       --breakpoints 375x812,1440x900 --init-script <auth.js> \
       --wait-selector "<seletor que só existe DEPOIS dos dados>" --require-ready
     ```
     It writes the PNGs to `.artifacts/screenshots/` (leave them there; do not commit them) and prints a JSON manifest — then
     **`Read` each PNG and judge it**. The looking is yours either way; only the
     navigation differs.
     - **`--wait-selector` is not optional in practice.** Pick something that renders only
       once the screen's DATA has arrived. Without it the script can only prove the DOM
       stopped changing — which a stuck skeleton also satisfies. The first real sweep
       captured exactly that: a page of grey placeholders, reported as a successful shot.
     - **Read `readyAll` in the manifest before judging.** `readyAll: false` (or a shot with
       `readiness.asserted: false`) means the capture is NOT visual proof — fix the readiness
       or the auth injection and re-run; never stamp `visual: true` on it. `--require-ready`
       makes that a non-zero exit so it cannot pass unnoticed.
     - Do **not** pass `--wait-until networkidle` against a dev server: the HMR websocket
       never goes idle, so every capture dies on timeout (the default is `domcontentloaded`).
     - **The TYPOGRAPHY in these PNGs is not production's, and nothing warns you.** Google
       Fonts is outside the sandbox's egress allowlist, so `next/font` fails (`NextFontError`
       on JetBrains Mono, Hanken Grotesk and Playpen Sans — the last degrades to a generic
       `cursive`, which is the most visually misleading of the three), Next silently falls back
       and still serves 200. Judge layout, state, data and hierarchy from these shots — do NOT
       raise a finding about the typeface itself, and do NOT certify one either.
   - **`browser` (chrome-devtools MCP) — NOT the route for a server this run started.** Its
     server is a child of the CLI process, and the containment wraps Bash calls, not the CLI:
     measured, the whole Chrome tree sits in the HOST's network namespace. Navigating it to
     `127.0.0.1:<your port>` returns `net::ERR_CONNECTION_REFUSED` while a host URL works —
     and it reports that failure with `isError: false`, so the timeout looks like your fault.
     Under containment the preflight drops it from the chain before probing (board.yaml →
     `toolConfigs.browser.outsideRunSandbox`), so normally it is not even mounted. If it IS
     mounted, the run is uncontained and it works — use it only for URLs that live on the
     host (a public/production URL), never for the dev server you just booted. Do NOT use the
     Playwright/`playwright-real` MCP either (it hangs headless).

   In BOTH routes, inject test-auth BEFORE navigation per the target repo's browser
   auth-injection recipe — read its load-bearing pins first (typically: point the client at
   the local test sign-in, use a test uid in the exact shape the auth layer accepts, clear stale
   auth flags left by a previous page, and wait for the app's auth-ready signal before
   asserting).

   **If neither route works, you will never get here** — the preflight settles the run
   at $0 with an `infra` diagnosis on the card. So do NOT invent a third path, do NOT
   burn turns hunting for a tool that is not mounted, and never record `visual: true`
   for a screen you did not actually see.
2.5. **Conformidade com o guia de estilo** (só quando `board.yaml` tiver `styleGuide:`) —
   cascata única de precedência (D13 canal 3): ① guia do board
   (`storymap/boards/<board>/design/style-guide.md`) → ② skill `*-ui-aesthetics` do app → ③
   componentes existentes. Compare cores/tipografia/espaçamento CAPTURADOS na varredura contra
   os `color.tokens`/`typography.scale`/`spacing` do guia; chame a tool MCP read-only
   `styleguide_drift {board}` (WS-4, quando disponível) para o diff mecânico guia↔código;
   CONSULTE `debt[]` ANTES de reportar — um resquício já declarado débito conhecido NÃO é um
   finding novo. Uma violação genuína vira `findings[]` `{ lens: "design", severity:
   "medium"|"low", status: "open", title, detail }` — NÃO bloqueia o avanço (ao contrário de
   `testing`). Grave o carimbo `styleGuideCheck: { version, hash, passed, at }` (espelha o
   ponteiro `styleGuide` do board.yaml no momento do check) independente do resultado —
   `passed:false` é um valor real, nunca omitido.
3. **Debug failures with logs, don't just fail.** When a spec/sweep fails and the
   cause isn't obvious from the test output, escalate per the target repo's operational-scripts notes:
   read `.logs/dev.log` (local stack), reproduce a pipeline bug with the repo's
   trace-capable CLI for that package, inspect seeded data with its read-only data-query
   helper, and for prod-only context query the error log broad first, then narrow to the
   package's service logs. The
   logs tell you WHOSE defect it is (test vs app) — see Verdict below for who fixes
   what (you fix tests; dev fixes the app). Never weaken an assertion to force green.

## Verdict + write

- **GREEN** (every targeted criterion passes; required states covered): set
  `qaPassed: true`, `qaRanAt: <today>`, `qaCommit: <HEAD sha or working-tree>` and the
  durable `commitRange: { base: <git rev-parse <earliest card-id commit>^>, head: <HEAD
  sha> }` (SM-05 — base+head survives `main` advancing; skip `commitRange` only when no
  card-id commit resolves); when the board has a published guide, also set
  `styleGuideCheck: { version, hash, passed, at }` (D14 — the conformance verdict from the
  sweep step above; write it even when `passed:false`, so the record is honest); write a
  short `## QA` body section (criteria → pass, screenshots captured); if the card
  had `mode: refine`/`fix`, CLEAR `mode` + `refinement`/`bugReport` now (deferred from
  `harness-review` — you were the last station that needed `mode`); set
  `status: revisao`. The hasQaPassed gate passes and the human reviewer gets a
  proven-green card.
- **RED** — first decide WHOSE defect it is, then act accordingly:
  - **The TEST is wrong** (bad selector, strict-mode multi-match, wrong layer, flaky
    timing): you OWN the acceptance specs → **fix the TEST** (NEVER weakening the
    assertion — the criterion must stay genuinely verified), then re-run. Do NOT
    touch product code for a test defect.
  - **The APP is wrong** (the criterion is genuinely unmet; it can't pass without
    weakening): record a `findings[]` entry `{ lens: "testing", severity: "blocker",
    status: "open", title, detail, file?, line?, suggestion }`, leave `qaPassed`
    unset, and route the card BACK to `desenvolver` (build) or `corrigir` (a
    regression on shipped code) so **`harness-do`** fixes it (the spec is its red→green
    target). **harness-qa does NOT edit product code** — QA gates + owns tests; the
    builder fixes the app. The card flows dev → review → qa again.
  - **Can't tell / a flaky harness / repeated round-trips with no progress**: KEEP
    the card in `qa-automatizado`, leave the blocker open, and report it for the
    human — do NOT ping-pong dev↔qa indefinitely (the cascade's no-loop guarantee
    only covers forward moves; a backward route is a cycle, so cap your own retries).

## Teardown

**Product boards (local product stack):** tear the stack down deterministically with
the target's declared stack-down command (`target.dev.down` in `storymap/settings.yaml`; with no declaration,
discover how to stop the environment in the repository's own instructions — it must kill the dev ports). Leave seeded data intact for
the next run.

**Dogfood board (`storymap`, the `qa-dev` server): there is nothing to tear down.** The
server dies when the Bash call that started it returns — the jail's PID-1 exits and reaps
the tree. Do NOT kill by PID, do NOT port-kill, and do NOT `systemctl stop` the run scope:
from inside the sandbox that command does not reach the host's systemd, and by settle time
the process is long gone anyway. `trap 'kill 0' EXIT` inside your own script is the only
early stop you need, and it cannot reach past your own call.

**NEVER** kill port **3008** — that is the AgileHarness dev server + autorun dispatcher
(the stack teardown is already scoped to avoid it; `qa-dev` never binds it). Note what this
rule is NOT: do not "probe whether 3008 is occupied" and conclude anything. Your call has
its own network namespace, so 3008 always reads FREE in there regardless of production —
the probe would measure zero and report safety. The protection is the rule (never bind it),
not a check.

## Report

Per criterion: pass/fail + the spec that proves it (title = the criterion). For UI
stories, the breakpoints swept and the states covered, with screenshot paths. State
whether the card advanced to `revisao` or stayed in `qa-automatizado` with blockers.

### Guardrails

- **Fix the right thing, never weaken.** A green run is the bar. If the TEST is
  wrong, fix the test (without weakening the assertion); if the APP is wrong, route
  it to dev — harness-qa never edits product code, and never weakens an assertion to
  force green.
- **Cheapest layer that proves it.** E2E browser is 5-10min; prefer mock/integration
  /journey when they prove the criterion (per the repo's testing rules + cost ROI). Escalate
  to a real-stack browser run only for genuinely UI-dependent criteria.
- **QA never repairs infra, and fails fast.** Do NOT touch `node_modules`/bun store/
  symlinks/lockfiles or `pkill` host processes — that is shared state with the live 3008
  service + every worktree. A broken/slow/hanging stack (crash, `MODULE_NOT_FOUND`, an
  interactive prompt waiting for a value, or an unhealthy readiness probe after a
  bounded wait) → record a `testing`/infra `blocker` and STOP within a few turns. Grinding to
  max-turns or resuming into the same wall is itself the bug — it burns cost for zero QA.
- **Right-size the stack.** Boot only what the card's criteria assert against (web + sign-in for
  a nav/visual sweep); never cold-boot the full multi-service stack for a UI check.
- **Don't deadlock infra cards, but don't rubber-stamp them either.** Only `user`
  stories get the seed+E2E+visual sweep; technical/spike/chore/bug are gated by the
  package's test SUITE (the target's `test` check) green + the `harness-review` lenses — never
  invent browser tests for them, but never advance one to `revisao` with a red suite.
- **One concurrent QA run** (the shared dev-stack port + two headless Chromiums would contend);
  the column carries `costGuard` so a hung browser can't hold a slot forever.
- **mode is load-bearing here** — you are the station that consumes it (delta/regression
  scope) and the ONLY one that clears it (protocolo canônico em
  **`@.claude/skills/harness-triage-shared/GUARDRAILS.md#mode-lifecycle`**). Don't advance to
  `revisao` without clearing a refine/fix marker once QA is green.
