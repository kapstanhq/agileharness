// O PORTÃO DENTRO DA AÇÃO — a segunda camada, redundante POR DESENHO (story-rwlu34).
//
// O QUE ESTE CONTROLE IMPEDE: que uma Server Action execute para um chamador ANÔNIMO quando o
// portão da BORDA não decidiu. As Server Actions do Next são endpoints POST; até aqui quem as
// protegia era só `src/middleware.ts`. A auditoria de perímetro (2026-07-29) REFUTOU a alegação de
// que um anônimo as alcança hoje — o middleware cobre, com casamento por segmento e teste de
// exaustividade que congela as isenções em 10 entradas. Mas a proteção era de UMA camada, EXTERNA à
// ação: uma linha mudada no `matcher`, uma rota nova entrando em `PUBLIC_ROUTES` por descuido, ou um
// dispatch de action que chegue por um caminho que o matcher não cubra exporiam ~120 mutadores de uma
// vez — inclusive apagar card, spawnar agente e publicar em produção. Este módulo tira a segurança da
// borda e a coloca também DENTRO do boundary, onde a ação de fato acontece.
//
// PERÍMETRO FECHADO, AUTONOMIA INTACTA. O guard reconhece TRÊS chamadores legítimos e não reduz a
// capacidade de nenhum deles — nada aqui remove skip-permissions, deploy ou deleção:
//
//  1. OPERADOR no navegador → cookie de sessão assinado. Verificado pela MESMÍSSIMA `verifySession`
//     do middleware, com o MESMO par de segredos (`authSecretsFromEnv`): uma segunda régua para
//     "sessão válida" seria uma segunda verdade, e a que apodrece. É o único chamador de quem se
//     exige prova, porque é o único que um atacante pode tentar imitar pela rede.
//
//  2. AGENTE HEADLESS pelo MCP → o request entrou por `/api/usm/<token>`, cujo token foi comparado
//     timing-safe (`lib/storymap/mcp/auth.ts`) e cuja identidade a rota publicou no AsyncLocalStorage
//     (`lib/storymap/mcp/actor.ts`). Esse chamador NÃO tem navegador nem cookie: exigir sessão dele
//     FECHARIA o canal dos agentes — o oposto do que este hardening quer. O crachá dele não é
//     forjável de fora porque não viaja no request: ele é o contexto async que a própria rota abriu
//     DEPOIS de autenticar o token.
//
//  3. O PRÓPRIO SERVIÇO, fora de um request → efeito fire-and-forget do engine, callback de
//     `fs.watch`, tick do copiloto (`runner/steward-deps.ts` chama `moveCardAction`/`askQuestionsAction`
//     a partir do timer de `instrumentation.ts`), teste unitário. Aqui não há request ⇒ não há
//     atacante: a única superfície que um anônimo alcança é HTTP, e TODO caminho HTTP do Next roda
//     dentro de um request store (é justamente por isso que `cookies()` só estoura fora dele).
//     Tratar "sem request" como interno não é fail-open: é reconhecer que o chamador é o processo,
//     não a rede.
//
// ⚠️ E É AQUI QUE A PRIMEIRA VERSÃO DESTE ARQUIVO ESTAVA FAIL-OPEN (achado HIGH da lente
// adversarial, 2026-07-30). Ela deduzia o chamador (3) por EXCLUSÃO: qualquer throw de `cookies()`
// que não fosse o bail-out `DYNAMIC_SERVER_USAGE` virava `in-process` — a classe que PERMITE. O
// `cookies()` do Next 14.2.35 tem CINCO caminhos de throw, e só UM significa "fora de request":
//
//   (1) `getExpectedRequestStore` sem store          → Error genérico   ⇒ é ESTE, o único
//   (2) dentro de `unstable_cache`                   → Error genérico   ⇒ é um CACHE SCOPE
//   (3) rota com `dynamic = "error"`                 → StaticGenBailoutError (`code`)
//   (4) prerender PPR (`postponeWithTracking`)       → postpone do React / Invariant genérico
//   (5) o próprio `import("next/headers")` falhando  → nem chegou a perguntar nada
//
// Três deles são `Error` GENÉRICOS — indistinguíveis do (1) pela classe. Então a régua virou
// FAIL-CLOSED e POSITIVA: só `in-process` quando há prova afirmativa de "não estou dentro de uma
// request", e a prova exige TRÊS fatos concordando (ver {@link classifyScopeThrow}). Qualquer outra
// coisa recusa com {@link UnauthenticatedActionError} `reason: "unverifiable-scope"`. Nenhum
// chamador legítimo perde capacidade: o (3) continua sendo reconhecido pelo sinal REAL do Next, e os
// testes de `action-guard.test.ts` produzem esse sinal chamando as funções do Next instalado.
//
// POR QUE NÃO reconhecemos rota self-auth pelo pathname: o middleware carimba o pathname num header
// (`PATHNAME_HEADER`), e seria tentador liberar `/api/usm` e `/api/runner` por ele. Sob a hipótese
// que ESTE controle cobre — middleware fora do caminho — esse header passa a vir do cliente, e
// reconhecer a rota por header seria entregar ao atacante o próprio crachá. O ALS do ator, não.

