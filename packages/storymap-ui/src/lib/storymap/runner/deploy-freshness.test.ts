// O PREFLIGHT DE FRESCOR, medido sobre git REAL (o padrão de convergence/release: repositórios descartáveis,
// isolados por `isolatedGitExec`). Mockar o git aqui não mediria nada — a pergunta inteira é "o que o git diz
// sobre ESTE checkout contra o upstream", e o defeito que o módulo existe para impedir (medido 2026-09-24) só
// aparece com um SEGUNDO clone empurrando para o mesmo upstream: o dono publicando de outra máquina.
//
// Cada caso monta o seu trio: `origin.git` (o upstream), `work` (o checkout de RUNTIME, de onde o serviço
// publica) e `other` (a outra máquina). Escopo do deploy nos casos: `packages/app/` — e há um arquivo
// rastreado FORA dele (`.claude/settings.local.json`) para medir que sujeira fora do escopo não recusa.

import { exec as nodeExec } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  checkDeployFreshness,
  DEPLOY_CLEARANCE_TTL_MS,
  dirtyInScope,
  freshnessDisabledByOperator,
  legacyTargetFreshnessInputs,
  parseLiveShas,
  parsePorcelainZ,
  pathInScope,
  redeemDeployClearance,
  type DeployFreshnessRequest,
} from "./deploy-freshness";
import { isolatedGitExec } from "./git-test-env";
import { describePosix } from "./test-platform";
import type { ExecFn } from "./worktree";

const baseExec = promisify(nodeExec) as unknown as ExecFn;
const SCOPE = ["packages/app/"];
const OFF = { AGILEHARNESS_DEPLOY_FRESHNESS: "off" };
const roots: string[] = [];

afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  for (const r of roots) await fsp.rm(r, { recursive: true, force: true });
});

interface Fixture {
  exec: ExecFn;
  work: string;
  other: string;
  origin: string;
  git: (cwd: string, cmd: string) => Promise<string>;
  commit: (cwd: string, file: string, body: string, msg: string) => Promise<string>;
}

async function fixture(): Promise<Fixture> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ah-freshness-"));
  roots.push(root);
  const exec = isolatedGitExec(baseExec, root);
  const git = async (cwd: string, cmd: string) => (await exec(`git ${cmd}`, { cwd })).stdout.trim();
  const write = async (cwd: string, file: string, body: string) => {
    await fsp.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await fsp.writeFile(path.join(cwd, file), body);
  };
  const commit = async (cwd: string, file: string, body: string, msg: string) => {
    await write(cwd, file, body);
    await git(cwd, "add -A");
    await git(cwd, `commit -q --no-verify -m ${JSON.stringify(msg)}`);
    return git(cwd, "rev-parse HEAD");
  };
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  await fsp.mkdir(origin);
  await git(origin, "init -q --bare -b main");
  await fsp.mkdir(work);
  await git(work, "init -q -b main");
  await git(work, "config user.email t@t.dev");
  await git(work, "config user.name tester");
  await write(work, ".claude/settings.local.json", "{}\n");
  await commit(work, "packages/app/a.ts", "export const a = 1;\n", "base");
  await git(work, `remote add origin ${JSON.stringify(origin)}`);
  await git(work, "push -q -u origin main");
  await git(root, `clone -q ${JSON.stringify(origin)} other`);
  await git(other, "config user.email o@t.dev");
  await git(other, "config user.name other");
  return { exec, work, other, origin, git, commit };
}

/** Roda o preflight como o serviço rodaria, capturando o log (a recusa e o "pulado" têm de ser VISÍVEIS). */
async function preflight(
  f: Fixture,
  over: Partial<DeployFreshnessRequest> = {},
  deps: { env?: Record<string, string | undefined>; exec?: ExecFn } = {},
) {
  const lines: string[] = [];
  const verdict = await checkDeployFreshness(
    { target: "app", repoRoot: f.work, scope: SCOPE, label: "teste", ...over },
    {
      exec: deps.exec ?? f.exec,
      env: deps.env ?? {},
      log: (level, line) => lines.push(`${level}: ${line}`),
    },
  );
  return { verdict, log: lines.join("\n") };
}

/** Um exec que responde o `liveShaCommand` declarado (`just live-sha`) e delega todo o resto ao git real. */
function withLiveSha(f: Fixture, answer: () => Promise<string>): ExecFn {
  return (async (cmd, opts) => {
    if (cmd.startsWith("'just'")) return { stdout: await answer(), stderr: "" };
    return f.exec(cmd, opts);
  }) as ExecFn;
}

