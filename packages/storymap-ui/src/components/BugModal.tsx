"use client";

import { useState } from "react";
import { AlertTriangle, Bug, Check, ImagePlus, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { reportBugAction } from "@/app/actions";
import { BUG_SEVERITIES } from "@/lib/storymap/frameworks";
import type { BugSeverity } from "@/lib/storymap/frameworks";
import type { ReopenDestination } from "@/lib/storymap/reopen";
import type { Card, StatusDef } from "@/lib/storymap/types";

/**
 * Onde uma reabertura de bug cai (R1). Daqui saem só o `id` e a DICA — o RÓTULO vem do BOARD.
 *
 * Antes os rótulos eram escritos à mão e NENHUM era `name` de step: "Em desenvolvimento" (o step chama-se
 * "Desenvolver"), "Design" (é o nome da COLUNA `prepare`; o step é "Jornada") e "Discovery" (é a COLUNA
 * "Descoberta"; o step é "Especificar"). O operador clicava em "Discovery" e o card caía em "Especificar" —
 * três nomes para o mesmo lugar, nenhum deles o prometido.
 */
const REOPEN_DESTINATIONS: { id: ReopenDestination; hint: string }[] = [
  { id: "desenvolver", hint: "Corrigir direto no código — harness-fix roda no Dev" },
  { id: "design-ux", hint: "Regressão visual — repensar a UX/UI" },
  { id: "enriquecer", hint: "Repensar o problema/escopo antes" },
];

const inputCls =
  "w-full rounded-lg border border-line bg-inset px-3 py-2 text-[15px] text-fg outline-none transition focus:border-red-400 dark:focus:border-red-500 focus:ring-2 focus:ring-red-100 dark:focus:ring-red-500/30";

/**
 * "Reportar bug" — reopen a delivered (or in-QA) story because it REGRESSED. The
 * sibling of RefineModal for the FIX flow. Captures the free-text report, the
 * severity, expected×actual behaviour, reproduction steps, an optional target route
 * and an optional broken-state screenshot, then calls `reportBugAction` to stamp
 * `mode: fix` + the bug report and route the card into the `corrigir` column (where
 * `harness-fix` diagnoses, reproduces with a failing test, and routes onward).
 */
export function BugModal({
  boardId,
  card,
  statuses,
  onCancel,
  onDone,
}: {
  boardId: string;
  card: Card;
  /** Os steps do board — a FONTE do rótulo de cada destino de reabertura (nunca escreva o nome à mão). */
  statuses?: readonly StatusDef[];
  onCancel: () => void;
  onDone: (card: Card) => void;
}) {
  const destinations = REOPEN_DESTINATIONS.map((d) => ({
    ...d,
    label: statuses?.find((s) => s.id === d.id)?.name ?? d.id,
  }));
  const [brief, setBrief] = useState("");
  const [severity, setSeverity] = useState<BugSeverity>("medium");
  const [destination, setDestination] = useState<ReopenDestination>("desenvolver");
  const [expected, setExpected] = useState("");
  const [actual, setActual] = useState("");
  const [stepsText, setStepsText] = useState("");
  const [target, setTarget] = useState("");
  const [screenshot, setScreenshot] = useState<string | null>(null); // data URL
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = (file?: File | null) => {
    if (!file) {
      setScreenshot(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setScreenshot(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
  };

  const submit = async () => {
    const b = brief.trim();
    if (!b) {
      setError("Escreva o relato do bug — o que está quebrado e o contexto.");
      return;
    }
    setSaving(true);
    setError(null);
    const steps = stepsText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const res = await reportBugAction({
      boardId,
      cardId: card.id,
      brief: b,
      severity,
      destination,
      expected: expected.trim() || null,
      actual: actual.trim() || null,
      steps,
      target: target.trim() || null,
      screenshotDataUrl: screenshot,
    });
    setSaving(false);
    if (res.ok) {
      // reportBugAction always returns the written card on success; this fallback is
      // defensive only and MIRRORS what the server persisted (today's openedAt; the
      // screenshot lives in the sidecar) so the optimistic card can't contradict disk.
      onDone(
        res.data?.card ?? {
          ...card,
          mode: "fix",
          status: destination,
          refinement: null,
          bugReport: {
            brief: b,
            severity,
            expected: expected.trim() || null,
            actual: actual.trim() || null,
            steps,
            target: target.trim() || null,
            screenshot: card.bugReport?.screenshot ?? null,
            openedAt: new Date().toISOString().slice(0, 10),
          },
        },
      );
    } else {
      setError(res.error);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-red-50 dark:bg-red-500/10 px-2 py-1 text-xs font-bold uppercase tracking-wide text-red-600 dark:text-red-300">
              <Bug className="h-3.5 w-3.5" /> Reportar bug
            </span>
            <span className="truncate text-sm font-medium text-fg-muted">{card.title}</span>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-fg-subtle transition hover:bg-surface-hover hover:text-fg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="board-scroll flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <div className="flex items-start gap-2 rounded-lg border border-red-100 dark:border-red-500/30 bg-red-50/60 dark:bg-red-500/10 px-3 py-2.5 text-[12px] leading-snug text-red-900 dark:text-red-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500 dark:text-red-400" />
            <span>
              Reabre esta story <strong>já entregue</strong> porque algo <strong>quebrou</strong>. O agente
              diagnostica o código real, escreve um <strong>teste que reproduz</strong> o bug e corrige in-place — sem
              recriar do zero. Regressão visual vira novas opções no Design.
            </span>
          </div>

          <div>
            <Label>Relato (o que está quebrado e o contexto)</Label>
            <textarea
              autoFocus
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={4}
              placeholder="Ex.: ao abrir um evento no mobile a imagem some e o preço aparece como “R$ NaN”. Começou ontem, em qualquer evento de cinema."
              className={cn(inputCls, "resize-y leading-relaxed")}
            />
          </div>

          <div>
            <Label>Severidade</Label>
            <div className="flex flex-wrap gap-1.5">
              {BUG_SEVERITIES.map((s) => {
                const active = severity === s.id;
                // medium (#c4a261) e low (#8f99a8) são fills claros — texto branco falha
                // contraste neles, então o label ativo vai escuro; blocker/high ficam brancos.
                const lightFill = s.id === "medium" || s.id === "low";
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSeverity(s.id)}
                    title={s.short}
                    style={active ? { backgroundColor: s.color } : undefined}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold transition",
                      active
                        ? lightFill
                          ? "text-black"
                          : "text-white"
                        : "bg-surface-hover text-fg-muted hover:bg-surface-hover hover:text-fg",
                    )}
                  >
                    {active && <Check className="h-3 w-3" />}
                    {s.name}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] leading-snug text-fg-muted">
              {BUG_SEVERITIES.find((s) => s.id === severity)?.short}
            </p>
          </div>

          <div>
            <Label>Voltar para</Label>
            <div className="flex flex-wrap gap-1.5">
              {destinations.map((d) => {
                const active = destination === d.id;
                return (
                  <button
                    key={d.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setDestination(d.id)}
                    title={d.hint}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold transition",
                      active
                        ? "bg-red-600 text-white"
                        : "bg-surface-hover text-fg-muted hover:text-fg",
                    )}
                  >
                    {active && <Check className="h-3 w-3" />}
                    {d.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] leading-snug text-fg-muted">
              A coluna onde o card reentra — o agente de correção roda lá e segue o fluxo.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label>Esperado — opcional</Label>
              <textarea
                value={expected}
                onChange={(e) => setExpected(e.target.value)}
                rows={2}
                placeholder="o que DEVERIA acontecer"
                className={cn(inputCls, "resize-y leading-relaxed")}
              />
            </div>
            <div>
              <Label>Atual — opcional</Label>
              <textarea
                value={actual}
                onChange={(e) => setActual(e.target.value)}
                rows={2}
                placeholder="o que acontece hoje"
                className={cn(inputCls, "resize-y leading-relaxed")}
              />
            </div>
          </div>

          <div>
            <Label>Passos para reproduzir — opcional (um por linha)</Label>
            <textarea
              value={stepsText}
              onChange={(e) => setStepsText(e.target.value)}
              rows={3}
              placeholder={"1. abrir /eventos\n2. tocar num card de cinema\n3. observar a imagem sumir"}
              className={cn(inputCls, "resize-y leading-relaxed")}
            />
          </div>

          <div>
            <Label>Alvo (rota/tela) — opcional</Label>
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="ex.: /eventos/[id] ou “card de evento na home”"
              className={inputCls}
            />
          </div>

          <div>
            <Label>Screenshot do bug — opcional</Label>
            {screenshot ? (
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={screenshot}
                  alt="estado quebrado"
                  className="h-16 w-16 rounded-md border border-line object-cover"
                />
                <button
                  type="button"
                  onClick={() => setScreenshot(null)}
                  className="text-xs font-medium text-fg-muted underline hover:text-red-600"
                >
                  remover
                </button>
              </div>
            ) : (
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-sm text-fg-muted transition hover:border-line-emphasis hover:bg-surface-hover">
                <ImagePlus className="h-4 w-4" />
                Anexar imagem
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => onFile(e.target.files?.[0])}
                />
              </label>
            )}
          </div>
        </div>

        {error && (
          <div className="mx-6 mb-1 flex items-start gap-2 rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex-1 leading-snug">{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-line px-6 py-4">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm font-medium text-fg-muted transition hover:bg-surface-hover"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || !brief.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-red-500 disabled:opacity-50"
          >
            <Bug className="h-4 w-4" />
            {saving ? "Enviando…" : "Enviar para correção"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-muted">{children}</div>
  );
}
