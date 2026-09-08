import { describe, expect, it } from "vitest";
import { load, dump } from "js-yaml";
import {
  coerceStrategyText,
  coerceCanvas,
  coerceCanvasTags,
  coercePersonas,
  coerceSystems,
  deriveBoardConfigForPersist,
  readBoardConfig,
} from "./repo";
import { FIXTURE_BOARD, FIXTURE_LEGACY_BOARD } from "./board-fixture";

// SM-strategy — `desiredOutcome` + `canvas` (the strategy bench / Marketing block) are declared in
// BoardConfig (types.ts) AND BoardConfigSchema (contracts.ts) but were SILENTLY DROPPED on BOTH sides:
// readBoardConfig built the config field-by-field WITHOUT them, and deriveBoardConfigForPersist never
// emitted them — so a governance approve / direct edit wrote a GHOST (the canonical value never
// changed, yet the UI reported success). These tests pin the fixed round-trip so the regression can't
// come back. The board-base-pipeline golden snapshot is the complementary guard: it now records
// desiredOutcome/canvas on every resolved config, so dropping them from readBoardConfig fails it too.

describe("strategy field coercion (read side — readBoardConfig invokes these)", () => {
  it("coerceStrategyText keeps a real statement; blank/null/undefined → undefined (sparse, like headroom)", () => {
    expect(coerceStrategyText("Levar cards de captura a merge sem intervenção")).toBe(
      "Levar cards de captura a merge sem intervenção",
    );
    expect(coerceStrategyText("   ")).toBeUndefined();
    expect(coerceStrategyText("")).toBeUndefined();
    expect(coerceStrategyText(null)).toBeUndefined();
    expect(coerceStrategyText(undefined)).toBeUndefined();
  });

  // O canvas passou de "um paragrafão por bloco" para "um bloco tem ITENS". A leitura tem de continuar
  // aceitando o formato LEGADO (string) — senão um board que nunca migrou perde o conteúdo na hora em
  // que o código sobe. A promoção é lossless: a prosa vira o item #1.
  it("coerceCanvas PROMOTES a legacy string block into a single item (nothing is lost)", () => {
    expect(coerceCanvas({ problem: " conflito ao paralelizar ", solution: null, uvp: "" })).toEqual({
      problem: { items: [{ id: "i1", text: "conflito ao paralelizar" }] },
      solution: null,
      uvp: null,
    });
  });

  it("coerceCanvas keeps a structured block, trims, and drops item-less blocks", () => {
    expect(
      coerceCanvas({
        problem: {
          items: [
            { id: "i1", text: " agenda espalhada ", tags: ["descobridor", "descobridor"], group: " Demanda " },
            { text: "sem id → ganha um" },
            { text: "   " }, // sem texto → não é item
          ],
        },
        solution: { items: [] }, // bloco vazio é NULO (o "empty is null" que o gate de governança usa)
      }),
    ).toEqual({
      problem: {
        items: [
          { id: "i1", text: "agenda espalhada", tags: ["descobridor"], group: "Demanda" },
          { id: "i2", text: "sem id → ganha um" },
        ],
      },
      solution: null,
    });
    expect(coerceCanvas({})).toBeUndefined();
    expect(coerceCanvas(null)).toBeUndefined();
    expect(coerceCanvas("não é objeto")).toBeUndefined();
  });
});

