// O que o Jido DIZ ao operador em cada decisão. O bug que estes testes travam: a decisão de NÃO agir era
// invisível (só no arquivo de estado / no log do systemd), então um copiloto disciplinado — sem trabalho, sem
// budget, em backoff — era indistinguível de um copiloto quebrado.

import { describe, it, expect } from "vitest";
import { appendCopilotActivity, readCopilotActivity, tickOutcomeText } from "./activity";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("tickOutcomeText — toda decisão vira uma frase que o humano entende", () => {
  it("rodou POR UM EVENTO: diz o que o acordou", () => {
    const r = tickOutcomeText("ran", { reason: 'Blocker aberto em "Login"' });
    expect(r).toEqual({ kind: "woke", text: 'Acordei: Blocker aberto em "Login". Analisando o board…' });
  });

  it("rodou pelo tick periódico (sem evento)", () => {
    expect(tickOutcomeText("ran")?.text).toMatch(/Tick periódico/);
  });

  it("PULOU por falta de trabalho — e explica o que isso quer dizer", () => {
    const r = tickOutcomeText("skipped-no-work");
    expect(r?.kind).toBe("stood-down");
    expect(r?.text).toMatch(/nada acionável/i);
  });

  // WS-12.2 (D16) — "nada acionável" com N itens à vista era a desistência INVISÍVEL da colisão #7: o board
  // acme repetiu a frase por horas enquanto um card limpo esperava para ser publicado. Desistir é um EVENTO.
  //
  // 2026-07-17: o D16 consertou o TEXTO e deixou o KIND como `stood-down` — meia-correção, e a metade que
  // faltou é a que o operador VÊ: o cliente pinta por kind, então a desistência continuou saindo em cinza e
  // colapsada com o ruído. O board do acme repetiu esta frase 130 vezes em 10h, com o tick parado, e passou
  // por um copiloto trabalhando. Agora é `handed-back` (tier attention). A asserção mudou porque o
  // comportamento MELHOROU — o "Desistir é um EVENTO" do comentário acima só virou verdade agora.
  it("DESISTIU de todos: conta quantos, quantas tentativas, e NOMEIA os itens (não finge que não havia nada)", () => {
    const r = tickOutcomeText("skipped-no-work", {
      backoffItemIds: ["story-eqpdtz:deploy-failed", "story-xfleex:approval:release"],
      perItemNoopMax: 2,
    });
    expect(r?.kind).toBe("handed-back");
    expect(r?.text).toContain("2 itens acionáveis");
    expect(r?.text).toContain("2 tentativas");
    expect(r?.text).toContain("story-eqpdtz:deploy-failed");
    expect(r?.text).toContain("story-xfleex:approval:release");
    expect(r?.text).toMatch(/re-arme/i); // a saída fica explícita — o item é do humano, e ele pode devolvê-lo
    expect(r?.text).not.toMatch(/nada acionável/i);
  });

  // O CORAÇÃO do fix: os dois desfechos saem do MESMO `skipped-no-work`, e antes vestiam o mesmo kind. Um é
  // ruído ("não tinha o que fazer"), o outro é uma pendência que passou a ser do humano. Se um dia voltarem a
  // colidir num kind só, a desistência volta a ser invisível — foi exatamente esse o incidente do acme.
  it("'nada acionável' e 'desisti' NUNCA compartilham o kind — um é ruído, o outro é a sua vez", () => {
    const nada = tickOutcomeText("skipped-no-work");
    const desistiu = tickOutcomeText("skipped-no-work", { backoffItemIds: ["story-x:b:1"], perItemNoopMax: 2 });
    expect(nada?.kind).toBe("stood-down");
    expect(desistiu?.kind).toBe("handed-back");
    expect(nada?.kind).not.toBe(desistiu?.kind);
  });

  it("desistiu de UM só: a frase concorda no singular (e não vira 'itens acionáveis: 1')", () => {
    const r = tickOutcomeText("skipped-no-work", { backoffItemIds: ["story-xfleex:approval:release"], perItemNoopMax: 2 });
    expect(r?.text).toContain("1 item acionável");
    expect(r?.text).toContain("desisti dele");
  });

  it("lista de backoff VAZIA volta à frase honesta de sempre (não inventa desistência)", () => {
    expect(tickOutcomeText("skipped-no-work", { backoffItemIds: [] })?.text).toMatch(/nada acionável/i);
  });

  it("PULOU por budget — mostra o consumo real, não um 'budget' abstrato", () => {
    const r = tickOutcomeText("skipped-budget", { ticksToday: 20, maxTicks: 20 });
    expect(r?.text).toContain("20/20");
  });

  it("budget CONCRETO — os DOIS tetos (ticks + custo $) e a janela de reset", () => {
    const r = tickOutcomeText("skipped-budget", { ticksToday: 5, maxTicks: 20, costToday: 3.4, maxCostUSD: 10 });
    expect(r?.text).toContain("5/20 ticks");
    expect(r?.text).toContain("$3.40/$10");
    expect(r?.text).toMatch(/virada do dia/i);
  });

  it("backoff CONCRETO — nomeia quantos ciclos seguidos não moveram o trabalho", () => {
    expect(tickOutcomeText("skipped-backoff", { noopStreak: 3 })?.text).toContain("3 ciclos");
    // sem o streak, cai no texto genérico (que os consumidores legados/testes ainda batem)
    expect(tickOutcomeText("skipped-backoff")?.text).toMatch(/não moveram nada/i);
  });

  it("stand-down PAREADO diz O QUE eu faria (N itens acionáveis) e QUANDO volto — sem inventar 'há X min'", () => {
    const r = tickOutcomeText("skipped-leased", { actionableCount: 2 });
    expect(r?.text).toContain("2 itens acionáveis esperando");
    expect(r?.text).toMatch(/retomo quando você soltar o painel/i);
    expect(r?.text).not.toMatch(/há \d+\s*min/i); // NUNCA inventa "desde quando"
    // singular correto + caso vazio honesto
    expect(tickOutcomeText("skipped-leased", { actionableCount: 1 })?.text).toContain("1 item acionável esperando");
    expect(tickOutcomeText("skipped-leased", { actionableCount: 0 })?.text).toContain("nada acionável agora");
  });

  it("PULOU por backoff / lease do humano / run em voo — cada um com o SEU motivo", () => {
    expect(tickOutcomeText("skipped-backoff")?.text).toMatch(/não moveram nada/i);
    expect(tickOutcomeText("skipped-leased")?.text).toMatch(/você está no comando/i);
    expect(tickOutcomeText("skipped-running")?.text).toMatch(/já estou rodando/i);
  });

  it("WS-4.3 — skipped-leased é HONESTO quando um ciclo autônomo ainda está em voo (não só 'fiquei de fora')", () => {
    const plain = tickOutcomeText("skipped-leased")?.text ?? "";
    expect(plain).not.toMatch(/ainda está terminando/i); // sem tick em voo → texto simples
    const honest = tickOutcomeText("skipped-leased", { tickInFlight: true })?.text ?? "";
    expect(honest).toMatch(/ciclo autônomo iniciado ANTES ainda está terminando/i);
  });

  it("spawn que não nasceu = ERRO visível (não um 'pulei' qualquer): falta o token", () => {
    const r = tickOutcomeText("skipped-spawn-failed");
    expect(r?.kind).toBe("error");
    expect(r?.text).toContain("STORYMAP_MCP_TOKEN_ORCH");
  });

  it("board não-autônomo NÃO gera linha (não houve decisão a comunicar)", () => {
    expect(tickOutcomeText("skipped-not-autonomous")).toBeNull();
  });
});

