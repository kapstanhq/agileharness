// O recibo de versão do release: o que o ah-release grava é o que a rota e a tool leem — e ausente/ilegível é dito, não
// inventado. E, desde a revisão do WP6b, a versão que se diz NO AR é a que ESTE PROCESSO carregou no boot (o recibo lido
// ao subir, ligado ao BUILD_ID do build que ele serve), nunca o arquivo que está no disco agora.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureToolVersionAtBoot,
  parseToolVersion,
  pendingToolRelease,
  readLiveToolVersion,
  readToolVersion,
  resetToolVersionAtBoot,
  runningToolVersion,
  toolReleaseNote,
  TOOL_VERSION_FILE,
  type ToolVersion,
} from "./tool-version";

const OK: ToolVersion = { tag: "v0.9.26", sha: "a3f9c1e07b5d4c2e8f1a6b9d0c3e5f7a1b2c4d6e", at: "2026-10-02T03:10:00Z", prev: "v0.9.25", buildId: "Qx7bN2kLp0RmT4vW9sYc1" };
const NOVO: ToolVersion = { tag: "v0.9.27", sha: "b4e0d2f18c6e5d3f9a2b7c0e1d4f6a8b2c3d5e7f", at: "2026-10-02T04:00:00Z", prev: "v0.9.26", buildId: "Zz9aA8bB7cC6dD5eE4fF3" };

describe("parseToolVersion — só o recibo íntegro vale", () => {
  it("aceita o que o release grava (e prev pode faltar na primeira instalação)", () => {
    expect(parseToolVersion(JSON.stringify(OK))).toEqual(OK);
    expect(parseToolVersion(JSON.stringify({ ...OK, prev: undefined }))).toEqual({ ...OK, prev: null });
    expect(parseToolVersion(JSON.stringify({ ...OK, prev: null }))).toEqual({ ...OK, prev: null });
  });

  it.each([
    ["texto que não é JSON", "v0.9.26"],
    ["JSON que não é objeto", "[1]"],
    ["sem tag", JSON.stringify({ ...OK, tag: undefined })],
    ["tag com caractere de caminho/shell", JSON.stringify({ ...OK, tag: "v1; rm -rf /" })],
    ["sha que não é hexadecimal", JSON.stringify({ ...OK, sha: "zzzzzzz" })],
    ["sha curto demais", JSON.stringify({ ...OK, sha: "abc12" })],
    ["instante que não é data", JSON.stringify({ ...OK, at: "ontem" })],
    ["prev fora da forma", JSON.stringify({ ...OK, prev: "../x" })],
    // sem o BUILD_ID o recibo não se liga a build nenhum: é exatamente o «número sem prova» que ele existe para evitar
    ["sem buildId", JSON.stringify({ ...OK, buildId: undefined })],
    ["buildId fora da forma", JSON.stringify({ ...OK, buildId: "../../etc" })],
  ])("recusa %s", (_nome, raw) => {
    expect(parseToolVersion(raw)).toBeNull();
  });
});

