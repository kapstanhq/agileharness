// Remote MCP endpoint for the AgileHarness board — the server side of the Claude "custom
// connector". A single dynamic `[transport]` segment (Streamable HTTP → `mcp`) is fronted by a
// `[secret]` segment that carries a capability credential in the URL path.
//
// WHY a path credential (not OAuth / not a bearer header): Claude's WEB custom connector connects
// FROM Anthropic's cloud (not the phone), so the server must be on the public internet — and the
// connector UI does NOT let you paste a static bearer header (only OAuth client id/secret). A long
// random value in the URL path is the pragmatic single-user guard: the connector preserves the exact
// URL you paste, so the credential rides along on every request. The endpoint runs over HTTPS via the
// Cloudflare tunnel. This is capability-URL security — good enough for one operator; upgrade to
// OAuth 2.1 if the surface ever widens.
//
// ── O QUE UMA CREDENCIAL NO PATH JÁ CUSTOU, MEDIDO (story-h8tmzh / story-u4yf1i) ─────────────────
//
// 174 gravações do token em texto claro — 168 no journal do Caddy, 6 em `/var/log/syslog*` — entre
// 2026-06-06 e 2026-07-29, pelo logger de ERRO DEFAULT do Caddy, que registra o URI inteiro. Não
// houve misconfiguração: enquanto a credencial FOR o path, todo intermediário tem a oportunidade de
// gravá-la, e o default de um deles já gravou. O path não pode simplesmente sair (o conector do chat
// web não tem outro carregador), então o que muda é a CONTENÇÃO do que vaza.
//
// Por isso `resolveActor` aceita DUAS formas, nesta ordem (`lib/auth/mcp-handle.ts`):
//
//   1. HANDLE opaco `ahk_<id-público>.<segredo>` — REVOGÁVEL na hora (o registro é relido a cada
//      resolução, então revogar corta o acesso no request seguinte, sem o restart que o guardrail do
//      projeto proíbe — e é por isso que a rotação do env var estava, na prática, TRAVADA),
//      ESCOPÁVEL (o handle carrega o próprio nível, então o que vaza no log pode não ser a autoridade
//      máxima) e DESACOPLADO das 4 rotas do runner. Emitir `full` continua permitido: contenção que
//      custasse autonomia estaria errada.
//   2. TOKEN LEGADO do env (`STORYMAP_MCP_TOKEN` e os escopados de `settings.mcpTokens`), com a MESMA
//      ordem de resolução de sempre. Isto NÃO é cortesia: é o que o conector do dono usa hoje, e
//      quebrá-lo seria remoção de capacidade disfarçada de hardening.
//
// O handle NÃO compra sigilo em trânsito (o path segue logável) nem defesa contra quem lê o log ANTES
// da revogação. A janela de dano deixa de ser "até o próximo restart autorizado" e passa a ser "até o
// operador clicar".
//
// SECURITY POSTURE: a wrong/missing/revoked/weak credential returns a bare 404 (indistinguishable
// from a non-existent route — never confirm the endpoint exists), inclusive quando a origem está
// TRANCADA (a trava não pode ser o oráculo que a recusa se recusa a ser: nada de `Retry-After` aqui).
// Um token legado só autentica se o segredo CONFIGURADO clear EVERY floor in `secretWeakness`
// (mcp/auth.ts): >= 32 chars, not the repetition of a short motif, >= 10 distinct chars and >= 64 bits
// of Shannon entropy. It used to be a bare 24-character length and nothing else — a floor a memorable
// typed string clears, on the most exposed secret in the system. (The old number is spelled out in
// prose ON PURPOSE: `security-claims.test.ts` asserts that every `>= N chars` written in this header
// equals the real MIN_TOKEN_LEN, so quoting the stale claim in that FORM would make the guard fire on
// its own history.)
//
// A RECUSA DEIXOU DE SER CEGA. Este cabeçalho dizia, com orgulho, que a autenticação falhava "with
// nothing logged" — e era verdade: seis tentativas com credencial errada não produziam UMA linha, então
// uma invasão em curso era 100% invisível (sem fonte de log não existe detecção de varredura, e a
// pergunta "alguém usou a credencial vazada na janela?" não tinha resposta). Hoje toda falha passa por
// `lib/auth/auth-audit.ts`: trava progressiva por origem + rastro durável em JSONL. A RESPOSTA não
// mudou — 404 nu, sempre —, o registro é do lado de DENTRO.
//
// "The endpoint can never be accidentally left OPEN" is a TRUE statement again, and the reason is worth
// knowing before anyone "improves" it: NOTHING generates this token (story-7q83gx, wave 2 — see the
// header of mcp/token-bootstrap.ts) e nada emite handle no boot (mcp-handle.ts, mesmo princípio).
// Declarar a env var — ou emitir um handle — é a ÚNICA forma de armar esta porta; uma instalação que
// não faz nem um nem outro não tem superfície MCP alguma. Auto-generating at boot — which wave 1
// briefly did — would make every install be born with the door EXISTING, which is what made this very
// sentence false.
//
// The MCP tools spawn `claude --dangerously-skip-permissions` on this machine, so this guard is the
// only thing between the public URL and full autonomy over the repo — keep the credential secret and
// never commit it. Need one? `node dist/ah-server.mjs --generate-mcp-token` prints a strong token (and
// writes it 0600); um handle sai de `createMcpHandle` (`lib/auth/mcp-handle.ts`).

