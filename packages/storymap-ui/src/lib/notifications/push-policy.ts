// PUSH SÓ PARA O CRÍTICO — a política única do que sai da máquina para o celular do dono (web-push) e para o Slack.
// PURA e isomórfica (zero IO): os produtores do servidor a consultam, e o painel de notificações pode citá-la.
//
// A decisão do dono (plano v3, 2026-09-25): "O dono abre o Inbox quando quiser (~1h/dia), com push só para o
// crítico: produção fora do ar, fonte de eventos parada há mais de 24h, fornecedor sem crédito, trava de cota."
// Antes disto, cada produtor decidia sozinho se empurrava — e empurravam quase tudo: toda pergunta nova, todo card
// que andava uma coluna, todo run que falhava, todo terminal parado; e o Slack recebia CADA escrita de card. O
// celular virou um segundo Inbox, que é exatamente o que o dono não quer carregar no bolso.
//
// O CONTRATO:
//   • cada FATO que poderia interromper tem um nome aqui ({@link PushEventKind}), e um produtor real;
//   • a tabela {@link PUSH_EVENT_DEFAULTS} decide, para CADA um, se ele empurra por padrão — exaustiva por tipo:
//     um fato novo é erro de compilação até alguém decidir se ele merece o bolso do dono;
//   • o dono pode trocar a lista em `settings.yaml` → `notifications.push.critical` (a lista dos que empurram);
//   • o que não empurra NÃO se perde: vai para o Inbox (ou para a tela aberta, pela régua do modo do Jido —
//     copilot/alert-policy) — push é interrupção, não entrega;
//   • push e Slack são a MESMA régua: o Slack é outro jeito de o celular vibrar (só o opt-in pessoal abaixo fica
//     fora do Slack — ele é de quem o armou, não do canal).
//
// A única exceção, e não é do sistema: o sininho que o OPERADOR arma numa página de terminal ("me avise quando
// esta sessão ficar quieta", por sessão, com prazo). O produtor só emite `terminal-quiet` quando alguém PEDIU
// aquilo agora — é um pedido dele, não um aviso que a máquina escolheu dar ({@link OPERATOR_OPT_IN_PUSH}).

/** Todo fato que poderia chegar ao celular/Slack. Cada um tem UM produtor (o comentário diz qual). */
export type PushEventKind =
  /** a trava do GOVERNADOR engatou: a frota inteira parou ("trava de cota"). runner/capacity-notify. */
  | "capacity-latch"
  /** o uso extra (PAGO) foi ligado na conta. runner/capacity-notify. */
  | "capacity-extra-usage"
  /** um trabalho automático está retido pelo governador há mais de 24h. runner/capacity-notify. */
  | "capacity-held-24h"
  /** o MEDIDOR de cota parou: a leitura de uso envelheceu depois de já ter sido vista, e o governador retém a frota
   *  inteira sem que ninguém veja. runner/capacity-notify (borda do governador, uma vez por episódio). */
  | "capacity-meter-stale"
  /** um deploy de produção FALHOU e o card foi revertido: o trabalho aprovado NÃO está no ar. runner/deploy-revert. */
  | "deploy-rollback"
  /** a publicação foi recusada ANTES de rodar (promoção stage→main falhou, preflight de frescor): nada tocou a
   *  produção. runner/deploy-revert. */
  | "deploy-blocked"
  /** um card nasceu com um prefixo de título que o BOARD declarou crítico (board.yaml
   *  `notifications.criticalTitlePrefixes` — ex.: o monitor de fonte parada, o de fornecedor sem crédito).
   *  notifications/server/channels/critical-signal-channel. */
  | "critical-signal"
  /** um card ganhou uma demanda humana pendente (pergunta, bloqueio, triagem, gate). web-push-channel. */
  | "card-demand"
  /** um card entrou numa parada manual (o pipeline espera alguém). web-push-channel. */
  | "card-needs-you"
  /** um card andou uma coluna. web-push-channel. */
  | "card-moved"
  /** um run headless falhou. web-push-channel (a ponte do registry). */
  | "run-failed"
  /** um pedido de publicação passou de lento a BLOQUEADO. instrumentation (o dreno da fila). */
  | "publish-blocked"
  /** um terminal está parado num prompt esperando alguém. lib/terminal/attention-watch. */
  | "terminal-waiting"
  /** um terminal cujo sininho o operador armou ficou quieto. lib/terminal/attention-watch. */
  | "terminal-quiet";

/**
 * O padrão, fato a fato — exaustivo por construção (`Record<PushEventKind, …>`). `true` = empurra.
 * Só o que o dono chamou de crítico: a frota parada pela cota (ou pelo medidor dela, parado), a produção que não
 * recebeu o que devia (deploy revertido) e os sinais que o próprio board declara críticos (fonte de eventos
 * parada, fornecedor sem crédito, produção fora do ar vista por um monitor do produto). Todo o resto espera o dono
 * no Inbox.
 */
