// WS-3 — o `service.lock`: a declaração "É AQUI que o serviço AgileHarness roda".
//
// POR QUE existe: board-data do checkout runtime tem UM escritor — o serviço (D4). O que serializa
// esse escritor é o lock IN-PROCESS de write.ts (withKeyedLock/updateCardOnDisk), que não vale nada
// contra OUTRO processo. O hook `.claude/hooks/checks/pre-{write,edit}/block-runtime-board-writes.js`
// recusa Write/Edit de agente em `storymap/boards/**` — mas só onde há serviço VIVO, porque só ali
// existe um lock in-process a respeitar. Este arquivo é como o hook sabe disso.
//
// CONTRATO com o hook (que é JS puro em .claude/, sem import daqui — o path é literal lá):
//   - Path:     <checkout>/storymap/.runner/service.lock
//   - Conteúdo: { pid, port, startedAt }
//   - Vivo:     o hook valida o pid (kill(0) + /proc/<pid>/cmdline). Sem lock ou pid morto ⇒ NO-OP.
// ⚠️ `AGILEHARNESS_RUNNER_STATE_DIR` redireciona runnerStateDir() (a suíte SEMPRE o aponta para um temp
// dir): sob teste o lock não suja o checkout vivo, e o hook — que lê o path literal — não vê nada.
// Em produção o override não existe e os dois caminhos coincidem.
//
// CICLO DE VIDA: escrito (sobrescrito) a cada boot — um lock STALE de crash não pode bloquear
// ninguém, e o pid novo simplesmente vence o antigo. NÃO removemos no shutdown: instalar um handler
// de SIGTERM sobrescreveria o comportamento default de término do processo (o serviço só sairia se
// nós chamássemos process.exit), o que é risco desnecessário no shutdown do systemd por um arquivo
// que a checagem de pid do hook já trata como stale. Serviço morto ⇒ lock stale ⇒ hook NO-OPa ⇒
// edição manual de emergência liberada, que é exatamente a política.

import { promises as fs } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";

export interface ServiceLock {
  /** pid do processo do serviço (next-server). O hook valida liveness com isto. */
  pid: number;
  /** porta HTTP do serviço — diagnóstico (qual serviço é este), não usada na decisão do hook. */
  port: number;
  /** ISO do boot que escreveu este lock. */
  startedAt: string;
}

export function serviceLockPath(): string {
  return path.join(runnerStateDir(), "service.lock");
}

/**
 * Escreve o lock do boot. Best-effort: NUNCA lança — falhar em escrever um arquivo de diagnóstico
 * jamais pode derrubar o boot do serviço (o custo de falhar é o hook não enforçar, que é o
 * comportamento fail-open dele de qualquer forma). Devolve o lock escrito, ou null se não deu.
 */
export async function writeServiceLock(): Promise<ServiceLock | null> {
  const lock: ServiceLock = {
    pid: process.pid,
    port: Number(process.env.PORT) || 3008,
    startedAt: new Date().toISOString(),
  };
  try {
    await fs.mkdir(runnerStateDir(), { recursive: true });
    await fs.writeFile(serviceLockPath(), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    return lock;
  } catch {
    return null;
  }
}
