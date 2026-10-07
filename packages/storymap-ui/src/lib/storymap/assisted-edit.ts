// Assisted-edit core — pure, server-safe helpers for the operator's editing bench (Fase 3).
//
// The bench lets the operator edit the artifacts that GOVERN the whole system — the strategy ladder,
// Lean Canvas, Ideias, personas and systems — either directly OR by asking a
// specialist agent. The agent has a per-view PERSONA (assistant-registry.ts, editable on disk) and a
// MODE (aprender / editar / sincronizar). This module holds the pure pieces the server actions
// (assisted-edit-actions.ts) compose: the path guard of a persona override and the prompt the agent
// answers. No fs, no spawn — fully unit-testable. The bench NEVER writes skills or prompts to disk (the
// runtime checkout is shared; the skill/prompt writers were deleted — quick-fix skill-writes).

import path from "node:path";
import { findRepoRoot } from "./paths";

/** A view-assistant id (the override filename). Conservative — no traversal/dots. */
export const ASSISTANT_ID_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Resolve the on-disk OVERRIDE path for a view-assistant's prompt, guarding traversal.
 * Returns null for an invalid id or any resolved path that escapes `.claude/storymap-assistants/`.
 * Read-only here (resolveAssistantPrompt): an override is changed by a commit, never by the bench.
 */
export function assistantPromptPath(id: string): string | null {
  if (!ASSISTANT_ID_RE.test(id)) return null;
  const dir = path.join(findRepoRoot(), ".claude", "storymap-assistants");
  const resolved = path.resolve(dir, `${id}.md`);
  const dirWithSep = dir.endsWith(path.sep) ? dir : dir + path.sep;
  if (!resolved.startsWith(dirWithSep)) return null;
  return resolved;
}

/** The kind of artifact being edited — ties a request to its view-assistant (assistant-registry). */
export type AssistedEditKind =
  /** the WHOLE Business Model Canvas at once — there is no per-block assistant: the 9 blocks are one system. */
  | "canvas"
  | "idea"
  | "persona"
  | "system"
  /**
   * the published Style Guide (bloco de Design, WS-4). Its assistant now lives in the Design page's chat (the
   * `doc-editor` purpose writes one section at a time with `write_styleguide`); the kind stays as the
   * registry key of the guide's persona override.
   */
  | "styleguide"
  | "generic";

/**
 * The MODE of an assisted-edit request — what the agent should DO:
 *  - `editar`      reescrever o artefato seguindo o pedido (o caso comum).
 *  - `aprender`    explicar/ensinar: o que é, o que deveria conter, o que falta — devolve PROSA, não o valor.
 *  - `sincronizar` investigar o CÓDIGO/realidade real do produto e derivar o valor verdadeiro (bootstrap da 1ª vez).
 */
export type AssistedEditMode = "editar" | "aprender" | "sincronizar";

/**
 * As tools NATIVAS que um `sincronizar` nunca recebe. Ele LÊ o código real (Read/Grep/Glob) para derivar o valor — e
 * roda com `cwd` no checkout de RUNTIME, que é compartilhado (o serviço é o único escritor dos boards). Antes ele
 * subia com `--dangerously-skip-permissions` como root, e só o PROMPT pedia "não modifique": um agente com permissão
 * total no checkout de produção. Agora: modo `default` explícito (nunca o herdado do settings do host) com esta
 * negação dura — o que escreve nem existe na superfície — e só as tools de leitura pré-aprovadas. NÃO o modo `plan`:
 * em `-p` ele instrui o modelo a apresentar um plano e chamar ExitPlanMode, e o `sincronizar` precisa devolver o VALOR
 * derivado do código. (quick-fix skill-writes)
 */
export const SINCRONIZAR_DENIED_TOOLS: readonly string[] = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"];

/** As tools de LEITURA que o `sincronizar` recebe pré-aprovadas (`--allowedTools`). */
export const SINCRONIZAR_ALLOWED_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];

export interface AssistedEditRunOptions {
  timeoutMs?: number;
  effort?: string;
  permissionMode?: "plan" | "default";
  disallowedTools?: readonly string[];
  allowedTools?: readonly string[];
}

/**
 * As opções do spawn por modo. `sincronizar` investiga o código → mais tempo e esforço, SÓ leitura (ver
 * {@link SINCRONIZAR_DENIED_TOOLS} e {@link SINCRONIZAR_ALLOWED_TOOLS}); nenhum modo pede skip-permissions. PURA — o
 * teste prova a contenção sem spawn.
 */
