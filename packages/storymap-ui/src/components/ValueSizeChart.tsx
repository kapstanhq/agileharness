"use client";

// VALOR × TAMANHO — o único gráfico da priorização.
//
// Os eixos SÃO a fórmula: y = Custo de Atraso (valor + urgência + destravamento), x = tamanho. O WSJF
// é y/x, então cada corte de tier vira uma LINHA no plano e a FAIXA acima dela é aquele tier. Quem
// olha aprende a régua sem legenda: topo-esquerda entrega mais por menos, e a inclinação mostra por
// que um item grande precisa de valor proporcionalmente maior.
//
// Trocamos os 4 gráficos antigos (matriz RICE, funil, curva KANO, raias KANO) por este. Aqueles
// CLASSIFICAVAM (que categoria é isto?); a pergunta da tela é ORDENAR (o que faço primeiro?), e
// nenhum deles respondia. Pior: plotavam `riceScore`, cuja cobertura real era 39/54/3/1 cards.
//
// ── Duas decisões que vieram de MEDIR o board real, não de teoria ────────────────────────────────
//
// 1. O EIXO Y SEGUE O DADO, não o domínio teórico. CoD pode chegar a 39 (13+13+13), mas isso exige os
//    três eixos no máximo — nos 30 cards reais o CoD vai de 3 a 13, ou seja os dados ocupavam 28% da
//    altura e 72% do gráfico era vazio decorado com linhas. Um gráfico que reserva espaço para um
//    caso que não acontece está descrevendo a fórmula, não o backlog.
//
// 2. O LEQUE DE COINCIDENTES SÓ ANDA NA HORIZONTAL. A versão anterior espalhava numa espiral (dx E
//    dy) — mas `y` CODIFICA o valor, então deslocar na vertical fazia o ponto MENTIR sobre o próprio
//    CoD. Empurrar só em x é seguro: x é ordinal e o rótulo do tick continua sendo a verdade.
//
// O x é ORDINAL (as seis posições de Fibonacci igualmente espaçadas), não linear: a escala é ordinal
// por natureza, e espaçar 8→13 cinco vezes mais que 1→2 daria um vazio à direita sem significado.

