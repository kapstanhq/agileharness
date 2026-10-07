// Derivações PURAS (client-safe: zero import de node) para o diário de atividade do Jido autônomo. O feed
// (CopilotActivityFeed) é um RECALL enxuto — uma linha curta por decisão, escaneável de relance —, não o lugar
// onde a substância do trabalho mora (essa flui no corpo do chat). Aqui ficam as três regras que o deixam
// enxuto: (1) o TIER visual de cada evento (o cliente pinta por tier, nunca por regex no texto), (2) o COLAPSO
// de decisões repetidas consecutivas numa linha com contador (o "Fiquei de fora" a cada tick lia como spam), e
// (3) o RESUMO por entrada (cap de caracteres). Puro/testado — o componente só renderiza.

import type { CopilotActivityEntry, CopilotActivityKind } from "./activity";
import { dejargonText } from "./dejargon";

/**
 * O teto de entradas do diário — de ARMAZENAMENTO e de EXIBIÇÃO, no mesmo número de propósito.
 *
 * Mora AQUI, e não em activity.ts, por uma razão de bundle: activity.ts importa `node:fs`, então o componente
 * de cliente (CopilotActivityFeed) só pode importar TIPOS de lá. Uma constante de valor viria com o módulo
 * inteiro a reboque. Este arquivo é client-safe por contrato (ver o cabeçalho), então é o lugar certo para o
 * que os dois lados precisam ler.
 *
 * POR QUE 24: o diário não é a memória do sistema (isso é o transcript do CLI + a telemetria) — é um feed de
 * relance dentro do chat. O teto anterior, 300, era arquivo morto que ninguém rolava até o fim.
 */
export const ACTIVITY_MAX_ENTRIES = 24;

/** O peso visual de um evento. O cliente escolhe ícone/cor por aqui — `idle` recua, o resto se destaca. */
export type ActivityTier = "work" | "attention" | "idle" | "error";

const TIER_BY_KIND: Record<CopilotActivityKind, ActivityTier> = {
  finished: "work", // terminou um ciclo (o resumo do que fez)
  acted: "work", // executou uma ação sozinho
  asked: "attention", // parou e pediu aprovação
  refused: "attention", // recusou uma ação irreversível
  // desistiu de um trabalho ACIONÁVEL e o devolveu: só destrava se o humano re-armar. É o oposto de ruído —
  // é uma pendência que passou a ser dele. Pintado como `stood-down` (idle), ficava cinza e colapsado, e um
  // board parado por horas lia como um board tranquilo.
  "handed-back": "attention",
  error: "error", // algo quebrou
  woke: "idle", // acordou de verdade e disparou (o ciclo em si é ruído; o que ele FEZ vem no finished)
  scheduled: "idle", // só marcou um horário p/ olhar — promessa, o piso do ruído
  "stood-down": "idle", // decidiu NÃO agir por disciplina (o repetido "fiquei de fora")
};

export function tierOf(kind: CopilotActivityKind): ActivityTier {
  return TIER_BY_KIND[kind] ?? "idle";
}

/** Uma corrida de decisões consecutivas IDÊNTICAS colapsada numa linha só (o matador de spam do stand-down). */
export interface ActivityGroup {
  /** chave estável do React = o id da entrada mais NOVA (a representante) da corrida. */
  key: string;
  /** a entrada representante (a mais NOVA da corrida) — é o texto/detalhe/horário que aparece. */
  entry: CopilotActivityEntry;
  /** quantas entradas idênticas consecutivas esta linha representa (1 = não colapsou). */
  count: number;
  /** ISO da entrada mais ANTIGA da corrida — alimenta o "×N desde HH:MM". */
  sinceAt: string;
}

/**
 * Colapsa entradas consecutivas que compartilham (kind + text) numa só. A entrada DEVE vir em ordem
 * decrescente (mais nova primeiro); a saída sai na mesma ordem. Um "Fiquei de fora…" repetido a cada tick vira
 * UMA linha com contador em vez de N linhas idênticas que empurram o que importa para baixo. Puro/determinístico.
 */
export function groupActivity(newestFirst: readonly CopilotActivityEntry[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const e of newestFirst) {
    const last = groups[groups.length - 1];
    if (last && last.entry.kind === e.kind && last.entry.text === e.text) {
      last.count += 1;
      last.sinceAt = e.at; // varrendo do mais novo p/ o mais velho ⇒ cada idêntico seguinte é mais ANTIGO ⇒ vira o "desde"
    } else {
      groups.push({ key: e.id, entry: e, count: 1, sinceAt: e.at });
    }
  }
  return groups;
}

