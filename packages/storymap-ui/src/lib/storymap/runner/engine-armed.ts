// engine-armed — o ÚNICO portão do boot: este processo pode agir sobre o repositório, ou só servir HTTP?
//
// O `register()` do instrumentation arma, de uma vez, coisas que MEXEM no repo compartilhado: escreve
// o `service.lock` (que declara autoridade sobre o board-data do checkout), varre worktrees de sessão
// com `git worktree remove --force`, recupera o MERGE TRAIN (que faz merge/push sobre o `.git`),
// respawna runs, arma a fila de publicação (que DEPLOYA) e o tick do copiloto (que gasta dinheiro).
//
// Nada disso tem gate hoje: `AGILEHARNESS_AUTORUN=0` cobre 4 dos ~15 efeitos e NÃO cobre o reaper nem o train.
// Consequência observada em 2026-07-23: subir `next start` de dentro de um worktree — algo que se faz
// para validar UI, e que a própria skill de QA faz no dogfood — arma um SEGUNDO merge train sobre o
// MESMO `.git` do serviço de produção, e um reaper que declarou quatro worktrees de sessão VIVOS como
// mortos e tentou removê-los.
//
// A regra é all-or-nothing DE PROPÓSITO: um portão por efeito seria a chance de terminar meio-armado
// (fila de publicação viva com train morto), que é pior que qualquer um dos dois estados inteiros.
//
// O que NÃO some quando o motor está desarmado: servir páginas, server actions, e o watcher de SSE —
// este último porque `/api/notifications/stream` já chama `ensureWatching()` na conexão. Ou seja, uma
// instância de validação/QA continua com board ao vivo; ela só perde o direito de AGIR sobre o repo.

/** Como o processo decidiu, para o log e para as superfícies de saúde. */
export interface EngineArmedVerdict {
  armed: boolean;
  /** Frase de operador — por que armou ou não. Nunca vazia. */
  reason: string;
}

export interface EngineArmedInputs {
  /** `process.env.AGILEHARNESS_ENGINE` cru (undefined quando não setado). */
  flag: string | undefined;
  /**
   * `.git` da raiz do repo é um DIRETÓRIO? É o discriminador ESTRUTURAL entre o checkout canônico
   * (diretório) e um `git worktree` (arquivo com `gitdir: …`). `null` = não deu para saber.
   *
   * Estrutural em vez de configurável porque o caso PERIGOSO não pode depender de alguém lembrar de
   * setar algo: quem sobe um servidor de dentro de um worktree está validando UI, não operando o
   * pipeline, e nunca vai pensar num env var.
   */
  gitIsDirectory: boolean | null;
}

/**
 * A decisão, PURA. Ordem: desligar explícito vence tudo; ligar explícito é o escape hatch; o resto é
 * estrutural; e não-sei é INERTE.
 *
 * A direção da falha importa mais que o acerto: um processo inerte por engano deixa o código parado em
 * `stage` e o operador percebe ("não publicou"); um processo armado por engano faz merge, deleta
 * worktree e deploya em cima de outro. Por isso o único jeito de armar onde o default diz que não é o
 * literal EXATO `on` — qualquer outro valor (typo incluído) cai no estrutural, que já é a resposta
 * certa para o lugar.
 */
export function engineArmedDecision({ flag, gitIsDirectory }: EngineArmedInputs): EngineArmedVerdict {
  const normalized = flag?.trim().toLowerCase();

  if (normalized === "off") {
    return { armed: false, reason: "AGILEHARNESS_ENGINE=off (desligado explicitamente)" };
  }
  if (normalized === "on") {
    return { armed: true, reason: "AGILEHARNESS_ENGINE=on (ligado explicitamente)" };
  }
  if (gitIsDirectory === true) {
    return { armed: true, reason: "checkout canônico (.git é diretório)" };
  }
  if (gitIsDirectory === false) {
    return {
      armed: false,
      reason: "git worktree (.git é arquivo) — um segundo motor sobre o mesmo repo não é seguro",
    };
  }
  return { armed: false, reason: "não foi possível ler .git — na dúvida, inerte" };
}

/** Texto do aviso de boot. Um board INERTE tem de ser distinguível de um board OCIOSO. */
export function engineInertWarning(reason: string): string {
  return (
    `[harness-boot] MOTOR INERTE (${reason}): este processo só SERVE — sem service.lock, sem recuperação ` +
    `de runs, sem varredura de worktree, sem merge train, sem fila de publicação e sem tick do ` +
    `copiloto. Páginas, server actions e SSE seguem funcionando. Para armar mesmo assim: AGILEHARNESS_ENGINE=on.`
  );
}
