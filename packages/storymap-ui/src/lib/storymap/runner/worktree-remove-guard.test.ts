import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { assertRemovable } from "./worktree";
import { runnerStateDir } from "@/lib/storymap/paths";
import { SESSION_HEARTBEAT_TTL_MS } from "./session-liveness";

// O guard lê o registro do DISCO (é o que ele faz em produção), e o vitest.setup já redireciona
// runnerStateDir para um tmp por worker — então escrevemos o registro de verdade e exercitamos o
// caminho real de leitura, em vez de mockar a única coisa que precisa funcionar aqui.
const arquivo = () => path.join(runnerStateDir(), "sessions.json");

function gravaRegistro(rows: unknown[] | null) {
  mkdirSync(runnerStateDir(), { recursive: true });
  if (rows === null) {
    rmSync(arquivo(), { force: true });
    return;
  }
  writeFileSync(arquivo(), JSON.stringify({ version: 1, sessions: rows }), "utf8");
}

const viva = {
  sessionId: "vivinha",
  heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
  worktreePath: "/w/agent-vivinha",
  task: "editando o engine",
};

describe("assertRemovable — a árvore de uma sessão VIVA não se remove sem pedir", () => {
  beforeEach(() => gravaRegistro([viva]));

  it("RECUSA remover a árvore de uma sessão viva, dizendo quem é e o que fazia", () => {
    // O incidente que originou o guard: quatro árvores apagadas no meio da edição, uma delas com
    // trabalho não commitado, sem nenhum caminho identificável no log.
    expect(() => assertRemovable("agent/vivinha")).toThrow(/sessão VIVA vivinha/);
    expect(() => assertRemovable("agent/vivinha")).toThrow(/editando o engine/);
  });

  it("PERMITE quando o próprio agente pede (worktree_discard)", () => {
    expect(() => assertRemovable("agent/vivinha", "session-discard")).not.toThrow();
  });

  it("PERMITE branch de run — o guard é só para sessões", () => {
    expect(() => assertRemovable("run/qualquer")).not.toThrow();
  });

  it("PERMITE sessão desconhecida ou com heartbeat vencido (o lixo que o reaper colhe)", () => {
    expect(() => assertRemovable("agent/nunca-existiu")).not.toThrow();
    gravaRegistro([{ ...viva, heartbeatAt: new Date(Date.now() - SESSION_HEARTBEAT_TTL_MS - 1).toISOString() }]);
    expect(() => assertRemovable("agent/vivinha")).not.toThrow();
  });

  it("RECUSA quando o registro está ilegível — 'não sei' não é 'pode'", () => {
    // Fail-closed: sem conseguir PROVAR que está morta, não se apaga. O oposto disso já varreu
    // uma frota inteira quando uma falha de leitura virou "todo mundo morreu".
    gravaRegistro(null);
    expect(() => assertRemovable("agent/vivinha")).toThrow(/ILEGÍVEL/);
  });
});
