// O PREFLIGHT DE FRESCOR É OBRIGAÇÃO, não convenção — o censo e a fiação de cada caminho de deploy de produto.
//
// Três camadas, porque cada uma sozinha é teatro:
//   1. o REGISTRY (`ProductDeployRegistry.start`) — onde todo deploy de produto vira processo — não lança sem
//      uma autorização que só o preflight cunha (um WeakSet privado: `as DeployClearance` não forja);
//   2. cada CAMINHO que lança (pipeline declarado command/agent, `orch-deploy` legado, face encadeada, tool MCP)
//      RECUSA quando o preflight recusa, sem lançar nada — e a recusa sai com o motivo (e, com card, reverte);
//   3. o CENSO de fonte: toda superfície de produção que lança pelo registry está registrada aqui e passa a
//      autorização do preflight em CADA `start` — uma superfície nova reprova até ser registrada, e o
//      registro é o momento em que alguém decide que ela passa pelo preflight. Mais: nenhum chamador de
//      produção injeta o `env` do escape (ele tem de vir do env do SERVIÇO), e só o registry resgata.
//
// A face composta é config do alvo (settings.yaml), que este repositório não declara — por isso as quatro
// funções que a descrevem são substituídas aqui por uma face de fixture. O resto do módulo é o REAL.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const faceFixture = vi.hoisted(() => ({ target: "face-x" as string | null }));
vi.mock("./product-deploy", async (orig) => {
  const actual = await orig<typeof import("./product-deploy")>();
  return {
    ...actual,
    composedFaceTarget: () => faceFixture.target,
    touchesComposedFace: (files: string[]) => files.some((f) => f.startsWith("packages/app/web/")),
    composedFacePrefixes: () => ["packages/app/web/"],
    composedFaceFiles: () => ["bun.lockb"],
  };
});

import { deployBoard, type DeployFreshnessGate } from "./deploy";
import { ProductDeployRegistry, type DeployLauncher, type DeployLaunchSpec } from "./product-deploy";
import { checkDeployFreshness, type DeployFreshnessRequest } from "./deploy-freshness";
import type { ExecFn } from "./worktree";

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────

/** O único caminho que cunha sem medir git: o escape HUMANO. A autorização é REAL. */
const liberar: DeployFreshnessGate = (req) =>
  checkDeployFreshness(req, {
    exec: async () => {
      throw new Error("o escape não mede git");
    },
    env: { AGILEHARNESS_DEPLOY_FRESHNESS: "off" },
    log: () => {},
  });

/** Um preflight que RECUSA (registra o que lhe pediram). */
function recusar(reason = "o checkout está 3 commit(s) ATRÁS de origin/main") {
  const pedidos: DeployFreshnessRequest[] = [];
  const gate: DeployFreshnessGate = async (req) => {
    pedidos.push(req);
    return { ok: false, code: "behind", reason };
  };
  return { gate, pedidos };
}

/** Libera uns alvos e recusa outros (a face encadeada tem o PRÓPRIO preflight). */
function porAlvo(recusados: string[]) {
  const pedidos: DeployFreshnessRequest[] = [];
  const gate: DeployFreshnessGate = async (req) => {
    pedidos.push(req);
    return recusados.includes(req.target) ? { ok: false, code: "behind", reason: `${req.target} atrás` } : liberar(req);
  };
  return { gate, pedidos };
}

function launcher() {
  const started: { target: string; spec?: DeployLaunchSpec }[] = [];
  const dones = new Map<string, (code: number | null) => void>();
  const l: DeployLauncher = (target, _log, spec) => {
    started.push({ target, spec });
    return { pid: 1, whenDone: (cb) => dones.set(target, cb) };
  };
  return { launcher: l, started, finish: (t: string, code: number) => dones.get(t)?.(code) };
}

const execGravador = () => {
  const calls: string[] = [];
  const exec: ExecFn = async (cmd) => {
    calls.push(cmd);
    return { stdout: "", stderr: "" };
  };
  return { exec, calls };
};

const drenar = () => new Promise<void>((r) => setTimeout(r, 0));
const ESCOPO = ["packages/app/", "packages/shared/"];

