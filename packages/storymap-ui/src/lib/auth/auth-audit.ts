// TRAVA E RASTRO EM TODA FALHA DE AUTENTICAÇÃO DO PERÍMETRO (story-m9jflb + story-et6a4j).
//
// O estado antes daqui, reproduzido ao vivo: 6 GETs a `/api/runner/pulse` com `secret` errado →
// `401,401,401,401,401,401`, sem 429 e sem lockout; `journalctl -u storymap` no mesmo minuto →
// `-- No entries --`. Seis superfícies com o mesmo defeito (a rota MCP e as 4 do runner recusam
// "with nothing logged" — o comentário da própria rota admite —, e o `rate-limit.ts` prometia uma
// negação "visível" que não emitia linha nenhuma).
//
// O ENQUADRAMENTO HONESTO: o dano não é "chuta e ganha autonomia". O token vivo tem 256 bits e
// força bruta é inviável. O dano é que uma invasão EM CURSO é 100% invisível — sem fonte de log não
// existe detecção de brute-force/password-spray, e combinado com o token exposto por 54 dias
// (story-u4yf1i) a pergunta "alguém usou essa credencial na janela?" hoje não tem resposta. Este
// módulo cria a fonte.
//
// ── O QUE CADA CONTROLE IMPEDE ────────────────────────────────────────────────────────────────
//
//  • TRAVA por origem: impede que uma origem tente indefinidamente contra a superfície que spawna
//    `claude --dangerously-skip-permissions`. UM balde por origem para o perímetro INTEIRO — não um
//    por rota: seis baldes deixariam o atacante rotacionar de superfície e multiplicar o orçamento
//    por seis. O backoff é PROGRESSIVO (cada bloqueio consecutivo dobra, até um teto), porque quem
//    volta a martelar depois de trancado não está errando a senha.
//  • ORDEM — A CREDENCIAL É COMPARADA PRIMEIRO (`guardPerimeter`): impede que o próprio controle de
//    segurança vire a ARMA. A ordem anterior era trava → compara, então a recusa acontecia sem nunca
//    olhar a credencial. Como o balde é um por ORIGEM e há três instalações em que o atacante e o
//    dono dividem a MESMA chave — self-host sem proxy (todos caem em `sem-proxy`), NAT compartilhado
//    (escritório, celular), CDN na frente do Caddy (o último salto passa a ser o proxy) —, bastava um
//    anônimo martelar uma superfície de máquina para o dono levar 404/429 no `/login` com o token
//    CERTO na mão: qualquer pessoa na internet desligava o painel por até 60 minutos, de graça. Hoje
//    a comparação vem ANTES da trava: credencial VÁLIDA sempre passa e ZERA o balde da origem; só
//    tentativa INVÁLIDA conta e é recusada. Custo: uma comparação em tempo constante por tentativa
//    (`isOperatorTokenValid` / `resolveActor`) paga inclusive por origem já trancada — é barato, e é
//    o preço de não existir um interruptor de negação de serviço contra o dono. De brinde acabou um
//    oráculo de TEMPO: a recusa instantânea do pre-check anunciava "você está trancado".
//    O QUE ISSO NÃO É: a barreira contra ADIVINHAÇÃO. Um chute CERTO durante o bloqueio entra, por
//    desenho. A barreira ali é o segredo de 32 bytes (256 bits — força bruta inviável, é o que o
//    card mede); a trava encarece, nega SERVIÇO a quem martela e produz o rastro. Trocar isso por
//    "nem o dono entra" seria comprar zero segurança pagando com o desfecho proibido.
//  • FALHA DO COMPARADOR CONTA COMO FALHA (`guardPerimeter`): impede que exista um canal de sondagem
//    INVISÍVEL e de graça. A exceção de `validate()` ESCAPAVA do portão: a tentativa não era contada na
//    trava, não gerava linha no rastro, e a resposta deixava de ser a mudez para virar o que a rota
//    fizesse do throw. Logo, qualquer classe de entrada que quebrasse o comparador (corpo malformado,
//    registro de handle ilegível, segredo com forma inesperada) rendia tentativas ILIMITADAS e
//    invisíveis — e um oráculo de brinde, porque "entrada que quebra o validador" respondia diferente de
//    "chute errado". Hoje lançar é RECUSAR (fail-closed: um comparador que não conseguiu comparar nunca
//    autentica), a tentativa CONTA e o rastro nomeia o motivo. Sem custo para o dono: a comparação segue
//    vindo PRIMEIRO, então credencial válida atravessa mesmo com a origem trancada por exceções.
//  • O MOTIVO DA EXCEÇÃO É A CLASSE, NUNCA A MENSAGEM: impede que o rastro seja o vazamento que o resto
//    do módulo evita. Uma mensagem de `JSON.parse`/Zod EMBUTE a entrada que a quebrou — gravá-la
//    escreveria o valor tentado num arquivo cuja postura inteira é "do valor só sai o comprimento". Daí
//    `sanitizeErrorKind`, que lê apenas `name`/`code` (e só na FORMA de identificador) e nunca
//    stringifica o valor lançado — um `throw <segredo>` não vira linha de log.
//  • SUPERFÍCIE CANÔNICA (`canonicalSurface`): impede que o `bySurface` do forense seja escrito pelo
//    CLIENTE. O resumo agrega por superfície, e o que vem abaixo dela é texto de quem chamou: com um
//    path livre, mil tentativas em `/ttyd/a1`, `/ttyd/a2`… viravam mil chaves e o resumo ficava
//    ilegível justamente na hora de lê-lo. A redação por FORMA não cobria isso (ela só apaga segmento
//    LONGO, então um segredo CURTO no path — token fraco configurado à mão, chute do atacante — ia
//    inteiro para o arquivo). Agora todo path colapsa na superfície DECLARADA que o contém (a mais
//    específica ganha, casando por segmento) e só o que não é declarado segue no caminho da redação.
//    Aplicado no chokepoint, não pedido ao chamador — pela mesma razão da redação.
//  • ATOMICIDADE da decisão: impede que o orçamento da janela seja "quantos requests o atacante tem
//    EM VOO". Decidir e incrementar acontecem no MESMO passo síncrono (`recordAuthFailure`), depois
//    do `await` da comparação. Uma checagem que só LÊ não decide nada: medido, 64 tentativas sob um
//    teto de 8 rendiam 56 aceitas — porque a lista de falhas é zerada no lockout e a 9ª voltava a
//    dizer "pode tentar". Hoje `recordAuthFailure` respeita o bloqueio vigente e recusa.
//  • TETO DE ORIGENS QUE NÃO SOLTA TRAVA: impede que encher o mapa seja o botão de destravar. O teto
//    antigo LIMPAVA o mapa inteiro, e limpar o mapa solta todo bloqueio vivo — quem controla o XFF
//    escolhia a hora de zerar a própria punição. Hoje o descarte é por POLÍTICA (ocioso primeiro; se
//    tudo estiver trancado, o de expiração mais PRÓXIMA), então a trava mais longa é a última a cair.
//  • RASTRO DURÁVEL: impede que a invasão seja irreconstruível. Memória in-process morre no restart
//    — e o restart é justamente o que um invasor causa, ou o que o operador faz ao investigar —,
//    então o rastro vai para JSONL append-only no estado do runner. A TRAVA, ao contrário, é
//    in-process de propósito (ela só encarece; perdê-la no restart não abre porta nenhuma).
//  • MODO 0600 DO RASTRO: impede que o forense seja legível por qualquer conta local do host. O
//    arquivo nomeia origens, superfícies e magnitude de uma invasão EM CURSO — entregá-lo a um
//    usuário local é contar ao atacante quanto do rastro dele já apareceu. `mode` no `appendFile` só
//    vale na CRIAÇÃO, então um arquivo herdado (edição manual, backup, versão anterior do serviço)
//    ficaria 0644 para sempre; daí o `chmod` explícito, a mesma postura de `mcp-handle.ts`.
//  • REDAÇÃO DA SUPERFÍCIE: impede que o NOSSO ledger repita o defeito do log do Caddy. Hoje a URL
//    É a credencial; um chamador que passe `req.url` gravaria o token no arquivo forense. A
//    redação é aplicada AQUI, não pedida ao chamador — controle que depende de disciplina alheia
//    não é controle.
//  • TETO DE BYTES: impede que o rastro seja o vetor de enchimento de disco. Um atacante trancado
//    que gerasse uma linha por tentativa escreveria à vontade no nosso disco; daí o
//    estrangulamento logarítmico (`noteBlockedAttempt`) e a rotação em `AUTH_LEDGER_MAX_BYTES`.
//  • TETO GLOBAL DE LINHAS QUE O ATACANTE NÃO ESCOLHE (`publicarLinha`): impede que o estrangulamento
//    do rastro seja contornado TROCANDO DE CHAVE. O estrangulamento acima é por chave de trava, e a
//    chave é o último salto do `x-forwarded-for` — que na topologia citada como motivação (self-host
//    exposto DIRETO, sem proxy reescrevendo o header) é escolhida pelo CLIENTE. Bastava um XFF novo por
//    tentativa: balde novo, orçamento de escrita novo, uma linha por tentativa. Duas consequências, e
//    nenhuma delas era o disco cheio (a rotação já limita o arquivo a 2 gerações): a I/O amplificada da
//    fila serial de escrita, e — pior — a EVICÇÃO da prova, porque quem escreve à vontade rotaciona o
//    forense e empurra a invasão real para fora do arquivo. O teto agora é por PROCESSO e por janela: o
//    atacante pode trocar de chave à vontade, o orçamento de linhas é o mesmo. O que ele NÃO consegue
//    com isso é ficar invisível — a magnitude do que foi suprimido é publicada em potências de 10, e a
//    trava, os strikes e os contadores seguem contando TUDO (o teto é do RASTRO, nunca da DECISÃO).
//
// ── O SINAL DE ORIGEM QUE ESCOLHEMOS, E O QUE ELE **NÃO** PROTEGE ─────────────────────────────
//
// A chave é `clientKey(headers)` de `lib/auth/rate-limit.ts` — o ÚLTIMO salto do `x-forwarded-for`.
// Não é uma segunda régua: é a MESMA que o portão de login usa, e o raciocínio (medido contra o
// Caddy desta instalação: XFF forjado é SUBSTITUÍDO pelo peer real; `x-real-ip` forjado passa
// intacto e por isso foi eliminado) está documentado lá. O que ela NÃO protege:
//
//   1. Um atacante com MUITAS origens (botnet, saída rotativa): cada IP ganha um balde novo. A
//      trava encarece por origem, não globalmente — ver o item 3.
//   2. O app exposto DIRETO, sem proxy: aí o cliente controla o XFF por completo e pode trocar de
//      chave a cada chute. Nesta instalação o Caddy está na frente e substitui o header, que é o
//      que torna o último salto confiável AQUI; num self-host sem proxy a trava degrada para
//      "encarece um pouco" e a defesa real segue sendo o segredo de 32 bytes.
//   3. Nada disso detém uma credencial VÁLIDA que vazou — a trava conta FALHAS. Contra vazamento a
//      resposta é a revogação (`mcp-handle.ts`), não o limitador.
//
// E o que foi DELIBERADAMENTE REJEITADO: um teto GLOBAL (somando todas as origens). Ele fecharia o
// buraco do item 1, mas entregaria ao atacante um interruptor para DESLIGAR o conector do operador
// — uma negação de serviço contra o próprio agente. Remoção de capacidade é o desfecho proibido
// deste trabalho, então o global aqui só CONTA (`perimeterScanCounters`), nunca bloqueia.
//
// CUSTO DE AUTONOMIA: ZERO. Uma credencial válida atravessa exatamente como hoje.