import { authSecretsFromEnv } from "@/lib/auth/env";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";
import { currentMcpActor } from "@/lib/storymap/mcp/actor";

/** Quem está chamando a ação — os três chamadores legítimos do cabeçalho. */
export type ActionCaller =
  /** operador humano com cookie de sessão válido. */
  | "operator-session"
  /** agente headless via MCP (token timing-safe já verificado pela rota). */
  | "mcp-token"
  /** o próprio serviço, fora de qualquer request HTTP. */
  | "in-process";

/**
 * POR QUE a ação foi recusada — o discriminador estável que o teste de ataque afirma.
 *
 * `no-session` é o caso comum e esperado (request HTTP sem cookie válido). `unverifiable-scope` é o
 * caso que a versão fail-open confundia com "chamada interna": não se conseguiu provar de ONDE a
 * chamada veio. Os dois recusam; separá-los importa porque o segundo é um sinal de que o ambiente do
 * Next mudou debaixo do guard (upgrade, bundling, contexto de render inesperado) e merece
 * investigação — não é um operador deslogado.
 */
export type ActionRefusalReason = "no-session" | "unverifiable-scope";

/**
 * A recusa NOMEADA — o que o teste de ataque afirma e o que aparece no log.
 *
 * É um `throw`, não um `{ok:false}`: as ~120 actions têm formas de retorno heterogêneas (Result,
 * dado puro, void) e uma recusa que se disfarça de retorno normal pode ser ignorada por engano no
 * chamador. Exceção é inescapável — e o operador de verdade nunca a vê, porque o middleware já o
 * mandou para `/login` antes.
 */
export class UnauthenticatedActionError extends Error {
  /** Estável para asserção/log — a mensagem é humana e pode mudar; isto não. */
  readonly code = "AH_ACTION_UNAUTHENTICATED";

  /** Qual das duas recusas — ver {@link ActionRefusalReason}. */
  readonly reason: ActionRefusalReason;

  constructor(
    readonly action: string,
    reason: ActionRefusalReason = "no-session",
    detail?: string,
  ) {
    super(
      reason === "no-session"
        ? `ação "${action}" recusada: sem sessão do AgileHarness — faça login`
        : `ação "${action}" recusada: não foi possível provar a origem da chamada${detail ? ` (${detail})` : ""}`,
    );
    this.name = "UnauthenticatedActionError";
    this.reason = reason;
  }
}

/**
 * `true` quando a exceção é o SINAL do Next de "esta rota é dinâmica", não a ausência de request.
 *
 * O que isto impede: engolir o bail-out que o App Router usa para desistir do render estático. Se
 * `cookies()` estourar durante uma tentativa de prerender e nós tratássemos isso como "chamada
 * interna", a página seria congelada como estática — e a ação passaria a rodar sem nunca ver cookie.
 * Re-lançamos, então o Next segue fazendo o que faria sem este guard.
 *
 * Fonte: `next/dist/client/components/hooks-server-context.js` — `DynamicServerError.digest`.
 */
function isDynamicUsageBailout(e: unknown): boolean {
  const digest = (e as { digest?: unknown } | null | undefined)?.digest;
  return typeof digest === "string" && digest.startsWith("DYNAMIC_SERVER_USAGE");
}

/**
 * As DUAS metades da frase que o Next usa para dizer "fora de request" — o sinal POSITIVO.
 *
 * Fonte exata (Next 14.2.35, `next/dist/client/components/request-async-storage.external.js`):
 *   throw new Error("`" + callingExpression + "` was called outside a request scope. " +
 *                   "Read more: https://nextjs.org/docs/messages/next-dynamic-api-wrong-context")
 *
 * Exigimos as duas metades (a frase E o slug do doc) porque cada uma sozinha é fraca: a frase pode
 * aparecer numa mensagem futura qualquer, e o slug é um identificador PÚBLICO e versionado de erro
 * do Next. Se um upgrade mudar qualquer uma delas, `action-guard.test.ts` fica vermelho — ele
 * produz o erro chamando a função REAL do Next instalado, então a quebra aparece na bancada, não em
 * produção. E a direção da quebra é segura: deixamos de reconhecer o chamador interno (recusa
 * barulhenta) em vez de passar a reconhecer um atacante.
 */
