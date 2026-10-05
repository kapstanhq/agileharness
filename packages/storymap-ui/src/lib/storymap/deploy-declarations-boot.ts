// AS CHECAGENS DO DEPLOY DECLARADO NO BOOT DO SERVIÇO — o pedaço do relatório de prontidão que precisa da config.
//
// O preflight do boot empacotado (src/server/main.ts) não importa `runner/config.ts` de propósito (restrição 1 de
// preflight.ts: o bundle não arrasta o parser nem a árvore de configuração). Por isso os dois checks que dependem do que o
// ALVO declarou de deploy — `host.just` (o lançador só é cobrado de quem o usa) e `deploy.declared-commands` (todo comando
// de board que a política efetiva recusaria) — só existiam no resource de prontidão do MCP: o serviço subia calado sobre
// um comando declarado que ia ser recusado na hora de publicar.
//
// Este módulo roda DENTRO do runtime do Next (instrumentation.ts), onde a config já é carregada, e é a MESMA medição que o
// resource do MCP usa (uma fonte só para as duas superfícies). Nunca recusa o boot e nunca lança: o resultado vira linhas
// de log, como o resto do preflight.

import type { DeployDeclarationsProbe, PreflightCheck, PreflightProbes } from "./preflight";

/** Os ids do relatório que dependem do deploy declarado — o que o boot empacotado não mede. */
export const DEPLOY_DECLARED_CHECK_IDS: ReadonlySet<string> = new Set(["host.just", "deploy.declared-commands"]);

/**
 * Mede o que o alvo declarou de deploy (settings.yaml → `deploy.*` ∪ o env aditivo, e os comandos de board-data). `null` = a
 * config ou os boards não puderam ser lidos — o relatório diz «não medido», nunca «ok». Nunca lança.
 */
export async function measureDeployDeclarations(): Promise<DeployDeclarationsProbe | null> {
  try {
    const [{ declaredDeployPolicy }, { deployPolicyFromSettings }, { deployDeclarationsProbe }, { listBoards, readBoardConfig }] = await Promise.all([
      import("@/lib/storymap/runner/product-deploy"),
      import("@/lib/storymap/runner/deploy-command-guard"),
      import("@/lib/storymap/preflight"),
      import("@/lib/storymap/repo"),
    ]);
    const declared = declaredDeployPolicy();
    const boards = await Promise.all((await listBoards()).map(async (b) => readBoardConfig(b.id).catch(() => null)));
    return deployDeclarationsProbe(
      {
        policy: deployPolicyFromSettings(declared),
        canaryCommand: declared.canaryCommand,
        canaryFromEnv: declared.canaryFromEnv,
        argvs: [declared.legacy.command, declared.legacy.plan, declared.composedFace?.command, declared.proof.record.securityReview, declared.proof.record.ownerApproval],
      },
      boards.filter((c): c is NonNullable<typeof c> => c !== null),
    );
  } catch {
    return null;
  }
}

export interface BootDeployPreflightDeps {
  measure(): Promise<DeployDeclarationsProbe | null>;
  /** o relatório de prontidão (preflight.ts `runPreflight`) — injetável para o teste. */
  runPreflight(probes: PreflightProbes): { checks: PreflightCheck[] };
  repoRoot: string | null;
  env: Record<string, string | undefined>;
  log(line: string): void;
  warn(line: string): void;
}

/**
 * Roda SÓ as checagens do deploy declarado e as conta no log do boot: uma linha quando passam (prova de que rodou), o
 * bloco com medido + conserto quando não. Devolve as checagens (para teste e para quem quiser exibir). Nunca lança.
 */
export async function bootDeployPreflight(d: BootDeployPreflightDeps): Promise<PreflightCheck[]> {
  try {
    const deploy = await d.measure();
    const checks = d.runPreflight({ repoRoot: d.repoRoot, deploy, env: d.env }).checks.filter((c) => DEPLOY_DECLARED_CHECK_IDS.has(c.id));
    const ruins = checks.filter((c) => c.status !== "ok");
    if (ruins.length === 0) {
      d.log(`[harness-boot] preflight do deploy declarado: OK — ${checks.map((c) => `${c.id}: ${c.observed}`).join(" · ")}`);
    } else {
      const linhas = [`[harness-boot] preflight do deploy declarado: ${ruins.length} de ${checks.length} verificação(ões) pedem atenção`];
      for (const c of ruins) {
        linhas.push(`  ${c.id} (${c.status}) — ${c.title}`);
        linhas.push(`        medido: ${c.observed}`);
        if (c.remedy) linhas.push(`        conserto: ${c.remedy}`);
      }
      linhas.push("  Isto NÃO impede o boot.");
      d.warn(linhas.join("\n"));
    }
    return checks;
  } catch (err) {
    d.warn(`[harness-boot] preflight do deploy declarado não pôde rodar: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** A passada em segundo plano deste processo — uma por boot (a segunda chamada devolve a mesma). */
let background: Promise<PreflightCheck[]> | null = null;

/**
 * Dispara {@link bootDeployPreflight} SEM esperar: devolve na hora a Promise da passada (o boot segue), uma vez por
 * processo, e nunca rejeita — um erro vira aviso e lista vazia. `deps` ausentes são resolvidas preguiçosamente (a medição
 * real, o relatório real, a raiz do repositório, o console). PURA no contrato; o teste injeta tudo.
 */
export function startDeployPreflightInBackground(deps?: Partial<BootDeployPreflightDeps>): Promise<PreflightCheck[]> {
  if (background) return background;
  const warn = deps?.warn ?? ((l: string) => console.warn(l));
  background = (async () => {
    const runPreflight = deps?.runPreflight ?? (await import("./preflight")).runPreflight;
    let repoRoot = deps?.repoRoot ?? null;
    if (deps?.repoRoot === undefined) {
      try {
        repoRoot = (await import("./paths")).findRepoRoot();
      } catch {
        repoRoot = null;
      }
    }
    return bootDeployPreflight({
      measure: deps?.measure ?? measureDeployDeclarations,
      runPreflight,
      repoRoot,
      env: deps?.env ?? process.env,
      log: deps?.log ?? ((l: string) => console.log(l)),
      warn,
    });
  })().catch((err) => {
    warn(`[harness-boot] preflight do deploy declarado falhou: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  });
  return background;
}

/** Só para teste: esquece a passada deste processo. */
export function resetDeployPreflightForTest(): void {
  background = null;
}
