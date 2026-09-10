// OS ATAQUES QUE `mcp-handle.ts` PRECISA IMPEDIR (story-h8tmzh).
//
// O dano já ocorreu e foi MEDIDO (story-u4yf1i): 174 gravações do token MCP em texto claro — 168 no
// journal do Caddy, 6 em `/var/log/syslog*` — entre 2026-06-06 e 2026-07-29, pelo logger de ERRO
// DEFAULT do Caddy, que registra o URI inteiro. Nenhuma misconfiguração: enquanto a credencial FOR o
// path, todo intermediário tem a oportunidade de gravá-la, e o default de um deles já gravou.
//
// O que este módulo compra NÃO é "o que vaza deixa de autenticar" — um handle apresentado no path é
// uma credencial portadora como qualquer outra. O que ele compra é CONTENÇÃO: o valor que vaza é
// revogável NA HORA (sem o restart que o guardrail do projeto proíbe), pode carregar um nível MENOR
// que `full`, e não é o segredo que também abre as 4 rotas do runner. Os testes abaixo atacam
// exatamente essas três propriedades — e a compatibilidade retroativa, cuja quebra tiraria
// capacidade do dono.

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MCP_HANDLE_PREFIX,
  createMcpHandle,
  flushHandleTouches,
  legacyMcpTokenTiers,
  mcpActorLabel,
  mcpHandlesPath,
  parseMcpHandle,
  readMcpHandles,
  resolveLegacyMcpToken,
  resolveMcpCredential,
  resolveMcpHandle,
  revokeMcpHandle,
} from "./mcp-handle";

const TOKEN_ENV = "AGILEHARNESS_MCP_TOKEN";

let prevStateDir: string | undefined;
let prevToken: string | undefined;
/** o diretório desta iteração — guardado para que o `afterEach` possa APAGÁ-LO, não só esquecê-lo. */
let stateDir: string;

beforeEach(() => {
  prevStateDir = process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  prevToken = process.env[TOKEN_ENV];
  stateDir = mkdtempSync(path.join(tmpdir(), "mcp-handle-"));
  process.env.AGILEHARNESS_RUNNER_STATE_DIR = stateDir;
});

afterEach(async () => {
  await flushHandleTouches();
  if (prevStateDir === undefined) delete process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  else process.env.AGILEHARNESS_RUNNER_STATE_DIR = prevStateDir;
  if (prevToken === undefined) delete process.env[TOKEN_ENV];
  else process.env[TOKEN_ENV] = prevToken;
  // O `beforeEach` cria um diretório por TESTE, não por arquivo. Sem esta linha cada passada da suíte
  // deixava um `/tmp/mcp-handle-XXXXXX` para trás; em 2026-08-05 havia 19.567 deles. O custo não são os
  // inodes — é que 19 mil nomes iguais escondem um vazamento de verdade quando houver um, e o inode do
  // próprio /tmp já passava de 20 MB só de entradas. DEPOIS do flush, de propósito: o `flushHandleTouches`
  // ainda escreve neste diretório, e apagá-lo antes trocaria lixo por um erro de escrita intermitente.
  rmSync(stateDir, { recursive: true, force: true });
});

/**
 * Toda janela de 8 chars de `segredo` — a varredura que prova que nem um PEDAÇO dele sobrou.
 *
 * 8 e não 4: o segredo é base64url e o que se varre contém um digest hex de 64 chars, então uma
 * janela de 4 chars só-hex casaria por sorte de vez em quando e o teste piscaria. Com 8 a colisão
 * acidental é ~64⁻⁸, e um vazamento de 8 chars contíguos já é o vazamento que interessa proibir.
 */
function janelas(segredo: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 8 <= segredo.length; i++) out.push(segredo.slice(i, i + 8));
  return out;
}

