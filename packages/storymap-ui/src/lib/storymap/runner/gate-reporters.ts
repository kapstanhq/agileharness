// gate-reporters — como o gate LÊ uma suíte: quais testes falharam e QUANTOS rodaram.
//
// O gate só sabia ler um dialeto (o JSON do vitest) e respondia uma pergunta só ("quais falharam?"). A
// segunda pergunta — "quantos testes RODARAM?" — nunca foi feita, e é exatamente a que distingue um gate
// que mediu de um que não mediu nada: no alvo de referência as entradas integravam em ~20–50 s com ZERO
// testes do produto executados, e o log dizia «✓ suíte verde». Um verde sem contagem é um verde sem prova.
//
// Três reporters, e cada um responde o que CONSEGUE responder — nunca mais do que isso:
//   · `vitest-json` — o gate anexa `--reporter=json`; falhas por teste + contagem executada.
//   · `junit-xml`   — o comando grava um arquivo (pytest `--junitxml`, `node --test --test-reporter=junit`,
//                     jest-junit…); falhas por `<testcase>` + contagem executada.
//   · `exit-code`   — só o status de saída. NÃO sabe contar nem identificar falhas: a contagem é `null`
//                     (desconhecida — nunca 0, que seria uma afirmação) e a atribuição é por UNIDADE.
//
// PURO: parse de string. Quem lê arquivo/roda comando é o runner (merge-queue.ts).

/** Um teste que o relatório diz ter falhado: arquivo, nome completo e a primeira linha da mensagem. */
export interface GateFailure {
  file: string;
  name: string;
  message: string;
}

/** O que um relatório conseguiu dizer. `parsed:false` ⇒ não havia relatório legível (crash/OOM/caminho errado). */
export interface ParsedReport {
  parsed: boolean;
  failures: GateFailure[];
  /** testes EXECUTADOS (passados + falhos; pulados/todo não contam). `null` ⇒ o relatório não diz. */
  tests: number | null;
}

/** Extrai o objeto JSON do stdout do vitest, tolerando linhas soltas em volta. `null` se não houver. */
function jsonObjectOf(stdout: string): Record<string, unknown> | null {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(stdout.trim());
  if (direct) return direct;
  const m = stdout.match(/\{[\s\S]*\}/); // vitest pode imprimir uma linha solta antes/depois do objeto
  return m ? tryParse(m[0]) : null;
}

/**
 * Relatório `vitest --reporter=json` → falhas + contagem. `parsed` exige o array `testResults` — é o que
 * diferencia o relatório de um JSON qualquer que o teste tenha impresso. A contagem prefere os totais do
 * relatório (`numPassedTests + numFailedTests`) e cai na contagem dos `assertionResults` quando eles faltam.
 * PURA.
 */
export function parseVitestReport(stdout: string): ParsedReport {
  const json = jsonObjectOf(stdout);
  const results = json?.testResults;
  if (!json || !Array.isArray(results)) return { parsed: false, failures: [], tests: null };
  const failures: GateFailure[] = [];
  let counted = 0;
  for (const tr of results) {
    const file = String((tr as { name?: unknown })?.name ?? "");
    const ars = (tr as { assertionResults?: unknown })?.assertionResults;
    const arr = Array.isArray(ars) ? ars : [];
    // Um ARQUIVO de teste que falhou sem nenhum teste falho dentro — erro de import/sintaxe, hook de
    // suíte que explodiu — é uma falha de verdade, e ATRIBUÍVEL (ela existe ou não na base). Sem isto o
    // relatório dizia "zero falhas" com exit≠0 e o gate lia crash: INCONCLUSIVO para um delta que quebrou
    // um import, retry, e só então parqueado com o motivo errado.
    if ((tr as { status?: unknown })?.status === "failed" && !arr.some((a) => (a as { status?: unknown })?.status === "failed")) {
      failures.push({
        file,
        name: "(o arquivo de teste falhou sem teste falho — import/sintaxe/hook)",
        message: String((tr as { message?: unknown })?.message ?? "").split("\n")[0],
      });
    }
    for (const a of arr) {
      const ar = a as { status?: unknown; fullName?: unknown; title?: unknown; failureMessages?: unknown };
      if (ar?.status === "passed" || ar?.status === "failed") counted++;
      if (ar?.status !== "failed") continue;
      const msgs = Array.isArray(ar.failureMessages) ? ar.failureMessages : [];
      failures.push({
        file,
        name: String(ar.fullName || ar.title || "?"),
        message: String(msgs[0] ?? "").split("\n")[0],
      });
    }
  }
  const passed = json.numPassedTests;
  const failed = json.numFailedTests;
  const tests =
    typeof passed === "number" && typeof failed === "number" && Number.isFinite(passed + failed) ? passed + failed : counted;
  return { parsed: true, failures, tests };
}