import { promises as fsp } from "node:fs";
import path from "node:path";

import {
  checkAttempt,
  clientKey,
  pruneAttempts,
  recordFailure,
  recordSuccess,
  type AttemptRecord,
  type RateLimitPolicy,
} from "@/lib/auth/rate-limit";
import { MIN_TOKEN_LEN, maskSecret } from "@/lib/storymap/mcp/auth";
import { runnerStateDir } from "@/lib/storymap/paths";
import { appendAgentAction } from "@/lib/storymap/runner/agent-actions";
import type { McpLevel, RiskClass } from "@/lib/storymap/types";

/** Por que a credencial foi recusada. Vocabulário ÚNICO do perímetro — `mcp-handle.ts` importa daqui. */
export const AUTH_FAILURE_REASONS = [
  /** nenhuma credencial apresentada (query/header ausente, path vazio). */
  "ausente",
  /** apresentou algo que não casa com nada vivo. */
  "desconhecida",
  /** casou com um handle que o operador REVOGOU — sinal de vazamento em uso, não de erro de digitação. */
  "handle-revogado",
  /** o segredo CONFIGURADO não passa os pisos de `secretWeakness` ⇒ a porta está fechada por setup. */
  "token-fraco",
  /** a origem já estava trancada; nem chegamos a comparar. */
  "trancado",
  /**
   * o comparador LANÇOU — não houve veredito. Conta como falha (um comparador que não comparou não
   * autentica) e é o nome que torna VISÍVEL a sondagem por entrada malformada, que antes escapava
   * inteira do portão. A classe do erro vai em `errorKind`; a mensagem, nunca (ela embute a entrada).
   */
  "erro-na-comparacao",
] as const;
export type AuthFailureReason = (typeof AUTH_FAILURE_REASONS)[number];

/** Por onde a credencial foi apresentada — o que a depreciação futura do path precisa medir. */
export type AuthVia = "path" | "query" | "header" | "body" | "cookie";

/**
 * TODAS as superfícies self-auth do perímetro, pelo PATH canônico — o vocabulário ÚNICO.
 *
 * Existe para as superfícies não inventarem N grafias do mesmo lugar (um resumo por superfície com
 * grafias divergentes é um resumo que esconde a rota mais atacada). O valor é o PATH — NUNCA a URL
 * do request, que hoje carrega a credencial; `canonicalSurface` é o backstop que o chokepoint aplica.
 *
 * ⚠️ ÚNICO significa incluir as duas do TERMINAL, que não são rotas do Next (elas atendem no
 * `http.Server` próprio, `src/server/terminal-gateway.ts`). Elas viveram num vocabulário PARALELO, e o
 * que isso impedia era estrutural: o balde é UM por origem para o perímetro INTEIRO justamente para o
 * atacante não rotacionar de superfície e multiplicar o orçamento — com duas listas, nada garante que a
 * superfície declarada só numa delas compartilhe o balde, apareça no resumo forense ou colapse em
 * `canonicalSurface`. A rotação que o balde único fechou voltava a existir na fronteira entre as listas.
 * Rodar fora do Next é um limite de RUNTIME, não um perímetro diferente.
 */
