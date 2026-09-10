// Lints de FONTE DA VERDADE — garantem que os specs (board.yaml + cards .md) refletem o estado real.
// Cumprem a promessa do comentário em repo.ts ("surfaced by the lint") que nunca tinha sido escrito, e
// pegam o drift de prosa que um rename de step deixa nas descrições (o skill-board-consistency.test só
// cruza os SKILL.md, nunca as descrições nem as refs dos cards). Rodam contra o board storymap REAL.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { DEPLOY_STEP_ID, deployStepAutorun, releaseModeOf } from "./release-policy";
import { listBoards, readBoardConfig, readCards, coerceOrchestrator } from "./repo";
import { findRepoRoot } from "./paths";
import { lintToolkit } from "./toolkit";
import { lintRiskMatrix } from "./runner/orchestrator-policy";
import { servesTarget, isDeliveryStory, isPlacementDebt } from "./unplaced";
import { terminalStatusIds, stagingStatusIds } from "./views";
import { REOPEN_KINDS } from "./reopen";
import { GATE_IDS } from "./types";
import { validateBoardLinks } from "./link-graph";
import { wsjfRatio, wsjfTier } from "./wsjf";
import { navItemForView, type BoardView } from "@/components/nav/nav-groups";
import { subjectBoards } from "./board-fixture";

// Os lints deste arquivo eram escritos contra `const BOARD = "storymap"` — o board canônico do dono,
// que NÃO viaja na extração OSS. Agora rodam sobre CADA board canônico presente na árvore: o fixture
// `demo` (sempre, nas duas árvores) mais o `storymap` do dono quando ele existe. Nada de cobertura
// foi trocado — o sujeito antigo continua na lista, e ganhou um que sobrevive à extração.
const BOARDS = subjectBoards();

