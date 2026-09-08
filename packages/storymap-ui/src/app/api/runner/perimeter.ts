// A PORTA DAS 4 ROTAS `/api/runner/*` — Bearer PREFERIDO, `?secret=` DEPRECADO, trava e rastro em
// toda recusa (story-h8tmzh AC4 + story-m9jflb).
//
// ⚠️ Não é `route.ts`: é um módulo COLOCADO (o App Router só roteia `route.ts`). Mora aqui, junto das
// 4 rotas que o usam, porque é a régua DELAS — e uma régua copiada 4× é uma régua que divergiu em 3
// lugares na próxima mudança.
//
// ── O QUE ESTE MÓDULO IMPEDE ──────────────────────────────────────────────────────────────────
//
//  • CREDENCIAL NA QUERY STRING: as 4 rotas autenticavam SÓ por `?secret=<token>`, a mesma classe de
//    vazamento do token no path — query string entra em log de acesso, em `Referer` e em histórico de
//    proxy. Medido em story-u4yf1i: 174 gravações do token em texto claro pelo logger de ERRO DEFAULT
//    do Caddy. O `Authorization: Bearer` tira a credencial da URL sem pedir nada de ninguém.
//  • RECUSA CEGA: reproduzido ao vivo, 6 GETs a `/api/runner/pulse` com `secret` errado devolveram
//    `401,401,401,401,401,401` e o `journalctl` do mesmo minuto disse `-- No entries --`. Uma invasão
//    em curso era 100% invisível. Agora TODA recusa conta na trava por origem e grava uma linha no
//    rastro durável (`lib/auth/auth-audit.ts`), sem nunca ecoar o valor tentado.
//  • A TRAVA VIRAR ARMA CONTRA O DONO: impede que um anônimo DESLIGUE o monitor autônomo. A trava é um
//    balde por ORIGEM para o perímetro inteiro, e há três topologias reais em que o atacante divide a
//    chave com o dono (self-host sem proxy, NAT de escritório/celular, CDN na frente do Caddy) — então,
//    com a trava consultada ANTES da comparação, 8 chutes em qualquer superfície faziam o `/pulse`
//    responder 429 ao token CERTO por até 60 minutos. Hoje quem decide é `guardPerimeter`: compara
//    primeiro, e credencial válida atravessa a origem trancada (ver `authorizeRunnerRequest`).
//  • ESCALADA POR HANDLE ESCOPADO: o handle revogável (`lib/auth/mcp-handle.ts`) carrega o próprio
//    nível, então um handle `ro` emitido para o monitor ler `/pulse` NÃO pode POSTar num webhook que
//    reverte card e dirige a cascata. Cada superfície declara o nível MÍNIMO que ela exige
//    (`RUNNER_SURFACE_AUTH`); sem isso, emitir um handle de leitura entregaria o pipeline inteiro.
//
// ── COMPATIBILIDADE É REQUISITO ───────────────────────────────────────────────────────────────
//
// `?secret=` CONTINUA autenticando, com o MESMO conjunto de segredos aceitos de antes (só o token
// primário do operador — ver `RUNNER_LEGACY_TIERS`). Existe automação VIVA do dono batendo nessas
// rotas (o monitor autônomo pollando `/pulse`, e o `curl` do self-deploy em `runner/deploy.ts`
// POSTando o settle): exigir que ele reconfigure algo para continuar funcionando seria REMOÇÃO DE
// CAPACIDADE, não hardening. A depreciação é ANUNCIADA (uma linha por superfície por processo, sem o
// valor) para a migração ser decisão dele, no tempo dele.
//
// CUSTO DE AUTONOMIA: ZERO. O token do operador (`full`) atravessa as 4 rotas exatamente como hoje,
// pelos dois carregadores.

import {
  guardPerimeter,
  stanceOfSurface,
  PERIMETER_SURFACES,
  type PerimeterValidation,
  type AuthVia,
} from "@/lib/auth/auth-audit";
import { resolveMcpCredential, type McpCredential, type McpTokenTier } from "@/lib/auth/mcp-handle";
import { MCP_TOKEN_ENV } from "@/lib/storymap/mcp/token-bootstrap";
import { MCP_LEVELS, type McpLevel } from "@/lib/storymap/types";

/**
 * Os tiers LEGADOS que estas 4 rotas aceitam: SÓ o token primário do operador (nível `full`).
 *
 * É exatamente o conjunto de hoje (`isMcpTokenValid(secret, process.env.STORYMAP_MCP_TOKEN)`), e o
 * default de `legacyMcpTokenTiers()` NÃO serve aqui: ele inclui os escopados de `settings.mcpTokens`,
 * e adotá-lo faria um token `ro` do settings passar a abrir `/pulse` e um `orch` a POSTar nos
 * webhooks — ALARGAMENTO silencioso de quem entra, decisão que não é desta mudança. Quem quiser uma
 * credencial reduzida para o monitor emite um HANDLE `ro`, que é revogável sem restart.
 */
