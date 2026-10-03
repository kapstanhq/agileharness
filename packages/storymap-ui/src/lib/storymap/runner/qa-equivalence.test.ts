import { describe, expect, it } from "vitest";
import { classifyFailure, type FailureRules } from "./findings";
import { coerceTargetProfileDetailed, QA_FAILURE_TEXT_TAIL_BYTES, qaOf } from "../target-profile";
import type { FailureClass } from "../types";

// MODELO DE REFERÊNCIA — o classificador de falhas de QA, alimentado por uma declaração `target.qa` que passou pela
// coerção real, se comporta EXATAMENTE como a regra escrita à mão abaixo:
//   1. as regras DECLARADAS, na ordem, a primeira que casa vence (qualquer classe — infra, test ou app);
//   2. ambiente: uma porta da ferramenta ou declarada citada como `:porta`, ou o baseline universal (módulo ausente,
//      porta ocupada, falta de memória, binário ausente, timeout de subida);
//   3. teste: passou em outra camada, ou o texto é de seletor/spec ruim;
//   4. aplicação: critério não atendido, ou qualquer outra mensagem.
//
// A declaração é INVENTADA (um laboratório de testes com sandboxes efêmeras e arquivos-ouro): duas regras de classes
// diferentes, duas portas. Nenhum valor vem de um alvo real.

const DECLARED_INFRA = /sandbox (?:vm|pod) (?:evicted|preempted)/i;
const DECLARED_TEST = /golden file [\w./-]+ is stale/i;
const PORTS = /:(3008|6060|6061)\b/; // a porta do serviço + as declaradas

const UNIVERSAL_INFRA: RegExp[] = [
  /MODULE_NOT_FOUND/i,
  /cannot find module/i,
  /EADDRINUSE|address already in use|port \d+ (is )?(already )?in use/i,
  /(javascript )?heap out of memory|out of memory|oom-?killed/i,
  /ENOENT[\s\S]*node_modules/i,
  /command not found|spawn \S+ ENOENT/i,
  /ETIMEDOUT|timed out (starting|booting|waiting for the (dev )?server)/i,
];
const SPEC_SMELLS: RegExp[] = [
  /strict mode violation/i,
  /waiting for (selector|locator)/i,
  /locator\(/i,
  /getby(testid|role|text)\b/i,
  /selector .* resolved to \d+ elements/i,
  /no (node|element) found for selector/i,
];

function referenceClassify(s: { message?: string | null; passedAtOtherLayer?: boolean; criterionUnmet?: boolean }): FailureClass | undefined {
  const msg = typeof s.message === "string" ? s.message : "";
  if (msg) {
    if (DECLARED_INFRA.test(msg)) return "infra";
    if (DECLARED_TEST.test(msg)) return "test";
    if (PORTS.test(msg) || UNIVERSAL_INFRA.some((re) => re.test(msg))) return "infra";
  }
  if (s.passedAtOtherLayer === true) return "test";
  if (msg && SPEC_SMELLS.some((re) => re.test(msg))) return "test";
  if (s.criterionUnmet === true) return "app";
  if (msg) return "app";
  return undefined;
}

const DECLARED = coerceTargetProfileDetailed({
  qa: {
    ports: [6060, 6061],
    failureClasses: [
      { pattern: "sandbox (?:vm|pod) (?:evicted|preempted)", class: "infra" },
      { pattern: "golden file [\\w./-]+ is stale", class: "test" },
    ],
  },
});
const RULES: FailureRules = { ...qaOf(DECLARED.profile), selfPort: 3008 };

const TEXTS: string[] = [
  "Error: Cannot find module 'tiny-fmt'",
  "code: MODULE_NOT_FOUND",
  "sandbox pod evicted after 120s",
  "SANDBOX VM PREEMPTED",
  "sandbox vm restarted", // não casa a regra declarada
  "golden file report/summary.txt is stale",
  "golden file cards.json is stale — MODULE_NOT_FOUND while diffing", // a declarada (test) vem ANTES do baseline
  "listen EADDRINUSE: address already in use :::3008",
  "port 6060 is already in use",
  "proxy at 127.0.0.1:6061 refused",
  "upstream :6062 refused", // porta não declarada
  "FATAL ERROR: JavaScript heap out of memory",
  "spawn labctl ENOENT",
  "bash: labctl: command not found",
  "ENOENT: no such file or directory, open '/w/node_modules/.bin/x'",
  "timed out booting the preview",
  "expected 7 to equal 8",
  "strict mode violation: locator('a') resolved to 4 elements",
  "locator.fill: Timeout 15000ms exceeded waiting for locator",
  "getByText('Enviar') resolved to 2 elements",
  "the sandbox is fine but the total is wrong",
  "",
];

describe("classificador de falhas = declaração do alvo + baseline universal (modelo de referência)", () => {
  it("a coerção da declaração não descarta nada", () => {
    expect(DECLARED.discarded).toEqual([]);
    expect(RULES.failureClasses).toHaveLength(2);
    expect(RULES.ports).toEqual([6060, 6061]);
  });

  it("TODA linha da tabela, em todas as combinações de sinais, dá o resultado do modelo", () => {
    for (const message of TEXTS) {
      for (const passedAtOtherLayer of [undefined, true]) {
        for (const criterionUnmet of [undefined, true]) {
          const signals = { message, passedAtOtherLayer, criterionUnmet };
          expect(classifyFailure(signals, RULES), JSON.stringify(signals)).toBe(referenceClassify(signals));
        }
      }
    }
  });

  it("a regra declarada de classe `test` vence o baseline de infra (a ordem é: declarado primeiro)", () => {
    expect(classifyFailure({ message: "golden file a.json is stale; Cannot find module 'x'" }, RULES)).toBe("test");
    expect(classifyFailure({ message: "Cannot find module 'x'" }, RULES)).toBe("infra");
  });

  it("`ECONNREFUSED` sem porta da ferramenta nem declarada é «app» — o baseline não o adivinha como ambiente", () => {
    for (const message of ["connect ECONNREFUSED 127.0.0.1:5000", "connect ECONNREFUSED 10.0.0.5:443"]) {
      expect(classifyFailure({ message }, RULES), message).toBe("app");
      expect(referenceClassify({ message })).toBe("app");
    }
  });

  it("log MAIOR que o limite de regex: a regra declarada casa na cabeça ou no rabo", () => {
    const meio = "z".repeat(QA_FAILURE_TEXT_TAIL_BYTES + 100);
    for (const message of [`sandbox pod evicted ${meio}`, `${meio} sandbox vm preempted`, `golden file x.txt is stale ${meio}`]) {
      expect(classifyFailure({ message }, RULES), message.slice(0, 40)).toBe(referenceClassify({ message }));
    }
  });

  it("textos aleatórios montados dos mesmos fragmentos nunca divergem do modelo", () => {
    const frags = ["expected", "sandbox", "pod", "evicted", "golden file a.txt is stale", ":6060", ":6099", "Cannot find module", "waiting for selector", "oom-killed", "ok", "locator(", "timed out starting", "ECONNREFUSED 127.0.0.1:5000"];
    let seed = 4242;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 400; i++) {
      const message = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => frags[Math.floor(rnd() * frags.length)]).join(rnd() < 0.5 ? " " : "\n");
      expect(classifyFailure({ message }, RULES), message).toBe(referenceClassify({ message }));
    }
  });
});