describe("board integrity — refs dos cards apontam para ids existentes", () => {
  it("parent / serves / duplicateOf de todo card resolvem para um card existente", async () => {
    for (const BOARD of BOARDS) {
      const cards = await readCards(BOARD);
      const ids = new Set(cards.map((c) => c.id));
      const dangling: string[] = [];
      for (const c of cards) {
        for (const ref of ["parent", "serves", "duplicateOf"] as const) {
          const v = c[ref];
          if (v && !ids.has(v)) dangling.push(`${c.id}.${ref} → "${v}" (id inexistente)`);
        }
      }
      expect(dangling).toEqual([]);
    }
  });

  // WS6 (F5) — o LINT PERMANENTE que mantém a dívida de órfãs em ZERO: nenhuma story VIVA pode ficar sem
  // lugar decidido (parent OU serves OU unplacedAck). Pós-backfill (grandfathering), os boards reais passam;
  // daqui em diante o create_card recusa órfã sem ack e o gate hasPlacement barra a que escapar — este teste
  // é o backstop que faz um novo órfão sem decisão REPROVAR o merge. Cobre TODOS os boards. A regra vive em
  // isPlacementDebt (unplaced.ts), que ISENTA o que legitimamente não tem lugar no mapa e portanto não é
  // dívida: containers efêmeros de captura/estilo (superfície própria) e cards TERMINAIS (entregues/arquivados,
  // fora da visão "Em aberto") — senão um container consumido ou um órfão já concluído reprovaria o merge à toa.
  it("WS6: nenhuma story VIVA órfã sem unplacedAck (dívida de placement = 0, em todos os boards)", async () => {
    const boards = await listBoards();
    const orphans: string[] = [];
    for (const b of boards) {
      const [config, cards] = await Promise.all([readBoardConfig(b.id), readCards(b.id)]);
      const terminals = terminalStatusIds(config);
      const staging = stagingStatusIds(config);
      for (const c of cards) {
        if (isPlacementDebt(c, terminals, staging)) {
          orphans.push(`${b.id}/${c.id}: "${c.title}" — sem parent/serves/unplacedAck`);
        }
      }
    }
    expect(orphans).toEqual([]);
  });

  // WS-2 (2.4 / autocrítica G9) — o merge-back agora integra findings/questions/tasks POR ID
  // (ELEMENT_MERGED_FIELDS em card-merge.ts). Isso só é correto enquanto um id nomear UM fato dentro do
  // card: dois elementos com o mesmo id fazem o merge tratá-los como um só e DESCARTAR um dos lados,
  // silenciosamente. Este lint é o backstop dessa pré-condição — id duplicado no mesmo card = defeito,
  // reprova o merge. Cobre TODOS os boards e as TRÊS coleções (é a mesma classe de defeito nas três).
  // Os boards reais passam hoje (medido: 0 duplicados); ids genéricos legados ("f1") NÃO são cobrados —
  // eles só colidem entre runs que cunhem de novo, e a prevenção disso é o sufixo de proveniência do
  // reviewFindingId (runner/findings.ts), não um lint que reprovaria 218 cards históricos.
  it("WS-2: nenhum card tem id duplicado em findings/questions/tasks (pré-condição do merge por elemento)", async () => {
    const boards = await listBoards();
    const dupes: string[] = [];
    let scanned = 0;
    for (const b of boards) {
      for (const c of await readCards(b.id)) {
        for (const coll of ["findings", "questions", "tasks"] as const) {
          const seen = new Set<string>();
          for (const el of c[coll] ?? []) {
            scanned++;
            if (seen.has(el.id)) dupes.push(`${b.id}/${c.id}: ${coll} tem id duplicado "${el.id}"`);
            seen.add(el.id);
          }
        }
      }
    }
    expect(dupes).toEqual([]);
    // não-vacuidade: um readCards que devolvesse [] deixaria o lint verde e MORTO para sempre.
    expect(scanned).toBeGreaterThan(0);
  });

  it("o serves de toda delivery aponta para uma USER story (dual-track honesto)", async () => {
    for (const BOARD of BOARDS) {
      const cards = await readCards(BOARD);
      const byId = new Map(cards.map((c) => [c.id, c]));
      const bad: string[] = [];
      for (const c of cards) {
        if (!isDeliveryStory(c)) continue;
        const t = servesTarget(c);
        const target = t ? byId.get(t) : undefined;
        if (target && (target.storyType ?? "user") !== "user") {
          bad.push(`${c.id} serve "${t}" que é ${target.storyType}, não user story`);
        }
      }
      expect(bad).toEqual([]);
    }
  });
});

describe("board integrity — a prioridade em disco é internamente coerente", () => {
  // `priorityCall.rank` é DERIVADO dos ordinais WSJF mas GRAVADO, porque gate-core.js (isomórfico,
  // lê YAML cru) e suggest-work.ts o consomem sem poder calcular uma razão. Cache derivado que
  // diverge da fonte é o pior dos dois mundos — a UI mostra um tier e o gate/autorun lê outro.
  // Esta lint roda contra TODOS os boards reais.
  it("todo rank gravado é exatamente o tier derivado dos ordinais WSJF", async () => {
    const boards = await listBoards();
    const drift: string[] = [];
    for (const b of boards) {
      for (const c of await readCards(b.id)) {
        const pc = c.priorityCall;
        if (!pc?.wsjf) continue; // call legado (só rank) é válido e não tem o que conferir
        const esperado = wsjfTier(wsjfRatio(pc.wsjf));
        if (esperado !== pc.rank) {
          drift.push(`${b.id}/${c.id}: rank=${pc.rank} mas os ordinais dão ${esperado}`);
        }
      }
    }
    expect(drift, `rank divergente dos ordinais:\n${drift.join("\n")}`).toEqual([]);
  });

  it("todo status `delivered` também é `terminal` (subconjunto ESTRITO)", async () => {
    // Entregue é um jeito de TERMINAR. Um step marcado delivered sem terminal significaria "está no
    // ar e ainda anda no pipeline" — e faria o card aparecer ao mesmo tempo como capacidade viva e
    // como trabalho a priorizar.
    const boards = await listBoards();
    const ruins: string[] = [];
    for (const b of boards) {
      const cfg = await readBoardConfig(b.id);
      for (const s of cfg.statuses) {
        if (s.delivered === true && s.terminal !== true) ruins.push(`${b.id}/${s.id}`);
      }
    }
    expect(ruins, `delivered sem terminal: ${ruins.join(", ")}`).toEqual([]);
  });
});