describePosix("checkDeployFreshness — o checkout de runtime carrega o que está no ar? (git real)", () => {
  it("EM DIA com o upstream ⇒ autoriza, e diz que a ancestralidade do sha no ar foi PULADA (não aprovada em silêncio)", async () => {
    const f = await fixture();
    const { verdict, log } = await preflight(f);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.bypassed).toBe(false);
    expect(verdict.clearance.target).toBe("app");
    expect(verdict.clearance.head).toBe(await f.git(f.work, "rev-parse HEAD"));
    // a linha explícita de "não checado" — o requisito é nunca passar calado
    expect(log).toMatch(/liveShaCommand não declarado.*NÃO checada/);
    // e a autorização é resgatável pelo alvo certo (uma vez)
    expect(redeemDeployClearance(verdict.clearance, "app")).toBeNull();
  });

  it("ATRÁS do upstream (a outra máquina publicou) ⇒ RECUSA, nomeando quantos commits e o pull — e prova que BUSCOU", async () => {
    const f = await fixture();
    // o dono empurra de OUTRA máquina; o checkout de runtime nunca fez fetch disto
    await f.commit(f.other, "packages/app/a.ts", "export const a = 2;\n", "fix de outra máquina");
    await f.git(f.other, "push -q origin main");
    const antes = await f.git(f.work, "rev-list --count HEAD..origin/main");
    expect(antes, "sem fetch o checkout nem SABE que está atrás — é o que o preflight tem de descobrir").toBe("0");

    const { verdict, log } = await preflight(f);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("behind");
    expect(verdict.reason).toContain("1 commit(s) ATRÁS de origin/main");
    expect(verdict.reason).toContain("pull --ff-only");
    expect(log).toMatch(/RECUSADO \(behind\)/);
    // a recusa veio de MEDIÇÃO: o fetch trouxe o upstream para o checkout
    expect(await f.git(f.work, "rev-list --count HEAD..origin/main")).toBe("1");
  });

  it("DIVERGIU (commit local não publicado + upstream andou) ⇒ RECUSA como atraso, dizendo que divergiu", async () => {
    const f = await fixture();
    await f.commit(f.other, "packages/app/b.ts", "export const b = 1;\n", "da outra máquina");
    await f.git(f.other, "push -q origin main");
    await f.commit(f.work, "packages/app/c.ts", "export const c = 1;\n", "local");
    const { verdict } = await preflight(f);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("behind");
    expect(verdict.reason).toContain("DIVERGIU");
  });

  it("À FRENTE do upstream (commit local ainda não empurrado) NÃO é atraso ⇒ autoriza", async () => {
    const f = await fixture();
    await f.commit(f.work, "packages/app/c.ts", "export const c = 1;\n", "local");
    const { verdict } = await preflight(f);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.summary).toContain("+1 à frente");
  });

  it("SUJO DENTRO do escopo (arquivo rastreado modificado, não commitado) ⇒ RECUSA nomeando o arquivo", async () => {
    const f = await fixture();
    await fsp.writeFile(path.join(f.work, "packages/app/a.ts"), "export const a = 999;\n");
    const { verdict } = await preflight(f);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("dirty");
    expect(verdict.reason).toContain("packages/app/a.ts");
  });

  it("SUJO DENTRO do escopo só no ÍNDICE (staged, não commitado) também RECUSA", async () => {
    const f = await fixture();
    await fsp.writeFile(path.join(f.work, "packages/app/a.ts"), "export const a = 3;\n");
    await f.git(f.work, "add packages/app/a.ts");
    const { verdict } = await preflight(f);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("dirty");
  });

  it("SUJO só FORA do escopo (a config local da ferramenta) ⇒ autoriza, e conta o que ignorou", async () => {
    const f = await fixture();
    await fsp.writeFile(path.join(f.work, ".claude/settings.local.json"), '{"local":true}\n');
    const { verdict } = await preflight(f);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.summary).toContain("1 arquivo(s) sujo(s) FORA do escopo ignorado(s)");
  });

  it("escopo VAZIO significa o repositório INTEIRO — não saber o escopo não vira 'nada a checar'", async () => {
    const f = await fixture();
    await fsp.writeFile(path.join(f.work, ".claude/settings.local.json"), '{"local":true}\n');
    const { verdict } = await preflight(f, { scope: [] });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("dirty");
  });

  it("SEM upstream (branch local sem rastreio) ⇒ RECUSA", async () => {
    const f = await fixture();
    await f.git(f.work, "checkout -q -b solto");
    const { verdict } = await preflight(f);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("no-upstream");
    expect(verdict.reason).toContain("set-upstream-to");
  });

  it("HEAD DESTACADO ⇒ RECUSA (sem branch não há upstream para comparar)", async () => {
    const f = await fixture();
    await f.git(f.work, "checkout -q --detach HEAD");
    const { verdict } = await preflight(f);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("detached-head");
  });

  it("o FETCH falha (upstream inalcançável) ⇒ RECUSA — sem o estado do upstream não há prova", async () => {
    const f = await fixture();
    await f.git(f.work, `remote set-url origin ${JSON.stringify(path.join(f.origin, "..", "nao-existe.git"))}`);
    const { verdict } = await preflight(f);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("fetch-failed");
    expect(verdict.reason).toContain("git fetch");
  });

  // ── deploy.liveShaCommand: o HEAD tem de DESCENDER do que está no ar ──────────────────────────────────
  describe("com deploy.liveShaCommand declarado (`just live-sha`, receita liberada pelo env do serviço)", () => {
    const LIVE = ["just live-sha"];

    it("o sha no ar é ANCESTRAL do HEAD ⇒ autoriza, dizendo o que mediu", async () => {
      vi.stubEnv("AGILEHARNESS_DEPLOY_RECIPES", "live-sha");
      const f = await fixture();
      const live = await f.git(f.work, "rev-parse HEAD");
      await f.commit(f.work, "packages/app/c.ts", "export const c = 1;\n", "novo, ainda não no ar");
      const { verdict } = await preflight(f, { liveShaCommands: LIVE }, { exec: withLiveSha(f, async () => `${live}\n`) });
      expect(verdict.ok).toBe(true);
      if (verdict.ok) expect(verdict.summary).toContain(`sha(s) no ar ${live.slice(0, 10)} ancestral(is) do HEAD`);
    });

    it("VÁRIAS unidades (um sha por linha), todas ancestrais ⇒ autoriza", async () => {
      vi.stubEnv("AGILEHARNESS_DEPLOY_RECIPES", "live-sha");
      const f = await fixture();
      const velho = await f.git(f.work, "rev-parse HEAD");
      const novo = await f.commit(f.work, "packages/app/c.ts", "export const c = 1;\n", "c");
      await f.git(f.work, "push -q origin main");
      const { verdict } = await preflight(f, { liveShaCommands: LIVE }, { exec: withLiveSha(f, async () => `${velho}\n\n${novo.slice(0, 12)}\n`) });
      expect(verdict.ok).toBe(true);
    });

    it("o ar está À FRENTE do HEAD (publicado de um commit que este checkout não tem no branch) ⇒ RECUSA", async () => {
      vi.stubEnv("AGILEHARNESS_DEPLOY_RECIPES", "live-sha");
      const f = await fixture();
      await f.git(f.work, "checkout -q -b publicado-a-frente");
      const aFrente = await f.commit(f.work, "packages/app/c.ts", "export const c = 1;\n", "no ar, à frente");
      await f.git(f.work, "checkout -q main");
      const { verdict } = await preflight(f, { liveShaCommands: LIVE }, { exec: withLiveSha(f, async () => aFrente) });
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.code).toBe("live-not-ancestor");
      expect(verdict.reason).toContain(aFrente.slice(0, 10));
    });

    it("o ar DIVERGIU do HEAD (irmão, não ancestral) ⇒ RECUSA", async () => {
      vi.stubEnv("AGILEHARNESS_DEPLOY_RECIPES", "live-sha");
      const f = await fixture();
      const base = await f.git(f.work, "rev-parse HEAD");
      await f.commit(f.work, "packages/app/b.ts", "export const b = 1;\n", "main anda");
      await f.git(f.work, "push -q origin main");
      await f.git(f.work, `checkout -q -b hotfix ${base}`);
      const irmao = await f.commit(f.work, "packages/app/h.ts", "export const h = 1;\n", "hotfix publicado");
      await f.git(f.work, "checkout -q main");
      const { verdict } = await preflight(f, { liveShaCommands: LIVE }, { exec: withLiveSha(f, async () => irmao) });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe("live-not-ancestor");
    });

    it("o sha no ar NÃO EXISTE neste checkout (nunca chegou ao upstream) ⇒ RECUSA", async () => {
      vi.stubEnv("AGILEHARNESS_DEPLOY_RECIPES", "live-sha");
      const f = await fixture();
      const { verdict } = await preflight(f, { liveShaCommands: LIVE }, {
        exec: withLiveSha(f, async () => "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
      });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe("live-sha-unknown");
    });

    it("o comando FALHA ⇒ RECUSA (fail-closed)", async () => {
      vi.stubEnv("AGILEHARNESS_DEPLOY_RECIPES", "live-sha");
      const f = await fixture();
      const { verdict } = await preflight(f, { liveShaCommands: LIVE }, {
        exec: withLiveSha(f, async () => {
          throw Object.assign(new Error("exit 1"), { code: 1, stderr: "gcloud: not authenticated" });
        }),
      });
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.code).toBe("live-sha-failed");
      expect(verdict.reason).toContain("gcloud: not authenticated");
    });

    it("o comando imprime LIXO ⇒ RECUSA (não é sha, não é aprovação)", async () => {
      vi.stubEnv("AGILEHARNESS_DEPLOY_RECIPES", "live-sha");
      const f = await fixture();
      const { verdict } = await preflight(f, { liveShaCommands: LIVE }, { exec: withLiveSha(f, async () => "v1.2.3 (latest)\n") });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe("live-sha-garbage");
    });

    it("a régua dos comandos declarados vale: receita fora da allow-list ⇒ RECUSA sem executar nada", async () => {
      // sem AGILEHARNESS_DEPLOY_RECIPES a receita `live-sha` não é alcançável de board-data
      const f = await fixture();
      const answer = vi.fn(async () => "x");
      const { verdict } = await preflight(f, { liveShaCommands: LIVE }, { exec: withLiveSha(f, answer) });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe("live-sha-refused");
      expect(answer).not.toHaveBeenCalled();
    });
  });

  // ── O escape humano ─────────────────────────────────────────────────────────────────────────────────
  it("AGILEHARNESS_DEPLOY_FRESHNESS=off ⇒ autoriza MESMO atrás do upstream, e GRITA no log", async () => {
    const f = await fixture();
    await f.commit(f.other, "packages/app/a.ts", "export const a = 2;\n", "fix de outra máquina");
    await f.git(f.other, "push -q origin main");
    const exec = vi.fn(f.exec);
    const { verdict, log } = await preflight(f, {}, { env: OFF, exec: exec as unknown as ExecFn });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.bypassed).toBe(true);
    expect(verdict.clearance.bypassed).toBe(true);
    expect(log).toMatch(/^warn: .*PREFLIGHT DE FRESCOR DESLIGADO por AGILEHARNESS_DEPLOY_FRESHNESS=off/m);
    expect(exec, "o escape não mede nada — e diz isso").not.toHaveBeenCalled();
  });

  it("qualquer valor que não seja `off` NÃO desliga (o erro de digitação cai do lado seguro) — e avisa", async () => {
    const f = await fixture();
    await f.commit(f.other, "packages/app/a.ts", "export const a = 2;\n", "fix de outra máquina");
    await f.git(f.other, "push -q origin main");
    const { verdict, log } = await preflight(f, {}, { env: { AGILEHARNESS_DEPLOY_FRESHNESS: "0" } });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("behind");
    expect(log).toMatch(/IGNORADO — só "off" desliga/);
  });

  it("o escape é lido NA HORA de cada chamada (process.env), sem restart", async () => {
    const f = await fixture();
    await f.commit(f.other, "packages/app/a.ts", "export const a = 2;\n", "x");
    await f.git(f.other, "push -q origin main");
    const run = () =>
      checkDeployFreshness({ target: "app", repoRoot: f.work, scope: SCOPE, label: "t" }, { exec: f.exec, log: () => {} });
    vi.stubEnv("AGILEHARNESS_DEPLOY_FRESHNESS", "off");
    expect((await run()).ok).toBe(true);
    vi.stubEnv("AGILEHARNESS_DEPLOY_FRESHNESS", "");
    expect((await run()).ok).toBe(false);
  });
});

