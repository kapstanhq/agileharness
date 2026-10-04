// O deploy declarado que diz «precisa de você». O comando de deploy de um board
// (`deploy.kind: command`) saiu com 3 — «há unidade que só um humano publica, nada foi publicado» — e o Inbox
// mostrou «Deploy de produção falhou — reentrar no Deploy (pode ser causa externa)». Nada falhou: o comando
// fez exatamente o que devia e disse ao dono o que publicar à mão. Estes testes fixam o contrato (a saída 3 do
// comando declarado) e a leitura do que o comando imprimiu (as unidades e a receita).

import { describe, expect, it } from "vitest";
import { DEPLOY_NEEDS_HUMAN_EXIT, isDeployNeedsHuman, parseNeedsHumanReport, settleFailureDetail } from "./deploy-needs-human";
import type { DeployDoneEvent } from "./product-deploy";
import { parseDeployExit3Report } from "./deploy-proof";

const ev = (o: Partial<DeployDoneEvent>): DeployDoneEvent => ({
  pkg: "acme",
  ok: false,
  exitCode: 1,
  board: "acme",
  cardId: "s1",
  durationMs: 40_000,
  ...o,
});

// Um log (inventado) de um deploy declarado que pediu humano: o recado em PT-BR (stderr) e a linha JSON (stdout), entre
// as linhas de moldura que o próprio lançador escreve.
const LOG = [
  "[deploy acme] $ './publish.sh' 'acme' '--auto'",
  "parado: duas unidades esperam a sua mão, nada subiu.",
  "  - push-gateway (3 arquivos) → `./publish.sh acme --only push-gateway`",
  "  - report-cron (1 arquivo) → `./publish.sh acme --only report-cron`",
  "  Depois disso a fila volta a andar sem você.",
  JSON.stringify({
    package: "acme",
    exitCode: 3,
    status: "needs-human",
    plan: {
      status: "needs-human",
      human: [
        { unit: "push-gateway", file: "acme/gateway/send.go", rule: "unit-operator-only", why: null },
        { unit: "report-cron", file: "acme/cron/weekly.go", rule: "unit-operator-only", why: null },
        { unit: "push-gateway", file: "acme/gateway/queue.go", rule: "unit-operator-only", why: null },
        { unit: "schema", file: null, rule: "schema-diff-unknown", why: "cliente do banco ausente" },
      ],
    },
  }),
  "",
  "[deploy acme] finished exit 3",
  "",
].join("\n");

describe("isDeployNeedsHuman — a saída 3 do deploy DECLARADO é «precisa de você», não falha", () => {
  it("comando declarado que sai com 3 ⇒ precisa de humano", () => {
    expect(DEPLOY_NEEDS_HUMAN_EXIT).toBe(3);
    expect(isDeployNeedsHuman(ev({ exitCode: 3, declaredKind: "command" }))).toBe(true);
  });

  it("qualquer outra coisa segue falha: outro código, agente, comando legado declarado, sucesso", () => {
    expect(isDeployNeedsHuman(ev({ exitCode: 1, declaredKind: "command" }))).toBe(false);
    expect(isDeployNeedsHuman(ev({ exitCode: 4, declaredKind: "command" }))).toBe(false);
    expect(isDeployNeedsHuman(ev({ exitCode: 3, declaredKind: "agent" }))).toBe(false); // o contrato é do comando
    expect(isDeployNeedsHuman(ev({ exitCode: 3 }))).toBe(false); // comando legado: 3 não tem esse sentido
    expect(isDeployNeedsHuman(ev({ ok: true, exitCode: 0, declaredKind: "command" }))).toBe(false);
  });
});

