// gate-scope — QUAL suíte o gate roda, derivada do delta, nunca de um caminho fixo no código.
//
// O gate nasceu monolítico: `path.join(stagingPath, "packages", "storymap-ui")`, literal, em três
// lugares. Consequências, nesta ordem de gravidade:
//   1. CORRETUDE — uma sessão que mexe em `packages/acmeapp` é validada pela suíte do storymap-ui.
//      Testes errados produzem confiança falsa, que é pior que nenhuma validação (esta grita).
//   2. AGNOSTICISMO (D13) — um harness que só sabe testar o próprio pacote não é genérico, e isso é
//      bloqueador direto da extração OSS.
//
// A regra aqui é DECLARATIVA e conservadora por desenho: só um pacote EXPLICITAMENTE configurado ganha
// unidade própria; qualquer coisa fora do mapa cai no `fallback`, que é exatamente o comportamento de
// hoje. Assim a troca hardcode→config é byte-equivalente enquanto ninguém declarar nada, e cada pacote
// novo entra por UMA entrada em `settings.yaml` — o contrato modular do pacote ("adicione 1 entrada
// declarativa, não N"), em vez de um `if` a mais no runner.
//
// PURO. Sem fs, sem git, sem exec: a decisão é uma função dos caminhos mudados.

/** Config carregada de `autorun.mergeGate.scope` (ausente ⇒ tudo cai no fallback = comportamento atual). */
export interface GateScopeSpec {
  /**
   * Mapa `<dir repo-relativo do pacote>` → comando de checagem. A chave é casada por PREFIXO, então
   * `packages/acmeapp` cobre `packages/acmeapp/src/**`. Um pacote FORA deste mapa nunca ganha unidade
   * própria — cai no fallback —, que é o que torna a migração incremental e sem regressão.
   */
  packages?: Record<string, string>;
  /**
   * Teto de unidades por entrada. Uma entrada que toca 6 pacotes rodaria 6 suítes em série dentro do
   * MESMO slot serial do train — o pior lugar possível para uma multiplicação. Estourou o teto ⇒ cai no
   * fallback (uma suíte só, a de hoje), com o motivo NOMEADO. Conservador na direção certa: perder
   * granularidade custa precisão; perder o slot custa a fila inteira.
   */
  maxUnits?: number;
    /**
     * A unidade que roda quando o delta NÃO casa nenhum pacote do mapa, ou transborda dele (regra 3 e o
     * teto). Ausente ⇒ o chamador mantém o default histórico, que é o pacote da própria ferramenta.
     *
     * POR QUE ELA EXISTE. Esse default só era verdade enquanto a ferramenta morava DENTRO do repositório
     * que ela opera. Desde a inversão o `cwd` do fallback é um caminho no repositório do USUÁRIO que pode
     * não existir — e aí o gate RECUSA toda entrada com código, fail-closed, congelando a fila. Declarar o
     * fallback é como um alvo diz «a suíte que cobre o que meu mapa não conhece roda AQUI».
     *
     * `command` ausente ⇒ o `checkCommand` global do `mergeGate`.
     */
    fallback?: { cwd: string; command?: string };
}

/** Uma suíte a rodar: onde e o quê. */
export interface GateUnit {
  /** dir repo-relativo onde o comando roda (o chamador prefixa a árvore de staging) */
  cwd: string;
  /** o comando (`vitest run`, `bun test`, …) */
  command: string;
  /** rótulo curto para o log do gate — é o que o operador lê quando reprova */
  label: string;
}

export interface GateScopeDecision {
  units: GateUnit[];
  /** POR QUE estas unidades — vai para o log do gate (uma reprovação sem escopo legível é meio recado) */
  reason: string;
}

const DEFAULT_MAX_UNITS = 3;

/** `a/b/` e `a/b` casam o mesmo prefixo; normaliza para comparar sem depender de como foi escrito. */
function underPrefix(file: string, prefix: string): boolean {
  const p = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return file === prefix.replace(/\/$/, "") || file.startsWith(p);
}

/**
 * Decide QUAIS suítes este delta exige.
 *
 * Regras, nesta ordem:
 *   1. Nenhum arquivo / nenhum pacote configurado tocado ⇒ o `fallback` (comportamento de hoje).
 *   2. Um ou mais pacotes configurados tocados ⇒ uma unidade por pacote, na ordem em que aparecem no
 *      MAPA (determinístico — não na ordem do diff, que varia).
 *   3. Um arquivo tocado FORA de todo pacote configurado, junto com pacotes configurados ⇒ o fallback
 *      ENTRA TAMBÉM. Isso é deliberado e é o coração do fail-safe: um arquivo que o mapa não conhece
 *      (a raiz, `scripts/`, `tools/`) pode quebrar qualquer coisa, e a única suíte que sabemos capaz de
 *      pegá-lo é a de sempre. Escopo que ACOMPANHA o delta, nunca escopo que o ENFRAQUECE (D15).
 *   4. Passou de `maxUnits` ⇒ colapsa no fallback, dizendo por quê.
 *
 * PURA.
 */
export function resolveGateUnits(
  changedFiles: readonly string[],
  fallback: GateUnit,
  spec: GateScopeSpec | undefined,
): GateScopeDecision {
  const map = spec?.packages ?? {};
  const configured = Object.keys(map);
  const files = changedFiles.map((f) => f.trim()).filter(Boolean);
  if (files.length === 0 || configured.length === 0) {
    return { units: [fallback], reason: configured.length === 0 ? "escopo não configurado — suíte padrão" : "delta vazio — suíte padrão" };
  }

  const touched = configured.filter((pkg) => files.some((f) => underPrefix(f, pkg)));
  if (touched.length === 0) {
    return { units: [fallback], reason: `nenhum pacote configurado no delta — suíte padrão (${fallback.label})` };
  }

  const unmapped = files.filter((f) => !configured.some((pkg) => underPrefix(f, pkg)));
  const units: GateUnit[] = touched.map((pkg) => ({ cwd: pkg, command: map[pkg], label: pkg }));
  if (unmapped.length > 0 && !units.some((u) => u.cwd === fallback.cwd)) {
    units.push(fallback); // regra 3 — o desconhecido puxa a suíte que cobre tudo
  }

  const maxUnits = spec?.maxUnits ?? DEFAULT_MAX_UNITS;
  if (units.length > maxUnits) {
    return {
      units: [fallback],
      reason: `${units.length} pacote(s) no delta acima do teto de ${maxUnits} — colapsado na suíte padrão (${fallback.label})`,
    };
  }
  const extra = unmapped.length > 0 ? ` + ${unmapped.length} arquivo(s) fora do mapa` : "";
  return { units, reason: `${touched.join(", ")}${extra}` };
}
