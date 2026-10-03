"use client";

// ⚙ Sistema · Orquestração — a bancada onde o operador vê e edita o "cérebro" do pipeline: os prompts
// que cada agente lê antes de agir.
//
// Ela era UMA rolagem de quatro assuntos empilhados: as ~14 skills do pipeline, depois Rotas &
// Especialistas (três tabelas), depois os ~9 assistentes de view, depois o raio-x do contexto. Quem
// entrava para ajustar um assistente rolava por catorze cartões de skill primeiro, e nada na tela
// dizia que ainda havia coisa embaixo. Agora são três SEÇÕES no nível 3 (`nav/PageTabs`), cada uma
// endereçável por `?tab=`:
//
//   • Skills do pipeline    → o prompt de cada step com automação (+ o raio-x do que alimenta um run,
//                             que só faz sentido ao lado das skills: é o resto do contexto delas);
//   • Assistentes de view   → os prompts-system dos agentes que ajudam a editar as telas;
//   • Rotas & Especialistas → a leitura read-only de perfis de rota e revisores por coluna.
//
// Cada skill/assistente carrega o seu markdown SOB DEMANDA na primeira expansão (readSkillAction /
// readAssistantPromptAction) e salva direto (writeSkillAction) ou via agente (requestAssistedEditAction).
// Steps sem trigger (só forwarding / landings) NÃO têm SKILL.md — viram uma nota curta.

import { useState } from "react";
import { Bot, ChevronDown, ChevronRight, Loader2, Route, Workflow } from "lucide-react";
import { BoardHeader } from "@/components/BoardHeader";
import { AssistedEditor } from "@/components/AssistedEditor";
import { PageHeader, PageTabs, usePageTab, type PageTab } from "@/components/nav/PageTabs";
import {
  readSkillAction,
  writeSkillAction,
  readAssistantPromptAction,
  writeAssistantPromptAction,
  requestAssistedEditAction,
} from "@/app/assisted-edit-actions";
import { VIEW_ASSISTANTS, type ViewAssistant } from "@/lib/storymap/assistant-registry";
import { RoutesSpecialistsTab } from "@/components/RoutesSpecialistsTab";
import type { AssistedEditMode } from "@/lib/storymap/assisted-edit";
import type { ConfigCockpitData } from "@/lib/storymap/config-cockpit";
import type { BoardConfig, BoardSummary } from "@/lib/storymap/types";

type OrchestrationStep = {
  id: string;
  name: string;
  trigger: string | null;
  autorun: boolean;
  model: string | null;
  effort: string | null;
  maxTurns: number | null;
};

// O board chega inteiro (server → client), mas a view só toca em board.config.
type BoardLike = { config: BoardConfig };

// Agrupamento por trigger único: dois steps podem compartilhar a MESMA skill — mostramos a skill
// uma vez só, mas guardamos quais steps a usam (e a primeira política observada, p/ os metadados).
type SkillGroup = {
  trigger: string;
  steps: OrchestrationStep[];
};

type OrqTab = "skills" | "assistentes" | "rotas";

const TABS: readonly PageTab<OrqTab>[] = [
  { id: "skills", label: "Skills do pipeline", icon: Workflow, hint: "O prompt de cada step com automação" },
  { id: "assistentes", label: "Assistentes de view", icon: Bot, hint: "Os agentes que ajudam a editar cada tela" },
  { id: "rotas", label: "Rotas & Especialistas", icon: Route, hint: "Perfis de rota e revisores por coluna" },
];