// A REGRA do Operador: toda mensagem do diário é UMA FRASE CORRIDA — sem tabela, sem quebra de linha. Ela é
// imposta na ESCRITA (appendCopilotActivity é o único chokepoint dos 5 escritores), então vale para qualquer
// texto que entre — inclusive o `summary` do run, que é markdown do LLM e não passa por revisão nossa.
describe("appendCopilotActivity — a regra da frase corrida vale na GERAÇÃO", () => {
  it("um summary markdown do LLM é gravado JÁ como frase corrida", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "diary-"));
    const prev = process.env.STORYMAP_RUNNER_STATE_DIR;
    process.env.STORYMAP_RUNNER_STATE_DIR = tmp; // runnerStateDir() lê o env A CADA chamada
    try {
      await appendCopilotActivity("acme-test", {
        kind: "finished",
        text: "**Pronto.**\n\n## Resumo\n| Card | Status |\n|---|---|\n| `story-x` | **No ar** |",
        detail: "$0.42 · 31s",
      });
      const entries = await readCopilotActivity("acme-test", 10);
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe("Pronto. Resumo"); // a tabela some; o resto vira prosa
      expect(entries[0].text).not.toContain("\n");
      expect(entries[0].text).not.toContain("|");
      expect(entries[0].text).not.toContain("**");
      expect(entries[0].detail).toBe("$0.42 · 31s"); // detalhe já corrido passa intacto
    } finally {
      if (prev === undefined) delete process.env.STORYMAP_RUNNER_STATE_DIR;
      else process.env.STORYMAP_RUNNER_STATE_DIR = prev;
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
