// OS PODERES DE UMA CONVERSA DO JIDO — o que um turno monta (nível do MCP, tools nativas) a partir do PROPÓSITO, do
// modo do board e da TRAVA DURA do host. PURO: o spawn (agent-session.ts) só aplica o plano, e o teste o fixa sem subir
// processo.
//
// A DECISÃO DO DONO (06/10, fase 6): o chat do board é a CENTRAL DE COMANDO — poderes amplos (shell, editar, o MCP
// inteiro) em qualquer modo do board, porque o modo governa os agentes AUTÔNOMOS e esta conversa é o dono presente. O
// que contém o chat são três coisas, nenhuma delas o token:
//   1. a TRAVA DURA do host (um hook `PreToolUse` que cobre `Bash`), que casa só com `Bash` — por isso a lista de
//      tools nativas abaixo é uma lista do PERMITIDO e nenhuma outra tool que rode comando de shell entra (`Monitor`
//      executava comando por fora da trava; ver runner/session-spawn.ts `SHELL_RUNNING_TOOLS`). Os caminhos de shell
//      do MCP (abrir terminal, digitar num shell) passam pela MESMA trava no serviço (runner/claude-settings.ts
//      `evaluateShellGuard`). O repositório NÃO traz essa trava: ela é do host. Sem ela instalada, os poderes amplos
//      não existem — a conversa cai para leitura (MCP `ro`, sem shell, sem editar) e o turno avisa o porquê;
//   2. o REGISTRO (copilot/chat-audit.ts): toda ação do chat entra na trilha de auditoria em nome dele;
//   3. a RÉGUA DE CONFIRMAÇÃO da persona (hitl/purpose-registry.ts `CHAT_COMMAND_CENTER_CLAUSE`).
// As conversas de TELA (propósito `ro`: documento, vocabulário, ideia) não têm shell: a promessa «só leitura» delas vale
// para o repositório também, não só para o board.

import type { HitlPurpose } from "../hitl/purpose-registry";
import { CHAT_DENIED_TOOLS } from "./protocol";
import type { CopilotTier } from "./tier";

/**
 * As tools NATIVAS de uma conversa do Jido (`--tools`, lista do PERMITIDO). Agent (subagentes de leitura e revisão),
 * o shell e os arquivos (Bash/Read/Edit/Write/Glob/Grep), TaskStop (parar o que ele subiu em segundo plano),
 * WebFetch/WebSearch (documentação antes de prescrever) e ToolSearch (sem ela o CLI não adia os schemas MCP e o 1º
 * turno carrega todos — medido em session-spawn.ts). FORA de propósito: `Monitor` e `PowerShell` (rodam comando por
 * fora da trava dura), `NotebookEdit`, e o resto da superfície do CLI que uma conversa não usa.
 */
export const CHAT_NATIVE_TOOLS = ["Agent", "Bash", "Read", "Edit", "Write", "Glob", "Grep", "TaskStop", "WebFetch", "WebSearch", "ToolSearch"] as const;

/**
 * As tools do MCP com que o chat opera os TERMINAIS do AgileHarness (que seguem separados do chat — o dono abre vários).
 * A persona as ensina (`CHAT_COMMAND_CENTER_CLAUSE`); um teste prende os dois lados e confere que o nível `full` as monta.
 */
export const CHAT_TERMINAL_TOOLS = {
  list: "claude_sessions",
  readScreen: "claude_capture",
  readConversation: "session_read",
  ask: "session_ask",
  type: "claude_send",
  kill: "claude_kill",
  open: "term_new",
} as const;

/** O que um turno monta. */
export interface ChatSpawnPlan {
  /** o token MCP: `full` = o MCP inteiro; `ro` = só leitura + as escritas de documento. */
  mcpLevel: "ro" | "full";
  /** as tools nativas permitidas (`--tools`). */
  tools: string[];
  /** as nativas negadas (`--disallowedTools`), quando o propósito/modo nega alguma — redundante com `tools`, de propósito. */
  deniedTools?: string;
  /** a trava dura do host faltou e a conversa caiu para leitura (o turno avisa o dono). */
  guardMissing?: true;
}

/** O que uma conversa SÓ DE LEITURA nunca monta: o shell (fora do alcance de qualquer garantia de «só leitura») e editar. */
export const CHAT_READ_ONLY_DENIED_TOOLS = "Bash,Write,Edit,NotebookEdit";

const merge = (a: string | undefined, b: string) => [...new Set([...(a ?? "").split(","), ...b.split(",")].map((t) => t.trim()).filter(Boolean))].join(",");

/**
 * O plano de poderes de um turno. O PROPÓSITO manda quando opina (o Jido do board declara `full`; as conversas de tela
 * declaram `ro` e negam Write/Edit); sem opinião, o modo do board decide (o comportamento histórico). Duas réguas por
 * cima, e as duas só TIRAM: (a) uma conversa de nível `ro` não tem shell — com Bash na mão a promessa de leitura não
 * valeria para o repositório, e um shell alcança as credenciais do serviço; (b) sem a trava dura do host instalada
 * (`hardDeny: false`) NENHUMA conversa tem os poderes amplos — cai para `ro`, sem shell e sem editar. As tools nativas
 * são SEMPRE a lista do permitido menos as negadas — nenhuma conversa nasce com uma tool de shell fora da trava. PURA.
 */
export function chatSpawnPlan(purpose: Pick<HitlPurpose, "mcpLevel" | "deniedTools">, tier: CopilotTier, opts: { hardDeny?: boolean } = {}): ChatSpawnPlan {
  // o propósito que declara o NÍVEL declarou o recorte inteiro: o que ele não nega, ele monta (o Jido do board declara
  // `full` e nenhuma negação — o modo `chat` do board não pode tirar dele o editar)
  const opinionated = purpose.mcpLevel !== undefined;
  const guardMissing = opts.hardDeny === false;
  const mcpLevel = guardMissing ? "ro" : (purpose.mcpLevel ?? (tier === "chat" ? "ro" : "full"));
  let deniedTools = purpose.deniedTools ?? (!opinionated && tier === "chat" ? CHAT_DENIED_TOOLS : undefined);
  if (mcpLevel === "ro") deniedTools = merge(deniedTools, CHAT_READ_ONLY_DENIED_TOOLS);
  const denied = new Set((deniedTools ?? "").split(",").map((t) => t.trim()).filter(Boolean));
  return {
    mcpLevel,
    tools: CHAT_NATIVE_TOOLS.filter((t) => !denied.has(t)),
    ...(deniedTools ? { deniedTools } : {}),
    ...(guardMissing ? { guardMissing: true as const } : {}),
  };
}
