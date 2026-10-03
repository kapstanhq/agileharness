// O MODO DOS REAPERS: apagar de verdade, ou apenas RELATAR o que apagaria.
//
// ── POR QUE ISTO EXISTE ─────────────────────────────────────────────────────────────────────────────
// O par mais perigoso do inventário multi-target é **resolução de raiz que não falha alto + operação
// destrutiva sobre o resultado**. F0 matou a primeira metade (paths.ts fail-loud). Esta é a segunda.
//
// ⚠ COBERTURA ATUAL, dita com precisão (uma revisão pegou este comentário afirmando mais do que o código
// entrega): o modo está ligado ao **`git branch -D` do branch-gc de boot** — o reaper que roda sobre a
// raiz recém-resolvida, que é o caminho de risco. O `git worktree remove --force` de `worktree-gc` e o
// `session-gc` AINDA NÃO passam por aqui; eles entram junto com o reaper por-alvo em F3. Escrever "o par
// inteiro ganhou modo relatório" seria exatamente a classe de afirmação sem lastro que F0 existe para
// remover, então está escrito o que é.
//
// O instante de maior risco de raiz errada não é o regime permanente: é o REGISTRO de um alvo novo,
// justamente quando a resolução ainda não foi exercitada por nada. A política por alvo que automatiza
// isso é de F3 (quando existir registro de alvos); F0 entrega o MECANISMO e o interruptor global, que é
// o que permite operar com segurança enquanto isso não existe.
//
// Custo de estar em modo relatório: alguns branches órfãos sobrevivendo. Benefício: um erro de
// configuração de alvo deixa de ter classe irreversível. É fail-safe aplicado onde não há rollback.

import type { EnvLike } from "./autonomy-sandbox";

export type ReaperMode = "report" | "delete";

/**
 * O modo GLOBAL, por env. `AGILEHARNESS_REAPER_MODE=report` põe todo reaper em modo relatório.
 *
 * O default é `delete` — deliberadamente, e vale escrever por quê: mudar o default agora deixaria
 * branches e worktrees órfãos acumulando numa instalação que hoje funciona, o que é uma regressão real
 * de operação disfarçada de cautela. O interruptor existe para ser LIGADO quando se aponta o motor para
 * um alvo novo, e é isso que a política por alvo automatiza em F3.
 */
export function resolveReaperMode(env: EnvLike): ReaperMode {
  const raw = env.AGILEHARNESS_REAPER_MODE?.trim().toLowerCase();
  if (raw === "report") return "report";
  // ── FALHA ABERTO EM SILÊNCIO, E AQUI O "ABERTO" É DESTRUTIVO (achado de revisão) ─────────────────
  // Medido: `reprot`, `dry-run` e `true` caíam todos em `delete` — o modo que APAGA branch e worktree —
  // sem uma linha de log. Quem digitou errado pediu o freio e recebeu a serra, achando que tinha o
  // freio. O default silencioso continua sendo `delete` (é o comportamento de sempre, e ligar `report`
  // por engano faria órfãos acumularem numa instalação que funciona), mas um valor PRESENTE e não
  // reconhecido não pode ser tratado como ausência.
  if (raw !== undefined && raw !== "") {
    console.error(
      `[reaper] AGILEHARNESS_REAPER_MODE="${raw}" não é um valor reconhecido. Aceitos: report. ` +
        `Assumindo "delete" — se você quis o modo RELATÓRIO, ele NÃO está ligado e a limpeza vai APAGAR.`,
    );
  }
  return "delete";
}

// A POLÍTICA POR ALVO (período de graça de N dias para um alvo recém-registrado) VIVIA AQUI e foi
// REMOVIDA: ela não tinha nenhum consumidor de produção, e manter função + constante + cinco testes para
// um comportamento que ninguém chama é exatamente a "estrutura sem uso" que este mesmo plano usou como
// razão para adiar outro item. Ela volta em F3, junto com o registro de alvos — que é o que lhe dá
// sujeito. O mecanismo que F0 entrega é o interruptor global acima, e ele TEM consumidor.

/** Uma deleção que o modo relatório interceptou. O que acontece com ela é responsabilidade do chamador,
 *  via `onReport` — este módulo não escreve journal (um comentário anterior dizia que sim, e não era
 *  verdade em nenhum call-site). O que ele SEMPRE faz é avisar em stderr. */
export interface ReaperReport {
  kind: "branch" | "worktree";
  ref: string;
  wouldDeleteAt: number;
}

/**
 * Envolve uma operação destrutiva no modo corrente. Em `report`, NÃO executa: registra e devolve
 * `false` (o mesmo formato de "não apagou" que os chamadores já sabem tratar), para o modo relatório
 * não precisar de um caminho de código paralelo — caminho paralelo é como um modo seguro apodrece.
 */
export async function guardDestructive(
  mode: ReaperMode,
  what: ReaperReport,
  run: () => Promise<boolean>,
  onReport?: (r: ReaperReport) => void,
): Promise<boolean> {
  if (mode === "report") {
    onReport?.(what);
    console.warn(
      `[harness-reaper] MODO RELATÓRIO: apagaria ${what.kind} "${what.ref}" — nada foi executado ` +
        `(AGILEHARNESS_REAPER_MODE=report). Desligue o modo para que a limpeza volte a agir.`,
    );
    return false;
  }
  return run();
}
