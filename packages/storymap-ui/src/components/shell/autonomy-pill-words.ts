// As PALAVRAS da pílula de Autonomia da barra do topo — PURO (o teste lê daqui; o componente as desenha).
//
// No computador a pílula diz «Autonomia: Máxima». No celular (390px) não cabe a frase: antes ela mostrava as barras e
// uma LETRA («X» para Máxima, «M» para Mínima), que ninguém lia como nível. Agora mostra as barras e a palavra curta
// («Máx» / «Mín» / «Pers.») — e o nome inteiro do nível segue no `aria-label` e no `title`. O nível é o que a tela
// mostra (`shownPresetOf`): com uma caixa fora do modo pronto é «Personalizada», e o `title` diz o quanto ela difere
// («Máxima, sem a Sentinela» — `presetGapWords`).

import { PRESET_LABEL, type AutonomyPreset } from "@/lib/storymap/autonomy-profile";

/** A palavra curta do nível, a que cabe ao lado das barras no celular. */
export const PRESET_SHORT: Readonly<Record<AutonomyPreset, string>> = { minima: "Mín", maxima: "Máx", personalizada: "Pers." };

/** O que a pílula diz: a palavra curta (celular), o rótulo inteiro (computador), o `title` e o `aria-label`. */
export function autonomyPillWords(preset: AutonomyPreset, gap?: string | null): { short: string; label: string; title: string; ariaLabel: string } {
  const label = `Autonomia: ${PRESET_LABEL[preset]}`;
  const full = gap ? `${label} (${gap})` : label;
  return {
    short: PRESET_SHORT[preset],
    label,
    title: `${full} — o que os agentes fazem sozinhos neste board`,
    ariaLabel: `${full} — abrir o painel de autonomia`,
  };
}
