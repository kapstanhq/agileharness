// Humaniza o texto que o operador lê no Inbox (resumos de bloqueio/aviso/pergunta) e no diário do Jido.
// Dois problemas, uma casa: os resumos que o agente gera vêm cheios de jargão interno — nomes de LENS de review
// ("perf", "security"), rotas de skill ("/harness-review", "/harness-style") — ilegível para quem não é dev.
//
// Puro e CLIENT-SAFE (zero import de node): a CockpitView (findings/questions) e o diário (activity-view.diarySentence)
// bebem daqui, então a régua é UMA só. Testado em dejargon.test.ts.
//
// Princípio de segurança (superfície de DECISÃO): só transformamos padrões CONHECIDOS e NÃO-AMBÍGUOS. Nunca
// "adivinhamos" uma tradução — um rótulo errado numa tela onde o operador decide é pior que o jargão original.

/**
 * As lentes EMBUTIDAS da ferramenta (types.ts `CoreLens`) → rótulo de produto (a «área» do problema). Neutras de
 * propósito: as lentes de DOMÍNIO (acesso a dados, frontend…) são do alvo, que declara o nome delas em
 * `target.reviewLenses` e o entrega a quem chama aqui (`declared`) — este módulo é client-safe e não lê o settings.
 */
const CORE_LENS_LABEL: Record<string, string> = {
  security: "Segurança",
  testing: "Testes",
  perf: "Performance",
  general: "Revisão geral",
  design: "Design",
};

/**
 * O rótulo humano de uma lens (null quando ausente). A ordem: o nome que o ALVO declarou (`declared: id → name`), o
 * rótulo da embutida, e por fim um Capitalize seguro — nunca um id cru.
 */
export function lensLabel(lens?: string | null, declared?: Readonly<Record<string, string>>): string | null {
  const l = lens?.trim();
  if (!l) return null;
  return declared?.[l] ?? CORE_LENS_LABEL[l] ?? l.charAt(0).toUpperCase() + l.slice(1);
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
