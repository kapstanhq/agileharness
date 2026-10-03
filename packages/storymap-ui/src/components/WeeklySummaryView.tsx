"use client";
// O resumo da semana (/semana) — de todos os boards, em português simples, para quem não acompanha o dia a dia.
// Só leitura, cada linha leva ao card (ou ao Inbox, para o que espera o dono). CLIENT component, como as outras
// views com `PageHeader`: o ícone (`icon={CalendarDays}`) é uma FUNÇÃO, e um server component não pode passá-la a
// um client component — em produção (v0.9.8) a página respondia 500 («Functions cannot be passed directly to Client
// Components»). O `summary` que chega do page.tsx é JSON puro, então atravessa a fronteira sem custo.

import { CalendarDays } from "lucide-react";
import { PageHeader } from "@/components/nav/PageTabs";
import { cardHref, inboxHref } from "@/lib/storymap/deep-links";
import { costImpactFigures } from "@/lib/storymap/cost-impact";
import { formatImpactMoney, projectedMonthlyText, weeklySummaryHref, type WeeklyItem, type WeeklySummary } from "@/lib/storymap/weekly-summary";

const fmtDay = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
};
const fmtWhen = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" });
// O dinheiro do PRODUTO sai na moeda do próprio impacto (formatImpactMoney: um card cujo dado se declara na moeda antiga segue nela mesmo que
// o alvo mude de moeda). O US$ abaixo é outra coisa: a moeda do FORNECEDOR de IA (o Claude informa em dólar), fato dele, não do alvo.
const usd = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "USD" });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function WeeklySummaryView({ summary, current, previous, next }: { summary: WeeklySummary; current: boolean; previous: string; next: string | null }) {
  const { week, live, discarded, dilemmas, systemDecisions, cost, waiting } = summary;
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
      <PageHeader
        title="Resumo da semana"
        icon={CalendarDays}
        description={`${fmtDay(week.from)} a ${fmtDay(week.to)}${current ? " — a semana corrente, até agora" : ""}. Todos os boards.`}
      />
      <nav className="mb-5 flex justify-between text-[13px]">
        <a href={weeklySummaryHref(previous)} className="text-accent hover:underline">
          ← Semana anterior
        </a>
        {next && (
          <a href={weeklySummaryHref(next)} className="text-accent hover:underline">
            Semana seguinte →
          </a>
        )}
      </nav>

      <Section title="Esperando você" count={waiting.length} empty="Nenhuma decisão sua esperando.">
        {waiting.map((w) => (
          <Row key={`${w.boardId}/${w.cardId}/${w.kind}/${w.what}`} href={w.cardId ? cardHref(w.boardId, w.cardId) : inboxHref(w.boardId)}>
            <span className="text-fg">{w.what}</span>
            <Meta>
              {w.boardName}
              {w.ownerClass ? ` · ${w.ownerClass}` : ""}
              {w.days != null ? ` · esperando há ${plural(w.days, "dia", "dias")}` : ""}
            </Meta>
          </Row>
        ))}
      </Section>

      <Section title="No ar" count={live.length} empty="Nada foi ao ar nesta semana.">
        {live.map((i) => (
          <ItemRow key={`${i.boardId}/${i.cardId}`} item={i} />
        ))}
      </Section>

      <Section title="Descartado" count={discarded.length} empty="Nada foi descartado.">
        {discarded.map((i) => (
          <ItemRow key={`${i.boardId}/${i.cardId}`} item={i} />
        ))}
      </Section>

      <Section title="Dilemas decididos" count={dilemmas.length} empty="Nenhum dilema decidido.">
        {dilemmas.map((d) => (
          <Row key={d.id} href={d.cardId ? cardHref(d.board, d.cardId) : null}>
            <span className="text-fg">{d.what}</span>
            {d.why && <Meta>Por quê: {d.why}</Meta>}
            <Meta>{d.boardName}</Meta>
          </Row>
        ))}
      </Section>

      <Section title="O que o sistema decidiu por você" count={systemDecisions.total} empty="Nenhuma decisão do sistema nesta semana.">
        {systemDecisions.byKind.map((k) => (
          <li key={k.kind} className="flex justify-between gap-3 px-4 py-2 text-[14px]">
            <span className="text-fg">{k.label}</span>
            <span className="tabular-nums text-fg-muted">{k.count}</span>
          </li>
        ))}
      </Section>
      {systemDecisions.total > 0 && (
        <p className="-mt-3 mb-6 text-[12.5px] text-fg-subtle">O porquê de cada uma, e o «Desfazer», estão em «Acompanhar», no Inbox de cada board.</p>
      )}

      {summary.rollout && (
        <section className="mb-6">
          <h2 className="mb-2 text-[13px] font-medium uppercase tracking-wide text-fg-subtle">Só-negócio em outros boards</h2>
          <p className="rounded-lg border border-line bg-surface px-4 py-3 text-[14px] text-fg">
            {summary.rollout.line}.
            <span className="text-fg-muted"> Ligar outro board continua sendo decisão sua.</span>
          </p>
        </section>
      )}

      {summary.health && (
        <section className="mb-6">
          <h2 className="mb-2 text-[13px] font-medium uppercase tracking-wide text-fg-subtle">Saúde da ferramenta</h2>
          <div className="space-y-1 rounded-lg border border-line bg-surface px-4 py-3 text-[14px]">
            <p className="text-fg">
              {summary.health.trend ? `Na semana — ${summary.health.trend}.` : "Só uma leitura nesta semana, ainda sem tendência."}
            </p>
            <p className="text-[12.5px] text-fg-muted">
              Última leitura: {summary.health.now} ({plural(summary.health.readings, "leitura", "leituras")} na semana). É trabalho do sistema: nada aqui pede você.
            </p>
          </div>
        </section>
      )}

      <section className="mb-6">
        <h2 className="mb-2 text-[13px] font-medium uppercase tracking-wide text-fg-subtle">Custo da semana</h2>
        <div className="space-y-1.5 rounded-lg border border-line bg-surface px-4 py-3 text-[14px]">
          <p className="text-fg">
            Automação: ≈ {usd(cost.automationUSD)} em {plural(cost.runs, "execução", "execuções")}
            <span className="text-fg-muted"> — a estimativa que o Claude informa por execução; pela assinatura, só vira cobrança com o uso extra ligado.</span>
          </p>
          <p className="text-fg">
            O que foi ao ar projeta {projectedMonthlyText(cost.projectedMonthly)}
            {cost.projections.length ? "" : <span className="text-fg-muted"> (nenhuma entrega da semana trouxe projeção de custo)</span>}.
          </p>
          {cost.projections.map((p) => (
            <p key={`${p.boardId}/${p.cardId}`} className="text-[12.5px] text-fg-muted">
              {p.title}: +{formatImpactMoney(costImpactFigures(p.impact).amount, costImpactFigures(p.impact).currency)}/mês ({p.impact.scope === "cash" ? "caixa" : "infraestrutura"}) — {p.impact.assumptions}
            </p>
          ))}
        </div>
      </section>
    </main>
  );
}

function Section({ title, count, empty, children }: { title: string; count: number; empty: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-[13px] font-medium uppercase tracking-wide text-fg-subtle">
        {title} <span className="tabular-nums">({count})</span>
      </h2>
      {count === 0 ? (
        <p className="rounded-lg border border-dashed border-line bg-surface px-4 py-3 text-[13px] text-fg-subtle">{empty}</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">{children}</ul>
      )}
    </section>
  );
}

function Row({ href, children }: { href: string | null; children: React.ReactNode }) {
  const body = <div className="flex flex-col gap-0.5 px-4 py-2.5 text-[14px]">{children}</div>;
  return <li>{href ? <a href={href} className="block hover:bg-inset">{body}</a> : body}</li>;
}

function Meta({ children }: { children: React.ReactNode }) {
  return <span className="text-[12.5px] text-fg-muted">{children}</span>;
}

function ItemRow({ item }: { item: WeeklyItem }) {
  return (
    <Row href={cardHref(item.boardId, item.cardId)}>
      <span className="text-fg">{item.title}</span>
      <Meta>
        {item.boardName} · {fmtWhen(item.at)}
      </Meta>
    </Row>
  );
}
