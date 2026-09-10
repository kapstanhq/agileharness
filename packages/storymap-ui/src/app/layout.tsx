import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, JetBrains_Mono, Playpen_Sans } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

import { PATHNAME_HEADER, shouldMountOverlay } from "@/lib/feedback/overlay-mount";
// As telas de abertura do PWA no iOS. A lista de aparelhos vive em `lib/pwa-splash.ts` porque o
// gerador dos PNG (`scripts/gen-splash.ts`) usa a MESMA — duas cópias divergiriam no primeiro
// iPhone novo, e um `<link>` para um arquivo que ninguém gerou é uma tela preta na estreia.
import { APPLE_SPLASH, splashHref, splashMedia } from "@/lib/pwa-splash";

// AgileHarness identity — UMA família clara para toda a UI. Hanken Grotesk: grotesca
// humanista, Notion-grade, self-hosted no build (sem fetch em runtime), exposta como a
// var --font-sans que o tailwind `font-sans` resolve.
const sans = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

// Mono para IDs/códigos (story-recs, card ids) — JetBrains Mono, exposta como --font-mono.
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
  weight: ["400", "500", "600"],
});

// Marca — o "Agile" manuscrito do logo (components/AgileHarnessLogo). Playpen Sans é a MESMA
// família do "Playpen Sans Deva" do design (a variante Deva só acrescenta glifos devanágari;
// no latim é idêntica), self-hosted no build como as demais, exposta como --font-brand.
const brand = Playpen_Sans({
  subsets: ["latin"],
  variable: "--font-brand",
  display: "swap",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "AgileHarness — User Story Mapping",
  description: "Dev tool: User Story Mapping boards backed by committed files.",
  // PWA: installable to the home screen so phone Web Push works like a native app.
  manifest: "/manifest.webmanifest",
  applicationName: "AgileHarness",
  appleWebApp: { capable: true, title: "AgileHarness", statusBarStyle: "black-translucent" },
  // Todos gerados por `bun run gen-icons` a partir da MESMA arte do mascote (mascot.ts) — o
  // `mascot-icons.test.ts` reprova o commit em que a arte muda e o ícone não. A ordem importa: o
  // SVG vem PRIMEIRO porque todo navegador atual o prefere quando existe, e é o único que fica
  // nítido em qualquer densidade/zoom; os PNG ficam como fallback (Safari antigo, Windows, o .ico).
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
    shortcut: "/favicon.ico",
  },
};

export const viewport: Viewport = {
  themeColor: "#E7E5DF",
};


// Light (warm-neutral) is the DEFAULT theme — é a identidade do redesign. SSR sem a classe
// `dark`; este script inline (antes do primeiro paint) só ATIVA o escuro se o usuário optou
// por ele via toggle — evita qualquer flash de tema no load.
const THEME_BOOTSTRAP = `
try {
  var t = localStorage.getItem('storymap.theme');
  if (t === 'dark') document.documentElement.classList.add('dark');
  else document.documentElement.classList.remove('dark');
} catch (e) {}
`;

// Feedback overlay — DOGFOOD: the AgileHarness board gives visual feedback on ITSELF. The vanilla
// snippet (public/ah-overlay.js) mounts a discreet bottom-left button on every page; unlinked
// batches become triage cards on the `storymap` board (?ah-card=/?ah-session= override the link).
// Same-origin + basic_auth → no nonce/CORS. The `theme` maps the overlay to the app's own CSS vars
// so it matches the palette AND dark mode; the overlay core stays framework-agnostic (Fase 4 OSS).
//
// `destinations` + `cardUrlTemplate` are the app's POLICY (what a "card"/"session"/"triagem" MEANS
// and where a card lives) injected into the semantics-blind core — so the operator sees, at send
// time, WHERE the feedback goes and that "Novo item" spawns a triage agent (no more silent flash).
// A cross-origin product embed (Nest, Fase 4) would inject its OWN copy or fall back to the neutral
// core defaults; nothing AgileHarness-specific is baked into ah-overlay.js.
const AH_FEEDBACK_CONFIG = {
  endpoint: "/api/feedback/intake",
  // Turns on the send-step picker: [Novo item · Card · Sessão]. The card/session lists load from this
  // same-origin endpoint (board pinned server-side; the Sessão option appears only when the terminal
  // round-trip is enabled — AGILEHARNESS_FEEDBACK_TERMINAL=1). A cross-origin embed would omit this.
  destinationsEndpoint: "/api/feedback/destinations",
  // Where a captured image is stored. The SOURCE of the image is the browser itself — a real frame of
  // the shared tab (one permission per session) or a pasted system screenshot — so this is the only
  // image knob the host provides. Omit it and annotations travel without pictures.
  shotEndpoint: "/api/feedback/shot",
  // O botão: o Jido com o marcador (a marca da FERRAMENTA, para não se confundir com o app olhado) e
  // "Marcar ajuste" — verbo + objeto. O balão de conversa escrito "Feedback" lia como canal de suporte.
  icon: "jido",
  label: "Marcar ajuste",
  link: { kind: "none", board: "storymap" },
  producer: "agileharness-board",
  cardUrlTemplate: "/board/{board}/inbox?focus={id}",
  destinations: {
    none: {
      label: "Novo item (Triagem)",
      verb: "Criar item de triagem",
      hint: "Cria um card na Triagem — um agente classifica (bug/melhoria/ideia). Não vincula a um card existente.",
    },
    card: {
      label: "Item vinculado (refino)",
      verb: "Enviar ao item",
      hint: "Reabre o item vinculado em modo refino com as anotações.",
    },
    session: {
      label: "Sessão do agente",
      verb: "Enviar à sessão",
      hint: "Cola as anotações direto na sessão; você confere e dá o Enter.",
    },
  },
  theme: {
    font: "var(--font-sans)",
    mono: "var(--font-mono)",
    accent: "rgb(var(--accent))",
    accentSoft: "rgb(var(--accent) / 0.26)",
    surface: "rgb(var(--surface))",
    surfaceHover: "rgb(var(--surface-hover))",
    inset: "rgb(var(--inset))",
    line: "rgb(var(--line))",
    fg: "rgb(var(--fg))",
    fgMuted: "rgb(var(--fg-muted))",
    fgSubtle: "rgb(var(--fg-subtle))",
    danger: "rgb(var(--danger))",
    radius: "10px",
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // A rota chega pelo carimbo do middleware (lib/feedback/overlay-mount.ts) — o root layout do App
  // Router não a conhece por conta própria. Serve só para NÃO montar o overlay em rota pública.
  const mountOverlay = shouldMountOverlay((await headers()).get(PATHNAME_HEADER));

  return (
    <html lang="pt-BR" className={`${sans.variable} ${mono.variable} ${brand.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        {APPLE_SPLASH.map((s) => (
          <link key={`${s.w}x${s.h}`} rel="apple-touch-startup-image" href={splashHref(s)} media={splashMedia(s)} />
        ))}
      </head>
      <body className="font-sans antialiased text-fg">
        {children}
        {mountOverlay && (
          <>
            <script dangerouslySetInnerHTML={{ __html: `window.__AH_FEEDBACK_CONFIG__=${JSON.stringify(AH_FEEDBACK_CONFIG)};` }} />
            <script src="/ah-overlay.js" async />
          </>
        )}
      </body>
    </html>
  );
}
