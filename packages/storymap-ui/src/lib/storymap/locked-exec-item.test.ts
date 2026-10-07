import { describe, expect, it } from "vitest";
import { lockedExecItem } from "./locked-exec-item";
import { decideItem } from "./inbox/decision";
import { ctx, HUMAN, ULTRA, mkCard } from "./inbox/items.fixture";
import { lockedExecAlert } from "./runner/locked-exec-notify";
import type { LockedExecRecord } from "./runner/locked-exec";

// O item do Inbox de um pedido de execução aprovada, em cada estado: o que o dono vê, o que pode fazer e o que o celular
// recebe. Fixtures INVENTADAS (o cofre de chaves de um ateliê fictício).

const NOW = Date.UTC(2026, 3, 1, 12);
const rec = (over: Partial<LockedExecRecord> = {}): LockedExecRecord => ({
  v: 1,
  id: "lx-00000000b2",
  board: "b1",
  cardId: "c1",
  summary: "Troca a chave de API do cofre por uma nova e guarda a anterior por um ciclo.",
  why: null,
  argv: ["cofre-cli", "rotate", "--key=api nova"],
  undoArgv: ["cofre-cli", "rollback", "--key=api nova"],
  noUndoPlan: null,
  preflight: [],
  verify: [{ label: "a chave nova está ativa", argv: ["cofre-cli", "verifica"], expectStdoutIncludes: "ativa" }],
  timeoutSec: 300,
  cwd: "/srv/alvo",
  programs: { main: "/opt/cofre/bin/cofre-cli", undo: "/opt/cofre/bin/cofre-cli", preflight: [], verify: ["/opt/cofre/bin/cofre-cli"] },
  hash: "b".repeat(64),
  classification: { rule: "vault-access" },
  proposedBy: "mcp:write(TESTE)",
  proposedAt: "2026-04-01T11:00:00Z",
  status: "pending",
  results: [],
  ...over,
});
const card = { title: "Chave de API do cofre", status: "desenvolver" };
const decide = (r: LockedExecRecord, config = HUMAN) => decideItem(lockedExecItem(r, card)!, ctx(config, mkCard({ status: "desenvolver" }), NOW));

describe("lockedExecItem", () => {
  it("o comando aparece EXATO e citado (o que a trava julgou e o servidor roda)", () => {
    const item = lockedExecItem(rec(), card)!;
    expect(item.command).toBe("cofre-cli rotate '--key=api nova'");
    expect(item.undoCommand).toBe("cofre-cli rollback '--key=api nova'");
    expect(item).toMatchObject({ kind: "locked-exec", id: "lx:lx-00000000b2", lane: "aprovar", cardTitle: "Chave de API do cofre", hash: "b".repeat(64) });
  });
  it("o que o dono arquivou (ou manteve) sai do Inbox", () => {
    expect(lockedExecItem(rec({ status: "kept" }), card)).toBeNull();
    expect(lockedExecItem(rec({ status: "failed", ackedAt: "2026-04-01T12:00:00Z" }), card)).toBeNull();
  });
});

