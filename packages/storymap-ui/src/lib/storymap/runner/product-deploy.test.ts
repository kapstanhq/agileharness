import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findRepoRoot, resetRepoRootCache } from "@/lib/storymap/paths";
import { loadRunnerConfig } from "./config";
import {
  ProductDeployRegistry,
  composedFaceManifestRel,
  composedFaceManifestStatus,
  resetComposedFaceManifestCache,
  deployPkgForPackage,
  deploySettledWithoutWork,
  DEPLOY_INSTANT_NOOP_MS,
  logFileFor,
  productDeployTargets,
  composedFacePrefixes,
  composedFaceFiles,
  composedFaceTarget,
  composedFaceRecipe,
  touchesComposedFace,
  deployCommandFor,
  resolveDeclaredProgram,
  type DeployDoneEvent,
  type DeployLauncher,
  type DeployLaunchSpec,
} from "./product-deploy";
import { checkDeployFreshness, type DeployClearance } from "./deploy-freshness";
import { deployPolicyFromSettings } from "./deploy-command-guard";
import { deployPolicyOf } from "@/lib/storymap/deploy-policy";
import { describePosix } from "./test-platform";

// ── ESTE ALVO DECLARA UMA SUPERFÍCIE COMPOSTA? ──────────────────────────────────────────────────────
//
// A pergunta MUDOU, e a mudança é o ponto. Antes era "o arquivo `scripts/deploy/<algo>.json` do dono
// existe neste checkout?", respondida por `soDoUmbrella` sobre uma constante de código — o que amarrava
// estes casos à árvore do repositório de origem. Agora o manifesto é DECLARADO pelo alvo, então a pergunta honesta é
// a declaração: um alvo que não declara face simplesmente não tem os blocos que interrogam o CONTEÚDO
// dela. A SEMÂNTICA do motor não depende disso e continua medida contra um manifesto de fixture, mais
// abaixo, em qualquer árvore.
// O PISO: declarar e não conseguir ler NÃO pode virar "pula". Esse é exatamente o estado `unreadable` —
// o que o motor trata de forma conservadora justamente porque não saber se a face mudou é pior do que
// saber que não há face. Um teste que pulasse aqui esconderia o buraco que ele existe para vigiar.
const manifestDoDono = (() => {
  const rel = composedFaceManifestRel();
  if (!rel) return null; // este alvo não declara superfície composta — não há conteúdo a interrogar
  const p = path.join(findRepoRoot(), rel);
  if (!existsSync(p)) {
    throw new Error(
      `este alvo DECLARA uma superfície composta em settings.yaml (deploy.composedFace.manifest = ${rel}), ` +
        `mas ${p} não existe. Ou o manifesto voltou, ou a declaração sai do settings — pular aqui deixaria ` +
        `os casos que interrogam o conteúdo da face mudos, verdes, medindo nada.`,
    );
  }
  return JSON.parse(readFileSync(p, "utf8")) as { apps: { webDir: string }[]; sharedGlobs: string[] };
})();

const declaredFaceHasCommand = (): boolean => !!loadRunnerConfig().deploy?.composedFace?.command;

// A launcher that never spawns a real process: records the launched pkg and exposes a manual `finish`
// to drive the close event (so the running→done/failed transition is testable without child_process).
/**
 * Uma autorização de frescor REAL para `target` — `start` não lança sem uma (deploy-freshness.ts). Cunhada
 * pelo escape HUMANO (`AGILEHARNESS_DEPLOY_FRESHNESS=off`), o único caminho que não mede git: estes casos
 * medem o CICLO do registry, e o preflight tem a sua própria suíte. Não há cunhagem só-de-teste.
 */
async function ok(target: string): Promise<DeployClearance> {
  const v = await checkDeployFreshness(
    { target, repoRoot: "/repo", scope: [], policy: deployPolicyFromSettings(undefined, {}), label: "teste do registry" },
    {
      exec: async () => {
        throw new Error("o escape não mede git");
      },
      env: { AGILEHARNESS_DEPLOY_FRESHNESS: "off" },
      log: () => {},
    },
  );
  if (!v.ok) throw new Error("o escape humano deveria cunhar a autorização");
  return v.clearance;
}

function fakeLauncher() {
  const launched: string[] = [];
  let done: ((code: number | null) => void) | undefined;
  const launcher: DeployLauncher = (pkg) => {
    launched.push(pkg);
    return { pid: 999, whenDone: (cb) => { done = cb; } };
  };
  return { launcher, launched, finish: (code: number | null) => done?.(code) };
}

// Alvos de FIXTURE. A resolução é pura sobre o conjunto injetado, então estes casos medem a SEMÂNTICA e
// não a configuração da máquina em que rodam — antes eles liam a lista literal do motor e por isso só
// valiam neste monorepo.
const ALVOS = ["alfa", "beta-app", "gama_svc"] as const;