describe("board integrity — a política de release tem UMA declaração só", () => {
  it("nenhum board.yaml autora `autorun` no passo Publicar — ele é DERIVADO de release.mode", async () => {
    // Se um board autorar esse `autorun`, ele diz duas coisas sobre o mesmo ato: o passo prometeria um
    // comportamento e `release.mode` prometeria outro. O runtime já resolve com uma verdade só
    // (withDerivedDeployAutorun sobrescreve), mas uma sobrescrita SILENCIOSA é pior que um erro — o
    // yaml é SPEC, e um spec que mente é o defeito que este arquivo inteiro existe para pegar.
    const root = findRepoRoot();
    const offenders: string[] = [];
    for (const { id } of await listBoards()) {
      const file = path.join(root, "storymap", "boards", id, "board.yaml");
      if (!existsSync(file)) continue;
      const raw = (yaml.load(await readFile(file, "utf8")) ?? {}) as { statuses?: Array<Record<string, unknown>> };
      const step = (raw.statuses ?? []).find((s) => s?.id === DEPLOY_STEP_ID);
      if (step && "autorun" in step) offenders.push(`${id}: statuses[${DEPLOY_STEP_ID}].autorun`);
    }
    expect(offenders).toEqual([]);
  });

  it("o `autorun` resolvido do passo Publicar CASA com o release.mode de cada board", async () => {
    const mismatched: string[] = [];
    for (const { id } of await listBoards()) {
      const cfg = await readBoardConfig(id);
      const step = cfg.statuses.find((s) => s.id === DEPLOY_STEP_ID);
      if (!step) continue; // board com pipeline próprio que não tem o passo
      const expected = deployStepAutorun(releaseModeOf(cfg));
      if (step.autorun !== expected) mismatched.push(`${id}: autorun=${step.autorun} esperado=${expected}`);
    }
    expect(mismatched).toEqual([]);
  });
});