export const PERIMETER_SURFACES = {
  mcp: "/api/usm",
  runnerEvents: "/api/runner/events",
  runnerPulse: "/api/runner/pulse",
  runnerDeployWebhook: "/api/runner/deploy-webhook",
  runnerTestWebhook: "/api/runner/test-webhook",
  login: "/api/auth/login",
  /** o terminal por HTTP (`/ttyd/token` e vizinhos) — rótulo FIXO, o path abaixo dele é texto do cliente. */
  terminalHttp: "/ttyd",
  /** o handshake que vira SHELL. A superfície mais valiosa do sistema. */
  terminalUpgrade: "/ttyd/ws",
} as const;

/** Um path declarado do perímetro. O que `PERIMETER_STANCES` cobre e `canonicalSurface` reconhece. */
export type PerimeterSurface = (typeof PERIMETER_SURFACES)[keyof typeof PERIMETER_SURFACES];

/**
 * As duas superfícies do TERMINAL na forma que `terminal-gateway.ts` consome — DERIVADAS do mapa
 * canônico, nunca redigitadas lá.
 *
 * O gateway rotula por FUNÇÃO (`http`/`upgrade`) e não pelo path do request, porque o resumo agrega por
 * superfície: passar `req.url` deixaria o atacante inventar uma chave por tentativa. Derivar daqui é o
 * que impede as duas listas de divergirem sem ninguém notar — um rótulo novo no gateway sem entrada no
 * mapa canônico deixa de compilar.
 */
export const TERMINAL_PERIMETER_SURFACES = {
  http: PERIMETER_SURFACES.terminalHttp,
  upgrade: PERIMETER_SURFACES.terminalUpgrade,
} as const;

/**
 * A postura de DIVULGAÇÃO da superfície quando ela está trancada.
 *
 *  - `muda`     → a rota MCP: a recusa é 404 nu, indistinguível de rota inexistente. A trava NÃO
 *                 pode ser o que confirma a existência do endpoint (era a postura correta antes e
 *                 continua sendo) — então o 429 fica de fora dela, e o registro do bloqueio vive no
 *                 rastro, do lado de dentro.
 *  - `declarada`→ as 4 rotas do runner, que já respondem 401: elas JÁ admitem existir, então negar
 *                 com 429 + `Retry-After` não conta nada novo e ainda ensina o cliente legítimo
 *                 (o monitor autônomo do dono) a esperar em vez de martelar.
 */
export type PerimeterStance = "muda" | "declarada";

/**
 * A postura de CADA superfície declarada — para o chamador não carregar a sua como literal.
 *
 * O que isto impede: que duas superfícies do mesmo perímetro divirjam de postura por descuido (o
 * gateway do terminal escrevia `"declarada"` na mão, longe daqui). A régua é uma frase só: responde
 * `muda` quem NÃO admitia existir antes da trava; `declarada` quem já respondia 401/JSON e portanto não
 * conta nada novo ao ganhar 429 + `Retry-After`.
 */
export const PERIMETER_STANCES: Record<keyof typeof PERIMETER_SURFACES, PerimeterStance> = {
  mcp: "muda",
  runnerEvents: "declarada",
  runnerPulse: "declarada",
  runnerDeployWebhook: "declarada",
  runnerTestWebhook: "declarada",
  login: "declarada",
  terminalHttp: "declarada",
  terminalUpgrade: "declarada",
};

/**
 * A postura de um path, canonicalizado primeiro (`/ttyd/token` ⇒ a do terminal HTTP).
 *
 * Fail-closed na DIVULGAÇÃO: superfície não declarada cai em `muda`, então uma rota nova esquecida no
 * mapa não passa a admitir que existe por omissão. `muda` nunca custa capacidade ao dono — ela só troca
 * o corpo de uma recusa que já estava decidida.
 */
export function stanceOfSurface(surface: string): PerimeterStance {
  const canonica = canonicalSurface(surface);
  for (const [chave, path] of Object.entries(PERIMETER_SURFACES)) {
    if (path === canonica) return PERIMETER_STANCES[chave as keyof typeof PERIMETER_SURFACES];
  }
  return "muda";
}

/**
 * A política do perímetro. Mesmo teto/janela do login (`LOGIN_POLICY`) — a régua é uma só —, com
 * `lockoutMs` sendo apenas a BASE: o bloqueio efetivo é `escalatedLockoutMs(strikes)`.
 */
export const PERIMETER_POLICY: RateLimitPolicy = {
  maxFailures: 8,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 60 * 1000,
};

/** Teto do backoff. Um bloqueio eterno viraria negação de serviço permanente por IP compartilhado. */
export const PERIMETER_LOCKOUT_CAP_MS = 60 * 60 * 1000;

/**
 * Quanto dura o n-ésimo bloqueio CONSECUTIVO da mesma origem: base × 2^(n-1), com teto.
 *
 * O primeiro bloqueio é curto de propósito — o caso comum é o operador com um token velho colado.
 * Quem volta e martela de novo não está errando a senha, e aí o custo dobra a cada rodada.
 */
export function escalatedLockoutMs(strikes: number): number {
  const n = Math.max(1, Math.floor(strikes));
  const ms = PERIMETER_POLICY.lockoutMs * 2 ** (n - 1);
  return Math.min(PERIMETER_LOCKOUT_CAP_MS, ms);
}

/** Depois de quanto tempo sem falhas a reincidência da origem é perdoada (o backoff volta à base). */
export const STRIKE_DECAY_MS = 6 * 60 * 60 * 1000;

/** Origens rastreadas ao mesmo tempo — teto de memória contra varredura com IP sempre novo. */
export const MAX_TRACKED_CLIENTS = 2000;

/** Estrangulamento do rastro de tentativa-enquanto-trancado (ver `noteBlockedAttempt`). */
export const BLOCKED_LOG_THROTTLE_MS = 60 * 1000;

/** Teto do arquivo de rastro; ao passar dele o atual vira `.1` e um novo começa vazio. */
export const AUTH_LEDGER_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Janela do teto GLOBAL de escrita do rastro (ver `publicarLinha`).
 *
 * Igual à janela do estrangulamento por chave: a régua é a mesma, o que muda é quem escolhe a chave —
 * aqui, ninguém.
 */
export const LEDGER_WINDOW_MS = 60 * 1000;

/**
 * Quantas linhas o rastro publica por janela, somando TODAS as origens.
 *
 * Folgado para o tráfego legítimo por construção: uma origem tranca em 8 falhas
 * (`PERIMETER_POLICY.maxFailures`), então este teto cabe 15 origens distintas trancando do zero dentro
 * do mesmo minuto antes de começar a coalescer. Quem encosta nele é volume de ataque, não operação.
 */
export const LEDGER_MAX_LINES_PER_WINDOW = 120;

export interface PerimeterGate {
  allowed: boolean;
  /** ms restantes de bloqueio — vira o `Retry-After` da superfície declarada. */
  retryAfterMs: number;
  /** tentativas restantes na janela (0 quando trancado). */
  remaining: number;
  /** bloqueios consecutivos já aplicados a esta origem — é o que escala o backoff. */
  strikes: number;
}

// ── Estado in-process ────────────────────────────────────────────────────────────────────────────
// Módulo-level de propósito: UM balde por origem para as 6 superfícies (ver o cabeçalho). Some no
// restart, e isso é aceitável — a trava encarece, ela não é a fronteira de segurança.

