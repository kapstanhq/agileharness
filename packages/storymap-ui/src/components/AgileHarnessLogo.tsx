// O LOGO do AgileHarness — o lockup "Agile·HARNESS" da rodada 4 do design.
//
// Três peças coladas, alinhadas pela BASE (flex-end):
//   "Agile"  — manuscrito (Playpen Sans, exposto como --font-brand no layout), peso 500;
//   o ponto  — um pixel quadrado no LARANJA AVIAÇÃO da marca (#FF4F00, via --brand-orange). É uma cor
//              de MARCA fixa (não o acento funcional âmbar do app), a mesma do ícone/splash;
//   "HARNESS"— pixel-art de altura fixa, um grid 68×10 desenhado em <rect>, em currentColor.
//
// currentColor governa "Agile" + "HARNESS" (herdam o text-fg de quem monta o logo — grafite no
// claro, quase-branco no escuro); só o ponto foge para o laranja da marca. Tudo escala de UM número: `size`
// = a altura ótica do HARNESS em px, e o resto sai das razões do design (Agile = 1,45× · ponto =
// ¼ · largura do svg = 6,8× a altura, do próprio grid 68×10). Sem hooks → server-component-safe.
//
// ⚠️ O HARNESS é pixel-art mas **NÃO** declara `shape-rendering: crispEdges` — e aqui a razão é ainda
// mais forte do que no mascote. O grid tem 10 unidades de altura e o `size` usado na barra é 13, ou
// seja **1,3 pixel por unidade**: fração em QUALQUER tela, sem depender de zoom nenhum. Com o modo
// "crisp", cada aresta arredonda sozinha e hastes que medem as MESMAS 2 unidades saem com larguras
// diferentes — medido a size 13 / DPR 1: as duas hastes do H rendiam 3px e 2px, uma 50% mais grossa
// que a outra. Sem o atributo, a fração vira meio-tom e toda haste soma a mesma tinta (2,6px), que é
// o desenho fiel. Só há escala inteira quando `size` é múltiplo de 10 (o login, a 20) — e o desenho
// não pode depender de o consumidor lembrar disso. A trava está em
// `components/pixel-art-rendering.test.ts`.

// O grid pixel de HARNESS (x, y, largura, altura) no sistema de coordenadas 0..68 × 0..10.
// Sete glifos de ~10px: H · A · R · N · E · S · S — transcrito 1:1 do artefato do design.
//
// EXPORTADO porque o lockup também é assado fora do React: `scripts/gen-splash.ts` compõe as telas de
// abertura do PWA com o MESMO desenho. Duplicar a tabela lá seria criar a segunda verdade que o
// splash já teve uma vez — ele ficou com o mascote antigo por meses justamente por não ter produtor.
export const HARNESS_PIXELS: ReadonlyArray<readonly [number, number, number, number]> = [
  // H
  [0, 0, 2, 10], [6, 0, 2, 10], [2, 4, 4, 2],
  // A
  [12, 0, 4, 2], [10, 2, 2, 8], [16, 2, 2, 8], [12, 4, 4, 2],
  // R
  [20, 0, 2, 10], [22, 0, 4, 2], [26, 2, 2, 2], [22, 4, 4, 2], [24, 6, 2, 2], [26, 8, 2, 2],
  // N
  [30, 0, 2, 10], [36, 0, 2, 10], [32, 2, 2, 3], [34, 5, 2, 3],
  // E
  [40, 0, 8, 2], [40, 2, 2, 6], [40, 4, 6, 2], [40, 8, 8, 2],
  // S
  [50, 0, 8, 2], [50, 2, 2, 2], [50, 4, 8, 2], [56, 6, 2, 2], [50, 8, 8, 2],
  // S
  [60, 0, 8, 2], [60, 2, 2, 2], [60, 4, 8, 2], [66, 6, 2, 2], [60, 8, 8, 2],
];

export function AgileHarnessLogo({
  size = 13,
  className,
}: {
  /** altura ótica do HARNESS em px (o "tamanho" do logo); tudo escala a partir dela. */
  size?: number;
  className?: string;
}) {
  const agileSize = Math.round(size * 1.45); // "Agile" = 1,45× a altura do HARNESS
  const dot = Math.round(size / 4); // o pixel de junção = ¼ da altura
  const dotMb = Math.round(size / 3); // recuo que alinha o ponto pela base do bloco
  const svgW = size * 6.8; // aspecto do grid 68×10
  const gap = size >= 16 ? 3 : 2;

  return (
    <span
      role="img"
      aria-label="AgileHarness"
      className={className}
      style={{ display: "inline-flex", alignItems: "flex-end", gap, lineHeight: 1 }}
    >
      <span
        aria-hidden
        style={{
          fontFamily: "var(--font-brand), 'Playpen Sans', cursive",
          fontWeight: 500,
          fontSize: agileSize,
          lineHeight: 0.72,
          letterSpacing: "-0.09em",
        }}
      >
        Agile
      </span>
      <span
        aria-hidden
        style={{
          width: dot,
          height: dot,
          background: "rgb(var(--brand-orange))",
          flex: "none",
          marginBottom: dotMb,
        }}
      />
      <svg
        aria-hidden
        width={svgW}
        height={size}
        viewBox="0 0 68 10"
        // Aqui NÃO vai atributo de shape-rendering — ver a nota no topo: a 1,3px por unidade o modo
        // "crisp" faz hastes iguais saírem com larguras diferentes.
        style={{ display: "block", flex: "none" }}
      >
        <g fill="currentColor">
          {HARNESS_PIXELS.map(([x, y, w, h], i) => (
            <rect key={i} x={x} y={y} width={w} height={h} />
          ))}
        </g>
      </svg>
    </span>
  );
}
