"use client";

// O ROSTO do Jido, na tela — o mascote pixel-art do AgileHarness.
//
// Este componente é DE PROPÓSITO burro: a ARTE (corpo, olhos, braços, glifos por humor) vive pura em
// lib/storymap/copilot/mascot.ts, e o HUMOR (sinais → qual humor) em lib/storymap/copilot/face.ts, ambos onde
// o vitest alcança. Aqui só tem PINTURA — traduzir a arte declarativa para SVG.
//
// Três decisões que valem o comentário:
//
// 1. É SVG em GRADE INTEIRA, não texto e não escala livre. O rosto ASCII antigo dependia da fonte do
//    LEITOR e aparecia rasgado; retângulos não dependem de fonte nenhuma. A viewBox é a grade de
//    células (`GRID` = 50, a grade do Claude Design: 1 célula = 2 unidades da prancha de 100), e a
//    escada de tamanhos (`SIZE_PX`) é escolhida para cair em célula inteira onde dá. O porquê longo —
//    inclusive por que o degrau do topnav é a exceção assumida — está no topo de `mascot.ts`.
//
// 1b. …e por isso NÃO usamos `shape-rendering="crispEdges"`. Parece a escolha óbvia para pixel-art, e
//    era a que estava aqui, mas ela ARREDONDA CADA ARESTA SOZINHA. Enquanto a escala é inteira isso não
//    muda nada — medimos: a 1×, `crispEdges` e o antialiasing padrão produzem bitmaps IDÊNTICOS, porque
//    toda aresta já cai em pixel cheio e não há cobertura parcial para suavizar. O problema aparece
//    quando a escala NÃO é inteira, que é a vida real: zoom de navegador em 90%/110% e escala de tela
//    do Windows em 125%/175% dão 2,5 ou 3,5 pixels por célula. Aí `crispEdges` arredonda cada borda
//    para o lado mais próximo e peças do MESMO tamanho saem com tamanhos diferentes — a 0,875 o bulbo
//    da antena fica descentrado, um olho fica maior que o outro e um pé mais largo que o outro. O
//    desenho não fica só borrado: fica TORTO, que é muito pior num rosto (relato de 2026-08-03).
//    Sem o atributo, a escala fracionária vira uma borda de meio-tom — levemente suave, mas SIMÉTRICA
//    e proporcional. Trocamos "duro e deformado" por "macio e correto", sem custo nenhum onde a escala
//    é inteira. Não reintroduza `crispEdges` sem medir os dois nas duas escalas.
//
// 2. Os olhos/boca são FUROS de geometria — um `<path>` só, com os recortes em sentido invertido sob a
//    regra `nonzero` (`silhouettePath`). A `<mask>` que fazia esse papel rasterizava num buffer próprio e
//    devolvia alpha parcial nas bordas: no topnav a boca saía CINZA, não vazada. Com furo de caminho, a
//    silhueta é `currentColor` (a tinta `--fg`, herdada por className) e o buraco revela o FUNDO do painel
//    — a mesma arte serve ao tema claro e ao escuro sem uma segunda paleta.
//
// 3. As animações são CSS puro (só transform/opacity → GPU, custo ~zero) e vivem em globals.css sob o prefixo
//    `jido-*`. Uma regra `@media (prefers-reduced-motion: reduce)` as CONGELA — um mascote piscando no canto é
//    exatamente o movimento periférico que dispara enxaqueca e desvia atenção de quem pediu para a tela parar.

import { cn } from "@/lib/cn";
import { EXPRESSIONS, type MoodId } from "@/lib/storymap/copilot/face";
import {
  GRID,
  MASCOT,
  RESTING,
  SIZE_PX,
  silhouettePath,
  type FaceSize,
  type MascotAnim,
  type MascotArt,
} from "@/lib/storymap/copilot/mascot";

export type { FaceSize };

