// «Ver status»/«Ver log» de um card de board de PRODUTO mostrava o
// `self-deploy.log` do host (o build da própria ferramenta), num modal «Log da falha de deploy» — quando
// nada tinha falhado: o deploy do board era outro job, com outro log. Aqui: o status
// da publicação DESTE card — o veredito primeiro (no ar com o commit dele: sim / não / não medido), depois o log
// do deploy DO BOARD (o job do registry ou o arquivo do alvo).

import { describe, expect, it } from "vitest";
import { publishLogTargets, publishVerdict, readPublishStatus, type PublishStatusDeps } from "./publish-status";
import { coerceCard } from "@/lib/storymap/repo";
import type { BoardConfig, Card } from "@/lib/storymap/types";

const cfg = (over: Partial<BoardConfig> = {}): BoardConfig =>
  ({ id: "prod", name: "Produto", statuses: [{ id: "deploy", name: "Publicar", onEnter: "promote-and-deploy" }], ...over }) as BoardConfig;
const card = (over: Partial<Card> = {}): Card => ({ ...coerceCard("story-x", { type: "story", status: "deploy" }, ""), ...over });

describe("publishLogTargets — o log é o do deploy DESTE board, nunca o da ferramenta por padrão", () => {
  it("o card carrega os alvos do disparo ⇒ eles", () => {
    expect(publishLogTargets(card({ deployTargets: ["api", "face"] }), cfg(), ["api"])).toEqual({ kind: "registry", targets: ["api", "face"] });
  });

  it("sem alvos no card: o deploy declarado do board (chave = id do board), ou o pacote entre os alvos declarados", () => {
    expect(publishLogTargets(card(), cfg({ deploy: { kind: "command", command: "x" } } as Partial<BoardConfig>), [])).toEqual({ kind: "registry", targets: ["prod"] });
    expect(publishLogTargets(card(), cfg({ package: "packages/api" }), ["api"])).toEqual({ kind: "registry", targets: ["api"] });
  });

  it("só o board DA FERRAMENTA lê o self-deploy.log; um board sem alvo não tem log de deploy", () => {
    expect(publishLogTargets(card(), cfg({ package: "packages/storymap-ui" }), [])).toEqual({ kind: "self" });
    expect(publishLogTargets(card(), cfg({ package: "packages/lib" }), ["api"])).toEqual({ kind: "none" });
  });
});

describe("publishVerdict — no ar com o commit deste card: sim / não / não medido", () => {
  it("prova carimbada, ou medida agora ⇒ sim", () => {
    expect(publishVerdict(card({ deployProof: { sha: "abcdef1234", targets: ["api"], at: "2026-03-05T10:30:00Z", source: "settle-webhook" } }), null)).toMatchObject({ state: "live" });
    expect(publishVerdict(card(), { proven: true, sha: "abcdef1234", targets: ["api"] })).toMatchObject({ state: "live" });
  });

  it("o que está no ar é ANTERIOR ao código deste card ⇒ não", () => {
    expect(publishVerdict(card(), { proven: false, reason: "deploy-anterior-ao-codigo" })).toMatchObject({ state: "not-live" });
  });

  it("sem de onde medir ⇒ não medido, dizendo por quê em português", () => {
    const v = publishVerdict(card(), { proven: false, reason: "codigo-sem-release" });
    expect(v.state).toBe("not-measured");
    expect(v.text).toMatch(/release/);
    expect(v.text).not.toMatch(/codigo-sem-release/);
  });
});

describe("readPublishStatus — o modal lê o log do job do board", () => {
  const deps = (over: Partial<PublishStatusDeps> = {}): PublishStatusDeps => ({
    readCard: async () => card({ deployTargets: ["api"], deployFiredAt: "2026-03-05T10:27:46.000Z" }),
    readConfig: async () => cfg({ package: "packages/api" }),
    productTargets: () => ["api"],
    jobOf: (t) => (t === "api" ? { logFile: "/logs/mcp-deploy-api.log", status: "done", startedAt: 1, finishedAt: 2, exitCode: 0 } : undefined),
    logFileFor: (t) => `/logs/mcp-deploy-${t}.log`,
    selfDeployLog: () => "/runner/self-deploy.log",
    readTail: async (p) => (p === "/logs/mcp-deploy-api.log" ? "[deploy api] finished exit 0" : null),
    measure: async () => ({ proven: false, reason: "codigo-sem-release" }),
    ...over,
  });

  it("card de produto ⇒ o log do job do registry daquele alvo — nunca o self-deploy.log", async () => {
    const s = await readPublishStatus("prod", "story-x", deps());
    expect(s?.logs).toEqual([
      { target: "api", path: "/logs/mcp-deploy-api.log", tail: "[deploy api] finished exit 0", job: { status: "done", startedAt: 1, finishedAt: 2, exitCode: 0 } },
    ]);
    expect(JSON.stringify(s)).not.toContain("self-deploy");
    expect(s?.verdict.state).toBe("not-measured");
  });

  it("sem job na memória (depois de um restart) ⇒ o arquivo de log do alvo", async () => {
    const s = await readPublishStatus("prod", "story-x", deps({ jobOf: () => undefined, readTail: async (p) => (p === "/logs/mcp-deploy-api.log" ? "antigo" : null) }));
    expect(s?.logs[0]).toMatchObject({ target: "api", path: "/logs/mcp-deploy-api.log", tail: "antigo" });
  });
});
