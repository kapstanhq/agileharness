import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseJunitReport, parseVitestFailures, parseVitestReport } from "./gate-reporters";

// Os três dialetos que o gate lê. A pergunta NOVA — "quantos testes rodaram?" — é a que separa um gate que
// mediu de um que não mediu: um verde com zero testes é um verde sem prova, e o gate só consegue recusá-lo
// se souber contar.

const FIX = path.join(__dirname, "__fixtures__", "gate-reporters");

describe("parseVitestReport — falhas E contagem executada", () => {
  const report = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      numTotalTests: 5,
      numPassedTests: 3,
      numFailedTests: 1,
      numPendingTests: 1,
      testResults: [
        {
          name: "/r/a.test.ts",
          status: "failed",
          assertionResults: [
            { fullName: "A > ok", status: "passed", failureMessages: [] },
            { fullName: "A > broken", status: "failed", failureMessages: ["AssertionError: nope\n  at x"] },
            { fullName: "A > skipped", status: "pending", failureMessages: [] },
          ],
        },
      ],
      ...over,
    });

  it("conta os EXECUTADOS pelos totais do relatório (passados + falhos; pulados não)", () => {
    const r = parseVitestReport(report());
    expect(r.parsed).toBe(true);
    expect(r.tests).toBe(4);
    expect(r.failures).toEqual([{ file: "/r/a.test.ts", name: "A > broken", message: "AssertionError: nope" }]);
  });

  it("sem os totais, conta os assertionResults passados/falhos", () => {
    const r = parseVitestReport(report({ numPassedTests: undefined, numFailedTests: undefined }));
    expect(r.tests).toBe(2);
  });

  it("zero testes selecionados (afetados vazio + --passWithNoTests) é um relatório LEGÍVEL com 0 — não um crash", () => {
    const r = parseVitestReport(JSON.stringify({ numPassedTests: 0, numFailedTests: 0, testResults: [] }));
    expect(r).toEqual({ parsed: true, failures: [], tests: 0 });
  });

  it("um ARQUIVO que falhou sem teste falho (import quebrado) vira falha ATRIBUÍVEL, não 'zero falhas'", () => {
    const r = parseVitestReport(
      JSON.stringify({
        testResults: [{ name: "/r/b.test.ts", status: "failed", message: "Error: Cannot find module './gone'\n at x", assertionResults: [] }],
      }),
    );
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].file).toBe("/r/b.test.ts");
    expect(r.failures[0].message).toBe("Error: Cannot find module './gone'");
  });

  it("stdout sem o objeto de relatório (crash/OOM, ou JSON qualquer impresso por um teste) NÃO é relatório", () => {
    expect(parseVitestReport("heap out of memory\nKilled")).toEqual({ parsed: false, failures: [], tests: null });
    expect(parseVitestReport(JSON.stringify({ hello: "world" })).parsed).toBe(false);
    expect(parseVitestReport("").parsed).toBe(false);
  });

  it("tolera uma linha solta em volta do objeto", () => {
    expect(parseVitestReport(`aviso qualquer\n${report()}\n`).tests).toBe(4);
  });

  it("parseVitestFailures continua sendo a vista só-de-falhas (a API histórica)", () => {
    expect(parseVitestFailures(report())).toHaveLength(1);
    expect(parseVitestFailures("lixo")).toEqual([]);
  });
});

describe("parseJunitReport — dialetos reais", () => {
  it("node --test --test-reporter=junit (saída REAL do node 22): `>` cru dentro do atributo não corta a tag", () => {
    const r = parseJunitReport(readFileSync(path.join(FIX, "node-test-junit.xml"), "utf8"));
    expect(r.parsed).toBe(true);
    // soma + quebra + filho ok executaram; "pulado" tem <skipped> e não conta
    expect(r.tests).toBe(3);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].name).toBe("quebra <x> & y");
    expect(r.failures[0].file).toBe("test");
    expect(r.failures[0].message).toBe("1 == 2");
  });

  it("pytest --junitxml: failure + skipped + identidade por classname", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="0" failures="1" skipped="1" tests="3" time="0.03"><testcase classname="tests.test_app" name="test_ok" time="0.001" /><testcase classname="tests.test_app" name="test_bad" time="0.001"><failure message="assert 1 == 2">def test_bad():
&gt;       assert 1 == 2
E       assert 1 == 2</failure></testcase><testcase classname="tests.test_app" name="test_skip" time="0.000"><skipped type="pytest.skip" message="nope">tests/test_app.py:7: nope</skipped></testcase></testsuite></testsuites>`;
    const r = parseJunitReport(xml);
    expect(r).toEqual({
      parsed: true,
      tests: 2,
      failures: [{ file: "tests.test_app", name: "test_bad", message: "assert 1 == 2" }],
    });
  });

  it("<error> conta como falha; com atributo `file`, o nome carrega o classname (identidade estável)", () => {
    const xml = `<testsuite><testcase file="svc/test_x.py" classname="svc.test_x.TestK" name="test_y"><error message="ImportError: z"/></testcase></testsuite>`;
    expect(parseJunitReport(xml).failures).toEqual([{ file: "svc/test_x.py", name: "svc.test_x.TestK > test_y", message: "ImportError: z" }]);
  });

  it("um <testcase> dentro de CDATA/comentário (saída impressa por um teste) não é um teste", () => {
    const xml = `<testsuite><testcase name="real"/><system-out><![CDATA[<testcase name="fake"><failure message="x"/></testcase>]]></system-out><!-- <testcase name="c"/> --></testsuite>`;
    expect(parseJunitReport(xml)).toEqual({ parsed: true, failures: [], tests: 1 });
  });

  it("um arquivo que não é JUnit NÃO vira 'zero falhas'", () => {
    expect(parseJunitReport("<html><body>oops</body></html>")).toEqual({ parsed: false, failures: [], tests: null });
    expect(parseJunitReport("").parsed).toBe(false);
  });

  it("suíte vazia é relatório legível com 0 executados", () => {
    expect(parseJunitReport(`<testsuites></testsuites>`)).toEqual({ parsed: true, failures: [], tests: 0 });
  });
});
