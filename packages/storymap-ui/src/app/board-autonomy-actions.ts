"use server";

// As server actions da AUTONOMIA DO BOARD — o controle único «Autonomia» (a pílula da barra do topo e a seção da
// engrenagem: um painel, duas portas). São a ponte, e nada mais: o perfil, os presets, as dependências e a escrita
// coerente moram em `lib/storymap/autonomy-profile.ts`.
//
// QUEM MUDA: só a sessão do OPERADOR no navegador. Um agente (token de MCP, sessão escopada) é recusado — agente nunca
// muda a autonomia, nem a dele nem a de outro. Não há tool MCP de escrita; a de leitura é `board_autonomy`.

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth/action-guard";
import { resolveActionCaller } from "@/lib/auth/action-guard";
import { readBoardConfig } from "@/lib/storymap/repo";
import { updateBoardConfigOnDisk } from "@/lib/storymap/write";
import { loadRunnerConfig } from "@/lib/storymap/runner/config";
import { autonomousModeSafe, lintRiskMatrix } from "@/lib/storymap/runner/orchestrator-policy";
import { appendSystemDecision, newSystemDecisionId } from "@/lib/storymap/runner/decision-log";
import { appendAgentAction } from "@/lib/storymap/runner/agent-actions";
import {
  ALWAYS_OWNER_NOTE,
  AUTONOMY_BOXES,
  alwaysOwnerPoints,
  applyAutonomyChange,
  autonomyKeysFingerprint,
  autonomyProfileOf,
  autonomyReceipt,
  autonomySnapshotOf,
  dependencyBlock,
  hasExplicitProfile,
  profileConflicts,
  shownPresetOf,
  withAutonomyProfile,
  withAutonomySnapshot,
  type AgentDecides,
  type AgentDecidesKey,
  type AlwaysOwnerPoint,
  type AutonomyPreset,
  type AutonomyProfile,
  type AutonomySnapshot,
} from "@/lib/storymap/autonomy-profile";

type Result<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/** O que o painel mostra: o perfil, o preset, cada caixa com o motivo de estar desabilitada, e a lista travada. */
export interface BoardAutonomyView {
  boardId: string;
  profile: AutonomyProfile;
  preset: AutonomyPreset;
  /** o board já tem o bloco explícito (o painel gravou), ou o perfil ainda é derivado das chaves de antes. */
  explicit: boolean;
  boxes: Array<{ key: AgentDecidesKey; label: string; effect: string; on: boolean; blockedBy: string | null; soon: boolean }>;
  /** caixas ligadas sem a pré-requisito (só num board legado) — o painel mostra, o dono escolhe. */
  conflicts: string[];
  alwaysOwner: AlwaysOwnerPoint[];
  alwaysOwnerNote: string;
}

function viewOf(boardId: string, profile: AutonomyProfile, explicit: boolean, config: Parameters<typeof alwaysOwnerPoints>[0]): BoardAutonomyView {
  return {
    boardId,
    profile,
    // o nível que a TELA mostra (toda caixa que vale hoje conta) — o mesmo da pílula e da tool `board_autonomy`
    preset: shownPresetOf(profile),
    explicit,
    boxes: AUTONOMY_BOXES.map((b) => ({
      key: b.key,
      label: b.label,
      effect: b.effect,
      on: profile[b.key],
      blockedBy: b.soon ? "em breve" : profile[b.key] ? null : dependencyBlock(profile, b.key),
      soon: b.soon === true,
    })),
    conflicts: profileConflicts(profile),
    alwaysOwner: alwaysOwnerPoints(config),
    alwaysOwnerNote: ALWAYS_OWNER_NOTE,
  };
}

/** A autonomia do board agora — a leitura do painel. */
export async function getBoardAutonomyAction(boardId: string): Promise<Result<BoardAutonomyView>> {
  await requireSession("getBoardAutonomyAction");
  const config = await readBoardConfig(boardId).catch(() => null);
  if (!config) return { ok: false, error: "Este board não existe ou não pôde ser lido." };
  return { ok: true, data: viewOf(boardId, autonomyProfileOf(config, loadRunnerConfig()), hasExplicitProfile(config), config) };
}

/** O «Desfazer» de uma mudança: a foto das chaves de ANTES e a impressão digital de DEPOIS (o que a mudança gravou). */
export interface AutonomyUndo {
  snapshot: AutonomySnapshot;
  /** autonomyKeysFingerprint da config logo depois da mudança — se a autonomia mudou de novo desde então, recusa. */
  after: string;
}

/**
 * Muda a autonomia do board — um preset inteiro (`minima` | `maxima`), caixas soltas (`patch`) ou o «Desfazer»
 * (`restore`). O ESCRITOR ÚNICO: grava, numa só escrita sob a trava do board.yaml, o bloco `autonomy.agentDecides` E as
 * chaves que os leitores de antes consultam (`autonomy.mode`, `release.mode`, `orchestrator.mode` + `riskMatrix`),
 * coerentes entre si; a matriz passa pelo mesmo lint de sempre. Idempotente: a mesma mudança de novo não grava nada.
 * Devolve o recibo («Autonomia: Personalizada — agora os agentes publicam sozinhos») e o `undo`: a foto EXATA das
 * chaves de antes — desfazer é chamar com `restore: undo`, que as devolve como estavam (nenhuma dependência propagada,
 * nada normalizado: um board legado incoerente volta incoerente, nunca com MAIS autonomia do que o dono deu).
 */
