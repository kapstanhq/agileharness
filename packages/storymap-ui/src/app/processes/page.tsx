import Link from "next/link";
import { Rocket } from "lucide-react";
import { listRunningServices } from "@/lib/vps/processes";
import { AppTopBar } from "@/components/nav/TopBar";
import { ProcessesClient } from "./ProcessesClient";
import { FleetPanel } from "./FleetPanel";
import { defaultPreservedBranchesDeps, listPreservedRunBranches } from "@/lib/storymap/runner/preserved-branches";
// WS-6.4 — a frota (uma linha por AGENTE) é a metade que faltava desta página: os runs headless sempre
// tiveram linha; os agentes vivos só existiam na cabeça do Operador.
import { collectFleet } from "@/lib/storymap/runner/fleet-view";
import { defaultFleetDeps } from "@/lib/storymap/runner/fleet-deps";

export const dynamic = "force-dynamic";

// Processos (ADR-058) — o painel do que a MÁQUINA está fazendo: os filhos headless (`claude -p`) do
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
  const [services, preserved, fleet] = await Promise.all([
    listRunningServices(),
    listPreservedRunBranches(defaultPreservedBranchesDeps()).catch(() => []),
    collectFleet(defaultFleetDeps()).catch(() => []),
  ]);

  return (
    <>
      <AppTopBar title="Processos" backHref="/" />
      <main className="mx-auto max-w-3xl p-6 sm:p-10">
        <header className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-fg">Processos</h1>
          <p className="mt-0.5 text-sm text-fg-muted">
            O que a máquina está fazendo — runs do pipeline, fila de merge e o que travou.
          </p>
          {/* O par desta página: aqui é o que FALHOU (e precisa de você); lá é o FLUXO (onde está cada
              trabalho, do worktree até o ar). Um link, nunca uma segunda lista do mesmo estado. */}
          <Link
            href="/entrega"
            className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-accent transition hover:underline"
          >
            <Rocket className="h-3.5 w-3.5" />
            Abrir a Esteira — do worktree até produção →
          </Link>
        </header>

        {/* The fleet renders INSIDE ProcessesClient (between "Rodando" and the archive) so the living agents
            sit near the top, not buried below 100+ archived items. */}
        <ProcessesClient initialServices={services} initialPreserved={preserved} fleet={<FleetPanel initialFleet={fleet} />} />
      </main>
    </>
  );
}
