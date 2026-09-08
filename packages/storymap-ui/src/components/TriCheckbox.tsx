"use client";

// Tri-state checkbox (checked / unchecked / indeterminate) — o controle de seleção COMPARTILHADO da
// plataforma: a árvore de proposta da captura (cascata dura parent-closed) E a multi-seleção PLANA de
// cards reais (lote de ideias no HUB da captura + na bancada de Ideias). Extraído do
// ProposalTree para que os dois níveis rendam o MESMO checkbox nativo (acessível por teclado).

import { useEffect, useRef } from "react";

export type TriState = "on" | "off" | "indeterminate";

export function TriCheckbox({
  state,
  onChange,
  label,
  className,
}: {
  state: TriState;
  onChange: () => void;
  /** aria-label completo do checkbox (ex.: "Incluir «título»" / "Selecionar «título»"). */
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "indeterminate";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === "on"}
      onChange={onChange}
      className={"accent-accent shrink-0 cursor-pointer " + (className ?? "")}
      aria-label={label}
    />
  );
}
