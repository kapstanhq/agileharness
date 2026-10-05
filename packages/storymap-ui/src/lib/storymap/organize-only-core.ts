// O núcleo PURO do board «só organização» (isomórfico — o portão e as palavras do selo o usam no cliente). O lado com
// disco (`organizeOnlyNow`) mora em organize-only.ts. Ver o cabeçalho de lá para o contrato.

import type { BoardConfig } from "./types";

/** A frase única (log, motivo de espera, recusa, selo). */
export const ORGANIZE_ONLY_WHY = "board só de organização — nada roda sozinho";

/** O board é só de organização? PURA. */
export function isOrganizeOnly(config: Pick<BoardConfig, "organizeOnly"> | null | undefined): boolean {
  return config?.organizeOnly === true;
}
