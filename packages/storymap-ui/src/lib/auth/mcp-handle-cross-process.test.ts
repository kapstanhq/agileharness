// O ATAQUE: DESFAZER UMA REVOGAÇÃO — sem privilégio nenhum, só por timing (story-h8tmzh/u4yf1i).
//
// Cenário real, não hipotético. O operador descobre no journal do proxy um handle que vazou (o dano
// medido em story-u4yf1i: 174 gravações de credencial em texto claro) e roda o comando de revogação.
// Esse comando é, POR CONSTRUÇÃO, um SEGUNDO PROCESSO — o serviço não pode ser reiniciado sem
// autorização do dono, e é justamente isso que o handle existe para não exigir.
//
// Enquanto isso, o serviço vivo está no meio de um `touchHandle` (`lastUsedAt`): ele já LEU o registro
// e vai regravá-lo INTEIRO. Se as duas escritas não se excluírem, a fotografia velha do serviço
// aterrissa DEPOIS da revogação e apaga o `revokedAt`. Resultado: o handle vazado volta a autenticar,
// sem uma linha no rastro, e o operador acredita ter fechado a porta. Uma revogação que pode ser
// desfeita em silêncio é PIOR que nenhuma — ela produz confiança falsa.
//
// `withKeyedLock` (serialize.ts) NÃO cobre isto: o doc-comment dele declara que serializa apenas
// dentro de um processo. Contra outro processo é last-writer-wins — o mesmo mecanismo que já reabriu
// dois blockers fechados no board-data (colisão #2, acme/story-qb8z2c).
//
// Os testes abaixo usam um PROCESSO DE VERDADE (bun rodando o mesmo módulo) para o lado do operador,
// e o próprio processo do teste para o lado do serviço. Nada de mock no meio: o que se prova é o
// comportamento no disco compartilhado, que é onde a corrida acontece.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HANDLE_LOCK_STALE_MS,
  McpHandleRegistryLockedError,
  createMcpHandle,
  flushHandleTouches,
  mcpHandlesLockPath,
  mcpHandlesPath,
  readMcpHandles,
  resolveMcpCredential,
  resolveMcpHandle,
  revokeMcpHandle,
  withMcpHandlesLock,
} from "./mcp-handle";

/** O pacote — cwd do filho, para que ele resolva os aliases `@/…` pelo tsconfig daqui. */
const PACOTE = path.resolve(__dirname, "..", "..", "..");
const MODULO = path.join(PACOTE, "src", "lib", "auth", "mcp-handle.ts");

let stateDir: string;
let prevStateDir: string | undefined;
let scriptDir: string;

beforeEach(() => {
  prevStateDir = process.env.STORYMAP_RUNNER_STATE_DIR;
  stateDir = mkdtempSync(path.join(tmpdir(), "mcp-handle-xp-"));
  scriptDir = mkdtempSync(path.join(tmpdir(), "mcp-handle-xp-bin-"));
  process.env.STORYMAP_RUNNER_STATE_DIR = stateDir;
});

afterEach(async () => {
  await flushHandleTouches();
  if (prevStateDir === undefined) delete process.env.STORYMAP_RUNNER_STATE_DIR;
  else process.env.STORYMAP_RUNNER_STATE_DIR = prevStateDir;
  // Dois diretórios por TESTE (registro + scripts do processo filho), nenhum removido até aqui — o mesmo
  // defeito de `mcp-handle.test.ts`, com o dobro do rastro. Depois do flush, pela mesma razão.
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(scriptDir, { recursive: true, force: true });
});

interface Filho {
  saida: Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** resolve quando o filho avisou que está a UM passo de mutar o registro. */
  prestes: Promise<void>;
}

/**
 * Roda `revokeMcpHandle` num PROCESSO SEPARADO, com um marcador de "estou prestes a revogar".
 *
 * O marcador é o que torna o teste determinístico nos DOIS estados do código: sem exclusão mútua o
 * filho revoga imediatamente depois de marcar; com exclusão mútua ele marca e então BLOQUEIA no lock.
 * Em ambos os casos o teste sabe exatamente quando agir, e nada depende do tempo de boot do runtime.
 */