export function CopilotFace({
  mood,
  size = "md",
  className,
  title,
}: {
  mood: MoodId;
  size?: FaceSize;
  className?: string;
  /** tooltip — default: o rótulo do humor ("Copiloto pensando"). */
  title?: string;
}) {
  const meta = EXPRESSIONS[mood];
  return (
    <Mascot
      art={MASCOT[mood]}
      size={size}
      className={className}
      label={meta.label}
      title={title ?? meta.label}
      // O humor é a CHAVE do grupo desenhado: mudou de humor, o grupo remonta e a animação de troca
      // (`jido-swap`) corre. Sem isso a pose troca num salto seco, que lê como glitch e não como
      // reação — ver o comentário do `.jido-swap` em globals.css.
      swapKey={mood}
    />
  );
}

/**
 * O JIDO ESCREVENDO — o mascote LOGO ABAIXO do texto que está saindo.
 *
 * É o sinal de streaming do painel: o lugar onde a resposta está crescendo passa a ter uma cara em vez de um
 * retângulo piscando. Ele vive numa linha própria (o `HitlConversation` o põe depois do último bloco de
 * texto), no MESMO tamanho do rosto do topnav — antes ele era um cursor de 15px espremido dentro do
 * parágrafo, e um mascote do tamanho de uma letra não é um mascote.
 *
 * DECORATIVO por construção (sem `label` ⇒ `aria-hidden`): a mesma cara já é anunciada pelo mascote do
 * topnav e o estado do turno já é lido em voz alta pelo "pensando…"; um leitor de tela repetindo "Copiloto
 * respondendo" a cada token seria ruído, não acessibilidade.
 */
export function JidoCursor({ mood, className }: { mood: MoodId; className?: string }) {
  return <Mascot art={MASCOT[mood]} size="xs" className={cn("jido-cursor", className)} swapKey={mood} />;
}

/**
 * O JIDO EM REPOUSO — a marca, não o copiloto.
 *
 * Existe para superfícies onde o mascote é IDENTIDADE e não estado de agente (hoje: a tela de
 * login). Usa `RESTING` — dois olhos, sem boca, sem wink — em vez de emprestar um humor: um humor
 * ali seria mentira (não há copiloto rodando para estar "tranquilo" ou "pronto"), e o wink do
 * `piscando` chegava a parecer uma resposta a algo que o operador ainda nem fez.
 */
export function JidoResting({
  size = "lg",
  className,
  label,
}: {
  size?: FaceSize;
  className?: string;
  /**
   * Rótulo para leitor de tela. OMITIDO = decorativo (`aria-hidden`), que é o certo quando o nome
   * do produto já está escrito ao lado: na tela de login o mascote fica logo acima do lockup
   * "Agile·HARNESS", e rotular os dois como "AgileHarness" fazia o leitor anunciar o nome DUAS
   * vezes seguidas. Uma ilustração que repete o texto vizinho é ruído, não informação.
   */
  label?: string;
}) {
  return <Mascot art={RESTING} size={size} className={className} label={label} title={label} />;
}

/** A PINTURA em si — recebe a arte pronta e não sabe nada de humor. É o que garante UMA implementação
 *  do furo/pálpebra/glifo, com ou sem copiloto por trás. */