export const PUSH_EVENT_DEFAULTS: Record<PushEventKind, boolean> = {
  "capacity-latch": true,
  // é TAMBÉM a trava: quando o uso extra (pago) liga, o governador engata a trava e reporta a borda com ESTE nome
  // ("Uso extra PAGO ligado — frota travada"). E, sem trava nova, é a conta passando a gastar dinheiro — decisão
  // que só o dono toma. Uma vez por transição (o governador dedupa na borda).
  "capacity-extra-usage": true,
  // é o governador funcionando (retém o que não cabe na janela); aparece no painel de capacidade.
  "capacity-held-24h": false,
  // é a frota PARADA por um defeito que não se resolve sozinho (sem tráfego, o token do medidor não renova) — o
  // mesmo efeito da trava, sem a trava para avisar. Crítico.
  "capacity-meter-stale": true,
  "deploy-rollback": true,
  // nada foi ao ar e nada saiu do ar: o card espera em "Liberar" com o motivo, no Inbox (lane travado).
  "deploy-blocked": false,
  "critical-signal": true,
  "card-demand": false,
  "card-needs-you": false,
  "card-moved": false,
  "run-failed": false,
  "publish-blocked": false,
  "terminal-waiting": false,
  // não é o sistema que decide: ver OPERATOR_OPT_IN_PUSH.
  "terminal-quiet": false,
};

/** Todo fato que existe — derivado da tabela, para nenhuma lista paralela envelhecer sozinha. */
export const PUSH_EVENT_KINDS = Object.keys(PUSH_EVENT_DEFAULTS) as PushEventKind[];

/** A lista padrão dos que empurram (o que `notifications.push.critical` substitui quando declarado). */
export const DEFAULT_CRITICAL_PUSH: readonly PushEventKind[] = PUSH_EVENT_KINDS.filter((k) => PUSH_EVENT_DEFAULTS[k]);

/**
 * Fatos que só EXISTEM porque o operador pediu, por fonte e com prazo (o sininho da página do terminal). Eles
 * empurram qualquer que seja a lista: a política governa o que a máquina escolhe interromper, não um pedido
 * explícito de quem está olhando aquela sessão agora. Desligar = não armar o sininho.
 */
export const OPERATOR_OPT_IN_PUSH: ReadonlySet<PushEventKind> = new Set<PushEventKind>(["terminal-quiet"]);

export function isPushEventKind(v: unknown): v is PushEventKind {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(PUSH_EVENT_DEFAULTS, v);
}

/** A política em vigor: o conjunto de fatos que empurram. */
export interface PushPolicy {
  critical: ReadonlySet<PushEventKind>;
}

export const DEFAULT_PUSH_POLICY: PushPolicy = { critical: new Set(DEFAULT_CRITICAL_PUSH) };

/** A política a partir da lista declarada (settings.yaml) — ausente ⇒ o padrão. Uma lista VAZIA é uma escolha
 *  (nada empurra além do opt-in do operador), não ausência. PURA. */
export function pushPolicyFrom(critical: readonly PushEventKind[] | null | undefined): PushPolicy {
  return critical ? { critical: new Set(critical) } : DEFAULT_PUSH_POLICY;
}

/** Este fato vai ao CELULAR (web-push)? PURA — a única régua; todo produtor passa por aqui. */
export function shouldPush(kind: PushEventKind, policy: PushPolicy = DEFAULT_PUSH_POLICY): boolean {
  return policy.critical.has(kind) || OPERATOR_OPT_IN_PUSH.has(kind);
}

/**
 * Este fato vai ao SLACK? A mesma lista do push, sem o opt-in pessoal: o sininho de um terminal é um pedido de
 * quem o armou (chega no aparelho dele), não um aviso para o canal do time. PURA.
 */
export function shouldSlack(kind: PushEventKind, policy: PushPolicy = DEFAULT_PUSH_POLICY): boolean {
  return policy.critical.has(kind);
}

/**
 * `settings.yaml` `notifications:` → `{ push: { critical } }`, ou undefined quando nada foi declarado. Tolerante
 * no formato, estrito no valor: um nome desconhecido é DESCARTADO com aviso (um typo não pode ligar nem desligar
 * nada em silêncio — e o que sobra da lista continua valendo). Sem `critical` como lista ⇒ undefined (o padrão).
 */
export function coerceNotificationSettings(
  raw: unknown,
  warn: (msg: string) => void = (m) => console.warn(`[notifications] ${m}`),
): { push: { critical: PushEventKind[] } } | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const push = (raw as Record<string, unknown>).push;
  if (!push || typeof push !== "object" || Array.isArray(push)) return undefined;
  const list = (push as Record<string, unknown>).critical;
  if (!Array.isArray(list)) return undefined;
  const critical: PushEventKind[] = [];
  for (const item of list) {
    if (isPushEventKind(item)) {
      if (!critical.includes(item)) critical.push(item);
    } else {
      warn(`notifications.push.critical: '${String(item)}' não é um fato conhecido — ignorado (conhecidos: ${PUSH_EVENT_KINDS.join(", ")})`);
    }
  }
  return { push: { critical } };
}

/**
 * Um título de card é um SINAL CRÍTICO do board? `prefixes` = board.yaml `notifications.criticalTitlePrefixes`.
 * Casa pelo INÍCIO do título (espaços à esquerda ignorados), sensível a maiúsculas — o prefixo é um contrato entre
 * o monitor que cria o card e o board, não texto livre. Sem prefixos declarados ⇒ nunca. PURA.
 */
export function criticalSignalPrefix(title: string | null | undefined, prefixes: readonly string[] | null | undefined): string | null {
  if (!title || !prefixes?.length) return null;
  const t = title.trimStart();
  return prefixes.find((p) => p.length > 0 && t.startsWith(p)) ?? null;
}
