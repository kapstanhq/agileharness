export declare const OWNER: {
  readonly HUMAN: 'human';
  readonly PROPOSABLE: 'proposable';
  readonly AGENT: 'agent';
};

/** Top-level board.yaml keys only a human may change canonically. */
export declare const HUMAN_BOARD_FIELDS: readonly string[];

/** True when filePath falls inside the proposals/ draft zone. */
export declare function isProposalPath(filePath: string): boolean;

/** True when filePath is a board.yaml canonical path. */
export declare function isBoardYamlPath(filePath: string): boolean;

/** True when filePath is a board's PRD (`storymap/boards/<b>/docs/prd.md`) — owner:human. */
export declare function isPrdDocPath(filePath: string): boolean;

/** True when filePath is a card .md path (owner:agent territory). */
export declare function isCardPath(filePath: string): boolean;

export interface OwnerViolation {
  owner: 'human';
  fields: string[];
  message: string;
  fix: string;
}

/**
 * Evaluate whether a run's write to filePath is authorised.
 * Returns null (allow) or a violation object (block).
 */
export declare function evaluateOwnerGuard(params: {
  filePath: string;
  board?: string | null;
  beforeYaml?: Record<string, unknown> | null;
  afterYaml?: Record<string, unknown> | null;
  runId?: string | null;
}): OwnerViolation | null;