describe("deployPkgForPackage — agnostic package→target resolution", () => {
  it("maps a declared package to its basename — with the packageRoot the TARGET declares", () => {
    expect(deployPkgForPackage("packages/alfa", ALVOS, "packages/")).toBe("alfa");
    expect(deployPkgForPackage("packages/beta-app", ALVOS, "packages/")).toBe("beta-app");
    expect(deployPkgForPackage("packages/gama_svc/", ALVOS, "packages/")).toBe("gama_svc"); // barra final tolerada
    // outra pasta de pacotes, declarada: a ferramenta não supõe `packages/`
    expect(deployPkgForPackage("apps/alfa", ALVOS, "apps/")).toBe("alfa");
    expect(deployPkgForPackage("packages/alfa", ALVOS, "apps/")).toBeNull();
  });

  it("SEM packageRoot declarado o `package` inteiro é comparado com os alvos (neutro: nenhuma pasta é suposta)", () => {
    expect(deployPkgForPackage("packages/alfa", ALVOS, null)).toBeNull();
    expect(deployPkgForPackage("alfa", ALVOS, null)).toBe("alfa");
    expect(deployPkgForPackage("alfa/", ALVOS, null)).toBe("alfa");
    expect(deployPkgForPackage("gama_svc", ALVOS, "")).toBe("gama_svc");
  });

  it("returns null for an UNDECLARED package and an absent package", () => {
    // Este é o invariante que o self-deploy depende: o pacote do próprio harness não está entre os alvos,
    // então ele resolve null — e `instrumentation.ts` lê esse mesmo null como "seguro no boot". Uma
    // resolução que devolvesse não-null para todo board com `package` quebraria os dois de uma vez.
    expect(deployPkgForPackage("packages/storymap-ui", ALVOS, "packages/")).toBeNull();
    expect(deployPkgForPackage("packages/some-internal-lib", ALVOS, "packages/")).toBeNull();
    expect(deployPkgForPackage(undefined, ALVOS)).toBeNull();
  });

  it("conjunto VAZIO ⇒ nada é deployável por esta via (o default de um alvo que não declara nada)", () => {
    for (const p of ["packages/alfa", "packages/qualquer", "packages/storymap-ui"]) {
      expect(deployPkgForPackage(p, [], "packages/")).toBeNull();
    }
  });

  it("story-ex0071: o alvo reservado da face vai para o COMANDO declarado dela; todo o resto, para o comando legado com {target}", () => {
    const declarada = deployPolicyOf({
      deploy: {
        legacy: { command: ["ship-cli", "--yes", "publish", "{target}"] },
        composedFace: { target: "face-composta", recipe: "rotulo-legado", manifest: "face.json", command: ["ship-cli", "--yes", "publish-face"] },
      },
    });
    expect(deployCommandFor("face-composta", declarada)).toEqual({ ok: true, argv: ["ship-cli", "--yes", "publish-face"] });
    expect(deployCommandFor("alfa", declarada)).toEqual({ ok: true, argv: ["ship-cli", "--yes", "publish", "alfa"] });
    // Sem face declarada, NADA é tratado como face — nem um alvo que por acaso tenha o mesmo nome.
    const semFace = deployPolicyOf({ deploy: { legacy: { command: ["ship-cli", "--yes", "publish", "{target}"] } } });
    expect(deployCommandFor("face-composta", semFace)).toEqual({ ok: true, argv: ["ship-cli", "--yes", "publish", "face-composta"] });
  });

  it("SEM declaração o comando é RECUSADO nomeando a chave a declarar — nada é suposto", () => {
    // alvo sem `legacy.command`
    const vazia = deployCommandFor("alfa", deployPolicyOf(undefined));
    expect(vazia.ok).toBe(false);
    if (!vazia.ok) expect(vazia.refusal).toMatch(/settings\.yaml → deploy\.legacy\.command/);
    // face declarada só com o RÓTULO (`recipe`): sozinho ele não publica nada — a ferramenta não sabe de que executor é aquela «receita»
    const soRotulo = deployPolicyOf({
      deploy: {
        legacy: { command: ["ship-cli", "publish", "{target}"] },
        composedFace: { target: "face-composta", recipe: "rotulo-legado", manifest: "face.json" },
      },
    });
    const face = deployCommandFor("face-composta", soRotulo);
    expect(face.ok).toBe(false);
    if (!face.ok) expect(face.refusal).toMatch(/settings\.yaml → deploy\.composedFace\.command/);
    // e NÃO cai no comando legado com o nome da face (publicaria um app que não existe)
    expect(deployCommandFor("alfa", soRotulo)).toEqual({ ok: true, argv: ["ship-cli", "publish", "alfa"] });
  });

  it("um id que não é slug nunca vira argumento do comando declarado", () => {
    const declarada = deployPolicyOf({ deploy: { legacy: { command: ["ship-cli", "publish", "{target}"] } } });
    for (const mau of ["../x", "a b", "a;b", "$(id)", "", "-f"]) {
      expect(deployCommandFor(mau, declarada).ok, JSON.stringify(mau)).toBe(false);
    }
  });

  it("PISO — a fiação settings→motor está viva, medida contra uma leitura INDEPENDENTE do arquivo", () => {
    // ── O QUE ESTE TESTE SUBSTITUI, E POR QUE PRECISA DE UM SEGUNDO INSTRUMENTO ──────────────────────
    //
    // A versão anterior era `for (const p of DEPLOY_PKGS) expect(...)` sobre uma lista literal, com o
    // título "the list is the source of truth". Com a lista virando DADO, esse laço passa VERDE sobre um
    // conjunto vazio: zero iterações, zero asserções, e o título continua afirmando a propriedade que
    // ninguém mediu.
    //
    // E a correção ÓBVIA também é vácuo. Contar as iterações e cobrar `medidos === declarados.length` é
    // uma tautologia — um laço que incrementa uma vez por volta sempre satisfaz isso, inclusive com zero
    // voltas. Exigir NÃO-VAZIO tampouco serve: um adotante legitimamente não declara alvo nenhum, e o
    // artefato extraído é exatamente esse caso.
    //
    // O que discrimina é comparar a resposta do MOTOR com uma leitura do MESMO arquivo feita POR FORA
    // dele. Se a fiação quebrar — o coerce parar de carregar a chave, o caminho do settings mudar, a
    // memoização servir um valor velho —, os dois lados divergem e isto fica vermelho. Nas duas árvores:
    // no repositório de origem os dois trazem os alvos declarados; no artefato os dois trazem vazio, e a IGUALDADE
    // continua sendo a afirmação (o motor concorda que não há nada declarado).
    const arquivo = path.join(findRepoRoot(), "storymap", "settings.yaml");
    const bruto = existsSync(arquivo) ? readFileSync(arquivo, "utf8") : null;
    const doc = bruto === null ? null : (yaml.load(bruto) as { deploy?: { targets?: unknown } } | null);
    const noArquivo: string[] = Array.isArray(doc?.deploy?.targets) ? (doc!.deploy!.targets as string[]) : [];
    const doMotor = [...productDeployTargets()];

    expect(
      doMotor.slice().sort(),
      "o motor e o arquivo discordam sobre os alvos declarados — a fiação settings→motor quebrou",
    ).toEqual(noArquivo.slice().sort());

    // E, para o lado que de fato declara algo, a propriedade que interessa: cada alvo resolve para si.
    const raizDeclarada = (doc as { deploy?: { legacy?: { packageRoot?: string } } } | null)?.deploy?.legacy?.packageRoot ?? "";
    for (const p of doMotor) {
      expect(deployPkgForPackage(`${raizDeclarada}${p}`)).toBe(p);
      // A forma é a mesma que o carregador impõe — a peneira que impede uma frase de chegar à recusa de
      // uma tool MCP (texto que o modelo do outro lado lê com autoridade de prompt).
      expect(p, `alvo fora da forma de slug: ${JSON.stringify(p)}`).toMatch(/^[A-Za-z][A-Za-z0-9_-]{0,40}$/);
    }

    // O piso do piso: se o arquivo EXISTE e declara alvos, o motor não pode responder vazio. É a
    // direção que a igualdade acima já cobre, escrita como asserção própria porque é a regressão
    // concreta que esta mudança poderia causar (a chave carregada em silêncio como ausente).
    if (noArquivo.length > 0) expect(doMotor.length).toBeGreaterThan(0);
  });
});

describe("logFileFor", () => {
  it("derives a per-pkg log path under .artifacts/logs", () => {
    expect(logFileFor("armazemweb", "/repo").replace(/\\/g, "/")).toBe("/repo/.artifacts/logs/mcp-deploy-armazemweb.log");
  });
});

