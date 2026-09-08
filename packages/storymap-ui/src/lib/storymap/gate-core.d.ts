// Types for gate-core.js (the isomorphic CommonJS single-source of the pipeline gates). This
// .d.ts shadows the .js for type-checking so the TS app gets a fully typed API while the
// pre-write hook require()s the same .js at runtime. gates.ts / rice.ts / priority.ts re-export
// from here, so consumers keep their existing import paths.
import type { BoardConfig, Card, GateId, Rice } from "./types";
import type { BugSeverity } from "./frameworks";

/** Resolve um id de card para o card daquele board. O `hasPlacement` usa para validar a âncora. */
export type CardLookup = (id: string) => Card | null | undefined;

/** Contexto OPCIONAL do gate — só o `hasPlacement` lê hoje (ver placementViolation). */
export interface GateContext {
  lookup?: CardLookup;
  config?: BoardConfig;
}

/** Uma violação da invariante de hierarquia (ver placementViolation). */
export interface PlacementViolation {
  code: "activity-com-pai" | "sem-ancora" | "ancora-inexistente" | "ancora-de-tipo-errado";
  message: string;
}

export interface GateSpec {
  /** true = card satisfies the gate and may enter the status */
  ok: (card: Card, ctx?: GateContext) => boolean;
  /** rótulo curto PT-BR (chip da UI) */
  label: string;
  /** PT-BR reason returned when the gate fails */
  message: string;
  /** PT-BR actionable remediation (surfaced by the pre-write hook) */
  fix: string;
}

export interface GateVerdict {
  gate: GateId;
  label: string;
  message: string;
  fix: string;
}

export const GATES: Record<GateId, GateSpec>;
export const GATE_LABELS: Record<GateId, string>;

export function hasNarrative(card: Card): boolean;
/** Does the card touch a user-visible UI surface? Three tiers: MEASURED `uiSurfaceEvidence` (engine, from
 *  the run's diff) > explicit `hasUiSurface` > `storyType === "user"`. Drives gate hasQaPassed — a
 *  surface-bearing card must pass visual QA regardless of storyType. */
export function hasUiSurface(card: Card): boolean;
/** Did the QA that stamped this card look at the SCREEN? `qaEvidence.visual`, or null when nothing was
 *  recorded (absent ≠ false — the gate treats unknown differently from a negative). */
export function qaVisualProof(card: Card): boolean | null;
/** deploy-truth (D-DT4) — does the card POSITIVELY declare code (stagedAt stamped OR a full commitRange)?
 *  The single no-code ruler shared by hasReleased, hasDeployProof AND the server settle handler. */
export function declaresCode(card: Card): boolean;
export function riceScore(rice: Rice | null | undefined): number | null;
export function priorityKind(card: Card): "feature" | "bug" | "melhoria";
export function bugSeverityOf(card: Card): BugSeverity | null;

/** Board inheritance (B5) — merge two id-keyed RAW lists (base order + per-id override + append).
 *  The single algorithm behind repo.ts mergeRawById AND the pre-write gate hook. */
export function mergeById(base: unknown, board: unknown): unknown[];
/** Resolve a board's raw pipeline STATUSES over the raw _base template (honours `inheritPipeline`).
 *  The gate-relevant slice of repo.ts mergeRawConfig, isomorphic for the pre-write hook. */
export function resolveBoardStatuses(baseRaw: unknown, boardRaw: unknown): unknown[];

/**
 * A INVARIANTE de hierarquia do Story Map: activity é raiz · step sob activity · user story sob
 * step · entrega sob a user story que serve. Devolve null quando o card está em ordem. Contêineres
 * efêmeros, `idea` e cards em status de quarentena (`staging`) ou terminal ficam fora do
 * backbone por desenho e nunca violam. Sem `lookup` a checagem degrada para só a FORMA (tem âncora
 * declarada?); com ele valida também existência e tipo da âncora.
 */
export function placementViolation(
  card: Card,
  lookup?: CardLookup | null,
  config?: BoardConfig | null,
): PlacementViolation | null;
/** O que um card precisa como âncora. null = isento (contêiner/ideia/quarentena/terminal). */
export interface PlacementSpec {
  /** true só para `activity`: é raiz, não deve ter âncora nenhuma. */
  rootOnly?: boolean;
  /** o id da âncora declarada no card, já normalizado (null quando ausente). */
  anchorId: string | null;
  /** qual campo manda para este card — `serves` (entrega com override) ou `parent`. */
  field: "parent" | "serves";
  /** valida o TIPO do card-âncora. Ausente quando `rootOnly`. */
  accepts?: (anchor: Card) => boolean;
  /** descrição PT-BR do que a âncora deveria ser (entra na mensagem de erro). */
  wanted?: string;
}
/** Qual âncora ESTE card exige — o dono único da escolha de campo/tipo. Ver placementViolation. */
export function placementSpec(card: Card, config?: BoardConfig | null): PlacementSpec | null;
/** Rótulo PT-BR do que um card é ("uma user story", "um passo (step)"…), para mensagens de erro. */
export function describeCardKind(card: Card): string;

export function gateForStatus(config: BoardConfig, statusId: string | null | undefined): GateId | undefined;
export function evaluateGate(
  card: Card,
  statusId: string | null | undefined,
  config: BoardConfig,
  lookup?: CardLookup,
): GateVerdict | null;
export function checkGate(
  card: Card,
  statusId: string | null | undefined,
  config: BoardConfig,
  lookup?: CardLookup,
): string | null;