const attempts = new Map<string, AttemptRecord>();
const strikes = new Map<string, { count: number; lastAt: number }>();
const blocked = new Map<string, { count: number; lastLogAt: number }>();
let totalFailures = 0;
let totalBlocked = 0;

/**
 * O orçamento de ESCRITA do rastro na janela corrente — global, sem chave nenhuma.
 *
 * Não tem chave de propósito: é isso que impede o atacante que controla o `x-forwarded-for` de recuperar
 * o orçamento trocando de identidade (ver o item TETO GLOBAL no cabeçalho).
 */
const ledgerWindow = { startedAt: -Infinity, written: 0, suppressed: 0 };
let totalSuppressed = 0;

/** TEST SEAM — zera o estado in-process (é também o que um restart do serviço faz). */
export function resetPerimeterState(): void {
  attempts.clear();
  strikes.clear();
  blocked.clear();
  totalFailures = 0;
  totalBlocked = 0;
  ledgerWindow.startedAt = -Infinity;
  ledgerWindow.written = 0;
  ledgerWindow.suppressed = 0;
  totalSuppressed = 0;
}

/**
 * Quantas chaves o descarte libera de uma vez ao encostar no teto.
 *
 * Liberar UMA por request obrigaria a ordenar o mapa cheio em TODO request da rajada; liberar um lote
 * amortiza a ordenação por ~200 requests. O lote não é um relaxamento do teto: `MAX_TRACKED_CLIENTS`
 * continua sendo o máximo — o lote só decide de quanto em quanto tempo se paga o custo de escolher.
 */
const EVICTION_BATCH = Math.max(1, Math.floor(MAX_TRACKED_CLIENTS / 10));

/**
 * Impõe o teto DESCARTANDO POR POLÍTICA, nunca limpando o mapa.
 *
 * O que isto impede: limpar o mapa inteiro SOLTA todo bloqueio vigente, e quem controla o `x-forwarded-for`
 * (self-host exposto direto) consegue criar chaves à vontade — ou seja, escolhia a hora de zerar a
 * própria punição. `rank` devolve `[trancada?, idade]`, e o descarte começa pelo MENOR: primeiro as
 * ociosas (mais antiga antes) e, só se TUDO estiver trancado, a de expiração mais próxima — a que
 * perde menos proteção restante. Assim o bloqueio mais longo é sempre o último a cair, e um atacante
 * que inunde de chaves novas está descartando as travas curtas que ele mesmo acabou de criar.
 */
function evictToCap<V>(map: Map<string, V>, rank: (key: string, value: V) => [number, number]): void {
  if (map.size < MAX_TRACKED_CLIENTS) return;
  const ordenado = [...map.entries()]
    .map(([k, v]) => ({ k, r: rank(k, v) }))
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1]);
  const excedente = map.size - MAX_TRACKED_CLIENTS + EVICTION_BATCH;
  for (let i = 0; i < excedente && i < ordenado.length; i++) map.delete(ordenado[i]!.k);
}

/** Esta origem está com bloqueio VIVO agora? É o que protege a chave do descarte. */
function travada(key: string, now: number): boolean {
  return (attempts.get(key)?.lockedUntil ?? 0) > now;
}

/** Descarta o que não é mais vivo e impõe o teto de memória (sem soltar bloqueio ativo). */
function prune(now: number): void {
  pruneAttempts(attempts, now, PERIMETER_POLICY);
  evictToCap(attempts, (_k, rec) =>
    rec.lockedUntil > now ? [1, rec.lockedUntil] : [0, rec.failures.length ? Math.max(...rec.failures) : 0],
  );
  for (const [k, s] of strikes) {
    if (now - s.lastAt > STRIKE_DECAY_MS) strikes.delete(k);
  }
  // Os strikes são a MEMÓRIA da reincidência (é o que escala o próximo bloqueio): descartar o de uma
  // origem trancada devolveria a ela o backoff da base.
  evictToCap(strikes, (k, s) => [travada(k, now) ? 1 : 0, s.lastAt]);
  for (const [k, b] of blocked) {
    if (now - b.lastLogAt > STRIKE_DECAY_MS) blocked.delete(k);
  }
  evictToCap(blocked, (k, b) => [travada(k, now) ? 1 : 0, b.lastLogAt]);
}

function strikeCount(key: string): number {
  return strikes.get(key)?.count ?? 0;
}

/**
 * OBSERVA a trava desta origem. NÃO é um portão — não recuse um request com base nisto.
 *
 * ⚠️ Recusar aqui é o desfecho PROIBIDO: esta função não conhece a credencial, então uma recusa antes
 * da comparação recusa TAMBÉM a do dono, e um anônimo martelando uma superfície de máquina desliga o
 * painel de quem divide a chave com ele (ver a seção ORDEM no topo). Quem decide é `guardPerimeter`,
 * que compara PRIMEIRO. Isto serve para o resumo/UI (`readAuthFailureSummary`, `lockedNow`) e para o
 * pre-check LEGADO das rotas ainda não migradas.
 *
 * Não muta nada — a contagem só anda em `recordAuthFailure`. A chave é derivada dos headers aqui
 * dentro: o chamador NÃO escolhe a chave, senão um atacante que controlasse o parâmetro trocaria de
 * balde a cada tentativa e a trava seria decorativa.
 */
export function checkPerimeter(headers: Headers, now: number = Date.now()): PerimeterGate {
  prune(now);
  const key = clientKey(headers);
  const v = checkAttempt(attempts, key, now, PERIMETER_POLICY);
  return { ...v, strikes: strikeCount(key) };
}

export interface AuthFailureInput {
  /** os headers do request — a ÚNICA fonte da chave de trava. */
  headers: Headers;
  /** o PATH canônico da rota (`PERIMETER_SURFACES.*`). Uma URL inteira é redigida, não recusada. */
  surface: string;
  via: AuthVia;
  reason: AuthFailureReason;
  /** o valor tentado — usado SÓ para derivar o comprimento (`maskSecret`). Nunca é gravado. */
  presented?: string;
  /** o nível que a credencial tentada pediria, quando a rota o conhece. */
  levelWanted?: McpLevel;
  /** o handle que casou, num `handle-revogado` — id público, nunca o segredo. */
  handleId?: string;
  /**
   * num `erro-na-comparacao`: a CLASSE do erro (`sanitizeErrorKind`). Nunca a mensagem — ela embute a
   * entrada que quebrou o comparador, e o valor tentado só sai deste módulo como comprimento.
   */
  errorKind?: string;
  now?: number;
}

/** Uma linha do rastro. Chaves em inglês, como o ledger de `agent-actions.ts`. */
export interface AuthFailureLine {
  v: number;
  at: string;
  surface: string;
  via: AuthVia;
  reason: AuthFailureReason;
  /** a chave de trava (último salto do XFF) — é o "quem" do forense. */
  client: string;
  /** a n-ésima falha desta origem na janela. */
  attempt: number;
  locked: boolean;
  retryAfterMs?: number;
  /** o valor tentado, MASCARADO: só o comprimento sai (`maskSecret`). */
  presented?: string;
  levelWanted?: McpLevel;
  handleId?: string;
  /** a CLASSE do erro que o comparador lançou. Nunca a mensagem dele. */
  errorKind?: string;
  /** numa linha de rajada estrangulada: quantas tentativas ela representa. */
  blocked?: number;
  /**
   * quantas linhas o teto GLOBAL da janela suprimiu até aqui (ver `publicarLinha`). É a MAGNITUDE do
   * que não está no arquivo — sem ela, coalescer viraria esconder.
   */
  suppressed?: number;
  strikes?: number;
}

