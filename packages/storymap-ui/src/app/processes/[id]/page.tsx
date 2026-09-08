import Link from "next/link";
import { BackButton } from "@/components/nav/NavShell";
import { getRunningService } from "@/lib/vps/processes";
import type { RunningService, ServiceKind, ServiceStatus } from "@/lib/vps/types";
import { inboxFocusHref } from "@/lib/storymap/deep-links";
import { ProcessActions } from "../ProcessActions";

export const dynamic = "force-dynamic";

const STATUS_META: Record<ServiceStatus, { label: string; hex: string }> = {
  running: { label: "rodando", hex: "#10b981" },
  interrupted: { label: "interrompido", hex: "#f59e0b" },
  failed: { label: "falhou", hex: "#f43f5e" },
  idle: { label: "ocioso", hex: "#94a3b8" },
  done: { label: "concluído", hex: "#94a3b8" },
};

const KIND_LABEL: Record<ServiceKind, string> = {
  "runner-run": "Run do autorun (headless)",
  "tmux-master": "Sessão master (interativa)",
  "tmux-shell": "Sessão shell (bash)",
  "tmux-card": "Terminal de card (tmux)",
  "tmux-copilot": "Terminal do Jido (tmux)",
  "tmux-adhoc": "Sessão tmux ad-hoc",
  "claude-external": "Processo claude solto (externo)",
  "helper-agent": "Assistente de painel (síncrono)",
};

function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${String(secs % 60).padStart(2, "0")}s`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

/** One labelled field row in the detail card. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="w-32 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{label}</span>
      <span className="min-w-0 flex-1 break-words text-[13px] text-fg">{children}</span>
    </div>
  );
}

export default async function ProcessDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;

  const svc: RunningService | null = await getRunningService(decodeURIComponent(params.id));

  if (!svc) {
    return (
      <main className="mx-auto max-w-3xl p-6 sm:p-10">
        <header className="mb-6">
          <BackButton fallbackHref="/processes" className="text-sm text-fg-muted transition hover:text-fg">
            ← Processos
          </BackButton>
        </header>
        <p className="rounded-md border border-line bg-surface p-6 text-center text-sm text-fg-muted">
          Serviço não encontrado — provavelmente já terminou ou foi encerrado.
        </p>
      </main>
    );
  }

  const meta = STATUS_META[svc.status];

  return (
    <main className="mx-auto max-w-3xl p-6 sm:p-10">
      <header className="mb-6 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <BackButton fallbackHref="/processes" className="text-sm text-fg-muted transition hover:text-fg">
            ← Processos
          </BackButton>
          <h1 className="mt-1 truncate text-xl font-semibold tracking-tight text-fg">{svc.label}</h1>
          <p className="mt-0.5 text-sm text-fg-muted">{KIND_LABEL[svc.kind]}</p>
        </div>
        <span
          className="mt-0.5 inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
          style={{ backgroundColor: `${meta.hex}1a`, color: meta.hex }}
        >
          {meta.label}
        </span>
      </header>

      <div className="rounded-md border border-line bg-surface p-4">
        <div className="divide-y divide-line-muted">
          <Field label="ID">
            <span className="font-mono text-[12px] text-fg-muted">{svc.id}</span>
          </Field>

          {svc.board && svc.cardId && (
            <Field label="Card">
              <Link
                href={inboxFocusHref(svc.board, svc.cardId)}
                className="text-accent hover:underline"
                title="Abrir o card no Inbox"
              >
                {svc.cardTitle ?? svc.cardId}
              </Link>
              <span className="ml-2 font-mono text-[11px] text-fg-subtle">
                {svc.board}/{svc.cardId}
              </span>
            </Field>
          )}

          {svc.trigger && <Field label="Skill">{svc.trigger}</Field>}

          {svc.sessionId && (
            <Field label="Sessão">
              <span className="font-mono text-[12px] text-fg-muted">{svc.sessionId}</span>
            </Field>
          )}

          {svc.tmuxSession && (
            <Field label="Tmux">
              <span className="font-mono text-[12px] text-fg-muted">{svc.tmuxSession}</span>
              {svc.attached != null && (
                <span className="ml-2 text-[11px] text-fg-subtle">
                  {svc.attached ? "(cliente conectado)" : "(sem cliente)"}
                </span>
              )}
            </Field>
          )}

          {svc.startedAt != null && (
            <Field label="Início">
              <span className="tabular-nums">{new Date(svc.startedAt).toLocaleString("pt-BR")}</span>
              {svc.status === "running" && (
                <span className="ml-2 text-fg-subtle">(há {formatElapsed(Date.now() - svc.startedAt)})</span>
              )}
            </Field>
          )}

          {svc.uptimeText && svc.startedAt == null && <Field label="Uptime">{svc.uptimeText}</Field>}

          {svc.pid != null && (
            <Field label="PID">
              <span className="font-mono text-[12px] text-fg-muted">{svc.pid}</span>
            </Field>
          )}

          {svc.outcome && <Field label="Resultado">{svc.outcome}</Field>}

          {svc.costUSD != null && <Field label="Custo">${svc.costUSD.toFixed(3)}</Field>}

          {svc.tokens != null && <Field label="Tokens">{formatTokens(svc.tokens)}</Field>}

          <Field label="Anexável">{svc.attachable ? "sim" : "não"}</Field>

          {svc.detail && <Field label="Detalhe">{svc.detail}</Field>}
        </div>

        <div className="mt-4 border-t border-line pt-4">
          <ProcessActions service={svc} size="md" />
        </div>
      </div>
    </main>
  );
}
