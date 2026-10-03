// A ÚNICA leitura de git que a fila de publicação faz: qual é o sha do branch de staging AGORA.
//
// Isolado do resto da fila de propósito. `publish-queue.ts` decide (comparar shas, decidir supersede) e
// esse núcleo é testável sem git nenhum; aqui mora o efeito. A fila NÃO faz git próprio além disto — o
// promote/deploy é o efeito canônico (`firePromoteAndDeploy`), nunca um segundo caminho de deploy.

import { defaultExec, type ExecFn } from "./worktree";
import { findRepoRoot } from "@/lib/storymap/paths";
import { loadRunnerConfig } from "./config";

/**
 * Sha do branch de staging (`autorun.staging.branch`), ou `null` quando não dá para ler.
 *
 * `null` é significativo: a fila trata "não sei qual é o sha" como HOLD (segura o pedido), nunca como
 * "pode publicar". Um erro de leitura não pode virar autorização — comparar contra o sha é justamente o
 * que garante que vai ao ar o que o solicitante escolheu.
 *
 * `board` entra na assinatura porque a fila é por board e um repo consumidor pode um dia ter branch de
 * staging por board; hoje o `_base` declara um só, e ler a config (em vez de cravar "stage") é o que
 * mantém isto agnóstico.
 */
export async function stagingShaOf(_board: string, exec: ExecFn = defaultExec): Promise<string | null> {
  const branch = loadRunnerConfig().autorun.staging?.branch;
  if (!branch) return null;
  try {
    const { stdout } = await exec(`git rev-parse --verify --quiet ${JSON.stringify(`${branch}^{commit}`)}`, {
      cwd: findRepoRoot(),
      timeout: 30_000,
    });
    return String(stdout).trim() || null;
  } catch {
    return null; // branch inexistente / git fora do ar ⇒ "não sei" ⇒ a fila segura o pedido
  }
}