export const AUTH_FAILURE_VERSION = 1;

/** O rastro durável. Ao lado do resto do estado do runner (gitignorado). */
export function authFailuresPath(): string {
  return path.join(runnerStateDir(), "auth-failures.jsonl");
}
/** A geração anterior, depois da rotação por bytes. */
export function authFailuresRotatedPath(): string {
  return path.join(runnerStateDir(), "auth-failures.1.jsonl");
}

let writeChain: Promise<void> = Promise.resolve();

/**
 * Serializa a escrita (linhas nunca se entrelaçam) e FALHA ABERTO: um erro de disco avisa e é
 * engolido. Um rastro que derruba a rota de autenticação seria uma negação de serviço auto-infligida
 * — e o pior desfecho possível aqui é o serviço parar de atender o dono.
 */
function appendLine(rec: AuthFailureLine): Promise<void> {
  const line = JSON.stringify(rec) + "\n";
  writeChain = writeChain
    .then(async () => {
      const file = authFailuresPath();
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const st = await fsp.stat(file).then(
        (s) => s,
        () => null,
      );
      // O modo do arquivo PRÉ-EXISTENTE: `mode` no `appendFile` só vale na CRIAÇÃO, então um rastro
      // herdado (edição manual, backup, versão anterior do serviço) ficaria legível por qualquer conta
      // local do host — e é o arquivo que nomeia as superfícies sendo varridas AGORA. Mesma postura de
      // `mcp-handle.ts`. A verificação é de graça: reusa o `stat` que a rotação já precisa.
      // eslint-disable-next-line no-bitwise -- modo de arquivo é máscara de bits por definição
      const modoFolgado = st !== null && (st.mode & 0o077) !== 0;
      // Rotação de UMA geração: o teto real do rastro é 2 × AUTH_LEDGER_MAX_BYTES, então nem uma
      // rajada longa transforma o forense em enchimento de disco.
      const rotacionou = st !== null && st.size >= AUTH_LEDGER_MAX_BYTES;
      if (rotacionou) {
        const anterior = authFailuresRotatedPath();
        await fsp.rename(file, anterior).catch(() => {});
        // A geração anterior carrega o MESMO forense — o modo folgado viaja com o inode no rename.
        if (modoFolgado) await fsp.chmod(anterior, 0o600).catch(() => {});
      }
      await fsp.appendFile(file, line, { encoding: "utf8", mode: 0o600 });
      if (modoFolgado && !rotacionou) await fsp.chmod(file, 0o600).catch(() => {});
    })
    .catch((err) =>
      console.warn("[auth-audit] rastro não gravou (não-fatal):", err instanceof Error ? err.message : err),
    );
  return writeChain;
}

/** Resolve quando todo append enfileirado até agora foi persistido. Nunca rejeita. */
export function flushAuthFailures(): Promise<void> {
  return writeChain;
}

/**
 * O CHOKEPOINT de publicação: decide se ESTA linha vai ao disco, sob um teto global por janela.
 *
 * O que este controle impede: que o orçamento de escrita do rastro seja recuperado TROCANDO DE CHAVE. O
 * outro estrangulamento (`registrarRajadaTrancada`) é por chave de trava, e num self-host exposto direto
 * — a topologia que a própria onda cita como motivação — a chave é o `x-forwarded-for`, texto do cliente:
 * um XFF novo por tentativa dava balde novo, orçamento novo e uma linha por tentativa. O teto daqui é do
 * PROCESSO, então rotacionar identidade não compra nada.
 *
 * E não vira cegueira: passado o teto, a contagem do que foi suprimido é publicada em POTÊNCIAS DE 10
 * (1, 10, 100…), então uma rajada de N gera O(log₁₀ N) linhas extras e a última carrega a magnitude —
 * "500 suprimidas", não "houve algo". A DECISÃO (trava, strikes, contadores) nunca passa por aqui: o teto
 * é do rastro, e uma origem que estourou o teto de escrita continua sendo trancada normalmente.
 */
function publicarLinha(rec: AuthFailureLine, now: number): void {
  if (now - ledgerWindow.startedAt >= LEDGER_WINDOW_MS) {
    ledgerWindow.startedAt = now;
    ledgerWindow.written = 0;
    ledgerWindow.suppressed = 0;
  }
  if (ledgerWindow.written < LEDGER_MAX_LINES_PER_WINDOW) {
    ledgerWindow.written += 1;
    void appendLine(rec);
    return;
  }
  ledgerWindow.suppressed += 1;
  totalSuppressed += 1;
  // A MESMA régua logarítmica do estrangulamento por chave — publicar na 1ª supressão e em cada potência
  // de 10 mantém o teto real em `LEDGER_MAX_LINES_PER_WINDOW + O(log₁₀ N)`.
  if (/^10*$/.test(String(ledgerWindow.suppressed))) {
    void appendLine({ ...rec, suppressed: ledgerWindow.suppressed });
  }
}

/**
 * Reduz `raw` ao PATH e apaga qualquer segmento que possa ser credencial.
 *
 * Isto existe porque a credencial de hoje VIAJA NO PATH: `/api/usm/<token>/mcp`, e `?secret=<token>`
 * nas rotas do runner. Um chamador que passasse `req.url` gravaria o segredo no arquivo forense —
 * exatamente o defeito do logger de erro default do Caddy, reproduzido dentro de casa. Duas regras,
 * as duas por FORMA (não por lista de rotas, que envelheceria):
 *   1. query string e fragmento são DESCARTADOS por inteiro (é onde `secret=` mora);
 *   2. todo segmento longo (> `MAX_SEGMENT`) vira `<redigido>` — um token tem 32+ chars, um nome de
 *      rota não.
 */
const MAX_SEGMENT = 24;
export function redactCredentialFromSurface(raw: string): string {
  const bruto = String(raw ?? "").trim();
  let semQuery = bruto.split("?")[0]!.split("#")[0]!;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(semQuery)) {
    try {
      semQuery = new URL(semQuery).pathname;
    } catch {
      /* não é URL parseável — segue como path */
    }
  }
  const partes = semQuery.split("/").map((seg) => (seg.length > MAX_SEGMENT ? "<redigido>" : seg));
  return partes.join("/").slice(0, 160) || "<vazio>";
}

/**
 * Os paths declarados, do MAIS específico para o menos — a ordem é o que faz `/ttyd/ws` ganhar de
 * `/ttyd`, e sem ela o handshake que entrega SHELL se esconderia no balde do HTTP.
 */
const SURFACE_PREFIXES: readonly string[] = Object.values(PERIMETER_SURFACES)
  .slice()
  .sort((a, b) => b.length - a.length);

/**
 * Reduz `raw` à superfície DECLARADA que o contém — o backstop que o chokepoint aplica antes do disco.
 *
 * Duas coisas que isto impede, e nenhuma delas a redação sozinha cobria:
 *   1. o CLIENTE escrever no resumo forense. `bySurface` agrega por superfície, e o path abaixo dela é
 *      texto de quem chamou: `/ttyd/a1`, `/ttyd/a2`… davam uma chave por tentativa, e o resumo ficava
 *      ilegível na hora exata de ler quem está sendo martelado.
 *   2. um segredo CURTO viajar no path até o arquivo. `redactCredentialFromSurface` só apaga segmento
 *      LONGO (> 24 chars) — um token fraco configurado à mão, ou o chute do atacante, passava inteiro.
 *
 * O casamento é por SEGMENTO (`=== path` ou `startsWith(path + "/")`), a mesma régua de
 * `public-routes.ts`: com `startsWith` cru, `/ttyd-publico` cairia no balde do terminal e o forense
 * acusaria a superfície errada. Superfície NÃO declarada segue no caminho da redação — colapsá-la num
 * balde alheio seria apagar informação forense em vez de proteger.
 */
