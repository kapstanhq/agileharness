import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isPublicPath, PUBLIC_ROUTES } from "@/lib/auth/public-routes";
import { APPLE_SPLASH, splashHref } from "@/lib/pwa-splash";
import { buildAll } from "../../../scripts/gen-icons";

// EXAUSTIVIDADE DAS ISENÇÕES — o mesmo padrão de `gate-exhaustiveness.test.ts`.
//
// O middleware nega por default, então uma rota NOVA nasce protegida (bom) e nenhum teste seria
// necessário para isso. O que ESTE arquivo protege é o outro lado, que é onde mora o risco:
//   1. uma rota nova cair sem querer sob um prefixo público e ficar aberta EM SILÊNCIO;
//   2. uma isenção continuar na lista depois que a rota que a justificava morreu (isenção morta —
//      o padrão "capacidade declarada com zero produtores", que parece proteção e não é nada).
// Por isso a lista esperada é ESCRITA À MÃO: abrir uma rota passa a exigir editar este arquivo,
// que é exatamente a fricção que se quer num code review de segurança.

const appDir = fileURLToPath(new URL("../../app", import.meta.url));
const publicDir = fileURLToPath(new URL("../../../public", import.meta.url));

/** Todo pathname servido pelo App Router (rotas de API + páginas). */
function collectRoutes(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Grupos de rota `(x)` não aparecem na URL.
      const segment = entry.name.startsWith("(") && entry.name.endsWith(")") ? "" : `/${entry.name}`;
      out.push(...collectRoutes(path.join(dir, entry.name), `${prefix}${segment}`));
    } else if (entry.name === "route.ts" || entry.name === "page.tsx") {
      out.push(prefix === "" ? "/" : prefix);
    }
  }
  return out;
}

const ROUTES = collectRoutes(appDir).sort();

/**
 * As ÚNICAS rotas do app que ficam fora do portão. Mexer aqui é decisão de segurança — cada
 * entrada tem de casar com uma justificativa em `PUBLIC_ROUTES` (self-auth ou pre-session).
 */
const EXPECTED_PUBLIC = [
  "/api/auth/login",
  "/api/auth/logout",
  "/api/health",
  "/api/notifications/vapid",
  "/api/runner/deploy-webhook",
  "/api/runner/events",
  "/api/runner/pulse",
  "/api/runner/test-webhook",
  "/api/usm/[secret]/[transport]",
  "/login",
].sort();

describe("isenções do portão de autenticação", () => {
  it("a suíte enxerga o App Router de verdade", () => {
    expect(ROUTES.length).toBeGreaterThan(20);
    expect(ROUTES).toContain("/");
  });

  it("EXATAMENTE as rotas esperadas ficam públicas", () => {
    expect(ROUTES.filter(isPublicPath)).toEqual(EXPECTED_PUBLIC);
  });

  it("o TERMINAL não é exceção — nem o documento, nem os assets, nem o backend", () => {
    // Este é o teste que fecha a história: até 2026-07-27 `/terminal` e `/ttyd/*` eram servidos
    // pelo Caddy com `basic_auth` PRÓPRIO — a última superfície do AgileHarness fora do portão do
    // app. Hoje o documento é um asset (`public/terminal/`) gateado pelo middleware e o backend
    // passa pelo servidor próprio (`src/server/terminal-gateway.ts`), que chama a MESMA
    // `verifySession`. Se alguma destas voltar a ser pública, a unificação regrediu.
    for (const p of [
      "/terminal",
      "/terminal/index.html",
      "/terminal/vendor/xterm.js",
      "/terminal/vendor/xterm.css",
      "/ttyd/ws",
      "/ttyd/token",
    ]) {
      expect(isPublicPath(p), `${p} deveria exigir sessão`).toBe(false);
    }
  });

  it("o board e as superfícies de mutação exigem sessão", () => {
    for (const p of [
      "/",
      "/board/[boardId]",
      "/processes",
      "/perguntas",
      "/api/copilot/turn",
      "/api/terminal/sessions",
      "/api/processes",
      "/api/vps/metrics",
      "/api/feedback/intake",
      "/api/design/upload",
      "/api/inbox/seen",
    ]) {
      expect(isPublicPath(p), `${p} deveria exigir sessão`).toBe(false);
    }
  });

  it("nenhuma isenção está MORTA — todo prefixo aponta para algo que existe", () => {
    for (const { prefix, why } of PUBLIC_ROUTES) {
      const servedByApp = ROUTES.some((r) => r === prefix || r.startsWith(`${prefix}/`));
      const servedByPublicDir = existsSync(path.join(publicDir, prefix.slice(1)));
      expect(servedByApp || servedByPublicDir, `isenção morta: ${prefix} — ${why}`).toBe(true);
    }
  });

  it("toda isenção declara um motivo reconhecido", () => {
    for (const r of PUBLIC_ROUTES) {
      expect(["self-auth", "pre-session"]).toContain(r.reason);
      expect(r.why.length).toBeGreaterThan(20);
    }
  });

  it("casa por SEGMENTO — um prefixo não vaza para um irmão de nome parecido", () => {
    // O bug clássico de `startsWith` cru: `/api/auth` liberando `/api/authorize-tudo`.
    expect(isPublicPath("/api/authorize-tudo")).toBe(false);
    expect(isPublicPath("/logindisfarcado")).toBe(false);
    expect(isPublicPath("/api/healthz-interno")).toBe(false);
    // …sem quebrar o caminho legítimo, com ou sem barra final.
    expect(isPublicPath("/api/auth/login")).toBe(true);
    expect(isPublicPath("/api/health/")).toBe(true);
  });

  it("libera os estáticos de que a PRÓPRIA tela de login depende", () => {
    for (const p of ["/_next/static/css/a.css", "/favicon.ico", "/icon-192.png", "/sw.js"]) {
      expect(isPublicPath(p), `${p} deveria ser público`).toBe(true);
    }
  });

  it("TODO ícone que o gerador escreve é público — inclusive um formato novo", () => {
    // Isto não é redundância do teste acima: ali a lista é escrita à mão, aqui ela vem do PRODUTOR.
    // O defeito real que motivou: o favicon vetorial saiu como `/icon.svg`, e o prefixo da lista era
    // `/icon-` (com hífen) — casava os PNG e não o SVG. O `<head>` declara o SVG PRIMEIRO porque todo
    // navegador atual o prefere, então quem não estava logado recebia a tela de login no lugar do
    // ícone e a aba ficava sem cara. Ninguém abre o DevTools para conferir favicon: só um teste pega.
    // Derivando do gerador, o próximo formato (um `.webp`, um `icon-mono.svg`) já nasce coberto.
    for (const file of buildAll().keys()) {
      expect(isPublicPath(`/${file}`), `/${file} é gerado mas está atrás do portão`).toBe(true);
    }
    // e as telas de abertura do PWA, que o iOS busca ANTES de existir sessão.
    for (const d of APPLE_SPLASH) expect(isPublicPath(splashHref(d)), `${splashHref(d)}`).toBe(true);
  });
});