function revogarEmOutroProcesso(id: string): Filho {
  const marcador = path.join(scriptDir, "prestes");
  const script = path.join(scriptDir, "revogar.ts");
  writeFileSync(
    script,
    [
      `const mod = await import(${JSON.stringify(MODULO)});`,
      `const { writeFileSync } = await import("node:fs");`,
      `writeFileSync(${JSON.stringify(marcador)}, "1");`,
      `const r = await mod.revokeMcpHandle(process.argv[2]);`,
      `console.log(r);`,
    ].join("\n"),
    "utf8",
  );

  // `--no-install`: o node_modules desta árvore é um symlink para o do serviço VIVO — um auto-install
  // do runtime mexeria em produção.
  const filho = spawn("bun", ["--no-install", script, id], {
    cwd: PACOTE,
    env: { ...process.env, STORYMAP_RUNNER_STATE_DIR: stateDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  filho.stdout.on("data", (d) => (stdout += String(d)));
  filho.stderr.on("data", (d) => (stderr += String(d)));

  const saida = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    filho.on("error", reject);
    filho.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  const prestes = (async () => {
    for (let i = 0; i < 600 && !existsSync(marcador); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!existsSync(marcador)) throw new Error(`o processo filho nunca marcou "prestes": ${stderr}`);
  })();

  return { saida, prestes };
}

describe("ATAQUE: desfazer a revogação com a fotografia velha do serviço", () => {
  it(
    "a revogação vinda de OUTRO PROCESSO sobrevive à regravação do serviço — o handle vazado NÃO volta a autenticar",
    async () => {
      const { handle, record } = await createMcpHandle({ level: "full", label: "conector do chat web" });
      expect((await resolveMcpHandle(handle)).outcome).toBe("ok");

      // ── O SERVIÇO pega o registro em mãos e entra na seção crítica ────────────────────────────
      // É o estado de `touchHandle`: já leu o arquivo e vai regravá-lo inteiro. Aqui isso é
      // representado como ele acontece no disco — o lock tomado e a fotografia PRÉ-revogação guardada.
      const emMaos = readFileSync(mcpHandlesPath(), "utf8");
      writeFileSync(mcpHandlesLockPath(), `${process.pid} servico-no-meio-do-write\n`, { mode: 0o600 });

      // ── O OPERADOR revoga, de um processo separado ────────────────────────────────────────────
      const filho = revogarEmOutroProcesso(record.id);
      await filho.prestes;
      // Margem para o caso SEM exclusão mútua: lá o filho revoga em seguida, sem pedir lock nenhum.
      await new Promise((r) => setTimeout(r, 250));

      // ── O SERVIÇO termina o read-modify-write dele: grava a fotografia VELHA e solta o lock ───
      writeFileSync(mcpHandlesPath(), emMaos, "utf8");
      unlinkSync(mcpHandlesLockPath());

      const { code, stdout, stderr } = await filho.saida;
      expect(stderr, "o processo de revogação quebrou").not.toContain("Error");
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("revogado");

      // O VEREDITO: a revogação existe no disco, e o valor que vazou não autentica mais.
      const rec = (await readMcpHandles()).handles.find((h) => h.id === record.id);
      expect(
        rec?.revokedAt,
        "a regravação do serviço APAGOU a revogação — o handle vazado voltou a autenticar em silêncio",
      ).toBeTruthy();
      expect((await resolveMcpHandle(handle)).outcome).toBe("revogado");
      const res = await resolveMcpCredential(handle);
      expect(res.ok).toBe(false);
      expect(res.ok === false && res.reason).toBe("handle-revogado");
    },
    30_000,
  );

  it("uma mutação NÃO entra enquanto outro processo detém o lock do registro", async () => {
    const { record } = await createMcpHandle({ level: "ro" });
    const antes = readFileSync(mcpHandlesPath(), "utf8");

    // Um lock RECÉM-criado = outro processo dentro da seção crítica. Ninguém mais escreve.
    writeFileSync(mcpHandlesLockPath(), `999999 outro-processo\n`, { mode: 0o600 });

    let terminou = false;
    const revogando = revokeMcpHandle(record.id).then((r) => {
      terminou = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(terminou, "escreveu por cima de quem detinha o lock — é a corrida que perde a revogação").toBe(false);
    expect(readFileSync(mcpHandlesPath(), "utf8")).toBe(antes);

    unlinkSync(mcpHandlesLockPath()); // o outro processo saiu
    expect(await revogando).toBe("revogado");
    expect((await readMcpHandles()).handles.find((h) => h.id === record.id)?.revokedAt).toBeTruthy();
  }, 30_000);

  it("ATAQUE: segurar o lock NÃO derruba a autenticação — um lock de arquivo não pode virar botão de DoS", async () => {
    // Guarda de regressão contra a "melhoria" óbvia e errada: estender o lock à LEITURA. Se ler
    // esperasse o lock, quem conseguisse criar `mcp-handles.json.lock` — ou um processo que morreu e
    // deixou um órfão — faria TODA autenticação por handle parar de responder. Ler é seguro sem lock
    // porque toda escrita aterrissa por rename atômico: ninguém vê arquivo pela metade.
    const { handle } = await createMcpHandle({ level: "full" });
    writeFileSync(mcpHandlesLockPath(), "999999 segurando\n", { mode: 0o600 });
    try {
      const t0 = Date.now();
      expect((await resolveMcpHandle(handle)).outcome).toBe("ok");
      expect((await resolveMcpCredential(handle)).ok).toBe(true);
      expect(Date.now() - t0, "a resolução esperou o lock — o perímetro ficou reprovável por DoS").toBeLessThan(500);
    } finally {
      unlinkSync(mcpHandlesLockPath());
    }
  }, 30_000);

  it("quebrar um órfão NÃO arranca o lock que outro processo acabou de adquirir", async () => {
    // A CORRIDA DENTRO DO CONSERTO. Dois processos acordam do poll no mesmo instante e olham o MESMO
    // lock órfão. Ambos o julgam morto. O primeiro move o órfão, cria o lock dele e entra na seção
    // crítica; o segundo — que já tinha a fotografia ANTIGA em mãos — só então executa o `rename`, e o
    // que ele move é o lock RECÉM-criado do vizinho. Resultado: dois escritores dentro da seção crítica
    // ao mesmo tempo, ou seja, exatamente o last-writer-wins que apaga um `revokedAt` — o defeito que
    // este módulo existe para não ter, de volta pela porta do conserto.
    //
    // `rename` ser atômico não fecha isso: a atomicidade vale para UM inode, e aqui o inode movido não
    // é o que foi julgado. O controle tem de comparar a fotografia com o que foi movido.
    //
    // O spy de `stat` reproduz a janela de forma determinística: ele devolve a leitura VELHA (órfã) e,
    // nesse exato ponto, o disco já carrega o lock NOVO do outro processo.
    const { record } = await createMcpHandle({ level: "orch" });
    const lock = mcpHandlesLockPath();
    writeFileSync(lock, "424242 morto\n", { mode: 0o600 });
    const velho = Date.now() - (HANDLE_LOCK_STALE_MS + 5_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(lock, velho / 1000, velho / 1000);

    const { promises: fsp } = await import("node:fs");
    const realStat = fsp.stat.bind(fsp);
    let injetado = false;
    const spy = vi.spyOn(fsp, "stat").mockImplementation(async (alvo, ...resto) => {
      const st = await realStat(alvo as string, ...(resto as []));
      if (!injetado && String(alvo) === lock) {
        injetado = true;
        // O VIZINHO venceu a corrida: quebrou o órfão e já está dentro da seção crítica.
        unlinkSync(lock);
        writeFileSync(lock, "999999 vizinho-dentro-da-secao-critica\n", { mode: 0o600 });
      }
      return st;
    });

    try {
      await expect(
        withMcpHandlesLock(async () => "entrou", { waitMs: 300 }),
        "entrou na seção crítica arrancando o lock de quem já estava dentro — dois escritores no registro",
      ).rejects.toThrow(McpHandleRegistryLockedError);
      expect(
        existsSync(lock) && readFileSync(lock, "utf8"),
        "o lock do vizinho foi REMOVIDO — ele segue escrevendo achando que é o único",
      ).toContain("999999");
    } finally {
      spy.mockRestore();
      // `force` porque no estado VULNERÁVEL o lock do vizinho já foi arrancado e removido — e uma
      // exceção de limpeza aqui esconderia a asserção que descreve o achado.
      rmSync(lock, { force: true });
    }

    // E o caminho normal continua funcionando depois: o órfão de verdade não trava a revogação.
    expect(await revokeMcpHandle(record.id)).toBe("revogado");
  }, 30_000);

  it("um lock ÓRFÃO (processo morto no meio) é quebrado — ele não pode travar a revogação para sempre", async () => {
    const { record } = await createMcpHandle({ level: "orch" });
    // Lock com mtime antigo: exatamente o que um SIGKILL no meio da escrita deixa para trás. Se o
    // órfão não fosse quebrado, uma máquina que levou um OOM ficaria sem NENHUM caminho de revogação
    // — o oposto do que este módulo existe para garantir.
    writeFileSync(mcpHandlesLockPath(), "424242 morto\n", { mode: 0o600 });
    const velho = Date.now() - (HANDLE_LOCK_STALE_MS + 5_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(mcpHandlesLockPath(), velho / 1000, velho / 1000);

    expect(await revokeMcpHandle(record.id)).toBe("revogado");
    expect(existsSync(mcpHandlesLockPath()), "o lock ficou para trás e travaria a próxima revogação").toBe(false);
  }, 30_000);
});
