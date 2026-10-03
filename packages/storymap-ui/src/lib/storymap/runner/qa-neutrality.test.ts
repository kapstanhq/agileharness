import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// CATRACA DE NEUTRALIDADE DA VERIFICAÇÃO — o código que classifica uma falha de QA, sonda a stack e escolhe a porta do
// dev server NÃO supõe a stack de nenhum alvo. O que é do alvo (portas, sondas, classes de falha) vem declarado em
// `settings.yaml → target.qa`. Este teste falha se um literal de stack voltar a uma LINHA DE CÓDIGO destes arquivos
// (comentário explica a história e fica de fora). Os termos são montados em tempo de execução: o arquivo é público.

const ROOT = join(process.cwd(), "src/lib/storymap/runner");
const FILES = ["findings.ts", "stack-health.ts", "dev-server.ts", "run-death.ts", "failure-origin.ts"];

const join_ = (...parts: string[]) => parts.join("");
const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: "nome de plataforma de nuvem/emulador", re: new RegExp(join_("fire", "base|fire", "store|emul", "ator"), "i") },
  { name: "nome da unidade de uma stack persistente do repositório de origem", re: new RegExp(join_("qa-", "stack"), "i") },
  { name: "porta de emulador de um repositório específico", re: new RegExp(`\\b(${["9099", "5001", "8080", "9199", "4500"].join("|")})\\b`) },
  { name: "prompt interativo de CLI de um fornecedor", re: /enter a string value/i },
];

const isCommentLine = (t: string) => t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");

describe("qa-neutrality — nenhum literal de stack de alvo no código de verificação", () => {
  for (const file of FILES) {
    it(`${file}: zero ocorrências proibidas em linhas de código`, () => {
      const offenders: string[] = [];
      readFileSync(join(ROOT, file), "utf8")
        .split("\n")
        .forEach((ln, i) => {
          const t = ln.trim();
          if (isCommentLine(t)) return;
          for (const rule of FORBIDDEN) if (rule.re.test(ln)) offenders.push(`${file}:${i + 1} [${rule.name}] → ${t.slice(0, 80)}`);
        });
      expect(offenders, "Declare o vocabulário do ambiente do alvo em settings.yaml → target.qa em vez de embuti-lo.").toEqual([]);
    });
  }

  it("a catraca PEGA o defeito: o literal antigo seria recusado", () => {
    expect(FORBIDDEN.some((r) => r.re.test("/:(3008|9099|5001)\\b/, // contended"))).toBe(true);
    expect(FORBIDDEN.some((r) => r.re.test(join_("/fire", "base[\\s\\S]{0,60}emul", "ator/i")))).toBe(true);
    expect(FORBIDDEN.some((r) => r.re.test("/MODULE_NOT_FOUND/i"))).toBe(false);
  });
});
