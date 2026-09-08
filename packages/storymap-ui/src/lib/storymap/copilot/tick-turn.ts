// O turno do TICK dentro da sessão compartilhada do board — como reconhecê-lo e como contá-lo ao operador.
//
// Desde o WS2A o tick RETOMA a mesma sessão durável que o chat lê (`--resume`), e ele acorda com um prompt que é
// uma SLASH COMMAND: `/storymap-orchestrator <board> <mode> --tick [--motivo "…"]`. O CLI grava esse prompt no
// transcript como um turno `user` — e, quando é slash command, ele o EXPANDE numa casca XML:
//
//   <command-message>storymap-orchestrator</command-message>
//   <command-name>/storymap-orchestrator</command-name>
//   <command-args>acme autonomous --tick --motivo "Aprovar design em …"</command-args>
//
// O `parseTranscriptTurns` lia isso como "o humano falou" e o chat imprimia a casca CRUA numa bolha à direita,
// como se o operador tivesse digitado XML. Não era: o operador nunca digitou nada — o Jido acordou sozinho.
// (Medido no board acme: 9 dessas bolhas na sessão viva, uma por tick, e crescendo.)
//
// Aqui mora o reconhecimento (PURO/testado) e a frase que o substitui. O parse é do PROMPT do transcript, não do
// que `buildOrchestratorPrompt` monta: quem escreve o transcript é o CLI, e ele pode entregar a forma expandida
// (slash command) OU a forma crua. As duas são aceitas — o transcript é um formato externo, não nosso.

/** Um "acordar" do tick reconhecido no transcript. `reason` = o --motivo (ausente ⇒ tick periódico comum). */
export interface TickWake {
  board: string;
  mode: string;
  reason?: string;
}

/** Uma slash command invocada nesta sessão, como o CLI a gravou. `name` vem SEM a barra. */
export interface CommandInvocation {
  name: string;
  args: string;
}

const ORCH_COMMAND = "storymap-orchestrator";
/** `<command-args>…</command-args>` da expansão de slash command do CLI. */
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const COMMAND_NAME_RE = /<command-name>\s*([^<\s]+)\s*<\/command-name>/;

/**
 * O nome do comando SEM a barra. O CLI grava `<command-name>` das duas formas — a medição em
 * ~/.claude/projects mostra 60 `/storymap-orchestrator` COM barra, mas também um
 * `<command-name>code-review</command-name>` SEM. Comparar a string crua faria o reconhecimento depender de
 * um detalhe de formatação de um formato EXTERNO (o transcript é do CLI, não nosso) — e o preço de errar é o
 * vazamento voltar calado. Normalizar é 1 linha; descobrir de novo custa uma investigação.
 */
const bareName = (s: string) => s.replace(/^\//, "");
/** `--motivo "…"` (o único arg citado que buildOrchestratorPrompt emite). */
const MOTIVO_RE = /--motivo\s+"([^"]*)"/;

/**
 * Reconhece o prompt com que o TICK acorda, nas duas formas que o transcript pode carregar: a EXPANDIDA (casca
 * `<command-name>/<command-args>` que o CLI grava para uma slash command) e a CRUA (`/storymap-orchestrator …`).
 * Devolve null para qualquer outro prompt — isto é, para tudo que o operador de fato digitou.
 *
 * Só reconhece com o marcador `--tick` presente: é ele que separa "o relógio me acordou" de um
 * `/storymap-orchestrator` que o OPERADOR tenha digitado no chat (esse é fala dele, e continua sendo bolha dele).
 */
export function parseTickWake(raw: string): TickWake | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;

  // (a) forma EXPANDIDA — a casca XML do CLI. O nome tem de ser o nosso comando (com ou sem barra).
  const nameHit = s.match(COMMAND_NAME_RE);
  if (nameHit) {
    if (bareName(nameHit[1]) !== ORCH_COMMAND) return null;
    const args = s.match(COMMAND_ARGS_RE)?.[1] ?? "";
    return parseArgs(args);
  }

  // (b) forma CRUA — o prompt como buildOrchestratorPrompt o monta.
  const bare = bareName(s);
  if (bare.startsWith(ORCH_COMMAND)) return parseArgs(bare.slice(ORCH_COMMAND.length));

  return null;
}

/** `acme autonomous --tick --motivo "…"` → TickWake. Sem `--tick` ⇒ não é o relógio ⇒ null. */
function parseArgs(args: string): TickWake | null {
  const a = args.trim();
  if (!/(^|\s)--tick(\s|$)/.test(a)) return null;
  const reason = a.match(MOTIVO_RE)?.[1]?.trim();
  // os posicionais vêm antes de qualquer flag: <board> <mode>
  const positional = a.split(/\s+--/)[0].trim().split(/\s+/).filter(Boolean);
  return {
    board: positional[0] ?? "",
    mode: positional[1] ?? "",
    ...(reason ? { reason } : {}),
  };
}

/**
 * A frase que o operador lê no lugar da casca crua. Diz as duas coisas que a bolha-de-XML escondia: que quem
 * falou foi o RELÓGIO (não ele), e POR QUE o Jido acordou. Pura.
 */
export function tickWakeText(wake: TickWake): string {
  return wake.reason ? `Acordei sozinho: ${wake.reason}` : "Acordei sozinho — ciclo periódico";
}

/**
 * Reconhece a casca de QUALQUER slash command no transcript — não só a do tick. Medido: o CLI grava a mesma
 * casca para `/compact` (`<command-name>/compact</command-name>…`), com os elementos em ORDEM DIFERENTE e
 * indentados. Por isso o reconhecimento é por elemento (regex independente), nunca por posição.
 */
export function parseCommandInvocation(raw: string): CommandInvocation | null {
  const s = typeof raw === "string" ? raw : "";
  const nameHit = s.match(COMMAND_NAME_RE);
  if (!nameHit) return null;
  return { name: bareName(nameHit[1]), args: (s.match(COMMAND_ARGS_RE)?.[1] ?? "").trim() };
}

/** Teto do rótulo genérico — um comando com argumento gigante não pode virar uma linha de evento infinita. */
const COMMAND_LABEL_MAX = 80;

/**
 * O texto do EVENTO para um prompt do transcript, ou null quando o prompt é fala de verdade do operador.
 *
 * A regra é de CLASSE, não de caso: se o CLI gravou a casca `<command-name>`, então aquilo foi uma INVOCAÇÃO
 * de comando — e imprimir a casca crua como se fosse prosa do operador é sempre errado. Cobrir só o tick
 * resolvia o vazamento de hoje e deixava a porta aberta: assim que o `/compact` do painel passasse a ser
 * enviado como comando de verdade, a MESMA casca voltaria a aparecer como bolha do humano, por outro caminho.
 * O tick ganha a frase rica (tem motivo a contar); qualquer outro comando ganha o rótulo genérico.
 */
export function commandNoticeText(raw: string): string | null {
  const cmd = parseCommandInvocation(raw);
  if (!cmd) return null;
  const wake = parseTickWake(raw);
  if (wake) return tickWakeText(wake);
  const label = cmd.args ? `/${cmd.name} ${cmd.args}` : `/${cmd.name}`;
  return `Comando: ${label.length > COMMAND_LABEL_MAX ? `${label.slice(0, COMMAND_LABEL_MAX - 1)}…` : label}`;
}