import { createMcpHandler } from "mcp-handler";
import {
  PERIMETER_SURFACES,
  guardPerimeter,
  stanceOfSurface,
  type AuthFailureReason,
  type PerimeterValidation,
} from "@/lib/auth/auth-audit";
import { mcpActorLabel, resolveMcpCredential, type McpCredential } from "@/lib/auth/mcp-handle";
import { isMcpTokenValid } from "@/lib/storymap/mcp/auth";
import { decodeRouteParam } from "@/lib/storymap/deep-links";
import { registerStorymapTools } from "@/lib/storymap/mcp/tools";
import { registerDevTools } from "@/lib/storymap/mcp/dev-tools";
import { registerOnboarding, STORYMAP_MCP_INSTRUCTIONS } from "@/lib/storymap/mcp/onboarding";
import { registerResources } from "@/lib/storymap/mcp/resources";
import { setServerLevel } from "@/lib/storymap/mcp/register";
import { runWithMcpActor, type McpActor } from "@/lib/storymap/mcp/actor";
import type { McpLevel } from "@/lib/storymap/types";

// Tools touch the filesystem + the runner engine singleton (child_process), so this
// route MUST run on the Node.js runtime, never the edge runtime. Never cache it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * F6 — o TETO de uma chamada, alinhado ao que as tools desta superfície realmente fazem.
 *
 * Estava em 60s enquanto `wait_for_run`/`wait_for_submit`/`wait_for_session_idle` já nasciam com DEFAULT
 * de 120s e teto de 600s, e `run_check`/`run_task` aceitam 600s. Ou seja: a rota declarava um limite que
 * a sua própria superfície cruzava no caminho FELIZ — as esperas bloqueantes, que são exatamente as
 * primitivas de autonomia (o substituto do repolling). No servidor standalone de hoje o número é inerte
 * (`maxDuration` é contrato de plataforma serverless, e o `maxDuration` do mcp-handler só arma no caminho
 * SSE, que está desligado), então a contradição nunca mordeu — mas um número que só está certo por não
 * ser lido é uma armadilha para quem publicar isto de outro jeito. Uma constante, os dois lugares.
 *
 * ⚠️ Isto NÃO governa o intermediário. O conector remoto entra por túnel/proxy, e um proxy com teto
 * próprio (tipicamente ~100s) corta a espera ANTES daqui — por isso as tools de espera devolvem
 * `timeout` como um estado NORMAL ("re-chame para continuar esperando") em vez de erro.
 * O NEXT 15 LÊ ESTA LINHA ESTATICAMENTE, e por isso o número é LITERAL aqui. No 14 dava para
 * exportar uma constante (`export const maxDuration = MAX_TOOL_CALL_SECONDS`); no 15 o analisador
 * de segment config recusa o que não consegue avaliar sem executar — `Unknown identifier
 * "MAX_TOOL_CALL_SECONDS" at "maxDuration"` — e o BUILD falha. Nem o typecheck nem a suíte pegam
 * isso: só o build. A intenção do parágrafo acima ("uma constante, os dois lugares") continua
 * valendo, só que invertida — a EXPORTAÇÃO é a constante, e o call-site abaixo a reusa.
 */