describe("a decisão no Inbox, por estado", () => {
  // fase 3 — um clique: sem diálogo; o que roda (o bloco estruturado) está no item, ANTES das palavras do agente
  it("pendente: Decidir em QUALQUER modo; aprovar leva o hash, e o item mostra o comando, o desfazer e as conferências", () => {
    for (const config of [HUMAN, ULTRA]) {
      const d = decide(rec(), config);
      expect(d.bucket).toBe("decidir");
      const approve = d.options.find((o) => o.id === "approve")!;
      expect(approve.invoke).toEqual({ kind: "approve-locked-exec", boardId: "b1", id: "lx-00000000b2", hash: "b".repeat(64) });
      const body = d.details.map((x) => `${x.label}: ${x.value}`);
      expect(body[0]).toBe("Programa: /opt/cofre/bin/cofre-cli");
      expect(body).toContain("Comando: cofre-cli rotate '--key=api nova'");
      expect(body.some((l) => l.startsWith("Desfazer: cofre-cli rollback"))).toBe(true);
      expect(body).toContain("Confere depois: a chave nova está ativa: cofre-cli verifica — passa se terminar com código 0 e a saída contiver “ativa”");
      // o bloco estruturado vem ANTES das palavras do agente, que entram rotuladas
      const agent = body.findIndex((l) => l.startsWith("Explicação do agente:"));
      expect(agent).toBeGreaterThan(body.findIndex((l) => l.startsWith("Confere depois:")));
      expect(approve.consequence).toMatch(/O que roda exatamente está acima/);
      expect(d.options.map((o) => o.id)).toEqual(["approve", "reject"]);
    }
  });
  // story-ex9603 (acabamento): a explicação do agente só aparece DEPOIS do bloco do que roda — nunca no «O que aconteceu»
  // nem no título.
  it("o texto do agente nunca entra no «O que aconteceu» nem no título — em estado nenhum", () => {
    const summary = rec().summary;
    for (const status of ["pending", "approved", "running", "done", "failed", "undone", "stale", "expired", "rejected"] as const) {
      const d = decide(rec({ status, error: "x", autoUndone: status === "undone" }));
      expect(d.happened, status).not.toContain(summary);
      expect(d.ask, status).not.toContain(summary);
    }
  });
  it("quem pediu: a sessão pelo nome que ela declarou, ou «uma sessão de trabalho» — nunca o uuid cru; no meio da frase, minúscula", () => {
    const uuid = "00000000-0000-4000-8000-0000000000a1";
    const anon = decide(rec({ proposedBy: `session:${uuid}` }));
    expect(anon.ask).toContain("Rodar o comando que uma sessão de trabalho pede");
    expect(`${anon.ask} ${anon.happened}`).not.toContain(uuid);
    expect(decide(rec({ proposedBy: "session:trocar a chave da API" })).ask).toContain("que uma sessão de agente (trocar a chave da API) pede");
    expect(decide(rec({ proposedBy: "conductor:c1" })).ask).toContain("que o condutor do card c1 pede");
  });
  it("pendente SEM desfazer: o botão diz que não há volta, e o item traz o plano B", () => {
    const d = decide(rec({ undoArgv: null, noUndoPlan: "Voltar à chave anterior pelo painel do cofre, com o operador." }));
    const approve = d.options.find((o) => o.id === "approve")!;
    expect(approve.label).toMatch(/sem desfazer/);
    expect(approve.tone).toBe("danger");
    expect(d.details.find((x) => x.label === "Sem desfazer — plano B")?.value).toMatch(/^Voltar à chave anterior pelo painel/);
  });
  it("rodando: Acompanhar, sem botão", () => {
    const d = decide(rec({ status: "running" }));
    expect(d.bucket).toBe("acompanhar");
    expect(d.options).toEqual([]);
  });
  it("deu certo: Manter (principal) e Desfazer, que diz o comando que roda", () => {
    const d = decide(rec({ status: "done" }));
    expect(d.options.map((o) => o.id)).toEqual(["keep", "undo"]);
    expect(d.options[1].consequence).toContain("cofre-cli rollback");
    expect(decide(rec({ status: "done", undoArgv: null, noUndoPlan: "Voltar à chave anterior pelo painel do cofre." })).options.map((o) => o.id)).toEqual(["keep"]);
  });
  it.each(["failed", "undone", "stale", "expired", "rejected"] as const)("%s: só «Ok» (arquiva), com o motivo", (status) => {
    const d = decide(rec({ status, error: "a conferência falhou", autoUndone: status === "undone" }));
    expect(d.bucket).toBe("acompanhar");
    expect(d.options.map((o) => o.id)).toEqual(["ack"]);
  });
});

describe("o aviso no celular — só quando deu errado", () => {
  it.each(["failed", "undone", "stale", "expired"] as const)("%s avisa", (status) => {
    const a = lockedExecAlert(rec({ status, autoUndone: status === "undone" }), NOW)!;
    expect(a).toMatchObject({ kind: "locked-exec", event: "locked-exec-failed", url: "/board/b1/inbox", tag: "locked-exec-lx-00000000b2" });
  });
  it.each(["pending", "approved", "running", "done", "rejected", "kept"] as const)("%s não avisa", (status) => {
    expect(lockedExecAlert(rec({ status }), NOW)).toBeNull();
  });
});
