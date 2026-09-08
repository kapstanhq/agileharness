import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isPidfileLive,
  parsePidfile,
  parseProcStatStarttime,
  procStartOf,
  readPidfiles,
  type ClaudePidfile,
} from "./claude-pidfile";

// O sample VERBATIM de um `<configDir>/sessions/<pid>.json` real (claude 2.1.218, capturado nesta
// caixa). Se o formato do CLI mudar, é ESTE literal que precisa mudar junto — não a asserção.
const SAMPLE = `{"pid":4125152,"sessionId":"4aa0a1a0-3ec8-475f-8b58-7847b2353f44","cwd":"/root/meu-monorepo","startedAt":1784813927749,"procStart":"420700166","version":"2.1.218","peerProtocol":1,"kind":"interactive","entrypoint":"cli","name":"meu-monorepo-b7","nameSource":"derived","status":"busy","updatedAt":1784813994111,"statusUpdatedAt":1784813994111}`;

// readPidfiles() lê $CLAUDE_CONFIG_DIR/sessions — redirecionamos para um dir descartável por teste,
// então nenhum teste enxerga (nem toca) o registro real do CLI desta caixa.
let dir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env.CLAUDE_CONFIG_DIR;
  dir = mkdtempSync(path.join(os.tmpdir(), "claude-pidfile-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
  mkdirSync(path.join(dir, "sessions"), { recursive: true });
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

function writePidfile(fileName: string, body: unknown): void {
  writeFileSync(
    path.join(dir, "sessions", fileName),
    typeof body === "string" ? body : JSON.stringify(body),
    "utf8",
  );
}

/** O pidfile de um processo COMPROVADAMENTE vivo: este próprio processo de teste. */
function livePidfileBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: process.pid,
    sessionId: "11111111-2222-3333-4444-555555555555",
    cwd: "/root/meu-monorepo",
    procStart: procStartOf(process.pid),
    kind: "interactive",
    ...over,
  };
}

/** Um pid livre de verdade (varre para baixo até o /proc não conhecer nenhum). */
function deadPid(): number {
  for (let p = 4_000_000; p > 3_900_000; p--) if (procStartOf(p) === null) return p;
  throw new Error("nenhum pid livre encontrado para o teste");
}

const pidfile = (over: Partial<ClaudePidfile> = {}): ClaudePidfile => ({
  pid: 4125152,
  sessionId: "4aa0a1a0-3ec8-475f-8b58-7847b2353f44",
  cwd: "/root/meu-monorepo",
  startedAt: 1784813927749,
  procStart: "420700166",
  version: "2.1.218",
  kind: "interactive",
  name: "meu-monorepo-b7",
  nameSource: "derived",
  status: "busy",
  updatedAt: 1784813994111,
  statusUpdatedAt: 1784813994111,
  ...over,
});

