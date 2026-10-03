import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { readStyleGuide } from "@/lib/storymap/sidecars";
import { isEmptyStyleGuideDoc, styleGuideToPrompt } from "@/lib/storymap/style-guide";
import { EstiloScreen } from "@/components/EstiloScreen";

export const dynamic = "force-dynamic";

/**
 * Server component (molde `canvas/page.tsx`) — reads the board + the canonical guide, runs every
 * KERNEL function that needs `node:crypto` (style-guide.ts) HERE, server-only, and hands the CLIENT
 * only plain data (booleans/strings). See derive-estilo-state.ts's header note: a "use client"
 * component may never import a RUNTIME value from style-guide.ts (it would drag node:crypto into the
 * browser bundle) — this boundary is where that kernel work happens instead. The guide is a PLAIN
 * source-of-truth document: it is either published, or empty (author it).
 */
export default async function EstiloPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  const [board, boards] = await Promise.all([getBoard(params.boardId), listBoards()]);
  if (!board) notFound();

  const styleGuide = await readStyleGuide(params.boardId);
  const hasPublishedGuide = !!styleGuide && !isEmptyStyleGuideDoc(styleGuide);

  // The "Editar guia" intake (Publicado state) reopens the authoring form PREFILLED with the current
  // guide serialized back to a prompt (styleGuideToPrompt) — computed here (node:crypto-safe) as a
  // plain string so the "use client" view never touches the kernel.
  const prefillPrompt = hasPublishedGuide ? styleGuideToPrompt(styleGuide!) : null;

  return (
    <EstiloScreen
      board={board}
      boards={boards}
      styleGuide={styleGuide}
      hasPublishedGuide={hasPublishedGuide}
      prefillPrompt={prefillPrompt}
    />
  );
}
