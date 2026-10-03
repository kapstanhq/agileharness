"use client";

import { useEffect, useState } from "react";

/**
 * O relógio de quem lê: 0 no servidor e no primeiro render (nenhuma idade calculada no fuso da VPS, e a hidratação
 * não discorda), carimbado no mount e empurrado a cada 30 s para «há 12 min» não apodrecer na tela.
 */
export function useNow(stepMs = 30_000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(t);
  }, [stepMs]);
  return now;
}