export function assistedEditRunOptions(mode: AssistedEditMode): AssistedEditRunOptions {
  return mode === "sincronizar"
    ? { timeoutMs: 600_000, effort: "high", permissionMode: "default", disallowedTools: SINCRONIZAR_DENIED_TOOLS, allowedTools: SINCRONIZAR_ALLOWED_TOOLS }
    : {};
}

/** Persona de fallback quando o kind não tem assistente registrado (ex.: "generic"). */
export const FALLBACK_ROLE = "Você é um editor de texto técnico, preciso e conciso.";

/** True para artefatos de marketing — recebem a nota de voz de marca. */
function isMarketingKind(kind: AssistedEditKind): boolean {
  return (
    kind === "canvas"
  );
}

/**
 * Kinds que um assistente escreve num PAINEL/CANVAS estratégico do board (Lean Canvas, Ideias,
 * Personas, Sistemas). Posicionamento / Resultado-alvo / Métrica de negócio saíram da lista porque
 * saíram da bancada: viraram seções do PRD, e quem escreve num documento de schema é `write_doc` —
 * não o assistente de campo único. Todos os que restam recebem o MESMO guia de estilo — é o que dá coesão à
 * escrita do board inteiro, qualquer que seja o assistente.
 */
function isPanelContentKind(kind: AssistedEditKind): boolean {
  return (
    kind === "canvas" ||
    kind === "idea" ||
    kind === "persona" ||
    kind === "system"
  );
}

/**
 * Guia de estilo COESO para tudo que um assistente escreve num painel/canvas do board. São boas
 * práticas de escrita UNIVERSAIS (Lean Startup / Business Model Canvas / Agile) — o "COMO escrever",
 * o mesmo em todo o board — que coexistem com a especialidade de cada assistente (o "O QUE escrever",
 * que vive no prompt individual) sem brigar: "linguagem de quem vai LER" resolve o aparente conflito
 * (o leitor de um canvas é o cliente; o de um sistema, o agente de build).
 */
export const PANEL_WRITING_STYLE = [
  "# Boas práticas de escrita (estilo coeso de todo o board)",
  "- Escreva na linguagem de quem vai LER o artefato; evite jargão que esse leitor não usaria.",
  "- Conciso e denso: direto ao ponto, sem enrolação nem adjetivo vazio; frases curtas e concretas.",
  "- Específico e ancorado em evidência — nada de clichê, buzzword ou afirmação genérica.",
  "- Trate cada bloco como uma hipótese a ser testada, não como verdade definitiva.",
  "- Uma ideia central por bloco; não repita o que já está em outro bloco do mesmo painel.",
].join("\n");

/** A instrução de TAREFA + contrato de saída, específica por modo. */
function modeTask(mode: AssistedEditMode, label: string): string {
  switch (mode) {
    case "aprender":
      return [
        `Sua tarefa: AJUDAR o operador a ENTENDER o artefato "${label}".`,
        `Explique, em prosa didática (pode usar tópicos curtos): o que é este artefato e para que serve,`,
        `o que um bom valor contém, e o que está faltando ou fraco no valor atual + como melhorá-lo.`,
        ``,
        `# Formato da resposta`,
        `Responda em PROSA (PT-BR). NÃO reescreva o artefato, NÃO devolva um valor pronto — só a explicação/orientação.`,
      ].join("\n");
    case "sincronizar":
      return [
        `Sua tarefa: SINCRONIZAR "${label}" com a REALIDADE do produto. Use suas ferramentas de leitura`,
        `(Read/Grep/Glob) para INVESTIGAR o código real do pacote-alvo e derivar o valor VERDADEIRO deste`,
        `artefato a partir do que o produto DE FATO é e faz — não do que se gostaria que fosse. É o caso de`,
        `bootstrap (preencher pela primeira vez a partir da realidade). NÃO MODIFIQUE nenhum arquivo: só leia e proponha.`,
        ``,
        `# Formato da resposta (OBRIGATÓRIO)`,
        `Ao terminar de investigar, responda com APENAS o novo conteúdo de "${label}" — texto cru, exatamente como`,
        `deve ser salvo. A PRIMEIRA palavra da sua resposta já é a primeira palavra do valor: NÃO use cercas \`\`\`,`,
        `NÃO escreva preâmbulo, saudação ou frase introdutória (nada de "Aqui está", "Claro", "Segue", "Proposta:",`,
        `"Eis"), NÃO inclua log da investigação, explicação ou comentário. Só o valor final.`,
      ].join("\n");
    case "editar":
    default:
      return [
        `Sua tarefa: reescrever o artefato "${label}" seguindo o pedido do operador, e devolver SOMENTE o novo valor.`,
        ``,
        `# Formato da resposta (OBRIGATÓRIO)`,
        `Responda IMEDIATAMENTE com APENAS o novo conteúdo de "${label}" — texto cru, exatamente como deve ser salvo.`,
        `A PRIMEIRA palavra da sua resposta já é a primeira palavra do valor: NÃO use cercas \`\`\`, NÃO escreva preâmbulo,`,
        `saudação ou frase introdutória (nada de "Aqui está", "Claro", "Segue", "Proposta:", "Eis"), NÃO explique,`,
        `NÃO comente nem repita o pedido. Só o valor final.`,
      ].join("\n");
  }
}