describe("ProductDeployRegistry — job lifecycle (injected launcher, no real spawn)", async () => {
  it("start() launches the declared deploy command for the pkg and tracks it as running", async () => {
    const f = fakeLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const job = reg.start("armazemweb", await ok("armazemweb"));
    expect(f.launched).toEqual(["armazemweb"]);
    expect(job.pkg).toBe("armazemweb");
    expect(job.pid).toBe(999);
    expect(job.status).toBe("running");
    expect(reg.isRunning("armazemweb")).toBe(true);
  });

  it("transitions running → done on exit 0", async () => {
    const f = fakeLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    reg.start("armazemweb", await ok("armazemweb"));
    f.finish(0);
    const job = reg.get("armazemweb")!;
    expect(job.status).toBe("done");
    expect(job.exitCode).toBe(0);
    expect(reg.isRunning("armazemweb")).toBe(false);
    expect(job.finishedAt).toBeTypeOf("number");
  });

  it("transitions running → failed on a non-zero / spawn-error exit", async () => {
    const f = fakeLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    reg.start("balcao", await ok("balcao"));
    f.finish(-1);
    const job = reg.get("balcao")!;
    expect(job.status).toBe("failed");
    expect(job.exitCode).toBe(-1);
  });

  it("latest() returns the most recently started job", async () => {
    const f = fakeLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    reg.start("armazemweb", await ok("armazemweb"));
    reg.start("galpao", await ok("galpao"));
    expect(reg.latest()?.pkg).toBe("galpao");
  });

  it("tail() of a job with no real log file degrades gracefully", async () => {
    const f = fakeLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const job = reg.start("armazemweb", await ok("armazemweb"));
    // Hermetic: logFileFor() resolves to `<root>/.artifacts/logs/mcp-deploy-armazemweb.log`, which
    // EXISTS in the live VPS checkout (a real MCP deploy left it) and would leak into this "no log
    // yet" assertion. Repoint at a path guaranteed absent so `tail()` deterministically hits the
    // graceful fallback regardless of the checkout it runs in.
    job.logFile = `${job.logFile}.__absent_for_test__`;
    expect(await reg.tail(job, 80)).toBe("(sem log ainda)");
  });

  it("G3: start(ctx) threads board/cardId onto the job", async () => {
    const f = fakeLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const job = reg.start("armazemweb", await ok("armazemweb"), { board: "armazem", cardId: "story-7" });
    expect(job.board).toBe("armazem");
    expect(job.cardId).toBe("story-7");
  });

  it("G3: onDone fires with ok=true + threaded board/cardId on a successful deploy", async () => {
    const f = fakeLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const events: unknown[] = [];
    reg.onDone((ev) => events.push(ev));
    reg.start("armazemweb", await ok("armazemweb"), { board: "armazem", cardId: "story-1" });
    f.finish(0);
    // story-ex0034 (t5): the event now also carries durationMs (wall-clock) + expectWork (threaded from ctx).
    expect(events).toEqual([
      { pkg: "armazemweb", ok: true, exitCode: 0, board: "armazem", cardId: "story-1", durationMs: expect.any(Number), expectWork: undefined },
    ]);
  });

  it("G3: onDone fires with ok=false + the exit code on a failed deploy", async () => {
    const f = fakeLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const events: unknown[] = [];
    reg.onDone((ev) => events.push(ev));
    reg.start("armazemweb", await ok("armazemweb"), { board: "armazem", cardId: "story-1" });
    f.finish(2);
    expect(events).toEqual([
      { pkg: "armazemweb", ok: false, exitCode: 2, board: "armazem", cardId: "story-1", durationMs: expect.any(Number), expectWork: undefined },
    ]);
  });

  it("G3: a manual deploy with no card ctx emits onDone without board/cardId", async () => {
    const f = fakeLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const events: Array<{ board?: string; cardId?: string }> = [];
    reg.onDone((ev) => events.push(ev));
    reg.start("armazemweb", await ok("armazemweb"));
    f.finish(0);
    expect(events[0]?.board).toBeUndefined();
    expect(events[0]?.cardId).toBeUndefined();
  });

  it("story-ex0034 (t5): threads expectWork onto the job and the onDone event", async () => {
    const f = fakeLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const events: DeployDoneEvent[] = [];
    reg.onDone((ev) => events.push(ev));
    const job = reg.start("armazemweb", await ok("armazemweb"), { board: "armazem", cardId: "story-1", expectWork: true });
    expect(job.expectWork).toBe(true);
    f.finish(0);
    expect(events[0]?.expectWork).toBe(true);
    expect(typeof events[0]?.durationMs).toBe("number");
  });

  it("D-AG2: um start LEGADO (sem spec) emite o evento byte-idêntico — sem chave diffAware nem liveSha", async () => {
    const f = fakeLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const events: DeployDoneEvent[] = [];
    reg.onDone((ev) => events.push(ev));
    reg.start("armazemweb", await ok("armazemweb"), { board: "armazem", cardId: "s1" });
    f.finish(0);
    expect("diffAware" in events[0]).toBe(false);
    expect("liveSha" in events[0]).toBe(false);
    expect("declaredKind" in events[0]).toBe(false);
  });
});

// D-AG2/D-AG3 — the registry gains a LAUNCH SPEC (the board's declared deploy) threaded to the launcher;
// the done event then carries `diffAware:false` (the declared paths are NOT the diff-aware declared command)
// and, for an agent verdict that claimed one, `liveSha` — read at close time via the launch's verdict().
describe("ProductDeployRegistry — launch spec do deploy declarado (D-AG2/D-AG3)", async () => {
  function specLauncher(verdict: (() => { ok: boolean; liveSha?: string } | null) | undefined) {
    const seen: { pkg: string; spec?: DeployLaunchSpec }[] = [];
    let done: ((code: number | null) => void) | undefined;
    const launcher: DeployLauncher = (pkg, _logFile, spec) => {
      seen.push({ pkg, spec });
      return { pid: 7, whenDone: (cb) => (done = cb), ...(verdict ? { verdict } : {}) };
    };
    return { launcher, seen, finish: (code: number | null) => done?.(code) };
  }

  it("threads o spec shell ao launcher e marca o evento diffAware:false (isento do guard instant-noop)", async () => {
    const f = specLauncher(undefined);
    const reg = new ProductDeployRegistry(f.launcher);
    const events: DeployDoneEvent[] = [];
    reg.onDone((ev) => events.push(ev));
    reg.start("armazem", await ok("armazem"), { board: "armazem", cardId: "s1", expectWork: true }, { kind: "shell", command: "vercel deploy --prod" });
    f.finish(0);

    expect(f.seen).toEqual([{ pkg: "armazem", spec: { kind: "shell", command: "vercel deploy --prod" } }]);
    expect(events[0]?.diffAware).toBe(false);
    // qual MECANISMO declarado rodou — é a ele que o contrato da saída 3 («precisa de você») pertence
    expect(events[0]?.declaredKind).toBe("command");
    // O CERNE do D-AG2: um comando arbitrário RÁPIDO (ok, expectWork, ~0s) NÃO pode ser revertido como
    // no-op — a inferência "~0s ⇒ nada shipou" é propriedade do comando declarado diff-aware, não dele.
    expect(deploySettledWithoutWork(events[0])).toBe(false);
  });

  it("agente com veredito liveSha ⇒ o evento carrega a ALEGAÇÃO (o settle re-mede; nunca vira carimbo aqui)", async () => {
    const f = specLauncher(() => ({ ok: true, liveSha: "eeff0011" }));
    const reg = new ProductDeployRegistry(f.launcher);
    const events: DeployDoneEvent[] = [];
    reg.onDone((ev) => events.push(ev));
    reg.start("armazem", await ok("armazem"), { board: "armazem", cardId: "s1" }, { kind: "agent", board: "armazem", description: "deploy via flyctl" });
    f.finish(0);
    expect(events[0]?.liveSha).toBe("eeff0011");
    expect(events[0]?.diffAware).toBe(false);
    expect(events[0]?.declaredKind).toBe("agent");
  });

  it("veredito sem liveSha / launch sem verdict ⇒ evento sem a chave liveSha", async () => {
    const f = specLauncher(() => ({ ok: true }));
    const reg = new ProductDeployRegistry(f.launcher);
    const events: DeployDoneEvent[] = [];
    reg.onDone((ev) => events.push(ev));
    reg.start("armazem", await ok("armazem"), { board: "armazem", cardId: "s1" }, { kind: "agent", board: "armazem", description: "x" });
    f.finish(0);
    expect("liveSha" in events[0]).toBe(false);
  });
});

