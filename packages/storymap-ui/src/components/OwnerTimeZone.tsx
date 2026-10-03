"use client";

// O fuso do dono para a TELA (lib/storymap/owner-timezone.ts): o layout raiz o resolve no servidor e o passa aqui, e
// toda hora do Inbox — a linha, a folha, a página do item, os recibos, o «Resolvido hoje», as datas de «parado» — é
// formatada com ele. O mesmo nome de fuso no SSR e na hidratação ⇒ o mesmo texto; nunca o fuso do navegador.

import { createContext, useContext } from "react";

const OwnerTimeZoneContext = createContext<string | undefined>(undefined);

export function OwnerTimeZoneProvider({ timeZone, children }: { timeZone: string; children: React.ReactNode }) {
  return <OwnerTimeZoneContext.Provider value={timeZone}>{children}</OwnerTimeZoneContext.Provider>;
}

/** O fuso do dono (undefined só fora do layout — um teste isolado). */
export function useOwnerTimeZone(): string | undefined {
  return useContext(OwnerTimeZoneContext);
}