describe("ATAQUE: usar um handle que vazou no log de um intermediário", () => {
  it("o operador revoga e o MESMO valor para de autenticar — no mesmo processo, sem restart", async () => {
    const { handle, record } = await createMcpHandle({ level: "full", label: "conector do chat web" });
    expect((await resolveMcpHandle(handle)).outcome).toBe("ok");

    // Trocar o token exige reiniciar o serviço — e o guardrail do projeto proíbe reiniciá-lo sem
    // autorização, o que é o que deixa a rotação TRAVADA hoje. A revogação tem de valer sem isso.
    expect(await revokeMcpHandle(record.id)).toBe("revogado");

    const depois = await resolveMcpHandle(handle);
    expect(depois.outcome, "um cache em memória faria a revogação exigir o restart proibido").toBe("revogado");

    // E a credencial revogada NÃO cai no caminho legado por descuido.
    const res = await resolveMcpCredential(handle);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe("handle-revogado");
    // A tentativa com um handle JÁ revogado é sinal de vazamento em uso — o veredito nomeia qual.
    expect(res.ok === false && res.handleId).toBe(record.id);
  });

  it("revogar duas vezes é idempotente, e revogar id inexistente não inventa nada", async () => {
    const { record } = await createMcpHandle({ level: "write" });
    expect(await revokeMcpHandle(record.id)).toBe("revogado");
    expect(await revokeMcpHandle(record.id)).toBe("ja-revogado");
    expect(await revokeMcpHandle("ffffffffffff")).toBe("desconhecido");
  });
});

describe("ATAQUE: transformar o registro em disco na própria credencial", () => {
  it("quem lê mcp-handles.json não consegue autenticar com nada de lá", async () => {
    const { handle, record } = await createMcpHandle({ level: "full" });
    const bruto = await readFile(mcpHandlesPath(), "utf8");
    expect(bruto.includes(handle), "o valor apresentável foi persistido — o arquivo É a credencial").toBe(false);
    const segredo = parseMcpHandle(handle)!.secret;
    expect(bruto.includes(segredo)).toBe(false);
    for (const j of janelas(segredo)) {
      expect(bruto.includes(j), `o registro persistiu "${j}" da metade secreta do handle`).toBe(false);
    }
    // O id, ao contrário, está em CLARO por desenho: é por ele que o operador revoga e o rastro cita
    // qual credencial foi usada — e ele não autentica nada sozinho.
    expect(bruto).toContain(record.id);
    // O que autentica é o digest — e o digest NÃO autentica (senão o arquivo seria a credencial).
    const reg = await readMcpHandles();
    const digest = reg.handles[0]!.digest;
    expect(digest.length).toBeGreaterThan(0);
    expect((await resolveMcpCredential(digest)).ok).toBe(false);
  });

  it("o arquivo nasce 0600 — nenhum outro usuário da máquina o lê", async () => {
    await createMcpHandle({ level: "ro" });
    expect(statSync(mcpHandlesPath()).mode & 0o777).toBe(0o600);
  });

  it("um registro PLANTADO à mão com digest de segredo fraco não autentica", async () => {
    // Sem piso de FORMA no valor APRESENTADO, quem conseguisse escrever no registro plantaria
    // sha256("ahk_<id>.senha") e autenticaria com uma senha adivinhável.
    const fraco = `${MCP_HANDLE_PREFIX}0123456789ab.senha`;
    writeFileSync(
      mcpHandlesPath(),
      JSON.stringify({
        v: 1,
        handles: [
          {
            id: "0123456789ab",
            digest: createHash("sha256").update(fraco).digest("hex"),
            level: "full",
            createdAt: new Date(0).toISOString(),
          },
        ],
      }),
      "utf8",
    );
    expect((await resolveMcpHandle(fraco)).outcome).not.toBe("ok");
    expect((await resolveMcpCredential(fraco)).ok).toBe(false);
  });

  it("trocar o id mantendo o segredo (ou o contrário) não autentica — o digest cobre o par", async () => {
    const { handle, record } = await createMcpHandle({ level: "full" });
    const segredo = parseMcpHandle(handle)!.secret;
    const outroId = `${MCP_HANDLE_PREFIX}ffffffffffff.${segredo}`;
    expect((await resolveMcpHandle(outroId)).outcome).not.toBe("ok");

    const outroSegredo = `${MCP_HANDLE_PREFIX}${record.id}.${randomBytes(32).toString("base64url")}`;
    expect((await resolveMcpHandle(outroSegredo)).outcome).toBe("desconhecido");
  });
});