export function OrquestracaoView({
  board,
  boards,
  steps,
  cockpit,
}: {
  board: BoardLike;
  boards: BoardSummary[];
  steps: OrchestrationStep[];
  cockpit: ConfigCockpitData;
}) {
  const [tab, setTab] = usePageTab(TABS);

  // Steps COM skill → agrupados por trigger único (preservando a ordem do pipeline).
  const skillGroups: SkillGroup[] = [];
  const byTrigger = new Map<string, SkillGroup>();
  for (const s of steps) {
    if (!s.trigger) continue;
    let group = byTrigger.get(s.trigger);
    if (!group) {
      group = { trigger: s.trigger, steps: [] };
      byTrigger.set(s.trigger, group);
      skillGroups.push(group);
    }
    group.steps.push(s);
  }

  // Steps SEM skill (só autorun = pontes / forwarding) — sem SKILL.md.
  const forwardingSteps = steps.filter((s) => !s.trigger);

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <BoardHeader boards={boards} config={board.config} view="orquestracao" subnav />
      {/* SISTEMA_MAX_W — a MESMA largura das irmãs (ver `nav/PageTabs`). */}
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">
        <PageHeader
          title="Orquestração"
          icon={Workflow}
          description="Os prompts que governam o sistema autônomo — o que cada agente lê antes de agir. Edite direto ou peça a outro agente."
          tabs={<PageTabs label="Seções de Orquestração" tabs={TABS} value={tab} onChange={setTab} />}
        />

        {tab === "skills" && (
          <section className="space-y-3">
            <SectionIntro>
              Uma skill por step com automação: o prompt que ela executa e o modelo/effort/turns com que
              o runner a chama. {skillGroups.length} skill(s) neste board.
            </SectionIntro>
            {skillGroups.length === 0 && forwardingSteps.length === 0 ? (
              <EmptyState>Este board não tem steps com automação configurada.</EmptyState>
            ) : (
              <>
                {skillGroups.map((group) => (
                  <SkillCard key={group.trigger} group={group} />
                ))}
                {forwardingSteps.length > 0 && (
                  <p className="pt-1 text-[12px] leading-relaxed text-fg-subtle">
                    <span className="font-medium text-fg-muted">Steps sem skill (só forwarding):</span>{" "}
                    {forwardingSteps.map((s) => s.name).join(", ")}.
                  </p>
                )}
                <RunContextXray config={board.config} />
              </>
            )}
          </section>
        )}

        {tab === "assistentes" && (
          <section className="space-y-3">
            <SectionIntro>
              Os prompts-system dos agentes que ajudam a editar cada view (Posicionamento, Resultado-alvo,
              Lean Canvas, Ideias, Skills). Edite a persona/instruções do agente direto ou peça a outro agente.
            </SectionIntro>
            {VIEW_ASSISTANTS.map((a) => (
              <AssistantCard key={a.id} assistant={a} />
            ))}
          </section>
        )}

        {tab === "rotas" && (
          <section className="space-y-3">
            <SectionIntro>
              Quais perfis de rota existem (o que cada um pula / o teto de modelo) e quais especialistas
              revisam cada coluna. Leitura read-only — a edição é no{" "}
              <code className="rounded bg-surface-hover px-1 py-0.5 font-mono text-[11px]">board.yaml</code>.
            </SectionIntro>
            <RoutesSpecialistsTab data={cockpit} />
          </section>
        )}
      </main>
    </div>
  );
}

/** A linha que abre uma seção: o que ela guarda, em uma frase. Mesma voz nas três. */
function SectionIntro({ children }: { children: React.ReactNode }) {
  return <p className="max-w-prose text-[12.5px] leading-snug text-fg-muted">{children}</p>;
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-surface px-4 py-12 text-center text-sm text-fg-subtle">
      {children}
    </div>
  );
}

