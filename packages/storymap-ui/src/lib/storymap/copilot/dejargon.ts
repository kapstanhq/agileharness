// Humaniza o texto que o operador lê no Inbox (resumos de bloqueio/aviso/pergunta) e no diário do Jido.
// Dois problemas, uma casa: os resumos que o agente gera vêm cheios de jargão interno — nomes de LENS de review
// ("perf", "firestore"), rotas de skill ("/harness-review", "/harness-style") — ilegível para quem não é dev.
//
// Puro e CLIENT-SAFE (zero import de node): a CockpitView (findings/questions) e o diário (activity-view.diarySentence)
// bebem daqui, então a régua é UMA só. Testado em dejargon.test.ts.
//
// Princípio de segurança (superfície de DECISÃO): só transformamos padrões CONHECIDOS e NÃO-AMBÍGUOS. Nunca
// "adivinhamos" uma tradução — um rótulo errado numa tela onde o operador decide é pior que o jargão original.

/** LENS de review → rótulo de produto (a "área" do problema). REVIEW_LENSES = firestore/nextjs/perf/security/testing/general. */
const LENS_LABEL: Record<string, string> = {
  firestore: "Regras de acesso (Firestore)",
  nextjs: "Frontend (Next.js)",
  perf: "Performance",
  security: "Segurança",
  testing: "Testes",
  general: "Revisão geral",
};

/** O rótulo humano de uma lens (null quando ausente). Lens desconhecida cai num Capitalize seguro — nunca um id cru. */
export function lensLabel(lens?: string | null): string | null {
  const l = lens?.trim();
  if (!l) return null;
  return LENS_LABEL[l] ?? l.charAt(0).toUpperCase() + l.slice(1);
}

/** Rotas internas de skill (/harness-*) que vazam para os resumos → frase de produto. Só as conhecidas; qualquer
 *  outra é deixada INTACTA (adivinhar seria pior que o jargão). */
const ROUTE_PHRASE: Record<string, string> = {
  "harness-review": "a revisão de código",
  "harness-style": "o guia de estilo",
  "harness-ui": "o design das telas",
  "harness-ux": "a jornada de uso",
  "harness-qa": "o QA automatizado",
  "harness-do": "a implementação",
  "harness-plan": "o plano técnico",
  "harness-tasks": "a quebra em tarefas",
  "harness-enrich": "o refinamento da story",
  "harness-capture": "a captura de ideias",
};

// `/harness-<slug>` — captura a rota inteira; a substituição decide se conhece (senão devolve o match cru).
const ROUTE_RE = /\/harness-[a-z][a-z-]*/gi;

/**
 * Limpa o jargão CONHECIDO de um texto voltado ao operador: troca rotas de skill (/harness-*) por frases de produto.
 * Conservador de propósito — o que não está no mapa fica como está. Retorna "" para entrada vazia/ausente.
 */
export function dejargonText(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(ROUTE_RE, (m) => ROUTE_PHRASE[m.slice(1).toLowerCase()] ?? m);
}
