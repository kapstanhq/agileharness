"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, X } from "lucide-react";
import { cn } from "@/lib/cn";

export type ToastKind = "error" | "success" | "warning";
/** Optional inline action — e.g. a "Ver" link that opens the thing the toast announced. */
export type ToastAction = { label: string; onClick: () => void };
type ToastItem = { id: number; kind: ToastKind; message: string; actions: ToastAction[] };

// WS-2 — the 3rd arg accepts 1..N actions (a bare object stays retro-compatible); normalized to an array internally.
// O 4º arg é a janela de vida em ms (default 6s). Existe para o DESFAZER de um move: 6s é curto para
// quem só percebe o arrasto acidental depois de olhar de volta para o board.
const ToastContext = createContext<
  (message: string, kind?: ToastKind, action?: ToastAction | ToastAction[], durationMs?: number) => void
>(() => {});

/** Janela padrão de um aviso. O desfazer usa uma maior (ver UNDO_TOAST_MS). */
const DEFAULT_TOAST_MS = 6000;
/** Janela do toast de DESFAZER — tempo real de perceber o erro e reagir. */
export const UNDO_TOAST_MS = 12000;

/** Lightweight, dependency-free toast stack. A UNICA superfície de aviso transitório do app. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((xs) => xs.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (
      message: string,
      kind: ToastKind = "error",
      action?: ToastAction | ToastAction[],
      durationMs: number = DEFAULT_TOAST_MS,
    ) => {
      const id = ++seq.current;
      const actions = action ? (Array.isArray(action) ? action : [action]) : [];
      setItems((xs) => [...xs, { id, kind, message, actions }]);
      window.setTimeout(() => dismiss(id), durationMs);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[360px] max-w-[92vw] flex-col gap-2">
        {items.map((t) => (
          <ToastCard
            key={t.id}
            kind={t.kind}
            message={t.message}
            actions={t.actions}
            onDismiss={() => dismiss(t.id)}
            className="pointer-events-auto"
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * O CARTÃO de aviso — a peça reutilizável. Todo aviso transitório do app (a pilha do
 * ToastProvider e os avisos ANCORADOS, como a confirmação de ativação no header do Jido)
 * renderiza ESTE componente; nada de remontar a caixinha na mão em cada tela.
 *
 * Identidade (globals.css): a superfície é a MESMA de um card — `bg-surface` OPACO sobre
 * `border-line`, tinta `text-fg`. Um aviso flutua por cima de conteúdo vivo, então superfície
 * translúcida (o antigo `bg-emerald-500/10`) deixava o texto ilegível — e a paleta emerald/red
 * crua não é a nossa. A COR fica só onde carrega significado: o filete lateral e o ícone —
 * `primary` (verde do "done") no sucesso, `accent` (âmbar, a mnemônica) no alerta e `danger`
 * no erro. Hierarquia por peso/espaço, não por bloco colorido.
 */
export function ToastCard({
  kind,
  message,
  actions = [],
  onDismiss,
  className,
}: {
  kind: ToastKind;
  message: React.ReactNode;
  actions?: ToastAction[];
  onDismiss: () => void;
  className?: string;
}) {
  const { Icon, rail, ink } = KIND_STYLE[kind];
  return (
    <div
      role="status"
      className={cn(
        "relative flex items-start gap-2.5 overflow-hidden rounded-lg border border-line bg-surface py-2.5 pl-3.5 pr-2.5 text-[13px] text-fg shadow-lg",
        className,
      )}
    >
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", rail)} />
      <Icon className={cn("mt-px h-4 w-4 shrink-0", ink)} />
      <span className="flex-1 leading-snug">{message}</span>
      {actions.map((a, i) => (
        <button
          key={i}
          type="button"
          onClick={() => {
            a.onClick();
            onDismiss();
          }}
          className="-my-0.5 shrink-0 rounded-md border border-line px-2 py-1 text-[12px] font-medium text-fg transition hover:bg-surface-hover"
        >
          {a.label}
        </button>
      ))}
      <button
        type="button"
        onClick={onDismiss}
        className="-my-0.5 -mr-1 shrink-0 rounded-md p-1 text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
        aria-label="Fechar aviso"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

const KIND_STYLE: Record<ToastKind, { Icon: typeof CheckCircle2; rail: string; ink: string }> = {
  success: { Icon: CheckCircle2, rail: "bg-primary", ink: "text-primary" },
  warning: { Icon: AlertTriangle, rail: "bg-accent", ink: "text-accent" },
  error: { Icon: AlertCircle, rail: "bg-danger", ink: "text-danger" },
};

/** Returns `toast(message, kind?)`. Safe outside a provider (no-op). */
export function useToast() {
  return useContext(ToastContext);
}
