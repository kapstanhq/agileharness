/** @type {import('next').NextConfig} */
// SERVIÇO DE PRODUÇÃO — não é mais "ferramenta de dev". O comentário anterior dizia que este pacote
// roda por `next dev`/`next start` e que NUNCA é deployado; as duas afirmações são falsas desde que ele
// virou um systemd com entrypoint próprio (`dist/ah-server.mjs`) que se auto-deploya. Corrigir isto não
// é higiene: `oss-docs-truth.test.ts` já cobra a mesma honestidade do README ("não afirma ser dev-only
// nem 'never deployed'"), e a postura de segurança do repositório publicado depende de ninguém ler
// "dev-only" e concluir que a superfície não precisa de portão.
//
// Continua valendo: NÃO usamos `output: 'export'` (ao contrário do admin dashboard) — export estático
// desliga Server Actions + Route Handlers, que são justamente como esta ferramenta lê e escreve os
// arquivos de `storymap/` no disco local.

/**
 * A CSP-ALVO, em modo REPORT-ONLY de propósito (story-2i89ai t2).
 *
 * Por que report-only e não enforce: o App Router do Next 14 injeta os scripts de bootstrap/
 * hidratação INLINE, sem nonce. Uma CSP com `script-src 'self'` mata a hidratação (o painel abre e
 * congela) e uma com `'unsafe-inline'` não impede XSS nenhum — o único desenho que serve é
 * nonce-por-request, e o nonce nasce no `middleware.ts`, que NÃO é desta onda. Ligar um enforce que
 * não foi exercido num navegador de verdade é pior que não ligar nada: o dono para de usar a
 * ferramenta e desliga a camada inteira.
 *
 * O que ELA JÁ ENTREGA em report-only: a violação aparece no console do navegador do operador, então
 * qualquer egress novo (um script de CDN, um beacon, um `fetch` para fora) fica VISÍVEL antes de
 * virar exfiltração silenciosa. Não há `report-uri`/`report-to` — não existe endpoint de coleta e
 * criar um abriria uma superfície POST nova sem sessão; o console é o consumidor.
 *
 * ⚠️ Antes de promover a enforce, valide num navegador: (1) hidratação do App Router com nonce;
 * (2) o `<iframe sandbox="" srcdoc>` do HtmlArtifactFrame (documento local HERDA a CSP do criador em
 * alguns navegadores — `frame-ancestors`/`frame-src` aqui podem matar o preview de wireframe html);
 * (3) o WebSocket do ttyd (`connect-src 'self'` cobre ws:// da MESMA origem pela CSP3, mas isso é
 * exatamente o tipo de detalhe que só o navegador confirma).
 */
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
].join("; ");