// story-ex0034 (t5) — a diff-aware declared deploy command of code that never reached main sees no drift → exits exit-0
// in ~0s. That instant no-work settle is NOT confirmation the code is live: when the release EXPECTED work
// (it promoted new code) it must be treated as a failed publish (revert), never a green "No Ar".
describe("deploySettledWithoutWork — the instant no-drift deploy is not a real ship (story-ex0034 t5)", () => {
  const ev = (o: Partial<DeployDoneEvent>): DeployDoneEvent => ({
    pkg: "armazemweb",
    ok: true,
    exitCode: 0,
    durationMs: 0,
    ...o,
  });

  it("flags an ok, expected-work, ~0s settle (the bug: code never shipped)", () => {
    expect(deploySettledWithoutWork(ev({ ok: true, expectWork: true, durationMs: 120 }))).toBe(true);
  });

  it("does NOT flag a deploy that did real work (minutes)", () => {
    expect(deploySettledWithoutWork(ev({ ok: true, expectWork: true, durationMs: DEPLOY_INSTANT_NOOP_MS + 1 }))).toBe(false);
  });

  it("does NOT flag a legit idempotent re-deploy where no new code was expected (expectWork false)", () => {
    // The false-positive guard: code already live, nothing to ship → a ~0s no-drift settle is CORRECT.
    expect(deploySettledWithoutWork(ev({ ok: true, expectWork: false, durationMs: 5 }))).toBe(false);
    expect(deploySettledWithoutWork(ev({ ok: true, durationMs: 5 }))).toBe(false); // expectWork undefined
  });

  it("does NOT flag a genuine failure (ok=false) — that path reverts on its own", () => {
    expect(deploySettledWithoutWork(ev({ ok: false, expectWork: true, durationMs: 3 }))).toBe(false);
  });

  it("D-AG2: does NOT flag a board-DECLARED deploy (diffAware:false) — a fast arbitrary command can be a real ship", () => {
    // The ~0s inference is a property of the diff-aware declared command (no drift ⇒ instant exit). A declared
    // shell/agent deploy answers via its exit code + the settle's proof measurement instead.
    expect(deploySettledWithoutWork(ev({ ok: true, expectWork: true, durationMs: 3, diffAware: false }))).toBe(false);
    // …and the legacy semantics are untouched (absent/true ⇒ diff-aware ⇒ the guard still bites).
    expect(deploySettledWithoutWork(ev({ ok: true, expectWork: true, durationMs: 3 }))).toBe(true);
    expect(deploySettledWithoutWork(ev({ ok: true, expectWork: true, durationMs: 3, diffAware: true }))).toBe(true);
  });
});

// A product board ships its backend through the diff-aware orchestrator deploy, whose manifest has NO hosting
// unit (the web is a MERGED artifact, not a per-app site). So a fix in a package that composes the merged face
// (its own `web/`, or a shared web package) reaches main via the release but NEVER gets published — the card
// claims "No ar" while prod serves the old bundle. touchesComposedFace is the gate: given the promoted diff,
// does it require publishing the face? The prefixes MUST mirror the target's own manifest (the merge-build
// authority) — enforced by the consistency lint below.
//
// ⚠ ESTE BLOCO É SOBRE O CONTEÚDO DO MANIFESTO DO ALVO, lido do disco: os caminhos dos casos saem do próprio
// manifesto, nunca de literais. O manifesto não viaja (ver a declaração em `oss-tree.ts`), então no repo
// extraído estes casos não têm sujeito: sem manifesto TODA resposta é `false`, e um `toBe(true)` aqui mediria
// a ausência, não o motor. A SEMÂNTICA que eles exercitam — prefixo de diretório vs. arquivo de raiz exato,
// diff misto, diff vazio — é do MOTOR e não do dono, e por isso está replicada logo abaixo contra um manifesto
// de FIXTURE, que roda nas DUAS árvores. O que fica só no alvo é a pergunta "o manifesto do alvo diz o que diz".
describe.runIf(manifestDoDono !== null)("touchesComposedFace — did the promoted diff touch the merged face declared by the target's manifest", () => {
  const declaredWebDirs = () => manifestDoDono!.apps.map((a) => a.webDir);
  const sharedPrefixes = () => manifestDoDono!.sharedGlobs.filter((g) => g.endsWith("/**")).map((g) => g.slice(0, -"**".length));
  const rootFiles = () => manifestDoDono!.sharedGlobs.filter((g) => !g.includes("*"));
  const insideFace = (p: string) => sharedPrefixes().some((x) => p.startsWith(x)) || declaredWebDirs().some((d) => p.startsWith(`${d}/`));
  // um irmão do web/ (api, functions) de cada app declarado que NÃO cai dentro de nenhum prefixo da face
  const backendSiblings = () =>
    declaredWebDirs()
      .flatMap((d) => [`${path.posix.dirname(d)}/api/src/graph/node.ts`, `${path.posix.dirname(d)}/functions/src/index.ts`])
      .filter((p) => !insideFace(p));

  it("flags a change under the web dir of EVERY declared app", () => {
    expect(declaredWebDirs().length).toBeGreaterThan(0);
    for (const d of declaredWebDirs()) expect(touchesComposedFace([`${d}/src/app/page.tsx`]), d).toBe(true);
  });

  it("flags a change to a shared glob directory (rebuilds every app's bundle)", () => {
    for (const x of sharedPrefixes()) expect(touchesComposedFace([`${x}src/ui/Button.tsx`]), x).toBe(true);
  });

  it("flags a ROOT workspace file the manifest lists (dependency resolution can shift)", () => {
    expect(rootFiles().length).toBeGreaterThan(0);
    for (const f of rootFiles()) expect(touchesComposedFace([f]), f).toBe(true);
  });

  it("does NOT flag a backend-only change (functions / api / cloud-run) — the orchestrator deploy already covers it", () => {
    expect(backendSiblings().length).toBeGreaterThan(0);
    for (const p of backendSiblings()) expect(touchesComposedFace([p]), p).toBe(false);
  });

  it("does NOT flag a NON-face package's web-lookalike path, nor a per-package package.json (root-file match is exact)", () => {
    // storymap-ui is not part of the merged face; a nested `web`-ish segment must not false-positive.
    expect(touchesComposedFace(["packages/storymap-ui/src/app/page.tsx"])).toBe(false);
    // a root-anchored `package.json` glob does not make a package-local one a face change.
    if (rootFiles().includes("package.json")) {
      const local = declaredWebDirs().map((d) => `${path.posix.dirname(d)}/package.json`).filter((p) => !insideFace(p));
      expect(local.length).toBeGreaterThan(0);
      for (const p of local) expect(touchesComposedFace([p]), p).toBe(false);
    }
  });

  it("returns false for an empty diff (nothing promoted)", () => {
    expect(touchesComposedFace([])).toBe(false);
  });

  it("flags a mixed diff if ANY file is a face path", () => {
    const [backend] = backendSiblings();
    expect(touchesComposedFace([backend!, `${declaredWebDirs()[0]}/src/app/page.tsx`])).toBe(true);
  });
});

