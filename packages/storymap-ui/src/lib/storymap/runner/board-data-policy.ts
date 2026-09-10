// A POLÍTICA DE VERSIONAMENTO DO BOARD — quem tem o direito de commitar, e quem tem o de EMPURRAR.
//
// POR QUE ESTE MÓDULO EXISTE (auditoria de extração, 2026-08-19). O flush debounced de board-data
// (`board-data-flush.ts`) tinha UM único portão: `if (process.env.VITEST) return;`. Editar um card na
// interface commitava E dava `git push origin HEAD` no repositório de quem instalou a ferramenta —
// sem chave em `settings.yaml`, sem uma linha de documentação, e sem consultar o portão do boot. Ou
// seja, acontecia inclusive no processo que o próprio produto declara INERTE ("só serve HTTP, não age
// sobre o repositório"), que é o modo de um servidor de validação e de qualquer instância subida de
// dentro de um `git worktree`.
//
// AS DUAS DECISÕES SÃO DIFERENTES, e é essa distinção que o módulo carrega:
//
//   · **Commitar** é o VALOR do produto. "O `git log` do seu produto e o do seu processo de produto
//     passam a ser o mesmo log" é a promessa da primeira tela do README. Nasce LIGADO.
//   · **Empurrar** é distribuição. Escreve num remoto que a ferramenta não escolheu, que pode ser
//     compartilhado, protegido ou disparar CI. Para quem acabou de instalar, o default honesto é NÃO —
//     e ligar é um gesto de uma linha, declarado no env do serviço.
//
// A TERCEIRA trava é estrutural e não se declara: um processo com o motor INERTE não versiona nada.
// A régua é a MESMA do boot (`engineArmedDecision`) — não uma segunda definição de "posso agir", que
// é como se ganha um estado meio-armado (fila de publicação viva com train morto).
//
// Puro sobre `env` e sobre o probe de `.git`, para a árvore de decisão inteira ser testável sem disco.

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "@/lib/storymap/paths";
import { engineArmedDecision, type EngineArmedVerdict } from "./engine-armed";

/** Liga o `git push` do board-data. Ausente/qualquer-outro-valor ⇒ DESLIGADO. */
export const BOARD_AUTOPUSH_ENV = "AGILEHARNESS_BOARD_AUTOPUSH";
/** Desliga o commit automático do board-data. Ausente ⇒ LIGADO (é o valor do produto). */
export const BOARD_AUTOCOMMIT_ENV = "AGILEHARNESS_BOARD_AUTOCOMMIT";

type EnvLike = Record<string, string | undefined>;

/**
 * Versionar o board localmente. Default LIGADO — desligar exige o literal `0`, e é para quem quer a
 * ferramenta como editor puro, versionando à mão.
 */
export function boardDataAutoCommitAllowed(env: EnvLike = process.env): boolean {
  return (env[BOARD_AUTOCOMMIT_ENV] ?? "").trim() !== "0";
}

/**
 * Empurrar o board para o `origin`. Default DESLIGADO — ligar exige o literal `1`.
 *
 * O literal exato (e não "truthy") é a mesma disciplina do `AGILEHARNESS_ENGINE=on`: habilitar escrita num
 * remoto de terceiro não pode ser consequência de um typo (`AGILEHARNESS_BOARD_AUTOPUSH=no` ligando a
 * coisa por ser string não-vazia é exatamente o acidente que a régua frouxa produz).
 */
export function boardDataAutoPushAllowed(env: EnvLike = process.env): boolean {
  return (env[BOARD_AUTOPUSH_ENV] ?? "").trim() === "1";
}

/**
 * Este processo pode versionar board-data? MESMA régua do boot: motor inerte ⇒ não.
 *
 * `gitIsDirectory` segue a semântica de {@link engineArmedDecision}: `true` no checkout canônico,
 * `false` num worktree linkado (`.git` é arquivo), `null` quando não deu para saber — e `null` é
 * INERTE, na dúvida.
 */
export function boardDataWriterDecision(
  env: EnvLike = process.env,
  gitIsDirectory: boolean | null = null,
): EngineArmedVerdict {
  return engineArmedDecision({ flag: env.AGILEHARNESS_ENGINE, gitIsDirectory });
}

let memo: EngineArmedVerdict | null = null;

/** Test-only: descarta o veredito memoizado. */
export function resetBoardDataWriterMemo(): void {
  memo = null;
}

/**
 * O veredito com o probe de disco feito (uma vez por processo). Nunca lança: um erro ao resolver a
 * raiz ou ler `.git` cai no lado INERTE, que é a direção segura — um flush que não acontece deixa o
 * trabalho visível na tela e no disco; um flush que acontece onde não devia escreve no repo alheio.
 */
export function isBoardDataWriterArmed(): EngineArmedVerdict {
  if (memo) return memo;
  let gitIsDirectory: boolean | null = null;
  try {
    const dotGit = path.join(findRepoRoot(), ".git");
    gitIsDirectory = existsSync(dotGit) ? statSync(dotGit).isDirectory() : null;
  } catch {
    gitIsDirectory = null;
  }
  memo = boardDataWriterDecision(process.env, gitIsDirectory);
  return memo;
}

/** O que o flush vai fazer, resolvido de uma vez — para o caminho de escrita não repetir a régua. */
export type FlushPlan =
  | { versiona: false; motivo: string }
  | { versiona: true; empurra: boolean };

/**
 * A decisão COMPLETA do flush, PURA sobre o env e o veredito do motor.
 *
 * Existe como função (e não como três `if` no corpo do flush) porque o corpo é inalcançável em teste:
 * `scheduleBoardDataFlush` sai cedo sob `VITEST` para a suíte nunca disparar git. Sem esta separação,
 * a régua que decide escrever no repositório de outra pessoa seria a única do módulo sem cobertura.
 */
export function planBoardDataFlush(
  env: EnvLike = process.env,
  armed: EngineArmedVerdict = boardDataWriterDecision(env),
): FlushPlan {
  if (!armed.armed) return { versiona: false, motivo: `motor inerte (${armed.reason})` };
  if (!boardDataAutoCommitAllowed(env)) return { versiona: false, motivo: `${BOARD_AUTOCOMMIT_ENV}=0` };
  return { versiona: true, empurra: boardDataAutoPushAllowed(env) };
}