// ── 1. o registry ──────────────────────────────────────────────────────────────────────────────────────
describe("ProductDeployRegistry.start — nenhum deploy de produto lança sem a autorização do preflight", () => {
  it("sem autorização, com uma FORJADA, com a de OUTRO alvo ou REUSADA ⇒ lança erro e o launcher NÃO roda", async () => {
    const f = launcher();
    const reg = new ProductDeployRegistry(f.launcher);
    expect(() => reg.start("app", undefined as never)).toThrow(/sem autorização do preflight de frescor/);
    const forjada = { target: "app", repoRoot: "/r", head: "x", issuedAt: Date.now(), bypassed: false, summary: "" };
    expect(() => reg.start("app", forjada as never)).toThrow(/sem autorização/);
    const deOutro = await liberar({ target: "outro", repoRoot: "/r", scope: [], label: "t" });
    if (!deOutro.ok) throw new Error("escape deveria cunhar");
    expect(() => reg.start("app", deOutro.clearance)).toThrow(/emitida para "outro"/);
    expect(f.started).toEqual([]);

    // NÃO-VACUIDADE: a autorização certa lança — uma vez.
    const v = await liberar({ target: "app", repoRoot: "/r", scope: [], label: "t" });
    if (!v.ok) throw new Error("escape deveria cunhar");
    reg.start("app", v.clearance);
    expect(f.started.map((s) => s.target)).toEqual(["app"]);
    f.finish("app", 0);
    expect(() => reg.start("app", v.clearance), "autorização é de uso único").toThrow(/sem autorização/);
    expect(f.started).toHaveLength(1);
  });
});