// Reflects reality — composedFacePrefixes()/FILES are DERIVED from the single-source manifest the target
// declares (the SAME file its own merge-build reads). No more hand-kept mirror: if the manifest gains an app
// or a shared glob, the exported gate follows automatically. This guards the DERIVATION logic — if it ever
// breaks (wrong slice/filter), the exact-equality assertion FAILS. (The manifest's own shape/order is guarded
// by the target's own manifest test.)
//
// ⚠ O MANIFESTO NÃO VIAJA, e não deve: `product-deploy.ts` já diz, por escrito, que "a superfície composta
// é config de UM repositório, não uma propriedade do motor". No repo extraído o manifesto está AUSENTE — e é
// exatamente por isso que o bloco de baixo existe: lá a propriedade cobrada deixa de ser "a derivação bate
// com o manifesto" e passa a ser "sem manifesto, o gate do rosto é INERTE". Sem esse par, o repo público
// publicaria um `touchesComposedFace()` cujo comportamento ninguém mede.
describe.runIf(manifestDoDono !== null)("composedFacePrefixes/Files are derived from the declared manifest single source", () => {
  it("parsed the single source (sanity: found each application's web directory + the shared globs)", () => {
    expect(manifestDoDono!.apps.length).toBeGreaterThanOrEqual(1);
    expect(manifestDoDono!.sharedGlobs.length).toBeGreaterThan(0);
  });

  it("every declared web directory is a face prefix", () => {
    for (const app of manifestDoDono!.apps) expect(composedFacePrefixes()).toContain(`${app.webDir}/`);
  });

  it("the gate equals the manifest derivation exactly — no extra, no missing (both directions)", () => {
    // A `**` glob → a directory prefix; a bare filename → an exact root file. Mirror the globToRegex semantics.
    const expectedPrefixes = [
      ...manifestDoDono!.apps.map((a) => `${a.webDir}/`),
      ...manifestDoDono!.sharedGlobs.filter((g) => g.endsWith("/**")).map((g) => g.slice(0, -"**".length)),
    ].sort();
    const expectedFiles = manifestDoDono!.sharedGlobs.filter((g) => !g.includes("*")).sort();

    expect([...composedFacePrefixes()].sort()).toEqual(expectedPrefixes);
    expect([...composedFaceFiles()].sort()).toEqual(expectedFiles);
  });

  it("pins the SHAPE of the gate independently of the derivation (the derivation could be self-consistently wrong)", () => {
    // The equality test above re-derives with the SAME logic as production, so it can't catch a derivation
    // that is self-consistently wrong. Pin invariants of the result that do not re-run that logic: a prefix
    // is a directory (ends in `/`, no glob), a root file is a bare name (no glob), nothing is duplicated, and
    // the two sets never overlap.
    const prefixes = composedFacePrefixes();
    const files = composedFaceFiles();
    expect(prefixes.length).toBeGreaterThan(0);
    for (const p of prefixes) {
      expect(p.endsWith("/"), p).toBe(true);
      expect(p.includes("*"), p).toBe(false);
    }
    for (const f of files) {
      expect(f.includes("*"), f).toBe(false);
      expect(f.endsWith("/"), f).toBe(false);
    }
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(new Set(files).size).toBe(files.length);
    expect(files.filter((f) => prefixes.includes(f))).toEqual([]);
  });
});

// ── O PAR DO BLOCO ACIMA, PARA A ÁRVORE QUE NÃO TEM O MANIFESTO ──────────────────────────────────────
//
// No repo OSS extraído o manifesto da face do dono está ausente por decisão da régua, e o bloco de
// derivação acima não tem sujeito. Trocar isso por um `skip` mudo deixaria o artefato publicando um gate
// de rosto cujo comportamento ninguém mede — e o comportamento importa: `product-deploy.ts` distingue
// `absent` (não há superfície composta declarada ⇒ o diff NÃO toca a face) de `unreadable` (existe e não
// pôde ser lido ⇒ conservador, assume que toca). Confundir os dois publicaria uma face velha como "No ar".
//
// Então a propriedade que o artefato cobra é a OUTRA metade da mesma decisão: sem manifesto, o gate é
// INERTE, e inerte de forma declarada — `absent`, nunca `unreadable`.
describe.runIf(manifestDoDono === null)("sem o manifesto do dono, o gate do rosto é INERTE (o par extraído)", () => {
  it("o status é `absent` — 'não há superfície declarada', não 'não consegui ler'", () => {
    resetComposedFaceManifestCache();
    expect(composedFaceManifestStatus()).toBe("absent");
  });

  it("nenhum prefixo, nenhum arquivo de raiz, e nada 'toca o rosto'", () => {
    resetComposedFaceManifestCache();
    expect(composedFacePrefixes()).toEqual([]);
    expect(composedFaceFiles()).toEqual([]);
    // Os mesmos tipos de caminho que o alvo com manifesto crava como TOCANDO a face: aqui todos têm de dar
    // false. Se algum der true, o motor ganhou uma face fantasma sem manifesto que a declare.
    for (const f of [
      "packages/alfa/web/src/app/page.tsx",
      "packages/beta/web/src/x.ts",
      "packages/kit-compartilhado/index.ts",
      "package.json",
      "bun.lock",
      "turbo.json",
      "packages/storymap-ui/public/ah-overlay.js",
    ]) {
      expect(touchesComposedFace([f]), `${f} passou a "tocar o rosto" sem manifesto nenhum`).toBe(false);
    }
    // E O QUE MUDOU AQUI, com a face virando DECLARAÇÃO do alvo. Antes o alvo reservado existia como
    // NOME mesmo sem manifesto (era constante de código), e este caso cravava que o comando sobrevivia à
    // ausência da superfície. Agora "não declarei face" e "declarei e não consigo ler" são estados
    // distintos, e num alvo que não declara nada o alvo reservado NÃO existe — é essa a resposta certa,
    // e ela é mais forte: sem declaração, nenhum caminho trata coisa alguma como face composta, então
    // não há como uma face fantasma ser publicada por engano.
    const alvoDaFace = composedFaceTarget();
    if (alvoDaFace === null) {
      // sem face declarada nenhum nome é face: resolve pelo comando LEGADO que o alvo declarou (ou recusa, se não declarou)
      const legado = deployPolicyOf(loadRunnerConfig());
      const r = deployCommandFor("qualquer-alvo", legado);
      expect(r.ok).toBe(legado.legacy.command !== undefined);
    } else {
      // Este alvo DECLARA face: então o nome resolve para o comando declarado dela, e o `absent` acima veio da
      // ausência do ARQUIVO, não da declaração. Os dois casos são reais e a distinção é o que importa.
      const r = deployCommandFor(alvoDaFace);
      expect(r.ok).toBe(declaredFaceHasCommand());
      expect(composedFaceRecipe(), "o rótulo legado da face continua legível").not.toBeNull();
    }
  });
});

