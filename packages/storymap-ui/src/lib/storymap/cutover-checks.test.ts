import { describe, expect, it } from "vitest";

import {
  caminhosAusentes,
  classificarUnits,
  lerCaminhosDeUnit,
  podeReiniciar,
  unidadesComExistenciaMedida,
} from "./cutover-checks";
import { runPreflight } from "./preflight";

describe("classificarUnits — as units cravadas num caminho literal", () => {
  const opts = { raizDoAlvo: "/alvo", pacoteDaFerramentaNoAlvo: "/alvo/packages/storymap-ui" };

  it("separa as três colunas", () => {
    const r = classificarUnits(
      [
        { unit: "storymap.service", caminhos: ["/alvo/packages/storymap-ui"] },
        { unit: "reaper.service", caminhos: ["/alvo/scripts/ops/reap.sh"] },
        { unit: "caddy.service", caminhos: ["/etc/caddy/Caddyfile"] },
      ],
      opts,
    );
    expect(r.map((c) => c.coluna)).toEqual(["ferramenta-no-alvo", "alvo", "host"]);
  });

  // O caso que uma comparação por STRING erra: `/alvo/packages/storymap-ui-antigo` COMEÇA com o
  // prefixo mas não está dentro dele. Classificá-lo como item de cutover mandaria o operador mexer
  // numa unit que não tem nada a ver — e ruído treina a ignorar o relatório.
  it("prefixo de string não é prefixo de caminho", () => {
    const r = classificarUnits(
      [{ unit: "x.service", caminhos: ["/alvo/packages/storymap-ui-antigo/bin"] }],
      opts,
    );
    expect(r[0].coluna).toBe("alvo");
  });

  it("uma unit com vários caminhos rende um veredito por caminho", () => {
    const r = classificarUnits(
      [{ unit: "ttyd.service", caminhos: ["/alvo/tools/web-terminal/attach.sh", "/alvo/packages/storymap-ui/x"] }],
      opts,
    );
    expect(r).toHaveLength(2);
    expect(r.map((c) => c.coluna)).toEqual(["alvo", "ferramenta-no-alvo"]);
  });
});

describe("podeReiniciar — o dreno que ninguém tinha escrito", () => {
  it("máquina quieta ⇒ seguro, e sem impedimento inventado", () => {
    const v = podeReiniciar({ runsAtivos: 0, filaEsperando: 0, boardsArmados: [] });
    expect(v.seguro).toBe(true);
    expect(v.impedimentos).toEqual([]);
    expect(v.comoDrenar).toEqual([]);
  });

  // A ORDEM é load-bearing: esperar os runs com o autorun armado é uma corrida que não termina, porque
  // cada card que avança dispara o próximo. Desarmar vem primeiro, e o veredito tem de dizer isso.
  it("com autorun armado, DESARMAR vem antes de esperar", () => {
    const v = podeReiniciar({ runsAtivos: 2, filaEsperando: 0, boardsArmados: ["nest", "spot"] });
    expect(v.seguro).toBe(false);
    expect(v.comoDrenar[0]).toMatch(/set_board_autorun/);
    expect(v.comoDrenar[0]).toContain("nest");
    expect(v.comoDrenar[1]).toMatch(/runner_status/);
    // e o remédio explica POR QUE a ordem importa — senão o operador inverte e espera para sempre
    expect(v.comoDrenar[1]).toMatch(/desarme ANTES/);
  });

  it("fila com trabalho não integrado é impedimento próprio", () => {
    const v = podeReiniciar({ runsAtivos: 0, filaEsperando: 3, boardsArmados: [] });
    expect(v.seguro).toBe(false);
    expect(v.impedimentos[0]).toMatch(/fila de merge/);
    expect(v.comoDrenar[0]).toMatch(/resolve_merge/);
  });
});

describe("o preflight NÃO opina sobre o que não mediu", () => {
  // Um check que passa por AUSÊNCIA de sonda é a pior espécie: ele afirma segurança sobre um host que
  // ninguém olhou. Nem todo host tem systemd; a resposta honesta é o item não existir.
  it("sem sonda, os dois checks simplesmente não aparecem", () => {
    const ids = runPreflight({ env: {} }).checks.map((c) => c.id);
    expect(ids).not.toContain("host.units");
    expect(ids).not.toContain("host.restartSafe");
  });

  it("com sonda, eles aparecem e nomeiam o conserto", () => {
    const r = runPreflight({
      env: {},
      repoRoot: "/alvo",
      pacoteDaFerramentaNoAlvo: "/alvo/packages/storymap-ui",
      unidades: [{ unit: "ttyd.service", caminhos: ["/alvo/packages/storymap-ui/x.sh"] }],
      reinicio: { runsAtivos: 1, filaEsperando: 0, boardsArmados: ["nest"] },
    });
    const u = r.checks.find((c) => c.id === "host.units");
    expect(u?.status).toBe("degraded");
    expect(u?.observed).toContain("ttyd.service");
    const s = r.checks.find((c) => c.id === "host.restartSafe");
    expect(s?.status).toBe("degraded");
    expect(s?.remedy).toMatch(/set_board_autorun/);
  });
});

