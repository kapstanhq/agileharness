"use client";

// AS OPÇÕES de um item — cada uma UM clique (fase 3). Nada de diálogo de confirmação e nada de formulário antes do botão.
// O modelo (lib/storymap/inbox/decision.ts) já entrega a opção pronta para o clique: cada alternativa de uma pergunta é
// uma opção que responde com ela, a sugestão do agente é «Usar a sugestão: …», o pedido de ajuste leva o texto padrão, e
// a que muda produção ou não tem volta diz isso no rótulo. Aqui:
//   • no máximo UM botão cheio — a principal do modelo (primaryOption);
//   • `requires: "answer"` = a resposta com as palavras da pessoa: um campo de uma linha com o botão ao lado (Enter
//     envia) — aberto quando é a única forma de responder, a um toque quando há alternativas;
//   • `requires: "selection"` = a escolha múltipla: as alternativas como chips marcáveis + o botão que envia;
//   • a bloqueada diz o motivo numa linha, com o link que a destrava;
//   • «No computador: como fazer» abre o passo a passo ali mesmo.
// O que cada opção faz, por extenso, fica em «Mais detalhes» (aria-describedby aponta para lá).

import { useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import type { InboxEntry } from "@/lib/storymap/inbox/entries";
import { proposalAcceptLabel, type DecisionOption, type ItemDecision } from "@/lib/storymap/inbox/decision";
import type { InvokePayload } from "@/components/quick-action-run";

type Run = (option: DecisionOption, extra?: InvokePayload) => void;

const BTN =
  "inline-flex min-h-11 max-w-full items-center justify-center rounded-[10px] px-4 py-2 text-left text-[14px] font-semibold leading-snug transition disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1";
/**
 * Os botões CHEIOS: o primário ESCURO da fase 1 (a tinta do texto — o mesmo do Kanban, `kanban-tokens` PRIMARY_BTN, e do
 * envio do compositor) para decidir/publicar, terracota para o que não tem volta. Desabilitado, o cheio vira um botão
 * neutro e apagado — um verde a 45% ainda parecia um botão ativo.
 */
const FILLED_OFF = "disabled:border disabled:border-line disabled:bg-inset disabled:text-fg-subtle disabled:opacity-100 disabled:hover:bg-inset";
const FILLED_DARK = `bg-fg text-surface hover:bg-fg/85 ${FILLED_OFF}`;
const FILLED_RED = `bg-danger text-danger-fg hover:bg-danger/90 ${FILLED_OFF}`;
const OUTLINE = "border border-line bg-surface text-fg hover:bg-surface-hover";
const OUTLINE_RED = "border border-danger/60 bg-surface text-danger hover:bg-danger/10";

export function optionCls(option: DecisionOption, isPrimary: boolean): string {
  if (isPrimary) return option.auditCls === "destructive" || option.tone === "danger" ? FILLED_RED : FILLED_DARK;
  return option.tone === "danger" ? OUTLINE_RED : OUTLINE;
}

// o campo encolhe (min-w-0, sem base larga) e o «Responder» fica AO LADO dele até nos 390px do celular
const INPUT =
  "min-h-11 min-w-0 flex-1 rounded-[10px] border border-line bg-inset px-3 text-[14px] text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none";

export function InboxOptions({
  entry,
  decision,
  primaryId,
  pending,
  howto,
  describedBy,
  text,
  onRun,
  payload,
}: {
  entry: InboxEntry;
  decision: ItemDecision;
  primaryId: string | null;
  pending: string | null;
  /** a opção «como fazer» aberta. */
  howto: string | null;
  /** o prefixo dos ids de «O que cada opção faz» (em «Mais detalhes»). */
  describedBy: string;
  text: (t: string) => string;
  onRun: Run;
  /** o que o corpo do item coletou (a seleção da proposta) — o rótulo do «aceitar» conta o que vai. */
  payload?: InvokePayload;
}) {
  const busy = pending !== null;
  const options = decision.options;
  // a resposta escrita: aberta quando é a única forma de responder; senão, a um toque
  const enabled = options.filter((o) => !o.disabled);
  const onlyAnswer = enabled.length > 0 && enabled.every((o) => o.requires === "answer");
  const [writing, setWriting] = useState<string | null>(onlyAnswer ? (enabled[0]?.id ?? null) : null);
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState<string[]>([]);

  if (options.length === 0) return <p className="text-[13.5px] text-fg-muted">Nada para você fazer aqui agora.</p>;

  const question = entry.item?.kind === "question" ? entry.item : null;
  // a escolha múltipla precisa das alternativas para marcar; sem elas, a opção é um botão como as outras
  const selection = question && question.options.length > 0 ? options.find((o) => o.requires === "selection" && !o.disabled) : undefined;
  const answer = options.find((o) => o.id === writing && o.requires === "answer");
  const buttons = options.filter((o) => o !== answer && o !== selection);
  const blocked = options.filter((o) => o.disabled);
  const shownHowto = options.find((o) => o.id === howto && o.invoke.kind === "howto");
  const describe = (o: DecisionOption) => `${describedBy}-${o.id}`;
  // o «aceitar» da proposta conta o que o clique manda: os itens que ficaram marcados em «Mais detalhes»
  const label = (o: DecisionOption) => (pending === o.id ? "Um instante…" : o.invoke.kind === "accept-proposal" && payload?.items ? proposalAcceptLabel(payload.items) : o.label);

  return (
    <div className="space-y-2">
      {selection && question && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Marque uma ou mais">
            {question.options.map((alt) => {
              const on = picked.includes(alt.id);
              return (
                <button
                  key={alt.id}
                  type="button"
                  aria-pressed={on}
                  disabled={busy}
                  onClick={() => setPicked((cur) => (on ? cur.filter((x) => x !== alt.id) : [...cur, alt.id]))}
                  className={cn(BTN, "rounded-full font-medium", on ? "border border-primary bg-primary/15 text-fg" : OUTLINE)}
                >
                  {alt.label}
                  {alt.recommended && <span className="ml-1 text-[11.5px] font-normal text-fg-subtle">(sugerida)</span>}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            disabled={busy || picked.length === 0}
            aria-describedby={describe(selection)}
            onClick={() => onRun(selection, { selectedOptionIds: picked, answer: "" })}
            className={cn(BTN, optionCls(selection, selection.id === primaryId))}
          >
            {label(selection)}
          </button>
        </div>
      )}

      {answer && (
        <form
          className="flex flex-nowrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) onRun(answer, { answer: draft.trim(), selectedOptionIds: [] });
          }}
        >
          <input
            autoFocus={!onlyAnswer}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="A sua resposta"
            placeholder="A sua resposta"
            disabled={busy}
            className={INPUT}
          />
          <button type="submit" disabled={busy || !draft.trim()} aria-describedby={describe(answer)} className={cn(BTN, "shrink-0", onlyAnswer ? FILLED_DARK : OUTLINE)}>
            {pending === answer.id ? "Um instante…" : "Responder"}
          </button>
        </form>
      )}

      {buttons.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {buttons.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => (o.requires === "answer" ? setWriting(o.id) : onRun(o))}
              disabled={Boolean(o.disabled) || busy || (o.invoke.kind === "accept-proposal" && payload?.items?.length === 0)}
              aria-describedby={describe(o)}
              aria-expanded={o.invoke.kind === "howto" ? howto === o.id : undefined}
              className={cn(BTN, optionCls(o, o.id === primaryId))}
            >
              {label(o)}
            </button>
          ))}
        </div>
      )}

      {blocked.map((o) => (
        <p key={o.id} className="text-[12.5px] leading-snug text-fg-muted" data-option-blocked={o.id}>
          <span className="font-semibold text-fg">«{o.label}» está bloqueada:</span> {text(o.disabled!.reason)}
          {o.disabled!.unblock && (
            <>
              {" "}
              <Link href={o.disabled!.unblock.href} prefetch={false} className="font-semibold text-accent-ink underline underline-offset-2">
                {o.disabled!.unblock.label}
              </Link>
            </>
          )}
        </p>
      ))}

      {shownHowto && shownHowto.invoke.kind === "howto" && (
        <div className="rounded-lg border border-line bg-inset px-3 py-2.5">
          <p className="text-[13px] font-semibold text-fg">{shownHowto.invoke.title}</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-[13px] leading-snug text-fg-muted">
            {shownHowto.invoke.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
