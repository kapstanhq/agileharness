"use server";

// Server actions for the Produto · Ideias bench (Fase 3c) — CRUD do espaço do problema (OST).
// Uma ideia é um card type:"idea" com IdeaFields {statement, evidence, status}.
// Nasce com pipeline status NULL (inerte: o kanban só renderiza stories e o autorun só casa triggers
// por status — uma ideia fora do pipeline não dispara skill nenhuma). As edições são
// CIRÚRGICAS via updateCardOnDisk (re-read fresh + patch só do subcampo) para não clobberar quando o
// operador edita statement e evidência em sequência no mesmo card.

import { requireSession } from "@/lib/auth/action-guard";
import { revalidatePath } from "next/cache";
import type { Card, IdeaFields } from "@/lib/storymap/types";
import { readBoardConfig, readCards } from "@/lib/storymap/repo";
import { updateCardOnDisk } from "@/lib/storymap/write";
import { makeDraftCard } from "@/lib/storymap/draft";
import { cardsAddressing } from "@/lib/storymap/idea";
import { terminalStatusIds } from "@/lib/storymap/views";
import { isIdeaStatus, type IdeaStatus } from "@/lib/storymap/frameworks";
import { createCardAction, startCaptureAction } from "./actions";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

type Result<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

function fail<T = unknown>(e: unknown): Result<T> {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

/**
 * Cria uma Ideia. Ela nasce pelo TÍTULO (o nome que você daria a ela), e o
 * `statement` é escrito DENTRO do documento — por isso os dois são opcionais aqui, exigindo apenas
 * que um deles exista. O caminho antigo (só `statement`, título espelhado) continua válido: é o que
 * a tool MCP e a captura usam, e espelhar é o certo quando quem cria já chegou com a frase pronta.
 */
export async function createIdeaAction(input: {
  boardId: string;
  /** o nome da Ideia; na ausência dele o `statement` vira o título (comportamento legado). */
  title?: string;
  statement?: string;
  evidence?: string;
  // OST light — optional extras beyond statement/evidence (persisted SPARSELY, like updateIdeaAction).
  candidateSolutions?: string[];
  keyAssumption?: string | null;
  successSignal?: string | null;
}): Promise<Result<{ card: Card }>> {
  await requireSession("createIdeaAction");
  try {
    const statement = input.statement?.trim() ?? "";
    const title = input.title?.trim() || statement;
    if (!title) return { ok: false, error: "Dê um nome à ideia." };
    const cards = await readCards(input.boardId);
    const base = makeDraftCard({ type: "idea", title, status: null, cards });
    const idea: IdeaFields = { statement, evidence: input.evidence?.trim() || null, status: "open" };
    const candidateSolutions = (input.candidateSolutions ?? []).map((s) => s.trim()).filter(Boolean);
    if (candidateSolutions.length) idea.candidateSolutions = candidateSolutions;
    if (input.keyAssumption?.trim()) idea.keyAssumption = input.keyAssumption.trim();
    if (input.successSignal?.trim()) idea.successSignal = input.successSignal.trim();
    const card: Card = { ...base, idea };
    return await createCardAction({ boardId: input.boardId, card });
  } catch (e) {
    return fail(e);
  }
}

/**
 * Surgically patch an idea's fields. Re-reads fresh inside the write lock and changes ONLY
 * the provided subfield(s), so editing statement then evidence (two round-trips) never reverts the
 * other. Returns the updated card. No-ops (returns error) if the card vanished or isn't an idea.
 */
export async function updateIdeaAction(input: {
  boardId: string;
  cardId: string;
  /** o título da Ideia — INDEPENDENTE do `statement` (ver a nota no retorno abaixo). */
  title?: string;
  statement?: string;
  evidence?: string | null;
  status?: IdeaStatus;
  /** motivo do descarte; exigido quando `status: "discarded"`. */
  discardReason?: string | null;
  // OST light (Fatia 2) — each is patched surgically: an absent key (undefined) preserves prev.
  keyAssumption?: string | null;
  successSignal?: string | null;
  candidateSolutions?: string[];
}): Promise<Result<{ card: Card }>> {
  await requireSession("updateIdeaAction");
  try {
    const updated = await updateCardOnDisk(input.boardId, input.cardId, (fresh) => {
      if (fresh.type !== "idea") return null;
      const prev = fresh.idea ?? { statement: fresh.title, evidence: null, status: "open" as IdeaStatus };
      const statement = input.statement !== undefined ? input.statement.trim() || prev.statement : prev.statement;
      const evidence = input.evidence !== undefined ? (input.evidence?.trim() || null) : prev.evidence;
      const status = input.status !== undefined && isIdeaStatus(input.status) ? input.status : prev.status;
      // Descarte EXIGE motivo. Sem ele o estado não é aplicado — ideia morta sem porquê
      // volta a ser proposta pelo próximo que tiver a mesma intuição, que é o buraco que `discarded` fecha.
      const discardReason = input.discardReason !== undefined ? (input.discardReason?.trim() || null) : prev.discardReason ?? null;
      if (status === "discarded" && !discardReason) {
        throw new Error("Descartar uma ideia exige o motivo — sem ele ninguém sabe por que ela morreu.");
      }
      // Surgical patch of the OST-light fields: only the provided keys change; the rest carry prev forward.
      const keyAssumption = input.keyAssumption !== undefined ? (input.keyAssumption?.trim() || null) : prev.keyAssumption ?? null;
      const successSignal = input.successSignal !== undefined ? (input.successSignal?.trim() || null) : prev.successSignal ?? null;
      const candidateSolutions = input.candidateSolutions !== undefined
        ? input.candidateSolutions.map((s) => s.trim()).filter(Boolean)
        : prev.candidateSolutions ?? [];
      // Build the block SPARSELY (omit empty fields) so the persisted card .md stays lean.
      const idea: IdeaFields = { statement, evidence, status };
      if (discardReason) idea.discardReason = discardReason;
      if (candidateSolutions.length) idea.candidateSolutions = candidateSolutions;
      if (keyAssumption) idea.keyAssumption = keyAssumption;
      if (successSignal) idea.successSignal = successSignal;
      // Título e `statement` são CAMPOS DISTINTOS. Antes o statement era espelhado no título a
      // cada save — parte do que fazia a Oportunidade parecer uma story de um campo só. Hoje o título é
      // o nome da Ideia (editável por si) e o statement é a primeira seção do documento; só um card
      // legado, que nunca teve título próprio, ainda herda o statement como fallback.
      const title = input.title !== undefined ? input.title.trim() || fresh.title : fresh.title;
      return {
        ...fresh,
        title: title || statement,
        idea,
      };
    });
    if (!updated) return { ok: false, error: "Ideia não encontrada." };
    revalidatePath(`/board/${input.boardId}/kanban`);
    return { ok: true, data: { card: updated } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * A ESCRITA DO AGENTE no documento de uma Ideia (classe de risco `idea-write`).
 *
 * É deliberadamente mais estreita que `updateIdeaAction`, e a estreiteza É a contenção — não uma promessa da
 * persona:
 *  · recusa qualquer card que não seja `type: "idea"` (nada de escrever num card do pipeline);
 *  · NUNCA apaga: campo vazio é ignorado em vez de limpar, e o texto livre é ACRESCENTADO ao corpo, nunca
 *    substituído. O documento é do humano; o agente soma;
 *  · não alcança status, parent, links, estado da exploração nem o motivo do descarte — decidir que a ideia
 *    virou tarefa, ou que morreu, continua sendo gesto do humano;
 *  · `candidateSolutions` UNE com as que já existem (dedup por texto) em vez de trocar a lista.
 *
 * O anti-clobber contra a edição não-salva do humano é o `expectedBody` do IdeaDocScreen: se o agente escreveu
 * enquanto o operador editava, o SAVE DELE falha com o aviso — em vez de um dos dois sumir em silêncio.
 */
export async function appendToIdeaAction(input: {
  boardId: string;
  cardId: string;
  /** markdown a ACRESCENTAR ao corpo do documento (nunca substitui). */
  note?: string;
  statement?: string;
  evidence?: string;
  keyAssumption?: string;
  successSignal?: string;
  candidateSolutions?: string[];
  /** quem escreveu (vira a assinatura do bloco acrescentado). */
  actor?: string;
}): Promise<Result<{ card: Card }>> {
  await requireSession("appendToIdeaAction");
  try {
    const updated = await updateCardOnDisk(input.boardId, input.cardId, (fresh) => {
      if (fresh.type !== "idea") return null;
      const prev = fresh.idea ?? { statement: fresh.title, evidence: null, status: "open" as IdeaStatus };
      // `||` e não `??`: string vazia do agente NÃO limpa campo — ela é ignorada.
      const idea: IdeaFields = {
        ...prev,
        statement: input.statement?.trim() || prev.statement,
        evidence: input.evidence?.trim() || (prev.evidence ?? null),
      };
      const keyAssumption = input.keyAssumption?.trim() || prev.keyAssumption;
      const successSignal = input.successSignal?.trim() || prev.successSignal;
      if (keyAssumption) idea.keyAssumption = keyAssumption;
      if (successSignal) idea.successSignal = successSignal;
      const merged = [...(prev.candidateSolutions ?? []), ...(input.candidateSolutions ?? []).map((s) => s.trim())]
        .filter(Boolean)
        .filter((s, i, all) => all.indexOf(s) === i);
      if (merged.length) idea.candidateSolutions = merged;

      const note = input.note?.trim();
      const who = input.actor?.trim() || "explorador";
      // A assinatura importa: sem ela, daqui a uma semana ninguém distingue o que o agente APUROU do que o
      // humano DECIDIU — e a diferença entre as duas coisas é a única serventia da evidência.
      const body = note
        ? `${(fresh.body ?? "").trimEnd()}${fresh.body?.trim() ? "\n\n" : ""}> _${who} · ${today()}_\n\n${note}\n`
        : fresh.body;
      return { ...fresh, body, idea };
    });
    if (!updated) return { ok: false, error: "Ideia não encontrada (ou o card não é uma ideia)." };
    revalidatePath(`/board/${input.boardId}/kanban`);
    revalidatePath(`/board/${input.boardId}/card/${encodeURIComponent(input.cardId)}`);
    return { ok: true, data: { card: updated } };
  } catch (e) {
    return fail(e);
  }
}

function truncate(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * Result of generateTasksForIdeaAction. Superset of Result<{card}>: the `ok:false` branch may carry a
 * WS-9 (9.2) `needsConfirm` signal + the active stories already addressing the idea, so a caller can offer a
 * one-click "gerar mesmo assim" (which re-invokes with `force:true`). Plain consumers still read ok/error/data.
 */
type GenStoriesResult =
  | { ok: true; data?: { card: Card } }
  | { ok: false; error: string; needsConfirm?: boolean; addressedBy?: { id: string; title: string }[] };

/**
 * OST "idea → generate stories" (Fatia 3B): kick a SCOPED smart-capture FROM an idea. Pre-fills
 * the capture body with the pain + key assumption + success signal + candidate solutions, and scopes the
 * container to this idea (`scopeIdeaId`) so the stories the human accepts on Inbox are born
 * with an `addresses` edge tracing UP to it. Async — returns immediately; the proposal lands on Inbox for
 * the human to review/accept (it does NOT create stories directly).
 *
 * WS-9 (9.2): guards the 1:1 auto-mint. If a NON-TERMINAL story ALREADY addresses this idea, generating MORE
 * stories duplicates the delivery track (the anti-pattern the D15 decision forbids — the incident's 2 opps each
 * went straight to 1 story, no branching). It refuses with a structured `needsConfirm` unless `force:true` is
 * passed (browser confirm / MCP force). First-time generation (nothing addresses it yet) passes untouched.
 *
 * WS-9 (9.4): stamps visible PROVENANCE on the container body ("criado por <ator> via bancada em <ts>") so the
 * "Gerar stories" container stops reading like a card nobody asked for.
 */
export async function generateTasksForIdeaAction(input: {
  boardId: string;
  cardId: string;
  /** WS-9 (9.2): bypass the "already addressed by an active story" guard — the human/MCP caller confirmed. */
  force?: boolean;
  /** WS-9 (9.4): who triggered it (provenance). Browser server actions have no agent-actions actor (follow-up 1),
   *  so default to the human operating the bench. */
  actor?: string;
}): Promise<GenStoriesResult> {
  await requireSession("generateTasksForIdeaAction");
  try {
    const [config, cards] = await Promise.all([readBoardConfig(input.boardId), readCards(input.boardId)]);
    const idea = cards.find((c) => c.id === input.cardId);
    if (!idea || idea.type !== "idea") return { ok: false, error: "Ideia não encontrada." };

    // WS-9 (9.2): block the reflexive re-generation when an ACTIVE (non-terminal) story already addresses this
    // idea. Opps still live on the bench; this only stops the 1-idea→1-story auto that produced the duplicate
    // delivery track in the incident. `force:true` overrides (a deliberate human/MCP decision).
    if (!input.force) {
      const terminal = terminalStatusIds(config);
      const active = cardsAddressing(idea, cards).filter((s) => !s.status || !terminal.has(s.status));
      if (active.length) {
        const titles = active.map((s) => `«${s.title}»`).join(", ");
        return {
          ok: false,
          needsConfirm: true,
          addressedBy: active.map((s) => ({ id: s.id, title: s.title })),
          error:
            `Esta ideia já é endereçada por ${active.length} story(s) ativa(s): ${titles}. ` +
            `Gerar mais tarefas duplica a trilha de entrega — confirme para gerar mesmo assim.`,
        };
      }
    }

    const o = idea.idea;
    const statement = o?.statement?.trim() || idea.title;
    const solutions = o?.candidateSolutions ?? [];
    const actor = input.actor?.trim() || "operador";
    const lines = [
      // WS-9 (9.4): provenance header — mata a ilusão de "card que ninguém pediu".
      `Origem: criado por ${actor} via bancada de Ideias em ${today()} — a partir da ideia «${statement}».`,
      "",
      "Gere as user stories de ENTREGA que resolvem esta ideia (uma dor do usuário).",
      "",
      `Dor (ideia): ${statement}`,
    ];
    if (o?.keyAssumption?.trim()) lines.push(`Premissa-chave a validar: ${o.keyAssumption.trim()}`);
    if (o?.successSignal?.trim()) lines.push(`Sinal de sucesso: ${o.successSignal.trim()}`);
    if (solutions.length) lines.push(`Soluções candidatas: ${solutions.join("; ")}`);
    lines.push(
      "",
      "Proponha as user stories de MENOR incremento de valor que endereçam esta dor (cada uma consumível " +
        "ponta-a-ponta por um usuário). NÃO fatie por camada técnica; na dúvida, MENOS stories.",
    );
    return await startCaptureAction({
      boardId: input.boardId,
      text: lines.join("\n"),
      // título legível p/ o painel de runs / Inbox (a instrução completa vive no body do container).
      title: `Gerar tarefas: «${statement}»`,
      scopeIdeaId: input.cardId,
    });
  } catch (e) {
    return fail<{ card: Card }>(e);
  }
}
