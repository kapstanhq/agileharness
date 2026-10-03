// O PEDIDO DE PERMISSÃO NO TERMINAL DE UMA SESSÃO DA FROTA — reconhecer, julgar e destravar. PURO (sem IO).
//
// O PROBLEMA (num caso real): um condutor ficou horas parado em «Bash command · from the code-reviewer
// agent … Dangerous rm operation on possibly-empty variable path … Do you want to proceed? ❯ 1. Yes 2. No». O Claude Code
// abre esse aviso MESMO em bypassPermissions (é uma trava dele para `rm -r` com caminho montado por variável), um
// subagente revisor o disparou, e numa sessão da frota não há ninguém para responder: a vaga do board, o card e o
// subagente ficaram presos por horas. O vigia de terminais via o prompt (`asking`), o Inbox/alerta o mostrava, e nada AGIA:
// a escada do condutor (conductor-pause.ts) trata `asking` como «assunto do humano» e sai.
//
// Só que há dois tipos de prompt, e só um é do humano:
//   • uma PERGUNTA do agente ao dono (AskUserQuestion, texto livre) — decisão de negócio, fica como está;
//   • um PEDIDO DE PERMISSÃO de ferramenta — mecanismo, não decisão. Ninguém do negócio sabe responder «posso rodar este
//     rm?», e esperar por isso não tem prazo. É do SISTEMA, e o sistema tem a mesma régua que o dono já deu: isolamento em
//     vez de proibição (o agente age livre dentro do próprio worktree e do próprio scratch; a trava dura cuida do resto).
//
// A REGRA (o que este módulo decide, sobre o COMANDO EXATO que o transcript guarda — a tela quebra linha no meio de
// palavra e não serve para julgar caminho):
//   1. APROVA o falso positivo PROVADO: o aviso é o de «variável possivelmente vazia» num `rm -r` cujas variáveis o
//      próprio comando atribui a valores literais, e TODO caminho que ele expande cai dentro do worktree da sessão ou do
//      scratch dela, sem token de alto risco (git push, gcloud, sudo, pipe para shell…);
//   2. RECUSA («No») o que o isolamento não prova: caminho fora das raízes, variável sem valor literal, token de risco;
//   3. o que não dá para julgar (outra ferramenta, outro aviso, comando que não bate com a tela) espera um PRAZO e, vencido
//      ele, é recusado — recusar é sempre seguro (a chamada não acontece, o agente replaneja), esperar para sempre não.
// Garantia final: nenhuma sessão da frota fica mais que {@link PROMPT_TIMEOUT_MS} num pedido de permissão.

/** Quanto o prompt precisa estar na tela antes de o sistema agir — dá tempo de um humano que está olhando responder. */
export const PROMPT_GRACE_MS = 2 * 60_000;
/** O prazo máximo de um pedido de permissão que o sistema não consegue julgar: vencido, é recusado. */
export const PROMPT_TIMEOUT_MS = 10 * 60_000;
/** Quantas vezes por sessão o sistema responde a pedidos antes de deixar para o humano (laço de pedido-recusa-pedido). */
export const PROMPT_MAX_ANSWERS = 6;

export interface PromptOption {
  /** a tecla que escolhe a opção (o número). */
  key: string;
  label: string;
}

/** O pedido de permissão lido da tela. */
export interface ToolPrompt {
  /** a primeira linha da moldura, ex.: «Bash command · from the code-reviewer agent». */
  header: string;
  /** a ferramenta, quando a moldura a nomeia (`Bash`), senão null. */
  tool: string | null;
  /** o aviso do próprio Claude Code dentro da moldura (ex.: «Dangerous rm operation on possibly-empty variable path…»). */
  warning: string | null;
  options: PromptOption[];
}

const TOOL_HEADER = /^\s*(Bash command|Edit file|Write file|Create file|Read file|Update file|Fetch|Web ?Fetch|MCP tool|Run shell command)\b/i;
const QUESTION = /^\s*Do you want to .+\?\s*$/i;
const OPTION = /^\s*[❯>]?\s*(\d+)\.\s+(.+?)\s*$/;

/**
 * Reconhece, na tela do pane, um pedido de permissão de FERRAMENTA do Claude Code — o desenho «moldura com a ferramenta,
 * `Do you want to …?`, opções numeradas com Yes/No». Qualquer outra coisa (uma pergunta do agente, um menu de escolha)
 * devolve null: é do humano. PURA.
 */