export function canonicalSurface(raw: string): string {
  const path = redactCredentialFromSurface(raw);
  for (const declarada of SURFACE_PREFIXES) {
    if (path === declarada || path.startsWith(`${declarada}/`)) return declarada;
  }
  return path;
}

/**
 * Registra UMA falha de autenticação: conta na trava, escala o bloqueio se passou do teto, e grava a
 * linha durável. Devolve o veredito já atualizado (`allowed:false` ⇒ esta falha acabou de trancar).
 *
 * A RESPOSTA da rota não muda por causa disto: quem recusava com 404 nu continua recusando com 404
 * nu. O registro é do lado de dentro — a postura de não confirmar o endpoint é correta e foi mantida.
 */
export function recordAuthFailure(input: AuthFailureInput): PerimeterGate {
  const now = input.now ?? Date.now();
  prune(now);
  const key = clientKey(input.headers);

  // A DECISÃO acontece AQUI, junto do incremento, e é o que torna a trava indivisível: entre uma
  // checagem que só lê e o registro da falha existe um `await` (a comparação da credencial lê o
  // registro de handles do disco), e nessa janela N pedidos concorrentes leem todos "pode tentar".
  // Sem este ramo o bloqueio vigente era IGNORADO no registro — a lista de falhas é zerada no
  // lockout, então a 9ª falha voltava a dizer "pode tentar" e o orçamento renascia a cada 8. Medido:
  // 64 tentativas sob teto de 8 rendiam 56 aceitas. O bloqueio NÃO é estendido a cada insistência
  // (senão martelar viraria bloqueio eterno, negação de serviço permanente por IP compartilhado); a
  // escalada acontece no PRÓXIMO lockout, via strikes.
  const vigente = attempts.get(key);
  if (vigente && vigente.lockedUntil > now) {
    registrarRajadaTrancada(input, key, now);
    return { allowed: false, retryAfterMs: vigente.lockedUntil - now, remaining: 0, strikes: strikeCount(key) };
  }

  const proximoStrike = strikeCount(key) + 1;
  // O `lockoutMs` escalado só é lido quando ESTA falha tranca; passá-lo sempre evita ter de
  // consultar a trava duas vezes para descobrir se trancou.
  const verdict = recordFailure(attempts, key, now, {
    ...PERIMETER_POLICY,
    lockoutMs: escalatedLockoutMs(proximoStrike),
  });
  const trancou = !verdict.allowed;
  if (trancou) strikes.set(key, { count: proximoStrike, lastAt: now });
  else strikes.set(key, { count: strikeCount(key), lastAt: now });
  totalFailures += 1;

  const tentativa = PERIMETER_POLICY.maxFailures - verdict.remaining;
  publicarLinha(
    {
      v: AUTH_FAILURE_VERSION,
      at: new Date(now).toISOString(),
      surface: canonicalSurface(input.surface),
      via: input.via,
      reason: input.reason,
      client: key,
      attempt: trancou ? PERIMETER_POLICY.maxFailures : tentativa,
      locked: trancou,
      ...(trancou ? { retryAfterMs: verdict.retryAfterMs, strikes: proximoStrike } : {}),
      ...(input.presented !== undefined ? { presented: maskSecret(input.presented) } : {}),
      ...(input.levelWanted ? { levelWanted: input.levelWanted } : {}),
      ...(input.handleId ? { handleId: input.handleId } : {}),
      ...(input.errorKind ? { errorKind: input.errorKind } : {}),
    },
    now,
  );

  return { ...verdict, strikes: trancou ? proximoStrike : strikeCount(key) };
}

/**
 * Grava uma tentativa recebida com a origem JÁ trancada, ESTRANGULADA.
 *
 * Uma linha por tentativa aqui entregaria o disco ao atacante (ele controla o volume). A régua é
 * logarítmica: publica na 1ª, e depois em cada potência de 10 — ou quando passou
 * `BLOCKED_LOG_THROTTLE_MS` desde a última. Uma rajada de N tentativas gera O(log₁₀ N) linhas e a
 * última carrega a MAGNITUDE, que é a informação que o operador precisa ("500", não "houve").
 */
function registrarRajadaTrancada(input: Omit<AuthFailureInput, "reason">, key: string, now: number): void {
  const st = blocked.get(key) ?? { count: 0, lastLogAt: -Infinity };
  st.count += 1;
  totalBlocked += 1;

  const potenciaDeDez = /^10*$/.test(String(st.count));
  const passouJanela = now - st.lastLogAt >= BLOCKED_LOG_THROTTLE_MS;
  if (potenciaDeDez || passouJanela) {
    st.lastLogAt = now;
    // Passa por `publicarLinha` (e não direto pelo `appendLine`) porque este estrangulamento é por
    // CHAVE, e a chave é escolhida pelo cliente num self-host sem proxy: sem o teto global acima dele,
    // trocar de XFF devolvia o orçamento de escrita inteiro.
    publicarLinha(
      {
        v: AUTH_FAILURE_VERSION,
        at: new Date(now).toISOString(),
        surface: canonicalSurface(input.surface),
        via: input.via,
        reason: "trancado",
        client: key,
        attempt: PERIMETER_POLICY.maxFailures,
        locked: true,
        blocked: st.count,
        strikes: strikeCount(key),
        ...(input.levelWanted ? { levelWanted: input.levelWanted } : {}),
      },
      now,
    );
  }
  blocked.set(key, st);
}

/**
 * Registra uma tentativa recebida com a origem JÁ trancada, sem comparar credencial nenhuma.
 *
 * Sobrevive para o pre-check LEGADO das rotas (ver `checkPerimeter`). Numa superfície migrada para
 * `guardPerimeter` este caminho não é mais alcançado: quem tranca já é `recordAuthFailure`, que
 * estrangula a rajada pela MESMA régua — e o faz DEPOIS de comparar a credencial, que é o que impede
 * a trava de recusar o dono.
 */
export function noteBlockedAttempt(input: Omit<AuthFailureInput, "reason">): PerimeterGate {
  const now = input.now ?? Date.now();
  registrarRajadaTrancada(input, clientKey(input.headers), now);
  return checkPerimeter(input.headers, now);
}

/**
 * Credencial VÁLIDA: perdoa a janela daquela origem — falhas, reincidência (strikes) e contagem de
 * rajada.
 *
 * É o que impede que o operador que colou um token velho três vezes carregue um backoff dobrado
 * depois de acertar. E não abre bypass nenhum: quem acertou já tem exatamente o que a trava
 * protegia, então zerar o contador dele não entrega nada que ele não tivesse.
 */
export function recordAuthSuccess(headers: Headers): void {
  const key = clientKey(headers);
  recordSuccess(attempts, key);
  strikes.delete(key);
  blocked.delete(key);
}

/**
 * A resposta de uma superfície TRANCADA — decidida em um lugar só para as 6 rotas não divergirem.
 *
 * `muda` devolve 404 SEM `Retry-After`: o header confirmaria que existe algo ali, e a trava não pode
 * ser o oráculo que a recusa se recusa a ser.
 */
