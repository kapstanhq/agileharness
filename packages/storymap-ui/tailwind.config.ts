import type { Config } from "tailwindcss";

// Own, neutral flat identity backed by SEMANTIC tokens (see globals.css). Every
// surface/border/text colour resolves to a CSS variable so the views share ONE
// palette and can't drift apart in dark mode. Modelled on GitHub Primer.
const withAlpha = (v: string) => `rgb(var(${v}) / <alpha-value>)`;

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Surfaces
        canvas: withAlpha("--canvas"),
        inset: withAlpha("--inset"),
        surface: {
          DEFAULT: withAlpha("--surface"),
          hover: withAlpha("--surface-hover"),
        },
        // Foreground (text / icons)
        fg: {
          DEFAULT: withAlpha("--fg"),
          muted: withAlpha("--fg-muted"),
          subtle: withAlpha("--fg-subtle"),
        },
        // Borders (also usable as bg for dividers: `bg-line-muted`)
        line: {
          DEFAULT: withAlpha("--line"),
          muted: withAlpha("--line-muted"),
          emphasis: withAlpha("--line-emphasis"),
        },
        // Interactive accent (links, active nav, selected, focus)
        accent: withAlpha("--accent"),
        // Primary call-to-action (create / save) — GitHub green button
        primary: {
          DEFAULT: withAlpha("--primary"),
          hover: withAlpha("--primary-hover"),
          fg: withAlpha("--primary-fg"),
        },
        // Danger — a tinta do erro (ícone/filete de aviso, texto de falha). Terracota quente, na
        // família do papel; evita o `red-500` cru voltar a ser cravado componente a componente.
        danger: withAlpha("--danger"),
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
  plugins: [],
};

export default config;