describe("board integrity — config do board.yaml é internamente consistente", () => {
  it("todo gate de status é um GateId conhecido e column é uma coluna declarada", async () => {
    for (const BOARD of BOARDS) {
      const cfg = await readBoardConfig(BOARD);
      const cols = new Set((cfg.columns ?? []).map((c) => c.id));
      const bad: string[] = [];
      for (const s of cfg.statuses) {
        if (s.gate && !GATE_IDS.includes(s.gate)) bad.push(`${s.id}.gate="${s.gate}" desconhecido`);
        if (s.column && !cols.has(s.column)) bad.push(`${s.id}.column="${s.column}" não declarada em columns`);
      }
      expect(bad).toEqual([]);
    }
  });

  it("as descrições só citam steps/stages que EXISTEM (pega rename-drift de prosa)", async () => {
    for (const BOARD of BOARDS) {
      const cfg = await readBoardConfig(BOARD);
      // todos os nomes atuais de step + stage
      const names = new Set<string>();
      for (const s of cfg.statuses) names.add(s.name);
      for (const c of cfg.columns ?? []) names.add(c.name);
      const stale: string[] = [];
      // refs de navegação: "move/avança/avance/mova ... para <Rótulo>" — o <Rótulo> deve ser um nome atual.
      // Exige inicial MAIÚSCULA (filtra prosa: "para a próxima", "para produção", "para o operador").
      const NAV = /(?:move|avança|avance|mova)\s+(?:manualmente\s+|o card\s+|a\s+)?para\s+([A-ZÀ-Ú][^.,()\n]{1,22}?)\s*(?:[.,)]|\bsó\b|\bquando\b|\bse\b|$)/gi;
      const check = (id: string, desc?: string) => {
        if (!desc) return;
        for (const m of desc.matchAll(NAV)) {
          const ref = m[1].trim();
          if (ref && !names.has(ref)) stale.push(`${id}: descrição manda ir "para ${ref}" — não é um step/stage atual`);
        }
      };
      for (const s of cfg.statuses) check(s.id, s.description);
      for (const c of cfg.columns ?? []) check(c.id, c.description);
      expect(stale).toEqual([]);
    }
  });

  // Mais forte que o lint acima (que só exige que o rótulo EXISTA): a descrição de um step que navega
  // "para <Step>" deve apontar para o PRÓXIMO step do pipeline (statuses[i+1], o happy-path da user
  // story). Pega o drift de ORDEM que o lint de existência não vê — ex.: enriquecer dizia "move para
  // Estimar" sendo que o próximo é Entrevista (um step interposto entre eles). Só valida refs que SÃO
  // nome de step (refs de stage/coluna ficam com o lint de existência). Refs "para X (..." não são
  // capturados pela NAV (o "(" corta), então a frase board-aware do interview/design-ui não é cobrada.
  it("as descrições navegam para o PRÓXIMO step real (pega drift de ORDEM, não só de nome)", async () => {
    for (const BOARD of BOARDS) {
      const cfg = await readBoardConfig(BOARD);
      const stepNames = new Set(cfg.statuses.map((s) => s.name));
      const NAV = /(?:move|avança|avance|mova)\s+(?:manualmente\s+|o card\s+|a\s+)?para\s+([A-ZÀ-Ú][^.,()\n]{1,22}?)\s*(?:[.,)]|\bsó\b|\bquando\b|\bse\b|$)/gi;
      const wrong: string[] = [];
      cfg.statuses.forEach((s, i) => {
        if (!s.description) return;
        const next = cfg.statuses[i + 1];
        if (!next) return; // último do array — sem "próximo"
        for (const m of s.description.matchAll(NAV)) {
          const ref = m[1].trim();
          if (!stepNames.has(ref)) continue; // ref de stage/coluna → fora do escopo deste lint
          if (ref !== next.name) {
            wrong.push(`${s.id}: descrição manda ir "para ${ref}", mas o próximo step do pipeline é "${next.name}"`);
          }
        }
      });
      expect(wrong).toEqual([]);
    }
  });

  // Fonte-da-verdade honesta: um GateId que existe no kernel (GATE_IDS + GATES) mas NÃO guarda nenhum
  // step de board é "dead code" silencioso — a spec (GATE_IDS) não reflete a realidade. Este lint
  // exige que todo GateId seja referenciado por ≥1 board OU esteja documentado como RESERVADO (com o
  // porquê). Assim um gate novo esquecido sem step FALHA, e os reservados ficam explícitos.
  it("todo GateId é usado por ≥1 board OU está documentado como reservado (sem gate fantasma)", async () => {
    const boards = await listBoards();
    const used = new Set<string>();
    for (const b of boards) {
      const cfg = await readBoardConfig(b.id);
      for (const s of cfg.statuses) if (s.gate) used.add(s.gate);
    }
    // Gates que existem DE PROPÓSITO sem guardar nenhum step hoje — cada um com a razão:
    const RESERVED: Record<string, string> = {
      hasCriteriaSpecs:
        "composto — hasBuildEvidence (C2/ny4v26) o delega e guarda revisar-codigo; predicado mantido como peça própria (parity/tests) e para steps futuros",
      hasAcceptance: "legado — superado por hasRefinement (narrativa + aceite); predicado mantido, sem step",
      hasRice: "legado — superado por hasPrioritization (type-aware); predicado mantido, sem step",
      hasStaged:
        "Fase 4b — reservado p/ o step stage/Homologar; não cabeado pois `!!stagedAt` (sem variante vacuous-ok) travaria um card board-only",
      hasReleased:
        "ADR-059 — outrora guardava o step deploy/Publicar; no modelo colapsado o promote stage→main passou a ser o efeito-ao-entrar do Deploy (promote-and-deploy), então o gate seria circular (travaria a entrada num card staged-mas-não-released). Predicado mantido como reserva.",
    };
    const orphan = GATE_IDS.filter((g) => !used.has(g) && !(g in RESERVED));
    expect(orphan).toEqual([]);
  });

  // Coerência de autorun na CADEIA DE BUILD (story-3t5cu3) — a cascata de autorun não pode auto-revisar/
  // qa um card que nunca foi CONSTRUÍDO. Na cadeia [desenvolver → revisar-codigo → qa-automatizado], o
  // autorun tem de ser NÃO-CRESCENTE: um passo autorun:true não pode ter um passo a montante autorun:false.
  // O bug real (nest/story-99wmbx): desenvolver era autorun:false (herdado do _base) enquanto revisar-codigo
  // e qa-automatizado eram autorun:true — a cascata PARA em desenvolver (harness-do nunca dispara: nem um no-op
  // no runner_status history) e o card acaba chegando a revisar-codigo/qa-automatizado com 0 tasks e zero
  // diff, onde harness-review/harness-qa rodam sobre um card não-construído. Nenhuma outra lint pega essa incoerência.
  it("a cadeia de build tem autorun NÃO-CRESCENTE em todo board (não auto-revisa/qa um card não-construído)", async () => {
    const boards = await listBoards();
    const BUILD_CHAIN = ["desenvolver", "revisar-codigo", "qa-automatizado"] as const;
    const bad: string[] = [];
    for (const b of boards) {
      const cfg = await readBoardConfig(b.id);
      const byId = new Map(cfg.statuses.map((s) => [s.id, s]));
      // só os passos da cadeia que ESTE board declara, preservando a ordem canônica
      const chain = BUILD_CHAIN.map((id) => byId.get(id)).filter((s): s is NonNullable<typeof s> => !!s);
      for (let i = 1; i < chain.length; i++) {
        const up = chain[i - 1];
        const down = chain[i];
        // só o autorun EXPLÍCITO conta como automático (idêntico ao guard do kernel, cascade-decision.ts:84)
        if (up.autorun !== true && down.autorun === true) {
          bad.push(
            `${b.id}: "${down.id}" é autorun:true mas o passo a montante "${up.id}" é autorun:${up.autorun ?? false} — ` +
              `a cascata para em "${up.id}" e o card chega a "${down.id}" sem ser construído`,
          );
        }
      }
    }
    expect(bad).toEqual([]);
  });

  // Aceite #3 (story-sbfutw) — todo link do board storymap real tem tipo conhecido,
  // ambas as pontas resolvem e respeitam as restrições from/to do edge. Hoje passa
  // vacuamente (links: [] em todos os cards) e é o guarda permanente para links futuros.
  it("todo links[] dos boards canônicos é válido: rel conhecido, pontas resolvem, from/to respeitados", async () => {
    let arestas = 0;
    for (const BOARD of BOARDS) {
      const cards = await readCards(BOARD);
      const cfg = await readBoardConfig(BOARD);
      const violations = validateBoardLinks(cfg, cards);
      expect(violations).toEqual([]);
      arestas += cards.reduce((n, c) => n + (c.links?.length ?? 0), 0);
    }
    // Não-vacuidade: enquanto TODO card tinha `links: []` este lint ficava verde sem validar aresta
    // nenhuma. O board fixture declara arestas de propósito — se elas sumirem, o lint volta a ser
    // teatro e este piso reprova antes disso.
    expect(arestas).toBeGreaterThan(0);
  });

  // O registry REOPEN_KINDS (reopen.ts) é a fonte única das lanes de reopen; este lint o trava ao
  // board.yaml REAL: o status de cada lane deve existir e carregar exatamente o gate que o registry
  // declara — senão um rename de coluna/gate divergiria silenciosamente do registry.
  it("cada lane de REOPEN_KINDS tem o status existente com o gate declarado", async () => {
    for (const BOARD of BOARDS) {
      const cfg = await readBoardConfig(BOARD);
      const byId = new Map(cfg.statuses.map((s) => [s.id, s]));
      const bad: string[] = [];
      for (const k of Object.values(REOPEN_KINDS)) {
        const step = byId.get(k.status);
        if (!step) {
          bad.push(`${k.mode}: status "${k.status}" não existe no board`);
          continue;
        }
        if (step.gate !== k.gate) {
          bad.push(`${k.mode}: status "${k.status}" tem gate "${step.gate ?? "(nenhum)"}", registry diz "${k.gate}"`);
        }
      }
      expect(bad).toEqual([]);
    }
  });
});