// A TERCEIRA ocorrência da mesma classe (depois de desiredOutcome/canvas e de sharedPackages/deploy):
// `faceUrl` — a superfície publicada que o canary de frescor sonda — foi declarada no tipo E no schema Zod,
// e mesmo assim DESCARTADA no coerce de leitura. O efeito em produção (2026-07-18, acme/story-novo-item): o
// canary caiu no default legado, mediu a RAIZ (que é outro app sob single-origin), viu um sha antigo e
// REVERTEU um card cujo código estava provadamente no ar — três vezes, até o item morrer no backoff.
//
// O teste que faltava não era da função pura (`resolveFaceUrl` sempre passou, recebendo o valor na mão):
// era o da FIAÇÃO — provar que o campo SOBREVIVE à leitura do yaml. Testar o predicado não prova o wiring.
describe("faceUrl — a superfície declarada sobrevive à leitura e à escrita (campo inerte é o bug)", () => {
  it("readBoardConfig SURFACES faceUrl do board que o declara (sem isto o canary sonda a superfície errada)", async () => {
    // O par que torna a prova discriminante mora no disco: `demo-legado` DECLARA faceUrl e `demo` NÃO.
    // Ler o valor esperado do próprio yaml cru seria fotografar o dado vivo — por isso ele é literal aqui.
    const declara = await readBoardConfig(FIXTURE_LEGACY_BOARD);
    expect(declara.faceUrl, `${FIXTURE_LEGACY_BOARD} declara faceUrl no board.yaml — se vier undefined, o coerce está descartando`).toBe(
      "https://aurora.exemplo.dev/selo/",
    );
  });

  it("board que NÃO declara → undefined (esparso: ninguém é forçado a migrar)", async () => {
    const semFace = await readBoardConfig(FIXTURE_BOARD);
    expect(semFace.faceUrl).toBeUndefined();
  });

  it("deriveBoardConfigForPersist EMITE faceUrl — um save não pode apagar a superfície declarada", async () => {
    const base = await readBoardConfig(FIXTURE_BOARD);
    const raw = await deriveBoardConfigForPersist(FIXTURE_BOARD, { ...base, faceUrl: "https://exemplo.dev/app/" });
    expect(raw.faceUrl).toBe("https://exemplo.dev/app/");

    const without = await deriveBoardConfigForPersist(FIXTURE_BOARD, { ...base, faceUrl: undefined });
    expect(without.faceUrl, "ausente não vira chave vazia no YAML").toBeUndefined();
  });
});

describe("board config — strategy bench fields round-trip (desiredOutcome/canvas)", () => {
  it("deriveBoardConfigForPersist EMITS desiredOutcome/canvas when present — and no empty husks", async () => {
    const base = await readBoardConfig(FIXTURE_BOARD);
    const raw = await deriveBoardConfigForPersist(FIXTURE_BOARD, {
      ...base,
      desiredOutcome: "Levar cards de captura a merge sem intervenção manual",
      canvas: {
        problem: { items: [{ id: "i1", text: "conflito ao paralelizar" }] },
        solution: null, // vazio não vira chave no YAML
      },
    });
    expect(raw.desiredOutcome).toBe("Levar cards de captura a merge sem intervenção manual");
    expect(raw.canvas).toEqual({ problem: { items: [{ id: "i1", text: "conflito ao paralelizar" }] } });
  });

  it("EMITS canvasTags (the canvas colour vocabulary) — and omits it when empty", async () => {
    const base = await readBoardConfig(FIXTURE_BOARD);
    const withTags = await deriveBoardConfigForPersist(FIXTURE_BOARD, {
      ...base,
      canvasTags: [{ id: "descobridor", name: "Descobridor", color: "#E8A13C" }],
    });
    expect(withTags.canvasTags).toEqual([{ id: "descobridor", name: "Descobridor", color: "#E8A13C" }]);

    const without = await deriveBoardConfigForPersist(FIXTURE_BOARD, { ...base, canvasTags: [] });
    expect("canvasTags" in without).toBe(false);
  });

  // O caminho MCP (`propose_change`) declara `after: z.any()` e o approve seta o valor VERBATIM no
  // config. Se a escrita confiasse na forma, um agente que ainda "conhece" o canvas antigo (string)
  // derrubaria o approve com um TypeError — ou gravaria um husk que ninguém consegue ler de volta.
  // Por isso a escrita COAGE: qualquer estrada para o board.yaml deposita a mesma forma.
  it("COERCES a raw/legacy value on the WRITE path (an agent's z.any() `after` can't corrupt board.yaml)", async () => {
    const base = await readBoardConfig(FIXTURE_BOARD);
    const raw = await deriveBoardConfigForPersist(FIXTURE_BOARD, {
      ...base,
      // o que um propose_change desavisado depositaria no canônico:
      canvas: { problem: "uma dor em prosa (formato antigo)" as unknown as never },
      canvasTags: [{ id: "seg", name: "Seg", color: "não-é-hex" }],
    });
    expect(raw.canvas).toEqual({ problem: { items: [{ id: "i1", text: "uma dor em prosa (formato antigo)" }] } });
    expect(raw.canvasTags).toEqual([{ id: "seg", name: "Seg" }]); // a cor inválida não vai para o disco
  });

  it("OMITS them when absent (sparse — no ghost keys written to board.yaml)", async () => {
    const base = await readBoardConfig(FIXTURE_BOARD);
    const raw = await deriveBoardConfigForPersist(FIXTURE_BOARD, {
      ...base,
      desiredOutcome: undefined,
      canvas: undefined,
    });
    expect("desiredOutcome" in raw).toBe(false);
    expect("canvas" in raw).toBe(false);
  });

  it("survives the real js-yaml dump→load (write → read) with the ITEMS + TAGS intact", async () => {
    const base = await readBoardConfig(FIXTURE_BOARD);
    const raw = await deriveBoardConfigForPersist(FIXTURE_BOARD, {
      ...base,
      desiredOutcome: "X estrela",
      canvas: {
        problem: { items: [{ id: "i1", text: "Y", tags: ["seg"], group: "Demanda" }] },
        solution: null,
      },
      canvasTags: [{ id: "seg", name: "Segmento", color: "#E8A13C" }],
    });
    const reloaded = load(dump(raw)) as Record<string, unknown>;
    expect(coerceStrategyText(reloaded.desiredOutcome)).toBe("X estrela");
    // O que sai da escrita e volta pela leitura é IDÊNTICO — a tag e o grupo sobrevivem ao YAML.
    expect(coerceCanvas(reloaded.canvas)).toEqual({
      problem: { items: [{ id: "i1", text: "Y", tags: ["seg"], group: "Demanda" }] },
    });
    expect(coerceCanvasTags(reloaded.canvasTags)).toEqual([{ id: "seg", name: "Segmento", color: "#E8A13C" }]);
  });
});

