// A COR de cada presença — o vocabulário ÚNICO que o card, o filete, a legenda, o pulso do Kanban e o nav desenham.
//
// O PROBLEMA: o nav e o card tinham paletas próprias e se contradiziam. Âmbar era «pede você» no chip do
// Inbox e «na fila» no ponto do card; a pílula do dono era preta; verde pulsava no nav para «run ativo» e azul pulsava
// no card para «trabalhando», inclusive sobre um condutor parado no prompt. O dono não tinha como aprender o que cada
// cor dizia, porque ela dizia coisas diferentes em cada lugar.
//
// A DECISÃO C3: uma cor, um significado, em toda tela — e sempre com FORMA e TEXTO junto, nunca só cor:
//   • owner      — precisa de você: âmbar PREENCHIDO (a pílula, o filete, o chip do Inbox);
//   • working    — agindo agora, com evidência fresca: azul, e o ÚNICO que pulsa;
//   • delivering — a vez é do sistema (integrando, publicando): violeta, sem pulso;
//   • waiting    — parado (círculo vazio) ou na fila (círculo tracejado): cinza — o sistema cutuca sozinho, não é
//                  alarme;
//   • stopped    — falhou e ninguém cuida: terracota (`--danger`), o único vermelho;
//   • live       — no ar: verde, só como texto.
// Os tokens moram em globals.css (`--state-*`, AA nos dois temas — presence-tone.test.ts mede).
//
// PURO e isomórfico: só strings de classe (o Tailwind as acha aqui, `content` varre src/**/*.ts).

import type { CardLiveKind, CardPresence } from "./card-live-status";

/** A forma do ponto: cheio, círculo vazio (parado), tracejado (na fila) ou nenhum (no ar — só o texto). */
export type PresenceMark = "filled" | "ring" | "dashed" | "none";

export interface PresenceTone {
  /** o ponto da linha de estado (forma + cor). */
  dot: string;
  /** o filete à esquerda do card. */
  rail: string;
  /** a tinta da frase. */
  text: string;
  mark: PresenceMark;
  /** só quem trabalha com prova pulsa (card-live-status.ts `presencePulses`). */
  pulse: boolean;
  /** o nome da presença na legenda do Kanban. */
  legend: string;
}

/** A classe do pulso — o movimento só existe sem `prefers-reduced-motion` (globals.css `.state-pulse`). */
export const STATE_PULSE = "state-pulse";

const RING = "border-[1.5px] border-state-idle bg-transparent";
const DASHED = "border-[1.5px] border-dashed border-state-idle bg-transparent";

/** Cada presença, uma cor. Record exaustivo: uma presença nova sem cor não compila. */
export const PRESENCE_TONE: Readonly<Record<CardPresence, PresenceTone>> = {
  owner: { dot: "bg-state-owner", rail: "bg-state-owner", text: "text-fg", mark: "filled", pulse: false, legend: "Precisa de você" },
  working: { dot: "bg-state-working", rail: "bg-state-working", text: "text-fg", mark: "filled", pulse: true, legend: "Agindo" },
  delivering: { dot: "bg-state-delivering", rail: "bg-state-delivering", text: "text-fg", mark: "filled", pulse: false, legend: "Sistema entregando" },
  waiting: { dot: RING, rail: "bg-state-idle", text: "text-fg", mark: "ring", pulse: false, legend: "Parado ou na fila" },
  stopped: { dot: "bg-danger", rail: "bg-danger", text: "text-danger", mark: "filled", pulse: false, legend: "Falhou, ninguém cuida" },
  live: { dot: "", rail: "bg-transparent", text: "text-state-live", mark: "none", pulse: false, legend: "No ar" },
};

/**
 * A cor de UMA linha de estado: a da presença, com a forma que o tipo pede — a fila do condutor é TRACEJADA (ainda
 * não tem agente), o resto da espera é o círculo vazio. PURA.
 */
export function presenceTone(s: { presence: CardPresence; kind: CardLiveKind }): PresenceTone {
  const base = PRESENCE_TONE[s.presence];
  if (s.kind === "queued") return { ...base, dot: DASHED, mark: "dashed" };
  return base;
}

/** A ordem da legenda: o que pede você, quem age, o sistema, quem espera, o que falhou, o que está no ar. */
export const LEGEND_ORDER: readonly CardPresence[] = ["owner", "working", "delivering", "waiting", "stopped", "live"];
