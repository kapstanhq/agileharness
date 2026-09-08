// A régua de estado do train — e o lint que impede a sexta cópia dela de nascer.
//
// O motivo destes testes existirem não é o conteúdo das listas (que é curto e óbvio), é a HISTÓRIA: a
// mesma pergunta tinha cinco respostas escritas à mão, e a versão anterior deste defeito — `laneOf` ×
// `trainInFlight` divergindo em dois status — fez trabalho SUMIR da página de Entrega sem que nenhuma
// das duas listas estivesse "errada" isoladamente.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isActiveMergeStatus, isLiveMergeStatus, isParkedMergeStatus } from "./merge-status";
import { trainInFlight, trainIsMoving } from "./delivery-view";
import type { MergeQueueStatus } from "./types";

const TODOS: MergeQueueStatus[] = [
  "waiting",
  "gate-running",
  "merging",
  "re-driving",
  "gate-failed",
  "conflict",
  "returned-to-session",
  "failed",
  "done",
];

describe("merge-status — ativa × parqueada × viva", () => {
  it("ATIVA = o train tem nas mãos agora", () => {
    expect(TODOS.filter(isActiveMergeStatus)).toEqual(["waiting", "gate-running", "merging"]);
  });

  it("PARQUEADA = parou esperando o operador", () => {
    expect(TODOS.filter(isParkedMergeStatus)).toEqual(["gate-failed", "conflict"]);
  });

  it("VIVA = ativa ∪ parqueada, e `re-driving` fica de FORA", () => {
    expect(TODOS.filter(isLiveMergeStatus)).toEqual(["waiting", "gate-running", "merging", "gate-failed", "conflict"]);
    // O ponto que a lista hardcoded acertava por acidente e que agora está travado: `re-driving` é
    // terminal para AQUELE branch (deletado, run novo despachado) — contá-lo como vivo faria uma entrada
    // fantasma segurar a cabeça da fila e sobreviver a caps.
    expect(isLiveMergeStatus("re-driving")).toBe(false);
  });

  it("os desfechos terminais nunca são vivos", () => {
    for (const s of ["done", "failed", "returned-to-session"] as const) expect(isLiveMergeStatus(s)).toBe(false);
  });
});

describe("as réguas da VISÃO derivam da do motor — e a diferença é exatamente `re-driving`", () => {
  it("trainInFlight = viva + re-driving", () => {
    for (const s of TODOS) expect(trainInFlight(s)).toBe(isLiveMergeStatus(s) || s === "re-driving");
  });

  it("trainIsMoving = ativa + re-driving", () => {
    for (const s of TODOS) expect(trainIsMoving(s)).toBe(isActiveMergeStatus(s) || s === "re-driving");
  });

  it("nenhum status é 'em voo' para a tela e ao mesmo tempo invisível para as duas raias", () => {
    // O invariante que o vão anterior violava: todo status ou pertence à raia do train, ou volta para a
    // sessão. Nunca a lugar nenhum. (`laneOf` é testado em delivery-view.test; aqui travamos a régua.)
    for (const s of TODOS) expect(typeof trainInFlight(s)).toBe("boolean");
    expect(TODOS.filter(trainInFlight)).toEqual([
      "waiting",
      "gate-running",
      "merging",
      "re-driving",
      "gate-failed",
      "conflict",
    ]);
  });
});

/**
 * O LINT. Quatro chamadores tinham reescrito `new Set(["waiting","gate-running","gate-failed",
 * "merging","conflict"])` à mão porque a régua canônica era privada. Ela deixou de ser — e este teste
 * impede a próxima cópia de entrar sem que ninguém veja.
 */
describe("nenhuma cópia hardcoded da lista de status vivos", () => {
  /**
   * VARRE O PACOTE INTEIRO, e essa é a lição: a primeira versão deste lint conferia uma LISTA FIXA de
   * quatro arquivos — os que eu conhecia. Passou verde com uma SEXTA cópia viva em `mcp/dev-tools.ts`
   * (chamada `LIVE`, mesma lista), que só apareceu num `git grep` depois do deploy. Um lint com escopo
   * enumerado à mão tem exatamente o defeito que ele existe para caçar: alguém precisa lembrar de
   * atualizá-lo. Escopo é o pacote; exceção é declarada aqui, com nome.
   */
  const IGNORAR = new Set([
    "src/lib/storymap/runner/merge-status.ts", // a régua canônica — é ELA
    "src/lib/storymap/runner/merge-status.test.ts", // este arquivo (o próprio padrão aparece aqui)
  ]);

  function arquivosTs(dir: string, raiz: string, out: string[] = []): string[] {
    for (const entrada of readdirSync(dir, { withFileTypes: true })) {
      const cheio = path.join(dir, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name === "node_modules" || entrada.name === ".next") continue;
        arquivosTs(cheio, raiz, out);
      } else if (/\.(ts|tsx)$/.test(entrada.name)) {
        out.push(path.relative(raiz, cheio).split(path.sep).join("/"));
      }
    }
    return out;
  }

  it("nenhum arquivo do pacote relista os status vivos à mão", () => {
    const raiz = path.resolve(__dirname, "../../../..");
    const culpados: string[] = [];
    for (const arquivo of arquivosTs(path.join(raiz, "src"), raiz)) {
      if (IGNORAR.has(arquivo)) continue;
      const src = readFileSync(path.join(raiz, arquivo), "utf8");
      // Uma lista literal contendo waiting + gate-running + merging é, por construção, uma segunda régua.
      // `[\s\S]` em vez da flag `s` — o alvo de compilação do pacote é anterior a es2018.
      if (/new Set[\s\S]{0,200}"waiting"[\s\S]{0,200}"gate-running"[\s\S]{0,200}"merging"/.test(src)) {
        culpados.push(arquivo);
      }
    }
    expect(culpados, `importe a régua de merge-status.ts em vez de relistar os status`).toEqual([]);
  });

  it("o próprio lint enxerga o pacote inteiro (senão ele dá garantia falsa)", () => {
    const raiz = path.resolve(__dirname, "../../../..");
    const vistos = arquivosTs(path.join(raiz, "src"), raiz);
    expect(vistos.length).toBeGreaterThan(200); // o pacote tem centenas de arquivos; 4 seria a lista antiga
    expect(vistos).toContain("src/lib/storymap/mcp/dev-tools.ts"); // o que escapou da lista enumerada
  });
});