// personas-as-prompt — a Persona is now authored as a single SYSTEM PROMPT (Persona.prompt). It must
// survive the SAME read+write path (coercePersonas reads it; deriveBoardConfigForPersist emits the
// personas array; js-yaml round-trips it) so the bench's edit lands on disk and reloads intact. The
// coerce footgun (a new field silently dropped by coerce* while contracts.test's safeParse accepts the
// extra key) is exactly what this pins.
describe("persona-as-prompt round-trip (Persona.prompt)", () => {
  it("coercePersonas reads the `prompt` field (not dropped on read)", () => {
    const out = coercePersonas([{ id: "p", name: "P", color: "#000", prompt: "Você é P: decide por evidência." }]);
    expect(out[0]?.prompt).toBe("Você é P: decide por evidência.");
  });

  it("deriveBoardConfigForPersist EMITS a persona's prompt and it survives the real js-yaml dump→load", async () => {
    const base = await readBoardConfig(FIXTURE_BOARD);
    const persona = { id: "test-icp", name: "Test ICP", color: "#7daa76", prompt: "Você é o Teste, um ICP de prova: 'decide por evidência?' — sim." };
    const raw = await deriveBoardConfigForPersist(FIXTURE_BOARD, {
      ...base,
      personas: [...base.personas, persona],
    });
    const reloaded = load(dump(raw)) as Record<string, unknown>;
    const back = coercePersonas(reloaded.personas).find((p) => p.id === "test-icp");
    expect(back?.prompt).toBe(persona.prompt);
    expect(back?.name).toBe("Test ICP");
  });

  // `Persona.kind` — o TIPO que agrupa a listagem ("Segmento de mercado" × "Interna"). Caiu EXATAMENTE
  // na armadilha que o comentário acima descreve, e vale registrar o sintoma porque ele não parece um
  // bug de leitura: o campo estava no tipo, estava no schema Zod (que é ALARME de drift, log-only — ele
  // ACEITA a chave extra em vez de exigi-la) e a gravação o escrevia certo. Só a coerção não o carregava.
  // Resultado: cada read-modify-write apagava o tipo de todas as OUTRAS personas, então o agente
  // classificou 7, as 7 gravações responderam ok, e sobrou 1 — a última.
  it("coercePersonas lê o `kind` (o gêmeo do SystemDef.kind — era ele o campo dropado)", () => {
    const out = coercePersonas([{ id: "p", name: "P", color: "#000", kind: "Segmento de mercado" }]);
    expect(out[0]?.kind).toBe("Segmento de mercado");
  });

  // A guarda GENÉRICA: um round-trip com TODOS os campos preenchidos. Um campo novo que alguém adicione
  // ao tipo e esqueça na coerção falha aqui, sem depender de lembrarem de escrever um teste por campo.
  it("ROUND-TRIP de uma persona COMPLETA — nenhum campo se perde entre disco e memória", () => {
    const full = {
      id: "full",
      name: "Completa",
      color: "#7daa76",
      kind: "Interna",
      prompt: "Você é a Completa.",
      role: "Papel de uma linha",
      description: "Descrição curta.",
      jobs: ["job A"],
      pains: ["dor A"],
      gains: ["ganho A"],
      avatar: "/avatars/storymap/full.png",
    };
    expect(coercePersonas([load(dump([full]))].flat() as unknown)[0]).toEqual(full);
  });
});