describe("parseNeedsHumanReport — o que o comando disse, lido do log do deploy", () => {
  it("unidades do JSON (em `human` ou `plan.human`), sem repetição, na ordem; o recado são as linhas do comando", () => {
    const r = parseNeedsHumanReport(LOG);
    expect(r.units).toEqual(["push-gateway", "report-cron", "schema"]);
    expect(r.message).toContain("nada subiu");
    expect(r.message).toContain("./publish.sh acme --only push-gateway");
    // nem a moldura do lançador nem a linha JSON entram no recado
    expect(r.message).not.toContain("[deploy acme]");
    expect(r.message).not.toContain('"status"');
  });

  it("`human` no topo do JSON também vale (o contrato não exige o `plan` de um alvo específico)", () => {
    const log = `${JSON.stringify({ status: "needs-human", human: [{ unit: "web" }, "api"] })}\n`;
    expect(parseNeedsHumanReport(log).units).toEqual(["web", "api"]);
  });

  it("sem JSON (comando que só imprime texto) ⇒ sem unidades, mas o recado vem", () => {
    const r = parseNeedsHumanReport("[deploy app] $ ./publish\nrode a migração do banco antes: ./tools/migrate\n[deploy app] finished exit 3\n");
    expect(r.units).toEqual([]);
    expect(r.message).toBe("rode a migração do banco antes: ./tools/migrate");
  });

  it("JSON de outro status não inventa unidades; log vazio ou ilegível ⇒ nada, nunca lança", () => {
    expect(parseNeedsHumanReport(`${JSON.stringify({ status: "refused", human: [{ unit: "x" }] })}\n`).units).toEqual([]);
    expect(parseNeedsHumanReport("")).toEqual({ units: [], message: null });
    expect(parseNeedsHumanReport("{nao é json\n").message).toBe("{nao é json");
  });

  it("o recado é o FIM da saída, com teto de linhas", () => {
    const many = Array.from({ length: 40 }, (_, i) => `linha ${i + 1}`).join("\n");
    const r = parseNeedsHumanReport(many);
    expect(r.message?.split("\n").length).toBeLessThanOrEqual(12);
    expect(r.message).toContain("linha 40");
    expect(r.message).not.toContain("linha 1\n");
  });
});

describe("settleFailureDetail — o settle que falhou vira o detalhe certo para o revert", () => {
  it("a saída 3 leva o RELATÓRIO inteiro ao revert (é lá, com a config, que se decide dono × sistema); o alvo que já diz needs-units chega assim", () => {
    const d = settleFailureDetail(ev({ exitCode: 3, declaredKind: "command" }), { exit3: parseDeployExit3Report(LOG) });
    expect(d.phase).toBe("needs-human"); // provisória — o revert a corrige pela régua
    expect(d.plan?.entries.map((e) => e.rule)).toEqual(["unit-operator-only", "unit-operator-only", "unit-operator-only", "schema-diff-unknown"]);
    const units = settleFailureDetail(ev({ exitCode: 3, declaredKind: "command" }), { exit3: { ...parseDeployExit3Report(LOG), status: "needs-units" } });
    expect(units.phase).toBe("needs-units");
    // sem JSON legível: fica do dono (fail-closed), sem relatório
    const blind = settleFailureDetail(ev({ exitCode: 3, declaredKind: "command" }), { exit3: parseDeployExit3Report("") });
    expect(blind).toMatchObject({ phase: "needs-human" });
    expect(blind.plan).toBeUndefined();
  });

  it("saída 3 do comando declarado ⇒ fase needs-human, com as unidades e o recado", () => {
    const d = settleFailureDetail(ev({ exitCode: 3, declaredKind: "command" }), { needsHuman: parseNeedsHumanReport(LOG) });
    expect(d.phase).toBe("needs-human");
    expect(d.units).toEqual(["push-gateway", "report-cron", "schema"]);
    expect(d.commandSays).toContain("./publish.sh acme --only push-gateway");
    expect(d.exitCode).toBe(3);
  });

  it("falha comum segue `deploy`, no-op segue `deploy-noop` (nada muda para quem não é o caso 3)", () => {
    expect(settleFailureDetail(ev({ exitCode: 1, declaredKind: "command" })).phase).toBe("deploy");
    expect(settleFailureDetail(ev({ ok: true, exitCode: 0 })).phase).toBe("deploy-noop");
    expect(settleFailureDetail(ev({ exitCode: 1 }), { faceReason: "app#typecheck: TS2307" }).reason).toBe("app#typecheck: TS2307");
  });
});