export function parseToolPrompt(screen: string): ToolPrompt | null {
  const lines = screen.split("\n").slice(-70);
  let q = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (QUESTION.test(lines[i]!)) {
      q = i;
      break;
    }
  }
  if (q < 0) return null;
  const options: PromptOption[] = [];
  for (let i = q + 1; i < lines.length && options.length < 6; i++) {
    const m = OPTION.exec(lines[i]!);
    if (m) options.push({ key: m[1]!, label: m[2]! });
    else if (options.length && !lines[i]!.trim()) break;
  }
  if (options.length < 2 || !options.some((o) => /^yes\b/i.test(o.label)) || !options.some((o) => /^no\b/i.test(o.label))) return null;
  let header: string | null = null;
  const box: string[] = [];
  // sobe até o separador da moldura (`────`); vale o cabeçalho MAIS ALTO dela («Bash command · from …», não o «Run shell command» de baixo)
  for (let i = q - 1; i >= Math.max(0, q - 40); i--) {
    const line = lines[i]!;
    if (/^\s*─{6,}/.test(line)) break;
    if (TOOL_HEADER.test(line)) header = line.trim();
    const m = /^\s*│\s?(.*)$/.exec(line);
    if (m) box.unshift(m[1]!);
  }
  if (!header) return null;
  const warn = box.join(" ").match(/((?:Dangerous|Warning)\b.*)$/i);
  return {
    header,
    tool: /^Bash command|^Run shell command/i.test(header) ? "Bash" : null,
    warning: warn ? warn[1]!.replace(/\s+/g, " ").trim() : null,
    options,
  };
}

/** A tecla do «sim» simples (não o «sim, e não pergunte mais»). null = a tela não tem. */
export function yesKey(p: ToolPrompt): string | null {
  const plain = p.options.find((o) => /^yes\b/i.test(o.label) && !/(don't ask|do not ask|always|allow all|for this session|never)/i.test(o.label));
  return plain?.key ?? null;
}
/** A tecla do «não». */
export function noKey(p: ToolPrompt): string | null {
  return p.options.find((o) => /^no\b/i.test(o.label))?.key ?? null;
}

/** Uma chamada de ferramenta ainda SEM resultado no transcript — o pedido que está esperando a resposta. */
export interface PendingToolUse {
  name: string;
  input: Record<string, unknown>;
}

/**
 * A última chamada de ferramenta sem `tool_result` num trecho de transcript JSONL (o fim dele). PURA. O transcript guarda
 * o comando EXATO — a tela quebra linha no meio de palavra e não serve para julgar caminho.
 */
export function lastPendingToolUse(jsonl: string): PendingToolUse | null {
  const uses = new Map<string, PendingToolUse>();
  const order: string[] = [];
  const done = new Set<string>();
  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let rec: { message?: { content?: unknown } };
    try {
      rec = JSON.parse(raw) as { message?: { content?: unknown } };
    } catch {
      continue; // a primeira linha do trecho pode vir cortada
    }
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        uses.set(b.id, { name: b.name, input: (b.input as Record<string, unknown>) ?? {} });
        order.push(b.id);
      } else if (b.type === "tool_result" && typeof b.tool_use_id === "string") done.add(b.tool_use_id);
    }
  }
  for (let i = order.length - 1; i >= 0; i--) if (!done.has(order[i]!)) return uses.get(order[i]!) ?? null;
  return null;
}

export type PromptVerdict =
  | { action: "approve"; why: string }
  | { action: "reject"; why: string }
  /** não dá para julgar: espera o prazo e é recusado. */
  | { action: "unjudged"; why: string };

/** O isolamento da sessão: onde ela pode apagar/escrever sem pedir licença. */
export interface PromptRoots {
  /** o worktree da sessão. */
  worktree: string;
  /** o scratch dela (a pasta temporária do Claude Code para este worktree). */
  scratch: string;
}

// Tokens que nunca passam pelo «aprova» — o aviso de rm não é licença para o resto do comando.
const HIGH_RISK =
  /\b(sudo|systemctl|gcloud|gsutil|firebase|kubectl|docker|podman|mkfs|fdisk|shutdown|reboot|pkill|killall|crontab|iptables|ufw|ssh|scp)\b|\bgit\s+(push|remote|config)\b|\|\s*(?:ba|z)?sh\b|--no-preserve-root|\bchmod\s+-R\b|\bchown\s+-R\b/;

const SAFE_SYSTEM_PATH = /^\/(dev\/null|dev\/stderr|dev\/stdout|usr\/(bin|local\/bin)\/[\w.-]+|bin\/[\w.-]+)$/;

const insideRoot = (p: string, root: string): boolean => p === root || p.startsWith(`${root.replace(/\/+$/, "")}/`);

