// deploy-agent-spawn (D-AG3/D-AG4) — the prompt is assembled ONLY from board config + card facts, the
// verdict contract is parsed fail-closed, and the launch feeds the registry's DeployLaunch shape with
// every failure mode (garbage / non-zero exit / spawn error / timeout) becoming a FAILED completion.
// The spawn is faked (DI spawnFn) — no test ever runs a real claude.

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEPLOY_AGENT_MAX_TURNS,
  DEPLOY_AGENT_TIMEOUT_MINUTES_DEFAULT,
  buildDeployAgentPrompt,
  launchDeployAgent,
  parseDeployAgentVerdict,
  type DeployAgentSpec,
} from "./deploy-agent-spawn";

const spec = (o: Partial<DeployAgentSpec> = {}): DeployAgentSpec => ({
  kind: "agent",
  board: "acme",
  cardId: "story-1",
  description: "Rode `flyctl deploy` a partir da raiz e confirme o health em /api/health.",
  releasedSha: "aabbccdd",
  changedFiles: ["packages/acmeapp/api/x.ts"],
  healthUrl: "https://meuapp.com/api/health",
  ...o,
});

describe("buildDeployAgentPrompt — montado do BOARD CONFIG + fatos do card (D-AG3)", () => {
  it("carrega a receita do dono, o contexto do card e o contrato estrito de saída", () => {
    const p = buildDeployAgentPrompt(spec());
    expect(p).toContain("Rode `flyctl deploy`"); // deploy.description, verbatim
    expect(p).toContain("Board: acme");
    expect(p).toContain("Card: story-1");
    expect(p).toContain("sha de main): aabbccdd");
    expect(p).toContain("packages/acmeapp/api/x.ts");
    expect(p).toContain("https://meuapp.com/api/health");
    // o contrato: última linha = JSON {ok, liveSha?, evidence?, reason?}
    expect(p).toContain('"ok": true|false');
    expect(p).toContain("liveSha");
    expect(p).toMatch(/ÚLTIMA linha/);
  });

  it("capa a lista de arquivos (40) e anota o excedente — o prompt é bounded como o spawn", () => {
    const files = Array.from({ length: 55 }, (_, i) => `packages/x/f${i}.ts`);
    const p = buildDeployAgentPrompt(spec({ changedFiles: files }));
    expect(p).toContain("packages/x/f39.ts");
    expect(p).not.toContain("packages/x/f40.ts");
    expect(p).toContain("e mais 15 arquivo(s)");
  });

  it("sem releasedSha/card ⇒ o prompt diz explicitamente (nunca inventa contexto)", () => {
    const p = buildDeployAgentPrompt(spec({ cardId: undefined, releasedSha: undefined, changedFiles: [] }));
    expect(p).toContain("disparo manual");
    expect(p).toContain("sha não informado");
  });
});

describe("parseDeployAgentVerdict — contrato fail-closed (D-AG3)", () => {
  it("prosa antes + JSON na última linha ⇒ veredito válido", () => {
    const out = parseDeployAgentVerdict('Deploy rodou.\nHealth ok.\n{"ok": true, "liveSha": "eeff0011", "evidence": "curl 200"}\n');
    expect(out).toEqual({ ok: true, liveSha: "eeff0011", evidence: "curl 200" });
  });

  it("ok:false honesto com reason passa (a honestidade é o caminho barato)", () => {
    const out = parseDeployAgentVerdict('{"ok": false, "reason": "flyctl exit 1"}');
    expect(out).toEqual({ ok: false, reason: "flyctl exit 1" });
  });

  it("última linha não-JSON ⇒ erro legível (sem contrato, sem sucesso)", () => {
    const out = parseDeployAgentVerdict("Deploy concluído com sucesso!");
    expect(out).toMatchObject({ error: expect.stringContaining("não é JSON") });
  });

  it("`ok` ausente/não-booleano ⇒ erro (nunca coagido)", () => {
    expect(parseDeployAgentVerdict('{"liveSha": "eeff0011"}')).toMatchObject({ error: expect.stringContaining("`ok`") });
    expect(parseDeployAgentVerdict('{"ok": "true"}')).toMatchObject({ error: expect.stringContaining("`ok`") });
  });

  it("liveSha que não é sha git ⇒ o veredito INTEIRO é rejeitado (fail-closed)", () => {
    const out = parseDeployAgentVerdict('{"ok": true, "liveSha": "deploy feito"}');
    expect(out).toMatchObject({ error: expect.stringContaining("não é um sha git") });
  });

  it("stdout vazio ⇒ erro", () => {
    expect(parseDeployAgentVerdict("")).toMatchObject({ error: expect.stringContaining("não escreveu nada") });
  });
});

// A fake child in the exact EventEmitter shape launchDeployAgent consumes — drives every completion path
// without child_process. kill() is recorded so the timeout path proves the SIGKILL.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  kills: string[] = [];
  kill(sig?: string) {
    this.kills.push(String(sig));
    return true;
  }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "harness-deploy-agent-test-"));
let logSeq = 0;