export function perimeterLockedResponse(stance: PerimeterStance, gate: PerimeterGate): Response {
  if (stance === "muda") return new Response("Not found", { status: 404 });
  return new Response("Too many requests", {
    status: 429,
    headers: { "retry-after": String(Math.max(1, Math.ceil(gate.retryAfterMs / 1000))) },
  });
}

/** O veredito da comparação de credencial que a superfície faz — a trava não sabe comparar nada. */
export type PerimeterValidation<T> =
  | { valid: true; value: T }
  | { valid: false; reason: AuthFailureReason; handleId?: string };

export interface PerimeterGuardInput<T> {
  /** os headers do request — a ÚNICA fonte da chave de trava. */
  headers: Headers;
  /** o PATH canônico da rota (`PERIMETER_SURFACES.*`). Uma URL inteira é redigida, não recusada. */
  surface: string;
  via: AuthVia;
  /** a postura de divulgação da rota quando trancada (`muda` = 404 nu; `declarada` = 429). */
  stance: PerimeterStance;
  /** o valor tentado, CRU — o mascaramento acontece dentro do ledger. */
  presented?: string;
  levelWanted?: McpLevel;
  /**
   * Compara a credencial. Roda SEMPRE e PRIMEIRO — é este contrato que impede a trava de recusar o
   * dono. Pode ser async (a resolução de handle lê o registro do disco).
   */
  validate: () => PerimeterValidation<T> | Promise<PerimeterValidation<T>>;
  /**
   * A recusa por CREDENCIAL da superfície, quando ela precisa de um corpo próprio (o `/api/auth/login`
   * devolve JSON, que é contrato da tela do operador). Sem isto, a recusa é a mudez da postura.
   */
  deny?: (gate: PerimeterGate) => Response;
  now?: number;
}

export type PerimeterGuardResult<T> =
  | { ok: true; value: T; gate: PerimeterGate }
  | { ok: false; response: Response; gate: PerimeterGate };

/** A recusa por credencial, na mudez da postura: 404 nu na muda, 401 nu na declarada. */
function recusaPadrao(stance: PerimeterStance): Response {
  if (stance === "muda") return new Response("Not found", { status: 404 });
  return new Response("Unauthorized", { status: 401 });
}

/**
 * Forma de identificador — o que um nome de classe/`errno` é, e o que um segredo NÃO consegue ser.
 *
 * O teto é `MIN_TOKEN_LEN - 1` de propósito: os três pisos de credencial do sistema valem 32
 * (`MIN_TOKEN_LEN`, `MIN_SESSION_SECRET_LEN`, `MIN_OPERATOR_TOKEN_LEN`), então nada que passe por aqui
 * tem comprimento para ser uma credencial VÁLIDA — o limite deixa de ser número mágico e vira invariante.
 * Nomes reais cabem folgados (`AggregateError` 14, `MongoServerSelectionError` 25).
 */
const IDENT_MAX = MIN_TOKEN_LEN - 1;
const ERROR_NAME_SHAPE = new RegExp(`^[A-Za-z][A-Za-z0-9_]{0,${IDENT_MAX - 1}}$`);
const ERROR_CODE_SHAPE = new RegExp(`^[A-Za-z0-9_]{1,${IDENT_MAX}}$`);

/**
 * O rótulo de um erro do comparador: `Name` ou `Name:CODE`. Nada mais.
 *
 * O que isto impede: que o rastro carregue o valor tentado por via indireta. A postura do módulo é que
 * do valor só sai o comprimento (`maskSecret`), e uma MENSAGEM de erro real a viola — `JSON.parse`,
 * `URL`, Zod e afins embutem a entrada que os quebrou. Por isso a mensagem nunca é lida, o valor lançado
 * nunca é stringificado (um `throw <segredo>` cai em `nao-erro:string`, sem conteúdo nenhum), e
 * `name`/`code` só entram com FORMA de identificador e comprimento abaixo do piso de credencial.
 */
export function sanitizeErrorKind(err: unknown): string {
  if (!(err instanceof Error)) return `nao-erro:${typeof err}`;
  const nome = ERROR_NAME_SHAPE.test(err.name) ? err.name : "Error";
  const code = (err as { code?: unknown }).code;
  if (typeof code === "number" && Number.isFinite(code)) return `${nome}:${code}`;
  if (typeof code === "string" && ERROR_CODE_SHAPE.test(code)) return `${nome}:${code}`;
  return nome;
}

/**
 * A recusa: conta a tentativa e escolhe o corpo. UM caminho para as DUAS classes de recusa (veredito
 * inválido e exceção do comparador).
 *
 * Ser um só é o controle: se a exceção tivesse resposta própria, ela viraria um ORÁCULO de forma de
 * entrada — o atacante distinguiria "quebrei o validador" de "chutei errado" e teria por onde procurar.
 * Aqui as duas saem idênticas, inclusive quando a superfície tem corpo próprio (`deny`), que é o que
 * mantém o contador na tela do dono sem contar nada ao atacante.
 */
function recusar<T>(
  input: PerimeterGuardInput<T>,
  veredito: Extract<PerimeterValidation<T>, { valid: false }>,
  now: number,
  errorKind?: string,
): Extract<PerimeterGuardResult<T>, { ok: false }> {
  const gate = recordAuthFailure({
    headers: input.headers,
    surface: input.surface,
    via: input.via,
    reason: veredito.reason,
    now,
    ...(input.presented !== undefined ? { presented: input.presented } : {}),
    ...(input.levelWanted ? { levelWanted: input.levelWanted } : {}),
    ...(veredito.handleId ? { handleId: veredito.handleId } : {}),
    ...(errorKind ? { errorKind } : {}),
  });
  const response = gate.allowed
    ? (input.deny?.(gate) ?? recusaPadrao(input.stance))
    : perimeterLockedResponse(input.stance, gate);
  return { ok: false, response, gate };
}

/**
 * O PORTÃO de uma superfície self-auth. Ordem: COMPARA a credencial → então decide.
 *
 * É o único ponto onde as superfícies de `PERIMETER_SURFACES` devem consultar a trava, e a ordem é o
 * controle:
 *
 *  1. `validate()` roda SEMPRE, antes de qualquer leitura da trava. Uma credencial VÁLIDA nunca é
 *     recusada — e é isso que torna IMPOSSÍVEL um terceiro trancar o dono: o dono apresenta
 *     credencial válida. O acerto ainda ZERA o balde da origem (`recordAuthSuccess`), então o
 *     operador que colou um token velho três vezes não carrega o backoff depois de acertar; e zerar
 *     não abre bypass, porque quem acertou já tem exatamente o que a trava protegia.
 *  2. Só a tentativa INVÁLIDA é contada e recusada, num passo indivisível (`recordAuthFailure` decide
 *     e incrementa junto) — o orçamento por rajada é o teto configurado, não o número de requests em
 *     voo.
 *  3. `validate()` LANÇAR é uma tentativa inválida como qualquer outra — não um caminho de fuga. A
 *     exceção escapava daqui, e com ela a tentativa saía sem ser contada, sem linha no rastro e com uma
 *     resposta que a rota inventava do throw: um canal de sondagem ilimitado, invisível e ainda
 *     distinguível de "chute errado". Hoje é fail-closed (um comparador que não comparou não autentica),
 *     CONTA na trava e nomeia o motivo no forense. Isto não custa nada ao dono: a comparação continua
 *     vindo primeiro, então uma credencial válida atravessa mesmo com a origem trancada por exceções.
 *
 * A RESPOSTA não conta nada novo: na superfície `muda` a recusa por credencial, a recusa por trava e a
 * recusa por exceção são o MESMO 404 nu sem `Retry-After` (a trava não pode ser o oráculo que a recusa
 * se recusa a ser); na `declarada` — que já admitia existir com 401 — o 429 + `Retry-After` ensina o
 * cliente legítimo do dono a esperar em vez de martelar.
 *
 * CUSTO: uma comparação em tempo constante por tentativa, inclusive de origem já trancada. É barato,
 * e é o preço de não ter um interruptor de negação de serviço contra o próprio dono.
 */