// ── A SEMÂNTICA DO MOTOR, MEDIDA CONTRA UM MANIFESTO DE FIXTURE — RODA NAS DUAS ÁRVORES ─────────────
//
// Os dois blocos acima se dividem por árvore, e cada um mede uma metade: o repositório de origem interroga o CONTEÚDO
// do manifesto do dono, o artefato cobra a degradação para `absent`. Nenhum dos dois mede, no repo
// público, a coisa que de fato é da FERRAMENTA: as regras de casamento — prefixo de diretório vs. arquivo
// de raiz ANCORADO, glob `/**` virando prefixo, diff misto, diff vazio. Sem este bloco, o artefato
// publicaria `touchesComposedFace` com todas as respostas iguais a `false` e chamaria isso de coberto:
// verde que mede a ausência do dado, não o comportamento do código.
//
// Então o motor é apontado para uma raiz de FIXTURE (`AGILEHARNESS_TARGET`) com um manifesto sintético — apps
// e SDK de nomes neutros, que o repo público pode ler sem herdar o vocabulário do dono. As mesmas
// propriedades dos casos que só rodam no repositório de origem, agora exercitadas nas duas árvores.
describe("touchesComposedFace — a SEMÂNTICA do casamento, contra um manifesto de FIXTURE (as duas árvores)", () => {
  const FIXTURE = {
    apps: [
      { id: "alfa", webDir: "packages/alfa/web", sub: "/alfa", turboPkg: "alfa" },
      { id: "beta", webDir: "packages/beta/web", sub: "/beta", turboPkg: "beta" },
    ],
    sharedGlobs: ["packages/kit-compartilhado/**", "package.json", "bun.lock", "turbo.json"],
  };

  // O caminho do manifesto no alvo de FIXTURE. Ele é escolhido pelo próprio fixture — e é isso que a
  // mudança destrava: o motor não tem mais opinião sobre onde o manifesto mora, então um alvo que
  // organiza seus scripts de outro jeito não precisa se dobrar ao layout de quem escreveu a ferramenta.
  const MANIFESTO_REL = "publicacao/face.json";

  let raiz = "";
  let alvoAnterior: string | undefined;

  beforeAll(() => {
    raiz = mkdtempSync(path.join(tmpdir(), "ah-face-fixture-"));
    // `turbo.json` é um dos ROOT_MARKERS que `findRepoRoot()` exige de um alvo DECLARADO — sem ele o
    // AGILEHARNESS_TARGET é recusado (e é bom que seja: a validação existe para um typo não virar raiz).
    writeFileSync(path.join(raiz, "turbo.json"), "{}\n", "utf8");
    mkdirSync(path.join(raiz, path.dirname(MANIFESTO_REL)), { recursive: true });
    writeFileSync(path.join(raiz, MANIFESTO_REL), JSON.stringify(FIXTURE, null, 2), "utf8");
    // E O ALVO DECLARA A FACE — este é o elo que a mudança introduziu, e exercitá-lo aqui é o que faz
    // este bloco medir a FIAÇÃO INTEIRA (settings.yaml → coerce → motor), e não só o parser de manifesto.
    // Sem esta declaração o motor responderia `absent` para tudo, e cada `false` abaixo passaria por
    // acerto medindo a ausência da config.
    mkdirSync(path.join(raiz, "storymap"), { recursive: true });
    writeFileSync(
      path.join(raiz, "storymap", "settings.yaml"),
      `version: 1\ndeploy:\n  composedFace:\n    target: face-fixture\n    recipe: publica-face\n    manifest: ${MANIFESTO_REL}\n`,
      "utf8",
    );
    alvoAnterior = process.env.AGILEHARNESS_TARGET;
    process.env.AGILEHARNESS_TARGET = raiz;
    resetRepoRootCache();
    resetComposedFaceManifestCache();
  });

  afterAll(() => {
    if (alvoAnterior === undefined) delete process.env.AGILEHARNESS_TARGET;
    else process.env.AGILEHARNESS_TARGET = alvoAnterior;
    resetRepoRootCache();
    resetComposedFaceManifestCache();
    rmSync(raiz, { recursive: true, force: true });
  });

  it("o fixture foi mesmo carregado — sem isto, todo `false` abaixo passaria por acerto", () => {
    // A trava anti-vácuo deste bloco: se o alvo não pegou, o status seria `absent` e os casos negativos
    // continuariam verdes medindo nada. Aqui o manifesto TEM de estar carregado.
    expect(composedFaceManifestStatus()).toBe("loaded");
    expect(composedFacePrefixes().length).toBeGreaterThan(0);
    expect(composedFaceFiles().length).toBeGreaterThan(0);
  });

  it("a derivação: `webDir` vira prefixo, glob `/**` vira prefixo, nome puro vira arquivo de raiz", () => {
    expect([...composedFacePrefixes()].sort()).toEqual(
      ["packages/alfa/web/", "packages/beta/web/", "packages/kit-compartilhado/"].sort(),
    );
    expect([...composedFaceFiles()].sort()).toEqual(["bun.lock", "package.json", "turbo.json"].sort());
  });

  it("acusa mudança sob o web/ de QUALQUER app declarado", () => {
    expect(touchesComposedFace(["packages/alfa/web/src/app/page.tsx"])).toBe(true);
    expect(touchesComposedFace(["packages/beta/web/public/logo.webp"])).toBe(true);
  });

  it("acusa mudança no kit compartilhado (recompõe o bundle de todos os apps)", () => {
    expect(touchesComposedFace(["packages/kit-compartilhado/src/ui/Botao.tsx"])).toBe(true);
  });

  it("acusa arquivo de RAIZ que desloca resolução de dependência", () => {
    expect(touchesComposedFace(["package.json"])).toBe(true);
    expect(touchesComposedFace(["bun.lock"])).toBe(true);
    expect(touchesComposedFace(["turbo.json"])).toBe(true);
  });

  it("NÃO acusa backend-only, nem um `web` sósia de pacote fora da superfície", () => {
    expect(touchesComposedFace(["packages/alfa/api/src/graph/node.ts"])).toBe(false);
    expect(touchesComposedFace(["packages/alfa/functions/src/index.ts"])).toBe(false);
    expect(touchesComposedFace(["packages/gama/web/src/app/page.tsx"])).toBe(false);
  });

  it("o casamento de arquivo de raiz é ANCORADO — um package.json de pacote não é mudança de rosto", () => {
    // O erro que este caso pega é `includes`/`endsWith` no lugar de igualdade: com ele, TODO promote de
    // qualquer pacote passaria a republicar a superfície composta, para sempre.
    expect(touchesComposedFace(["packages/alfa/package.json"])).toBe(false);
    expect(touchesComposedFace(["docs/turbo.json"])).toBe(false);
  });

  it("diff vazio ⇒ false; diff misto ⇒ true se QUALQUER arquivo for do rosto", () => {
    expect(touchesComposedFace([])).toBe(false);
    expect(touchesComposedFace(["packages/alfa/api/src/x.ts", "packages/alfa/web/src/app/page.tsx"])).toBe(true);
  });

  it("manifesto ILEGÍVEL ⇒ conservador (`unreadable` + true), nunca 'não toca'", () => {
    // A outra metade da decisão de três estados: `absent` é false, `unreadable` é true. Trocar um pelo
    // outro publica uma face velha como "No ar" — o buraco que o `throw` original protegia.
    writeFileSync(path.join(raiz, MANIFESTO_REL), "{ isto não é json", "utf8");
    resetComposedFaceManifestCache();
    expect(composedFaceManifestStatus()).toBe("unreadable");
    expect(touchesComposedFace(["qualquer/coisa/fora/da/superficie.ts"])).toBe(true);

    // e restaura o fixture para não deixar estado para o próximo caso
    writeFileSync(path.join(raiz, MANIFESTO_REL), JSON.stringify(FIXTURE, null, 2), "utf8");
    resetComposedFaceManifestCache();
    expect(composedFaceManifestStatus()).toBe("loaded");
  });
});