function Mascot({
  art,
  size,
  className,
  label,
  title,
  swapKey,
}: {
  art: MascotArt;
  size: FaceSize;
  className?: string;
  /** ausente ⇒ o desenho é DECORATIVO (`aria-hidden`), sem papel de imagem na árvore de acessibilidade. */
  label?: string;
  title?: string;
  /** Muda quando a POSE muda (o humor). Vira a `key` do grupo → o React remonta e a animação de troca
   *  recomeça. Ausente (marca em repouso, que nunca troca de cara) ⇒ o grupo nunca remonta. */
  swapKey?: string;
}) {
  const px = SIZE_PX[size];
  const shake = art.anim === "shake";

  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={title ?? label}
      // TINTA (`text-fg`), sem placa nem moldura: o mascote é desenho solto sobre o painel. `lineHeight:0`
      // impede que o descender da linha reserve altura fantasma (era o que empurrava a barra do header).
      className={cn("inline-flex select-none text-fg", className)}
      style={{ lineHeight: 0 }}
    >
      <svg
        // A `key` é o HUMOR: trocou de pose, o SVG inteiro remonta e o `jido-swap` corre de novo,
        // dando à troca o quadro de assentamento que faltava.
        //
        // A REGRA que este arranjo respeita: **um elemento, uma animação**. `jido-swap` mora aqui, no
        // `<svg>`; `jido-anim-shake` mora no `<g>` de dentro — elementos DIFERENTES, então as duas
        // convivem e o pânico treme enquanto assenta. Se as duas estivessem no MESMO elemento, a
        // propriedade-atalho `animation` da regra que viesse depois na folha ANULARIA a outra (não
        // somam), e o tremor comeria a troca ou vice-versa conforme a ordem do CSS. Por isso o gancho
        // não desceu para o `<g>`: lá o shake já estava.
        key={swapKey}
        className={cn("jido-mascot", swapKey && "jido-swap")}
        width={px}
        height={px}
        viewBox={`0 0 ${GRID} ${GRID}`}
        // Aqui NÃO vai atributo de shape-rendering — de propósito. Ver a nota 1b no topo: em escala
        // inteira o modo "crisp" é indistinguível do padrão, e em escala fracionária (zoom 90%/110%,
        // tela a 125%/175%) é ele que entorta o rosto, arredondando cada aresta por conta própria.
        fill="currentColor"
        aria-hidden
      >
        {/* `shake` treme o desenho INTEIRO (glitch/pânico); os demais humores ficam firmes. */}
        <g className={shake ? "jido-anim-shake" : undefined}>
          {/* A silhueta com os furos já vazados — corpo + braços + recortes, num caminho só. */}
          <path d={silhouettePath(art)} />

          {/* PÁLPEBRAS — retângulos na cor do corpo, sobre os olhos: fechados por CSS na piscada, senão scaleY(0)
              (invisíveis, o olho vazado aparece). Dois olhos piscam levemente defasados p/ parecer natural. */}
          {art.blinkEyes?.map((p, i) => (
            <rect
              key={`lid-${i}`}
              className="jido-eyelid jido-blink"
              x={p[0]}
              y={p[1]}
              width={p[2]}
              height={p[3]}
              // Defasagem MÍNIMA entre os dois olhos: dois olhos que fecham no mesmo milissegundo
              // leem como um obturador, não como um rosto. Eram 90ms — mais do que a piscada nova
              // leva fechada (~150ms nas duas batidas), o que fazia a dupla sair "olho, olho, olho,
              // olho" em vez de duas piscadas. 40ms é a menor defasagem que ainda se sente.
              style={{ animationDelay: `${i * 0.04}s` }}
            />
          ))}

          {/* LÁBIO — só no `falando`: um retângulo que abre/fecha sobre o recorte da boca (a fala). */}
          {art.lips && (
            <rect
              className="jido-lip jido-talk"
              x={art.lips[0]}
              y={art.lips[1]}
              width={art.lips[2]}
              height={art.lips[3]}
            />
          )}

          {/* GLIFOS externos (z, !, ✦, ondas) — na cor do mascote, POR CIMA (não recortados). Podem pulsar
              (pensar/ondas/✦) ou flutuar (os z do sono). Retângulos como o resto: nada de fonte.

              Cada GLIFO ganha um `<g>` próprio, e é ele — não o retângulo — que recebe a animação e a
              defasagem. Um `z` são três barras: com a defasagem por retângulo (como era), as três
              subiam em tempos diferentes e o glifo se desmanchava no ar. A regra do CSS
              (`.jido-anim-* > *`) mira o filho DIRETO, então trocar retângulo por grupo já move o
              glifo inteiro de uma vez. Ver `InkGlyph` em mascot.ts. */}
          {art.ink && art.ink.length > 0 && (
            <g className={animClass(art.anim)}>
              {art.ink.map((glyph, i) => (
                <g key={`ink-${i}`} style={{ animationDelay: `${i * 0.14}s` }}>
                  {glyph.map((p, j) => (
                    <rect key={j} x={p[0]} y={p[1]} width={p[2]} height={p[3]} />
                  ))}
                </g>
              ))}
            </g>
          )}
        </g>
      </svg>
    </span>
  );
}

function animClass(anim?: MascotAnim): string | undefined {
  switch (anim) {
    case "pulse":
      return "jido-anim-pulse";
    case "float":
      return "jido-anim-float";
    default:
      return undefined; // `shake` é tratado no corpo; `none`/undefined → sem animação de grupo
  }
}