describe("COMPATIBILIDADE: quebrar o token legado seria remover capacidade do dono", () => {
  it("o token primário do env continua autenticando pelo path, como `full`", async () => {
    const token = randomBytes(32).toString("base64url");
    process.env[TOKEN_ENV] = token;
    const res = await resolveMcpCredential(token);
    expect(res.ok).toBe(true);
    expect(res.ok && res.credential.level).toBe("full");
    expect(res.ok && res.credential.via, "o ledger precisa saber QUAL credencial entrou").toBe("token-legado");
    expect(res.ok && res.credential.tokenEnv).toBe(TOKEN_ENV);
  });

  it("um token de tier ESCOPADO continua resolvendo para o nível dele", () => {
    const orch = randomBytes(32).toString("base64url");
    const env = { AGILEHARNESS_MCP_TOKEN_ORCH: orch };
    const c = resolveLegacyMcpToken(orch, env, [{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_ORCH", level: "orch" }]);
    expect(c?.level).toBe("orch");
    expect(c?.tokenEnv).toBe("AGILEHARNESS_MCP_TOKEN_ORCH");
  });

  it("o tier PRIMÁRIO é o primeiro da ordem de resolução, como hoje", () => {
    const tiers = legacyMcpTokenTiers();
    expect(tiers[0]).toEqual({ tokenEnv: TOKEN_ENV, level: "full" });
  });

  it("um token legado FRACO continua recusado (o piso de força não afrouxou)", async () => {
    process.env[TOKEN_ENV] = "x".repeat(40); // 40 chars, 1 caractere distinto
    expect((await resolveMcpCredential("x".repeat(40))).ok).toBe(false);
  });

  it("o handle é um caminho ADICIONAL: os dois valem ao mesmo tempo", async () => {
    const token = randomBytes(32).toString("base64url");
    process.env[TOKEN_ENV] = token;
    const { handle } = await createMcpHandle({ level: "write", label: "notebook" });
    expect((await resolveMcpCredential(token)).ok).toBe(true);
    const viaHandle = await resolveMcpCredential(handle);
    expect(viaHandle.ok && viaHandle.credential.via).toBe("handle");
    expect(viaHandle.ok && viaHandle.credential.level, "um handle `write` não pode virar `full`").toBe("write");
  });

  it("um handle `full` É emissível — contenção não pode custar autonomia", async () => {
    const { handle } = await createMcpHandle({ level: "full" });
    const res = await resolveMcpCredential(handle);
    expect(res.ok && res.credential.level).toBe("full");
  });
});

describe("nada que o rastro publique pode carregar o segredo", () => {
  it("o rótulo de ator do ledger não contém o handle nem o token", async () => {
    const { handle, record } = await createMcpHandle({ level: "full", label: "chat web" });
    const res = await resolveMcpCredential(handle);
    const label = mcpActorLabel(res.ok ? res.credential : { level: "ro", via: "handle" });
    expect(label).toContain(record.id);
    for (const j of janelas(parseMcpHandle(handle)!.secret)) {
      expect(label.includes(j)).toBe(false);
    }
  });
});

describe("o último uso é sinal forense, não um contador de requisições", () => {
  it("registra o uso, mas não escreve em disco a cada chamada", async () => {
    const { handle, record } = await createMcpHandle({ level: "full", now: 0 });
    await resolveMcpHandle(handle, 1_000);
    await flushHandleTouches();
    const primeiro = (await readMcpHandles()).handles.find((h) => h.id === record.id)?.lastUsedAt;
    expect(primeiro).toBeTruthy();

    await resolveMcpHandle(handle, 31_000); // dentro do estrangulamento
    await flushHandleTouches();
    expect((await readMcpHandles()).handles.find((h) => h.id === record.id)?.lastUsedAt).toBe(primeiro);

    await resolveMcpHandle(handle, 1_000 + 120_000);
    await flushHandleTouches();
    expect((await readMcpHandles()).handles.find((h) => h.id === record.id)?.lastUsedAt).not.toBe(primeiro);
  });
});