describe("parsePidfile — o registro que o próprio CLI mantém", () => {
  it("o sample real do CLI parseia com todos os campos", () => {
    expect(parsePidfile(SAMPLE)).toEqual({
      pid: 4125152,
      sessionId: "4aa0a1a0-3ec8-475f-8b58-7847b2353f44",
      cwd: "/root/meu-monorepo",
      startedAt: 1784813927749,
      procStart: "420700166",
      version: "2.1.218",
      kind: "interactive",
      name: "meu-monorepo-b7",
      nameSource: "derived",
      status: "busy",
      updatedAt: 1784813994111,
      // A IDADE do flag: sem ela, `status` é uma afirmação sem data — e foi um `busy` de 42,6h
      // que ensinou o quanto isso importa (ver cliFlagExpired).
      statusUpdatedAt: 1784813994111,
    });
  });

  it("json corrompido devolve null em vez de lançar", () => {
    expect(parsePidfile("{broken")).toBeNull();
    expect(parsePidfile("")).toBeNull();
    expect(parsePidfile("null")).toBeNull();
    expect(parsePidfile("[]")).toBeNull();
    expect(parsePidfile('"uma string"')).toBeNull();
  });

  it("arquivo sem sessionId é rejeitado — sem os dois campos não há mapeamento nenhum", () => {
    expect(parsePidfile(JSON.stringify({ pid: 42, cwd: "/x" }))).toBeNull();
    expect(parsePidfile(JSON.stringify({ pid: 42, sessionId: "" }))).toBeNull();
    expect(parsePidfile(JSON.stringify({ pid: 42, sessionId: "   " }))).toBeNull();
    expect(parsePidfile(JSON.stringify({ sessionId: "abc" }))).toBeNull();
    expect(parsePidfile(JSON.stringify({ pid: "42", sessionId: "abc" }))).toBeNull();
    expect(parsePidfile(JSON.stringify({ pid: 0, sessionId: "abc" }))).toBeNull();
  });

  it("campo desconhecido/ausente degrada para null, nunca para um valor inventado", () => {
    const out = parsePidfile(JSON.stringify({ pid: 7, sessionId: "s" }));
    expect(out).toEqual({
      pid: 7,
      sessionId: "s",
      cwd: "",
      startedAt: null,
      procStart: null,
      version: null,
      kind: null,
      name: null,
      nameSource: null,
      status: null,
      updatedAt: null,
      statusUpdatedAt: null,
    });
  });

  it("procStart vazio degrada para null — senão a guarda compararia contra \"\" e mataria um vivo", () => {
    expect(parsePidfile(JSON.stringify({ pid: 7, sessionId: "s", procStart: "" }))?.procStart).toBeNull();
  });
});

describe("isPidfileLive — a guarda de reuso de pid", () => {
  it("procStart divergente => NÃO vivo (pid reciclado usando o arquivo de um morto)", () => {
    const probe = { procStartOf: () => "999999999" };
    expect(isPidfileLive(pidfile({ procStart: "420700166" }), probe)).toBe(false);
  });

  it("procStart idêntico => vivo", () => {
    const probe = { procStartOf: () => "420700166" };
    expect(isPidfileLive(pidfile({ procStart: "420700166" }), probe)).toBe(true);
  });

  it("procStart ausente no pidfile => vivo se o pid existe (CLI antigo, guarda degradada)", () => {
    const probe = { procStartOf: () => "420700166" };
    expect(isPidfileLive(pidfile({ procStart: null }), probe)).toBe(true);
  });

  it("probe devolvendo null => NÃO vivo (processo morto ou /proc ilegível)", () => {
    const probe = { procStartOf: () => null };
    expect(isPidfileLive(pidfile({ procStart: "420700166" }), probe)).toBe(false);
    expect(isPidfileLive(pidfile({ procStart: null }), probe)).toBe(false);
  });

  it("a comparação é textual e exata — nem prefixo nem número aproximado passam", () => {
    expect(isPidfileLive(pidfile({ procStart: "420700166" }), { procStartOf: () => "4207001660" })).toBe(false);
    expect(isPidfileLive(pidfile({ procStart: "420700166" }), { procStartOf: () => "420700167" })).toBe(false);
  });

  it("consulta o probe com o pid do ARQUIVO, não com outro qualquer", () => {
    const seen: number[] = [];
    isPidfileLive(pidfile({ pid: 4125152 }), {
      procStartOf: (p: number) => {
        seen.push(p);
        return null;
      },
    });
    expect(seen).toEqual([4125152]);
  });
});

