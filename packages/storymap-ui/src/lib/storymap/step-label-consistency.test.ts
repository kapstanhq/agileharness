// LINT — os NOMES dos steps têm uma fonte só: o board.
//
// O `skill-board-consistency` já guardava os IDS e as transições. Mas ele casa apenas ``in status `X` `` /
// ``sitting in `X` `` (com crase = id) — os NOMES LEGÍVEIS nunca tiveram guarda nenhuma, e derivaram
// livremente por meses:
//
//   • STEP_LABEL_BY_TRIGGER era um ESPELHO declarado ("mirrors the board's step names") — e derivou em 4:
//       harness-capture "Captura"        ≠ "Capturando"
//       harness-plan    "Plano técnico"  ≠ "Plano & Tarefas"
//       harness-qa      "QA automatizado"≠ "QA / Testes"
//       harness-ux      "Wireframe"      ≠ "Jornada"   ← o pior: a skill harness-ux existe justamente para NÃO fazer
//                                                     wireframes (isso é o harness-ui); a UI a rotulava com o nome
//                                                     exato da coisa que ela não faz.
//   • Os modais de reabertura ofereciam "Discovery"/"Design"/"Em desenvolvimento" — três rótulos que não são
//     `name` de step NENHUM (o card caía em "Especificar"/"Jornada"/"Desenvolver").
//
// Corrigir as strings não fecha a classe — só zera o contador. Este lint fecha: qualquer rótulo de step
// escrito à mão no código tem de ser IGUAL ao `name` do board.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { mergeRawConfig } from "./repo";
import { STEP_LABEL_BY_TRIGGER } from "./step-rollup";
import { pipelineBoards } from "./board-fixture";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

interface StatusDef {
  id: string;
  name?: string;
  trigger?: string;
}
const loadRaw = (f: string) => (yaml.load(readFileSync(f, "utf8")) ?? {}) as Record<string, unknown>;
const BASE_RAW = loadRaw(path.join(ROOT, "storymap", "boards", "_base", "board.yaml"));
const loadBoard = (b: string) =>
  (mergeRawConfig(BASE_RAW, loadRaw(path.join(ROOT, "storymap", "boards", b, "board.yaml"))) as unknown as {
    statuses: StatusDef[];
  }).statuses;

const BOARD_IDS = pipelineBoards();
const ALL_STATUSES = BOARD_IDS.flatMap(loadBoard);

/** trigger → os `name` que ele tem nos boards (um trigger pode ser step em N boards). */
const NAMES_BY_TRIGGER = new Map<string, Set<string>>();
for (const s of ALL_STATUSES) {
  if (!s.trigger || !s.name) continue;
  const set = NAMES_BY_TRIGGER.get(s.trigger) ?? new Set<string>();
  set.add(s.name);
  NAMES_BY_TRIGGER.set(s.trigger, set);
}
/** Todo `name` de step válido, em qualquer board. */
const ALL_STEP_NAMES = new Set(ALL_STATUSES.map((s) => s.name).filter(Boolean) as string[]);

describe("step-label-consistency — o NOME do step vem do board, não de uma cópia", () => {
  it("STEP_LABEL_BY_TRIGGER não diverge do board (o fallback também tem de dizer a verdade)", () => {
    const drift: string[] = [];
    for (const [trigger, label] of Object.entries(STEP_LABEL_BY_TRIGGER)) {
      const names = NAMES_BY_TRIGGER.get(trigger);
      if (!names) continue; // trigger telemetry-only (não é step de board) → rótulo livre
      if (!names.has(label)) {
        drift.push(`${trigger}: mapa diz "${label}", board diz ${[...names].map((n) => `"${n}"`).join(" ou ")}`);
      }
    }
    expect(
      drift,
      "Rótulo de step divergindo do board.yaml. O `name` do board é a FONTE — corrija o mapa (ou o board), " +
        "nunca deixe os dois discordarem: foi assim que o harness-ux virou 'Wireframe' na UI.",
    ).toEqual([]);
  });

  it("os destinos de reabertura (BugModal/RefineModal) usam nomes que EXISTEM no board", () => {
    // Estes modais ofereciam "Discovery"/"Design"/"Em desenvolvimento" — nenhum era `name` de step. O usuário
    // escolhia "Discovery" e o card caía em "Especificar". Agora eles derivam o rótulo do board; este lint
    // impede que alguém volte a digitar um nome inventado num `label:` ao lado de um `id:` de step.
    const offenders: string[] = [];
    for (const file of ["components/BugModal.tsx", "components/RefineModal.tsx"]) {
      const src = readFileSync(path.join(ROOT, "packages", "storymap-ui", "src", file), "utf8");
      for (const [, id, label] of src.matchAll(/\{\s*id:\s*"([^"]+)"\s*,\s*label:\s*"([^"]+)"/g)) {
        const isStep = ALL_STATUSES.some((s) => s.id === id);
        if (isStep && !ALL_STEP_NAMES.has(label)) {
          offenders.push(`${file}: id "${id}" rotulado "${label}" — não é o \`name\` de nenhum step`);
        }
      }
    }
    expect(offenders, "Rótulo inventado para um step. Derive do board (statusName), não escreva à mão.").toEqual(
      [],
    );
  });
});