export async function guardPerimeter<T>(input: PerimeterGuardInput<T>): Promise<PerimeterGuardResult<T>> {
  const now = input.now ?? Date.now();

  let veredito: PerimeterValidation<T>;
  try {
    veredito = await input.validate();
  } catch (err) {
    // Só a CLASSE do erro atravessa (ver `sanitizeErrorKind`): a mensagem embute a entrada que quebrou
    // o comparador, e gravá-la escreveria o valor tentado no arquivo forense.
    const errorKind = sanitizeErrorKind(err);
    const recusa = recusar(input, { valid: false, reason: "erro-na-comparacao" }, now, errorKind);
    // No journald também, porque "o comparador está quebrando" é sinal de DEFEITO e não só de invasão —
    // mas apenas enquanto a origem não está trancada. Depois da trava quem controla o volume é o
    // atacante: uma linha por insistência entregaria o journal a ele, exatamente o vetor que o
    // estrangulamento do rastro durável (`noteBlockedAttempt`) já fecha.
    if (recusa.gate.allowed) {
      console.warn(`[auth-audit] comparador lançou em ${canonicalSurface(input.surface)} (${errorKind})`);
    }
    return recusa;
  }

  if (veredito.valid) {
    recordAuthSuccess(input.headers);
    return {
      ok: true,
      value: veredito.value,
      gate: { allowed: true, retryAfterMs: 0, remaining: PERIMETER_POLICY.maxFailures, strikes: 0 },
    };
  }

  return recusar(input, veredito, now);
}

/**
 * Contadores do processo — inclui o total GLOBAL, que só CONTA (nunca bloqueia; ver o cabeçalho).
 *
 * `ledgerSuppressed` existe para o teto global de escrita não virar cegueira: ele é a diferença entre o
 * que aconteceu e o que está no arquivo. Os outros três contam TUDO, inclusive o que o teto suprimiu —
 * é o que garante que o teto seja do rastro e não da detecção.
 */
export function perimeterScanCounters(): {
  failures: number;
  blocked: number;
  distinctClients: number;
  ledgerSuppressed: number;
} {
  return {
    failures: totalFailures,
    blocked: totalBlocked,
    distinctClients: attempts.size,
    ledgerSuppressed: totalSuppressed,
  };
}

/** Lê o rastro durável (geração anterior primeiro; linha corrompida é ignorada, nunca derruba). */
export async function readAuthFailures(): Promise<AuthFailureLine[]> {
  const out: AuthFailureLine[] = [];
  for (const file of [authFailuresRotatedPath(), authFailuresPath()]) {
    const raw = await fsp.readFile(file, "utf8").catch(() => "");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t) as AuthFailureLine;
        if (rec && typeof rec.surface === "string" && typeof rec.client === "string") out.push(rec);
      } catch {
        /* linha truncada por rotação/queda — ignora */
      }
    }
  }
  return out;
}

export interface AuthFailureSummary {
  /** o `at` da linha mais antiga que ainda existe no rastro (depois da rotação). */
  since?: string;
  total: number;
  byReason: Partial<Record<AuthFailureReason, number>>;
  bySurface: Record<string, number>;
  topClients: { client: string; failures: number; lastAt: string }[];
  /** quem está trancado NESTE processo — vem da trava in-process, não do arquivo. */
  lockedNow: { client: string; retryAfterMs: number; strikes: number }[];
}

/**
 * O resumo que a UI/ops lê. Combina as DUAS fontes, e a divisão é a própria postura: os totais vêm
 * do rastro DURÁVEL (é o que serve para forense) e `lockedNow` vem da trava IN-PROCESS (é o que
 * existe agora). Um resumo que fingisse uma fonte só mentiria depois de todo restart.
 */
export async function readAuthFailureSummary(opts?: { now?: number; topN?: number }): Promise<AuthFailureSummary> {
  const now = opts?.now ?? Date.now();
  const topN = opts?.topN ?? 10;
  const linhas = await readAuthFailures();

  const byReason: Partial<Record<AuthFailureReason, number>> = {};
  const bySurface: Record<string, number> = {};
  const porCliente = new Map<string, { failures: number; lastAt: string }>();
  for (const l of linhas) {
    byReason[l.reason] = (byReason[l.reason] ?? 0) + 1;
    bySurface[l.surface] = (bySurface[l.surface] ?? 0) + 1;
    const c = porCliente.get(l.client) ?? { failures: 0, lastAt: l.at };
    c.failures += 1;
    if (l.at > c.lastAt) c.lastAt = l.at;
    porCliente.set(l.client, c);
  }

  const lockedNow: AuthFailureSummary["lockedNow"] = [];
  for (const [key, rec] of attempts) {
    if (rec.lockedUntil > now) {
      lockedNow.push({ client: key, retryAfterMs: rec.lockedUntil - now, strikes: strikeCount(key) });
    }
  }

  return {
    ...(linhas[0] ? { since: linhas[0].at } : {}),
    total: linhas.length,
    byReason,
    bySurface,
    topClients: [...porCliente.entries()]
      .map(([client, v]) => ({ client, ...v }))
      .sort((a, b) => b.failures - a.failures)
      .slice(0, topN),
    lockedNow,
  };
}

/**
 * story-et6a4j — LEVA O TOKEN `full` PARA O LEDGER DE AUDITORIA.
 *
 * O guard por chamada (`mcp/guard.ts`) curto-circuita `full` ANTES de qualquer escrita, então a
 * credencial MAIS poderosa do sistema era a única cujas ações não deixavam rastro: um incidente
 * conduzido por ela era o menos reconstruível de todos. Isto não GATEIA nada — `full` continua
 * passando direto, sem aprovação, sem matriz, sem custo de autonomia. Só passa a existir a linha.
 *
 * A régua de VOLUME vive aqui, não no chamador: `read` não gera linha, igual ao ator escopado (o
 * ledger registra MUTAÇÃO; uma linha por leitura afogaria o arquivo e o tornaria inútil justamente
 * quando fosse preciso ler). Assim a fiação no guard é uma chamada e não pode errar a ordem.
 */
export function recordPrivilegedCall(input: {
  /** rótulo do ator SEM segredo — `mcpActorLabel()` de `mcp-handle.ts` produz o canônico. */
  actor?: string;
  tool: string;
  cls: RiskClass;
  cardId?: string;
  board?: string;
}): void {
  if (input.cls === "read") return;
  void appendAgentAction({
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.board ? { board: input.board } : {}),
    ...(input.cardId ? { cardId: input.cardId } : {}),
    tool: input.tool,
    cls: input.cls,
    disposition: "auto",
    outcome: "executed",
    note: "nível full — não-gateado por desenho",
  });
}