// Num caso real: dois «Publicar» do MESMO board em segundos. O primeiro disparou o deploy do
// board; o segundo bateu no `isRunning` e voltou «já em andamento» — sem se prender a nada. O deploy terminou,
// o settle foi só do primeiro card, e o segundo ficou em Publicar até o watchdog dizer «deploy disparado sem
// confirmação». A carona: o card que chega com um deploy do mesmo alvo em curso se PRENDE a ele e recebe o
// desfecho dele como um evento de done PRÓPRIO.
describe("ProductDeployRegistry — carona no deploy em curso (dois «Publicar» do mesmo board)", () => {
  it("attach num job RODANDO ⇒ no done, o card de carona recebe o PRÓPRIO evento com o desfecho do job", async () => {
    const f = fakeLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const events: DeployDoneEvent[] = [];
    reg.onDone((ev) => events.push(ev));
    reg.start("armazem", await ok("armazem"), { board: "armazem", cardId: "s1", expectWork: true }, { kind: "shell", command: "x" });
    expect(reg.attach("armazem", { board: "armazem", cardId: "s2" })).toBe(true);
    f.finish(0);

    expect(events.map((e) => e.cardId)).toEqual(["s1", "s2"]);
    expect(events[1]).toMatchObject({ pkg: "armazem", ok: true, exitCode: 0, board: "armazem", cardId: "s2", attached: true, declaredKind: "command" });
    // o `expectWork` é do release do PRIMEIRO card — o de carona não herda o julgamento de no-op dele
    expect(events[1]?.expectWork).toBeUndefined();
    expect(events[0]?.attached).toBeUndefined(); // o evento do dono do job segue byte-idêntico
  });

  it("falha do job ⇒ o card de carona recebe a MESMA falha (o desfecho é um só)", async () => {
    const f = fakeLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const events: DeployDoneEvent[] = [];
    reg.onDone((ev) => events.push(ev));
    reg.start("armazem", await ok("armazem"), { board: "armazem", cardId: "s1" });
    reg.attach("armazem", { board: "armazem", cardId: "s2", followUp: true });
    f.finish(3);
    expect(events[1]).toMatchObject({ cardId: "s2", ok: false, exitCode: 3, attached: true, followUp: true });
  });

  it("sem job rodando ⇒ attach recusa (o chamador dispara o seu); card repetido ou o próprio dono ⇒ um evento só", async () => {
    const f = fakeLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    expect(reg.attach("armazem", { board: "armazem", cardId: "s2" })).toBe(false);
    const events: DeployDoneEvent[] = [];
    reg.onDone((ev) => events.push(ev));
    reg.start("armazem", await ok("armazem"), { board: "armazem", cardId: "s1" });
    expect(reg.attach("armazem", { board: "armazem", cardId: "s2" })).toBe(true);
    expect(reg.attach("armazem", { board: "armazem", cardId: "s2" })).toBe(true);
    expect(reg.attach("armazem", { board: "armazem", cardId: "s1" })).toBe(true);
    f.finish(0);
    expect(events.map((e) => e.cardId)).toEqual(["s1", "s2"]);
    // terminado o job, a carona acabou: um attach agora é recusado
    expect(reg.attach("armazem", { board: "armazem", cardId: "s3" })).toBe(false);
  });
});

// ── O EXECUTÁVEL DO COMANDO DECLARADO — declarado > PATH > recusa, para QUALQUER programa ───────────────
describe("resolveDeclaredProgram — a mesma régua de resolveHostTool, estendida ao programa que o alvo declarou", () => {
  const existe = (...ps: string[]) => (p: string) => ps.includes(p);

  it("um programa que a ferramenta já conhece por nome usa a variável própria dele (AGILEHARNESS_JUST…)", () => {
    const r = resolveDeclaredProgram("just", { env: { AGILEHARNESS_JUST: "/opt/x/just", PATH: "/usr/bin" }, exists: existe("/opt/x/just", "/usr/bin/just") });
    expect(r).toEqual({ ok: true, path: "/opt/x/just" });
  });

  it("um programa QUALQUER aceita AGILEHARNESS_BIN_<NOME> (maiúsculo, não-alfanumérico → _), absoluto e existente", () => {
    const env = { AGILEHARNESS_BIN_OFICINA_CLI: "/opt/oficina/cli", PATH: "/usr/bin" };
    expect(resolveDeclaredProgram("oficina-cli", { env, exists: existe("/opt/oficina/cli") })).toEqual({ ok: true, path: "/opt/oficina/cli" });
    // relativo é recusado (resolveria contra um cwd que o motor não escolhe)
    const rel = resolveDeclaredProgram("oficina-cli", { env: { AGILEHARNESS_BIN_OFICINA_CLI: "bin/cli" }, exists: () => true });
    expect(rel.ok).toBe(false);
    // declarado mas inexistente NÃO cai para o PATH: um engano não se esconde atrás de outro binário
    const inexistente = resolveDeclaredProgram("oficina-cli", { env: { ...env, PATH: "/usr/bin" }, exists: existe("/usr/bin/oficina-cli") });
    expect(inexistente.ok).toBe(false);
    if (!inexistente.ok) expect(inexistente.refusal).toMatch(/AGILEHARNESS_BIN_OFICINA_CLI/);
  });

  it("o prefixo é DEDICADO: AGILEHARNESS_<NOME> sem BIN_ (que colide com a configuração da ferramenta) NÃO declara programa nenhum", () => {
    // `port`/`deploy` existem como chaves de CONFIGURAÇÃO da ferramenta; sem o espaço de nomes próprio um programa de
    // mesmo nome leria a porta como se fosse o seu caminho.
    const r = resolveDeclaredProgram("port", { env: { AGILEHARNESS_PORT: "3008", PATH: "/usr/bin" }, exists: existe("/usr/bin/port") });
    expect(r).toEqual({ ok: true, path: "/usr/bin/port" });
    const viaBin = resolveDeclaredProgram("port", { env: { AGILEHARNESS_BIN_PORT: "/opt/p/port", AGILEHARNESS_PORT: "3008" }, exists: existe("/opt/p/port") });
    expect(viaBin).toEqual({ ok: true, path: "/opt/p/port" });
  });

  it("o NOME é validado antes de qualquer busca: espaço, metacaractere, '-' inicial, '.' e '..' nem chegam ao PATH", () => {
    const tudoExiste = { env: { PATH: "/usr/bin" }, exists: () => true };
    for (const ruim of ["", " ", "a b", "a;b", "-rf", ".", "..", ".oculto", "a/b", "a$(x)", "a\nb", "a`b`", "é"]) {
      const r = resolveDeclaredProgram(ruim, tudoExiste);
      expect(r.ok, JSON.stringify(ruim)).toBe(false);
      if (!r.ok) expect(r.refusal).toMatch(/nome de programa válido/);
    }
    // nomes legítimos com ponto, mais e hífen passam da validação
    for (const bom of ["oficina-cli", "tool.sh", "g++", "python3.12", "a_b"]) {
      expect(resolveDeclaredProgram(bom, { env: { PATH: "/usr/bin" }, exists: (p) => p === `/usr/bin/${bom}` }), bom).toEqual({ ok: true, path: `/usr/bin/${bom}` });
    }
  });

  it("sem declaração, resolve pelo PATH; sem PATH, RECUSA nomeando a variável que declara o caminho", () => {
    expect(resolveDeclaredProgram("oficina-cli", { env: { PATH: "/opt/a:/opt/b" }, exists: existe("/opt/b/oficina-cli") })).toEqual({ ok: true, path: "/opt/b/oficina-cli" });
    const nada = resolveDeclaredProgram("oficina-cli", { env: { PATH: "/opt/a" }, exists: () => false });
    expect(nada.ok).toBe(false);
    if (!nada.ok) {
      expect(nada.refusal).toMatch(/oficina-cli/);
      expect(nada.refusal).toMatch(/AGILEHARNESS_BIN_OFICINA_CLI=/);
    }
  });
});

