"use client";

// DocEditor — public entry point for the BlockNote editing surface. next/dynamic + ssr:false because
// the real implementation (./blocknote/DocEditorImpl.tsx) mounts ProseMirror, which needs a DOM.

import dynamic from "next/dynamic";
import type { DocEditorImplProps } from "./blocknote/DocEditorImpl";

export type DocEditorProps = DocEditorImplProps;

const DocEditorImpl = dynamic(() => import("./blocknote/DocEditorImpl"), {
  ssr: false,
  loading: () => (
    <div className="w-full animate-pulse space-y-2 rounded-lg border border-line bg-surface p-4">
      <div className="h-4 w-1/3 rounded bg-surface-hover/60" />
      <div className="h-3 w-full rounded bg-surface-hover/60" />
      <div className="h-3 w-5/6 rounded bg-surface-hover/60" />
      <div className="h-3 w-2/3 rounded bg-surface-hover/60" />
    </div>
  ),
});

export function DocEditor(props: DocEditorProps) {
  return <DocEditorImpl {...props} />;
}