/**
 * Build the prompt the specialist agent answers. Composes: the view-assistant PERSONA (`systemPrompt`,
 * resolved by the action from the registry default OR a disk override) + the MODE task/output contract
 * + the current value + context + the operator's instruction. Pure.
 */
export function buildAssistedEditPrompt(input: {
  systemPrompt: string;
  kind: AssistedEditKind;
  mode: AssistedEditMode;
  /** human label of the artifact, e.g. "Resultado-alvo", "Canvas · Problema", "harness-enrich / SKILL.md" */
  label: string;
  /** the current value (may be empty when the artifact is unset) */
  current: string;
  /** the operator's free-text instruction (optional on sincronizar — ele deriva do código) */
  instruction: string;
  /** optional extra context (board name, the WHOLE canvas, neighbouring artifacts) */
  context?: string;
  /** a voz de marca do BOARD (`brandVoiceNote` do Guia de Estilo dele) — só entra em artefato de marketing; vazia = nenhuma. */
  brandVoice?: string;
}): string {
  const { systemPrompt, kind, mode, label, current, instruction, context } = input;
  const brandNote = isMarketingKind(kind) && input.brandVoice ? `\n${input.brandVoice}` : "";
  // Estilo coeso: todo assistente de painel/canvas herda o MESMO guia de boas práticas de escrita.
  const styleNote = isPanelContentKind(kind) ? `\n${PANEL_WRITING_STYLE}\n` : "";
  const ask = instruction.trim();
  return `${systemPrompt}
${styleNote}
${modeTask(mode, label)}
${context ? `\n# Contexto\n${context}\n` : ""}
# Valor atual de "${label}"
${current.trim() || "(vazio — proponha do zero)"}

# Pedido do operador
${ask || (mode === "sincronizar" ? "(sem pedido específico — derive o valor real do código)" : "(sem pedido específico)")}
${brandNote}`;
}

/** Abridores conversacionais que um LLM costuma colar antes do valor, apesar do contrato de saída. */
const PREAMBLE_OPENERS =
  /^(aqui (está|vai|tem|segue)|claro|com certeza|perfeito|ótimo|segue|seguem|eis|proposta|sugestão|versão|certo|beleza)\b/i;

/**
 * Remove cercas de código e UM preâmbulo conversacional que o agente possa ter colado em volta do
 * valor cru — apesar do contrato de saída pedir só o valor. CONSERVADOR de propósito (nunca come o
 * corpo real do artefato):
 *   1. desembrulha UMA cerca \`\`\` que envolva a resposta inteira (com ou sem linguagem);
 *   2. remove UMA linha de abertura SÓ quando ela é claramente preâmbulo — começa com um abridor
 *      conhecido ("aqui está", "claro", "segue", "eis", "proposta", …) OU é curta (≤120) e termina
 *      em ":" — E é seguida por uma linha EM BRANCO e por um corpo não-vazio (a assinatura forte de
 *      "preâmbulo + valor"). Sem a linha em branco, não mexe.
 * Aplicado só aos modos que devem devolver o VALOR (editar/sincronizar); o modo "aprender" devolve
 * prosa e NÃO passa por aqui. Puro e testável (sem fs/spawn).
 */
export function stripAgentPreamble(raw: string): string {
  let text = (raw ?? "").trim();
  if (!text) return text;

  // 1) Desembrulha uma cerca ``` que envolva a resposta inteira.
  const fence = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fence) text = fence[1].trim();

  // 2) Remove uma única linha de preâmbulo no topo, se for claramente introdutória.
  const nl = text.indexOf("\n");
  if (nl !== -1) {
    const first = text.slice(0, nl).trim();
    const rest = text.slice(nl + 1);
    const looksPreamble = first.length > 0 && first.length <= 120 && (PREAMBLE_OPENERS.test(first) || first.endsWith(":"));
    const blankAfter = /^[ \t]*\r?\n/.test(rest); // linha em branco logo após o preâmbulo
    const body = rest.trim();
    if (looksPreamble && blankAfter && body) text = body;
  }
  return text;
}