export const maxDuration = 600;

type RouteCtx = { params: Promise<{ secret: string; transport: string }> };

/** O PATH canônico desta superfície no perímetro — nunca `req.url`, que hoje carrega a credencial. */
const SURFACE = PERIMETER_SURFACES.mcp;

/** O veredito da porta. `credential` diz QUAL caminho entrou (handle × token legado). */
type ActorResolution =
  | { ok: true; actor: McpActor; credential: McpCredential }
  | { ok: false; reason: AuthFailureReason; handleId?: string };

/**
 * Resolve a credencial do path a uma AUTORIDADE MCP — ou nomeia o motivo da recusa (para o rastro; a
 * resposta é 404 nu em todos os casos).
 *
 * A resolução em si vive em `lib/auth/mcp-handle.ts` (uma verdade só: handle primeiro, token legado
 * depois, na ordem de sempre; e um handle REVOGADO não cai para o legado, senão a revogação viraria
 * "tenta o outro caminho" e o sinal de vazamento em uso desapareceria).
 */
async function resolveActor(presented: string): Promise<ActorResolution> {
  const r = await resolveMcpCredential(presented);
  if (!r.ok) return r;
  const c = r.credential;

  // ÚLTIMO PORTÃO — o piso de FORÇA é re-afirmado aqui, depois de a resolução ter saído deste arquivo.
  //
  // O que este re-check IMPEDE: que a superfície que spawna `claude --dangerously-skip-permissions`
  // autentique um segredo que os pisos de `secretWeakness` recusam, se a resolução deixar de aplicá-los
  // — e o buraco é concreto, não hipotético: `resolveMcpCredential` aceita um MAPA DE AMBIENTE
  // injetado, então uma edição que passe o mapa errado autenticaria contra um segredo que não é o deste
  // serviço. Quem decide por REQUISIÇÃO continua sendo `isMcpTokenValid`, contra o `process.env` daqui.
  // É a mesma defesa em profundidade que `mcp/auth.ts` já pratica contra um processo subido por outro
  // entrypoint. Custo: uma comparação em tempo constante por requisição autenticada. Não alcança
  // handle — ali não há env atrás, e o portão é o digest do par id+segredo.
  if (c.via === "token-legado" && !isMcpTokenValid(presented, process.env[c.tokenEnv ?? ""])) {
    return { ok: false, reason: "token-fraco" };
  }

  return {
    ok: true,
    credential: c,
    // ATRIBUIÇÃO (story-et6a4j): `tokenEnv` é o campo que o guard por chamada grava como `actor` no
    // ledger `agent-actions`. Token legado mantém o NOME DA ENV cru — `noop-attribution.ts` casa esse
    // campo por IGUALDADE com o tokenEnv do run, e trocá-lo por um rótulo quebraria a atribuição do
    // copiloto. Handle entra como `handle:<id>` (`mcpActorLabel`): identifica a credencial usada sem
    // carregar um byte de segredo, que é o que faz um incidente ser reconstruível.
    actor: { level: c.level, tokenEnv: c.via === "handle" ? mcpActorLabel(c) : c.tokenEnv },
  };
}

// The handler is built once per credential (effectively once per dev-server life for the env token) —
// registering the tool set on every request would be wasteful. 6.5 — keyed by basePath in a MAP (was a
// single slot): with a `full` and a `write` credential both live, the single slot thrashed AND — now
// that the tool surface depends on the level — could serve a handler built for the WRONG level. Each
// credential's basePath is distinct, so its handler (with its own baked-in level) is cached
// independently. Só credencial JÁ autenticada chega aqui, então o mapa não cresce por tentativa.
const handlerCache = new Map<string, (req: Request) => Promise<Response>>();

