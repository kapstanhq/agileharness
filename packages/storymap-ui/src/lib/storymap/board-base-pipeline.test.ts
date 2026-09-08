import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readBoardConfig, listBoards } from "./repo";
import { GOVERNANCE_ARTIFACTS } from "./types";
import { expectedBoardIds } from "./board-fixture";
import { arvore, OSS_TREE_ROOT } from "./oss-tree";
import type { BoardConfig } from "./types";

// Fields edited LIVE through the strategy bancada / save_persona / save_system (governance artifacts +
// `systems`) are board DATA, not the pipeline this golden guards. Capturing them made the snapshot break
// on every strategy edit (it captured a `positioning` the bancada wrote — story item #7). Redact them so
// the snapshot stays byte-stable across live edits and asserts ONLY the resolved pipeline
// (statuses/columns/gates/steps/linkTypes/…). Any drift here is a genuine pipeline regression.
// `autorunDisabled` (story-fr5bnt) is a per-board OPERATIONAL flag, not the shared pipeline this golden
// guards — redact it so setting it on a board.yaml (e.g. `storymap`) never trips the pipeline snapshot.
// `orchestrator` (mode + riskMatrix) is the SAME class, and its omission was a live footgun: it is the
// copiloto's autonomy TOGGLE, flipped by the operator in the UI popover — which rewrites board.yaml, which the
// autorun's "estado vivo" sweep COMMITS. So a click made this golden red; a red suite makes the merge gate
// REPROVE every merge-back; and the whole pipeline froze until someone re-baselined by hand (twice in two days
// — off→paired, then paired→autonomous). A golden that photographs a BUTTON is a self-inflicted freeze.
// `styleGuide` (bloco de Design WS-0) is the SAME class again: the pointer is written by the
// `promoteStyleGuideDoc` chokepoint (the human-authoring apply), a live operator action, NOT the
// shared pipeline this golden guards — redact it DIRECTLY here rather than through
// `GOVERNANCE_ARTIFACTS` (that road writes its `after` verbatim with no recompile/checkAA; adding
// `styleGuide` there would be a side door that desyncs the pointer from the compiled .md).
const VOLATILE_FIELDS = [...GOVERNANCE_ARTIFACTS, "systems", "autorunDisabled", "orchestrator", "styleGuide"] as const;
function redactVolatile(cfg: BoardConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cfg };
  for (const f of VOLATILE_FIELDS) delete out[f];
  return out;
}

// R1 / B5 incr. 2 — GOLDEN regression guard for moving the canonical Stage→Step pipeline into
// boards/_base. The snapshots below capture each board's RESOLVED config (post _base deep-merge)
// BEFORE the extraction. After the canonical pipeline moves to _base (the `storymap` board inherits
// it with no pipeline delta; product boards `nest`/`quartz` keep their own older pipeline via
// `inheritPipeline: false`), readBoardConfig MUST resolve BYTE-IDENTICALLY — every snapshot stays
// green. That is the whole safety claim of R1: zero card migration, zero behavior change.
//
// Regenerate (vitest -u) ONLY for an INTENDED pipeline change, and explain it in the diff — a
// surprise snapshot diff here means a board's resolved pipeline drifted.

// ── O GOLDEN NÃO VIAJA, E ISSO É DECISÃO ────────────────────────────────────────────────────────────
//
// O arquivo `__snapshots__/board-base-pipeline.test.ts.snap` fotografa a config RESOLVIDA de TODO
// board DESTA árvore — o que, nesta casa, inclui os quatro boards privados do dono. Ele viajava na
// extração e republicava o conteúdo deles por uma porta que nenhum guarda olhava (o `agnostic-lint`
// pula `__snapshots__|\.snap$` por construção). A régua agora o corta (`__snapshots__/` no
// `.ossignore`), e quem cobra a classe inteira por CONTEÚDO é `oss-identity-hygiene.test.ts`.
//
// O efeito colateral tem de ser tratado AQUI, e não com um `existsSync(...) return` genérico: no
// repositório extraído, `CI=true` faz o vitest RECUSAR escrever o golden que falta — medido, o teste
// reprova com "Snapshot … mismatched". Um golden é a linha de base DA ÁRVORE QUE O GEROU; a linha de
// base do repo adotante é a árvore DELE, e enquanto ninguém a tirar lá não há o que comparar.
//
// A condição é ESTREITA de propósito, e é o que a impede de virar interruptor de desligar:
//   · exige `arvore() === "extraido"` — dois sinais independentes que TÊM de discordar, senão lança;
//   · no umbrella ela é SEMPRE falsa, então apagar o golden daqui continua reprovando (a cobertura
//     desta casa não é trocada por nada);
//   · e some sozinha assim que a extração regenerar a linha de base no destino.
const CAMINHO_DO_GOLDEN = fileURLToPath(
  new URL("./__snapshots__/board-base-pipeline.test.ts.snap", import.meta.url),
);
const semLinhaDeBase = arvore() === "extraido" && !existsSync(CAMINHO_DO_GOLDEN);
if (semLinhaDeBase) {
  // GRITA, como `oss-tree.ts` faz com todo guarda umbrella-only: quem roda a suíte no artefato tem
  // de saber o que deixou de ser medido — silêncio aqui é o mesmo que portão verde por vacuidade.
  console.warn(
    "[board-base-pipeline] o golden do pipeline NÃO foi medido: esta árvore é o repositório extraído " +
      `e não há linha de base em ${CAMINHO_DO_GOLDEN}. O guarda volta sozinho quando a extração (ou ` +
      "um `vitest -u` local) tirar a primeira fotografia DESTA árvore.",
  );
}