// Raio-x do contexto — o que TODO run neste board recebe antes da skill, derivado do board.yaml
// (buildContextNote injeta o CLAUDE.md do pacote + o brandbook; o worktree auto-carrega o CLAUDE.md
// raiz). Transparência pura: nenhum dado novo, só expõe o que o engine já monta. Mora na aba das
// SKILLS porque é o resto do contexto delas — sozinho, no fim da página, não se sabia a que se referia.
function RunContextXray({ config }: { config: BoardConfig }) {
  const feeds: { label: string; value: string }[] = [
    { label: "Raiz", value: "CLAUDE.md (raiz do monorepo, auto-carregado no worktree)" },
  ];
  if (config.package) feeds.push({ label: "App", value: `${config.package}/.claude/CLAUDE.md` });
  if (config.brandbook) feeds.push({ label: "Marca", value: config.brandbook });
  feeds.push({ label: "Skill", value: "o SKILL.md do step (acima) + o card alvo" });

  return (
    <div className="mt-4 rounded-lg border border-line bg-surface p-4">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
        O que alimenta cada run
      </p>
      <ul className="space-y-1.5">
        {feeds.map((f) => (
          <li key={f.label} className="flex items-start gap-2 text-[12px]">
            <span className="w-12 shrink-0 font-medium text-fg-muted">{f.label}</span>
            <span className="min-w-0 flex-1 font-mono text-[11px] leading-snug text-fg">{f.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Um dado da política do run (modelo/effort/turns) — em chip, não em frase corrida: eram quatro
 *  valores num parágrafo cinza de 11px, ilegíveis de relance justamente quando se comparam skills. */
function PolicyChip({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-inset px-1.5 py-0.5 text-[10.5px] text-fg-subtle">
      {label}
      <span className="font-medium text-fg-muted">{value}</span>
    </span>
  );
}

const EXPAND_BTN =
  "inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2.5 py-1 text-[11px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg";

function SkillCard({ group }: { group: SkillGroup }) {
  const trigger = group.trigger;
  // A política (modelo/effort/turns/autorun) é a do PRIMEIRO step que usa a skill.
  const lead = group.steps[0];
  const stepNames = group.steps.map((s) => s.name).join(" · ");

  const [expanded, setExpanded] = useState(false);
  // Conteúdo do SKILL.md, carregado sob demanda na primeira expansão.
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadSkill = async () => {
    if (content !== null || loading) return;
    setLoading(true);
    setLoadError(null);
    const res = await readSkillAction({ skill: trigger });
    setLoading(false);
    if (res.ok) {
      setContent(res.data?.content ?? "");
    } else {
      setLoadError(res.error || "Falha ao carregar a skill.");
    }
  };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) void loadSkill();
  };

  const label = `${trigger} / SKILL.md`;

  const onSave = async (next: string) => {
    const res = await writeSkillAction({ skill: trigger, content: next });
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  };

  const onAskAgent = async (instruction: string, current: string, mode: AssistedEditMode) => {
    const res = await requestAssistedEditAction({
      kind: "skill",
      mode,
      label,
      current,
      instruction,
    });
    return res.ok
      ? { ok: true, proposal: res.data?.proposal }
      : { ok: false, error: res.error };
  };

  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-fg">{stepNames}</span>
            <span className="rounded bg-inset px-1.5 py-0.5 font-mono text-[11px] text-fg-muted">
              {trigger}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <PolicyChip label="modelo" value={lead.model ?? "—"} />
            <PolicyChip label="effort" value={lead.effort ?? "—"} />
            <PolicyChip label="turns" value={lead.maxTurns ?? "—"} />
            {lead.autorun && (
              <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10.5px] font-medium text-emerald-700 dark:text-emerald-300">
                autorun
              </span>
            )}
          </div>
        </div>
        <button type="button" onClick={toggle} className={EXPAND_BTN}>
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Ver/editar prompt
        </button>
      </div>

      {expanded && (
        <div className="border-t border-line px-4 py-3">
          {loading ? (
            <LoadingRow>Carregando SKILL.md…</LoadingRow>
          ) : loadError ? (
            <ErrorRow message={loadError} onRetry={() => void loadSkill()} />
          ) : content !== null ? (
            <AssistedEditor
              label={label}
              value={content}
              multiline
              mono
              rows={18}
              agentModes={["editar", "aprender"]}
              onSave={onSave}
              onAskAgent={onAskAgent}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

// ── Assistentes de view — os PROMPTS-SYSTEM dos agentes de enriquecimento/edição das views ─────────
// (Posicionamento, Resultado-alvo, Lean Canvas, Ideias, editor de Skills). Cada um é editável: default
// no registry, override por arquivo (file-backed).
function AssistantCard({ assistant }: { assistant: ViewAssistant }) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [isDefault, setIsDefault] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = async () => {
    if (content !== null || loading) return;
    setLoading(true);
    setLoadError(null);
    const res = await readAssistantPromptAction({ id: assistant.id });
    setLoading(false);
    if (res.ok) {
      setContent(res.data?.content ?? "");
      setIsDefault(res.data?.isDefault ?? true);
    } else {
      setLoadError(res.error || "Falha ao carregar o prompt.");
    }
  };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) void load();
  };

  const label = `${assistant.label} · prompt-system`;
  const onSave = async (next: string) => {
    const res = await writeAssistantPromptAction({ id: assistant.id, content: next });
    if (res.ok) setIsDefault(false);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  };
  // Meta-assistente: ajuda a editar o PRÓPRIO prompt (editar/aprender — sincronizar não cabe num prompt).
  const onAskAgent = async (instruction: string, current: string, mode: AssistedEditMode) => {
    const res = await requestAssistedEditAction({
      kind: "generic",
      mode,
      label,
      current,
      instruction,
      context: `Você está ajudando a editar o PROMPT-SYSTEM do "${assistant.label}" — o agente que ${assistant.summary} Mantenha o prompt claro, específico para a tarefa, em PT-BR.`,
    });
    return res.ok ? { ok: true, proposal: res.data?.proposal } : { ok: false, error: res.error };
  };

  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-inset px-1.5 py-0.5 text-[10px] font-medium text-fg-muted">{assistant.viewLabel}</span>
            <span className="font-medium text-fg">{assistant.label}</span>
            <span className={cnBadge(isDefault)}>{isDefault ? "padrão" : "personalizado"}</span>
          </div>
          <p className="mt-1 text-[11px] text-fg-subtle">{assistant.summary}</p>
        </div>
        <button type="button" onClick={toggle} className={EXPAND_BTN}>
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Ver/editar prompt
        </button>
      </div>

      {expanded && (
        <div className="border-t border-line px-4 py-3">
          {loading ? (
            <LoadingRow>Carregando prompt…</LoadingRow>
          ) : loadError ? (
            <ErrorRow message={loadError} onRetry={() => void load()} />
          ) : content !== null ? (
            <AssistedEditor
              label={label}
              value={content}
              multiline
              mono
              rows={12}
              agentModes={["editar", "aprender"]}
              onSave={onSave}
              onAskAgent={onAskAgent}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Carregando / falhou — os dois cartões expansíveis diziam a mesma coisa com o mesmo desenho em
 *  dois lugares; agora é um par de peças, e uma mudança de voz vale para os dois. */
function LoadingRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-6 text-[12px] text-fg-subtle">
      <Loader2 className="h-4 w-4 animate-spin" />
      {children}
    </div>
  );
}

function ErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="space-y-2 py-2 text-[12px] text-danger">
      <p>{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border border-line px-2.5 py-1 font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
      >
        Tentar de novo
      </button>
    </div>
  );
}

function cnBadge(isDefault: boolean): string {
  return isDefault
    ? "rounded px-1.5 py-0.5 text-[10px] font-medium text-fg-subtle border border-line"
    : "rounded px-1.5 py-0.5 text-[10px] font-medium text-accent border border-accent/40";
}
