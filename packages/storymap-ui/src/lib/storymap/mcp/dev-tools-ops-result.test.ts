import { describe, it, expect } from "vitest";
import { opsHealthResult, queryErrorsResult, stripAnsi } from "./dev-tools";

// O script de relatório declarado sai NÃO-ZERO quando a saúde falha e devolve `{ok:false,error}` (exit 2) quando a
// consulta de erros falha. Antes, `ops_health` devolvia o texto colorido cru (ignorando o exit) e `query_errors`
// punha `{ok:false}` debaixo de `errors`, uma chave que sempre foi lista. Uma falha nunca pode chegar como verde.

const textOf = (r: { content: unknown[] }): string => String((r.content[0] as { text?: string }).text);
const body = (r: { content: unknown[] }) => JSON.parse(textOf(r));

describe("ops_health — --health --json estruturado", () => {
  const health = {
    adcActive: true,
    window: "1h",
    ok: true,
    services: { loja: { recentErrors: 0, capped: false }, unmapped: { recentErrors: 0, capped: false } },
  };

  it("exit 0 com JSON ⇒ {exitCode, health}, sem isError", () => {
    const r = opsHealthResult({ code: 0, stdout: JSON.stringify(health), stderr: "" });
    expect(r.isError).toBeFalsy();
    expect(body(r)).toEqual({ exitCode: 0, health });
  });

  it("exit não-zero ⇒ falha, com os campos de diagnóstico preservados (queryFailed)", () => {
    const sick = { ...health, ok: false, services: { loja: { recentErrors: null, queryFailed: true, error: "gcloud falhou" } } };
    const r = opsHealthResult({ code: 1, stdout: JSON.stringify(sick), stderr: "" });
    expect(r.isError).toBe(true);
    expect(body(r).health.services.loja).toEqual({ recentErrors: null, queryFailed: true, error: "gcloud falhou" });
  });

  it("health.ok false mesmo com exit 0 ⇒ falha", () => {
    expect(opsHealthResult({ code: 0, stdout: JSON.stringify({ ...health, ok: false }), stderr: "" }).isError).toBe(true);
  });

  it("sem JSON: o texto volta SEM códigos de cor, e exit não-zero é falha", () => {
    const colored = "\u001b[31mADC inativo\u001b[0m\n\u001b[1mloja\u001b[22m: ?";
    const bad = opsHealthResult({ code: 1, stdout: colored, stderr: "" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("ADC inativo\nloja: ?");
    expect(textOf(bad)).not.toContain("\u001b");
    const okText = opsHealthResult({ code: 0, stdout: colored, stderr: "" });
    expect(okText.isError).toBeFalsy();
    expect(textOf(okText)).toBe("ADC inativo\nloja: ?");
  });
});

describe("query_errors — o formato {ok:false,error} passa adiante, nunca como lista", () => {
  it("lista ⇒ {exitCode, ok:true, errors}", () => {
    const r = queryErrorsResult({ code: 0, stdout: JSON.stringify([{ message: "boom" }]), stderr: "" });
    expect(r.isError).toBeFalsy();
    expect(body(r)).toEqual({ exitCode: 0, ok: true, errors: [{ message: "boom" }] });
  });

  it("{ok:false,error} com exit 2 ⇒ {exitCode, ok:false, error} com isError, sem chave errors", () => {
    const r = queryErrorsResult({ code: 2, stdout: JSON.stringify({ ok: false, error: "gcloud logging read failed: x" }, null, 2), stderr: "" });
    expect(r.isError).toBe(true);
    const b = body(r);
    expect(b).toEqual({ exitCode: 2, ok: false, error: "gcloud logging read failed: x" });
    expect(b).not.toHaveProperty("errors");
  });

  it("saída sem JSON com exit não-zero ⇒ falha, sem cor", () => {
    const r = queryErrorsResult({ code: 1, stdout: "", stderr: "\u001b[31mUnknown service\u001b[0m" });
    expect(r.isError).toBe(true);
    expect(body(r)).toEqual({ exitCode: 1, output: "Unknown service" });
  });
});

describe("stripAnsi", () => {
  it("tira CSI e OSC, mantém o texto", () => {
    expect(stripAnsi("\u001b[1;32mok\u001b[0m \u001b]8;;http://x\u0007link\u001b]8;;\u0007")).toBe("ok link");
  });
});