const OUTSIDE_SCOPE_PHRASE = "was called outside a request scope";
const OUTSIDE_SCOPE_DOC = "next-dynamic-api-wrong-context";

/**
 * A exceção é, POSITIVAMENTE, o "fora de request scope" do Next?
 *
 * O QUE ESTA CHECAGEM IMPEDE: que um erro genérico vindo de DENTRO de um render (o `Error` do
 * `unstable_cache`, o Invariant do postpone) seja lido como ausência de request — o veredito que
 * PERMITE. Além das duas metades da frase, recusa qualquer coisa que carregue marcador de
 * control-flow de framework (`digest` do Next, `code` do StaticGenBailoutError, `$$typeof` do
 * postpone do React): esses objetos NUNCA falam sobre a origem do chamador.
 */
function isOutsideRequestScopeThrow(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const marked = e as unknown as { digest?: unknown; code?: unknown; $$typeof?: unknown };
  if (marked.digest !== undefined || marked.code !== undefined || marked.$$typeof !== undefined) return false;
  return e.message.includes(OUTSIDE_SCOPE_PHRASE) && e.message.includes(OUTSIDE_SCOPE_DOC);
}

/** O que uma exceção de `cookies()` PROVA sobre a origem da chamada. */
export type ScopeVerdict =
  /** prova POSITIVA de "não estou dentro de uma request" — a única porta para `in-process`. */
  | "outside-request"
  /** protocolo do Next (bail-out dinâmico): re-lançar intacto, não classifica ninguém. */
  | "framework-signal"
  /** não prova nada ⇒ NEGA. */
  | "unverifiable";

/** Os fatos independentes que {@link classifyScopeThrow} pesa. `null` = fato indisponível. */
export interface ScopeEvidence {
  /** o que `cookies()` lançou. */
  readonly thrown: unknown;
  /** o AsyncLocalStorage de REQUEST do Next tem store agora? */
  readonly hasRequestStore: boolean | null;
  /** o AsyncLocalStorage de STATIC GENERATION do Next tem store agora? */
  readonly hasStaticStore: boolean | null;
}

/**
 * O KERNEL da decisão — puro, para o teste poder montar combinações que o processo de teste não
 * consegue produzir (dentro do vitest o ALS do Next é o `FakeAsyncLocalStorage`, cujo `getStore()`
 * devolve sempre `undefined` e cujo `run()` estoura).
 *
 * A régua é fail-closed: `outside-request` exige TRÊS fatos concordando, e a ausência de qualquer um
 * deles recusa. Nenhum fato é redundante — cada um mata um caminho de throw diferente:
 *
 *  • `hasRequestStore === true` ⇒ existe request. Os caminhos (2), (3) e (4) do cabeçalho estouram
 *    ANTES de o Next procurar o request store (em `trackDynamicDataAccessed`), então é possível ter
 *    um throw de `cookies()` COM request vivo — e chamar isso de "sem request" é a contradição que
 *    abria o buraco. Divergência entre os dois oráculos NUNCA vira permissão.
 *  • `hasStaticStore === true` ⇒ estamos dentro de um render/cache scope (é ali que os caminhos (2),
 *    (3) e (4) vivem: todos exigem `staticGenerationStore`). Uma chamada interna de verdade — timer,
 *    `fs.watch`, teste — não tem nenhum dos dois stores.
 *  • a FORMA da exceção ({@link isOutsideRequestScopeThrow}) ⇒ o sinal afirmativo do Next. É o fato
 *    que segura o caso em que os dois oráculos estão indisponíveis (`null`).
 */
export function classifyScopeThrow({ thrown, hasRequestStore, hasStaticStore }: ScopeEvidence): ScopeVerdict {
  if (isDynamicUsageBailout(thrown)) return "framework-signal";
  if (hasRequestStore === true || hasStaticStore === true) return "unverifiable";
  return isOutsideRequestScopeThrow(thrown) ? "outside-request" : "unverifiable";
}

/** Os dois oráculos de escopo do Next, já reduzidos a perguntas sim/não/não-sei. */
interface ScopeOracle {
  hasRequestStore(): boolean | null;
  hasStaticStore(): boolean | null;
}