/**
 * Parse vitest `--reporter=json` stdout into the FAILED tests. TOLERANT: returns `[]` when there is no
 * parseable JSON (a crash/OOM before the reporter wrote) so the caller blocks safely instead of passing.
 * Kept as the historical entry point (merge-queue re-exports it). PURE.
 */
export function parseVitestFailures(stdout: string): GateFailure[] {
  return parseVitestReport(stdout).failures;
}

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
/** O miolo de uma tag de abertura: qualquer coisa fora de aspas que não feche a tag, ou um valor entre aspas. */
const ATTRS = `(?:[^>"']|"[^"]*"|'[^']*')*?`;

/** Decodifica as entidades XML de um valor de atributo/texto. PURA. */
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[ent.toLowerCase()] ?? whole;
  });
}

/** Os atributos de uma tag de abertura (`name="…"`, também com aspas simples). PURA. */
function attrsOf(openTag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of openTag.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1]] = decodeXml(m[2] ?? m[3] ?? "");
  }
  return out;
}

/**
 * Relatório JUnit XML → falhas + contagem. Tolerante aos dialetos que importam (pytest `--junitxml`,
 * `node --test --test-reporter=junit`, jest-junit, surefire): cada `<testcase>` é um teste; um filho
 * `<failure>` ou `<error>` o torna falho; `<skipped>` o tira da contagem executada. A IDENTIDADE de um teste
 * (o que a atribuição compara entre a árvore mesclada e a base) é `file` (ou `classname`) + `classname > name`
 * — estável entre as duas rodadas porque a árvore é a mesma e os caminhos são relativos a ela.
 *
 * `parsed` exige uma raiz `<testsuite>`/`<testsuites>`: um arquivo que não é JUnit não vira "zero falhas".
 * Parser por varredura (sem dependência de XML): o formato é raso e o que se extrai são atributos. PURA.
 */
export function parseJunitReport(xml: string): ParsedReport {
  // Comentários e CDATA fora: um `<testcase` dentro de um CDATA (saída de teste impressa) não é um teste.
  const body = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  if (!/<testsuites?[\s>/]/.test(body)) return { parsed: false, failures: [], tests: null };
  const failures: GateFailure[] = [];
  let executed = 0;
  // Atributos AWARE de aspas: o reporter do `node --test` escreve `name="a &lt;x> b"` — um `>` cru DENTRO
  // do valor, que é XML válido e que um `[^>]*` cortaria no meio (medido no node 22).
  const caseRe = new RegExp(`<testcase\\b(${ATTRS})(\\/>|>([\\s\\S]*?)<\\/testcase\\s*>)`, "g");
  for (const m of body.matchAll(caseRe)) {
    const attrs = attrsOf(m[1]);
    const inner = m[3] ?? "";
    if (/<skipped\b/.test(inner)) continue;
    executed++;
    const fail = inner.match(new RegExp(`<(failure|error)\\b(${ATTRS})(?:\\/>|>([\\s\\S]*?)<\\/\\1\\s*>)`));
    if (!fail) continue;
    const fattrs = attrsOf(fail[2]);
    const text = decodeXml(fail[3] ?? "").trim();
    const classname = attrs.classname ?? "";
    const name = attrs.name ?? "?";
    failures.push({
      file: attrs.file ?? classname,
      name: classname && attrs.file ? `${classname} > ${name}` : name,
      message: (fattrs.message || text || fail[1]).split("\n")[0],
    });
  }
  return { parsed: true, failures, tests: executed };
}
