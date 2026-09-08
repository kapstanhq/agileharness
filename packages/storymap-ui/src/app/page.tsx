import { redirect } from "next/navigation";
import { listBoards } from "@/lib/storymap/repo";
import { AgileHarnessLogo } from "@/components/AgileHarnessLogo";

export const dynamic = "force-dynamic";

export default async function Home() {
  const boards = await listBoards();
  // The front door is the "Início Agêntico" home of the first board (o que pede você + terminais +
  // kanban), not the raw map — the map stays reachable as a board view.
  if (boards.length > 0) redirect(`/board/${boards[0].id}/inicio`);

  return (
    <main className="mx-auto max-w-2xl p-12">
      <h1 className="text-fg">
        <AgileHarnessLogo size={24} />
      </h1>
      <p className="mt-3 text-fg-muted">
        Nenhum board encontrado em <code className="font-mono text-fg">storymap/boards/</code>.
      </p>
      <p className="mt-2 text-sm text-fg-muted">
        Crie <code className="font-mono">storymap/boards/&lt;app&gt;/board.yaml</code> e uma pasta{" "}
        <code className="font-mono">cards/</code> para começar.
      </p>
    </main>
  );
}