// ── A NÃO-VACUIDADE DO PRÓPRIO INVENTÁRIO ───────────────────────────────────────────────────────────
// Um relatório que aprova tendo medido ZERO é o defeito que ele existe para não cometer. A máquina que
// serve isto tem, no mínimo, a unit do próprio serviço citando a árvore — medir zero significa que a
// varredura não alcançou, ou que esta raiz não é a que as units apontam.
describe("host.units não aprova por vacuidade", () => {
  it("zero caminhos medidos ⇒ `unknown`, nunca `ok`", () => {
    const r = runPreflight({
      env: {},
      repoRoot: "/alvo",
      pacoteDaFerramentaNoAlvo: "/alvo/packages/storymap-ui",
      unidades: [{ unit: "caddy.service", caminhos: [] }],
    });
    const c = r.checks.find((x) => x.id === "host.units");
    expect(c?.status).toBe("unknown");
    expect(c?.remedy).toMatch(/ausência de medição/);
  });

  it("…e com caminho de verdade, aprova de verdade", () => {
    const r = runPreflight({
      env: {},
      repoRoot: "/alvo",
      pacoteDaFerramentaNoAlvo: "/alvo/packages/storymap-ui",
      unidades: [{ unit: "x.service", caminhos: ["/alvo/scripts/ops/y.sh"] }],
    });
    expect(r.checks.find((x) => x.id === "host.units")?.status).toBe("ok");
  });
});

describe("lerCaminhosDeUnit — o inventário que omitia em silêncio", () => {
  const RAIZ = "/root/alvo";
  const tudoExiste = () => true;

  it("acha o caminho dentro de `sh -c '...'` — o falso negativo que escondia uma unit inteira", () => {
    // A FORMA EXATA da unit desta caixa. Com o desaspamento antigo (só `\"`), o token saía como
    // `/root/alvo'` — com apóstrofo — não casava o prefixo da raiz, e a unit sumia do inventário.
    const texto = `[Service]\nExecStart=/bin/sh -c '/usr/bin/tmux has-session -t shell || /usr/bin/tmux new-session -d -s shell -c ${RAIZ}'\n`;
    const r = lerCaminhosDeUnit(texto, { raiz: RAIZ, existe: tudoExiste });
    expect(r.caminhos).toEqual([RAIZ]);
  });

  it("aspas duplas continuam funcionando", () => {
    const r = lerCaminhosDeUnit(`WorkingDirectory="${RAIZ}/pacote"\n`, { raiz: RAIZ, existe: tudoExiste });
    expect(r.caminhos).toEqual([`${RAIZ}/pacote`]);
  });

  it("caminho EXIGIDO que não existe entra em `ausentes`", () => {
    const r = lerCaminhosDeUnit(`ExecStart=${RAIZ}/bin/sumiu\n`, { raiz: RAIZ, existe: () => false });
    expect(r.ausentes).toEqual([`${RAIZ}/bin/sumiu`]);
  });

  it("o `-` do systemd DECLARA a ausência como esperada — e não é defeito", () => {
    // Medido nesta caixa: uma unit da pilha de QA declara assim um `.env` que de fato não existe, e
    // está certa. Tratar isso como defeito seria um alarme que ensina a ignorar alarmes.
    const r = lerCaminhosDeUnit(`EnvironmentFile=-${RAIZ}/pacote/.env\n`, { raiz: RAIZ, existe: () => false });
    expect(r.caminhos).toEqual([`${RAIZ}/pacote/.env`]);
    expect(r.ausentes).toEqual([]);
  });

  it("ignora caminho de OUTRA árvore com o mesmo prefixo textual", () => {
    // `/root/alvo-stage` começa com `/root/alvo` como STRING e não está dentro dele.
    const r = lerCaminhosDeUnit(`WorkingDirectory=/root/alvo-stage/x\n`, { raiz: RAIZ, existe: () => false });
    expect(r.caminhos).toEqual([]);
  });

  it("diretiva sem caminho não produz nada", () => {
    const r = lerCaminhosDeUnit(`Type=oneshot\nExecStart=/usr/bin/tmux kill-server\n`, {
      raiz: RAIZ,
      existe: tudoExiste,
    });
    expect(r.caminhos).toEqual([]);
  });
});

describe("caminhosAusentes — sonda que não mediu não vira verde", () => {
  it("junta os ausentes de todas as units, nomeando a unit", () => {
    expect(
      caminhosAusentes([
        { unit: "a.service", caminhos: ["/r/x"], ausentes: ["/r/x"] },
        { unit: "b.timer", caminhos: ["/r/y"], ausentes: [] },
      ]),
    ).toEqual([{ unit: "a.service", caminho: "/r/x" }]);
  });

  it("unit SEM o campo `ausentes` é pulada, não aprovada", () => {
    const unidades = [{ unit: "velha.service", caminhos: ["/r/x"] }];
    expect(caminhosAusentes(unidades)).toEqual([]);
    // …e é `unidadesComExistenciaMedida` que impede o veredito de chamar isso de "ok".
    expect(unidadesComExistenciaMedida(unidades)).toBe(0);
  });

  it("conta só as units cuja existência foi de fato medida", () => {
    expect(
      unidadesComExistenciaMedida([
        { unit: "a", caminhos: ["/r/x"], ausentes: [] },
        { unit: "b", caminhos: ["/r/y"] },
      ]),
    ).toBe(1);
  });
});
