import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import { VIEWPORT_VARIANTS } from "./src/lib/viewport";

// Own, neutral flat identity backed by SEMANTIC tokens (see globals.css). Every
// surface/border/text colour resolves to a CSS variable so the views share ONE
// palette and can't drift apart in dark mode. Modelled on GitHub Primer.
const withAlpha = (v: string) => `rgb(var(${v}) / <alpha-value>)`;

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  // `hover:` só onde existe hover DE VERDADE — `@media (hover: hover) and (pointer: fine)`. No toque o navegador deixa o
  // :hover GRUDADO no último elemento tocado (em 390px o «+N … desta funcionalidade» aparecia cinza sem ninguém passar o
  // mouse). No computador com mouse nada muda. ATENÇÃO: `group-hover:` e `peer-hover:` TAMBÉM entram nesta chave (saem
  // da mesma lista de pseudo-variantes) — no toque eles nunca disparam. Todo controle escondido (`opacity-0`) que só
  // aparece por `group-hover:` precisa também de `nohover:opacity-100` (variante abaixo), senão some para sempre no
  // celular/tablet.
  future: { hoverOnlyWhenSupported: true },
  theme: {
    extend: {
      colors: {
        // Surfaces
        canvas: withAlpha("--canvas"),
        inset: withAlpha("--inset"),
        surface: {
          DEFAULT: withAlpha("--surface"),
          hover: withAlpha("--surface-hover"),
          soft: withAlpha("--surface-soft"),
          press: withAlpha("--surface-press"),
        },
        // Foreground (text / icons)
        fg: {
          DEFAULT: withAlpha("--fg"),
          strong: withAlpha("--fg-strong"),
          muted: withAlpha("--fg-muted"),
          subtle: withAlpha("--fg-subtle"),
        },
        // Borders (also usable as bg for dividers: `bg-line-muted`)
        line: {
          DEFAULT: withAlpha("--line"),
          muted: withAlpha("--line-muted"),
          emphasis: withAlpha("--line-emphasis"),
        },
        // Interactive accent (links, active nav, selected, focus). `accent-ink` é o mesmo âmbar escurecido para TEXTO
        // (links do Inbox): o âmbar cheio dá 2,19:1 sobre o branco e reprova AA; a tinta passa nos dois temas.
        accent: {
          DEFAULT: withAlpha("--accent"),
          ink: withAlpha("--accent-ink"),
        },
        // Primary call-to-action (create / save) — GitHub green button
        primary: {
          DEFAULT: withAlpha("--primary"),
          hover: withAlpha("--primary-hover"),
          fg: withAlpha("--primary-fg"),
        },
        // Danger — a tinta do erro (ícone/filete de aviso, texto de falha). Terracota quente, na
        // família do papel; evita o `red-500` cru voltar a ser cravado componente a componente.
        danger: {
          DEFAULT: withAlpha("--danger"),
          fg: withAlpha("--danger-fg"),
        },
        // Os ESTADOS de presença (globals.css; o mapa por presença em lib/storymap/presence-tone.ts) — uma cor, um
        // significado, igual no nav e no card.
        state: {
          owner: withAlpha("--state-owner"),
          "owner-fg": withAlpha("--state-owner-fg"),
          working: withAlpha("--state-working"),
          delivering: withAlpha("--state-delivering"),
          idle: withAlpha("--state-idle"),
          live: withAlpha("--state-live"),
        },
        // O QUADRO NOVO (Kanban por funcionalidade — globals.css explica cada um): o fundo do quadro, o poço do fluxo,
        // os estados do desenho (forma + tinta AA) e as caixinhas. `bg-st-run/[0.08]` é a tinta clara de um bloco.
        board: withAlpha("--board"),
        well: withAlpha("--well"),
        st: {
          run: withAlpha("--st-run"),
          err: withAlpha("--st-err"),
          "err-ink": withAlpha("--st-err-ink"),
          attn: withAlpha("--st-attn"),
          "attn-ink": withAlpha("--st-attn-ink"),
          queued: withAlpha("--st-queued"),
          forgot: withAlpha("--st-forgot"),
          new: withAlpha("--st-new"),
        },
        crate: {
          line: withAlpha("--crate-line"),
          fill: withAlpha("--crate-fill"),
          pile: withAlpha("--crate-pile"),
        },
        // Marca — o laranja aviação do lockup. Fora do acento funcional (âmbar) de propósito: hoje
        // só o logo e o contador do Inbox (o "quantos te esperam") o usam.
        brand: withAlpha("--brand-orange"),
      },
      borderColor: {
        DEFAULT: withAlpha("--line"),
      },
      ringColor: {
        DEFAULT: withAlpha("--accent"),
      },
      fontFamily: {
        sans: [
          "var(--font-sans)",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "var(--font-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
        // O "Agile" manuscrito do logo (Playpen Sans, --font-brand). Só o <AgileHarnessLogo> usa.
        brand: ["var(--font-brand)", "Playpen Sans", "cursive"],
      },
    },
  },
  // As faixas de computador pela ALTURA (`tall:` / `short:`) — src/lib/viewport.ts explica. Variantes e não `screens`:
  // um `screens` com objeto `raw` desliga os `max-md:` do Tailwind, que o app usa em toda parte.
  plugins: [
    plugin(({ addVariant }) => {
      for (const [name, media] of Object.entries(VIEWPORT_VARIANTS)) addVariant(name, `@media ${media}`);
      // `nohover:` — o complemento EXATO da media que `hoverOnlyWhenSupported` põe em `hover:`/`group-hover:`: onde
      // não há hover de verdade (toque, caneta, tablet), o que só se revelaria no hover fica visível.
      addVariant("nohover", "@media not all and (hover: hover) and (pointer: fine)");
    }),
  ],
};

export default config;