// ── 2. cada caminho de deploy de produto ─────────────────────────────────────────────────────────────────
describe("deployBoard — cada caminho de deploy de produto passa pelo preflight, e RECUSA quando ele recusa", () => {
  const base = { repoRoot: "/repo", board: "nest", cardId: "s1", deployScope: ESCOPO, deployTargets: ["app"] as const };

  it("kind:command — recusado ⇒ nada lança, a recusa sai nomeada; o preflight recebeu alvo, escopo e liveShaCommand", async () => {
    const f = launcher();
    const { exec, calls } = execGravador();
    const r = recusar();
    const res = await deployBoard({
      ...base,
      exec,
      boardPackage: "packages/app",
      boardDeploy: { kind: "command", command: "vercel deploy --prod", liveShaCommand: "just live-sha" },
      productDeploy: new ProductDeployRegistry(f.launcher),
      freshness: r.gate,
    });
    expect(res.fired).toBe(false);
    expect(res.tool).toBe("board-command");
    expect(res.freshnessRefused).toEqual({ code: "behind", reason: "o checkout está 3 commit(s) ATRÁS de origin/main" });
    expect(res.reason).toMatch(/RECUSADO pelo preflight de frescor.*ATRÁS/);
    expect(f.started).toEqual([]);
    expect(calls).toEqual([]);
    expect(r.pedidos).toEqual([
      { target: "nest", repoRoot: "/repo", scope: ESCOPO, liveShaCommands: ["just live-sha"], label: "board nest" },
    ]);
  });

  it("kind:command — liberado ⇒ lança (não-vacuidade)", async () => {
    const f = launcher();
    const res = await deployBoard({
      ...base,
      exec: execGravador().exec,
      boardPackage: "packages/app",
      boardDeploy: { kind: "command", command: "vercel deploy --prod" },
      productDeploy: new ProductDeployRegistry(f.launcher),
      freshness: liberar,
    });
    expect(res.fired).toBe(true);
    expect(f.started.map((s) => s.target)).toEqual(["nest"]);
  });

  it("kind:agent — recusado ⇒ nenhum agente de deploy é lançado", async () => {
    const f = launcher();
    const settle = vi.fn(async () => null);
    const res = await deployBoard({
      ...base,
      exec: execGravador().exec,
      boardPackage: undefined,
      boardDeploy: { kind: "agent", description: "rode flyctl deploy" },
      productDeploy: new ProductDeployRegistry(f.launcher),
      freshness: recusar().gate,
      settle,
    });
    expect(res.fired).toBe(false);
    expect(res.tool).toBe("deploy-agent");
    expect(res.freshnessRefused?.code).toBe("behind");
    expect(f.started).toEqual([]);
    expect(settle).not.toHaveBeenCalled();
  });

  it("orch-deploy LEGADO (alvo por package) — recusado ⇒ nada lança; liberado ⇒ lança", async () => {
    const f = launcher();
    const reg = new ProductDeployRegistry(f.launcher);
    const r = recusar();
    const res = await deployBoard({ ...base, exec: execGravador().exec, boardPackage: "packages/app", productDeploy: reg, freshness: r.gate });
    expect(res).toMatchObject({ fired: false, tool: "orch-deploy", pkg: "app", freshnessRefused: { code: "behind" } });
    expect(f.started).toEqual([]);
    expect(r.pedidos[0]).toMatchObject({ target: "app", scope: ESCOPO });

    const ok = await deployBoard({ ...base, exec: execGravador().exec, boardPackage: "packages/app", productDeploy: reg, freshness: liberar });
    expect(ok.fired).toBe(true);
    expect(f.started.map((s) => s.target)).toEqual(["app"]);
  });

  it("o preflight AGUARDA (fetch): se outro caminho disparou o mesmo alvo enquanto ele media, NÃO lança duplicado", async () => {
    const f = launcher();
    const reg = new ProductDeployRegistry(f.launcher);
    // enquanto o preflight deste deploy mede, outro caminho (a tool MCP, outro card) lança o mesmo alvo
    const concorrente: DeployFreshnessGate = async (req) => {
      const outro = await liberar(req);
      if (outro.ok) reg.start(req.target, outro.clearance);
      return liberar(req);
    };
    const res = await deployBoard({ ...base, exec: execGravador().exec, boardPackage: "packages/app", productDeploy: reg, freshness: concorrente });
    expect(res.fired).toBe(false);
    expect(res.reason).toMatch(/já em andamento/);
    expect(f.started.map((s) => s.target)).toEqual(["app"]); // só o do outro caminho
  });

  it("face ENCADEADA — tem o PRÓPRIO preflight (outro alvo, escopo ⊕ face, sem o liveShaCommand do board); recusada ⇒ não sobe e o card volta", async () => {
    const f = launcher();
    const reg = new ProductDeployRegistry(f.launcher);
    const g = porAlvo(["face-x"]);
    const revert = vi.fn(async () => {});
    const res = await deployBoard({
      ...base,
      exec: execGravador().exec,
      boardPackage: "packages/app",
      boardDeploy: { liveShaCommand: "just live-sha" }, // só o liveSha ⇒ roteamento legado
      changedFiles: ["packages/app/web/page.tsx"],
      productDeploy: reg,
      freshness: g.gate,
      revertOnRefusal: revert,
    });
    expect(res.fired).toBe(true);
    expect(res.chainedComposedFace).toBe(true);
    f.finish("app", 0); // o backend assenta ok → a face tenta subir
    await vi.waitFor(() => expect(revert).toHaveBeenCalledTimes(1));
    expect(revert).toHaveBeenCalledWith("nest", "s1", { pkg: "face-x", phase: "freshness", reason: "face-x atrás" });
    expect(f.started.map((s) => s.target)).toEqual(["app"]); // a face NÃO subiu
    const pedidoDaFace = g.pedidos.find((p) => p.target === "face-x");
    expect(pedidoDaFace).toMatchObject({ scope: [...ESCOPO, "packages/app/web/", "bun.lockb"] });
    expect(pedidoDaFace?.liveShaCommands).toBeUndefined();
  });

  it("face ENCADEADA liberada ⇒ sobe com a SUA autorização (a do backend é de uso único e de outro alvo)", async () => {
    const f = launcher();
    const reg = new ProductDeployRegistry(f.launcher);
    const revert = vi.fn(async () => {});
    await deployBoard({
      ...base,
      exec: execGravador().exec,
      boardPackage: "packages/app",
      changedFiles: ["packages/app/web/page.tsx"],
      productDeploy: reg,
      freshness: liberar,
      revertOnRefusal: revert,
    });
    f.finish("app", 0);
    await vi.waitFor(() => expect(f.started.map((s) => s.target)).toEqual(["app", "face-x"]));
    expect(reg.get("face-x")).toMatchObject({ board: "nest", cardId: "s1" });
    expect(revert).not.toHaveBeenCalled();
  });

  it("backend FALHOU ⇒ a face nem chega a pedir o preflight", async () => {
    const f = launcher();
    const g = porAlvo([]);
    await deployBoard({
      ...base,
      exec: execGravador().exec,
      boardPackage: "packages/app",
      changedFiles: ["packages/app/web/page.tsx"],
      productDeploy: new ProductDeployRegistry(f.launcher),
      freshness: g.gate,
    });
    f.finish("app", 1);
    await drenar();
    expect(g.pedidos.map((p) => p.target)).toEqual(["app"]);
  });

  it("ISENÇÃO DECLARADA: o self-deploy da FERRAMENTA não é deploy de produto e não consulta o preflight", async () => {
    // Não é esquecimento: ele reconstrói o pacote da ferramenta que está no ar (a régua de árvore dele exige
    // que a árvore declarada SEJA a que roda) e a ferramenta se atualiza pelo canal de release dela.
    const r = recusar();
    const { exec, calls } = execGravador();
    const res = await deployBoard({
      exec,
      repoRoot: "/repo",
      boardPackage: "packages/storymap-ui",
      toolPackageDir: "/repo/packages/storymap-ui",
      freshness: r.gate,
    });
    expect(res.fired).toBe(true);
    expect(res.tool).toBe("systemd-restart");
    expect(calls).toHaveLength(1);
    expect(r.pedidos).toEqual([]);
  });
});

