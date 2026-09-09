// O QUE FICA FORA DO PORTÃO — fonte ÚNICA da verdade.
//
// O middleware (`src/middleware.ts`) nega por default: tudo exige sessão, MENOS o que estiver
// declarado aqui. Isso inverte o default histórico (o `basic_auth` do Caddy protegia só o que
// passava pelo :443 — e o :3008 ficava aberto).
//
// Este módulo é lido por DOIS consumidores, de propósito:
//   1. o middleware, que decide de verdade;
//   2. `public-routes.test.ts`, que enumera TODA rota em `src/app/**/route.ts` e reprova se
//      alguma não estiver classificada — o padrão `gate-exhaustiveness.test.ts` do pacote.
//      Sem esse teste, uma rota nova nasce protegida (bom) mas uma rota nova que PRECISA ser
//      pública nasce quebrada em silêncio, e uma isenção some no code review. Com ele, a
//      classificação é uma DECISÃO explícita e versionada.
//
// A régua para entrar nesta lista é estreita — só duas justificativas valem:
//   (a) a rota carrega a PRÓPRIA autenticação (token timing-safe), ou
//   (b) a rota precisa ser alcançável ANTES de existir sessão (o login, o health, o PWA).
// "É mais fácil assim" não é justificativa.

/** Motivo pelo qual um prefixo é público — o teste de exaustividade exige um destes. */
export type PublicReason = "self-auth" | "pre-session";

export interface PublicRoute {
  /** Prefixo do pathname. Casa por igualdade OU por `startsWith(prefix + "/")`. */
  readonly prefix: string;
  readonly reason: PublicReason;
  /** Por que ESTA rota pode ficar fora do portão. Aparece no teste quando algo regride. */
  readonly why: string;
}

export const PUBLIC_ROUTES: readonly PublicRoute[] = [
  // ── (b) alcançável antes de haver sessão ───────────────────────────────────────────────────
  {
    prefix: "/login",
    reason: "pre-session",
    why: "a própria tela de login — gatear isto seria um laço de redirect infinito",
  },
  {
    prefix: "/api/auth",
    reason: "pre-session",
    why: "trocar token por sessão (login) e derrubá-la (logout); o login se autentica pelo token",
  },
  {
    prefix: "/api/health",
    reason: "pre-session",
    why:
      "probe de liveness sem segredo. `runner/stack-health.ts` faz probeGet com redirect:'manual' e " +
      "só aceita res.ok — um 307 para /login marcaria o serviço como DOENTE e derrubaria o próprio " +
      "monitor de stack",
  },

  // ── (a) a rota traz a própria autenticação ────────────────────────────────────────────────
  {
    prefix: "/api/usm",
    reason: "self-auth",
    why:
      "endpoint MCP: token no path, comparado timing-safe contra um segredo que precisa passar os 4 " +
      "critérios de `secretWeakness` (lib/storymap/mcp/auth.ts) — >= 32 chars, >= 10 caracteres " +
      "distintos, >= 64 bits de Shannon e não ser a repetição de um motivo curto. Fora do portão " +
      "porque é o canal dos agentes headless, que não têm navegador nem cookie; sem token declarado " +
      "na env a superfície não existe (404 nu) e nada a arma por conta própria",
  },
  {
    prefix: "/api/runner",
    reason: "self-auth",
    why:
      "webhooks e SSE do runner (deploy-webhook, test-webhook, events, pulse): todos já exigem o " +
      "shared secret e devolvem 401 sem ele. Quem chama é o próprio serviço em 127.0.0.1 e os runs",
  },

    {
    prefix: "/api/feedback/intake",
    reason: "self-auth",
    why:
      "broker do overlay de feedback, com TRÊS lanes que se autenticam na própria rota: same-origin " +
      "pela sessão do operador (a MESMA verifySession do middleware, em lib/feedback/session-gate.ts), " +
      "INGEST pelo token de repasse timing-safe (x-ah-ingest, board vem do token, triage-only) e EMBED " +
      "por origem allowlistada + nonce cunhado pelo board (triage-only). Fora do portão porque um relay " +
      "servidor-a-servidor não tem cookie e um navegador de outra origem nunca manda o do board — " +
      "story-14xvpa passo 2 / issue #2. Sem token nem allowlist declarados, as duas lanes não existem",
  },
  {
    prefix: "/api/feedback/shot",
    reason: "self-auth",
    why:
      "a imagem de uma anotação: o POST aceita o relay pelo token de repasse (mesma lane do intake) ou " +
      "same-origin + sessão do operador; o GET é same-origin + sessão, sempre — nunca CORS, para nenhuma " +
      "página poder hotlinkar um screenshot da tela do operador. Verificação em lib/feedback/session-gate.ts",
  },
// ── PWA: o navegador busca estes ANTES de qualquer sessão (instalação + push) ──────────────
  {
    prefix: "/sw.js",
    reason: "pre-session",
    why: "service worker — o navegador o busca fora do contexto da página, sem cookie garantido",
  },
  { prefix: "/manifest.webmanifest", reason: "pre-session", why: "manifest do PWA (instalação na home)" },
  {
    prefix: "/api/notifications/vapid",
    reason: "pre-session",
    why: "chave VAPID PÚBLICA por definição — é o que o browser usa para assinar a subscription",
  },
];

/**
 * Assets estáticos e ícones — sem segredo, e barrá-los quebraria a própria tela de login.
 *
 * ⚠️ `/icon.svg` está aqui SEPARADO de `/icon-` porque o hífen não é decoração: `/icon-` casa
 * `/icon-192.png` e `/icon-512.png` e **não** casa `/icon.svg`. Foi assim que o favicon vetorial
 * nasceu gateado — o `<head>` o declara PRIMEIRO (todo navegador atual prefere o SVG), o middleware
 * respondia a tela de login no lugar dele, e a aba de quem não estava logado ficava sem ícone. O
 * sintoma é mudo: ninguém abre o DevTools para conferir favicon. O `public-routes.test.ts` agora
 * cobra que TODO arquivo que o gerador de ícones escreve seja público, para não depender de alguém
 * lembrar de estender esta lista ao adicionar um formato novo.
 */
const PUBLIC_FILE_PREFIXES = [
  "/_next/",
  "/icon-",
  "/icon.svg",
  "/favicon",
  "/apple-touch-icon",
  "/badge-", // estêncil do badge de notificação — o service worker o busca sem contexto de página
  "/splash/",
] as const;

/**
 * A rota está fora do portão?
 *
 * Casamento por SEGMENTO (`=== prefix` ou `startsWith(prefix + "/")`), nunca `startsWith` cru:
 * com `startsWith` cru, o prefixo `/api/auth` deixaria passar `/api/authorize-everything`, que é
 * exatamente como isenções de path viram bypass.
 */
export function isPublicPath(pathname: string): boolean {
  // Normaliza a barra final para `/api/health/` casar com o prefixo `/api/health`.
  const p = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (PUBLIC_FILE_PREFIXES.some((prefix) => p.startsWith(prefix))) return true;
  return PUBLIC_ROUTES.some((r) => p === r.prefix || p.startsWith(`${r.prefix}/`));
}