/**
 * Reduz um módulo `*-async-storage.external` do Next a "tem store?".
 *
 * O sufixo `.external` não é decoração: o webpack do Next marca esses módulos como externos
 * justamente para que exista UMA instância do AsyncLocalStorage compartilhada entre o runtime do
 * App Router e o código do app — é por isso que perguntar aqui responde sobre o request de verdade.
 * (`next/dist/build/handle-externals.js`: `externalFileEnd = "(\.external(\.js)?)$"`, casado contra o
 * caminho RESOLVIDO — por isso o especificador aqui pode terminar em `.js` sem perder a partilha.)
 *
 * Qualquer surpresa (módulo ausente num upgrade, export renomeado, `getStore` estourando) devolve
 * `null` = "não sei", nunca `false`: um oráculo quebrado não pode AFIRMAR ausência de request. Com
 * `null` a decisão passa a depender só da forma da exceção, que continua sendo fail-closed.
 */
function alsProbe(mod: unknown, key: string): () => boolean | null {
  const als = (mod as Record<string, { getStore?: () => unknown } | undefined> | null)?.[key];
  const getStore = als?.getStore;
  if (typeof getStore !== "function") return () => null;
  return () => {
    try {
      return getStore.call(als) !== undefined;
    } catch {
      return null;
    }
  };
}

/**
 * Como {@link alsProbe}, mas a pergunta é "a store corrente é de REQUEST?" e não "existe store?".
 *
 * Existe porque no Next 15 uma ÚNICA store cobre request, cache e prerender, distinguidos por
 * `type`. Qualquer surpresa — módulo ausente, export renomeado, store sem `type`, `getStore`
 * estourando — devolve `null` ("não sei"), NUNCA `false`: um oráculo quebrado não pode afirmar
 * ausência de request, porque `false` em ambos os oráculos é o que libera o caminho permissivo.
 */
function alsTipoRequest(mod: unknown, key: string): () => boolean | null {
  const als = (mod as Record<string, { getStore?: () => unknown } | undefined> | null)?.[key];
  const getStore = als?.getStore;
  if (typeof getStore !== "function") return () => null;
  return () => {
    try {
      const store = getStore.call(als);
      if (store === undefined || store === null) return false; // sem store ⇒ comprovadamente sem request
      const tipo = (store as { type?: unknown }).type;
      return typeof tipo === "string" ? tipo === "request" : null; // sem `type` ⇒ não sei
    } catch {
      return null;
    }
  };
}

let oraclePromise: Promise<ScopeOracle> | null = null;

/** Carrega (uma vez por processo) os oráculos de escopo. Nunca lança — ver {@link alsProbe}. */
function loadScopeOracle(): Promise<ScopeOracle> {
  oraclePromise ??= (async () => {
    // NEXT 15 FUNDIU OS DOIS ORÁCULOS, E COPIAR A PERGUNTA ANTIGA ABRIRIA UM BURACO. No 14 havia um
    // ALS de REQUEST e um de STATIC GENERATION, e "tem store?" respondia a pergunta certa em cada um.
    // No 15 o de request virou `workUnitAsyncStorage`, cuja store é união DISCRIMINADA por `type` —
    // MEDIDO no fecho (next@15.5.21, work-unit-async-storage.external.d.ts): 'request' convive com
    // 'cache', 'private-cache', 'unstable-cache' e cinco variantes de 'prerender'. Perguntar só "tem
    // store?" AFIRMARIA request dentro de um `use cache`, que é a contradição que este portão existe
    // para não cometer. Por isso aqui se pergunta `type === "request"`, e não presença.
    // O antigo staticGeneration tem sucessor 1:1: `workAsyncStorage` (WorkStore), presente em
    // qualquer escopo de render/cache — ali "tem store?" continua sendo a pergunta certa.
    // Os caminhos são os do 15 e NÃO existem no 14; num downgrade o `catch` devolve null e a régua
    // cai para a forma da exceção, que é fail-closed — nunca para "não há request".
    const [wu, wk] = await Promise.all([
      import("next/dist/server/app-render/work-unit-async-storage.external.js").catch(() => null),
      import("next/dist/server/app-render/work-async-storage.external.js").catch(() => null),
    ]);
    return {
      hasRequestStore: alsTipoRequest(wu, "workUnitAsyncStorage"),
      hasStaticStore: alsProbe(wk, "workAsyncStorage"),
    };
  })();
  return oraclePromise;
}

/** O que se conseguiu estabelecer sobre o request corrente. */
type RequestScope =
  | { readonly kind: "in-request"; readonly cookie?: string }
  | { readonly kind: "outside-request" }
  | { readonly kind: "unverifiable"; readonly why: string };

/** Nome curto e sem conteúdo do que foi lançado — entra na mensagem de recusa, então nada de payload. */
function shapeOf(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.name || "Error";
  return thrown === null ? "null" : typeof thrown;
}

