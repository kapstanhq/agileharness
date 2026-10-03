// B13 / F4 (auditoria do Inbox) — o STATUS DA PUBLICAÇÃO de um card: o que o «Ver status»/«Ver log» do
// Inbox mostra.
//
// Antes, `getDeployFailureLogAction` lia SEMPRE `storymap/.runner/self-deploy.log` — o log do build da PRÓPRIA
// ferramenta — para qualquer board e qualquer card, num modal chamado «Log da falha de deploy». Num card de um
// board de produto o deploy era outro job, com outro log; o modal mostrava um build antigo da
// ferramenta e «Nenhum finding deploy-failure aberto». O dono era mandado «verificar se o serviço
// subiu» com a evidência de outra coisa.
//
// Aqui: o veredito PRIMEIRO — o código deste card está no ar? sim / não / não medido, pela MESMA régua de
// ancestralidade do settle (measureDeployAncestry) — e depois o log do deploy DO BOARD: o job do registry do alvo
// (o que `deploy_status` mostra), ou o arquivo de log do alvo quando o job já saiu da memória. Só o board da
// própria ferramenta lê o self-deploy.log. Estritamente leitura.

import { promises as fs } from "node:fs";
import path from "node:path";
import { DEPLOY_UNPROVEN_TEXT, makeGitContains, measureDeployAncestry, readLastDeploySha, type DeployProofMeasurement } from "./deploy-reconcile";
import { resolveDeployKind, TOOL_PACKAGE_REL } from "./deploy";
import { declaredDeployPolicy, deployPkgForPackage, getProductDeploy, logFileFor, productDeployTargets } from "./product-deploy";
import { defaultExec } from "./worktree";
import { findRepoRoot, runnerStateDir } from "@/lib/storymap/paths";
import { readBoardConfig, readCard } from "@/lib/storymap/repo";
import { DEPLOY_FAILURE_FINDING_ID, DEPLOY_UNPROVEN_FINDING_ID } from "@/lib/storymap/demands";
import type { BoardConfig, Card } from "@/lib/storymap/types";

export type PublishLogTargets = { kind: "registry"; targets: string[] } | { kind: "self" } | { kind: "none" };

/**
 * DE ONDE vem o log do deploy deste card. PURE. Os alvos que o disparo carimbou no card vencem; sem eles, o deploy
 * que o board declara (chave do job = id do board), ou o pacote do board entre os alvos declarados. Só o board da
 * ferramenta (o self-deploy) lê o self-deploy.log; um board sem alvo não tem log de deploy.
 *
 * `packageRoot` é o prefixo que o ALVO declara (settings.yaml → deploy.legacy.packageRoot) e que `deployPkgForPackage`
 * tira de `package` para achar o id do alvo. Entra por PARÂMETRO (sem default lido do settings da máquina) para que
 * a função continue PURA e o teste não dependa de quem hospeda a suíte; `readPublishStatus` é quem lê a declaração.
 * null/ausente ⇒ o `package` inteiro é comparado com os alvos (o neutro).
 */
export function publishLogTargets(
  card: Pick<Card, "deployTargets">,
  config: Pick<BoardConfig, "id" | "package" | "deploy">,
  productTargets: readonly string[],
  packageRoot: string | null = null,
): PublishLogTargets {
  const carimbados = card.deployTargets?.filter(Boolean) ?? [];
  if (carimbados.length > 0) return { kind: "registry", targets: carimbados };
  const declarado = resolveDeployKind(config.deploy);
  if (declarado === "command" || declarado === "agent") return { kind: "registry", targets: [config.id] };
  const pkg = deployPkgForPackage(config.package, productTargets, packageRoot);
  if (pkg) return { kind: "registry", targets: [pkg] };
  if (config.package?.replace(/\/+$/, "") === TOOL_PACKAGE_REL) return { kind: "self" };
  return { kind: "none" };
}

export interface PublishVerdict {
  state: "live" | "not-live" | "not-measured";
  /** a frase, em português, que abre o modal. */
  text: string;
}

/**
 * O VEREDITO: o código deste card está no ar? PURE. A prova carimbada (o settle já mediu) vence; senão a medição de
 * agora. «Não» só quando a medição provou que o que está no ar é ANTERIOR ao código dele; sem de onde medir, «não
 * medido» — com o porquê em português (DEPLOY_UNPROVEN_TEXT), nunca o código cru.
 */
