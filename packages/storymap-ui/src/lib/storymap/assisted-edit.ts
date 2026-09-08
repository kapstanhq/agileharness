// Assisted-edit core — pure, server-safe helpers for the operator's editing bench (Fase 3).
//
// The bench lets the operator edit the artifacts that GOVERN the whole system — the strategy ladder,
// Lean Canvas, Ideias, the skills/prompts each column runs — either directly OR by asking a
// specialist agent. The agent has a per-view PERSONA (assistant-registry.ts, editable on disk) and a
// MODE (aprender / editar / sincronizar). This module holds the pure pieces the server actions
// (assisted-edit-actions.ts) compose: the path guards and the prompt the agent answers. No fs, no
// spawn — fully unit-testable.

import path from "node:path";
import { findRepoRoot } from "./paths";

/** A harness-* skill folder name (the TriggerId, e.g. `harness-enrich`). Conservative on purpose. */
export const SKILL_NAME_RE = /^harness-[a-z][a-z0-9-]*$/;

/**
 * Resolve the on-disk `SKILL.md` for a `harness-*` skill, guarding against path traversal.
 * Returns null for an invalid skill name or any resolved path that escapes `.claude/skills/`.
 * The bench reads/writes the SKILL.md in the working tree — it's read at RUNTIME by the headless
 * `claude -p` (no rebuild needed), but a change must be committed on the VPS checkout to persist.
 */
export function skillMdPath(skill: string): string | null {
  if (!SKILL_NAME_RE.test(skill)) return null;
  const skillsDir = path.join(findRepoRoot(), ".claude", "skills");
  const resolved = path.resolve(skillsDir, skill, "SKILL.md");
  const dirWithSep = skillsDir.endsWith(path.sep) ? skillsDir : skillsDir + path.sep;
  if (!resolved.startsWith(dirWithSep)) return null;
  return resolved;
}

/** A view-assistant id (the override filename). Conservative — no traversal/dots. */
export const ASSISTANT_ID_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Resolve the on-disk OVERRIDE path for a view-assistant's prompt, guarding traversal.
 * Returns null for an invalid id or any resolved path that escapes `.claude/storymap-assistants/`.
 * Like SKILL.md: read at runtime, no rebuild, but must be committed on the VPS checkout to persist.
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
  /** the WHOLE Lean Canvas at once — there is no per-block assistant: the 12 blocks are one system. */
  | "canvas"
  | "idea"
  | "persona"
  | "system"
  | "skill"
  /**
   * the published Style Guide (bloco de Design, WS-4) — editar/aprender/sincronizar. `aprender` rides
   * the generic `buildAssistedEditPrompt` below (prose contract); `editar`/`sincronizar` use the
   * dedicated `buildStyleGuideAssistPrompt` (a guide is a multi-section STRUCTURED doc, not a single
   * string value — same reason the canvas-wide assistant needed its own prompt builder).
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
 * escrita do board inteiro, qualquer que seja o assistente. O skill-editor fica de fora (edita o
 * SKILL.md, que tem contrato estrutural próprio).
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
  /** optional extra context (board name, brand voice, the WHOLE canvas, neighbouring artifacts) */
  context?: string;
}): string {
  const { systemPrompt, kind, mode, label, current, instruction, context } = input;
  const brandNote = isMarketingKind(kind)
    ? "\nVoz de marca PT-BR urbano-sofisticada: NUNCA use \"rolê/rolês\", \"zap\", \"o que rola\"."
    : "";
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

/**
 * The prompt for the STYLEGUIDE view-assistant's STRUCTURED modes (`editar`/`sincronizar`). A style
 * guide is a multi-section doc (10 keys — StyleGuideDoc), not a single string value, so it doesn't fit
 * the generic `buildAssistedEditPrompt` "return the raw new value" contract above — um documento com
 * várias seções não cabe num contrato que devolve UM valor. (O canvas teve o mesmo problema e ganhou
 * um construtor próprio; ele saiu com o assistente de proposta, quando o canvas virou markdown e a
 * ajuda passou a ser a conversa ancorada na tela.)
 * The agent answers with ONE JSON object shaped like `StyleGuideDoc` — coerced tolerantly on
 * read by the caller (`coerceStyleGuideDoc` never throws), so a partial/malformed reply degrades
 * gracefully instead of corrupting the guide. `aprender` for this kind still rides the generic
 * `buildAssistedEditPrompt` (it only owes prose). Pure — the caller (design-actions.ts) resolves the
 * persona, the current guide (already serialized via `styleGuideToPrompt`) and the section registry
 * before calling this; no fs/spawn here.
 */
export function buildStyleGuideAssistPrompt(input: {
  systemPrompt: string;
  mode: Extract<AssistedEditMode, "editar" | "sincronizar">;
  /** the published guide, already serialized (styleGuideToPrompt) — or "" when the board has none yet. */
  current: string;
  /** the section registry the agent must stay inside: key + label + hint (STYLE_SECTIONS shape, kept
   *  inline here para este módulo nunca importar style-guide-blocks). */
  sections: ReadonlyArray<{ key: string; label: string; hint: string }>;
  instruction: string;
  /** e.g. "Pacote do produto: packages/acme." — only meaningful for `sincronizar` (there's real code to read). */
  context?: string;
}): string {
  const { systemPrompt, mode, current, sections, instruction, context } = input;
  const catalogue = sections.map((s) => `- \`${s.key}\` (${s.label}): ${s.hint}`).join("\n");
  const task =
    mode === "sincronizar"
      ? [
          "Sua tarefa: SINCRONIZAR o guia de estilo com a REALIDADE do produto. Use suas ferramentas de",
          "leitura (Read/Grep/Glob) para investigar o CÓDIGO real do pacote-alvo (CSS/tokens/tailwind) e",
          "derivar os valores VERDADEIROS de `color`/`tokenBindings`/`typography`/`debt` a partir do que o",
          "produto DE FATO é — nunca da memória. Preserve as demais seções (identity, principles, voice,",
          "antiPatterns…) EXATAMENTE como estão no guia atual — o código não as revela. NÃO MODIFIQUE",
          "nenhum arquivo: só leia e proponha.",
        ].join("\n")
      : [
          "Sua tarefa: reescrever o guia de estilo seguindo o pedido do operador — mexa SÓ nas seções que",
          "o pedido exige; preserve as demais exatamente como estão no guia atual.",
        ].join("\n");

  return `${systemPrompt}

${task}

# Seções válidas do guia (use EXATAMENTE estas chaves — nenhuma outra)
${catalogue}

# Guia atual
${current.trim() || "(nenhum guia publicado ainda — proponha do zero)"}
${context ? `\n# Contexto\n${context}\n` : ""}
# Pedido do operador
${instruction.trim() || (mode === "sincronizar" ? "(sem pedido específico — derive os tokens reais do código)" : "(sem pedido específico)")}

# Formato da resposta (OBRIGATÓRIO)
Responda com UM único objeto JSON e NADA MAIS — sem cercas \`\`\`, sem preâmbulo, sem explicação fora do
JSON. O objeto deve ter a MESMA forma do "Guia atual" acima (meta/identity/principles/color/typography/
spacing/shape/motion/voice/antiPatterns/debt/tokenBindings) — reenvie TODAS as seções, inclusive as que
você não mudou (uma seção omitida vira VAZIA, não "preservada").`;
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
