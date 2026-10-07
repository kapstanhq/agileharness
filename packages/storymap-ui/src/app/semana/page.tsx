import { AppTopBar } from "@/components/nav/TopBar";
import { RunnerStatusProvider } from "@/components/RunnerStatusProvider";
import { WeeklySummaryView } from "@/components/WeeklySummaryView";
import { collectWeeklySummary, ownerTimeZone } from "@/lib/storymap/weekly-summary-collect";
import { addDays, isMonday, mondayOf } from "@/lib/storymap/weekly-summary";

export const dynamic = "force-dynamic";

// /semana — o RESUMO DA SEMANA, de todos os boards: o que foi ao ar, o que foi
// descartado, os dilemas decididos, o que o sistema decidiu em nome do dono, o custo e o que ainda espera por ele. O
// push de segunda às 9h aponta para `?de=<a segunda da semana que acabou>`; sem `de`, a semana corrente até agora.
export default async function SemanaPage(props: { searchParams: Promise<{ de?: string }> }) {
  const { de } = await props.searchParams;
  const now = Date.now();
  const current = mondayOf(now, ownerTimeZone());
  const monday = isMonday(de) && de <= current ? de : current;
  const summary = await collectWeeklySummary(monday, now);
  return (
    // O anel da cota da barra lê a métrica do SSE vivo: fora do provider ele ficaria no fantasma para sempre.
    <RunnerStatusProvider>
      <AppTopBar title="Resumo da semana" backHref="/" />
      <WeeklySummaryView summary={summary} current={monday === current} previous={addDays(monday, -7)} next={monday < current ? addDays(monday, 7) : null} />
    </RunnerStatusProvider>
  );
}
