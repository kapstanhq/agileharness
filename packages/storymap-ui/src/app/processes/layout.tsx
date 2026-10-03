import type { ReactNode } from "react";
import { RunnerStatusProvider } from "@/components/RunnerStatusProvider";
import { ToastProvider } from "@/components/Toast";

// Processos layout — wraps the page + its detail in ONE RunnerStatusProvider (the
// shared SSE connection that drives the live runner snapshot, the VPS health metrics
// and the live-console modal) AND a ToastProvider (so the action buttons can toast
// their Result). Mirrors board/[boardId]/layout.tsx; the providers are client
// components, so this server component just composes them.
export default function ProcessesLayout({ children }: { children: ReactNode }) {
  return (
    <RunnerStatusProvider>
      <ToastProvider>{children}</ToastProvider>
    </RunnerStatusProvider>
  );
}