/**
 * OS CABEÇALHOS DE SEGURANÇA de TODA resposta que o Next serve (story-2i89ai t1+t2).
 *
 * Cada linha existe porque o vetor correspondente está fechado hoje por UMA camada só — a remoção
 * acidental dessa camada não pode abrir a porta. O que cada um IMPEDE:
 *
 * • `Referrer-Policy: no-referrer` — impede que a URL da página vaze para um terceiro no header
 *   `Referer` quando o operador clica num link externo. Aqui isso não é higiene abstrata: a
 *   superfície MCP tem o segredo NO PATH (`/api/mcp/<token>/<transport>`), e o default do navegador
 *   (`strict-origin-when-cross-origin`) já não manda o path para fora — mas manda para outra página
 *   da MESMA origem, e o AgileHarness renderiza conteúdo autoral (cards, wireframes html). Sem
 *   referrer nenhum, nada disso tem como reconstruir a URL de quem o carregou.
 * • `X-Content-Type-Options: nosniff` — impede que o navegador ADIVINHE o tipo de um arquivo salvo
 *   pelo upload e execute como documento algo que gravamos como imagem.
 * • `X-Frame-Options: DENY` — impede clickjacking (o painel dentro de um iframe invisível de outro
 *   site, com o operador clicando em "Deployar" sem saber). Hoje o único obstáculo é o
 *   `SameSite=Lax` do cookie, que faz a moldura carregar SEM sessão e mostrar o /login — proteção
 *   real, mas de UMA camada, e que evapora no dia em que alguém precisar de `SameSite=None`.
 *   Escolhido `DENY` (não `SAMEORIGIN`) porque NENHUMA superfície nossa se emoldura: o único iframe
 *   do app é `srcdoc` + `sandbox=""` (HtmlArtifactFrame), e XFO não se aplica a documento local —
 *   verificado por busca: zero `<iframe src>`, zero `window.parent`/`postMessage` no pacote.
 *   O gêmeo `frame-ancestors 'none'` fica no report-only acima justamente porque a CSP É herdada
 *   por srcdoc e poderia matar aquele preview; o XFO não é, então ele pode ser enforce hoje.
 * • `Strict-Transport-Security` — impede o downgrade para http:// (link colado, redirect, rede
 *   hostil) que entregaria o cookie de sessão em texto claro. Incondicional de propósito: a RFC 6797
 *   §8.1 manda o navegador IGNORAR o header quando a resposta veio por transporte inseguro, então o
 *   self-host em `http://localhost:3008` não sente nada — não transforme isto num header condicional
 *   "para não quebrar o local", porque a condição não existe. Sem `includeSubDomains` e sem
 *   `preload`: o painel costuma morar num subdomínio de um domínio com outros hosts que não são
 *   nossos para trancar.
 */
const SECURITY_HEADERS = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Strict-Transport-Security", value: "max-age=15552000" },
  { key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY },
];

