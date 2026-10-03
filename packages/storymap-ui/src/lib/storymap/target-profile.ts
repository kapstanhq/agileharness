// O PERFIL DO ALVO — como ESTE repositório roda os próprios checks e onde ficam as regras dele. PURO.
//
// POR QUE EXISTE: as skills e a tool `run_check` diziam ao agente COMO o repositório de origem trabalha —
// «rode `just test-<pkg>`», «leia `.claude/rules/testing-philosophy.md`». Num repositório que usa outro executor, ou
// guarda as regras noutro lugar, a instrução manda rodar um comando que não existe e ler um arquivo que não há. A
// ferramenta não pode supor o ferramental de quem a adota.
//
// O QUE O ALVO DECLARA, em `storymap/settings.yaml` → `target:` (o canal do OPERADOR: versionado e sob o gate de código,
// diferente de `board.yaml`, que agentes editam — por isso um comando daqui pode ser executado):
//   • `checks` — o comando de cada verificação pelo NOME que as skills pedem (`test`, `testUnit`, `e2e`, `typecheck`,
//     `validate`, `smoke`…);
//   • `dev`    — subir e derrubar o ambiente de desenvolvimento (`up`, `down`);
//   • `docs`   — onde ficam as regras que o agente lê antes de agir (`conventions`, `testing`, `security`,
//     `devEnvironment`, `ops`…).
// Nos três, `{pkg}` é o nome do pacote do board (o último segmento de `board.yaml package`), `{package}` o caminho
// inteiro e `{board}` o id do board — o mesmo perfil serve a todos os boards do repositório.
//
// SEM PERFIL nada quebra: as skills dizem «descubra o comando nas instruções do repositório» em vez de inventar um.

/** O perfil como o alvo o declarou (moldes, ainda com `{pkg}`/`{package}`/`{board}`). */
export interface TargetProfile {
  checks: Record<string, string>;
  dev: Record<string, string>;
  docs: Record<string, string>;
}

/** O perfil de UM board: os moldes já preenchidos. Um molde que não pôde ser preenchido não entra. */
export interface ResolvedTargetProfile {
  checks: Record<string, string>;
  dev: Record<string, string>;
  docs: Record<string, string>;
}

/** Os nomes que as skills pedem — a lista é DOCUMENTAÇÃO (um alvo pode declarar outros), não uma trava. */
export const KNOWN_CHECKS = ["test", "testUnit", "e2e", "typecheck", "lint", "validate", "build", "smoke"] as const;
export const KNOWN_DEV = ["up", "down"] as const;
export const KNOWN_DOCS = ["conventions", "testing", "security", "devEnvironment", "ops"] as const;

const KEY = /^[a-z][A-Za-z0-9]{0,31}$/;
const COMMAND_MAX = 300;
/** Um caminho relativo que pode ir VERBATIM para dentro de um prompt entre aspas: sem espaço, aspas, `$`, crase. */
const SAFE_PATH = /^[A-Za-z0-9._/{}-]+$/;
const SAFE_SLUG = /^[A-Za-z0-9._-]+$/;
const SAFE_REL = /^[A-Za-z0-9._/-]+$/;

const hasControl = (s: string) => [...s].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20 || ch.codePointAt(0) === 0x7f);

function coerceMap(raw: unknown, accept: (value: string) => boolean): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEY.test(key) || typeof value !== "string") continue;
    const v = value.trim();
    if (!v || v.length > COMMAND_MAX || hasControl(v) || !accept(v)) continue;
    out[key] = v;
  }
  return out;
}

/** Um caminho de documento aceitável: relativo, sem `..`, só caracteres que atravessam um prompt entre aspas. */
function isDocPath(v: string): boolean {
  return SAFE_PATH.test(v) && !v.startsWith("/") && !v.split("/").includes("..");
}

/**
 * O bloco `target:` do settings, tolerante: chave fora da forma, valor que não é texto, comando com caractere de
 * controle ou documento com caminho absoluto / `..` / caractere que não atravessa um prompt são DESCARTADOS (os outros
 * seguem). Sem nada aproveitável devolve undefined — o alvo simplesmente não declarou perfil. PURA.
 */
export function coerceTargetProfile(raw: unknown): TargetProfile | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const profile: TargetProfile = { checks: coerceMap(r.checks, () => true), dev: coerceMap(r.dev, () => true), docs: coerceMap(r.docs, isDocPath) };
  return Object.keys(profile.checks).length || Object.keys(profile.dev).length || Object.keys(profile.docs).length ? profile : undefined;
}