// ── A autorização: só o preflight cunha, amarrada ao alvo, uso único, validade curta ────────────────────
describe("redeemDeployClearance — a autorização não se forja, não se reusa, não se desvia", () => {
  const cunhar = async (target: string, now = () => 1_000) => {
    const v = await checkDeployFreshness(
      { target, repoRoot: "/r", scope: [], label: "t" },
      { exec: baseExec, env: OFF, log: () => {}, now },
    );
    if (!v.ok) throw new Error("escape deveria cunhar");
    return v.clearance;
  };

  it("um objeto com o MESMO formato (ou `as DeployClearance`) não é autorização", () => {
    const forjada = { target: "app", repoRoot: "/r", head: null, issuedAt: Date.now(), bypassed: false, summary: "" };
    expect(redeemDeployClearance(forjada, "app")).toMatch(/sem autorização do preflight/);
    expect(redeemDeployClearance(undefined, "app")).toMatch(/sem autorização do preflight/);
  });

  it("vale UMA vez: resgatada, deixa de valer", async () => {
    const c = await cunhar("app");
    expect(redeemDeployClearance(c, "app", 1_000)).toBeNull();
    expect(redeemDeployClearance(c, "app", 1_000)).toMatch(/sem autorização/);
  });

  it("amarrada ao ALVO: a de um alvo não lança outro", async () => {
    const c = await cunhar("backend");
    expect(redeemDeployClearance(c, "face", 1_000)).toMatch(/emitida para "backend" usada para lançar "face"/);
  });

  it("VENCE: cunhada e guardada além do teto não lança", async () => {
    const c = await cunhar("app");
    expect(redeemDeployClearance(c, "app", 1_000 + DEPLOY_CLEARANCE_TTL_MS + 1)).toMatch(/VENCIDA/);
  });
});

