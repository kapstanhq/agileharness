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
// ── A UNIDADE DEIXOU DE SER UMA STRING (gate honesto, v0.6.x) ─────────────────────────────────────────
// Medido no alvo de referência (auditoria v0.5.x): o mapa era `<dir> → <comando>` e o `affected.command`
// GLOBAL (`bunx vitest run --changed {base} --passWithNoTests`) SUBSTITUÍA o comando de TODA unidade. Três
// consequências, todas verdes-sem-olhar:
//   · uma unidade que não é vitest (pytest) nunca rodava — rodava vitest no diretório dela;
//   · as flags da unidade (`--config vitest.unit.config.ts`) sumiam — rodava a config errada;
//   · o delta de produto caía no fallback (um SDK compartilhado) e ZERO testes do produto rodavam; as
//     entradas integravam em ~20–50 s, que é o tempo de medir nada.
// Agora a unidade DECLARA como é medida (`reporter`), se aceita seleção por afetados (`affected` — só
// `vitest-json`, e o sufixo é ANEXADO ao comando dela, nunca a substitui), onde grava o relatório
// (`junitPath`), se pode usar rede (`network`) e o que mais a dispara (`triggers`). A string continua
// aceita: é a unidade legada, `vitest-json` com o comando dado.
//
// PURO. Sem fs, sem git, sem exec: a decisão é uma função dos caminhos mudados.

import { matchesGatePattern } from "./affected-gate";

/** Como a unidade é MEDIDA — de onde o gate tira "quais testes falharam" e "quantos rodaram". */
export type GateReporter = "vitest-json" | "junit-xml" | "exit-code";
export const GATE_REPORTERS: readonly GateReporter[] = ["vitest-json", "junit-xml", "exit-code"] as const;

/** Rede de uma unidade selada: `deny` (default) = só loopback PRIVADO; `allow` = a rede do host. */
export type GateNetwork = "deny" | "allow";

/**
 * A forma DECLARADA de uma unidade (settings.yaml). A string solta é açúcar para
 * `{ command, reporter: "vitest-json" }` — o contrato de antes, byte a byte.
 */
export interface GateUnitSpec {
  /** o comando que roda a suíte da unidade (`bunx vitest run --config vitest.unit.config.ts`, `pytest -q`, …) */
  command: string;
  /** default `vitest-json` (o gate anexa `--reporter=json`); `junit-xml` lê `junitPath`; `exit-code` só o status */
  reporter?: GateReporter;
  /**
   * Aceita seleção por afetados? Default `true` SÓ para `vitest-json` — e mesmo então só vale com
   * `mergeGate.affected.enabled`. Outros reporters rodam SEMPRE completos: não há como o gate derivar
   * "o que o delta afeta" num comando que ele não entende, e selecionar zero seria verde sem olhar.
   */
  affected?: boolean;
  /** `junit-xml`: onde o comando grava o relatório, RELATIVO ao `cwd` da unidade (ex.: `.gate/junit.xml`). */
  junitPath?: string;
  /** isolamento selado: `deny` (default) tira a rede da unidade; `allow` a devolve. */
  network?: GateNetwork;
  /** onde o comando roda, repo-relativo. Default: a própria chave. `.` = a raiz da árvore do gate. */
  cwd?: string;
  /**
   * Globs (mesma gramática de `fullSuitePaths`: `dir/`, `*`, `**`) que TAMBÉM disparam a unidade. É como um
   * lint de arquitetura roda quando qualquer `packages/*\/web/**` muda sem ser dono desses caminhos. Um
   * arquivo casado só por gatilho NÃO conta como "mapeado": ele continua puxando o fallback (regra 3).
   */
  triggers?: string[];
}

/** Config carregada de `autorun.mergeGate.scope` (ausente ⇒ tudo cai no fallback = comportamento atual). */
export interface GateScopeSpec {
  /**
   * Mapa `<dir repo-relativo do pacote>` → unidade (string legada OU {@link GateUnitSpec}). A chave é casada
   * por PREFIXO, então `packages/acmeapp` cobre `packages/acmeapp/src/**`. Um pacote FORA deste mapa nunca
   * ganha unidade própria — cai no fallback —, que é o que torna a migração incremental e sem regressão.
   */
  packages?: Record<string, string | GateUnitSpec>;
  /**
   * Unidades EXTRAS com a mesma forma, para prefixos que não são pacote (`tests/architecture`, `infra/`).
   * Existem num mapa próprio por legibilidade — o casamento é idêntico ao de `packages` e as duas listas
   * são percorridas nessa ordem (pacotes primeiro), o que mantém a ordem das unidades determinística.
   */
  units?: Record<string, string | GateUnitSpec>;
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
   * `command` ausente ⇒ o `checkCommand` global do `mergeGate`. Os demais campos de {@link GateUnitSpec}
   * (reporter, affected, junitPath, network) valem aqui também.
   */
  fallback?: { cwd: string; command?: string } & Omit<Partial<GateUnitSpec>, "command" | "cwd" | "triggers">;
}

/** Uma suíte a rodar: onde, o quê e como medir. */
export interface GateUnit {
  /** dir repo-relativo onde o comando roda (o chamador prefixa a árvore de staging) */
  cwd: string;
  /** o comando (`vitest run`, `bun test`, …) */
  command: string;
  /** rótulo curto para o log do gate — é o que o operador lê quando reprova */
  label: string;
  /** ausente ⇒ `vitest-json` (o contrato legado) */
  reporter?: GateReporter;
  /** ausente ⇒ `reporter === "vitest-json"` */
  affected?: boolean;
  junitPath?: string;
  /** ausente ⇒ `deny` */
  network?: GateNetwork;
}