export async function setBoardAutonomyAction(input: {
  boardId: string;
  preset?: "minima" | "maxima";
  patch?: Partial<AgentDecides>;
  restore?: AutonomyUndo;
}): Promise<Result<BoardAutonomyView & { previous: AutonomyProfile; undo: AutonomyUndo | null; receipt: string; changed: boolean }>> {
  await requireSession("setBoardAutonomyAction");
  try {
    const caller = await resolveActionCaller();
    if (caller !== "operator-session") {
      return { ok: false, error: "A autonomia do board é uma decisão do operador: só muda pela tela, com a sua sessão — nenhum agente a muda." };
    }
    if (input.preset && input.preset !== "minima" && input.preset !== "maxima") return { ok: false, error: `Preset desconhecido: ${String(input.preset)}` };
    if (!input.preset && !input.patch && !input.restore) return { ok: false, error: "Diga o preset ou as caixas a mudar." };
    const settings = loadRunnerConfig();
    // o que a mutação viu (sob a trava): o perfil antes e depois, o lint, a recusa e se gravou
    const seen: { prev?: AutonomyProfile; next?: AutonomyProfile; nextExplicit?: boolean; lint?: string; refused?: string; changed?: boolean; undo?: AutonomyUndo } = {};
    const written = await updateBoardConfigOnDisk(input.boardId, (current) => {
      const prev = autonomyProfileOf(current, settings);
      seen.prev = prev;
      let candidate: typeof current;
      if (input.restore) {
        // o «Desfazer» só vale sobre o estado que a mudança deixou: mexeram de novo desde então ⇒ recusa (desfazer por
        // cima de outra mudança apagaria a outra)
        if (autonomyKeysFingerprint(current) !== input.restore.after) {
          seen.refused = "A autonomia deste board mudou depois disso — ajuste pelas caixas.";
          return null;
        }
        candidate = withAutonomySnapshot(current, input.restore.snapshot);
      } else {
        candidate = withAutonomyProfile(current, applyAutonomyChange(prev, { preset: input.preset, patch: input.patch }));
      }
      seen.next = autonomyProfileOf(candidate, settings);
      seen.nextExplicit = hasExplicitProfile(candidate);
      // A defesa em profundidade que o seletor antigo tinha: `autonomous` só com a matriz de risco imposta pela guarda.
      if (candidate.orchestrator?.mode === "autonomous" && current.orchestrator?.mode !== "autonomous" && !autonomousModeSafe()) {
        seen.refused = "O Jido agir no board exige a matriz de risco imposta pela guarda do MCP, e ela está desligada neste servidor.";
        return null;
      }
      const errors = lintRiskMatrix(candidate.orchestrator);
      if (errors.length) {
        seen.lint = errors.join("; ");
        return null;
      }
      // Idempotente: o board.yaml já diz exatamente isto (o bloco explícito e as chaves coerentes) ⇒ não regrava.
      const keys = (c: typeof current) => JSON.stringify([c.autonomy ?? null, c.release ?? null, c.orchestrator ?? null]);
      if (keys(current) === keys(candidate)) return null;
      seen.changed = true;
      seen.undo = { snapshot: autonomySnapshotOf(current), after: autonomyKeysFingerprint(candidate) };
      return candidate;
    });
    if (seen.refused) return { ok: false, error: seen.refused };
    if (seen.lint) return { ok: false, error: seen.lint };
    if (!seen.prev || !seen.next) return { ok: false, error: "Este board não existe ou não pôde ser lido." };
    const prevProfile = seen.prev;
    const nextProfile = seen.next;
    const changed = seen.changed === true && !!written;
    const nextExplicit = seen.nextExplicit ?? true;
    const receipt = autonomyReceipt(prevProfile, nextProfile);
    if (changed) {
      void appendSystemDecision({
        v: 1,
        id: newSystemDecisionId(),
        at: new Date().toISOString(),
        board: input.boardId,
        agent: "human",
        kind: "board-mode",
        what: receipt,
        why: "Você mudou o que os agentes decidem sozinhos neste board. O que é sempre seu não mudou.",
      });
      void appendAgentAction({
        actor: "human:autonomy-panel",
        board: input.boardId,
        tool: "setBoardAutonomyAction",
        cls: "write-board",
        disposition: "auto",
        outcome: "executed",
        note: `agentDecides=${JSON.stringify(nextProfile)}`,
      });
      revalidatePath(`/board/${input.boardId}`);
      // Ligar o copiloto dispara um tique IMEDIATO só deste board (o mesmo gesto do seletor de antes); inerte sem o
      // token do orquestrador no ambiente do serviço.
      if (nextProfile.copilot && !prevProfile.copilot) {
        void import("@/lib/storymap/runner/orchestrator-run")
          .then(({ runBoardTickNow }) => runBoardTickNow(input.boardId, "você acabou de deixar o Jido agir no board"))
          .catch(() => {});
      }
    }
    const config = written ?? (await readBoardConfig(input.boardId).catch(() => null));
    return {
      ok: true,
      data: { ...viewOf(input.boardId, nextProfile, nextExplicit, config), previous: prevProfile, undo: changed ? (seen.undo ?? null) : null, receipt, changed },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
