// O PORTÃO ÚNICO do board — a guarda de que ele continua único.
//
// Antes do ritmo do board (board-pace.ts), onze pontos do runner liam `config.autorunDisabled` cada um por conta
// própria. Quando a pausa nasceu, bastaria UM deles esquecer de perguntar pelo ritmo para um board pausado seguir
// gastando por aquela porta. Agora todos perguntam a `resolveBoardGate` (pela porta `boardGate` ou por `boardGateNow`),
// e este teste falha se um automático novo voltar a ler `autorunDisabled` direto.
//
// Quem PODE ler o campo: o próprio portão, e quem o PERSISTE ou o REPORTA (nunca quem decide se algo começa).

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../../..");

/** Onde ler `.autorunDisabled` é legítimo, e por quê. */
const ALLOWED: Record<string, string> = {
  "lib/storymap/runner/board-pace.ts": "o portão",
  "lib/storymap/repo.ts": "lê e persiste o board.yaml",
  "lib/storymap/board-registry.ts": "arma e desarma o board (o escritor do campo)",
  "lib/storymap/mcp/resources.ts": "reporta «armado» ao agente",
  "lib/storymap/mcp/tools.ts": "reporta «armado» na resposta de set_board_autorun",
};

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("o portão único do board", () => {
  const readers = sources(SRC)
    .filter((file) => /\.autorunDisabled\b/.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(SRC, file).split(path.sep).join("/"))
    .sort();

  it("nenhum automático lê `autorunDisabled` por conta própria — todos perguntam ao portão (board-pace.ts)", () => {
    const strays = readers.filter((f) => !(f in ALLOWED));
    expect(strays, `leem .autorunDisabled direto (use gateOf/boardGateNow de runner/board-pace*): ${strays.join(", ")}`).toEqual([]);
  });

  it("a lista de exceções não tem sobra (uma exceção que não lê mais o campo sai da lista)", () => {
    expect(Object.keys(ALLOWED).sort()).toEqual(readers);
  });

  it("cada automático do runner está ligado ao portão", () => {
    // os que decidem começar algo num board — a lista atual. Um novo entra aqui junto com a ligação dele.
    const WIRED = [
      "lib/notifications/server/channels/autorun-eval.ts", // a entrada de coluna (skills, efeitos de entrada)
      "lib/storymap/runner/engine.ts", // o pump dos runs
      "lib/storymap/runner/conductor.ts", // a fila e a adoção de órfãos do condutor
      "lib/storymap/runner/fleet-deps.ts", // os candidatos a órfão + a porta do condutor
      "lib/storymap/runner/proxy.ts", // o procurador
      "lib/storymap/runner/triage-judge.ts", // o juiz da triagem
      "lib/storymap/runner/technical-audit.ts", // o auditor (fundo)
      "lib/storymap/runner/deploy-proof-producer.ts", // o produtor das provas
      "lib/storymap/runner/stall-watch-deps.ts", // o vigia de card parado
      "lib/storymap/runner/card-budget-deps.ts", // o teto de gasto
      "lib/storymap/runner/orchestrator-run.ts", // o copiloto (fundo)
      "lib/storymap/runner/orchestrator-wake.ts", // o despertar do copiloto (fundo)
    ];
    for (const rel of WIRED) {
      const text = readFileSync(path.join(SRC, rel), "utf8");
      expect(/\b(gateOf|boardGateNow|paceAllowsBackground)\(/.test(text), `${rel} não consulta o portão do board`).toBe(true);
    }
  });

  // O SEGUNDO EIXO (escopo de tipos): perguntar ao portão do BOARD não basta — quem decide COMEÇAR trabalho para um card
  // também tem de perguntar «este card é admitido?» (`gateAdmitsCard`). Sem esta lista, um ponto novo (ou um existente
  // refatorado) esquece a pergunta e a funcionalidade nova volta a ser construída por aquela porta — o mesmo buraco que a
  // lista WIRED fechou para o `autorunDisabled`. Um ponto novo que lê o card e decide iniciar trabalho entra aqui.
  it("cada ponto que decide COMEÇAR trabalho para um card pergunta se o card é admitido pelo escopo de tipos", () => {
    const CARD_AWARE: Record<string, string> = {
      "lib/notifications/server/channels/autorun-eval.ts": "a entrada de coluna: a construção e o despacho do condutor",
      "lib/storymap/runner/conductor.ts": "a fila do condutor (pump) e a adoção de órfãos",
      "lib/storymap/runner/stall-watch-deps.ts": "o vigia de card parado: fora do escopo é parado DE PROPÓSITO (não abre card de conserto)",
      "lib/storymap/cockpit-collect.ts": "os itens acionáveis do copiloto: não enfileira nem move card de tipo fora do escopo",
      "lib/storymap/runner/board-pace-actions.ts": "estreitar tira da fila só o fora-do-escopo; alargar re-varre o que o escopo novo admite",
      "lib/storymap/runner/engine.ts": "o pump do engine: o job automático (inclusive o do agente escopado) de card fora do escopo espera na fila",
      "lib/storymap/runner/recovery.ts": "a recuperação de boot/varredura: retomar ou re-disparar um run é «começar» para o card fora do escopo",
    };
    for (const rel of Object.keys(CARD_AWARE)) {
      const text = readFileSync(path.join(SRC, rel), "utf8");
      expect(/\b(gateAdmitsCard|scopeAdmitsCard)\(/.test(text), `${rel} (${CARD_AWARE[rel]}) não pergunta gateAdmitsCard(gate, card) — o escopo de tipos passaria por ele`).toBe(true);
    }
  });

  // A CATRACA DO TIPO (R6): com o escopo limitando o board, o tipo do card é o que decide o que ele pode ser. Dois pontos
  // gravam `storyType` por ordem de quem chama — a tool `update_card` (o agente) e a ação de servidor (a tela) — e os dois
  // têm de passar pela régua única de board-pace.ts: recusar a troca de um `user` já classificado por um agente
  // (`storyTypeChangeRefusal`) e deixar a linha de auditoria com antes/depois/autor (`storyTypeChangeLine`). Esquecer isto
  // num ponto novo reabre o atalho «reclassifico a funcionalidade como manutenção e ela passa».
  it("quem grava o tipo de um card passa pela catraca do tipo (recusa do agente + trilha de auditoria)", () => {
    const TYPE_WRITERS: Record<string, string> = {
      "lib/storymap/mcp/tools.ts": "update_card: o agente que troca o tipo",
      "app/actions.ts": "a ação de servidor que a tela e o enriquecer usam para trocar o tipo",
    };
    for (const rel of Object.keys(TYPE_WRITERS)) {
      const text = readFileSync(path.join(SRC, rel), "utf8");
      expect(/\bstoryTypeChangeRefusal\(/.test(text) || /\bstoryTypeChangeLine\(/.test(text), `${rel} (${TYPE_WRITERS[rel]}) não consulta storyTypeChangeRefusal/storyTypeChangeLine de board-pace.ts`).toBe(true);
    }
    // e a recusa do AGENTE mora na tool (a tela é do dono: só audita)
    expect(/\bstoryTypeChangeRefusal\(/.test(readFileSync(path.join(SRC, "lib/storymap/mcp/tools.ts"), "utf8")), "update_card não recusa a troca de tipo do agente").toBe(true);
  });

  it("a pergunta por card não é reimplementada por fora: ninguém compara o tipo do card com o escopo por conta própria", () => {
    // `gate.scope.types` / `gate.scope?.types` (o escopo do PORTÃO; a `view.scope.types` das telas e da tool é outra coisa) lidos fora do portão e das telas = uma segunda régua que diverge (tipo efetivo, coluna, uso)
    const OWNERS = ["lib/storymap/runner/board-pace.ts", "lib/storymap/board-pace-words.ts", "lib/storymap/runner/board-pace-actions.ts"];
    const strays = sources(SRC)
      .map((file) => path.relative(SRC, file).split(path.sep).join("/"))
      .filter((rel) => !OWNERS.includes(rel) && !rel.startsWith("components/") && !rel.startsWith("app/"))
      .filter((rel) => /\b\w*[gG]ate\w*\??\.scope\??\.types\b/.test(readFileSync(path.join(SRC, rel), "utf8")));
    expect(strays, `leem o escopo de tipos direto (use gateAdmitsCard): ${strays.join(", ")}`).toEqual([]);
  });

  it("as portas de produção dos núcleos com DI recebem o portão de verdade", () => {
    for (const rel of ["proxy-deps.ts", "triage-judge-deps.ts", "technical-audit-deps.ts", "deploy-proof-deps.ts", "fleet-deps.ts"]) {
      const text = readFileSync(path.join(SRC, "lib/storymap/runner", rel), "utf8");
      expect(text.includes("boardGate: boardGateNow"), `${rel} não injeta boardGateNow`).toBe(true);
    }
  });
});
