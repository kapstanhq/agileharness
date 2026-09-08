import { describe, expect, it } from "vitest";
import { scrollBack, type TmuxRunner } from "./scroll";

// Runner INJETADO — nenhum teste aqui fala com um servidor tmux de verdade. Ele grava cada argv
// (para provar o que chegou, e o que NÃO chegou, no spawn) e devolve uma posição por leitura de
// `display-message`; os demais comandos respondem vazio, como o tmux real.
function spyRunner(positions: string[]): { run: TmuxRunner; calls: string[][] } {
  const calls: string[][] = [];
  let read = 0;
  const run: TmuxRunner = async (args) => {
    calls.push(args);
    // Sucesso SEMPRE: é justamente assim que o tmux responde a uma busca que não achou nada.
    return { stdout: args[0] === "display-message" ? (positions[read++] ?? "") : "", stderr: "" };
  };
  return { run, calls };
}

describe("scrollBack — o cliente nomeia uma AÇÃO, nunca um padrão", () => {
  it("ação desconhecida nunca chega ao tmux", async () => {
    const spy = spyRunner([]);
    const r = await scrollBack("shell", "rm -rf", spy.run);
    expect(r).toMatchObject({ ok: false, found: false });
    expect(r.error).toBeTruthy();
    // O ponto do teste: o guard roda ANTES do spawn, não depois. Zero processos criados.
    expect(spy.calls).toEqual([]);
  });

  it("nome de sessão inválido é recusado antes do spawn", async () => {
    const spy = spyRunner(["12:3", "480:3"]);
    const r = await scrollBack("a;b", "last-prompt", spy.run);
    expect(r).toMatchObject({ ok: false, found: false });
    expect(r.error).toBeTruthy();
    expect(spy.calls).toEqual([]);
  });

  it("found vem da posição, não do exit code (e 'bottom' cancela o copy-mode)", async () => {
    // O runner acima NUNCA falha — se `found` viesse do código de saída, os dois casos abaixo
    // seriam idênticos e a UI mentiria em todo painel sem prompt anterior.
    const parada = spyRunner(["12:3", "12:3"]);
    expect(await scrollBack("shell", "last-prompt", parada.run)).toEqual({ ok: true, found: false });

    const andou = spyRunner(["12:3", "480:3"]);
    expect(await scrollBack("shell", "last-prompt", andou.run)).toEqual({ ok: true, found: true });

    // O padrão é do SERVIDOR: o argv da busca tem 6 elementos, os 5 primeiros fixos e o 6º vindo do
    // allowlist — nada do que o chamador passou aparece aí. E é argv, nunca uma string de shell.
    const busca = andou.calls.find((a) => a.includes("search-backward")) ?? [];
    expect(busca).toHaveLength(6);
    expect(busca.slice(0, 5)).toEqual(["send-keys", "-t", "shell", "-X", "search-backward"]);
    expect(typeof busca[5]).toBe("string");
    expect(busca[5].length).toBeGreaterThan(0);

    // "bottom" sai do copy-mode; o `found` dele também é a posição ter mudado de verdade.
    const fim = spyRunner(["480:3", ":"]);
    expect(await scrollBack("shell", "bottom", fim.run)).toEqual({ ok: true, found: true });
    expect(fim.calls).toContainEqual(["send-keys", "-t", "shell", "-X", "cancel"]);
  });
});
