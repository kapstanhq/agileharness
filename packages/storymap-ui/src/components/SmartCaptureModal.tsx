"use client";

// Captura inteligente — fluxo SÍNCRONO autocontido na modal, com uma MÁQUINA DE ESTADOS EXPLÍCITA
// (`step`) e um HUB PERSISTENTE. Quatro telas:
//
//   input         — UMA caixa de texto livre + imagens de contexto (downscale no cliente). "Propor" roda
//                   o LLM (proposeCardsAction) sem gravar nada.
//   review        — a proposta INICIAL, editável: marcar/desmarcar com cascata dura, colapsar, AJUSTAR.
//                   "Aceitar e criar" grava na Triagem (commitProposalAction) → vai pro HUB.
//   hub           — o RESULTADO PERSISTENTE: as ideias (◆) e os cards da Triagem criados na sessão.
//                   Cada ideia tem a ação inline "Gerar stories" (loop dual-track) + a marca
//                   "✓ N stories" derivada de cardsAddressing. Seleção em LOTE → gerar stories p/ várias
//                   (assíncrono → Inbox). "+ Capturar outra" acumula; "Concluir" fecha.
//   story-review  — as stories GERADAS de UMA ideia (proposeTasksForIdeaAction, síncrono).
//                   Aceitar/Voltar SEMPRE retorna pro HUB — as outras dores NUNCA somem.
//
// BUG-RAIZ consertado: a fase deixou de ser DERIVADA (`proposal ? review : created ? created : input`,
// onde proposal sempre vencia created e o HUB sumia ao gerar stories) e passou a um `step` explícito;
// `hubCards` vive INDEPENDENTE de `proposal`, então abrir a sub-tela de stories nunca apaga o HUB.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bug, ImageUp, Loader2, MapPinOff, Plus, Sparkles, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { servesIsPlacement } from "@/lib/storymap/unplaced";
import { HitlSurface } from "@/components/hitl/HitlSurface";
import { HitlConversation } from "@/components/hitl/HitlConversation";
import { useHitl } from "@/components/hitl/useHitl";
import { planDisambiguation } from "@/lib/storymap/hitl/disambiguation";
import type { HitlTurn } from "@/lib/storymap/hitl/types";
import {
  commitProposalAction,
  proposeCardsAction,
  proposeTasksForIdeaAction,
  recastProposedItemAction,
} from "@/app/actions";
import { generateTasksForIdeaAction } from "@/app/idea-actions";
import { ProposalTree, type ReanchorPatch } from "@/components/ProposalTree";
import { IdeaBlock } from "@/components/entity/IdeaBlock";
import { BatchActionBar } from "@/components/entity/BatchActionBar";
import {
  ancestorTempIds,
  applyReanchor,
  cascadeSelect,
  effectiveSelectedCount,
  selectAll,
} from "@/lib/storymap/smart-capture/proposal-tree";
import { batchActionsFor, confirmFor } from "@/lib/storymap/entity-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { runBatch, toggleId } from "@/lib/storymap/selection";
import { resolvesToIdea } from "@/lib/storymap/idea";
import { correlateCommitWarnings, type CaptureWarningView } from "@/lib/storymap/smart-capture/warnings";
import type { CaptureTurn, Proposal, ProposedItem } from "@/lib/storymap/smart-capture/types";
import type { BoardConfig, Card, CardType } from "@/lib/storymap/types";
import type { StoryType } from "@/lib/storymap/frameworks";

/** A context image held in the modal (downscaled data URL ready to ship to the server). */
type CaptureImage = { id: string; name: string; dataUrl: string };

type CaptureStep = "input" | "review" | "hub" | "story-review";

/** ① dica de intenção (chips) — em voz humana; mapeada a intentHint no propose(). "auto" = classificação automática.
 *  WS-9: a "Necessidade" (dor crua → ◆) saiu — a captura estruturada não cunha ideia; dor crua vai para a
 *  bancada de Ideias. Restam Automático / Melhoria ou função / Algo quebrado. */
type CaptureIntent = "auto" | "story" | "bug";
type IntentChip = {
  value: CaptureIntent;
  label: string;
  /** "spark" = o chip "mágico" (opção automática, borda em degradê + glifo Sparkles); senão um ícone lucide de linha. */
  icon: "spark" | LucideIcon;
  /** explicação rica (popover no hover/foco) — ajuda o usuário leigo a escolher. */
  blurb: string;
  /** quando essa opção é a certa. */
  when: string;
  /** exemplo concreto, na voz de quem captura. */
  example: string;
};
const INTENT_CHIPS: IntentChip[] = [
  {
    value: "auto",
    label: "Automático",
    icon: "spark",
    blurb: "Você escreve à vontade e o assistente decide o tipo de cada coisa que encontrar.",
    when: "Está em dúvida, ou é um despejo de ideias misturadas (necessidade + função + defeito juntos).",
    example: "“o app trava ao salvar e seria bom ter um mural de favoritos”",
  },
  {
    value: "story",
    label: "Melhoria ou função",
    icon: Plus,
    blurb: "Algo concreto a construir ou melhorar no produto — o espaço da solução.",
    when: "Você já sabe o que quer entregar: uma tela, um botão, uma capacidade nova.",
    example: "“adicionar um mural de favoritos no perfil”",
  },
  {
    value: "bug",
    label: "Algo quebrado",
    icon: Bug,
    blurb: "Um defeito: algo que deveria funcionar e não funciona.",
    when: "Você está reportando um erro, um comportamento errado ou uma tela quebrada.",
    example: "“o botão de salvar não responde no celular”",
  },
];

const MAX_IMAGES = 4;
const MAX_DIM = 1568; // Claude's recommended max edge — past this is wasted vision tokens.

/** Merge two card lists by id (the second wins). Keeps the HUB list accumulating without duplicates. */
function mergeCardsById(prev: Card[], add: Card[]): Card[] {
  const map = new Map(prev.map((c) => [c.id, c] as const));
  for (const c of add) map.set(c.id, c);
  return [...map.values()];
}

/** Read a File and downscale (longest edge ≤ MAX_DIM) → a compact JPEG data URL. */
async function downscaleToDataUrl(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(new Error("Falha ao ler a imagem."));
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("Imagem inválida."));
    im.src = dataUrl;
  });
  const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
  if (scale === 1 && dataUrl.length < 700_000) return dataUrl; // already small — keep as-is
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.9);
}