export function publishVerdict(card: Pick<Card, "deployProof">, measurement: DeployProofMeasurement | null): PublishVerdict {
  if (card.deployProof) {
    const day = card.deployProof.at?.slice(0, 10);
    return { state: "live", text: `Sim — o código deste card está no ar (commit ${card.deployProof.sha.slice(0, 8)}${day ? `, provado em ${day}` : ""}).` };
  }
  if (!measurement) return { state: "not-measured", text: "Não medido — não há de onde medir se o código deste card está no ar." };
  if (measurement.proven) return { state: "live", text: `Sim — o último deploy contém o código deste card (commit ${measurement.sha.slice(0, 8)}).` };
  if (measurement.reason === "deploy-anterior-ao-codigo") {
    return { state: "not-live", text: `Não — ${DEPLOY_UNPROVEN_TEXT[measurement.reason].why}.` };
  }
  return { state: "not-measured", text: `Não medido — ${DEPLOY_UNPROVEN_TEXT[measurement.reason].why}.` };
}

export interface PublishStatusLog {
  target: string;
  path: string;
  /** o fim do log (~16KB); null quando o arquivo não existe/é ilegível. */
  tail: string | null;
  /** o job do registry, quando ele ainda está na memória do serviço. */
  job?: { status: "running" | "done" | "failed"; startedAt: number; finishedAt?: number; exitCode?: number };
}

export interface PublishStatus {
  verdict: PublishVerdict;
  /** o finding aberto que explica a publicação (a falha, ou a prova que não fechou). */
  finding: { title: string; detail: string | null } | null;
  deployFiredAt: string | null;
  logs: PublishStatusLog[];
}

export interface PublishStatusDeps {
  readCard(board: string, cardId: string): Promise<Card | null>;
  readConfig(board: string): Promise<BoardConfig | null>;
  productTargets(): readonly string[];
  /** deploy.legacy.packageRoot do alvo (o prefixo que sai de `package`); null quando não declarado. */
  packageRoot(): string | null;
  jobOf(target: string): { logFile: string; status: "running" | "done" | "failed"; startedAt: number; finishedAt?: number; exitCode?: number } | undefined;
  logFileFor(target: string): string;
  selfDeployLog(): string;
  readTail(file: string): Promise<string | null>;
  measure(card: Card): Promise<DeployProofMeasurement | null>;
}

const TAIL_BYTES = 16_384;

const defaultDeps: PublishStatusDeps = {
  readCard: (b, c) => readCard(b, c),
  readConfig: (b) => readBoardConfig(b).catch(() => null),
  productTargets: () => productDeployTargets(),
  packageRoot: () => declaredDeployPolicy().legacy.packageRoot ?? null,
  jobOf: (t) => getProductDeploy().get(t),
  logFileFor: (t) => logFileFor(t),
  // O self-deploy grava onde a ferramenta roda (deploy.ts: `<repo>/storymap/.runner/self-deploy.log`), que em
  // produção é o diretório de estado do runner.
  selfDeployLog: () => path.join(runnerStateDir(), "self-deploy.log"),
  readTail: async (file) => {
    try {
      const raw = await fs.readFile(file, "utf8");
      return raw.length > TAIL_BYTES ? raw.slice(-TAIL_BYTES) : raw;
    } catch {
      return null;
    }
  },
  measure: async (card) => {
    const repoRoot = findRepoRoot();
    return measureDeployAncestry(card, (t) => readLastDeploySha(repoRoot, t), makeGitContains(defaultExec, repoRoot)).catch(() => null);
  },
};

/** O status da publicação de um card, para o modal do Inbox. null quando o card não existe. Só leitura. */
export async function readPublishStatus(boardId: string, cardId: string, deps: PublishStatusDeps = defaultDeps): Promise<PublishStatus | null> {
  const [card, config] = await Promise.all([deps.readCard(boardId, cardId), deps.readConfig(boardId)]);
  if (!card) return null;
  const finding =
    (card.findings ?? []).find((f) => f.status === "open" && (f.id === DEPLOY_FAILURE_FINDING_ID || f.id === DEPLOY_UNPROVEN_FINDING_ID)) ?? null;
  const measurement = card.deployProof ? null : await deps.measure(card);
  const where = config ? publishLogTargets(card, config, deps.productTargets(), deps.packageRoot()) : ({ kind: "none" } as const);
  const logs: PublishStatusLog[] = [];
  if (where.kind === "registry") {
    for (const target of where.targets) {
      const job = deps.jobOf(target);
      const file = job?.logFile ?? deps.logFileFor(target);
      logs.push({
        target,
        path: file,
        tail: await deps.readTail(file),
        ...(job
          ? {
              job: {
                status: job.status,
                startedAt: job.startedAt,
                ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
                ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
              },
            }
          : {}),
      });
    }
  } else if (where.kind === "self") {
    const file = deps.selfDeployLog();
    logs.push({ target: "a própria ferramenta", path: file, tail: await deps.readTail(file) });
  }
  return {
    verdict: publishVerdict(card, measurement),
    finding: finding ? { title: finding.title, detail: finding.detail ?? null } : null,
    deployFiredAt: card.deployFiredAt ?? null,
    logs,
  };
}