// WS3 (F2) — lints do toolkit declarativo contra os board.yaml REAIS. ERROS (ref de toolConfig
// inexistente, guidance > 300) FALHAM; a ausência de um mcp mount no disco é ADVISORY (só loga —
// um consumidor pode plugar o grafo depois). Antes da migração _base do toolkit os boards não têm
// facet nenhum → verde trivial; depois, trava o _base + os overrides.
describe("board integrity — toolkit declarativo (WS3 F2)", () => {
  it("todo toolkit.use/expect referencia um toolConfig existente + guidance ≤ 300 (todos os boards)", async () => {
    const boards = await listBoards();
    const allErrors: string[] = [];
    for (const b of boards) {
      const cfg = await readBoardConfig(b.id);
      const { errors } = lintToolkit(cfg, { boardId: b.id });
      allErrors.push(...errors.map((e) => `[${b.id}] ${e}`));
    }
    expect(allErrors).toEqual([]);
  });

  it("avisa (NÃO falha) um mcp mount ausente no disco — advisory p/ consumidor", async () => {
    for (const BOARD of BOARDS) {
      const cfg = await readBoardConfig(BOARD);
      const repoRoot = findRepoRoot();
      const { errors, warnings } = lintToolkit(cfg, {
        boardId: BOARD,
        repoRoot,
        mcpExists: (rel) => existsSync(path.isAbsolute(rel) ? rel : path.join(repoRoot, rel)),
      });
      expect(errors).toEqual([]); // estrutura sempre válida
      if (warnings.length) console.warn("[board-integrity toolkit]", warnings.join("; "));
      expect(Array.isArray(warnings)).toBe(true); // advisory — nunca falha o build
    }
  });

  // WS4 — os lints de rota/especialistas travados aos board.yaml REAIS: dispensable nunca em load-bearing,
  // toolkit.specialists e routeProfiles.skips resolvem, e todo specialist do _base tem seu .claude/agents/<slug>.md
  // (WARN se faltar — advisory).
  //
  // POR QUE ESTE TESTE OLHA PARA A ÁRVORE ANTES DE COBRAR. `.claude/agents/` é do repo CONSUMIDOR,
  // por decisão escrita na antiga lista de extração ("as lentes de review são do repo consumidor — o board só
  // declara o tier"): é exatamente ela que a indireção id→agent do `_base` existe para permitir.
  // Logo há DOIS tipos de checkout, e o invariante verdadeiro é diferente em cada um:
  //   • checkout que TRAZ as lentes (este monorepo) ⇒ toda declaração resolve. WARN vazio.
  //   • checkout que NÃO traz (o repo OSS extraído) ⇒ NENHUMA resolve, e isso é o projeto, não rot.
  // Cobrar "WARN vazio" nos dois reprovava o repo extraído por ele obedecer à régua; cobrar nada
  // seria vácuo. Então cada ramo cobra o seu, e o segundo cobra a ausência TOTAL — um checkout onde
  // 2 de 3 lentes sumiram não é "sem lentes", é rot, e cai nos dois ramos.
  it("WS4: rota/especialistas consistentes em TODOS os boards + specialists resolvem conforme a árvore", async () => {
    const boards = await listBoards();
    const repoRoot = findRepoRoot();
    const agentExists = (slug: string) => existsSync(path.join(repoRoot, ".claude", "agents", `${slug}.md`));
    const allErrors: string[] = [];
    const allWarnings: string[] = [];
    const declarados: string[] = [];
    for (const b of boards) {
      const cfg = await readBoardConfig(b.id);
      const { errors, warnings } = lintToolkit(cfg, { boardId: b.id, repoRoot, agentExists });
      allErrors.push(...errors.map((e) => `[${b.id}] ${e}`));
      // só os warnings de specialist (agent ausente) — o mcp advisory tem seu próprio teste
      allWarnings.push(...warnings.filter((w) => w.startsWith("specialist ")).map((w) => `[${b.id}] ${w}`));
      for (const [id, s] of Object.entries(cfg.specialists ?? {})) {
        expect(String((s as { agent?: string }).agent ?? ""), `[${b.id}] specialist "${id}" sem slug de agente`)
          .not.toBe("");
        declarados.push(`[${b.id}] ${id}`);
      }
    }
    expect(allErrors).toEqual([]);

    // NÃO-VACUIDADE, antes de qualquer ramo: o `_base` declara specialists e todo board os herda. Se
    // esta lista vier vazia, o lint acima passou por não ter o que olhar — e é ISSO que reprova.
    expect(declarados.length, "nenhum board declara specialist — o lint de rota mediu o vazio").toBeGreaterThan(0);

    const trazLentes = existsSync(path.join(repoRoot, ".claude", "agents"));
    if (trazLentes) {
      // Monorepo: os 3 agentes do `_base` existem — WARN vazio prova que a migração está completa.
      expect(allWarnings).toEqual([]);
    } else {
      // Repo OSS extraído: a régua corta `.claude/agents/` inteiro. Então TODA declaração tem de
      // aparecer no WARN — nem uma a menos (seria agente meio-viajado) nem a lista vazia (seria o
      // lint não tendo rodado). O advisory continua advisory: `allErrors` já foi cobrado vazio.
      expect(allWarnings.length, "checkout sem `.claude/agents/`: toda declaração devia virar advisory").toBe(
        declarados.length,
      );
    }
  });

  // WS8 — a riskMatrix de QUALQUER board não pode marcar deploy/destructive como `auto` (humano nos
  // irreversíveis). Vacuamente verde hoje (nenhum board declara orchestrator) — guarda permanente.
  it("WS8: nenhuma riskMatrix de board marca deploy/destructive como auto", async () => {
    const boards = await listBoards();
    const bad: string[] = [];
    for (const b of boards) {
      const cfg = await readBoardConfig(b.id);
      bad.push(...lintRiskMatrix(cfg.orchestrator).map((e) => `[${b.id}] ${e}`));
    }
    expect(bad).toEqual([]);
  });

  // F3.4 — o parse do orchestrator preserva a riskMatrix (round-trip: o serializer copia orchestrator verbatim,
  // então provar o PARSE prova o round-trip). Classe/disposição desconhecida é dropada (guarda de typo).
  it("F3.4: coerceOrchestrator round-trips a riskMatrix válida e dropa entradas inválidas", () => {
    const round = coerceOrchestrator({
      mode: "autonomous",
      maxActionsPerHour: 42,
      riskMatrix: { "write-board": "auto", run: "ask", deploy: "never", bogus: "auto", read: "banana" },
    });
    expect(round?.mode).toBe("autonomous");
    expect(round?.maxActionsPerHour).toBe(42);
    expect(round?.riskMatrix).toEqual({ "write-board": "auto", run: "ask", deploy: "never" }); // bogus/banana dropados
  });
});

