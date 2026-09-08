"use client";

import { useEffect, useState } from "react";

/**
 * Se a viewport casa `query` AGORA. Começa `false` para que o render do servidor e o primeiro render do cliente
 * concordem (sem mismatch de hidratação), e sobe no mount.
 *
 * Por que isto tem de ser JS e não uma classe `hidden lg:flex`: um painel escondido por CSS continua MONTADO.
 * Num celular, o chat existiria duas vezes (o rail escondido + a folha) brigando pela mesma sessão, pelo mesmo
 * lease de turno e pela mesma chave de fila no sessionStorage. **Layout por CSS, montagem por JS** — e o buraco
 * de um quadro entre os dois é o que o fantasma do dock preenche.
 *
 * Havia três cópias desta função (InicioScreen, BoardHeader e a que o ChatDock precisaria). Uma regra de layout
 * duplicada é uma regra que vai divergir: quando o breakpoint do rail mudar, uma das cópias fica para trás e o
 * chat passa a montar em duas larguras diferentes na mesma tela.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setMatches(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [query]);
  return matches;
}