describe("board resolved config — golden snapshot (byte-identical across the _base extraction)", () => {
  it.skipIf(semLinhaDeBase)("resolves every live board deterministically", async () => {
    const boards = (await listBoards()).sort((a, b) => a.id.localeCompare(b.id));
    // Os boards de fixture são PISO incondicional; os privados do dono entram quando a árvore os
    // tem (o repositório extraído não os tem — por decisão de projeto, não por acidente).
    expect(boards.map((b) => b.id)).toEqual(expectedBoardIds());
    for (const b of boards) {
      const cfg = await readBoardConfig(b.id);
      expect(redactVolatile(cfg)).toMatchSnapshot(b.id);
    }
  });

  // A METADE DA COBERTURA QUE ATRAVESSA O CORTE. Sem golden não há como comparar bytes, mas as duas
  // propriedades abaixo não dependem de linha de base nenhuma: `listBoards()` não pode PULAR um board
  // com yaml válido nem INVENTAR um que não está no disco, e todo board resolvido tem de RESOLVER
  // (herança do `_base` aplicada, id preservado). Este `it` roda nas DUAS árvores — é ele que impede o
  // `skipIf` acima de deixar o artefato sem nenhuma medição da resolução de board.
  //
  // Nome NOVO de propósito: a chave de um snapshot é derivada do nome do `describe`+`it`, e renomear
  // o `it` de cima invalidaria os seis retratos já gravados. Aqui não se grava snapshot algum.
  it("enumera e resolve todo board do disco (a parte que não depende de linha de base)", async () => {
    const boards = (await listBoards()).sort((a, b) => a.id.localeCompare(b.id));
    expect(boards.map((b) => b.id)).toEqual(expectedBoardIds());
    // Anti-vácuo: um `listBoards()` que devolvesse vazio satisfaria o laço abaixo sem medir nada, e
    // `expectedBoardIds()` já garante os dois fixtures como PISO nas duas árvores.
    expect(boards.length, "nenhum board para resolver — o laço abaixo não mediria nada").toBeGreaterThanOrEqual(2);

    // ── INVARIANTE DO SÍTIO: o golden só fotografa board DESTA árvore ─────────────────────────────
    //
    // A comparação acima (`toEqual(expectedBoardIds())`) NÃO cobre isto, e é importante dizer por quê:
    // os dois lados dela leem o MESMO disco — `listBoards()` e `expectedBoardIds()` descem ambos para
    // `boardsDir()` → `findRepoRoot()`. Ela pega `listBoards` PULANDO ou INVENTANDO um board; é cega
    // para a árvore inteira estar errada. Sob `STORYMAP_TARGET` ela fica verde fotografando os boards
    // de outro repositório — que foi como, em 2026-08-19, quatro retratos de boards privados viajaram
    // para o artefato público com a suíte verde.
    //
    // `OSS_TREE_ROOT` é derivado da localização DESTE módulo, então é a única raiz aqui que
    // `STORYMAP_TARGET` não consegue mover. `vitest.setup.ts` já apaga o env; este invariante cobre o
    // que o saneamento não alcança — a prova que reatribui o alvo em `beforeAll` (sete arquivos
    // fazem isso, legitimamente) e que, por engano, deixasse o golden rodar debaixo dele.
    const nativos = new Set(
      readdirSync(path.join(OSS_TREE_ROOT, "storymap", "boards"), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
        .map((d) => d.name),
    );
    expect(nativos.size, "nenhum board nativo lido — o invariante ficaria vácuo").toBeGreaterThan(0);
    for (const b of boards) {
      expect(
        nativos.has(b.id),
        `o board "${b.id}" NÃO é deste repositório. A suíte está lendo outra árvore — quase sempre ` +
          `um \`STORYMAP_TARGET\` reatribuído em prova. Um \`vitest -u\` aqui gravaria o retrato de ` +
          `board alheio NESTE repositório.`,
      ).toBe(true);
    }

    for (const b of boards) {
      const cfg = await readBoardConfig(b.id);
      expect(cfg.id, `readBoardConfig("${b.id}") devolveu outro id`).toBe(b.id);
      expect(
        Array.isArray(cfg.statuses) && cfg.statuses.length > 0,
        `"${b.id}" resolveu SEM statuses — a herança do _base não foi aplicada`,
      ).toBe(true);
    }
  });
});
