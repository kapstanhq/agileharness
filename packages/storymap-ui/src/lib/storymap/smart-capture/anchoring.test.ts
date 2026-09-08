import { describe, expect, it } from "vitest";
import { validateBatchAnchoring, validateExtendTargets, type AnchorTarget } from "./anchoring";
import type { ProposedItem } from "./types";
import type { BoardConfig } from "../types";

// A guarda de ancoragem do lote. O ponto DELICADO — e a razão deste arquivo existir — é que ela
// precisa cobrar EXATAMENTE o que a invariante cobra, nunca mais: o card capturado nasce na
// quarentena (a lane `staging`), e uma guarda mais estrita que a invariante foi o que quebrou a
// captura de bug (o prompt manda a entrega sair com `parent` = step; a guarda exigia a user story).

const config: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [
    { id: "triage", name: "Triagem", staging: true },
    { id: "desenvolver", name: "Desenvolver" },
    { id: "concluida", name: "Concluída", terminal: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};

const BOARD: Record<string, AnchorTarget> = {
  "act-1": { type: "activity", storyType: null },
  "step-1": { type: "step", storyType: null },
  "story-user": { type: "story", storyType: "user" },
  "story-entrega": { type: "story", storyType: "technical" },
};
const resolve = (ref: string) => BOARD[ref] ?? null;

const item = (over: Partial<ProposedItem>): ProposedItem => ({
  tempId: "i1",
  type: "story",
  title: "Item",
  rationale: "",
  ...over,
});

const messages = (items: ProposedItem[], landsInQuarantine: boolean) =>
  validateBatchAnchoring(items, resolve, { config, landsInQuarantine }).map((p) => p.message);

describe("validateBatchAnchoring — cobra a invariante, nem mais nem menos", () => {
  it("aceita a hierarquia canônica", () => {
    expect(
      messages(
        [
          item({ tempId: "a", type: "activity", title: "Ação" }),
          item({ tempId: "s", type: "step", title: "Passo", parent: "act-1" }),
          item({ tempId: "u", storyType: "user", title: "Story", parent: "step-1" }),
          item({ tempId: "d", storyType: "technical", title: "Entrega", serves: "story-user" }),
        ],
        false,
      ),
    ).toEqual([]);
  });

  it("AUSÊNCIA de âncora é tolerada na quarentena — e cobrada fora dela", () => {
    const semAncora = [item({ storyType: "user", title: "Solta" })];
    expect(messages(semAncora, true)).toEqual([]); // nasce na Triagem: decidir depois é legítimo
    expect(messages(semAncora, false)[0]).toMatch(/não tem parent/);
  });

  it("âncora QUEBRADA é recusada MESMO na quarentena — é dado corrompido, não decisão adiada", () => {
    expect(messages([item({ storyType: "user", parent: "step-fantasma" })], true)[0]).toMatch(
      /"step-fantasma" não existe/,
    );
  });

  it("âncora do TIPO ERRADO é recusada MESMO na quarentena — relacionamento errado parece certo", () => {
    // a entrega pendurada no step: o caso das 32 do censo, e o que o prompt antigo mandava fazer
    expect(messages([item({ storyType: "bug", parent: "step-1", title: "Bug" })], true)[0]).toMatch(
      /não é uma user story/,
    );
    // a user story pendurada na activity, pulando o passo
    expect(messages([item({ storyType: "user", parent: "act-1", title: "Pula passo" })], true)[0]).toMatch(
      /não é um passo/,
    );
    // entrega servindo outra ENTREGA (não é a story base)
    expect(messages([item({ storyType: "chore", serves: "story-entrega" })], true)[0]).toMatch(
      /não é uma user story/,
    );
  });

  it("resolve âncora contra um item do PRÓPRIO lote (backbone proposto junto)", () => {
    const lote = [
      item({ tempId: "s1", type: "step", title: "Passo novo", parent: "act-1" }),
      item({ tempId: "u1", storyType: "user", title: "Story", parent: "s1" }),
    ];
    const withBatch = (ref: string) => {
      const inBatch = lote.find((i) => i.tempId === ref);
      if (inBatch) return { type: inBatch.type, storyType: inBatch.storyType ?? "user" };
      return resolve(ref);
    };
    expect(validateBatchAnchoring(lote, withBatch, { config, landsInQuarantine: false })).toEqual([]);
  });

  it("activity com pai é violação; idea é isenta", () => {
    expect(messages([item({ type: "activity", title: "Ação", parent: "act-1" })], true)[0]).toMatch(
      /é uma ação \(raiz do mapa\)/,
    );
    expect(messages([item({ type: "idea", title: "Dor", storyType: null })], false)).toEqual([]);
  });

  it("item em modo ESTENDER não tem âncora a validar", () => {
    expect(messages([item({ targetCardId: "story-user", tasks: [{ title: "t" }] })], false)).toEqual([]);
  });
});

describe("validateExtendTargets — estender só sobre algo que existe", () => {
  const exists = (id: string) => id in BOARD;

  it("aceita alvo existente com tasks", () => {
    expect(
      validateExtendTargets([item({ targetCardId: "story-user", tasks: [{ title: "agrupar por dia" }] })], exists),
    ).toEqual([]);
  });

  it("recusa alvo inexistente — nunca degrada para 'cria um card novo'", () => {
    expect(
      validateExtendTargets([item({ targetCardId: "story-fantasma", tasks: [{ title: "x" }] })], exists)[0].message,
    ).toMatch(/não existe neste board/);
  });

  it("recusa extensão sem nada a acrescentar", () => {
    expect(validateExtendTargets([item({ targetCardId: "story-user", tasks: [] })], exists)[0].message).toMatch(
      /não traz nenhuma task/,
    );
  });

  it("ignora itens que não estendem", () => {
    expect(validateExtendTargets([item({ storyType: "user", parent: "step-1" })], exists)).toEqual([]);
  });
});
