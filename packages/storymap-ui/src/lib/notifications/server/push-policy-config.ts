// A política de push EM VIGOR — a lista de `settings.yaml` (`notifications.push.critical`) sobre o padrão da
// push-policy. Módulo à parte para a régua pura não arrastar o carregador de settings (node:fs) para o cliente, e
// para os testes dos produtores trocarem a política sem montar um settings.yaml.
//
// Lida A CADA fato (o loadRunnerConfig é memoizado por mtime): mudar a lista no arquivo vale no próximo aviso,
// sem restart. Nunca lança — um settings ilegível cai no padrão, que é o crítico e nada mais.

import { DEFAULT_PUSH_POLICY, pushPolicyFrom, type PushPolicy } from "../push-policy";
import { loadRunnerConfig } from "@/lib/storymap/runner/config";

export function currentPushPolicy(): PushPolicy {
  try {
    return pushPolicyFrom(loadRunnerConfig().notifications?.push.critical);
  } catch {
    return DEFAULT_PUSH_POLICY;
  }
}