const ELLIPSIS = "…";

/** Uma linha de tabela markdown (`| a | b |`) ou seu separador (`|---|---|`) — no diário isso é RUÍDO, não frase. */
const TABLE_ROW_RE = /^\|.*\|?\s*$/;
/** A linha de blocos de código (```ts) — o cerco some junto com o conteúdo formatado. */
const FENCE_RE = /^\s*```/;

/**
 * Achata o texto de UMA entrada do diário numa FRASE CORRIDA — sem quebra de linha, sem tabela, sem markdown.
 *
 * O diário é uma linha de ~11px num feed de recall: o componente a renderiza como TEXTO PURO (não markdown, de
 * propósito — uma tabela dentro de um item de lista de 11px não é legível em nenhum tamanho de tela). Mas a
 * maioria das entradas não é escrita por nós: um `finished` carrega o `summary` do run, que é o texto FINAL do
 * LLM — e ele chega como relatório completo, com `##` de título, `**negrito**`, bullets e tabelas inteiras.
 * Renderizado como texto puro, isso virava uma sopa de pipes e asteriscos numa linha só, capada em 250 chars.
 * (Medido num diário real: mais de um décimo das entradas.) As nossas próprias entradas sofriam a versão menor do
 * mesmo mal — `Executei \`move_card\` sozinho` imprimia as crases.
 *
 * As tabelas são DESCARTADAS (são dados tabulares — não sobrevivem a virar frase); o resto vira prosa, unido por
 * ". " quando o fragmento não termina em pontuação. Aplicado no RENDER, não na escrita: o diário é append-only e
 * as entradas já gravadas também precisam ficar legíveis. Pura/testada.
 */
/** O que cada ferramenta faz, em palavras: [feito, a fazer] — o diário mostrava o nome técnico (`move_card`). */
const TOOL_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  move_card: ["moveu um card de coluna", "mover um card de coluna"],
  update_card: ["atualizou um card", "atualizar um card"],
  create_card: ["criou um card", "criar um card"],
  create_idea: ["registrou uma ideia na Triagem", "registrar uma ideia na Triagem"],
  triage_finding: ["tratou um aviso", "tratar um aviso"],
  answer_question: ["respondeu uma pergunta", "responder uma pergunta"],
  ask_question: ["fez uma pergunta", "fazer uma pergunta"],
  record_decision: ["registrou uma decisão", "registrar uma decisão"],
  write_sidecar: ["atualizou o plano de um card", "atualizar o plano de um card"],
  worktree_open: ["abriu uma cópia de trabalho", "abrir uma cópia de trabalho"],
  worktree_submit: ["mandou um trabalho para integração", "mandar um trabalho para integração"],
  worktree_discard: ["encerrou uma cópia de trabalho", "encerrar uma cópia de trabalho"],
  worktree_refresh: ["atualizou uma cópia de trabalho", "atualizar uma cópia de trabalho"],
  set_card_driver: ["mudou quem conduz um card", "mudar quem conduz um card"],
  defer_card: ["adiou um card", "adiar um card"],
  undefer_card: ["retomou um card adiado", "retomar um card adiado"],
  transfer_card: ["mudou um card de board", "mudar um card de board"],
  enqueue: ["pôs um card na fila", "pôr um card na fila"],
  enqueue_batch: ["pôs cards na fila", "pôr cards na fila"],
  claude_new: ["abriu uma sessão de agente", "abrir uma sessão de agente"],
  pause_board: ["mudou o ritmo do board", "mudar o ritmo do board"],
  resume_board: ["mudou o ritmo do board", "mudar o ritmo do board"],
};
const GENERIC: readonly [string, string] = ["fez uma ação no board", "fazer uma ação no board"];

/** O tipo de risco da matriz, em palavras («write-board» → «mexe no board»). */
const RISK_WORDS: Readonly<Record<string, string>> = {
  read: "só leitura",
  "write-board": "mexe no board",
  "doc-write": "mexe em documento",
  "reversible-delete": "apaga com volta",
  run: "roda um processo",
  session: "abre sessão",
  "merge-resolve": "resolve integração",
  "peer-review": "revisão",
  deploy: "publicação",
  "run-free": "comando livre",
  destructive: "destrutivo",
};

