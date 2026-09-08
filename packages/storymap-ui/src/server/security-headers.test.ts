// OS CABEÇALHOS DE SEGURANÇA — trava de regressão do perímetro do NAVEGADOR (story-2i89ai t1+t2+t6).
//
// Verificado ao vivo na auditoria de 2026-07-29: `/login`, `/`, `/board` e `/terminal` respondiam SEM
// `x-frame-options`, SEM `referrer-policy` e SEM CSP nenhuma — e o Caddy desta VPS também não os
// injeta. Cada ataque abaixo estava fechado por UMA camada só (o `SameSite=Lax` do cookie, ou o
// comportamento default do navegador); este arquivo existe para que a remoção acidental dessa camada
// não abra a porta em silêncio.
//
// Por que testar a CONFIG e não uma resposta HTTP: em Next 14 os cabeçalhos por path SÃO a config —
// `next.config.js#headers()` é lido para o manifesto de rotas no build, e não existe código nosso no
// caminho da resposta onde um teste de request pudesse observá-los sem subir o servidor inteiro. Para
// a asserção não virar comparação de string, o casamento de `source` usa O MESMO matcher que o Next
// usa (`getPathMatch`, de `next/dist/shared/lib/router/utils/path-match`): se alguém trocar o
// catch-all por um padrão que deixe `/api/**` de fora, o teste vê.
//
// O que ele NÃO faz: reduzir capacidade. Nenhum cabeçalho aqui limita o que o agente executa, e o
// avatar SVG — a única capacidade que a alternativa "recusar SVG" custaria — segue aceito.
//
// O segundo bloco cobre os REDIRECTS declarados no mesmo arquivo: são a outra coisa que o
// `next.config.js` decide sobre o navegador, e um redirect cujo destino carrega parte da URL do
// pedido é a forma clássica de open redirect.

import { describe, expect, it } from "vitest";

import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { compileNonPath, prepareDestination } from "next/dist/shared/lib/router/utils/prepare-destination";

// A config é CJS na raiz do pacote; `require` relativo é o que o Next também faz.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nextConfig = require("../../next.config.js") as {
  poweredByHeader?: boolean;
  headers?: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>>;
  redirects?: () => Promise<Array<{ source: string; destination: string; permanent?: boolean }>>;
};

/**
 * Os cabeçalhos EFETIVOS de um path, montados como o Next monta (`resolve-routes.js`, bloco "handle
 * headers"): toda entrada que casa é aplicada, na ordem, e a última a definir uma chave vence. Chave
 * em minúsculas porque é assim que o navegador as lê.
 *
 * O `compileNonPath` não é detalhe copiado por zelo: quando a `source` tem parâmetro, o Next passa
 * CHAVE E VALOR por um compilador de PATH — então um `:` no meio de uma CSP (`data:`, `blob:`) entra
 * num caminho de escape/interpolação. É o valor que sai DALI que o navegador recebe, e é ele que este
 * teste precisa olhar.
 */
async function effectiveHeaders(pathname: string): Promise<Map<string, string>> {
  expect(typeof nextConfig.headers, "next.config.js não declara headers() — nenhum path tem cabeçalho de segurança").toBe(
    "function",
  );
  const rules = await nextConfig.headers!();
  const out = new Map<string, string>();
  for (const rule of rules) {
    const params = getPathMatch(rule.source, { removeUnnamedParams: true, strict: true })(pathname);
    if (!params) continue;
    const hasParams = Object.keys(params).length > 0;
    for (const h of rule.headers) {
      const key = hasParams ? compileNonPath(h.key, params) : h.key;
      const value = hasParams ? compileNonPath(h.value, params) : h.value;
      out.set(key.toLowerCase(), value);
    }
  }
  return out;
}

/** As superfícies que o operador realmente abre — página, board, terminal, e a rota de máquina. */
const PATHS = ["/", "/login", "/board/storymap", "/board/storymap/inbox", "/terminal", "/api/usm/abc/sse"];