export interface GateScopeDecision {
  units: GateUnit[];
  /** POR QUE estas unidades — vai para o log do gate (uma reprovação sem escopo legível é meio recado) */
  reason: string;
}

const DEFAULT_MAX_UNITS = 3;

/** O reporter EFETIVO de uma unidade (ausente ⇒ o legado). PURA. */
export function unitReporter(u: Pick<GateUnit, "reporter">): GateReporter {
  return u.reporter ?? "vitest-json";
}

/** A unidade aceita seleção por afetados? Só `vitest-json`, e só se não recusou. PURA. */
export function unitAcceptsAffected(u: Pick<GateUnit, "reporter" | "affected">): boolean {
  return unitReporter(u) === "vitest-json" && u.affected !== false;
}

/** `a/b/` e `a/b` casam o mesmo prefixo; normaliza para comparar sem depender de como foi escrito. */
function underPrefix(file: string, prefix: string): boolean {
  const p = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return file === prefix.replace(/\/$/, "") || file.startsWith(p);
}

/** Uma entrada do mapa (string legada ou objeto) → a spec normalizada. `null` = entrada sem comando. PURA. */
export function normalizeUnitSpec(v: string | GateUnitSpec | undefined | null): GateUnitSpec | null {
  if (typeof v === "string") return v.trim() ? { command: v.trim() } : null;
  if (!v || typeof v !== "object" || typeof v.command !== "string" || !v.command.trim()) return null;
  return v;
}

/** A spec declarada → a unidade executável, com a chave como rótulo (e cwd default). PURA. */
function toUnit(key: string, s: GateUnitSpec): GateUnit {
  return {
    cwd: s.cwd ?? key,
    command: s.command,
    label: key,
    ...(s.reporter ? { reporter: s.reporter } : {}),
    ...(s.affected !== undefined ? { affected: s.affected } : {}),
    ...(s.junitPath ? { junitPath: s.junitPath } : {}),
    ...(s.network ? { network: s.network } : {}),
  };
}

/**
 * Decide QUAIS suítes este delta exige.
 *
 * Regras, nesta ordem:
 *   1. Nenhum arquivo / nenhuma unidade configurada ⇒ o `fallback` (comportamento de hoje).
 *   2. Uma ou mais unidades tocadas — por PREFIXO da chave ou por um GATILHO declarado — ⇒ uma unidade
 *      por chave, na ordem do MAPA (`packages` e depois `units`; determinístico — não na ordem do diff).
 *   3. Um arquivo tocado FORA de todo prefixo configurado, junto com unidades ⇒ o fallback ENTRA TAMBÉM.
 *      Deliberado, e é o coração do fail-safe: um arquivo que o mapa não conhece (a raiz, `scripts/`,
 *      `tools/`) pode quebrar qualquer coisa, e a única suíte que sabemos capaz de pegá-lo é a de sempre.
 *      Casar um GATILHO não torna o arquivo "mapeado" — o lint que ele dispara não é a suíte que o cobre.
 *      Escopo que ACOMPANHA o delta, nunca escopo que o ENFRAQUECE (D15).
 *   4. Passou de `maxUnits` ⇒ colapsa no fallback, dizendo por quê.
 *
 * PURA.
 */
export function resolveGateUnits(
  changedFiles: readonly string[],
  fallback: GateUnit,
  spec: GateScopeSpec | undefined,
): GateScopeDecision {
  // `packages` primeiro, `units` depois; uma chave repetida vale a PRIMEIRA declaração (a do mapa de pacotes).
  const declared: Array<{ key: string; spec: GateUnitSpec }> = [];
  for (const map of [spec?.packages ?? {}, spec?.units ?? {}]) {
    for (const [key, raw] of Object.entries(map)) {
      const s = normalizeUnitSpec(raw);
      if (s && !declared.some((d) => d.key === key)) declared.push({ key, spec: s });
    }
  }
  const files = changedFiles.map((f) => f.trim()).filter(Boolean);
  if (files.length === 0 || declared.length === 0) {
    return { units: [fallback], reason: declared.length === 0 ? "escopo não configurado — suíte padrão" : "delta vazio — suíte padrão" };
  }

  const byPrefix = (key: string) => files.some((f) => underPrefix(f, key));
  const triggerHit = (s: GateUnitSpec): string | null => {
    for (const g of s.triggers ?? []) if (files.some((f) => matchesGatePattern(f, g))) return g;
    return null;
  };
  const touched: Array<{ key: string; spec: GateUnitSpec; via: string | null }> = [];
  for (const d of declared) {
    if (byPrefix(d.key)) touched.push({ ...d, via: null });
    else {
      const g = triggerHit(d.spec);
      if (g) touched.push({ ...d, via: g });
    }
  }
  if (touched.length === 0) {
    return { units: [fallback], reason: `nenhuma unidade configurada no delta — suíte padrão (${fallback.label})` };
  }

  const unmapped = files.filter((f) => !declared.some((d) => underPrefix(f, d.key)));
  const units: GateUnit[] = touched.map((t) => toUnit(t.key, t.spec));
  if (unmapped.length > 0 && !units.some((u) => u.cwd === fallback.cwd)) {
    units.push(fallback); // regra 3 — o desconhecido puxa a suíte que cobre tudo
  }

  const maxUnits = spec?.maxUnits ?? DEFAULT_MAX_UNITS;
  if (units.length > maxUnits) {
    return {
      units: [fallback],
      reason: `${units.length} unidade(s) no delta acima do teto de ${maxUnits} — colapsado na suíte padrão (${fallback.label})`,
    };
  }
  const names = touched.map((t) => (t.via ? `${t.key} (gatilho ${t.via})` : t.key));
  const extra = unmapped.length > 0 ? ` + ${unmapped.length} arquivo(s) fora do mapa` : "";
  return { units, reason: `${names.join(", ")}${extra}` };
}
