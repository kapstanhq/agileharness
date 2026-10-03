// A TERCEIRA VAGA de condutor — fatia 4 das «paradas por recurso» (por decisão do operador).
//
// O board aceita `conductor.maxSessions` condutores por vez. Com a fila esperando e a máquina ociosa, uma vaga a mais
// entrega mais cedo; com a máquina ou a cota apertadas, ela piora tudo (a integração roda a suíte inteira e pede muita memória,
// e a cota é a mesma das sessões do dono). A decisão do operador: «vaga extra com todas as travas», conservadoras —
//   • processador abaixo de metade dos núcleos (carga de 1 min < `loadPerCore` × núcleos);
//   • memória disponível acima de `ramFreeMb`;
//   • janela de 5 horas da cota abaixo de `fiveHourMaxPct` e a SEMANA no ritmo (card-budget.ts `quotaPace`);
//   • fila de integração vazia;
//   • só card pequeno (bug ou ajuste), e só UMA vaga a mais.
// A carga é medida SEM a integração em curso (`gateLoad`): a integração já tem a sua trava própria.
// A vaga «fecha quando o card termina» por construção: o que conta é quantos condutores estão VIVOS — quando o extra
// encerra, o board volta ao limite, e outra vaga extra só nasce se TODAS as travas passarem de novo.
// PURO: os fatos chegam prontos; a fiação mora em fleet-deps.ts.

import type { Card } from "@/lib/storymap/types";
import type { QuotaPace } from "./card-budget";

/** `autorun.extraSlot` do settings. */
export interface ExtraSlotSettings {
  /** quantas vagas além de `maxSessions` (0 = desligado). */
  max: number;
  /** a carga de 1 min tem de estar ABAIXO de `loadPerCore` × núcleos. */
  loadPerCore: number;
  /** a memória disponível tem de estar ACIMA disto (MB). */
  ramFreeMb: number;
  /** a janela de 5 horas da cota tem de estar ABAIXO disto (%). */
  fiveHourMaxPct: number;
}
export const DEFAULT_EXTRA_SLOT: ExtraSlotSettings = { max: 1, loadPerCore: 0.5, ramFreeMb: 5000, fiveHourMaxPct: 60 };

export interface ExtraSlotFacts {
  /** condutores vivos no board agora. */
  live: number;
  /** o limite declarado do board. */
  maxSessions: number;
  loadAvg1: number;
  /**
   * Núcleos ocupados AGORA pela integração (o slice do gate, medido pelo cgroup). A carga de 1 min inclui a
   * suíte do merge train, que é passageira e já tem a sua própria trava (`mergeBusy`): contá-la de novo fechava a vaga
   * extra exatamente quando havia fila (carga alta com 2 condutores e o gate). Ausente ⇒ 0.
   */
  gateLoad?: number;
  cores: number;
  freeRamMb: number;
  /** a semana no ritmo E a janela de 5 horas abaixo do limite desta fatia (quotaPace com `fiveHourMaxPct`). */
  pace: QuotaPace;
  /** entradas vivas no merge train. */
  mergeBusy: number;
}

/**
 * QUAL trava fechou a vaga — a classe estável do motivo (o `why` traz números que mudam a cada passada). A fila do
 * condutor a grava em `lastWaitKind` (`slots:extra-closed:<trava>`), para o Kanban e o painel dizerem a trava real.
 */
export type ExtraSlotLock = "off" | "used" | "card-size" | "load" | "ram" | "quota" | "merge";

export type ExtraSlotVerdict = { open: true; why: string } | { open: false; why: string; lock: ExtraSlotLock };

/** Card pequeno = bug ou ajuste (chore). Uma story de usuário, um spike ou trabalho técnico amplo esperam a vaga normal. */
export function isSmallCard(card: Pick<Card, "storyType">): boolean {
  return card.storyType === "bug" || card.storyType === "chore";
}

/** Uma leitura do contador de CPU do slice do gate (`usage_usec` do cgroup) e quando foi feita. */
export interface GateCpuSample {
  at: number;
  usec: number;
}

/**
 * Núcleos que o gate ocupou entre duas leituras do contador — PURA. Só vale um par separado por 10 s a 5 min (fora
 * disso a média não descreve o último minuto, o horizonte da carga de 1 min) e com o contador andando para a frente
 * (um cgroup recriado zera o contador); senão 0, o lado de hoje (a carga inteira conta).
 */
export function gateCoresBetween(prev: GateCpuSample | undefined, cur: GateCpuSample): number {
  if (!prev) return 0;
  const dt = cur.at - prev.at;
  if (dt < 10_000 || dt > 5 * 60_000 || cur.usec < prev.usec) return 0;
  return (cur.usec - prev.usec) / (dt * 1000);
}

/** A carga que conta para a vaga extra: a de 1 min menos a integração em curso, nunca abaixo de zero. PURA. */
export function loadWithoutGate(f: Pick<ExtraSlotFacts, "loadAvg1" | "gateLoad">): number {
  return Math.max(0, f.loadAvg1 - Math.max(0, f.gateLoad ?? 0));
}

/**
 * A vaga extra do BOARD está aberta agora, para um card pequeno? PURA — as travas da máquina, da cota e da integração,
 * sem olhar o card (o nav mostra «vaga extra aberta/fechada: por quê» sem ter um card na mão). A primeira que falha é
 * o motivo.
 */
export function extraSlotBoardVerdict(f: ExtraSlotFacts, s: ExtraSlotSettings): ExtraSlotVerdict {
  if (!(s.max > 0)) return { open: false, why: "a vaga extra está desligada", lock: "off" };
  if (f.live >= f.maxSessions + s.max) return { open: false, why: `o board já usa ${f.live - f.maxSessions} vaga(s) extra(s)`, lock: "used" };
  const load = loadWithoutGate(f);
  const loadCeiling = s.loadPerCore * Math.max(1, f.cores);
  const gate = (f.gateLoad ?? 0) > 0 ? `, sem os ${(f.gateLoad ?? 0).toFixed(1)} da integração` : "";
  if (!(load < loadCeiling)) return { open: false, why: `processador em ${load.toFixed(1)}${gate} (a vaga extra pede abaixo de ${loadCeiling.toFixed(1)})`, lock: "load" };
  if (!(f.freeRamMb > s.ramFreeMb)) return { open: false, why: `memória livre em ${Math.round(f.freeRamMb)} MB (a vaga extra pede acima de ${s.ramFreeMb} MB)`, lock: "ram" };
  if (!f.pace.onPace) return { open: false, why: f.pace.detail, lock: "quota" };
  if (f.mergeBusy > 0) return { open: false, why: `a fila de integração tem ${f.mergeBusy} entrada(s) viva(s)`, lock: "merge" };
  return { open: true, why: `processador em ${load.toFixed(1)}${gate}, ${Math.round(f.freeRamMb / 1000)} GB livres, fila de integração vazia e ${f.pace.detail}` };
}

/** Este card pode ganhar uma vaga extra AGORA? PURA — a primeira trava que falha é o motivo. */
export function extraSlotVerdict(card: Pick<Card, "storyType">, f: ExtraSlotFacts, s: ExtraSlotSettings): ExtraSlotVerdict {
  const board = extraSlotBoardVerdict(f, s);
  if (!board.open && (board.lock === "off" || board.lock === "used")) return board;
  if (!isSmallCard(card)) return { open: false, why: "só card pequeno (bug ou ajuste) usa a vaga extra", lock: "card-size" };
  return board;
}