function handlerFor(secret: string, level: McpLevel): (req: Request) => Promise<Response> {
  // basePath = everything BEFORE the [transport] segment, so mcp-handler derives the
  // streamable endpoint as `${basePath}/mcp` = /api/usm/<credencial>/mcp (what you paste).
  const basePath = `/api/usm/${secret}`;
  const cached = handlerCache.get(basePath);
  if (cached) return cached;
  const handler = createMcpHandler(
    (server) => {
      setServerLevel(server, level); // 6.5 — stamp BEFORE registering so defineTool filters this build by level
      registerOnboarding(server); // first, so it surfaces at the top of the tool list
      registerStorymapTools(server);
      registerDevTools(server);
      // Os MCP *resources* (contexto endereçável, ao lado das tools). Registrar AQUI, dentro do callback
      // de construção, não é detalhe: `registerResource` declara a capacidade `resources` no servidor, e
      // o SDK LANÇA se uma capacidade for declarada depois que o transport conectou. Este callback roda
      // antes do connect; registrar preguiçosamente de dentro de um handler de tool quebraria.
      registerResources(server);
    },
    // `instructions` ride in the MCP initialize response → every client sees the mental
    // model + rules before the first tool call (the canonical fix for "the agent feels lost").
    { serverInfo: { name: "storymap", version: "0.2.3" }, instructions: STORYMAP_MCP_INSTRUCTIONS },
    // Stateless Streamable HTTP (no sessionIdGenerator) → no Redis needed; SSE is
    // disabled (removed from the MCP spec since 2025-03-26 and the source of the
    // Redis requirement we deliberately avoid).
    { basePath, maxDuration, disableSse: true, verboseLogs: false },
  );
  handlerCache.set(basePath, handler);
  return handler;
}

async function handle(req: Request, ctx: RouteCtx): Promise<Response> {
  // Next does not decode App-Router params. A credencial é comparada byte a byte (contra a env ou
  // contra um digest), então um valor que carregue algo URL-unsafe (um `+` ou `/` de base64, um `:`)
  // chega percent-encodado, falha a comparação, e esta rota responde 404 BY DESIGN. Decodificar aqui é
  // o que mantém "colei a credencial certa" e "funcionou" como a mesma afirmação.
  const rota = await ctx.params;
  const presented = decodeRouteParam(rota?.secret ?? "");

  // O PORTÃO. A ordem é o controle: COMPARA a credencial → só então a trava decide.
  //
  // ⚠️ A ordem inversa (trava → compara) era um interruptor de DoS contra o próprio dono. O balde é UM
  // por origem para o perímetro INTEIRO — seis baldes deixariam o atacante rotacionar de rota e
  // multiplicar o orçamento por seis —, e em três topologias REAIS o atacante e o dono dividem a MESMA
  // chave: self-host sem proxy (todos caem em `sem-proxy`), NAT compartilhado e CDN na frente do Caddy.
  // Bastava um anônimo martelar 8 vezes qualquer superfície para o conector do chat web do dono levar
  // 404 com a credencial CERTA na mão, por até 60 minutos, de graça. Isto é REMOÇÃO DE CAPACIDADE, o
  // desfecho proibido — e nesta rota ela desliga a superfície MCP inteira, que é a autonomia do agente.
  //
  // Os headers entram como estão: eles não autenticam nada, servem só para derivar a chave da trava
  // DENTRO do módulo (o chamador não pode escolhê-la). A postura `muda` sai do mapa canônico
  // (`stanceOfSurface`) e não de um literal daqui: 404 nu, sem `Retry-After` — a trava não pode
  // confirmar a existência do endpoint que a recusa nega, então recusa por credencial e recusa por trava
  // são o MESMO byte. As 4 rotas do runner usam `declarada` (429) porque já admitem existir.
  const portao = await guardPerimeter<McpActor>({
    headers: req.headers,
    surface: SURFACE,
    via: "path",
    stance: stanceOfSurface(SURFACE),
    // CRU: o mascaramento acontece dentro do módulo, para nenhum byte de credencial acabar no nosso
    // próprio arquivo forense — foi assim que o log do proxy juntou 174 linhas.
    presented,
    // Roda SEMPRE e PRIMEIRO, inclusive com a origem trancada. Sem try/catch defensivo de propósito:
    // `guardPerimeter` trata um comparador que lança como tentativa inválida (conta na trava, grava
    // `erro-na-comparacao` e responde com a MESMA mudez), e engolir a exceção aqui reabriria o canal de
    // sondagem invisível que o portão fechou. O rastro nomeia o motivo (handle revogado ≠ scanner ≠
    // porta fechada por setup), que é o que separa "estou sendo varrido" de "meu conector nunca vai
    // funcionar".
    validate: async (): Promise<PerimeterValidation<McpActor>> => {
      const resolvido = await resolveActor(presented);
      if (resolvido.ok) return { valid: true, value: resolvido.actor };
      return {
        valid: false,
        reason: resolvido.reason,
        ...(resolvido.handleId ? { handleId: resolvido.handleId } : {}),
      };
    },
  });
  // Credencial válida já PERDOOU a janela desta origem dentro do portão. É o que impede que o operador
  // que colou um token velho três vezes carregue um backoff dobrado depois de acertar — e não abre
  // bypass: quem acertou já tem exatamente o que a trava protegia.
  if (!portao.ok) return portao.response;

  // F5.1 — corre o handler DENTRO do contexto do ator: o guard por chamada (5.2) e a atribuição do ledger
  // (moveCardAction/acceptTriage) leem currentMcpActor() na cadeia async deste request. handlerFor continua
  // cacheado por level (a superfície montada não muda por request); a identidade vem do ALS, não do cache.
  const actor = portao.value;
  return runWithMcpActor(actor, () => handlerFor(presented, actor.level)(req));
}