/** O diretório dos logs de agente é APAGADO no fim — cada passada do portão deixava um
 *  `/tmp/harness-deploy-agent-test-XXXXXX` para trás. A remoção vem DEPOIS de todos os testes (e portanto
 *  depois do `out.end()` de cada launch): o fd do stream sobrevive ao unlink, o diretório não. */
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function launchFake(opts: { timeoutMs?: number; spec?: DeployAgentSpec; throwOnSpawn?: boolean } = {}) {
  const child = new FakeChild();
  const spawnArgs: { bin: string; args: string[]; cwd?: string } = { bin: "", args: [] };
  const launch = launchDeployAgent(opts.spec ?? spec(), {
    logFile: path.join(tmp, `agent-${(logSeq += 1)}.log`),
    repoRoot: "/repo",
    claudeBin: "claude",
    timeoutMs: opts.timeoutMs ?? 5_000,
    spawnFn: ((bin: string, args: string[], o: { cwd?: string }) => {
      if (opts.throwOnSpawn) throw new Error("ENOENT claude");
      spawnArgs.bin = bin;
      spawnArgs.args = args;
      spawnArgs.cwd = o.cwd;
      return child;
    }) as never,
  });
  const done = new Promise<number | null>((resolve) => launch.whenDone(resolve));
  return { child, launch, done, spawnArgs };
}

describe("launchDeployAgent — spawn bounded que alimenta o ciclo do registry (D-AG3)", () => {
  it("spawna com o prompt, o teto de turnos e o cwd do repo (padrão resolution-judge)", () => {
    const { spawnArgs } = launchFake();
    expect(spawnArgs.bin).toBe("claude");
    expect(spawnArgs.cwd).toBe("/repo");
    expect(spawnArgs.args[0]).toBe("-p");
    expect(spawnArgs.args[1]).toContain("Rode `flyctl deploy`"); // o prompt montado da config
    expect(spawnArgs.args).toContain("--max-turns");
    expect(spawnArgs.args).toContain(String(DEPLOY_AGENT_MAX_TURNS));
    expect(spawnArgs.args).toContain("--dangerously-skip-permissions");
  });

  it("exit 0 + veredito ok/liveSha ⇒ completa 0 e expõe o veredito (o registry o lê no close)", async () => {
    const { child, launch, done } = launchFake();
    child.stdout.emit("data", Buffer.from("Publicando…\n"));
    child.stdout.emit("data", Buffer.from('{"ok": true, "liveSha": "eeff0011"}\n'));
    child.emit("close", 0);
    await expect(done).resolves.toBe(0);
    expect(launch.verdict?.()).toEqual({ ok: true, liveSha: "eeff0011" });
  });

  it("exit 0 + veredito ok:false honesto ⇒ completa 1 (deploy FALHOU no ciclo do registry)", async () => {
    const { child, launch, done } = launchFake();
    child.stdout.emit("data", Buffer.from('{"ok": false, "reason": "health 500"}\n'));
    child.emit("close", 0);
    await expect(done).resolves.toBe(1);
    expect(launch.verdict?.()).toMatchObject({ ok: false, reason: "health 500" });
  });

  it("exit 0 + stdout fora do contrato ⇒ completa 1 com o motivo do parse (fail-closed)", async () => {
    const { child, launch, done } = launchFake();
    child.stdout.emit("data", Buffer.from("deploy feito, tudo certo!\n"));
    child.emit("close", 0);
    await expect(done).resolves.toBe(1);
    expect(launch.verdict?.()).toMatchObject({ ok: false, reason: expect.stringContaining("não é JSON") });
  });

  it("exit ≠ 0 ⇒ falha SEM ler veredito (um agente que morreu não confirma deploy nenhum)", async () => {
    const { child, launch, done } = launchFake();
    child.stdout.emit("data", Buffer.from('{"ok": true, "liveSha": "eeff0011"}\n')); // alegou… e morreu
    child.emit("close", 3);
    await expect(done).resolves.toBe(3);
    expect(launch.verdict?.()).toMatchObject({ ok: false, reason: expect.stringContaining("exit 3") });
  });

  it("erro de spawn (evento) ⇒ falha -1 com o porquê", async () => {
    const { child, launch, done } = launchFake();
    child.emit("error", new Error("EACCES"));
    await expect(done).resolves.toBe(-1);
    expect(launch.verdict?.()).toMatchObject({ ok: false, reason: expect.stringContaining("EACCES") });
  });

  it("spawn síncrono que LANÇA ⇒ falha -1 depois do whenDone registrar (nunca explode o start do registry)", async () => {
    const { done, launch } = launchFake({ throwOnSpawn: true });
    await expect(done).resolves.toBe(-1);
    expect(launch.verdict?.()).toMatchObject({ ok: false, reason: expect.stringContaining("spawn do agente") });
  });

  it("timeout ⇒ SIGKILL + falha -1 (orçamento explícito; default 15min quando o board não declara)", async () => {
    expect(DEPLOY_AGENT_TIMEOUT_MINUTES_DEFAULT).toBe(15);
    const { child, launch, done } = launchFake({ timeoutMs: 20 });
    // nunca emite close → o timer decide
    await expect(done).resolves.toBe(-1);
    expect(child.kills).toEqual(["SIGKILL"]);
    expect(launch.verdict?.()).toMatchObject({ ok: false, reason: expect.stringContaining("orçamento") });
    child.emit("close", 137); // o close tardio do kill NÃO re-settla (guard settled)
    expect(launch.verdict?.()).toMatchObject({ ok: false, reason: expect.stringContaining("orçamento") });
  });
});
