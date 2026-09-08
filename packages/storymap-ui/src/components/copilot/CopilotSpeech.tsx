"use client";

// O BALÃO DE FALA do Jido — pendurado no mascote do topnav.
//
// Com o mascote fora do chat, a "linha viva" que morava ao lado dele (`dormindo · acme`) não tinha mais onde
// ficar: no topnav não cabe um rótulo permanente, e um mascote mudo no canto da barra não conta nada. Então ele
// FALA — a mesma informação, mas com a forma certa para a barra: um balão que
//   • aparece SOZINHO por alguns segundos quando há fala nova (`useSpeechCue`, por BORDA da `key`), e
//   • aparece no HOVER, aí com o conteúdo rico (as últimas decisões, os números da sessão, o atalho do chat).
//
// O componente não decide NADA sobre o que é dito: o texto vem pronto de `copilot/speech.ts` (puro/testado).
// Aqui é só pintura — a bolha, o rabinho apontando para a cabeça, e a transição.
//
// A cor segue a regra do painel: superfície neutra, tinta comum, e o ESTADO no ponto (`DOT[tone]`).

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { DOT, TXT } from "./ui";
import {
  BUBBLE_DWELL_MS,
  BUBBLE_DWELL_URGENT_MS,
  type CopilotSpeech,
} from "@/lib/storymap/copilot/speech";

/**
 * "Ele acabou de dizer algo?" — true por alguns segundos a cada fala NOVA (a `key` mudou).
 *
 * Só a BORDA fala: abrir uma página não é o Jido dizer alguma coisa, e sem isto TODA navegação abriria um
 * balão. Mesma disciplina do sinal de movimento que a barra já usava — quem espera um nível e não uma borda
 * acaba com um aviso permanente que ninguém lê.
 *
 * `ready` é o que separa "ele falou" de "o dado chegou": no 1º paint o topnav ainda não leu o overview nem o
 * medidor, então a fala nasce genérica ("Tudo tranquilo") e vira a real ("Estou dormindo…") assim que os
 * fetches voltam — uma MUDANÇA de key que não é fala nenhuma. Enquanto `ready` for false o baseline
 * acompanha a key em silêncio; medido no board (o balão abria sozinho a cada F5).
 */
export function useSpeechCue(key: string, urgent = false, ready = true): boolean {
  const [visible, setVisible] = useState(false);
  const spoken = useRef<string | null>(null);
  const wasReady = useRef(ready);
  useEffect(() => {
    // A VIRADA de `ready` também absorve a key em silêncio. Sem isto o gate não resolvia nada: o último fetch a
    // voltar entrega o dado E liga o `ready` no MESMO commit, então a fala definitiva ("Estou dormindo…")
    // chegava já com o portão aberto e abria o balão a cada carregamento de página — exatamente o que o gate
    // existe para impedir. A partir daqui, a 1ª fala do mount NUNCA fala; a 2ª em diante, sim.
    const justReady = ready && !wasReady.current;
    wasReady.current = ready;
    if (!ready || justReady || spoken.current === null) {
      spoken.current = key; // baseline (mount / dados ainda chegando / acabou de hidratar) — não é fala
      return;
    }
    if (spoken.current === key) return;
    spoken.current = key;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), urgent ? BUBBLE_DWELL_URGENT_MS : BUBBLE_DWELL_MS);
    return () => clearTimeout(t);
  }, [key, urgent, ready]);
  return visible;
}

/**
 * A bolha em si. `open=false` a mantém MONTADA porém invisível e fora do foco (transição de opacidade em vez de
 * montar/desmontar: um balão que pisca para dentro do DOM não tem como sair suave).
 *
 * `children` é o conteúdo RICO (só no hover): o diário, os números, o atalho. Sem ele a bolha é só a fala —
 * que é o que o operador precisa ver quando ela aparece sozinha no meio de outra coisa.
 */
export function CopilotSpeechBubble({
  speech,
  open,
  href,
  children,
  onMouseEnter,
  onMouseLeave,
}: {
  speech: CopilotSpeech;
  open: boolean;
  /**
   * PARA ONDE esta fala leva, quando leva a algum lugar (o card que se moveu, o terminal que travou).
   *
   * Presente ⇒ a FRASE vira link. Não a bolha inteira: ela é vizinha de um `<button>` (o Jido) e
   * envolver tudo num `<a>` daria duas áreas clicáveis sobrepostas com destinos diferentes — e o
   * conteúdo rico do hover tem o seu próprio atalho ("conversar →"). O alvo é o texto, que é o que o
   * operador está lendo quando decide ir.
   */
  href?: string;
  children?: ReactNode;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  return (
    <div
      // `top-full` + `mt-2` = pendurado logo abaixo da cabeça. Centralizado nela a partir de `sm`; no CELULAR
      // ancorado à DIREITA, porque lá o mascote mora na ponta da barra e um balão centrado nele nasce metade
      // fora da tela (visto no 375×812: a frase saía cortada pela borda).
      className={cn(
        "absolute right-0 top-full z-50 mt-2 transition duration-200 ease-out sm:left-1/2 sm:right-auto sm:-translate-x-1/2",
        open ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0",
      )}
      aria-hidden={!open}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div
        className={cn(
          "relative w-max max-w-[min(20rem,80vw)] rounded-xl border border-line bg-surface px-3 py-2 text-left shadow-lg",
          children ? "min-w-[14rem]" : undefined,
        )}
        role="status"
        aria-live="polite"
      >
        {/* o rabinho — um quadrado girado com as MESMAS duas bordas de cima do balão, para a costura sumir.
            Ele segue a âncora: sob o centro da cabeça no desktop, sob a cabeça encostada na direita no celular
            (a cabeça tem 38px ⇒ o centro dela fica a 19px da borda, menos 4px de meio-rabinho). */}
        <span
          aria-hidden
          className="absolute -top-[5px] right-[15px] h-2 w-2 rotate-45 border-l border-t border-line bg-surface sm:left-1/2 sm:right-auto sm:-translate-x-1/2"
        />
        <p className={cn("flex items-start gap-1.5 leading-snug text-fg", TXT.label)}>
          <span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", DOT[speech.tone], speech.urgent && "animate-pulse")} />
          {href ? (
            // A seta é a AFFORDANCE: sem ela o link só apareceria no hover (sublinhado), e o balão fica
            // na tela poucos segundos — tempo curto demais para descobrir por exploração que dá para ir.
            <Link href={href} className="group/link min-w-0 hover:underline">
              {speech.line}
              <span aria-hidden className="ml-1 inline-block text-accent transition-transform group-hover/link:translate-x-0.5">
                →
              </span>
            </Link>
          ) : (
            <span className="min-w-0">{speech.line}</span>
          )}
        </p>
        {speech.note && <p className={cn("mt-0.5 pl-3 text-fg-subtle", TXT.meta)}>{speech.note}</p>}
        {children}
      </div>
    </div>
  );
}