describe("partes puras do preflight", () => {
  it("parsePorcelainZ: modificado, staged e RENOMEADO (os dois caminhos contam)", () => {
    const out = [" M packages/app/a.ts", "R  packages/app/novo.ts", "fora/velho.ts", "M  .claude/x.json", ""].join("\0");
    expect(parsePorcelainZ(out)).toEqual(["packages/app/a.ts", "packages/app/novo.ts", "fora/velho.ts", ".claude/x.json"]);
    expect(parsePorcelainZ("")).toEqual([]);
  });

  it("pathInScope: prefixo de diretório, arquivo exato, e escopo vazio = tudo", () => {
    expect(pathInScope("packages/app/a.ts", ["packages/app/"])).toBe(true);
    expect(pathInScope("packages/application/a.ts", ["packages/app/"])).toBe(false); // prefixo com `/` não vaza
    expect(pathInScope("bun.lockb", ["bun.lockb"])).toBe(true);
    expect(pathInScope("tools/x/y.js", ["tools/x"])).toBe(true);
    expect(pathInScope(".claude/settings.local.json", [])).toBe(true);
    expect(dirtyInScope(["packages/app/a.ts", ".claude/s.json", "packages/app/a.ts"], ["packages/app/"])).toEqual([
      "packages/app/a.ts",
    ]);
  });

  it("parseLiveShas: um ou mais shas por linha; qualquer outra coisa é lixo (null)", () => {
    expect(parseLiveShas("ABCDEF1234\n")).toEqual(["abcdef1234"]);
    expect(parseLiveShas("abc1234\n\n abc1234 \ndef5678\n")).toEqual(["abc1234", "def5678"]);
    expect(parseLiveShas("")).toBeNull();
    expect(parseLiveShas("   \n")).toBeNull();
    expect(parseLiveShas("abc1234\ndeployed ok")).toBeNull();
    expect(parseLiveShas("abc12")).toBeNull(); // curto demais para ser um sha
    expect(parseLiveShas(Array.from({ length: 65 }, () => "abc1234").join("\n"))).toBeNull();
  });

  it("só `off` desliga", () => {
    expect(freshnessDisabledByOperator({ AGILEHARNESS_DEPLOY_FRESHNESS: "off" })).toBe(true);
    expect(freshnessDisabledByOperator({ AGILEHARNESS_DEPLOY_FRESHNESS: " OFF " })).toBe(true);
    for (const v of [undefined, "", "0", "false", "no", "disabled"]) {
      expect(freshnessDisabledByOperator({ AGILEHARNESS_DEPLOY_FRESHNESS: v })).toBe(false);
    }
  });

  it("legacyTargetFreshnessInputs: o escopo dos boards que publicam o alvo; sem board, a convenção packages/<alvo>/", () => {
    const boards = [
      { package: "packages/app", scope: ["packages/app/", "packages/shared/"], liveShaCommand: "just live-sha" },
      { package: "packages/other", scope: ["packages/other/"], liveShaCommand: "just outro" },
      { package: "packages/app/", scope: ["packages/app/"], liveShaCommand: "just live-sha" },
    ];
    expect(legacyTargetFreshnessInputs("app", boards)).toEqual({
      scope: ["packages/app/", "packages/shared/"],
      liveShaCommands: ["just live-sha"],
    });
    expect(legacyTargetFreshnessInputs("sem-board", boards)).toEqual({ scope: ["packages/sem-board/"], liveShaCommands: [] });
  });
});