// Streamable HTTP uses POST for calls, GET for stream resumption, DELETE to end a
// session. All route through the same guarded handler.
//
// ⚠️ ESTA FORMA DE EXPORT É UMA ISENÇÃO EXPLÍCITA DE LINT, E A ISENÇÃO TEM PREMISSA.
// `src/app/safe-methods-readonly.test.ts` varre todo `src/app/**/route.ts` e ACUSA um
// handler GET/HEAD que mute estado (escrita em disco, escritor de card, fila de publish,
// deploy). Um `handle` compartilhado entre GET e POST alcança a superfície INTEIRA de tools
// — spawn, deploy, delete — então cairia nessa varredura. Ele passa por estar em
// `SHARED_IMPL_EXEMPTIONS` por DECISÃO: a credencial é um token de capacidade NO PATH e
// esta rota não lê NENHUMA credencial de ambiente, então o navegador da vítima não anexa
// nada que autentique e CSRF não a alcança (SameSite é irrelevante sem credencial de
// navegador). Separar GET de POST não compraria segurança — o protocolo MCP usa GET para
// retomar stream — e tiraria capacidade do agente.
//
// A premissa CONTINUA valendo depois do rastro de auth: os headers do request são lidos para derivar a
// chave da TRAVA, não para autenticar — nenhum header que um navegador anexe sozinho concede acesso, e
// um GET induzido de outro site continua sem credencial. O único estado que um GET recusado toca é o
// rastro forense (uma linha JSONL), que é o próprio propósito dele e não alcança dado de board.
//
// A ISENÇÃO MORRE no instante em que esta rota passar a autenticar por credencial de
// AMBIENTE (a API de headers do Next, a jarra de cookies, o cookie de sessão, o
// verificador de sessão do middleware): aí o GET volta a ser forjável por navegação
// cross-site e o vetor de CSRF reabre. O lint verifica essa premissa a cada rodada
// (`premise.forbids`) e fica vermelho sozinho — mas ele fica vermelho DO LADO DELE, e quem
// edita esta rota não era avisado aqui. Precisando de credencial de ambiente, o caminho é
// REMOVER a isenção e separar os métodos — nunca relaxar o lint.
//
// ⚠️ E não escreva os nomes proibidos aqui: aquele lint casa os `forbids` contra o arquivo
// INTEIRO, comentário incluído — citá-los literalmente derruba a premissa por menção.
export { handle as GET, handle as POST, handle as DELETE };