const RUNNER_LEGACY_TIERS: McpTokenTier[] = [{ tokenEnv: MCP_TOKEN_ENV, level: "full" }];

/** O nível mínimo que uma superfície exige. `MCP_LEVELS` é ordenado do menos ao mais privilegiado. */
function levelAtLeast(have: McpLevel, need: McpLevel): boolean {
  return MCP_LEVELS.indexOf(have) >= MCP_LEVELS.indexOf(need);
}

export interface RunnerSurfaceAuth {
  /** o PATH canônico (`PERIMETER_SURFACES.*`) — nunca `req.url`, que hoje carrega a credencial. */
  path: string;
  /** o nível MÍNIMO que a credencial precisa ter para esta superfície. */
  minLevel: McpLevel;
}

/**
 * Cada rota do runner com o nível que ela exige — declarado aqui, num lugar só, para as 4 não
 * divergirem.
 *
 * Por que `ro` nas duas de leitura: `/events` e `/pulse` só EXPÕEM o que uma credencial `ro` já
 * alcança pelas tools de leitura do MCP; exigir mais delas não protegeria nada e tiraria do dono a
 * possibilidade de dar ao monitor uma credencial de leitura. Por que `orch` nos dois webhooks: eles
 * MUTAM — revertem card (`revertCardOnDeployFailure`), avançam para terminal (`settleDeploySuccess`) e
 * retomam a cascata (`reportDone`). É o mesmo nível que o MCP exige para dirigir o pipeline, e é o que
 * impede que um handle `ro`/`write` vazado no log de um proxy vire controle do deploy.
 */
export const RUNNER_SURFACE_AUTH = {
  events: { path: PERIMETER_SURFACES.runnerEvents, minLevel: "ro" },
  pulse: { path: PERIMETER_SURFACES.runnerPulse, minLevel: "ro" },
  deployWebhook: { path: PERIMETER_SURFACES.runnerDeployWebhook, minLevel: "orch" },
  testWebhook: { path: PERIMETER_SURFACES.runnerTestWebhook, minLevel: "orch" },
} as const satisfies Record<string, RunnerSurfaceAuth>;

export interface PresentedRunnerCredential {
  value: string;
  via: AuthVia;
}

/**
 * De onde a credencial vem, em ordem de PREFERÊNCIA: `Authorization: Bearer <token>` primeiro,
 * `?secret=` depois.
 *
 * O header vence quando os dois vierem — é o que faz um cliente em migração (que setou os dois) sair
 * da query sem passo extra, e é o que faz a linha de depreciação parar de aparecer sozinha.
 *
 * Um `Authorization` de OUTRO esquema (`Basic …` de um proxy de autenticação na frente, ou de um
 * scanner) NÃO cega a query: sem valor de Bearer, a query volta a ser consultada. Cegar seria uma
 * regressão de capacidade servida de graça a qualquer intermediário que passe a injetar um header —
 * a automação do dono pararia de autenticar sem nada no lado dela ter mudado. Credencial de outro
 * protocolo nunca é interpretada como token.
 *
 * Sem NENHUM dos dois, o carregador registrado no rastro é o que o cliente de fato usou (header, se
 * mandou algum `Authorization`; senão query, o único que a rota já documentava).
 */
export function readRunnerCredential(request: Request): PresentedRunnerCredential {
  const auth = (request.headers.get("authorization") ?? "").trim();
  const bearer = /^Bearer[ \t]+(.+)$/i.exec(auth);
  if (bearer) return { value: bearer[1]!.trim(), via: "header" };
  const secret = (new URL(request.url).searchParams.get("secret") ?? "").trim();
  if (secret) return { value: secret, via: "query" };
  return { value: "", via: auth ? "header" : "query" };
}

/** As superfícies que já avisaram sobre a query neste processo — ver `warnQueryDeprecatedOnce`. */
const avisadas = new Set<string>();

/**
 * Anuncia a DEPRECIAÇÃO da query — uma vez por superfície por processo, e SÓ quando ela autenticou.
 *
 * Uma linha por request afogaria o journal (o monitor polla `/pulse` continuamente) e o operador
 * pararia de ler; uma linha por TENTATIVA daria ao atacante uma torneira de log. Avisar só no sucesso
 * mantém o aviso endereçado a quem pode agir: o dono, sobre a automação DELE. O valor nunca aparece.
 */
function warnQueryDeprecatedOnce(surfacePath: string): void {
  if (avisadas.has(surfacePath)) return;
  avisadas.add(surfacePath);
  console.warn(
    `[runner-auth] ${surfacePath}: autenticou por \`?secret=\` — carregador DEPRECADO (a query string ` +
      `vaza em log de acesso, em Referer e em histórico de proxy). Migre para o header ` +
      `\`Authorization: Bearer <token>\`; a query segue funcionando e nada quebra hoje.`,
  );
}