const nextConfig = {
  /**
   * Remove o `X-Powered-By: Next.js` (story-2i89ai t2). O que isso impede: entregar de graça a
   * pilha e a versão para um scanner, que é o primeiro passo de qualquer varredura automatizada.
   * Não é defesa — é não colaborar com o atacante.
   */
  poweredByHeader: false,
  /**
   * DESLIGA o Image Optimizer — `/_next/image` passa a responder 404.
   *
   * Por que aqui e não uma migração: o endpoint é montado pelo servidor do Next INDEPENDENTEMENTE do
   * que a aplicação importa, e este pacote não importa `next/image` em lugar nenhum (o guarda
   * `importers_confined_to` do VEX mede isso, com `allow: []`). Ou seja, a superfície existia com uso
   * ZERO — e estava fora do portão duas vezes: o `matcher` do middleware exclui `_next/image` e
   * `isPublicPath` libera `/_next/`.
   *
   * MEDIDO na fonte instalada (`next/dist/server/next-server.js`, `handleNextImageRequest`): com
   * `unoptimized: true` o handler chama `render404` ANTES de `validateParams`, antes da chave de cache
   * e antes de qualquer leitura de imagem. Ou seja o caminho vulnerável não é atenuado — ele não
   * executa. É o que fecha GHSA-h64f-5h5j-jqjh (DoS por memória, ramo local) e GHSA-3x4c-7xq6-9pq8
   * (cache em disco sem teto) a custo de capacidade ZERO.
   *
   * ⚠️ Se um dia alguém importar `next/image`, a imagem passa a ser servida SEM otimização (o
   * atributo `src` sai cru). Isso é uma decisão de produto, não um efeito colateral: para reverter,
   * remova este bloco E reabra as duas disposições VEX.
   */
  images: { unoptimized: true },
  /**
   * ONDE o build é escrito. Default `.next`; o self-deploy passa `.next-staging`.
   *
   * POR QUE: `next build` reescreve os arquivos DENTRO do distDir, e o servidor vivo lê esse mesmo
   * diretório por caminho, em tempo de request. Buildar por cima do `.next` do processo em execução é
   * um defeito CONHECIDO do Next (vercel/next.js#43462) e produzia, a cada publicação, ~1 min de 500
   * (`TypeError: Cannot read properties of undefined (reading 'clientModules')` — o manifesto de
   * client-reference trocado debaixo do servidor). Medido em 2026-07-28, 18:49:51.
   *
   * O padrão canônico é buildar num distDir SEPARADO e trocar por rename. Em Next 14 o flag
   * `--distDir` do `next build` NÃO existe mais — a única porta é esta, o `distDir` do config
   * (docs: nextjs.org/docs/app/api-reference/config/next-config-js/distDir), lido por env para o
   * build de deploy poder escolher sem que o RUNTIME saiba: o systemd não define a variável, então o
   * serviço sempre serve `.next`.
   */
  distDir: process.env.AGILEHARNESS_DIST_DIR || ".next",
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  /**
   * Os cabeçalhos aplicados por PATH. Vale para TODA resposta que o Next serve, inclusive os
   * arquivos de `public/` — é o que faz o bloco `/avatars/` abaixo ter efeito, e não é fé: os
   * cabeçalhos são acumulados na RESOLUÇÃO de rota (`server/lib/router-utils/resolve-routes.js`,
   * bloco "handle headers"), antes de qualquer decisão sobre quem serve o corpo.
   *
   * ⚠️ NÃO cobre o que o `src/server/main.ts` responde por fora do Next: o upgrade de WebSocket e o
   * proxy `/ttyd/*` (terminal-gateway) nunca passam por aqui — quem os protege é a validação de
   * sessão + `Origin` do próprio gateway.
   */
  async headers() {
    return [
      { source: "/(.*)", headers: SECURITY_HEADERS },
      {
        // O AVATAR SUBIDO É UM DOCUMENTO NA NOSSA ORIGEM (story-2i89ai t6).
        //
        // `/api/avatar` grava em `public/avatars/<board>/<persona>.<ext>`, servido estaticamente na
        // MESMA origem do painel — e um dos formatos aceitos (SVG) é código executável. Navegar até
        // `/avatars/x/y.svg` renderiza um DOCUMENTO: um `<script>` lá dentro roda como se fosse
        // página nossa, lê o DOM, e chama as server actions do board com o cookie do operador
        // (HttpOnly não protege disso — o navegador anexa o cookie sozinho). Hoje o que barra a
        // gravação é UMA camada: o `SameSite=Lax`, que impede o POST multipart cross-site.
        //
        // `sandbox` sem NENHUM token é o que impede a execução: o documento cai numa origem opaca e
        // fica sem `allow-scripts`, então o script não roda e, se rodasse, não seria mais a nossa
        // origem. Custo de capacidade ZERO — avatar SVG continua aceito e continua RENDERIZANDO
        // (sandbox não mexe em geometria nem em `<style>` interno), e num `<img>` a diretiva é
        // ignorada pelo navegador porque só se aplica a documento/worker.
        //
        // Sem `default-src 'none'` aqui de propósito: ele bloquearia o `<style>` interno do SVG e
        // quebraria o desenho — a contenção é o sandbox, não a lista de fontes.
        source: "/avatars/:path*",
        headers: [
          ...SECURITY_HEADERS,
          { key: "Content-Security-Policy", value: "sandbox" },
        ],
      },
    ];
  },
  // A "Pilotagem" virou "Inbox" (rota inclusa). Links antigos — bookmarks do operador, hrefs
  // colados em cards/notas, deep-links que agentes já emitiram — continuam válidos: um 301 leva
  // /board/:b/pilotagem[/:item] para /board/:b/inbox[/:item] preservando a query (?focus=…).
  async redirects() {
    return [
      { source: "/board/:boardId/pilotagem", destination: "/board/:boardId/inbox", permanent: true },
      {
        source: "/board/:boardId/pilotagem/:itemId",
        destination: "/board/:boardId/inbox/:itemId",
        permanent: true,
      },
    ];
  },
  // O TERMINAL passou a ser servido pelo app (2026-07-27). Antes ele era um `file_server` do Caddy
  // apontando para /var/lib/caddy/web-terminal, com `basic_auth` PRÓPRIO — uma segunda autenticação,
  // fora do repositório, que só existia porque o Next não podia tratar o WebSocket do ttyd. Agora o
  // documento é um asset em `public/terminal/` e este rewrite dá a ele a URL limpa `/terminal`; o
  // middleware o gateia como qualquer outra rota, e o WebSocket vai pelo `src/server/main.ts`.
  //
  // Rewrite (e não uma página React): a página do terminal são ~2800 linhas de JS imperativo que
  // manipulam o DOM direto. Hidratação do React em cima disso seria uma briga por nada — o
  // documento é servido como documento, exatamente como era.
  async rewrites() {
    return [{ source: "/terminal", destination: "/terminal/index.html" }];
  },
  // `src/instrumentation.ts` faz o watcher do autorun subir COM O SERVIDOR e recupera os runs
  // interrompidos por um crash — as duas coisas TÊM de acontecer sem esperar a primeira conexão SSE
  // de um browser. No Next 14 isso dependia de `experimental.instrumentationHook: true`; no 15 o
  // arquivo é carregado por default e a flag virou chave DESCONHECIDA — o build a rejeitava com
  // `Invalid next.config.js options detected` em toda rodada. Config morta que emite aviso é pior que
  // config morta calada: ela ensina quem lê o log a passar os olhos por avisos.
  experimental: {
    // Smart capture lets the user attach context images (downscaled client-side, but a few of them
    // still exceed the 1MB default Server Action body limit). Bump it so the capture POST doesn't 413.
    serverActions: { bodySizeLimit: "10mb" },
    // The remote MCP route (app/api/mcp/[secret]/[transport]) imports `mcp-handler`
    // (CommonJS, pulls in `redis`). Bundling that graph alongside our runner engine
    // — which imports `node:child_process` — makes the Next 14 webpack choke with
    // `UnhandledSchemeError: Reading from "node:child_process"`. Externalizing these
    // packages keeps webpack from bundling them (native require at runtime instead).
    // `web-push` (CommonJS) pulls in jws/asn1.js + node https/crypto; externalizing
    // it keeps webpack from bundling that graph (native require at runtime instead),
    // same rationale as mcp-handler above.
  },
  // NEXT 15: saiu de `experimental` e virou opção de topo (`serverExternalPackages`). O build do 15
  // avisa em voz alta e IGNORA a chave antiga — ou seja, manter o nome velho não é cosmético: os
  // três pacotes voltariam a ser empacotados pelo webpack e o `UnhandledSchemeError` que o
  // parágrafo acima descreve voltaria junto.
  serverExternalPackages: ["mcp-handler", "@modelcontextprotocol/sdk", "web-push"],
  // Belt-and-suspenders for the same UnhandledSchemeError: force every `node:`-prefixed
  // builtin (e.g. node:child_process from the runner engine, node:crypto from the MCP
  // token check) to resolve as an external commonjs require on the server, so webpack
  // never tries to resolve the `node:` URI scheme. No-op on the client bundle.
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Externalize BOTH `node:`-prefixed and bare builtins (net/http/https/tls/…). A
      // bare-builtin import comes from web-push's transitive deps (https-proxy-agent →
      // agent-base) and otherwise breaks the instrumentation chunk build. `split('/')[0]`
      // covers subpaths like `fs/promises`.
      const { builtinModules } = require("node:module");
      const isNodeBuiltin = (req) =>
        !!req && (req.startsWith("node:") || builtinModules.includes(req.split("/")[0]));
      const prev = Array.isArray(config.externals)
        ? config.externals
        : config.externals
          ? [config.externals]
          : [];
      config.externals = [
        ...prev,
        ({ request }, cb) => (isNodeBuiltin(request) ? cb(null, `commonjs ${request}`) : cb()),
      ];
    }
    return config;
  },
};

module.exports = nextConfig;
