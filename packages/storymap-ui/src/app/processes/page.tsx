import Link from "next/link";
import { listRunningServices } from "@/lib/vps/processes";
import { AppTopBar } from "@/components/nav/TopBar";
import { ProcessesClient } from "./ProcessesClient";
import { FleetPanel } from "./FleetPanel";
import { HealthPanel } from "./HealthPanel";
import { defaultPreservedBranchesDeps, listPreservedRunBranches } from "@/lib/storymap/runner/preserved-branches";
// WS-6.4 — a frota (uma linha por AGENTE) é a metade que faltava desta página: os runs headless sempre
// tiveram linha; os agentes vivos só existiam na cabeça do Operador.
import { collectFleet } from "@/lib/storymap/runner/fleet-view";
import { defaultFleetDeps } from "@/lib/storymap/runner/fleet-deps";
// A saúde da FERRAMENTA: a página LÊ a última leitura que o tick gravou (health.jsonl) — nunca remede na renderização.
import { readHealthSettings, readLastHealthRecord } from "@/lib/storymap/health/health-deps";
import { healthPanelModel } from "@/lib/storymap/health/health-view";

export const dynamic = "force-dynamic";

// Processos — o painel do que a MÁQUINA está fazendo: os filhos headless (`claude -p`) do
// autorun, a fila de merge, e o que travou de fato.
//
// Veste a MESMA casca do resto do app (AppTopBar) — antes era a única página sem barra de topo — e é
// de lá que passa a vir a cota do Claude: a página mantinha um medidor PRÓPRIO, lendo a estimativa do
// ccusage (85%), enquanto a barra do board, na página ao lado, mostrava a janela REAL da assinatura.
// Dois números para a mesma coisa; agora há um.
//
// Server-renderiza o snapshot inicial + as branches preservadas; a ilha cliente mantém a lista viva
// (SSE para os runs, poll de 8s para os terminais) e liga os controles.
export default async function ProcessesPage() {
  const [services, preserved, fleet, lastHealth] = await Promise.all([
    listRunningServices(),
    listPreservedRunBranches(defaultPreservedBranchesDeps()).catch(() => []),
    collectFleet(defaultFleetDeps()).catch(() => []),
    readLastHealthRecord(),
  ]);
  const health = healthPanelModel(lastHealth ? [lastHealth] : [], readHealthSettings(), Date.now());

  return (
    <>
      <AppTopBar title="Processos" backHref="/" />
      <main className="mx-auto max-w-3xl p-6 sm:p-10">
        <header className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-fg">Processos</h1>
          <p className="mt-0.5 text-sm text-fg-muted">
            O que a máquina está fazendo — runs do pipeline, fila de merge e o que travou.
          </p>
          {/* O par desta página: aqui é o que a MÁQUINA está fazendo; o que espera uma decisão sua mora no Inbox (a
              Esteira, que era o outro par, saiu na fase 3 — o trem está no Kanban). Um link, nunca uma segunda lista. */}
          <Link
            href="/inbox"
            className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-accent-ink transition hover:underline"
          >
            O que precisa de você está no Inbox →
          </Link>
        </header>

        {/* A saúde da ferramenta no topo: é o que diz se o resto desta página (frota, runs, fila) pode ser levado ao pé da
            letra. Lê a última leitura do tick; o bloco avisa quando ela está velha ou quando não há leitura. */}
        <HealthPanel model={health} />

        {/* The fleet renders INSIDE ProcessesClient (between "Rodando" and the archive) so the living agents
            sit near the top, not buried below 100+ archived items. */}
        <ProcessesClient initialServices={services} initialPreserved={preserved} fleet={<FleetPanel initialFleet={fleet} />} />
      </main>
    </>
  );
}