/**
 * As frases que o próprio serviço escreve no diário com jargão — «executou `move_card` (write-board)», «O condutor do card
 * story-ex9711» — viram palavras. Aplicado no RENDER (o diário é append-only; as entradas velhas também melhoram). PURA.
 */
export function humanizeAgentAction(text: string): string {
  return text
    .replace(/(executou|Executei|pediu) `([a-z_]+)`( sozinho)? \(([a-z-]+)\)/g, (_m, verb: string, tool: string, alone: string | undefined, cls: string) => {
      const [done, todo] = TOOL_WORDS[tool] ?? GENERIC;
      const risk = RISK_WORDS[cls] ? ` (${RISK_WORDS[cls]})` : "";
      if (verb === "Executei") return `Fiz${alone ? " sozinho" : ""}: ${todo}${risk}`;
      if (verb === "pediu") return `pediu para ${todo}${risk}`;
      return `${done}${risk}`;
    })
    .replace(/\b(O|o) condutor do card (?:story|step|act)-[a-z0-9]+\b/g, (_m, o: string) => `${o} agente de um card`)
    .replace(/`([a-z]+(?:_[a-z]+)+)`/g, (_m, tool: string) => (TOOL_WORDS[tool] ? `«${TOOL_WORDS[tool][1]}»` : "uma ação"));
}

export function diarySentence(text: string): string {
  const raw = humanizeAgentAction((text ?? "").replace(/\r\n?/g, "\n"));
  const fragments: string[] = [];
  let inFence = false;

  for (const line of raw.split("\n")) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const t = line.trim();
    if (!t) continue;
    if (TABLE_ROW_RE.test(t)) continue; // tabela: descartada inteira (linhas E separador)
    const cleaned = stripInlineMarkup(t);
    if (cleaned) fragments.push(cleaned);
  }

  let out = "";
  for (const f of fragments) {
    if (!out) {
      out = f;
      continue;
    }
    // já termina em pontuação de frase ⇒ só um espaço; senão o ". " que costura os fragmentos em prosa.
    out += /[.!?:;,—-]$/.test(out) ? ` ${f}` : `. ${f}`;
  }
  // Último passo: limpa o jargão conhecido (rotas de skill /harness-*) que o resumo do LLM carrega para o diário —
  // a mesma régua que o Inbox aplica aos findings. Idempotente, então vale no write E no render (entradas
  // já gravadas ficam legíveis também). Ver dejargon.ts.
  return dejargonText(stripOrphanMarkup(out).replace(/\s+/g, " ").trim());
}

/**
 * Tira marcador de ênfase/crase que ficou ÓRFÃO (sem par). Duas fontes reais, ambas medidas num diário real:
 * um `**negrito**` que atravessa a quebra de linha (o strip é por linha, então cada metade fica sem par), e —
 * a mais comum — uma entrada TRUNCADA na origem, que termina no meio do negrito (`… devolveu o card. **Não enfil`).
 * Sem esta passada, o par nunca casa e o `**` chegava cru à linha do diário.
 */
function stripOrphanMarkup(s: string): string {
  return s.replace(/\*\*/g, "").replace(/`/g, "");
}

/** Tira a marcação INLINE de uma linha (título/bullet/quote/ênfase/crase/link) — o texto fica, o cerco sai. */
function stripInlineMarkup(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "") // ## título
    .replace(/^>\s*/, "") // > quote
    .replace(/^[-*+]\s+/, "") // - bullet
    .replace(/^\d+\.\s+/, "") // 1. lista
    .replace(/^\s*[-*_]{3,}\s*$/, "") // --- régua
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [texto](url) → texto
    .replace(/`+([^`]*)`+/g, "$1") // `código` → código
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **negrito**
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, "$1$2") // *itálico* (não toca em a*b)
    .trim();
}

/**
 * Enxuga o texto de UMA entrada do diário para caber num recall (cap ~250). Corta preferindo uma fronteira de
 * SENTENÇA (primeira frase), senão a última PALAVRA — nunca no meio de uma palavra. O texto completo continua
 * disponível (o componente o põe no tooltip). Puro/testado.
 */
export function summarizeEntry(text: string, max = 250): string {
  const t = (text ?? "").trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max - 1);
  const floor = max * 0.6; // só corta numa fronteira se ela estiver "lá pra frente" — senão o recall vira 2 palavras
  const sentenceEnd = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  if (sentenceEnd >= floor) return `${slice.slice(0, sentenceEnd + 1)}${ELLIPSIS}`;
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace >= floor ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}${ELLIPSIS}`;
}
