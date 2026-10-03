// O FUSO DO DONO — a hora que o Inbox, os recibos, o «Resolvido hoje», o push e o resumo da semana mostram. É o do
// ritmo diário do governador (`governor.timezone` no settings.yaml — já validado na coerção); sem ele, o do host.
//
// Por que não o fuso do navegador nem o do processo: o serviço roda numa VPS em outro fuso (num caso real, com o
// servidor adiantado várias horas em relação ao dono, uma execução que morreu à noite dele aparecia como madrugada), e o celular do dono pode
// estar em qualquer fuso. A hora de uma decisão é a do DONO, e é a mesma no servidor (SSR) e no navegador (hidratação):
// o servidor resolve o nome do fuso UMA vez e a tela formata com ele (components/OwnerTimeZone.tsx).

import { loadRunnerConfig } from "./runner/config";
import { isValidTimeZone } from "./runner/capacity-governor";

/** O fuso configurado do dono (`governor.timezone`), ou undefined quando não há um. */
export function ownerTimeZone(): string | undefined {
  try {
    return loadRunnerConfig().governor?.timezone || undefined;
  } catch {
    return undefined;
  }
}

/** O fuso do host, pelo nome IANA (nunca vazio). */
export function hostTimeZone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz && isValidTimeZone(tz) ? tz : "UTC";
}

/** O fuso que a tela usa: o do dono, ou o do host — SEMPRE um nome concreto, para servidor e navegador concordarem. */
export function resolvedOwnerTimeZone(): string {
  const tz = ownerTimeZone();
  return tz && isValidTimeZone(tz) ? tz : hostTimeZone();
}
