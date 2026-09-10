import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { settingsPath } from "@/lib/storymap/paths";

// INTERRUPTOR PUBLICADO SEM LEITOR — a classe, não o caso.
//
// Medido em 2026-08-20 no artefato: `settings.yaml` trazia `autorun.sandbox.enabled: false` e
// `runner/config.ts` tinha o `if (env.AGILEHARNESS_AUTORUN_SANDBOX === "1" || … === "0") { }` — corpo VAZIO.
// A alavanca saiu em 2026-08-05 junto com a camada fail-open que ela governava (`runner/sandbox.ts`,
// removida quando o F0 pousou), e os dois resíduos ficaram quinze dias prometendo um controle de
// contenção que não existia. É a pior classe de mentira de configuração: quem lê o arquivo publicado
// conclui que a proteção está desligada por ESCOLHA e que basta virar a chave.
//
// Nenhum `tsc` e nenhum lint reprovam um `if` de corpo vazio nem uma chave YAML que ninguém lê — por
// isso a régua é aqui, e é ESTRUTURAL: mede a forma do resíduo, não o nome do knob que já morreu.

const CONFIG_TS = path.join(process.cwd(), "src/lib/storymap/runner/config.ts");

describe("configuração não publica interruptor que ninguém lê", () => {
  it("[CLASSE] applyEnvOverrides não tem nenhum `if` de corpo vazio", () => {
    const src = readFileSync(CONFIG_TS, "utf8");
    expect(src.length, "não li o config.ts — um guarda que lê vazio fica verde de graça").toBeGreaterThan(5000);
    // `if (…) {` seguido só de espaço/quebra até o `}` que fecha: a assinatura exata de um knob que
    // foi desligado por dentro e continua anunciado por fora.
    const vazios = [...src.matchAll(/\bif\s*\([^\n]*\)\s*\{\s*\}/g)].map((m) => m[0].slice(0, 80));
    expect(
      vazios.join(" | "),
      "`if` de corpo vazio em config.ts — ou o override faz algo, ou ele (e a chave que o anuncia) sai",
    ).toBe("");
  });

  it("o settings.yaml publicado não carrega a chave `autorun.sandbox`", () => {
    const doc = yaml.load(readFileSync(settingsPath(), "utf8")) as { autorun?: Record<string, unknown> } | null;
    expect(doc?.autorun, "settings.yaml sem bloco autorun — o guarda mediria o vazio").toBeTruthy();
    expect(
      Object.keys(doc?.autorun ?? {}),
      "a chave `sandbox` voltou ao settings.yaml — ela não tem leitor desde 2026-08-05; a contenção " +
        "real é a do F0 (runner/autonomy-sandbox.ts), que RECUSA em vez de degradar em silêncio",
    ).not.toContain("sandbox");
  });

  it("[ATAQUE] o nome do knob morto não reaparece em código de runtime", () => {
    const src = readFileSync(CONFIG_TS, "utf8");
    // Só fora de comentário: a lápide que explica a remoção é desejável e cita o nome de propósito.
    const semComentarios = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(semComentarios).not.toContain("AGILEHARNESS_AUTORUN_SANDBOX");
  });
});
