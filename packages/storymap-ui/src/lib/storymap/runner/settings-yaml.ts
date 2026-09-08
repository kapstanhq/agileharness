// A ESCRITA CIRÚRGICA no settings.yaml — trocar ALGUMAS chaves sem reescrever o arquivo.
//
// POR QUE EXISTE: o caminho normal de escrita (`writeRunnerSettings`) faz `yaml.dump` do objeto inteiro, e
// `js-yaml` não preserva comentários. No settings.yaml deste repo os comentários NÃO são enfeite — são a
// documentação operacional (por que o gate roda affected-only, o trade que isso implica, o que cada teto
// significa). Medido ao trocar o modelo pela primeira vez: 19 linhas inseridas, **60 apagadas**. Mexer num
// punhado de knobs por um popover não pode custar o caderno de operação do time.
//
// A resposta é editar o TEXTO, não o objeto: só as linhas dos escalares pedidos mudam; todo o resto do
// arquivo — comentários, ordem, formatação, chaves que este módulo nem conhece — atravessa byte a byte.
//
// LIMITE DECLARADO: isto NÃO é um editor de YAML. Ele cobre o formato que o arquivo tem (blocos indentados,
// chaves escalares) e, quando não encontra o caminho, ele CRIA os blocos que faltam em vez de adivinhar —
// nunca reescreve o que não entendeu. Um settings.yaml em fluxo (`orchestrator: {chat: …}`) ganharia um
// bloco novo em vez de ser mutilado, e o `coerceRunnerSettings` do lado do leitor decide o que vale.

/** Um escalar a gravar: o CAMINHO até ele (`["orchestrator","chat","model"]`) e o valor. */
export interface YamlScalarPatch {
  path: readonly string[];
  value: string | number | boolean;
}

/** Indentação de um passo (o arquivo é 2 espaços por nível, como o `yaml.dump` default). */
const STEP = "  ";

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isBlankOrComment = (line: string): boolean => !line.trim() || line.trimStart().startsWith("#");

/** Onde um bloco indentado termina: a primeira linha com CONTEÚDO cuja indentação não é maior que a do pai. */
function blockEnd(lines: string[], start: number, parentIndent: number): number {
  let i = start;
  while (i < lines.length && (isBlankOrComment(lines[i]) || indentOf(lines[i]) > parentIndent)) i++;
  return i;
}

/** A linha `key:` (mapeamento) DIRETAMENTE dentro de [start,end) no nível `indent`. -1 se não houver. */
function findKey(lines: string[], start: number, end: number, indent: number, key: string): number {
  const re = new RegExp(`^ {${indent}}${key}:`);
  for (let i = start; i < end; i++) {
    if (isBlankOrComment(lines[i])) continue;
    if (indentOf(lines[i]) === indent && re.test(lines[i])) return i;
  }
  return -1;
}

/**
 * O valor como YAML. Números e booleanos vão crus; strings vão cruas SALVO quando a forma delas mudaria o
 * sentido na volta (vazia, começando por caractere estrutural, com `: ` ou ` #` no meio, ou parecendo
 * número/booleano — uma string "true" que fosse escrita crua voltaria como boolean).
 */
function fmt(value: string | number | boolean): string {
  if (typeof value !== "string") return String(value);
  const s = value;
  const risky =
    s === "" ||
    /^[\s>|*&!%@`"'?:,{}[\]-]/.test(s) ||
    /: |\s#/.test(s) ||
    /^(true|false|yes|no|on|off|null|~)$/i.test(s) ||
    /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s);
  return risky ? JSON.stringify(s) : s;
}

/** Troca o VALOR de uma linha `chave: valor`, preservando indentação, a chave e o comentário do fim. */
function setScalar(line: string, value: string): string {
  return line.replace(/^(\s*[A-Za-z_][\w-]*:)([^#\n]*)(#.*)?$/, (_m, head: string, _old: string, tail?: string) =>
    `${head} ${value}${tail ? ` ${tail}` : ""}`,
  );
}

/** As linhas de um caminho que ainda não existe: `a:` / `  b:` / `    c: valor`. */
function blockFor(path: readonly string[], value: string, baseIndent: string): string[] {
  return path.map((key, i) => {
    const indent = baseIndent + STEP.repeat(i);
    return i === path.length - 1 ? `${indent}${key}: ${value}` : `${indent}${key}:`;
  });
}

/** Grava UM escalar, criando os blocos que faltarem. Muta `lines`. */
function setPath(lines: string[], patch: YamlScalarPatch): void {
  const value = fmt(patch.value);
  let start = 0;
  let end = lines.length;
  let indent = 0;
  for (let d = 0; d < patch.path.length; d++) {
    const key = patch.path[d];
    const at = findKey(lines, start, end, indent, key);
    const leaf = d === patch.path.length - 1;
    if (at < 0) {
      // O caminho morre aqui: cria o RESTO dele no começo do bloco pai. Inserir no TOPO (e não no fim)
      // mantém colados os comentários que precedem as chaves já existentes.
      lines.splice(start, 0, ...blockFor(patch.path.slice(d), value, " ".repeat(indent)));
      return;
    }
    if (leaf) {
      lines[at] = setScalar(lines[at], value);
      return;
    }
    // Desce: a indentação dos filhos é a DAS IRMÃS que já existem (um bloco escrito com 4 espaços receberia
    // um filho de 2 e o arquivo deixaria de parsear); sem filhos, o passo padrão.
    const childEnd = blockEnd(lines, at + 1, indent);
    const sibling = lines.slice(at + 1, childEnd).find((l) => !isBlankOrComment(l));
    start = at + 1;
    end = childEnd;
    indent = sibling ? indentOf(sibling) : indent + STEP.length;
  }
}

/**
 * Devolve o texto do settings.yaml com cada escalar de `patches` valendo o valor pedido. PURA.
 *
 * Os patches são aplicados EM ORDEM, e cada um enxerga o texto que o anterior deixou — então dois patches
 * de um mesmo bloco novo (`chat.model` e `chat.effort`) resultam em UM bloco com as duas chaves.
 */
export function patchYamlScalars(text: string, patches: readonly YamlScalarPatch[]): string {
  if (!patches.length) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  // Arquivo vazio: nasce do primeiro caminho e segue normalmente pelos demais.
  const lines = text.trim() ? text.split(/\r?\n/) : [];
  for (const p of patches) setPath(lines, p);
  const out = lines.join(eol);
  return out.endsWith(eol) ? out : `${out}${eol}`;
}