describe("parseProcStatStarttime — o campo 22 de /proc/<pid>/stat", () => {
  // O comm (campo 2) vem entre parênteses e PODE conter espaços e parênteses — o kernel não escapa.
  // Um split ingênuo na linha inteira desloca todos os campos seguintes.
  const weird = (() => {
    const after: string[] = ["S"]; // campo 3
    for (let f = 4; f <= 21; f++) after.push(String(f)); // campos 4..21
    after.push("420700166"); // campo 22 — starttime
    after.push("777", "888"); // campos 23+
    return `123 (weird (name) here) ${after.join(" ")}`;
  })();

  it("parseia um comm com espaço e parênteses (o campo 22 sai certo)", () => {
    expect(parseProcStatStarttime(weird)).toBe("420700166");
  });

  it("o split ingênuo na linha inteira erra o campo — é por isso que fatiamos após o último ')'", () => {
    expect(weird.trim().split(/\s+/)[21]).not.toBe("420700166");
  });

  it("parseia o caso normal (comm de uma palavra)", () => {
    const after: string[] = ["S"];
    for (let f = 4; f <= 21; f++) after.push(String(f));
    after.push("420783546");
    expect(parseProcStatStarttime(`4136422 (claude) ${after.join(" ")}`)).toBe("420783546");
  });

  it("linha truncada/sem ')' /com starttime não-numérico devolve null", () => {
    expect(parseProcStatStarttime("")).toBeNull();
    expect(parseProcStatStarttime("123 claude S 1 2 3")).toBeNull();
    expect(parseProcStatStarttime("123 (claude) S 1 2 3")).toBeNull();
    expect(parseProcStatStarttime(`123 (claude) ${["S", ...Array(19).fill("x")].join(" ")}`)).toBeNull();
  });
});

describe("procStartOf — leitura real do /proc", () => {
  it("devolve o mesmo starttime que /proc/self/stat para este processo", () => {
    const fromSelf = parseProcStatStarttime(readFileSync("/proc/self/stat", "utf8"));
    expect(fromSelf).toMatch(/^\d+$/);
    expect(procStartOf(process.pid)).toBe(fromSelf);
  });

  it("pid inexistente ou inválido devolve null, nunca 0", () => {
    expect(procStartOf(deadPid())).toBeNull();
    expect(procStartOf(0)).toBeNull();
    expect(procStartOf(-1)).toBeNull();
    expect(procStartOf(1.5)).toBeNull();
  });
});

describe("readPidfiles — só sessões VIVAS entram no mapa", () => {
  it("diretório inexistente => mapa vazio, sem exceção", () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, "nao-existe");
    expect(readPidfiles()).toEqual(new Map());
  });

  it("diretório vazio => mapa vazio", () => {
    expect(readPidfiles().size).toBe(0);
  });

  it("só entradas VIVAS aparecem no mapa (morto e corrompido ficam de fora)", () => {
    writePidfile(`${process.pid}.json`, livePidfileBody());
    const dead = deadPid();
    writePidfile(`${dead}.json`, { pid: dead, sessionId: "morta", procStart: "1" });
    writePidfile("999999998.json", "{corrompido");

    const map = readPidfiles();
    expect([...map.keys()]).toEqual([process.pid]);
    expect(map.get(process.pid)?.sessionId).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("json corrompido não derruba a leitura — as outras entradas continuam", () => {
    writePidfile("1.json", "{broken");
    writePidfile("2.json", "");
    writePidfile(`${process.pid}.json`, livePidfileBody());
    expect([...readPidfiles().keys()]).toEqual([process.pid]);
  });

  it("pid do nome do arquivo diferente do pid do conteúdo é descartado", () => {
    // O conteúdo descreve um processo VIVO — mesmo assim o arquivo é descartado, porque um
    // pidfile copiado/renomeado registraria a sessão sob um pid que nunca a rodou.
    writePidfile(`${process.pid + 1}.json`, livePidfileBody());
    expect(readPidfiles().size).toBe(0);
  });

  it("procStart divergente do /proc é descartado (o arquivo sobrou de um SIGKILL, o pid foi reciclado)", () => {
    writePidfile(`${process.pid}.json`, livePidfileBody({ procStart: "1" }));
    expect(readPidfiles().size).toBe(0);
  });

  it("ignora qualquer nome que não seja <dígitos>.json", () => {
    writePidfile("README.md", "oi");
    writePidfile(`${process.pid}.json.tmp`, JSON.stringify(livePidfileBody()));
    writePidfile(`x${process.pid}.json`, JSON.stringify(livePidfileBody()));
    expect(readPidfiles().size).toBe(0);
  });
});
