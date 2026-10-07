// O recorte «Mostrar» do Kanban — tipo, padrão e validação. Módulo PURO (sem JSX) para os testes o importarem.

export type KanbanShowMode = "exc" | "all" | "running" | "attention" | "error" | "queued" | "delivering" | "paused";

/** O recorte com que o Kanban abre: TUDO (o dono, 07/10 — «Exceções» como padrão deixava o board parecendo vazio). */
export const KANBAN_DEFAULT_MODE: KanbanShowMode = "all";

const SHOW_MODES: readonly KanbanShowMode[] = ["exc", "all", "running", "attention", "error", "queued", "delivering", "paused"];

/** Valida um valor lido de fora (o armazenamento do navegador) antes de virar o recorte. */
export function isKanbanShowMode(v: string): v is KanbanShowMode {
  return (SHOW_MODES as readonly string[]).includes(v);
}