/** TEST SEAM — reabre o aviso de depreciação (é também o que um restart do serviço faz). */
export function resetQueryDeprecationNotice(): void {
  avisadas.clear();
}

export type RunnerAuthOutcome =
  | { ok: true; credential: McpCredential; via: AuthVia }
  /** a rota devolve ESTA resposta e para — 401 muda, ou 429 com `Retry-After` quando trancada. */
  | { ok: false; response: Response };

/**
 * Autoriza um request de rota do runner. ORDEM: COMPARA a credencial → só então a trava decide.
 *
 * ⚠️ A ORDEM É O CONTROLE, e a inversão dela era um DoS contra o próprio dono. A trava é UM balde por
 * ORIGEM para o perímetro inteiro (é o que impede o atacante de rotacionar de superfície e multiplicar
 * o orçamento por seis), e existem três topologias REAIS em que o atacante e o dono dividem a MESMA
 * chave: self-host sem proxy (todos caem em `sem-proxy`), NAT compartilhado (escritório, celular) e CDN
 * na frente do Caddy (o último salto passa a ser o proxy). Consultando a trava ANTES da comparação,
 * bastava um anônimo martelar 8 vezes qualquer superfície para o monitor autônomo do dono — que polla
 * `/pulse` continuamente — passar a levar 429 com o token CERTO na mão, sem nada do lado dele ter
 * mudado. Hoje quem decide é `guardPerimeter`: credencial VÁLIDA sempre passa e ZERA o balde; só
 * tentativa INVÁLIDA conta e é recusada.
 *
 * O que isso NÃO é: a barreira contra ADIVINHAÇÃO. Um chute certo durante o bloqueio entra, por
 * desenho — a barreira ali é o segredo de 32 bytes (256 bits, força bruta inviável). A trava encarece,
 * nega serviço a quem martela e produz o rastro.
 *
 * A RESPOSTA continua sendo a de antes — 401 nu, que não confirma nem nega nada além do que a rota já
 * admitia — EXCETO quando a origem está trancada: aí é 429 + `Retry-After`, a postura `declarada`.
 * Ela é correta justamente porque estas 4 rotas JÁ respondiam 401: elas admitem existir, então o 429
 * não conta nada novo e ensina o cliente legítimo do dono a esperar em vez de martelar. (A rota MCP,
 * que responde 404 nu, usa a postura `muda` — quem tranca não pode ser o oráculo que a recusa se
 * recusa a ser.) A postura sai de `stanceOfSurface`, não de um literal daqui: uma superfície que
 * divergisse da postura declarada no mapa canônico é divergência silenciosa.
 */
export async function authorizeRunnerRequest(
  request: Request,
  surface: RunnerSurfaceAuth,
): Promise<RunnerAuthOutcome> {
  const apresentada = readRunnerCredential(request);

  const portao = await guardPerimeter<McpCredential>({
    headers: request.headers,
    surface: surface.path,
    via: apresentada.via,
    stance: stanceOfSurface(surface.path),
    // Cru de propósito: o mascaramento (`maskSecret` — só o COMPRIMENTO sai) acontece dentro do ledger.
    // Mascarar aqui daria a cada chamador a chance de inventar a própria régua.
    presented: apresentada.value,
    levelWanted: surface.minLevel,
    // Roda SEMPRE e PRIMEIRO, inclusive com a origem já trancada — é isso que faz o token do dono
    // atravessar. E NÃO leva try/catch defensivo: `guardPerimeter` trata um comparador que lança como
    // tentativa inválida (conta na trava, grava `erro-na-comparacao`), então engolir a exceção aqui só
    // reabriria o canal de sondagem invisível que o portão fechou.
    validate: async (): Promise<PerimeterValidation<McpCredential>> => {
      if (!apresentada.value) return { valid: false, reason: "ausente" };

      const resolucao = await resolveMcpCredential(apresentada.value, { tiers: RUNNER_LEGACY_TIERS });
      if (!resolucao.ok) {
        return {
          valid: false,
          reason: resolucao.reason,
          ...(resolucao.handleId ? { handleId: resolucao.handleId } : {}),
        };
      }

      // Nível insuficiente é recusa, não degradação: a rota não tem um modo "faz menos". `desconhecida`
      // é o `reason` mais próximo no vocabulário do ledger (a credencial não casa com nada VIVO *para
      // esta superfície*), e a linha carrega `levelWanted` + `handleId`, que é o diagnóstico que o
      // operador precisa: qual handle pediu o que ele não tem.
      if (!levelAtLeast(resolucao.credential.level, surface.minLevel)) {
        return {
          valid: false,
          reason: "desconhecida",
          ...(resolucao.credential.handleId ? { handleId: resolucao.credential.handleId } : {}),
        };
      }

      return { valid: true, value: resolucao.credential };
    },
  });

  if (!portao.ok) return { ok: false, response: portao.response };

  if (apresentada.via === "query") warnQueryDeprecatedOnce(surface.path);
  return { ok: true, credential: portao.value, via: apresentada.via };
}
