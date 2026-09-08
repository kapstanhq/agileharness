// O ESCOPO de uma promoção: quais prefixos de caminho um board leva de `stage` para `main`.
//
// Extraído de `fireReleaseStaged` (entry-effects) para ter UMA definição: a página de Entrega precisa
// medir exatamente o delta que a promoção levaria, e uma segunda derivação do escopo — mesmo idêntica
// no dia em que foi escrita — vira a que apodrece. Quem promove e quem MOSTRA o que será promovido têm
// de concordar por construção, não por coincidência.
//
// PURO: recebe o board já lido e o fallback global; não toca disco, git nem config.

import type { BoardConfig } from "@/lib/storymap/types";

/** Normaliza para prefixo de diretório (`packages/x` → `packages/x/`) — o formato que o pathspec espera. */
const asPrefix = (p: string): string => `${p.replace(/\/+$/, "")}/`;

/**
 * Os prefixos que a promoção deste board carrega: o pacote DELE, mais os `sharedPackages` que ele
 * legitimamente toca (acme consertando `acme-shared/`), mais as `deploy.surfaces` (caminhos
 * deployáveis fora de `packages/`, story-zr1cmf).
 *
 * Sem `package` no board.yaml, cai no `staging.codePrefixes` GLOBAL (legado) — que publica o código
 * staged de todos os boards junto; é o comportamento herdado, preservado de propósito.
 */
export function releaseCodePrefixes(
  config: Pick<BoardConfig, "package" | "sharedPackages" | "deploy"> | null | undefined,
  globalCodePrefixes: readonly string[],
): string[] {
  if (!config?.package) return [...globalCodePrefixes];
  const surfaces = (config.deploy?.surfaces ?? []).map((s) => s.prefix);
  return [config.package, ...(config.sharedPackages ?? []), ...surfaces].map(asPrefix);
}
