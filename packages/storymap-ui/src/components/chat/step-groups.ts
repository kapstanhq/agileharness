// O TÉCNICO RECOLHIDO — na conversa do Jido (o compositor do rodapé), os passos técnicos de uma resposta (cada comando,
// leitura, chamada de ferramenta) não aparecem um a um entre as frases: os passos SEGUIDOS viram UMA linha discreta,
// «ver detalhes · N passos», que abre a lista de sempre. Decisão do dono (fase 6): a conversa mostra o que foi feito e o
// resultado; o detalhe técnico fica a um toque. PURO (.ts) — o componente (hitl/HitlConversation) só pinta.

import type { HitlSegment } from "@/lib/storymap/hitl/types";

type ToolSegment = Extract<HitlSegment, { type: "tool" }>;
type TextSegment = Extract<HitlSegment, { type: "text" }>;

export type SegmentItem = { kind: "text"; seg: TextSegment } | { kind: "steps"; key: string; steps: ToolSegment[] };

/**
 * Agrupa os passos SEGUIDOS (sem texto entre eles) num item só, na ordem. Um texto vazio (o segmento que o stream cria
 * antes do primeiro token) não separa grupos — ele não aparece na tela. PURA.
 */
export function groupSegments(segments: readonly HitlSegment[]): SegmentItem[] {
  const out: SegmentItem[] = [];
  for (const s of segments) {
    if (s.type === "tool") {
      const last = out[out.length - 1];
      if (last?.kind === "steps") last.steps.push(s);
      else out.push({ kind: "steps", key: s.segId, steps: [s] });
    } else if (s.text.trim()) {
      out.push({ kind: "text", seg: s });
    }
  }
  return out;
}

/** O estado de um grupo: algum passo rodando ⇒ `running`; senão algum com erro ⇒ `error`; senão `done`. PURA. */
export function stepsStatus(steps: readonly ToolSegment[]): ToolSegment["status"] {
  if (steps.some((s) => s.status === "running")) return "running";
  if (steps.some((s) => s.status === "error")) return "error";
  return "done";
}

/** O rótulo da linha recolhida — em português, sem nome de ferramenta. PURA. */
export function stepsLabel(steps: readonly ToolSegment[]): string {
  const n = steps.length;
  const count = `${n} ${n === 1 ? "passo" : "passos"}`;
  const status = stepsStatus(steps);
  if (status === "running") return `trabalhando · ${count}`;
  if (status === "error") {
    const failed = steps.filter((s) => s.status === "error").length;
    return `ver detalhes · ${count}, ${failed} com erro`;
  }
  return `ver detalhes · ${count}`;
}
