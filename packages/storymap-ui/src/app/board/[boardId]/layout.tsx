import type { ReactNode } from "react";
import { RunnerStatusProvider } from "@/components/RunnerStatusProvider";

// Board layout — wraps EVERY board view (mapa/kanban/priorização/vocabulário/config)
// in ONE RunnerStatusProvider, so the navbar runner menu + the live console work
// across all of them with a SINGLE SSE connection (instead of reconnecting per view).
// ToastProvider stays per-view (only the kanban interactions toast).
export default function BoardLayout({ children }: { children: ReactNode }) {
  return <RunnerStatusProvider>{children}</RunnerStatusProvider>;
}