describe("cabeçalhos de segurança do perímetro web", () => {
  it("clickjacking: nenhuma superfície pode ser emoldurada por outro site", async () => {
    // ATAQUE: página maliciosa com o painel num iframe transparente por cima de um botão qualquer —
    // o operador clica em "Deployar"/"Aprovar" sem ver. Hoje o único obstáculo é o SameSite=Lax
    // (a moldura carrega sem cookie e mostra o /login); trocar o cookie para SameSite=None por
    // qualquer motivo de UI reabriria isto sem nenhum sinal.
    for (const p of PATHS) {
      const h = await effectiveHeaders(p);
      expect(h.get("x-frame-options"), `${p} pode ser emoldurado`).toBe("DENY");
    }
  });

  it("o Referer não pode carregar a URL do painel para fora", async () => {
    // ATAQUE: a superfície MCP tem o SEGREDO NO PATH (`/api/usm/<token>/<transport>`). Qualquer
    // navegação a partir de um documento nosso que mande `Referer` entrega esse path a quem receber
    // o clique — e o painel renderiza conteúdo autoral (cards, wireframes html), que pode ter link.
    for (const p of PATHS) {
      const h = await effectiveHeaders(p);
      expect(h.get("referrer-policy"), `${p} vaza referrer`).toBe("no-referrer");
    }
  });

  it("downgrade para http não pode entregar o cookie de sessão em claro", async () => {
    // ATAQUE: um link/redirect http:// (ou uma rede hostil que reescreva) faz o navegador repetir o
    // pedido em texto claro, com o cookie. O HSTS é ignorado pelo navegador quando a resposta veio
    // por transporte inseguro (RFC 6797 §8.1), então isto NÃO quebra o self-host em localhost.
    const sts = (await effectiveHeaders("/")).get("strict-transport-security") ?? "";
    const maxAge = Number(/max-age=(\d+)/.exec(sts)?.[1] ?? 0);
    expect(maxAge, `HSTS ausente ou curto demais: "${sts}"`).toBeGreaterThanOrEqual(15_552_000);
  });

  it("nada de adivinhar tipo: o que gravamos como imagem não vira documento", async () => {
    for (const p of ["/", "/avatars/storymap/persona.png"]) {
      expect((await effectiveHeaders(p)).get("x-content-type-options"), p).toBe("nosniff");
    }
  });

  it("um SVG armazenado em /avatars NÃO executa script na origem do painel", async () => {
    // ATAQUE (t6): `/api/avatar` aceita `image/svg+xml` e grava em `public/avatars/**`, servido na
    // MESMA origem. SVG é código: navegar até o arquivo renderiza um DOCUMENTO e o `<script>` de
    // dentro roda como página nossa — lê o DOM do painel e dispara server actions com o cookie do
    // operador (HttpOnly não ajuda: o navegador anexa o cookie sozinho). Hoje a gravação está
    // barrada por UMA camada (SameSite=Lax barra o POST multipart cross-site).
    const h = await effectiveHeaders("/avatars/storymap/persona.svg");
    const csp = h.get("content-security-policy") ?? "";
    expect(csp, "sem CSP enforce em /avatars — um SVG armazenado roda na nossa origem").toMatch(/(^|;)\s*sandbox\b/);
    // Sandbox SEM tokens é o que carrega a garantia: com `allow-scripts` o script volta a rodar, e
    // com `allow-same-origin` ele volta a ser a NOSSA origem — qualquer um dos dois anula o controle.
    expect(csp).not.toMatch(/allow-scripts/);
    expect(csp).not.toMatch(/allow-same-origin/);
    // Este é o único bloco com parâmetro na `source`, logo o único em que o `compileNonPath` mexe nos
    // valores: se ele mutilasse os `data:`/`blob:` da report-only, o cabeçalho chegaria quebrado ao
    // navegador (e um cabeçalho de CSP quebrado é descartado inteiro, silenciosamente).
    expect(h.get("content-security-policy-report-only")).toContain("img-src 'self' data: blob:");
  });

  it("a CSP de página é report-only até existir nonce — enforce cego derruba a hidratação", async () => {
    // Não é preferência de estilo: o App Router do Next 14 injeta script inline sem nonce. Um
    // `script-src 'self'` congela o painel (o dono desliga a camada inteira) e um `'unsafe-inline'`
    // não impede XSS nenhum. Este teste PERMITE promover a enforce — desde que seja com nonce, que é
    // o único desenho que impede injeção de verdade.
    const h = await effectiveHeaders("/board/storymap");
    const enforced = h.get("content-security-policy");
    if (enforced) {
      expect(enforced, "CSP em enforce sem nonce: ou quebra a hidratação, ou não impede XSS").toMatch(/'nonce-/);
      expect(/script-src[^;]*'unsafe-inline'/.test(enforced)).toBe(false);
    }
    const report = h.get("content-security-policy-report-only") ?? "";
    // O que a report-only já entrega: egress novo (CDN, beacon, fetch para fora) fica VISÍVEL no
    // console do operador antes de virar exfiltração silenciosa.
    expect(report).toContain("default-src 'self'");
    expect(report).toContain("object-src 'none'");
    expect(report).toContain("frame-ancestors 'none'");
  });

  it("o serviço não anuncia a pilha para o scanner", async () => {
    // `X-Powered-By: Next.js` entrega de graça o primeiro passo de qualquer varredura automatizada.
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});

describe("redirects do next.config — o destino não pode sair da nossa origem", () => {
  /** Valores hostis que um atacante conseguiria plantar num segmento de path da URL. */
  const HOSTIS = ["evil.example", "%2F%2Fevil.example", "..", "%2e%2e", "x%00y", "a%5Cb"];

  it("open redirect: um segmento da URL não consegue virar HOST do Location", async () => {
    // ATAQUE: `/board/<algo>/pilotagem` responde 301 para `/board/<algo>/inbox`, ou seja, o destino
    // CARREGA um trecho do pedido. Se esse trecho conseguisse virar autoridade (`//evil.example/…`,
    // `https://evil.example`), o 301 mandaria o operador — que confia no domínio dele — para fora,
    // e um phishing de token ficaria a um clique de distância. Montado com o MESMO par
    // matcher+compilador que o Next usa em runtime (getPathMatch + prepareDestination).
    expect(typeof nextConfig.redirects).toBe("function");
    const rules = await nextConfig.redirects!();
    expect(rules.length).toBeGreaterThan(0);

    for (const rule of rules) {
      const matcher = getPathMatch(rule.source, { removeUnnamedParams: true, strict: true });
      for (const hostil of HOSTIS) {
        const pathname = rule.source.replace(/:([A-Za-z0-9_]+)/g, hostil);
        const params = matcher(pathname);
        if (!params) continue; // esse valor não casa a rota — não há redirect para explorar
        const { newUrl, parsedDestination } = prepareDestination({
          appendParamsToQuery: false,
          destination: rule.destination,
          params,
          query: {},
        });
        // "Sem autoridade" no `parsedDestination` do Next é campo VAZIO (`""`), não `null` — a
        // propriedade travada é a ausência, em qualquer das duas formas.
        expect(Boolean(parsedDestination.hostname), `${rule.source} + ${hostil} → host "${parsedDestination.hostname}"`).toBe(
          false,
        );
        expect(Boolean(parsedDestination.protocol), `${rule.source} + ${hostil} → esquema "${parsedDestination.protocol}"`).toBe(
          false,
        );
        // `//host` é o outro jeito de trocar de autoridade sem escrever esquema nenhum.
        expect(newUrl.startsWith("/"), `${newUrl} não é caminho`).toBe(true);
        expect(newUrl.startsWith("//"), `${newUrl} vira autoridade`).toBe(false);
      }
    }
  });
});
