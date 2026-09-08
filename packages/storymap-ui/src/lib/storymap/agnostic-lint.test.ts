// WS9 (transversal) — AGNOSTIC LINT. The AgileHarness will be extracted from the PlayPack monorepo and opened
// as a standalone tool, so `packages/storymap-ui/src/**` must carry ZERO product-specific names. This test
// greps every non-test source file for the consumer board names (nook/playpack/citygo/tribify/cidade) OUTSIDE
// comments and fails on any hit NOT in the explicit whitelist. The whitelist is the REGISTERED existing
// coupling debt (docs/plans/storymap-flow-v2/09-extracao-opensource.md §"Registro de débito"); it only ever
// SHRINKS — a hit in a new/agnostic file has no whitelist entry ⇒ FAIL. Same spirit as the autorun lint.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const BOARD_NAME_RE = /\b(nook|playpack|citygo|tribify|cidade)/i;

/** A file is skipped from the scan when it's a test / snapshot / typings / fixture (per the blueprint scope). */
const isSkipped = (p: string) => /\.test\.(ts|tsx)$|__snapshots__|\.snap$|\.d\.ts$|\/fixtures?\//.test(p);

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|js)$/.test(p) && !isSkipped(p)) acc.push(p);
  }
  return acc;
}

/** True when the trimmed line is a pure comment (line or block) — those legitimately name a board (prose). */
const isCommentLine = (t: string) => t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");

/**
 * The REGISTERED coupling-debt files (docs/plans/storymap-flow-v2/09-extracao-opensource.md). Each is a
 * WHOLESALE product-coupling module (deploy adapters, dev-toolkit personas, onboarding/description examples,
 * the VAPID default) that the extraction turns into a consumer adapter or a neutral placeholder. Every entry
 * carries the débito item it maps to. This list only shrinks — remove a file when it is extracted/neutralised.
 */
// AS TRÊS QUE SOBRAM têm uma coisa em comum, e é o que separa esta lista de uma lista de tarefas:
// NENHUMA delas é prosa. Cada uma é um VALOR DE CONFIGURAÇÃO DO CONSUMIDOR embutido como default no
// código — uma URL de sonda, um remetente VAPID, um `generatedBy`. Redigi-las não seria redação, seria
// trocar o default de alguém por outro default de alguém. O conserto certo é injetá-las por settings,
// que é trabalho de desenho, não de texto — e por isso elas continuam DÉBITO REGISTRADO e não viram
// item de redação.
// VAZIA desde 2026-09-02: `runner/stack-health.ts` saiu — a URL da sonda do QA stack virou o knob
// `AGILEHARNESS_QA_SEED_PROBE_URL` (catalogado no .env.example) com default NEUTRO; o id de projeto real
// que morava literal no fonte foi embora com ela. O teste de whitelist STALE abaixo é o que obriga esta
// linha a sumir quando o débito some.
const DEBT_WHITELIST: Record<string, string> = {};

// ── AS TRÊS QUE SAÍRAM (2026-08-12), e o que fez cada uma sair ───────────────────────────────────────
//
//   runner/product-deploy.ts          15 linhas → 0
//   runner/deploy.ts                   4 linhas → 0
//   notifications/…/trigger-runner-channel.ts   3 linhas → 0
//
// Não foi redação de comentário: as três só nomeavam produto porque duas COISAS eram literais no fonte do
// motor — a lista de apps deployáveis e o descritor da superfície composta. Ambas viraram declaração do
// ALVO (settings.yaml → `deploy.targets` / `deploy.composedFace`), e os nomes sumiram do código junto com
// o acoplamento. A prova de que a saída é real, e não cosmética, é o teste de whitelist STALE logo abaixo:
// se qualquer uma delas voltasse a ter um hit, ela precisaria voltar para cá; e se eu tivesse removido uma
// entrada que AINDA tem hit, o primeiro teste reprovaria apontando a linha.
//
// ── E AS TRÊS SEGUINTES SAÍRAM EM 2026-08-12 (a redação, #42) ────────────────────────────────────
//
//   mcp/dev-tools.ts    7 linhas → 0
//   mcp/tools.ts        4 linhas → 0
//   mcp/onboarding.ts   3 linhas → 0
//
// Estas 14 linhas eram TEXTO DE INSTRUÇÃO — `description` de tool e o guia que o MCP entrega no
// handshake. Elas valiam mais que os ~150 arquivos de teste que ainda citam nome de produto, e por um
// motivo estrutural: a `description` viaja dentro do `tools/list`, então ela É o contrato publicado, e
// o guia do onboarding é a PRIMEIRA coisa que um agente lê. O texto se autodescrevia como "a fonte da
// verdade de produto do ecossistema <do dono>" — uma ferramenta que se apresenta assim a quem a adota
// não está descrevendo o adotante, está descrevendo outra pessoa.
//
// A régua desta lista só encolhe, e o teste de whitelist STALE logo abaixo é quem cobra isso: uma
// entrada que perdeu o hit REPROVA até ser removida.

describe("agnostic-lint (WS9) — no new product-board names in storymap-ui/src", () => {
  it("every non-comment board-name hit is in a REGISTERED coupling-debt file (whitelist only shrinks)", () => {
    const files = walk("src");
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.replace(/\\/g, "/");
      const lines = readFileSync(f, "utf8").split("\n");
      const hit = lines.some((ln) => !isCommentLine(ln.trim()) && BOARD_NAME_RE.test(ln));
      if (!hit) continue;
      if (rel in DEBT_WHITELIST) continue; // known, registered debt
      // Report the first offending line so a new leak is easy to locate.
      const line = lines.findIndex((ln) => !isCommentLine(ln.trim()) && BOARD_NAME_RE.test(ln));
      offenders.push(`${rel}:${line + 1} → ${lines[line].trim().slice(0, 100)}`);
    }
    expect(offenders, "New product-board name in an AGNOSTIC file — inject it via board.yaml/settings/opaque id, or (if genuine debt) register it in docs/plans/storymap-flow-v2/09 + the whitelist.").toEqual([]);
  });

  it("the whitelist does not list a file that no longer has a hit (keep the debt registry honest)", () => {
    const stale: string[] = [];
    for (const rel of Object.keys(DEBT_WHITELIST)) {
      let content: string;
      try {
        content = readFileSync(rel, "utf8");
      } catch {
        continue; // file moved/deleted — a separate concern, not a stale-whitelist failure
      }
      const hit = content.split("\n").some((ln) => !isCommentLine(ln.trim()) && BOARD_NAME_RE.test(ln));
      if (!hit) stale.push(rel);
    }
    expect(stale, "Whitelisted file no longer has a board-name hit — remove it from DEBT_WHITELIST (the debt shrank).").toEqual([]);
  });
});