// ── 3. o censo de fonte ────────────────────────────────────────────────────────────────────────────────

/** Remove linhas de comentário e comentários de fim de linha precedidos de espaço — prosa não lança deploy. */
const soCodigo = (s: string): string =>
  s
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .map((l) => l.replace(/\s\/\/\s.*$/, ""))
    .join("\n");

function fontesDeProducao(dir = "src", acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) fontesDeProducao(p, acc);
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$|\.d\.ts$/.test(p)) acc.push(p.replace(/\\/g, "/"));
  }
  return acc;
}

/** Os argumentos da chamada que abre em `open` (parênteses balanceados). */
function argsDaChamada(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length && i - open < 4_000; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return code.slice(open + 1, i);
  }
  return code.slice(open, open + 600);
}

/** Divide o texto dos argumentos no nível ZERO (vírgulas dentro de parênteses/chaves/colchetes não contam). */
function argsDeTopo(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of args) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * O REGISTRO das superfícies que lançam deploy de produto pelo registry. Uma superfície NOVA reprova o censo
 * até entrar aqui — e entrar exige passar a autorização do preflight em cada `start` (a asserção abaixo).
 */
const SUPERFICIES_DE_DEPLOY: Record<string, string> = {
  "src/lib/storymap/runner/deploy.ts":
    "o deploy do board (pipeline e fila de publicação): kind command/agent, orch-deploy legado, face encadeada",
  "src/lib/storymap/mcp/dev-tools.ts": "a tool MCP `deploy` — deploy cru de um alvo, sem card",
};

describe("censo — toda superfície que lança deploy de produto passa pelo preflight de frescor", () => {
  const fontes = fontesDeProducao().map((p) => ({ p, code: soCodigo(readFileSync(p, "utf8")) }));

  it("as superfícies que lançam pelo registry são EXATAMENTE as registradas, e cada `start` leva a autorização do preflight", () => {
    const achadas: string[] = [];
    const semAutorizacao: string[] = [];
    for (const { p, code } of fontes) {
      if (!/\b(?:ProductDeployRegistry|getProductDeploy)\b/.test(code)) continue;
      const re = /\b[\w$.]+\.start\s*\(/g;
      let m: RegExpExecArray | null;
      let temStart = false;
      while ((m = re.exec(code))) {
        temStart = true;
        const args = argsDeTopo(argsDaChamada(code, m.index + m[0].length - 1));
        if (!/\.clearance$/.test(args[1] ?? "")) {
          semAutorizacao.push(`${p}:${code.slice(0, m.index).split("\n").length} → ${m[0]}${args.join(", ").slice(0, 80)})`);
        }
      }
      if (temStart) achadas.push(p);
    }
    expect(achadas.sort(), "superfície de deploy de produto NÃO registrada — registre-a em SUPERFICIES_DE_DEPLOY").toEqual(
      Object.keys(SUPERFICIES_DE_DEPLOY).sort(),
    );
    expect(semAutorizacao, "`start` do registry sem a autorização (`<veredito>.clearance`) do preflight de frescor").toEqual([]);
  });

  it("toda superfície registrada CHAMA o preflight em código (checkDeployFreshness)", () => {
    for (const rel of Object.keys(SUPERFICIES_DE_DEPLOY)) {
      const code = fontes.find((f) => f.p === rel)?.code ?? "";
      expect(code, `${rel} não chama checkDeployFreshness`).toMatch(/\bcheckDeployFreshness\s*\(/);
    }
  });

  it("nenhum chamador de produção injeta o `env` do escape — ele vem do env do SERVIÇO, lido na hora", () => {
    const injetam: string[] = [];
    let chamadas = 0;
    for (const { p, code } of fontes) {
      if (p.endsWith("/deploy-freshness.ts")) continue; // a definição
      const re = /\bcheckDeployFreshness\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code))) {
        chamadas++;
        const deps = argsDeTopo(argsDaChamada(code, m.index + m[0].length - 1))[1] ?? "";
        if (/\benv\b/.test(deps)) injetam.push(`${p}: ${deps.slice(0, 80)}`);
      }
    }
    expect(chamadas, "NÃO-VACUIDADE: o censo tem de encontrar as chamadas de produção").toBeGreaterThanOrEqual(2);
    expect(injetam).toEqual([]);
  });

  it("só o REGISTRY resgata autorizações — ninguém mais as consome", () => {
    const quem = fontes
      .filter(({ p, code }) => !p.endsWith("/deploy-freshness.ts") && /\bredeemDeployClearance\s*\(/.test(code))
      .map(({ p }) => p);
    expect(quem).toEqual(["src/lib/storymap/runner/product-deploy.ts"]);
  });
});