/** Expande `$VAR`/`${VAR}`/`${VAR:?}` de um argumento pelos valores literais conhecidos. null = variável sem valor literal. */
function expand(arg: string, env: ReadonlyMap<string, readonly string[]>): string[] | null {
  let results = [arg.replace(/^["']|["']$/g, "")];
  const re = /\$\{([A-Za-z_]\w*)(?::\?[^}]*)?\}|\$([A-Za-z_]\w*)/;
  for (let guard = 0; guard < 10; guard++) {
    const next: string[] = [];
    let any = false;
    for (const s of results) {
      const m = re.exec(s);
      if (!m) {
        next.push(s);
        continue;
      }
      any = true;
      const vals = env.get((m[1] ?? m[2])!);
      if (!vals || !vals.length) return null;
      for (const v of vals) next.push(s.slice(0, m.index) + v + s.slice(m.index + m[0].length));
      if (next.length > 64) return null;
    }
    results = next;
    if (!any) break;
  }
  return /[$`]/.test(results.join(" ")) ? null : results;
}

/** Os valores literais que o PRÓPRIO comando atribui: `NAME=valor` e `for NAME in a b c;`. */
function literalEnv(command: string): Map<string, string[]> {
  const env = new Map<string, string[]>();
  const sub = (v: string): string | null => {
    const e = expand(v, env);
    return e && e.length === 1 ? e[0]! : null;
  };
  // percorre na ordem do texto: atribuições e laços
  const re = /(?:^|[\s;&|(])([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|)]*)|\bfor\s+([A-Za-z_]\w*)\s+in\s+([^;\n]+?)\s*;\s*do\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) {
    if (m[1]) {
      const raw = m[2]!.replace(/^["']|["']$/g, "");
      const v = /[`]|\$\(/.test(raw) ? null : sub(raw);
      if (v !== null) env.set(m[1], [v]);
    } else if (m[3]) {
      const words = m[4]!.split(/\s+/).filter(Boolean);
      if (words.length && !words.some((w) => /[`$*?]/.test(w))) env.set(m[3], words);
    }
  }
  return env;
}

/** Os argumentos de caminho de cada `rm` RECURSIVO do comando. */
function recursiveRmPaths(command: string): string[] {
  const out: string[] = [];
  for (const seg of command.split(/\s*(?:&&|\|\||;|\||\n)\s*/)) {
    const toks = seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    let i = toks.findIndex((t) => t === "rm" || t.endsWith("/rm"));
    if (i < 0) continue;
    const flags: string[] = [];
    const paths: string[] = [];
    for (i += 1; i < toks.length; i++) (toks[i]!.startsWith("-") && !paths.length ? flags : paths).push(toks[i]!);
    if (flags.some((f) => f === "--recursive" || /^-[a-zA-Z]*[rR]/.test(f))) out.push(...paths);
  }
  return out;
}

/**
 * O veredito sobre um pedido de permissão. PURA. `pending` é o comando EXATO do transcript (null = não achei);
 * `ageMs` é há quanto tempo o prompt está na tela.
 */
export function judgeToolPrompt(
  prompt: ToolPrompt,
  pending: PendingToolUse | null,
  roots: PromptRoots,
  ageMs: number,
): PromptVerdict {
  const expired = ageMs >= PROMPT_TIMEOUT_MS;
  const unjudged = (why: string): PromptVerdict =>
    expired ? { action: "reject", why: `${why}; o pedido passou de ${Math.round(PROMPT_TIMEOUT_MS / 60_000)} min sem ninguém que o responda — recusado para a sessão seguir (a chamada não acontece e o agente replaneja)` } : { action: "unjudged", why };

  if (prompt.tool !== "Bash") return unjudged(`pedido de permissão de outra ferramenta («${prompt.header.slice(0, 60)}»)`);
  if (!pending || pending.name !== "Bash" || typeof pending.input.command !== "string") return unjudged("não achei no transcript o comando que espera a resposta");
  const command = pending.input.command;
  if (HIGH_RISK.test(command)) return { action: "reject", why: "o comando tem token de alto risco (git push, gcloud, sudo, pipe para shell…) — isso não passa por aprovação automática" };
  if (!prompt.warning || !/possibly-empty variable path/i.test(prompt.warning)) return unjudged(`aviso que o sistema não sabe julgar («${(prompt.warning ?? "sem aviso").slice(0, 80)}»)`);

  const env = literalEnv(command);
  const allowed = [roots.worktree, roots.scratch];
  const outside: string[] = [];
  for (const arg of recursiveRmPaths(command)) {
    const expanded = expand(arg, env);
    if (!expanded) return { action: "reject", why: `o rm recursivo usa uma variável que o comando não define com valor literal («${arg.slice(0, 60)}») — se estiver vazia, apaga o lugar errado` };
    for (const p of expanded) {
      if (!p.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(p) || !allowed.some((r) => insideRoot(p, r)) || allowed.some((r) => p === r || p === `${r}/`)) outside.push(p);
    }
  }
  if (outside.length) return { action: "reject", why: `o rm recursivo alcança fora do worktree e do scratch da sessão (${outside.slice(0, 2).join(", ")})` };
  // todo caminho absoluto literal do comando também precisa estar dentro do isolamento (ou ser um binário/dispositivo comum)
  for (const m of command.matchAll(/(?<![\w$.-])(\/[^\s"'`;|&<>()$]*)/g)) {
    const p = m[1]!;
    if (SAFE_SYSTEM_PATH.test(p) || allowed.some((r) => insideRoot(p, r))) continue;
    return { action: "reject", why: `o comando cita um caminho fora do isolamento da sessão (${p.slice(0, 80)})` };
  }
  return { action: "approve", why: "falso positivo do aviso de variável vazia: as variáveis do rm têm valor literal no próprio comando e todo caminho cai dentro do worktree/scratch da sessão" };
}