/** O que um board empresta aos moldes. */
export interface TargetScope {
  /** o id do board. */
  board: string;
  /** `board.yaml package` (o caminho do pacote), quando o board mapeia código. */
  package?: string | null;
}

/**
 * Preenche um molde. Devolve null quando ele pede um valor que o board não tem (`{pkg}` num board sem `package`) ou
 * que não é seguro para virar argumento / caminho — nunca um comando pela metade. PURA.
 */
export function expandTargetTemplate(template: string, scope: TargetScope): string | null {
  const pkgPath = scope.package && SAFE_REL.test(scope.package) && !scope.package.split("/").includes("..") ? scope.package.replace(/\/+$/, "") : null;
  const values: Record<string, string | null> = {
    board: SAFE_SLUG.test(scope.board) ? scope.board : null,
    package: pkgPath,
    pkg: pkgPath ? (pkgPath.split("/").pop() ?? null) : null,
  };
  let missing = false;
  const out = template.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => {
    if (!(name in values)) return whole; // chave que não é molde fica como está (um `{}` de quem escreveu o comando)
    const v = values[name];
    if (!v) missing = true;
    return v ?? "";
  });
  return missing ? null : out;
}

/** O perfil de um board: cada molde preenchido; o que não pôde ser preenchido fica de fora. PURA. */
export function resolveTargetProfile(profile: TargetProfile | null | undefined, scope: TargetScope): ResolvedTargetProfile {
  const fill = (map: Record<string, string> | undefined, accept: (v: string) => boolean = () => true): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, template] of Object.entries(map ?? {})) {
      const v = expandTargetTemplate(template, scope);
      if (v && accept(v)) out[key] = v;
    }
    return out;
  };
  return { checks: fill(profile?.checks), dev: fill(profile?.dev), docs: fill(profile?.docs, (v) => SAFE_REL.test(v)) };
}

/**
 * O comando de um check, pronto para executar SEM shell: a lista de palavras. Null quando o check não foi declarado,
 * quando o molde não pôde ser preenchido para este board, ou quando o comando só faria sentido com um shell (pipe,
 * redireção, `&&`, `$(…)`): o operador que precisa disso declara um script do repositório. PURA.
 */
export function checkArgv(profile: TargetProfile | null | undefined, scope: TargetScope, check: string, parse: (cmd: string) => string[] | null): { argv: string[] } | { refusal: string } {
  const template = profile?.checks[check];
  if (!template) {
    const known = Object.keys(profile?.checks ?? {});
    return {
      refusal: known.length
        ? `o alvo não declara o check "${check}" — os declarados são: ${known.join(", ")} (storymap/settings.yaml → target.checks).`
        : `o alvo não declara nenhum check (storymap/settings.yaml → target.checks). Declare o comando lá, ou rode-o você mesmo pelo terminal do repositório.`,
    };
  }
  const cmd = expandTargetTemplate(template, scope);
  if (!cmd) return { refusal: `o check "${check}" usa {pkg}/{package}, e o board "${scope.board}" não mapeia um pacote (board.yaml → package).` };
  const argv = parse(cmd);
  if (!argv?.length) return { refusal: `o check "${check}" não é uma lista de palavras (tem sintaxe de shell: pipe, redireção, &&, $(…)). Declare um script do repositório e chame-o.` };
  return { argv };
}

const DOC_WORDS: Record<string, string> = {
  conventions: "convenções",
  testing: "testes",
  security: "segurança",
  devEnvironment: "ambiente de desenvolvimento",
  ops: "operação",
};

/**
 * A nota do perfil para o prompt de um agente — SEGURA para ir entre aspas num comando: só caminhos de documento (já
 * peneirados) e NOMES de check; o texto de um comando nunca é interpolado (ele tem aspas e `$`). Null sem perfil. PURA.
 */
export function targetProfileNote(resolved: ResolvedTargetProfile): string | null {
  const docs = Object.entries(resolved.docs).map(([k, p]) => `${DOC_WORDS[k] ?? k}: ${p}`);
  const checks = Object.keys(resolved.checks);
  const dev = Object.keys(resolved.dev);
  if (!docs.length && !checks.length && !dev.length) return null;
  const parts: string[] = [];
  if (docs.length) parts.push(`leia antes de agir os documentos do alvo — ${docs.join("; ")}`);
  if (checks.length || dev.length) {
    parts.push(
      `os comandos deste repositório estão em storymap/settings.yaml, bloco target` +
        `${checks.length ? ` (checks: ${checks.join(", ")})` : ""}${dev.length ? ` (dev: ${dev.join(", ")})` : ""} — use-os em vez de supor um executor`,
    );
  }
  return `Perfil do alvo: ${parts.join(". ")}.`;
}