/**
 * O cookie de sessão do request corrente — ou a prova POSITIVA de que não há request algum.
 *
 * `next/headers` entra por import DINÂMICO de propósito: este módulo é alcançado por
 * `src/app/*-actions.ts`, que a suíte unitária importa direto (sem servidor Next). Um import estático
 * de `next/headers` acoplaria toda essa suíte ao carregamento do runtime do App Router.
 *
 * `cookies()` que RESOLVE já é prova de que há request (o Next só devolve depois de achar o request
 * store). No Next 15 ele é ASSÍNCRONO: o que antes era throw síncrono agora é REJEIÇÃO, e o `await`
 * dentro do `try` a entrega ao mesmo `catch` — a análise por forma do lançado não muda.
 * `cookies()` que ESTOURA não prova nada por si — quem decide é {@link classifyScopeThrow}.
 */
async function resolveRequestScope(): Promise<RequestScope> {
  let headersMod: typeof import("next/headers");
  try {
    headersMod = await import("next/headers");
  } catch {
    // Caminho (5): o módulo que lê o cookie não carregou. Nenhum fato foi estabelecido sobre o
    // chamador — e "não sei" jamais pode virar "é o próprio serviço".
    return { kind: "unverifiable", why: "next/headers não carregou" };
  }

  try {
    return { kind: "in-request", cookie: (await headersMod.cookies()).get(SESSION_COOKIE)?.value };
  } catch (thrown) {
    const oracle = await loadScopeOracle();
    const verdict = classifyScopeThrow({
      thrown,
      hasRequestStore: oracle.hasRequestStore(),
      hasStaticStore: oracle.hasStaticStore(),
    });
    if (verdict === "framework-signal") throw thrown;
    if (verdict === "outside-request") return { kind: "outside-request" };
    return { kind: "unverifiable", why: `cookies() lançou ${shapeOf(thrown)} fora do sinal de "sem request"` };
  }
}

/** O veredito completo — o chamador, ou a recusa com o seu motivo. */
type CallerVerdict =
  | { readonly caller: ActionCaller }
  | { readonly caller: null; readonly reason: ActionRefusalReason; readonly why?: string };

async function resolveCallerVerdict(now?: number): Promise<CallerVerdict> {
  // 1º o ator MCP: ele é o chamador cuja prova já foi feita (token timing-safe na rota) e que NUNCA
  // terá cookie. Checá-lo antes evita que um agente headless dependa de um cookie que não existe.
  if (currentMcpActor() != null) return { caller: "mcp-token" };

  const scope = await resolveRequestScope();
  if (scope.kind === "unverifiable") return { caller: null, reason: "unverifiable-scope", why: scope.why };
  if (scope.kind === "outside-request") return { caller: "in-process" };

  const ok = await verifySession({ token: scope.cookie, ...authSecretsFromEnv(), now });
  return ok ? { caller: "operator-session" } : { caller: null, reason: "no-session" };
}

/**
 * Quem está chamando — ou `null` quando a chamada é RECUSADA (request HTTP sem sessão válida, ou
 * origem que não se conseguiu provar).
 *
 * Separada de {@link requireSession} para ser testável e para um chamador que precise DECIDIR (e não
 * abortar) poder ler o veredito sem catch. O bail-out dinâmico do Next continua SUBINDO por aqui
 * (não é veredito, é protocolo do framework — ver {@link isDynamicUsageBailout}).
 */
export async function resolveActionCaller(now?: number): Promise<ActionCaller | null> {
  return (await resolveCallerVerdict(now)).caller;
}

/**
 * A PRIMEIRA linha de toda Server Action. Deixa passar os três chamadores legítimos; lança
 * {@link UnauthenticatedActionError} para um request HTTP sem sessão válida — e para qualquer
 * chamada cuja origem não se consiga PROVAR.
 *
 * Fail-closed pelos dois lados: segredo ausente/fraco, cookie ausente, assinatura errada, sessão
 * expirada e token do operador rotacionado caem todos no MESMO `false` de `verifySession` (um
 * serviço mal inicializado tranca as ações em vez de abri-las); e uma origem indeterminada recusa
 * com `reason: "unverifiable-scope"` em vez de ser promovida a chamada interna.
 *
 * @param action nome da action, só para a mensagem/log nomear quem recusou.
 */
export async function requireSession(action: string): Promise<ActionCaller> {
  const verdict = await resolveCallerVerdict();
  if (verdict.caller) return verdict.caller;
  throw new UnauthenticatedActionError(action, verdict.reason, verdict.why);
}