describe("system-as-prompt round-trip (SystemDef.prompt)", () => {
  it("coerceSystems reads the `prompt` field (not dropped on read)", () => {
    const out = coerceSystems([{ id: "s", name: "S", color: "#000", prompt: "O sistema S detém X; limite: não toque Y." }]);
    expect(out[0]?.prompt).toBe("O sistema S detém X; limite: não toque Y.");
  });

  it("deriveBoardConfigForPersist EMITS a system's prompt + drift anchors; all survive the real js-yaml dump→load", async () => {
    const base = await readBoardConfig(FIXTURE_BOARD);
    const system = {
      id: "test-sys",
      name: "Test Sys",
      color: "#6366f1",
      kind: "Serviço",
      prompt: "O Test Sys orquestra Z; respeite o lock por card.",
      paths: ["packages/storymap-ui/src/lib/storymap/runner/test-sys.ts"],
      syncedCommit: "abc1234",
    };
    const raw = await deriveBoardConfigForPersist(FIXTURE_BOARD, {
      ...base,
      systems: [...base.systems, system],
    });
    const reloaded = load(dump(raw)) as Record<string, unknown>;
    const back = coerceSystems(reloaded.systems).find((s) => s.id === "test-sys");
    expect(back?.prompt).toBe(system.prompt);
    expect(back?.kind).toBe("Serviço");
    expect(back?.paths).toEqual(system.paths);
    expect(back?.syncedCommit).toBe("abc1234");
  });

  /** A MESMA guarda genérica do lado do sistema — simétrica de propósito, para o par não divergir. */
  it("ROUND-TRIP de um sistema COMPLETO — nenhum campo se perde entre disco e memória", () => {
    const full = {
      id: "full-sys",
      name: "Sistema Completo",
      color: "#6366f1",
      kind: "Serviço",
      prompt: "O Sistema Completo detém X.",
      description: "Descrição curta.",
      capabilities: ["capacidade A"],
      constraints: ["limite A"],
      paths: ["packages/storymap-ui/src/x.ts"],
      syncedCommit: "abc1234",
    };
    expect(coerceSystems([load(dump([full]))].flat() as unknown)[0]).toEqual(full);
  });
});

// D15 — story-fr5bnt kill-switch: `autorunDisabled` era a MESMA classe de bug que desiredOutcome/canvas
// (declarado em types+contract, consumido por autorun-eval, mas dropado no read field-by-field E no
// persist). O teste unitário do autorun-eval passava porque constrói o config EM MEMÓRIA — em produção o
// resolvido lia undefined e a flag do board.yaml era deletada por qualquer save. Pina os DOIS lados.
describe("board config — autorunDisabled (per-board kill-switch) round-trip", () => {
  it("readBoardConfig carries the flag from the RAW board.yaml (no live-data photograph: asserts equivalence)", async () => {
    const { promises: fs } = await import("node:fs");
    const { boardConfigPath } = await import("./paths");
    const own = load(await fs.readFile(boardConfigPath(FIXTURE_BOARD), "utf8")) as Record<string, unknown>;
    const resolved = await readBoardConfig(FIXTURE_BOARD);
    // equivalence to the raw file, whatever the operator set — never a frozen snapshot of live state
    expect(resolved.autorunDisabled).toBe(own.autorunDisabled === true ? true : undefined);
  });

  it("deriveBoardConfigForPersist EMITS the flag when set and OMITS it when absent (no ghost key)", async () => {
    const base = await readBoardConfig(FIXTURE_BOARD);
    const withFlag = await deriveBoardConfigForPersist(FIXTURE_BOARD, { ...base, autorunDisabled: true });
    expect(withFlag.autorunDisabled).toBe(true);
    const without = await deriveBoardConfigForPersist(FIXTURE_BOARD, { ...base, autorunDisabled: undefined });
    expect("autorunDisabled" in without).toBe(false);
    // and the flag survives a real js-yaml dump→load (the exact write→read path of board.yaml)
    const reloaded = load(dump(withFlag)) as Record<string, unknown>;
    expect(reloaded.autorunDisabled).toBe(true);
  });
});