import { useCallback, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { DEFAULT_TIER_CUTS, FIB, wsjfRatio, type Fib, type WsjfCall } from "@/lib/storymap/wsjf";
import type { Card } from "@/lib/storymap/types";

const COD_FLOOR = 3; // 1+1+1 — o mínimo que a escala permite
const COD_CEIL = 39; // 13+13+13
/** Altura mínima do domínio: sem isto, um board onde todo mundo tem o mesmo CoD colapsaria o eixo. */
const MIN_SPAN = 6;
const PAD = { l: 11, r: 4, t: 9, b: 16 } as const;

const xOf = (size: Fib) => PAD.l + (FIB.indexOf(size) / (FIB.length - 1)) * (100 - PAD.l - PAD.r);

interface Point {
  card: Card;
  wsjf: WsjfCall;
  cod: number;
  score: number;
  pos: number;
}

export function ValueSizeChart({
  cards,
  onOpen,
  cuts = DEFAULT_TIER_CUTS,
}: {
  /** já ORDENADOS (posição 1 = maior prioridade) e todos com wsjf */
  cards: Card[];
  onOpen: (id: string) => void;
  cuts?: { critica: number; alta: number; media: number };
}) {
  const [hover, setHover] = useState<string | null>(null);

  const points = useMemo<Point[]>(() => {
    const out: Point[] = [];
    cards.forEach((card, i) => {
      const w = card.priorityCall?.wsjf;
      const score = wsjfRatio(w);
      if (!w || score == null) return;
      out.push({ card, wsjf: w, cod: w.value + w.urgency + w.unlock, score, pos: i + 1 });
    });
    return out;
  }, [cards]);

  // O domínio do eixo Y, derivado dos pontos com uma folga de 1 ponto de CoD para cima e para baixo.
  const [lo, hi] = useMemo(() => {
    if (points.length === 0) return [COD_FLOOR, COD_FLOOR + MIN_SPAN] as const;
    const cods = points.map((p) => p.cod);
    let a = Math.max(COD_FLOOR, Math.min(...cods) - 1);
    let b = Math.min(COD_CEIL, Math.max(...cods) + 1);
    if (b - a < MIN_SPAN) b = Math.min(COD_CEIL, a + MIN_SPAN);
    if (b - a < MIN_SPAN) a = Math.max(COD_FLOOR, b - MIN_SPAN);
    return [a, b] as const;
  }, [points]);

  // Margem INTERNA: sem ela um ponto no piso do domínio (CoD 3, que existe) desenha colado na linha
  // de base e fica meio cortado pelo overflow.
  const INSET = 3;
  const yOf = useMemo(() => {
    const span = hi - lo || 1;
    const top = PAD.t + INSET;
    const bottom = 100 - PAD.b - INSET;
    return (cod: number) => bottom - ((Math.max(lo, Math.min(hi, cod)) - lo) / span) * (bottom - top);
  }, [lo, hi]);

  /** Onde a linha `y = corte × tamanho` cruza o plano visível, amostrada nas posições ordinais. */
  const isoLine = (cut: number) =>
    FIB.map((s) => `${xOf(s).toFixed(1)},${yOf(cut * s).toFixed(1)}`).join(" ");

  /**
   * O rótulo de um tier vai DENTRO da faixa que ele nomeia — ancorá-lo no FIM da linha deixava
   * ambíguo qual LADO da linha o nome descrevia.
   *
   * A posição é escolhida por DUAS regras, e a segunda existe porque a primeira sozinha errou: fixar
   * na borda esquerda perdia o rótulo "média" (ali a faixa está quase toda abaixo do piso do
   * domínio), e escolher a faixa MAIS ALTA jogava o nome exatamente onde o dado se concentra — as
   * faixas crescem com x, e o backlog também. Então: entre os ticks onde a faixa é visível, preferir
   * o de MENOR densidade de pontos; empate desempata pela faixa mais alta.
   * `null` quando a faixa não é visível em tick nenhum (aí o nome some, em vez de flutuar no vazio).
   */
  const bandLabel = (cut: number, ceiling: number): { x: number; y: number } | null => {
    let best: { x: number; y: number; h: number; near: number } | null = null;
    for (const s of FIB) {
      const bandLo = Math.max(lo, Math.min(hi, cut * s));
      const bandHi = Math.max(lo, Math.min(hi, ceiling * s));
      const h = bandHi - bandLo;
      if (h < (hi - lo) * 0.07) continue;
      const mid = (bandLo + bandHi) / 2;
      // pontos NESTE tick cuja altura cairia debaixo do rótulo
      const near = points.filter((p) => p.wsjf.size === s && Math.abs(p.cod - mid) <= (hi - lo) * 0.14).length;
      if (!best || near < best.near || (near === best.near && h > best.h)) {
        best = { x: xOf(s), y: yOf(mid), h, near };
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  };

  // índice dentro da célula exata (mesmo tamanho E mesmo CoD) — para o leque horizontal
  const { cellIdx, cellSize } = useMemo(() => {
    const seen = new Map<string, number>();
    const total = new Map<string, number>();
    const idx = new Map<string, number>();
    for (const p of points) {
      const key = `${p.wsjf.size}|${p.cod}`;
      total.set(key, (total.get(key) ?? 0) + 1);
    }
    for (const p of points) {
      const key = `${p.wsjf.size}|${p.cod}`;
      const n = seen.get(key) ?? 0;
      idx.set(p.card.id, n);
      seen.set(key, n + 1);
    }
    return { cellIdx: idx, cellSize: total };
  }, [points]);

  // ── O ALVO É O PLANO, não o ponto ──────────────────────────────────────────────────────────────
  //
  // Os pontos medem 10–12px e ABREM UM CARD ao serem clicados. Num celular isso é inalcançável, e a
  // correção óbvia — inflar a área de toque para 28px — está ERRADA aqui: o leque de colisão afasta
  // pontos do mesmo tier em 9px, então cada caixa engoliria as vizinhas e o toque abriria o card
  // errado. Trocar um alvo pequeno por um alvo grande e MENTIROSO é pior que o defeito.
  //
  // A solução canônica de gráfico de dispersão é outra: o PLANO inteiro recebe o ponteiro e resolve
  // o ponto MAIS PRÓXIMO. Cada pixel passa a pertencer a exatamente um ponto, sem sobreposição por
  // construção — o alvo efetivo vira a célula ao redor de cada marca, não um retângulo fixo.
  //
  // Os pontos continuam sendo `<button>` de verdade (foco por teclado + Enter). O que sai deles é só
  // o hit-test do PONTEIRO (`pointer-events-none`), que `pointer-events` não tira do teclado.
  const plotRef = useRef<HTMLDivElement | null>(null);
  // Sem hover no toque: `title` e passar-o-mouse não existem lá, então o primeiro toque SELECIONA
  // (revela o rótulo) e o segundo abre. No mouse, um clique abre direto — lá o alvo já é o plano.
  const coarse = useMediaQuery("(pointer: coarse)");

  const nearestAt = useCallback(
    (clientX: number, clientY: number): string | null => {
      const box = plotRef.current?.getBoundingClientRect();
      if (!box || box.width === 0) return null;
      const px = clientX - box.left;
      const py = clientY - box.top;
      let best: { id: string; d2: number } | null = null;
      for (const p of points) {
        const key = `${p.wsjf.size}|${p.cod}`;
        const n = cellSize.get(key) ?? 1;
        const i = cellIdx.get(p.card.id) ?? 0;
        const dx = n > 1 ? (i - (n - 1) / 2) * 9 : 0; // o MESMO leque do render — uma conta só
        const cx = (xOf(p.wsjf.size) / 100) * box.width + dx;
        const cy = (yOf(p.cod) / 100) * box.height;
        const d2 = (px - cx) ** 2 + (py - cy) ** 2;
        if (!best || d2 < best.d2) best = { id: p.card.id, d2 };
      }
      // Teto de 72px: um clique no canto vazio do plano não deve abrir o card do outro lado.
      return best && best.d2 <= 72 * 72 ? best.id : null;
    },
    // `xOf` NÃO entra: é const de MÓDULO (l. 40), então a identidade dela nunca muda e listá-la só
    // ensina que a lista é decorativa. `yOf` entra porque é o `useMemo` deste componente.
    [points, cellIdx, cellSize, yOf],
  );

  if (points.length === 0) return null;

  // O DEGRAU entre as faixas é o que o olho lê, não o valor absoluto de cada uma. Os alphas baixos
  // que eu tinha (0.055/0.035/0.018) funcionavam no tema claro — grafite sobre papel — e desapareciam
  // no escuro, onde a mesma tinta vira branco a 5% sobre um inset quase preto: a faixa deixava de
  // existir e voltava a ambiguidade de "qual lado da linha?". Estes degraus se sustentam nos dois.
  const bands: Array<{ cut: number; ceiling: number; label: string; tint: string }> = [
    { cut: cuts.critica, ceiling: Number.POSITIVE_INFINITY, label: "crítica", tint: "rgb(var(--fg) / 0.10)" },
    { cut: cuts.alta, ceiling: cuts.critica, label: "alta", tint: "rgb(var(--fg) / 0.055)" },
    { cut: cuts.media, ceiling: cuts.alta, label: "média", tint: "rgb(var(--fg) / 0.022)" },
  ];

  return (
    <figure className="rounded-[10px] border border-fg/[0.09] bg-inset">
      <div
        ref={plotRef}
        className="relative h-56 w-full cursor-pointer overflow-hidden sm:h-64"
        onPointerMove={(e) => {
          if (coarse) return; // no toque não existe "passar por cima" — só toque
          setHover(nearestAt(e.clientX, e.clientY));
        }}
        onPointerLeave={() => !coarse && setHover(null)}
        onClick={(e) => {
          const id = nearestAt(e.clientX, e.clientY);
          if (!id) return;
          // Toque: o 1º seleciona (revela QUAL card é), o 2º abre. Abrir no primeiro toque seria
          // abrir às cegas — o rótulo é a confirmação de que o dedo acertou o ponto que ele queria.
          if (coarse && hover !== id) {
            setHover(id);
            return;
          }
          onOpen(id);
        }}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          {/* A FAIXA de cada tier, pintada entre a sua linha e a de cima. Sombrear (em vez de só
              traçar) é o que torna "acima da linha = aquele tier" inequívoco — com linhas soltas o
              leitor não sabia qual LADO cada nome descrevia. Tinta grafite em alpha mínimo: a
              identidade é quase P&B e hierarquia se faz por peso, não por cor. */}
          {bands.map((b) => {
            // O teto da faixa mais alta é o TOPO DO DOMÍNIO — e tem de ser lido por `yOf`, igual às
            // linhas. Usar `PAD.t` cru deixava uma lasca da margem interna pintada acima da linha
            // clampada: uma tira clara atravessando o gráfico, que lia como um traço perdido.
            const topPts = Number.isFinite(b.ceiling)
              ? isoLine(b.ceiling)
              : FIB.map((s) => `${xOf(s).toFixed(1)},${yOf(hi).toFixed(1)}`).join(" ");
            const bottom = isoLine(b.cut).split(" ").reverse().join(" ");
            return <polygon key={b.label} points={`${topPts} ${bottom}`} fill={b.tint} />;
          })}
          {bands.map((b) => (
            <polyline
              key={b.label}
              points={isoLine(b.cut)}
              fill="none"
              stroke="rgb(var(--fg) / 0.22)"
              strokeWidth={1}
              strokeDasharray="2 3"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>

        {bands.map((b) => {
          const at = bandLabel(b.cut, Number.isFinite(b.ceiling) ? b.ceiling : COD_CEIL);
          if (!at) return null;
          return (
            <span
              key={b.label}
              className="pointer-events-none absolute -translate-y-1/2 whitespace-nowrap text-[9px] font-medium uppercase tracking-wide text-fg-subtle"
              style={{ left: `${at.x}%`, top: `${at.y}%`, transform: "translate(-50%, -50%)" }}
            >
              {b.label}
            </span>
          );
        })}

        {/* Eixo Y: dois valores, para o plano ser LEGÍVEL. Sem nenhum tick não dava para saber quanto
            valia a altura de um ponto — o gráfico virava só forma. */}
        <span className="pointer-events-none absolute left-1 text-[9px] tabular-nums text-fg-subtle" style={{ top: `${PAD.t}%` }}>
          {hi}
        </span>
        <span
          className="pointer-events-none absolute left-1 text-[9px] tabular-nums text-fg-subtle"
          style={{ top: `${100 - PAD.b}%`, transform: "translateY(-100%)" }}
        >
          {lo}
        </span>
        <span className="pointer-events-none absolute left-1 top-0.5 text-[9.5px] font-medium text-fg-muted">valor ↑</span>

        {/* eixo x: as seis posições da escala */}
        {FIB.map((s) => (
          <span
            key={s}
            className="pointer-events-none absolute -translate-x-1/2 text-[9.5px] tabular-nums text-fg-subtle"
            style={{ left: `${xOf(s)}%`, top: `${100 - PAD.b + 3}%` }}
          >
            {s}
          </span>
        ))}
        <span className="pointer-events-none absolute bottom-0.5 right-2 text-[9.5px] font-medium text-fg-muted">
          tamanho →
        </span>

        {points.map((p) => {
          const key = `${p.wsjf.size}|${p.cod}`;
          const n = cellSize.get(key) ?? 1;
          const i = cellIdx.get(p.card.id) ?? 0;
          // leque HORIZONTAL apenas — deslocar em y corromperia o valor que o eixo codifica
          const dx = n > 1 ? (i - (n - 1) / 2) * 9 : 0;
          const top3 = p.pos <= 3;
          const active = hover === p.card.id;
          const right = xOf(p.wsjf.size) > 62;
          return (
            <button
              key={p.card.id}
              type="button"
              onClick={() => onOpen(p.card.id)}
              onFocus={() => setHover(p.card.id)}
              onBlur={() => setHover(null)}
              title={`#${p.pos} · ${p.card.title} — WSJF ${p.score.toFixed(1)} (valor ${p.wsjf.value}, urgência ${p.wsjf.urgency}, destrava ${p.wsjf.unlock}, tamanho ${p.wsjf.size})`}
              aria-label={`${p.card.title}, posição ${p.pos}, WSJF ${p.score.toFixed(1)}`}
              className={cn(
                // `pointer-events-none` tira do PONTEIRO, não do TECLADO: o botão continua na ordem
                // de tabulação e o Enter num botão focado ainda dispara `click`. Quem usa mouse ou
                // dedo é atendido pelo plano (ponto mais próximo); quem usa teclado continua com o
                // alvo exato, que é o melhor dos dois. Os handlers de mouse saíram daqui porque o
                // hover agora nasce do plano — mantê-los criaria duas fontes para o mesmo estado.
                "pointer-events-none absolute rounded-full border outline-none ring-offset-1 ring-offset-inset transition focus-visible:ring-2 focus-visible:ring-accent",
                // ponto maior que antes: o DADO é o assunto do gráfico, as linhas são o pano de fundo
                top3 ? "h-3 w-3 border-accent bg-accent" : "h-2.5 w-2.5 border-fg/30 bg-fg/55",
                active && "z-20 scale-125 !border-fg !bg-fg",
              )}
              style={{
                left: `${xOf(p.wsjf.size)}%`,
                top: `${yOf(p.cod)}%`,
                transform: `translate(calc(-50% + ${dx}px), -50%)`,
              }}
            >
              {active && (
                <span
                  className={cn(
                    "pointer-events-none absolute top-1/2 z-30 max-w-[190px] -translate-y-1/2 truncate rounded-md border border-line bg-surface px-1.5 py-0.5 text-[10px] font-medium leading-tight text-fg shadow-sm",
                    right ? "right-full mr-2" : "left-full ml-2",
                  )}
                >
                  <span className="tabular-nums text-fg-subtle">#{p.pos}</span> {p.card.title}
                  {/* No toque o rótulo é a CONFIRMAÇÃO de que o dedo acertou — e precisa dizer o que
                      fazer com ela, senão o segundo toque é adivinhação. No mouse, silêncio: lá o
                      clique já abre e a dica seria ruído. */}
                  {coarse && <span className="ml-1 text-fg-subtle">· toque de novo para abrir</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <figcaption className="border-t border-fg/[0.06] px-3 py-1.5 text-[10.5px] leading-snug text-fg-subtle">
        Altura = valor + urgência + destravamento; horizontal = tamanho. Cada faixa é um tier — quanto
        mais alto e mais à esquerda, mais cedo.
      </figcaption>
    </figure>
  );
}