const dirs: string[] = [];
afterEach(() => {
  resetToolVersionAtBoot();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Um pacote descartável: o recibo (texto cru) em dist/ah-version.json e o BUILD_ID do `.next` que «roda». */
const pkg = (opts: { receipt?: string; buildId?: string } = {}) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ah-version-"));
  dirs.push(dir);
  if (opts.receipt !== undefined) {
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(path.join(dir, TOOL_VERSION_FILE), opts.receipt);
  }
  if (opts.buildId !== undefined) {
    mkdirSync(path.join(dir, ".next"), { recursive: true });
    writeFileSync(path.join(dir, ".next", "BUILD_ID"), `${opts.buildId}\n`);
  }
  return dir;
};

describe("readToolVersion — o recibo do DISCO, e o porquê quando não há", () => {
  it("com o recibo do release: a versão, sem motivo", () => {
    expect(readToolVersion(pkg({ receipt: JSON.stringify(OK) }))).toEqual({ version: OK, reason: null });
  });

  it("sem o arquivo (dev, build manual): null com o motivo — nunca um número inventado", () => {
    const r = readToolVersion(pkg());
    expect(r.version).toBeNull();
    expect(r.reason).toMatch(/ausente.*contrib\/ah-release/);
  });

  it("arquivo malformado: null com o motivo", () => {
    const r = readToolVersion(pkg({ receipt: "{quebrado" }));
    expect(r.version).toBeNull();
    expect(r.reason).toMatch(/ilegível/);
  });

  it("sem diretório informado, resolve o pacote desta própria árvore (a fonte roda dentro do pacote da ferramenta)", () => {
    // Numa árvore de desenvolvimento não há dist/ah-version.json; numa instalada há. Nos dois casos a RAIZ resolveu: o
    // único motivo que não pode aparecer é «raiz não resolvida».
    expect(readToolVersion().reason ?? "").not.toMatch(/raiz da ferramenta/);
  });
});

describe("runningToolVersion — o recibo só vale se for o do build que o processo carregou (PURA)", () => {
  it("recibo e BUILD_ID do boot batem: é a versão que roda", () => {
    expect(runningToolVersion({ receipt: { version: OK, reason: null }, buildId: OK.buildId })).toEqual({ version: OK, reason: null });
  });

  it("o build em execução é OUTRO (self-deploy ou troca manual depois do release): null com o motivo, nunca a tag velha", () => {
    const r = runningToolVersion({ receipt: { version: OK, reason: null }, buildId: "OutroBuildDoSelfDeploy" });
    expect(r.version).toBeNull();
    expect(r.reason).toMatch(/OutroBuildDoSelfDeploy.*não é o do recibo v0\.9\.26/);
    expect(r.reason).toMatch(/fora do contrib\/ah-release/);
  });

  it("BUILD_ID ilegível no boot: o recibo não se liga a build nenhum — null com o motivo", () => {
    const r = runningToolVersion({ receipt: { version: OK, reason: null }, buildId: null });
    expect(r.version).toBeNull();
    expect(r.reason).toMatch(/BUILD_ID/);
  });

  it("sem recibo no boot: o motivo do recibo passa adiante", () => {
    const sem = { version: null, reason: "dist/ah-version.json ausente — este build não passou por contrib/ah-release" } as const;
    expect(runningToolVersion({ receipt: sem, buildId: "qualquer" })).toEqual(sem);
  });
});

describe("pendingToolRelease — o recibo que está no disco e ainda NÃO roda (PURA)", () => {
  it("o disco tem um recibo diferente do lido no boot: é o release que espera o restart", () => {
    expect(pendingToolRelease({ receipt: { version: OK, reason: null }, buildId: OK.buildId }, { version: NOVO, reason: null })).toEqual(NOVO);
  });

  it("o mesmo recibo do boot, ou nenhum no disco: nada pendente", () => {
    const boot = { receipt: { version: OK, reason: null }, buildId: OK.buildId };
    expect(pendingToolRelease(boot, { version: { ...OK }, reason: null })).toBeNull();
    expect(pendingToolRelease(boot, { version: null, reason: "ausente" })).toBeNull();
  });

  it("subiu sem recibo e agora há um no disco: pendente", () => {
    expect(pendingToolRelease({ receipt: { version: null, reason: "ausente" }, buildId: "x" }, { version: NOVO, reason: null })).toEqual(NOVO);
  });
});

describe("readLiveToolVersion — a foto do BOOT, não o disco de agora (defeito 1 da revisão)", () => {
  it("o recibo reescrito DEPOIS do boot não muda a versão que se diz no ar: o processo velho segue dizendo a dele, e o novo fica como pendente", () => {
    // O caso que a revisão reproduziu: o ah-release grava o recibo v0.9.27 no swap e é morto antes do restart; o processo
    // v0.9.26 continua no ar. Lendo do disco a cada request, ele respondia v0.9.27 — e a reexecução do release
    // «conferia» uma versão que não rodava.
    const dir = pkg({ receipt: JSON.stringify(OK), buildId: OK.buildId });
    captureToolVersionAtBoot(dir);
    writeFileSync(path.join(dir, TOOL_VERSION_FILE), JSON.stringify(NOVO));
    writeFileSync(path.join(dir, ".next", "BUILD_ID"), `${NOVO.buildId}\n`); // o swap trocou o .next também

    const live = readLiveToolVersion(dir);
    expect(live.running).toEqual({ version: OK, reason: null });
    expect(live.pending).toEqual(NOVO);
    expect(toolReleaseNote(live)).toMatch(/v0\.9\.27.*restart pendente/);
  });

  it("a primeira foto vence: capturar de novo no mesmo processo não troca a versão", () => {
    const dir = pkg({ receipt: JSON.stringify(OK), buildId: OK.buildId });
    captureToolVersionAtBoot(dir);
    writeFileSync(path.join(dir, TOOL_VERSION_FILE), JSON.stringify(NOVO));
    captureToolVersionAtBoot(dir);
    expect(readLiveToolVersion(dir).running.version?.tag).toBe("v0.9.26");
  });

  it("sem foto (o register() não rodou: teste, dev), a primeira leitura vira a foto", () => {
    const dir = pkg({ receipt: JSON.stringify(OK), buildId: OK.buildId });
    expect(readLiveToolVersion(dir).running.version?.tag).toBe("v0.9.26");
    writeFileSync(path.join(dir, TOOL_VERSION_FILE), JSON.stringify(NOVO));
    expect(readLiveToolVersion(dir).running.version?.tag).toBe("v0.9.26");
  });

  it("self-deploy depois do release (defeito 3): o recibo ficou, o build é outro — a versão no ar é null com o motivo", () => {
    const dir = pkg({ receipt: JSON.stringify(OK), buildId: "BuildDoSelfDeploy" });
    captureToolVersionAtBoot(dir);
    const live = readLiveToolVersion(dir);
    expect(live.running.version).toBeNull();
    expect(live.pending).toBeNull(); // o recibo do disco é o mesmo do boot: não há release esperando restart
    expect(toolReleaseNote(live)).toMatch(/não é o do recibo v0\.9\.26/);
  });

  it("tudo em dia: nenhuma nota", () => {
    const dir = pkg({ receipt: JSON.stringify(OK), buildId: OK.buildId });
    captureToolVersionAtBoot(dir);
    expect(toolReleaseNote(readLiveToolVersion(dir))).toBeNull();
  });
});

describe("o boot tira a foto — antes do portão do motor", () => {
  it("register() chama captureToolVersionAtBoot antes de engineArmedDecision (um boot inerte também diz a versão)", () => {
    // Sem esta chamada, a foto só nasceria no primeiro request — e um processo que ficou dias sem receber um /api/version
    // fotografaria o recibo de AGORA, que é o defeito inteiro de volta. A leitura preguiçosa é rede, não o caminho.
    const src = readFileSync(path.join(__dirname, "../../instrumentation.ts"), "utf8");
    const at = src.indexOf("captureToolVersionAtBoot()");
    expect(at, "o register() não fotografa a versão no boot").toBeGreaterThan(0);
    expect(at).toBeLessThan(src.indexOf("engineArmedDecision({"));
  });
});