// ── O LAUNCHER DEFAULT, COM SPAWN REAL, contra um alvo de FIXTURE que DECLARA (e outro que não) ──────────
describePosix("o launcher default executa o argv DECLARADO pelo alvo — e SEM declaração recusa no log", () => {
  const criarAlvo = (nome: string, deploy: string, mtime: number) => {
    const raiz = mkdtempSync(path.join(tmpdir(), `ah-launcher-${nome}-`));
    writeFileSync(path.join(raiz, "turbo.json"), "{}\n", "utf8");
    mkdirSync(path.join(raiz, "storymap"), { recursive: true });
    const settings = path.join(raiz, "storymap", "settings.yaml");
    writeFileSync(settings, `version: 1\n${deploy}`, "utf8");
    // o cache do carregador de settings é por mtime, e as raízes são escritas no mesmo milissegundo: mtimes distintos
    utimesSync(settings, mtime, mtime);
    return raiz;
  };
  const apontar = (raiz: string) => {
    process.env.AGILEHARNESS_TARGET = raiz;
    resetRepoRootCache();
  };
  const rodar = async (pkg: string) => {
    const reg = new ProductDeployRegistry(); // o launcher DEFAULT (spawn real)
    const fim = new Promise<DeployDoneEvent>((resolve) => reg.onDone(resolve));
    reg.start(pkg, await ok(pkg));
    const ev = await fim;
    // o `onDone` dispara no `close` do processo, mas o fluxo do log só esvazia depois: espera a moldura de fim (ou a recusa)
    let log = "";
    await vi.waitFor(() => {
      log = existsSync(logFileFor(pkg)) ? readFileSync(logFileFor(pkg), "utf8") : "";
      expect(log).toMatch(/finished exit|RECUSADO|spawn error/);
    });
    return { ev, log };
  };

  let declara = "";
  let omisso = "";
  let programaInexistente = "";
  let programa = "";
  let alvoAnterior: string | undefined;
  let programaAnterior: string | undefined;

  beforeAll(() => {
    alvoAnterior = process.env.AGILEHARNESS_TARGET;
    programaAnterior = process.env.AGILEHARNESS_BIN_OFICINA_PUBLISH;
    declara = criarAlvo(
      "declara",
      [
        "deploy:",
        "  targets: [bicicleta]",
        "  legacy:",
        "    packageRoot: oficinas/",
        '    command: [oficina-publish, --rapido, "{target}"]',
        "  composedFace:",
        "    target: vitrine",
        "    recipe: rotulo-da-vitrine",
        "    manifest: publicacao/vitrine.json",
        "    command: [oficina-publish, --vitrine]",
        "",
      ].join("\n"),
      1_700_000_001,
    );
    omisso = criarAlvo("omisso", "deploy:\n  targets: [bicicleta]\n", 1_700_000_002);
    programaInexistente = criarAlvo(
      "inexistente",
      'deploy:\n  targets: [bicicleta]\n  legacy:\n    command: [programa-que-nao-existe-na-oficina, "{target}"]\n',
      1_700_000_003,
    );
    // o «programa» do alvo: ecoa o que recebeu (prova o argv, byte a byte) e termina em 0
    programa = path.join(declara, "oficina-publish.sh");
    writeFileSync(programa, '#!/bin/sh\necho "recebi: $*"\n', "utf8");
    chmodSync(programa, 0o755);
    process.env.AGILEHARNESS_BIN_OFICINA_PUBLISH = programa;
  });

  afterAll(() => {
    if (alvoAnterior === undefined) delete process.env.AGILEHARNESS_TARGET;
    else process.env.AGILEHARNESS_TARGET = alvoAnterior;
    if (programaAnterior === undefined) delete process.env.AGILEHARNESS_BIN_OFICINA_PUBLISH;
    else process.env.AGILEHARNESS_BIN_OFICINA_PUBLISH = programaAnterior;
    resetRepoRootCache();
    for (const r of [declara, omisso, programaInexistente]) rmSync(r, { recursive: true, force: true });
  });

  it("DECLARADO: executa EXATAMENTE o argv do settings com {target} expandido, e o log mostra a linha `[deploy alvo] <programa> <args>`", async () => {
    apontar(declara);
    const { ev, log } = await rodar("bicicleta");
    expect(ev).toMatchObject({ pkg: "bicicleta", ok: true, exitCode: 0 });
    expect(log).toContain(`[deploy bicicleta] ${programa} --rapido bicicleta\n`);
    expect(log).toContain("recebi: --rapido bicicleta");
    expect(log).toContain("[deploy bicicleta] finished exit 0");
  });

  it("DECLARADO: o alvo reservado da face executa o comando DECLARADO da face (e não o legado com o nome dela)", async () => {
    apontar(declara);
    const { ev, log } = await rodar("vitrine");
    expect(ev.ok).toBe(true);
    expect(log).toContain(`[deploy vitrine] ${programa} --vitrine\n`);
    expect(log).toContain("recebi: --vitrine");
    expect(log).not.toContain("--rapido");
  });

  it("NÃO DECLARADO: termina com exit -1 e RECUSADO no log nomeando a chave — nenhum processo é lançado", async () => {
    apontar(omisso);
    const { ev, log } = await rodar("bicicleta");
    expect(ev).toMatchObject({ ok: false, exitCode: -1 });
    expect(log).toMatch(/^\[deploy bicicleta\] RECUSADO: .*settings\.yaml → deploy\.legacy\.command/);
    expect(log).not.toContain("recebi:");
  });

  it("DECLARADO com um programa que não existe nesta máquina: RECUSADO nomeando a variável que declara o caminho", async () => {
    apontar(programaInexistente);
    const { ev, log } = await rodar("bicicleta");
    expect(ev).toMatchObject({ ok: false, exitCode: -1 });
    expect(log).toMatch(/RECUSADO: .*programa-que-nao-existe-na-oficina/);
    expect(log).toMatch(/AGILEHARNESS_BIN_PROGRAMA_QUE_NAO_EXISTE_NA_OFICINA=/);
  });
});