export function SmartCaptureModal({
  boardId,
  config,
  cards,
  onClose,
  onCreated,
  onOpenCard,
  onOpenIdeas,
  initialText,
}: {
  boardId: string;
  /** o board resolvido — a árvore de arquitetura precisa dele para saber onde cada tipo ancora. */
  config: BoardConfig;
  /** existing board cards — a árvore desenha os existentes como CONTEXTO da proposta. */
  cards?: Card[];
  /** Texto que o composer já nasce contendo — a captura semeada por outra tela (ex.: o recorte do PRD).
   *  Editável como qualquer outro: quem semeia propõe um ponto de partida, não uma decisão. */
  initialText?: string;
  onClose: () => void;
  /** fires AFTER cards are created (each commit) so the parent can refresh the board behind the modal. */
  onCreated?: (created: Card[]) => void;
  /** open a freshly created pipeline card (closes the modal) — wired by the board. */
  onOpenCard?: (id: string) => void;
  /** open the Ideias bench (closes the modal) — wired by the board. */
  onOpenIdeas?: () => void;
}) {
  const [text, setText] = useState(initialText ?? "");
  const [images, setImages] = useState<CaptureImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [intent, setIntent] = useState<CaptureIntent>("auto");
  const [step, setStep] = useState<CaptureStep>("input");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [turns, setTurns] = useState<CaptureTurn[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // The persistent HUB: everything created in THIS session (accumulates across commits). Independent of
  // `proposal` — that's the whole fix: opening story-review never wipes it.
  const [hubCards, setHubCards] = useState<Card[] | null>(null);
  // set while reviewing stories GENERATED from an idea → commit stamps the addresses edge.
  const [scopeOpp, setScopeOpp] = useState<{ id: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // which idea's inline "Gerar stories" is running → the spinner shows ONLY on that card's button.
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  // ② which proposed item is being re-cast (rewritten to another type) right now.
  const [recastingId, setRecastingId] = useState<string | null>(null);
  // ③ item being disambiguated via the HITL popover (+ the anchor element it's pinned to).
  const [disambig, setDisambig] = useState<{ item: ProposedItem; anchor: HTMLElement } | null>(null);
  // ③ transcripts da desambiguação POR tempId — persistem fora do popover, então fechar/reabrir RETOMA a
  // conversa em vez de recomeçar do zero (não perde os rounds já trocados).
  const [disambigTurns, setDisambigTurns] = useState<Record<string, HitlTurn[]>>({});
  const [error, setError] = useState<string | null>(null);
  // HUB batch selection (idea ids) + async fan-out state.
  const [hubSelected, setHubSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  // A pergunta do "gerar em lote" — um clique aqui dispara N agentes.
  const [confirmGen, setConfirmGen] = useState(false);
  // …e a do "gerar" de UMA ideia do HUB. Este caminho é SÍNCRONO (`proposeTasksForIdeaAction`): ele não
  // deixa contêiner nem proposta para limpar, mas gasta uma chamada de modelo e o tempo dela num clique
  // de raspão — a mesma ação (`generate-stories`) do catálogo, e o catálogo diz que ela pergunta.
  const [confirmGenOne, setConfirmGenOne] = useState<Card | null>(null);
  const [batchNote, setBatchNote] = useState<string | null>(null);
  // idea ids dispatched to Inbox via the async batch this session → block re-send + show a badge.
  const [batchSentIds, setBatchSentIds] = useState<Set<string>>(new Set());
  // 4.1 — placement-degradation warnings from the last commit (a parent/serves the proposal asked for that
  // couldn't be honored). Surfaced non-blocking in the HUB with a link to the created card, never dropped.
  const [captureWarnings, setCaptureWarnings] = useState<CaptureWarningView[]>([]);

  // pool for cardsAddressing + anchor/title resolution = board cards + everything created this session.
  const pool = mergeCardsById(cards ?? [], hubCards ?? []);
  const hubIdeas = (hubCards ?? []).filter((c) => c.type === "idea");
  // pipeline cards to list = non-idea AND not a story that addresses an idea (those are
  // counted UNDER the idea as "✓ N stories", not listed separately).
  const hubPipeline = (hubCards ?? []).filter(
    (c) => c.type !== "idea" && !resolvesToIdea(c.links ?? []),
  );

  const addFiles = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      setError(`Máximo de ${MAX_IMAGES} imagens.`);
      return;
    }
    try {
      const next = await Promise.all(
        imgs.slice(0, room).map(async (f, i) => ({
          id: crypto.randomUUID(),
          name: f.name || `colado-${images.length + i + 1}.png`,
          dataUrl: await downscaleToDataUrl(f),
        })),
      );
      setImages((prev) => [...prev, ...next]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao anexar imagem.");
    }
  };
  const removeImage = (id: string) => setImages((prev) => prev.filter((im) => im.id !== id));

  const propose = async () => {
    if ((!text.trim() && images.length === 0) || busy) return;
    setBusy(true);
    setError(null);
    const t = text.trim();
    const res = await proposeCardsAction({
      boardId,
      text: t,
      images: images.map((im) => ({ name: im.name, dataUrl: im.dataUrl })),
      intentHint: intent === "auto" ? null : intent,
    });
    setBusy(false);
    if (res.ok && res.data) {
      setProposal(res.data.proposal);
      setTurns([{ text: t, proposal: res.data.proposal }]);
      setSelected(selectAll(res.data.proposal.items));
      setCollapsed(new Set());
      setScopeOpp(null);
      setStep("review");
    } else {
      setError(res.ok ? "O agente não propôs nenhum item." : res.error);
    }
  };

  const refine = async (feedback: string) => {
    const f = feedback.trim();
    if (!f || busy) return;
    setBusy(true);
    setError(null);
    const res = await proposeCardsAction({ boardId, text: f, history: turns });
    setBusy(false);
    if (res.ok && res.data) {
      // Em story-review a WORK path é stories-only endereçando UMA dor: mantenha essa disciplina no refino
      // (o prompt geral de captura poderia re-introduzir activities/ideias) filtrando para stories e
      // re-carimbando a aresta addresses — espelhando proposeTasksForIdeaAction.
      const rawItems = res.data.proposal.items;
      const newItems =
        step === "story-review" && scopeOpp
          ? rawItems.filter((it) => it.type === "story").map((it) => ({ ...it, addresses: scopeOpp.id }))
          : rawItems;
      if (!newItems.length) {
        setError(step === "story-review" ? "O refino não produziu nenhuma story." : "O agente não propôs nenhum item.");
        return;
      }
      const nextProposal = { ...res.data.proposal, items: newItems };
      const oldIds = new Set((proposal?.items ?? []).map((i) => i.tempId));
      setProposal(nextProposal);
      setTurns((tt) => [...tt, { text: f, proposal: nextProposal }]);
      // F5 — preserva as DESELEÇÕES do humano através do refino (por tempId estável): um item que
      // sobreviveu e estava desmarcado continua desmarcado; itens novos entram marcados. Reaplica o
      // fechamento por pai (parent-closed) para nunca deixar um filho novo selecionado sob pai desmarcado.
      setSelected((prev) => {
        const next = new Set<string>();
        for (const it of newItems) {
          const wasDeselected = oldIds.has(it.tempId) && !prev.has(it.tempId);
          if (!wasDeselected) next.add(it.tempId);
        }
        for (const id of [...next]) ancestorTempIds(newItems, id).forEach((a) => next.add(a));
        return next;
      });
      setCollapsed(new Set());
    } else {
      setError(res.ok ? "O agente não propôs nenhum item." : res.error);
    }
  };

  const accept = async () => {
    if (!proposal || busy) return;
    const items = proposal.items.filter((it) => selected.has(it.tempId));
    if (items.length === 0) {
      setError("Marque ao menos um card para criar.");
      return;
    }
    setBusy(true);
    setError(null);
    const addressesIdeaId = step === "story-review" ? scopeOpp?.id : undefined;
    // story-cl1mi9: forward the pasted context images so a captured BUG retains them on the card
    // (they were previously consumed only by the propose/vision step and dropped at commit).
    const res = await commitProposalAction({
      boardId,
      items,
      addressesIdeaId,
      // A modal É a tela de revisão: o operador viu tipo, confiança e duplicata, pôde reclassificar
      // e reancorar, e clicou em criar. Não faz sentido o card nascer pedindo "revise este item".
      humanReviewed: true,
      images: images.map((im) => ({ name: im.name, dataUrl: im.dataUrl })),
    });
    setBusy(false);
    if (res.ok) {
      const createdCards = res.data?.created ?? [];
      onCreated?.(createdCards); // refresh the board behind the modal
      setHubCards((prev) => mergeCardsById(prev ?? [], createdCards));
      // 4.1 — surface any placement-degradation warnings in the HUB (non-blocking); `items` are the selected
      // ProposedItems, so we can pair each warning's tempId back to a readable title + the created card id.
      setCaptureWarnings(correlateCommitWarnings(items, res.data?.warnings ?? []));
      setProposal(null);
      setScopeOpp(null);
      setTurns([]);
      setSelected(new Set());
      setCollapsed(new Set());
      setBatchNote(null);
      setStep("hub");
    } else {
      setError(res.error);
    }
  };

  /** Inline (synchronous) story generation for ONE idea → goes to story-review, returns to hub. */
  const generateStories = async (idea: Card) => {
    if (busy || batchBusy) return;
    setBusy(true);
    setGeneratingId(idea.id);
    setError(null);
    const res = await proposeTasksForIdeaAction({ boardId, cardId: idea.id });
    setBusy(false);
    setGeneratingId(null);
    if (res.ok && res.data) {
      setProposal(res.data.proposal);
      setScopeOpp(res.data.idea);
      setSelected(selectAll(res.data.proposal.items));
      setCollapsed(new Set());
      setTurns([{ text: `Stories que resolvem: ${res.data.idea.title}`, proposal: res.data.proposal }]);
      setStep("story-review");
    } else {
      setError(res.ok ? "O agente não propôs nenhuma story." : res.error);
    }
  };

  /** Batch (asynchronous) story generation for the SELECTED ideas → each lands on Inbox. */
  const batchGenerate = async () => {
    const ids = [...hubSelected];
    if (!ids.length || batchBusy || busy) return;
    setBatchBusy(true);
    setBatchNote(null);
    setError(null);
    const { okIds, failed } = await runBatch(
      ids,
      (id) => generateTasksForIdeaAction({ boardId, cardId: id }),
      undefined,
      { concurrency: 5 },
    );
    setBatchBusy(false);
    setHubSelected(new Set());
    setBatchSentIds((prev) => new Set([...prev, ...okIds])); // marca como enviadas → some o "gerar", evita re-disparo
    onCreated?.([]); // refresh the board behind (the capture containers now exist)
    const okN = okIds.length;
    if (failed.length === 0) {
      setBatchNote(
        `${okN} ${okN === 1 ? "ideia enviada" : "ideias enviadas"} para o Inbox — revise quando quiser.`,
      );
    } else {
      const distinct = [...new Set(failed.map((f) => f.error))];
      setBatchNote(`${okN} enviada(s); ${failed.length} falhou(ram): ${distinct.join(" · ")}`);
    }
  };

  /** ② Re-cast one proposed item to another type — the agent rewrites its content; replace it in place. */
  const recast = async (tempId: string, toType: CardType, toStoryType: StoryType | null) => {
    if (!proposal || recastingId) return;
    const item = proposal.items.find((i) => i.tempId === tempId);
    if (!item) return;
    setRecastingId(tempId);
    setError(null);
    const res = await recastProposedItemAction({ boardId, item, toType, toStoryType, sourceText: turns[0]?.text });
    setRecastingId(null);
    if (res.ok && res.data) {
      const next = res.data.item;
      setProposal((p) => (p ? { ...p, items: p.items.map((i) => (i.tempId === tempId ? next : i)) } : p));
    } else {
      setError(res.ok ? "Não foi possível reclassificar o item." : res.error);
    }
  };

  /**
   * Reancorar um item PROPOSTO na hora — puramente local, sem chamar o agente. É a saída de 1 clique
   * do aviso de duplicata ("isto é entrega DAQUELE card" / "só some as tasks nele"). NÃO passa por
   * LLM de propósito: a decisão de ARQUITETURA é do operador e já está tomada quando ele clica; um
   * round-trip só arriscaria o agente reescrever o resto do lote.
   */
  // A regra da reancoragem (inclusive o "a suspeita de duplicata foi resolvida") vive em proposal-tree,
  // compartilhada com o Inbox — duas cópias divergiriam na primeira mudança.
  const reanchor = (tempId: string, patch: ReanchorPatch) => {
    setProposal((p) => (p ? { ...p, items: applyReanchor(p.items, tempId, patch) } : p));
  };

  /**
   * ③ aplica o resultado da desambiguação (RecastResult) ao item proposto e fecha o popover. Usa
   * `planDisambiguation` (puro): se o tipo/subtipo MUDOU, REESCREVE o corpo no novo formato via
   * recastProposedItemAction (não relabela — preserva a regra da ②); mesmo tipo só carimba título/racional.
   * `done` inválido NÃO limpa o ⚠ (evita falso "resolvido") — só sinaliza erro.
   */
  const applyDisambig = async (done: unknown) => {
    const item = disambig?.item;
    setDisambig(null);
    if (!item) return;
    const tempId = item.tempId;
    const plan = planDisambiguation(item, done);
    if (plan.kind === "invalid") {
      setError("A desambiguação não retornou uma classificação válida — tente de novo.");
      return;
    }
    if (plan.kind === "bancada") {
      // WS-9 (D15): o veredito é DOR CRUA — a captura não cria ideia. NÃO altera o item (o ⚠ fica, então
      // não é um falso "resolvido"); guia o humano para a bancada de Ideias, o ponto de entrada leve onde
      // a dor é registrada deliberadamente. Se o item só descreve a dor, ele deve ser removido da proposta.
      const dor = plan.title || item.title;
      setError(
        `«${dor}» é uma dor crua — a captura não cria ideias. Registre-a na bancada de Ideias ` +
          `(botão "Ideias") e remova este item se ele só descreve a dor.`,
      );
      return;
    }
    if (plan.kind === "stamp") {
      setProposal((p) => (p ? { ...p, items: p.items.map((i) => (i.tempId === tempId ? plan.item : i)) } : p));
      return;
    }
    // recast: o tipo/subtipo mudou → reescreve o conteúdo no novo formato (mesma ação do select ②).
    setRecastingId(tempId);
    setError(null);
    const res = await recastProposedItemAction({
      boardId,
      item,
      toType: plan.toType,
      toStoryType: plan.toStoryType,
      sourceText: turns[0]?.text,
    });
    setRecastingId(null);
    if (res.ok && res.data) {
      const rewritten: ProposedItem = {
        ...res.data.item,
        title: plan.title || res.data.item.title,
        rationale: plan.rationale || res.data.item.rationale,
        ambiguous: false,
        confidence: 0.9,
      };
      setProposal((p) => (p ? { ...p, items: p.items.map((i) => (i.tempId === tempId ? rewritten : i)) } : p));
    } else {
      setError(res.ok ? "Não foi possível reescrever o item." : res.error);
    }
  };

  const captureAnother = () => {
    setText("");
    setImages([]);
    setProposal(null);
    setScopeOpp(null);
    setTurns([]);
    setSelected(new Set());
    setCollapsed(new Set());
    setError(null);
    setBatchNote(null);
    setCaptureWarnings([]); // 4.1 — a fresh capture starts with no stale warnings
    setHubSelected(new Set());
    setIntent("auto");
    setStep("input");
    // KEEP hubCards — the HUB accumulates across captures in one session.
  };

  const back = () => {
    setError(null);
    if (step === "story-review") {
      // back to the HUB (the idea + the others persist).
      setProposal(null);
      setScopeOpp(null);
      setSelected(new Set());
      setCollapsed(new Set());
      setTurns([]);
      setStep("hub");
    } else if (step === "review") {
      // back to input (capturing another round) → hub if it exists, else the empty input.
      setProposal(null);
      setSelected(new Set());
      setCollapsed(new Set());
      setTurns([]);
      setStep(hubCards ? "hub" : "input");
    }
  };

  const onSelect = (tempId: string, on: boolean) =>
    setSelected((s) => cascadeSelect(proposal?.items ?? [], s, tempId, on));
  const onToggleCollapse = (tempId: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(tempId)) next.delete(tempId);
      else next.add(tempId);
      return next;
    });
  const onSelectAll = () => setSelected(selectAll(proposal?.items ?? []));
  const onSelectNone = () => setSelected(new Set());

  // HUB batch selection (idea ids).
  const toggleHubSelect = (id: string) => setHubSelected((s) => toggleId(s, id, !s.has(id)));
  // só dores ainda NÃO enviadas ao Inbox entram no "selecionar todas" / no total da barra.
  const selectableOpps = hubIdeas.filter((o) => !batchSentIds.has(o.id));
  const selectAllOpps = () => setHubSelected(new Set(selectableOpps.map((o) => o.id)));
  const clearHubSelection = () => setHubSelected(new Set());

  const openCard = (id: string) => {
    onOpenCard?.(id);
    onClose();
  };
  const openIdeas = () => {
    onOpenIdeas?.();
    onClose();
  };

  const selectedCount = effectiveSelectedCount(selected);

  // "Nenhum item nasce sem lugar" — a decisão de placement acontece AQUI, na revisão, com o mapa inteiro na
  // tela e o contexto fresco, e não há mais escapatória: a invariante de hierarquia recusa a escrita de um
  // card sem âncora. O caminho de saída é o FEEDBACK (o agente repropõe encaixando a story num passo
  // existente ou propondo um passo novo no mesmo lote, que resolve por tempId) — não um aceite.
  const placelessSelected = useMemo(
    () =>
      (proposal?.items ?? []).filter(
        (it) =>
          selected.has(it.tempId) &&
          it.type === "story" &&
          !it.parent &&
          !servesIsPlacement(it.storyType, it.serves),
      ),
    [proposal, selected],
  );
  const blockedByPlacement = placelessSelected.length > 0;
  const headerTitle =
    step === "hub"
      ? "Resultado da captura"
      : step === "story-review"
        ? "Revisar stories"
        : step === "review"
          ? "Revisar proposta"
          : "Capturar";

  // HUB batch action descriptors (registry) — the modal only fans out "generate-stories" (async).
  // PERGUNTA antes (o registry diz que esta ação precisa): aqui um clique dispara N agentes de uma vez, que é
  // a versão cara do mesmo acidente que a bancada já sofreu com UM.
  const hubBatchActions = batchActionsFor(hubIdeas)
    .filter((a) => a.id === "generate-stories")
    .map((a) => ({
      id: a.id,
      label: `Gerar tarefas (${hubSelected.size})`,
      icon: a.icon,
      tone: a.tone,
      onRun: () => setConfirmGen(true),
    }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <span className="text-[15px] font-semibold tracking-tight text-fg">{headerTitle}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
            title="Fechar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="board-scroll flex-1 space-y-4 overflow-y-auto px-6 py-5">
          {step === "input" && (
            <InputPhase
              text={text}
              setText={setText}
              images={images}
              dragOver={dragOver}
              setDragOver={setDragOver}
              intent={intent}
              setIntent={setIntent}
              onAddFiles={addFiles}
              onRemoveImage={removeImage}
              onSubmit={propose}
            />
          )}

          {(step === "review" || step === "story-review") && proposal && (
            <ProposalPreview
              proposal={proposal}
              config={config}
              cards={pool}
              scopeTitle={step === "story-review" ? scopeOpp?.title ?? null : null}
              selected={selected}
              onSelect={onSelect}
              collapsed={collapsed}
              onToggleCollapse={onToggleCollapse}
              onSelectAll={onSelectAll}
              onSelectNone={onSelectNone}
              onRecast={recast}
              onReanchor={reanchor}
              recastingId={recastingId}
              onDisambiguate={(item, anchor) => setDisambig({ item, anchor })}
              busy={busy}
              onRefine={refine}
            />
          )}

          {step === "hub" && (
            <HubPhase
              opps={hubIdeas}
              pipeline={hubPipeline}
              pool={pool}
              busy={busy}
              batchBusy={batchBusy}
              generatingId={generatingId}
              selected={hubSelected}
              sentIds={batchSentIds}
              batchNote={batchNote}
              warnings={captureWarnings}
              onGenerate={(idea) => setConfirmGenOne(idea)}
              onToggleSelect={toggleHubSelect}
              onOpenCard={openCard}
              onOpenIdeas={openIdeas}
            />
          )}

          {busy && (
            <div className="flex items-center gap-2 rounded-lg border border-line bg-fg/[0.03] px-4 py-3 text-[13px] text-fg-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              Analisando — pode levar de alguns segundos a alguns minutos.
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-line bg-fg/[0.04] px-4 py-3 text-[13px] text-fg">{error}</div>
          )}
        </div>

        {/* ③ HITL — popover de desambiguação ancorado na linha do item incerto (portal, posição própria). */}
        {disambig && proposal && (
          <CaptureDisambiguatePopover
            boardId={boardId}
            item={disambig.item}
            summary={proposal.summary}
            anchor={disambig.anchor}
            initialTurns={disambigTurns[disambig.item.tempId] ?? []}
            onTurnsChange={(t) => setDisambigTurns((m) => ({ ...m, [disambig.item.tempId]: t }))}
            onClose={() => setDisambig(null)}
            onResolved={applyDisambig}
          />
        )}

        {/* Batch action bar — pinned above the footer, only when ideas are selected in the HUB. */}
        {step === "hub" && (
          <BatchActionBar
            count={hubSelected.size}
            total={selectableOpps.length}
            onSelectAll={selectAllOpps}
            onClear={clearHubSelection}
            actions={hubBatchActions}
            busy={batchBusy}
          />
        )}

        {/* "Sem lugar no mapa" — a decisão de placement, na hora da revisão, com o contexto fresco. Não há
            aceite: a saída é o Feedback (o agente repropõe encaixando a story, ou propondo o passo junto). */}
        {(step === "review" || step === "story-review") && placelessSelected.length > 0 && (
          <div className="border-t border-amber-500/25 bg-amber-500/[0.07] px-6 py-3">
            <div className="flex items-start gap-2.5">
              <MapPinOff className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-500" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">
                  {placelessSelected.length === 1
                    ? "1 story sem lugar no mapa"
                    : `${placelessSelected.length} stories sem lugar no mapa`}
                </p>
                <p className="mt-0.5 text-xs text-fg-muted">
                  {placelessSelected.map((it) => `"${it.title}"`).join(", ")} — toda story vive sob um passo, e
                  sem isso ela não pode ser criada. Use <strong>Feedback</strong> para o agente encaixá-la num
                  passo existente ou propor o passo junto, no mesmo lote.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-line px-6 py-4">
          {step === "review" || step === "story-review" ? (
            <>
              <button
                type="button"
                onClick={back}
                disabled={busy}
                className="rounded-lg px-4 py-2 text-sm font-medium text-fg-muted transition hover:bg-surface-hover disabled:opacity-50"
              >
                {step === "story-review" ? "Voltar ao resultado" : "Voltar"}
              </button>
              <button
                type="button"
                onClick={accept}
                disabled={busy || selectedCount === 0 || blockedByPlacement}
                title={blockedByPlacement ? "Decida o lugar (Feedback) ou aceite 'sem lugar' acima" : undefined}
                className="inline-flex items-center gap-1.5 rounded-lg bg-fg px-5 py-2 text-sm font-semibold text-surface transition hover:bg-fg/85 disabled:opacity-50"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Aceitar e criar ({selectedCount})
              </button>
            </>
          ) : step === "hub" ? (
            <>
              <button
                type="button"
                onClick={captureAnother}
                disabled={busy || batchBusy}
                className="rounded-lg px-4 py-2 text-sm font-medium text-fg-muted transition hover:bg-surface-hover disabled:opacity-50"
              >
                + Capturar outra
              </button>
              <button
                type="button"
                onClick={onClose}
                disabled={busy || batchBusy}
                className="rounded-lg bg-fg px-5 py-2 text-sm font-semibold text-surface transition hover:bg-fg/85 disabled:opacity-50"
              >
                Concluir
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={hubCards ? () => setStep("hub") : onClose}
                className="rounded-lg px-4 py-2 text-sm font-medium text-fg-muted transition hover:bg-surface-hover"
              >
                {hubCards ? "Voltar ao resultado" : "Cancelar"}
              </button>
              <button
                type="button"
                onClick={propose}
                disabled={(!text.trim() && images.length === 0) || busy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-fg px-5 py-2 text-sm font-semibold text-surface transition hover:bg-fg/85 disabled:opacity-50"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Propor
              </button>
            </>
          )}
        </div>
      </div>

      {confirmGen &&
        (() => {
          const c = confirmFor("generate-stories", hubSelected.size)!;
          return (
            <ConfirmDialog
              title={c.title}
              description={c.description}
              confirmLabel={batchBusy ? "Gerando…" : c.confirmLabel}
              confirmDisabled={batchBusy}
              tone={c.tone}
              onCancel={() => setConfirmGen(false)}
              onConfirm={() => {
                setConfirmGen(false);
                void batchGenerate();
              }}
            />
          );
        })()}

      {confirmGenOne &&
        (() => {
          const c = confirmFor("generate-stories", 1)!;
          const idea = confirmGenOne;
          return (
            <ConfirmDialog
              title={c.title}
              // A CONSEQUÊNCIA aqui é outra (síncrona, sem Inbox): a cópia do catálogo descreve o caminho
              // assíncrono, e repeti-la mentiria sobre o que vai acontecer nesta tela.
              description={`«${idea.title}» — o agente propõe as tarefas AGORA, aqui na modal, para você revisar antes de criar. Leva alguns segundos e consome tokens; nada é criado até você aceitar.`}
              confirmLabel={busy ? "Gerando…" : c.confirmLabel}
              confirmDisabled={busy || batchBusy}
              onCancel={() => setConfirmGenOne(null)}
              onConfirm={() => {
                setConfirmGenOne(null);
                void generateStories(idea);
              }}
            />
          );
        })()}
    </div>
  );
}

/** Phase 1 — a single free-text box + context images (paste / drag-drop / attach). */
function InputPhase({
  text,
  setText,
  images,
  dragOver,
  setDragOver,
  intent,
  setIntent,
  onAddFiles,
  onRemoveImage,
  onSubmit,
}: {
  text: string;
  setText: (v: string) => void;
  images: CaptureImage[];
  dragOver: boolean;
  setDragOver: (v: boolean) => void;
  intent: CaptureIntent;
  setIntent: (v: CaptureIntent) => void;
  onAddFiles: (files: File[]) => void;
  onRemoveImage: (id: string) => void;
  onSubmit: () => void;
}) {
  // Popover explicativo por chip (hover/foco) — ajuda o usuário leigo a escolher o tipo. Ancorado ACIMA do
  // chip via portal (escapa do overflow do modal) e não-interativo (pointer-events-none → sem flicker).
  const EXPLAIN_W = 300;
  const [mounted, setMounted] = useState(false);
  const [explain, setExplain] = useState<{ value: CaptureIntent; left: number; bottom: number } | null>(null);
  useEffect(() => setMounted(true), []);
  const showExplain = (value: CaptureIntent, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setExplain({
      value,
      left: Math.min(Math.max(8, r.left), window.innerWidth - EXPLAIN_W - 8),
      bottom: window.innerHeight - r.top + 8,
    });
  };
  const hideExplain = () => setExplain(null);
  const explainProps = (value: CaptureIntent) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => showExplain(value, e.currentTarget),
    onMouseLeave: hideExplain,
    onFocus: (e: React.FocusEvent<HTMLButtonElement>) => showExplain(value, e.currentTarget),
    onBlur: hideExplain,
  });
  const explained = explain ? INTENT_CHIPS.find((c) => c.value === explain.value) : null;
  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length) onAddFiles(files);
        }}
        className={
          "rounded-xl border bg-inset transition " +
          (dragOver ? "border-accent ring-2 ring-accent" : "border-line focus-within:border-accent focus-within:ring-2 focus-within:ring-accent")
        }
      >
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.items)
              .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
              .map((it) => it.getAsFile())
              .filter((f): f is File => !!f);
            if (files.length) {
              e.preventDefault();
              onAddFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={6}
          placeholder="Descreva a dor, o objetivo — ou cole um print de contexto (Ctrl/⌘+V). Ex.: o usuário não acha o que já curtiu; quero favoritar eventos e um mural de favoritos no perfil."
          className="w-full resize-y bg-transparent px-4 py-3 text-[15px] leading-relaxed text-fg outline-none"
        />
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pb-3">
            {images.map((im) => (
              <div key={im.id} className="group relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={im.dataUrl}
                  alt={im.name}
                  className="h-16 w-16 rounded-md border border-line object-cover"
                />
                <button
                  type="button"
                  onClick={() => onRemoveImage(im.id)}
                  className="absolute -right-1.5 -top-1.5 rounded-full border border-line bg-surface p-0.5 text-fg-subtle shadow transition hover:text-fg"
                  title="Remover imagem"
                  aria-label={`Remover ${im.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {/* ① Chips de intenção — esteiram a classificação do agente (opcional; default Automático). */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-0.5 text-[11px] text-fg-subtle">O que é?</span>
        {INTENT_CHIPS.map((c) => {
          const active = intent === c.value;
          const body = (
            <>
              {c.icon === "spark" ? (
                <Sparkles className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
              ) : (
                <c.icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
              )}
              {c.label}
            </>
          );
          // O chip "Automático" usa borda em degradê (a paleta do spark da marca) para ler como o padrão "mágico".
          if (c.icon === "spark") {
            return (
              <span
                key={c.value}
                className={cn(
                  "rounded-full p-px transition-opacity",
                  "bg-[linear-gradient(120deg,#2f6bff_0%,#8aa0f5_45%,#ecd6c6_100%)]",
                  active ? "opacity-100" : "opacity-80 hover:opacity-100",
                )}
              >
                <button
                  type="button"
                  onClick={() => setIntent(c.value)}
                  aria-pressed={active}
                  {...explainProps(c.value)}
                  className={cn(
                    // interior sempre = bg do modal (sem fill): mantém o anel em degradê limpo, sem o degradê
                    // vazando por trás de um fill translúcido. A seleção é indicada só pela cor do texto.
                    "flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-[11px] font-medium transition hover:bg-surface-hover",
                    active ? "text-accent" : "text-fg",
                  )}
                >
                  {body}
                </button>
              </span>
            );
          }
          return (
            <button
              key={c.value}
              type="button"
              onClick={() => setIntent(c.value)}
              aria-pressed={active}
              {...explainProps(c.value)}
              className={cn(
                "flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition",
                active
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-line text-fg-muted hover:bg-surface-hover hover:text-fg",
              )}
            >
              {body}
            </button>
          );
        })}
      </div>
      {/* Popover explicativo do chip sob hover/foco — portal ancorado ACIMA do chip, não-interativo. */}
      {mounted && explain && explained
        ? createPortal(
            <div
              role="tooltip"
              className="pointer-events-none fixed z-[95] rounded-xl border border-line bg-surface p-3 shadow-2xl"
              style={{ left: explain.left, bottom: explain.bottom, width: EXPLAIN_W }}
            >
              <div className="flex items-center gap-1.5 text-[12px] font-semibold text-fg">
                {explained.icon === "spark" ? (
                  <Sparkles className="h-4 w-4 shrink-0 text-accent" strokeWidth={2} aria-hidden />
                ) : (
                  <explained.icon className="h-4 w-4 shrink-0 text-accent" strokeWidth={2} aria-hidden />
                )}
                {explained.label}
              </div>
              <p className="mt-1.5 text-[12px] leading-snug text-fg-muted">{explained.blurb}</p>
              <p className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Quando usar</p>
              <p className="text-[12px] leading-snug text-fg-muted">{explained.when}</p>
              <p className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Exemplo</p>
              <p className="text-[12px] italic leading-snug text-fg-muted">{explained.example}</p>
            </div>,
            document.body,
          )
        : null}
      <div className="flex items-center justify-between text-[11px] text-fg-subtle">
        <label className="inline-flex cursor-pointer items-center gap-1.5 font-medium text-fg-muted transition hover:text-fg">
          <ImageUp className="h-3.5 w-3.5" />
          Anexar imagem
          <input
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) onAddFiles(files);
              e.currentTarget.value = "";
            }}
          />
        </label>
        <span>⌘/Ctrl + Enter para propor</span>
      </div>
    </div>
  );
}

/** Phase 2/4 — the proposal: summary, the shared <ProposalTree>, and a free-text "ajustar" box.
 *  Reused for the INITIAL proposal review AND the per-idea story review (scopeTitle set). */
function ProposalPreview({
  proposal,
  config,
  cards,
  scopeTitle,
  selected,
  onSelect,
  collapsed,
  onToggleCollapse,
  onSelectAll,
  onSelectNone,
  onRecast,
  recastingId,
  onDisambiguate,
  onReanchor,
  busy,
  onRefine,
}: {
  proposal: Proposal;
  config: BoardConfig;
  cards?: Card[];
  /** when set, we're reviewing stories GENERATED from this idea (shows the link banner). */
  scopeTitle?: string | null;
  selected: Set<string>;
  onSelect: (tempId: string, on: boolean) => void;
  collapsed: Set<string>;
  onToggleCollapse: (tempId: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onRecast: (tempId: string, toType: CardType, toStoryType: StoryType | null) => void;
  recastingId: string | null;
  /** ③ open the HITL disambiguation popover for a low-confidence/ambiguous item, pinned to its row. */
  onDisambiguate: (item: ProposedItem, anchor: HTMLElement) => void;
  onReanchor: (tempId: string, patch: ReanchorPatch) => void;
  busy: boolean;
  onRefine: (feedback: string) => void;
}) {
  const [refineOpen, setRefineOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  // resolve "→ aborda: «…»" chips to titles against the session pool (board + just-created cards).
  const cardsById = new Map<string, Card>();
  for (const c of cards ?? []) cardsById.set(c.id, c);

  return (
    <>
      {scopeTitle && (
        <p className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-[12px] leading-snug text-fg-muted">
          Stories que resolvem a dor: <span className="font-medium text-fg">«{scopeTitle}»</span>
        </p>
      )}
      <p className="text-[13px] leading-snug text-fg-muted">{proposal.summary}</p>

      <ProposalTree
        items={proposal.items}
        selected={selected}
        onSelect={onSelect}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        cards={cardsById}
        config={config}
        onSelectAll={onSelectAll}
        onSelectNone={onSelectNone}
        onRecast={onRecast}
        recastingId={recastingId}
        onDisambiguate={onDisambiguate}
        onReanchor={onReanchor}
      />

      {/* Ajustar — refino em texto livre, com memória dos turnos. */}
      {refineOpen ? (
        <div className="space-y-2 rounded-lg border border-line bg-inset p-3">
          <textarea
            autoFocus
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={2}
            placeholder="O que ajustar? Ex.: junte as duas primeiras; o índice é technical, não story."
            className="w-full resize-y rounded-md border border-line bg-surface px-3 py-2 text-[13px] leading-relaxed text-fg outline-none transition focus:border-accent focus:ring-2 focus:ring-accent"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onRefine(feedback);
                setFeedback("");
                setRefineOpen(false);
              }}
              disabled={busy || !feedback.trim()}
              className="rounded-md bg-fg px-3 py-1.5 text-[12px] font-semibold text-surface transition hover:bg-fg/85 disabled:opacity-50"
            >
              Reanalisar
            </button>
            <button
              type="button"
              onClick={() => {
                setRefineOpen(false);
                setFeedback("");
              }}
              className="rounded-md px-3 py-1.5 text-[12px] font-medium text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setRefineOpen(true)}
          disabled={busy}
          className="text-[12px] font-medium text-fg-muted transition hover:text-fg disabled:opacity-50"
        >
          + Ajustar a proposta
        </button>
      )}
    </>
  );
}

/** Phase 3 — the persistent HUB: ideas (◆) get the inline "Gerar stories" CTA (dual-track loop)
 *  and the "✓ N stories" marker; pipeline cards link to Triagem. Stays open until the human is done. */
function HubPhase({
  opps,
  pipeline,
  pool,
  busy,
  batchBusy,
  generatingId,
  selected,
  sentIds,
  batchNote,
  warnings,
  onGenerate,
  onToggleSelect,
  onOpenCard,
  onOpenIdeas,
}: {
  opps: Card[];
  pipeline: Card[];
  pool: Card[];
  busy: boolean;
  batchBusy: boolean;
  /** the idea id currently generating inline — only ITS button spins. */
  generatingId: string | null;
  selected: Set<string>;
  /** opps já despachadas ao Inbox nesta sessão — selo "enviada" + sem ação de gerar/selecionar. */
  sentIds: Set<string>;
  batchNote: string | null;
  /** 4.1 — placement-degradation warnings from the commit (created without the requested parent/serves). */
  warnings: CaptureWarningView[];
  onGenerate: (idea: Card) => void;
  onToggleSelect: (id: string) => void;
  onOpenCard: (id: string) => void;
  onOpenIdeas: () => void;
}) {
  const selectable = opps.length > 1; // lote só faz sentido com >1 dor
  const selectionActive = selected.size > 0;

  const summary = (() => {
    const parts: string[] = [];
    if (opps.length) parts.push(`${opps.length} ${opps.length === 1 ? "dor mapeada" : "dores mapeadas"}`);
    if (pipeline.length) parts.push(`${pipeline.length} ${pipeline.length === 1 ? "card" : "cards"} na Triagem`);
    return parts.length ? parts.join(" · ") : "Nada criado ainda.";
  })();

  return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 text-[14px] font-medium text-fg">
        <span className="text-emerald-700 dark:text-emerald-400">✓</span>
        {summary}
      </p>

      {batchNote && (
        <p className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-[12px] leading-snug text-fg-muted">
          {batchNote}
        </p>
      )}

      {/* 4.1 — placement warnings: a card was created without the parent/serves the proposal asked for. Amber,
          NON-blocking (the cards exist and the merge train is safe — parent-dropped already system-acks), with
          a link to each created card so the operator can re-place it. */}
      {warnings.length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 dark:border-amber-500/30 dark:bg-amber-500/10">
          <p className="text-[12px] font-medium text-amber-800 dark:text-amber-300">
            {warnings.length === 1 ? "Um aviso na criação:" : "Alguns avisos na criação:"}
          </p>
          <ul className="space-y-1">
            {warnings.map((w, i) => (
              <li key={w.cardId ?? `${w.code}-${i}`} className="flex flex-wrap items-baseline gap-x-1.5 text-[12px] leading-snug text-amber-800/90 dark:text-amber-200/90">
                <span className="font-medium">«{w.title}»</span>
                <span className="text-amber-700/80 dark:text-amber-200/70">— {w.detail}</span>
                {w.cardId && (
                  <button
                    type="button"
                    onClick={() => onOpenCard(w.cardId!)}
                    className="font-medium text-amber-900 underline underline-offset-2 transition hover:opacity-80 dark:text-amber-100"
                  >
                    Ver card ↗
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {opps.map((idea) => (
        <IdeaBlock
          key={idea.id}
          idea={idea}
          pool={pool}
          variant="card"
          selectable={selectable && !sentIds.has(idea.id)}
          selected={selected.has(idea.id)}
          selectionActive={selectionActive}
          onToggleSelect={() => onToggleSelect(idea.id)}
          sent={sentIds.has(idea.id)}
          handlers={{
            "generate-stories": {
              run: () => onGenerate(idea),
              busy: generatingId === idea.id,
              disabled: busy || batchBusy,
            },
          }}
          onOpen={onOpenIdeas}
        />
      ))}

      {pipeline.length > 0 && (
        <div className="space-y-2 rounded-xl border border-line bg-inset p-4">
          <ul className="space-y-1">
            {pipeline.map((c) => (
              <li key={c.id} className="flex items-baseline gap-2 text-[13px] text-fg">
                <span className="text-fg-subtle">•</span>
                <span className="min-w-0 flex-1">{c.title}</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => onOpenCard(pipeline[0].id)}
            className="text-[12px] font-medium text-fg-muted transition hover:text-fg"
          >
            Ver na Triagem ↗
          </button>
        </div>
      )}
    </div>
  );
}

/** ③ The capture's HITL consumer — a popover anchored to an uncertain proposal row. The agent asks the
 *  human (one question at a time) until it can confidently classify the item, then emits a RecastResult
 *  (`{type, storyType?, title?, rationale?}`) which `onResolved` applies back to the ProposedItem. */
function CaptureDisambiguatePopover({
  boardId,
  item,
  summary,
  anchor,
  initialTurns,
  onTurnsChange,
  onClose,
  onResolved,
}: {
  boardId: string;
  item: ProposedItem;
  summary: string;
  anchor: HTMLElement;
  /** transcript persistido deste item — retoma a conversa ao reabrir (não perde rounds). */
  initialTurns: HitlTurn[];
  onTurnsChange: (turns: HitlTurn[]) => void;
  onClose: () => void;
  onResolved: (done: unknown) => void;
}) {
  // The anchor is a real element handed from the click — wrap it in a ref for HitlSurface's positioning.
  const anchorRef = useRef<HTMLElement | null>(anchor);
  anchorRef.current = anchor;
  // Open the conversation exactly once (the agent asks first) — guard against StrictMode double-effect.
  const startedRef = useRef(false);

  const context = [
    `BOARD: ${boardId}`,
    `RESUMO DA CAPTURA: ${summary}`,
    `ITEM INCERTO:`,
    `- título: ${item.title}`,
    `- tipo atual: ${item.type}${item.storyType ? ` (${item.storyType})` : ""}`,
    item.rationale ? `- racional: ${item.rationale}` : null,
    item.body ? `- corpo: ${item.body}` : null,
    item.confidence != null ? `- confiança do agente: ${item.confidence}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const hitl = useHitl({
    purpose: "capture-disambiguation",
    context,
    boardId,
    initialTurns,
    onTurnsChange,
    onResolve: (done) => onResolved(done),
  });

  // Abre a conversa pelo agente uma vez — MAS só se não estiver retomando um transcript persistido
  // (start() já é no-op com turns>0; o ref evita o re-disparo do efeito no StrictMode).
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    hitl.start();
  }, [hitl]);

  return (
    <HitlSurface variant="popover" open onClose={onClose} anchorRef={anchorRef} title="Desambiguar item" width={380}>
      <HitlConversation
        turns={hitl.turns}
        status={hitl.status}
        error={hitl.error}
        responseMode={hitl.responseMode}
        setResponseMode={hitl.setResponseMode}
        onSend={hitl.send}
        onCancel={hitl.cancel}
        done={hitl.done}
        placeholder="Responda — ou escolha acima…"
        className="max-h-[60vh]"
      />
    </HitlSurface>
  );
}