// story-zr1cmf — DEPLOYABLE SURFACES (board.yaml deploy.surfaces) declare code that lives OUTSIDE `package`
// (e.g. the Caddy-served web terminal under tools/). The feature spans THREE sites that must agree — the
// merge-train split (reads the GLOBAL staging.codePrefixes), the release promote scope + out-of-scope probe
// (read the board's deploy.surfaces), and the self-deploy publish (runs deploy.surfaces[].deployCmd). These
// two lints keep them from silently drifting apart — the "two config homes" risk the design flagged.
describe("board integrity — superfícies deployáveis (deploy.surfaces, story-zr1cmf)", () => {
  const SELF_DEPLOY_PACKAGE = "packages/storymap-ui"; // deploy.ts TOOL_PACKAGE_REL — the ONLY self-deploy path
  const norm = (p: string) => `${p.replace(/\/+$/, "")}/`;

  it("todo surface.prefix está coberto por staging.codePrefixes (classificação → stage acompanha a promoção)", async () => {
    const { loadRunnerConfig } = await import("./runner/config");
    const codePrefixes = (loadRunnerConfig().autorun.staging?.codePrefixes ?? []).map(norm);
    const boards = await listBoards();
    const offenders: string[] = [];
    for (const b of boards) {
      const cfg = await readBoardConfig(b.id).catch(() => null);
      for (const s of cfg?.deploy?.surfaces ?? []) {
        const p = norm(s.prefix);
        // The split marks a path as CODE via p.startsWith(codePrefix). A surface not covered by ANY global
        // codePrefix would be classified as board-data → land on main ungated — the exact bug this closes.
        if (!codePrefixes.some((cp) => p.startsWith(cp))) {
          offenders.push(`${b.id}: surface "${s.prefix}" ausente de staging.codePrefixes (${codePrefixes.join(", ")})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("surface.deployCmd só existe no board de self-deploy (senão é no-op silencioso)", async () => {
    const boards = await listBoards();
    const offenders: string[] = [];
    for (const b of boards) {
      const cfg = await readBoardConfig(b.id).catch(() => null);
      const hasDeployCmd = (cfg?.deploy?.surfaces ?? []).some((s) => s.deployCmd?.trim());
      // deployBoard runs deployCmd ONLY on the STORYMAP self-deploy path; on any other board it never fires.
      if (hasDeployCmd && cfg?.package !== SELF_DEPLOY_PACKAGE) {
        offenders.push(`${b.id} (package ${cfg?.package ?? "—"}) declara surface.deployCmd, mas só ${SELF_DEPLOY_PACKAGE} o executa`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// A porta que o cabeçalho de uma coluna do Kanban abre (`columns[].tool`) é DECLARADA em board.yaml e
// resolvida contra o registro de navegação. É o formato de defeito que já nos mordeu duas vezes: uma
// capacidade declarada nos dados cujo PRODUTOR/consumidor no código some ou muda de nome — e ela não
// quebra nada, só deixa de aparecer, em silêncio (foi assim com `deploy.surfaces`, inerte por meses).
// Estes dois testes fecham as duas pontas: o id declarado tem de resolver, e alguém tem de declarar.
describe("board integrity — porta da coluna para a ferramenta (columns[].tool)", () => {
  it("todo `tool` declarado resolve para uma view real do menu (senão a porta some calada)", async () => {
    const boards = await listBoards();
    const offenders: string[] = [];
    for (const b of boards) {
      const cfg = await readBoardConfig(b.id).catch(() => null);
      for (const col of cfg?.columns ?? []) {
        if (!col.tool) continue;
        if (!navItemForView(col.tool as BoardView)) {
          offenders.push(`${b.id}/${col.id} aponta tool="${col.tool}", que não é uma view de nav-groups`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("a pipeline canônica declara ao menos UMA porta (o campo tem produtor, não só schema)", async () => {
    const cfg = await readBoardConfig(BOARDS[0]);
    const withTool = (cfg?.columns ?? []).filter((c) => c.tool);
    // Sem esta asserção, apagar o `tool:` do _base deixaria o campo vivo no tipo, no Zod e no coerce —
    // e nenhum teste notaria que a porta sumiu da tela.
    expect(withTool.length).toBeGreaterThan(0);
  });
});
