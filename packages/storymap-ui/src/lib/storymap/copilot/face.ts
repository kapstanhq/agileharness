// O HUMOR do Jido — de sinais REAIS para uma cara. Este módulo é o ESTADO do mascote (a fonte da verdade),
// puro e testável; o DESENHO de cada humor vive em lib/storymap/copilot/mascot.ts e a pintura em
// components/copilot/CopilotFace.tsx.
//
// Por que existe: o Jido tinha um ícone `<Bot/>` parado. Um agente que pensa, chama tool, engasga na API,
// pede aprovação e morre no meio de um turno apresentava TODOS esses estados como o mesmo boneco imóvel — o
// operador só sabia diferenciar lendo texto. O humor transforma o estado interno em algo que se lê num relance.
//
// CUSTO ZERO DE LLM — a regra dura deste módulo. Nenhuma expressão é "decidida" por um modelo: TODO humor é
// DERIVADO (função pura) de sinais que o cliente JÁ tem — o `status` do turno, os `segments[]` (tool rodando,
// tool que falhou), os eventos SSE (`text-delta`/`frame`/`error`), as aprovações pendentes e o nível do board.
// Se um dia alguém quiser "perguntar ao modelo qual cara fazer": não. O humor é observação, não inferência.
//
// PURO (sem React, sem IO, sem timers) → testável. O ESTADO é uma fonte só: o mesmo `deriveMood` alimenta o
// rosto do chat E o do topnav, então as duas superfícies nunca discordam do que o Jido está sentindo.

import type { CopilotStatusLevel } from "@/lib/storymap/copilot/copilot-status";

// ─────────────────────────────────────────────────────────────────────────────
// 1. O VOCABULÁRIO DE HUMORES — os 12 canônicos + `falando`. Adicionar um humor:
//    (a) uma entrada aqui (metadados), (b) uma entrada em MASCOT (o desenho), (c) um degrau em `deriveMood`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Os humores. Os 12 canônicos + `falando`.
 *
 * `falando` existe porque emitir texto token-a-token é o estado MAIS visível do Jido (é o que ele faz na maior
 * parte de um turno) e sem ele o streaming teria que emprestar a cara de outro humor.
 */
export type MoodId =
  | "feliz"
  | "triste"
  | "surpreso"
  | "pensativo"
  | "erro"
  | "dormindo"
  | "piscando"
  | "glitch"
  | "amoroso"
  | "panico"
  | "codigo"
  | "conectado"
  | "falando";

/** O TOM de um humor — reusa a semântica do resto do board. É o que o PONTO de estado (não o rosto) pinta:
 *  o mascote é monocromático (tinta), quem carrega a cor do estado é o ponto/`DOT[tone]` (ver copilot/ui.ts). */
export type MoodTone = "ok" | "warn" | "danger" | "neutral" | "accent";

/** Os metadados de um humor — o que o rosto NÃO desenha: o rótulo de acessibilidade, a palavra de estado e o tom.
 *  (O desenho — olhos, braços, glifos — vive em MASCOT; o QUANDO, em `deriveMood`.) */
export interface MoodMeta {
  readonly id: MoodId;
  /** o que um leitor de tela (e o tooltip) anuncia. */
  readonly label: string;
  /** o estado em 1-2 palavras, minúsculas — a linha viva ao lado do rosto ("pensando", "trabalhando"). */
  readonly short: string;
  /** o tom do estado (o ponto pulsante o pinta; o rosto continua tinta). */
  readonly tone: MoodTone;
}

/** O registro de humores — metadados só. Exaustivo por `MoodId`. Consumido pelo rosto (label), pela linha viva
 *  (short) e pelo ponto de estado (tone). Mantém o nome `EXPRESSIONS` porque é a chave que os consumidores usam. */
export const EXPRESSIONS: Record<MoodId, MoodMeta> = {
  feliz: { id: "feliz", label: "Copiloto tranquilo", short: "tranquilo", tone: "neutral" },
  falando: { id: "falando", label: "Copiloto respondendo", short: "respondendo", tone: "accent" },
  pensativo: { id: "pensativo", label: "Copiloto pensando", short: "pensando", tone: "neutral" },
  codigo: { id: "codigo", label: "Copiloto trabalhando", short: "trabalhando", tone: "accent" },
  surpreso: { id: "surpreso", label: "Copiloto esperando sua resposta", short: "esperando você", tone: "warn" },
  panico: {
    id: "panico",
    label: "Copiloto pedindo confirmação de uma ação irreversível",
    short: "quer sua confirmação",
    tone: "danger",
  },
  erro: { id: "erro", label: "Copiloto com erro", short: "com erro", tone: "danger" },
  glitch: { id: "glitch", label: "Copiloto instável (conexão ou retry da API)", short: "instável", tone: "danger" },
  conectado: { id: "conectado", label: "Copiloto agindo sozinho no board", short: "agindo sozinho", tone: "ok" },
  amoroso: { id: "amoroso", label: "Copiloto satisfeito", short: "feito", tone: "ok" },
  triste: { id: "triste", label: "Copiloto cansado", short: "cansado", tone: "warn" },
  dormindo: { id: "dormindo", label: "Copiloto dormindo", short: "dormindo", tone: "neutral" },
  piscando: { id: "piscando", label: "Copiloto piscando", short: "pronto", tone: "neutral" },
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. SINAIS — o que o humor precisa saber. TODOS estes campos já existem no cliente hoje (custo zero de LLM).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tudo que o humor precisa saber. `chat`/`streamingText`/`runningTool`/`interrupted`/`straining` saem do funil
 * de eventos SSE do `useCopilotAgent`; `pendingApprovals`/`topRisk` do `CopilotChat`; `level` do `copilotStatus()`;
 * `autonomousRunning` do overview do orquestrador; `contextTone` do `contextPressure()`. Nenhum custa um modelo.
 */
export interface FaceSignals {
  /** o status do turno do chat (`useCopilotAgent`). */
  chat?: "idle" | "typing" | "error";
  /** o assistente está cuspindo texto agora (último segmento é texto e o turno está vivo). */
  streamingText?: boolean;
  /** o nome CRU da tool em execução (`Bash`, `Read`, `mcp__storymap__move_card`…), se alguma. */
  runningTool?: string | null;
  /** o turno morreu no meio (queda de conexão / restart do serviço) — segmentos-sentinela do hook. */
  interrupted?: boolean;
  /** a API está em retry (evento SSE `frame`). */
  straining?: boolean;
  /** quantas aprovações esperam o humano. */
  pendingApprovals?: number;
  /** a classe de risco mais alta entre as pendentes (`deploy`, `destructive`, …). */
  topRisk?: string | null;
  /** o humano acabou de aprovar uma ação (transitório — quem seta, apaga). */
  delighted?: boolean;
  /** o humano acabou de REJEITAR uma ação (transitório). Ele murcha — e é justo que murche: você disse não. */
  dejected?: boolean;
  /** um tick autônomo está rodando neste board agora. */
  autonomousRunning?: boolean;
  /** o nível do board (chip da verdade do header). */
  level?: CopilotStatusLevel;
  /** a pressão da janela de contexto. */
  contextTone?: "ok" | "warn" | "danger";
  /**
   * Houve turno RECENTE nesta conversa (minutos, não horas) — a conversa está morna.
   *
   * Existe para separar duas coisas que estavam coladas: "o board não vai acordá-lo sozinho"
   * (`level` desligado/desarmado) e "ninguém está falando com ele". Quem acabou de conversar com o
   * Jido não aceita vê-lo `dormindo` — ele está ali, respondendo.
   */
  recentTurn?: boolean;
}

/**
 * As tools que só LEEM. Uma tool de leitura deixa o Jido PENSATIVO; qualquer outra o põe em CÓDIGO
 * (trabalhando). É a única classificação que o humor faz — e é uma tabela, não uma regex de adivinhação:
 * o que não estiver aqui é tratado como escrita/execução (falha para o lado de "ele está MEXENDO em algo").
 */
const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "webfetch",
  "websearch",
  "get_card",
  "get_card_plan",
  "get_card_wireframes",
  "list_cards",
  "list_boards",
  "list_files",
  "list_statuses",
  "list_pending_changes",
  "read_file",
  "file_tree",
  "search_code",
  "card_diff",
  "card_console",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "runner_status",
  "deploy_plan",
  "deploy_status",
  "service_health",
  "ops_health",
  "query_errors",
  "get_vocabulary",
  "worktree_list",
]);

/** Tira o prefixo MCP (`mcp__storymap__move_card` → `move_card`) e normaliza. Pura. */
export function toolKey(name: string): string {
  const short = name.replace(/^mcp__[^_]+(?:__)?/, "").replace(/^mcp__/, "");
  return (short.split("__").pop() ?? short).trim().toLowerCase();
}

/** Uma tool que só lê não assusta ninguém — o humor reflete isso. Pura. */
export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(toolKey(name));
}

/** As classes de risco que NUNCA são automáticas — pedir uma dessas é motivo de pânico. */
const SCARY_RISK = new Set(["deploy", "destructive", "run-free"]);

/** A classe mais assustadora da fila de aprovações — é ela que decide entre susto e pânico. Pura. */
export function scariestRisk(classes: readonly string[]): string | null {
  return classes.find((c) => SCARY_RISK.has(c)) ?? classes[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. SINAIS → HUMOR. Função pura, prioridade explícita de cima para baixo: o que é mais URGENTE para o operador
//    ver ganha. A ordem é a regra de produto inteira do rosto — mexer aqui muda o mascote, e o teste cobre cada
//    degrau.
// ─────────────────────────────────────────────────────────────────────────────

export function deriveMood(s: FaceSignals): MoodId {
  // 1. quebrou: nada é mais importante de mostrar.
  if (s.chat === "error") return "erro";
  // 2. a máquina está engasgando (retry da API, conexão caída, turno interrompido no meio).
  if (s.interrupted || s.straining) return "glitch";
  // 3. ele PAROU e depende de você — e treme se o que ele pede for irreversível.
  if ((s.pendingApprovals ?? 0) > 0) {
    return s.topRisk && SCARY_RISK.has(s.topRisk) ? "panico" : "surpreso";
  }
  // 4. tem tool rodando: lendo (pensativo) vs mexendo (código).
  if (s.runningTool) return isReadOnlyTool(s.runningTool) ? "pensativo" : "codigo";
  // 5. está falando com você.
  if (s.streamingText) return "falando";
  // 6. turno enviado, nada voltou ainda.
  if (s.chat === "typing") return "pensativo";
  // 7. você acabou de decidir sobre uma ação dele: aprovou (ele se derrete) ou rejeitou (ele murcha).
  if (s.delighted) return "amoroso";
  if (s.dejected) return "triste";
  // 8. em repouso, mas trabalhando sozinho no board.
  if (s.autonomousRunning) return "conectado";
  // 9. em repouso e o board não vai acordá-lo (desligado, tick desarmado, sem token) — MAS só dorme se ninguém
  //    estiver conversando com ele. "O board não vai acordá-lo" e "ninguém está falando com ele" são coisas
  //    diferentes; colapsá-las mostrava `dormindo` no meio de uma conversa viva.
  if (!s.recentTurn && (s.level === "off" || s.level === "auto-disarmed" || s.level === "auto-inert")) {
    return "dormindo";
  }
  // 10. em repouso, mas a sessão está pesada — a cara pede um /compact.
  if (s.contextTone === "danger") return "triste";
  // 11. repouso: amigável.
  return "feliz";
}

/** O humor já resolvido em metadados (o que o consumidor lê para label/short/tone). Pura. */
export function faceFor(signals: FaceSignals): MoodMeta {
  return EXPRESSIONS[deriveMood(signals)];
}

/** Os humores que INTERROMPEM: o que ele SENTE agora vale mais que qualquer notícia. */
const URGENT_MOODS = new Set<MoodId>(["panico", "surpreso", "erro", "glitch"]);

/**
 * Este humor é dos que interrompem? Mora aqui — junto do vocabulário — porque tem DOIS consumidores
 * que precisam concordar: a fala do balão (`copilot/speech`, onde o humor urgente vence o diário) e o
 * anúncio de notícias no topnav (BoardHeader, onde uma notícia do board NÃO pode cobrir a cara de quem
 * quebrou ou parou esperando você). Duas cópias desta lista seriam duas ideias diferentes de urgente.
 */
export function isUrgentMood(mood: MoodId): boolean {
  return URGENT_MOODS.has(mood);
}

/**
 * O Jido está TRABALHANDO agora? — o fato por trás do pulso do ponto e do peso da tinta do rosto.
 *
 * É o que a régua `active` do topnav DEVERIA ter sido: turno em voo (o chat mandou e nada voltou),
 * tool rodando, texto saindo, ou um tick autônomo no board. O que ela era: `live` — "houve turno nos
 * últimos 30 MINUTOS". Isso é HISTÓRICO, não trabalho: por meia hora depois de qualquer conversa o
 * mascote ficava pintado de vivo com o Jido parado sem fazer nada, e o operador não tinha como
 * distinguir isso de "ele está agindo sozinho". Recência mora no rodapé do balão ("conversa viva ·
 * ctx 12%"), onde é informação; no rosto ela é mentira.
 *
 * (É o mesmo erro que custou o ponto verde dos Terminais: `status === "running"` só prova que o
 * processo existe — sessão travada há 80h e sessão escrevendo código liam idêntico.)
 */
export function isWorking(s: FaceSignals): boolean {
  return Boolean(s.autonomousRunning || s.runningTool || s.streamingText || s.chat === "typing");
}

/** As cores de ponto que a barra conhece (o vocabulário do `NavDot`). `null` = sem ponto. */
export type MoodDot = "live" | "attention" | "danger" | null;

/**
 * O PONTO de estado no canto da cabeça — e, principalmente, QUANDO ele NÃO existe.
 *
 * Ele era um verde pulsante fixo (`tone="live"`) preso à mesma booleana que pintava o rosto de âmbar:
 * UM sinal pintado em DUAS cores diferentes, nenhuma delas a do humor. Daí a pergunta do operador
 * diante de um mascote laranja com selo verde — "que status é este?". Nenhum: era recência.
 *
 * A régua agora é o TOM do humor (que é derivado de fatos), então o ponto tem UM significado — *algo
 * aqui pede o seu olho* — e a cor gradua a urgência: verde ele está agindo (`conectado`, `feito`),
 * âmbar ele PAROU e espera você (`esperando você`, `cansado`), rosa quebrou (`erro`, `instável`,
 * `quer sua confirmação`). Repouso (`neutral`: tranquilo, pensando, dormindo, pronto) não ganha ponto
 * nenhum — um mascote em paz não precisa de selo anunciando que está em paz, e é justamente o silêncio
 * do repouso que faz o ponto significar alguma coisa quando acende.
 *
 * Quem pulsa é o `isWorking` (movimento = movimento de verdade); um ponto de "ele parou e espera você"
 * é estático de propósito — nada está acontecendo ali, esse é o ponto.
 */
export function moodDot(mood: MoodId): MoodDot {
  switch (EXPRESSIONS[mood].tone) {
    case "ok":
    case "accent":
      return "live";
    case "warn":
      return "attention";
    case "danger":
      return "danger";
    default:
      return null; // neutral = repouso
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. ADAPTADOR — do estado do chat (useCopilotAgent) para os sinais do humor. Fica AQUI (e não no componente)
//    porque neste pacote o que é puro é o que é testado.
// ─────────────────────────────────────────────────────────────────────────────

/** Os segmentos-sentinela que o hook injeta quando um turno morre no meio, e o que os cancela. */
const DEAD_SEGS = new Set(["dropped", "interrupted"]);
const RECOVERED_SEG = "reconnect";

/**
 * Lê o turno pendente e devolve os sinais do humor. Pura (estruturalmente tipada: recebe só o que lê, para
 * não amarrar o humor ao tipo inteiro do HITL).
 *
 * Detalhe que evita um humor preso em `glitch`: a queda de conexão deixa um segmento `dropped`/`interrupted`
 * no turno, e a recuperação bem-sucedida ou SUBSTITUI os turnos (o sentinela some) ou anexa um `reconnect`.
 * Então "está caído" = tem sentinela de morte E NÃO tem o de recuperação depois.
 */
export function chatSignals(input: {
  status: "idle" | "typing" | "error";
  turns: readonly {
    role: string;
    segments?: readonly (
      | { type: "text"; segId: string; text: string }
      | { type: "tool"; segId: string; name: string; status: string }
    )[];
  }[];
  straining?: boolean;
}): FaceSignals {
  const lastAgent = [...input.turns].reverse().find((t) => t.role === "agent");
  const segs = lastAgent?.segments ?? [];

  const running = [...segs].reverse().find((s) => s.type === "tool" && s.status === "running");
  const last = segs[segs.length - 1];

  const died = segs.some((s) => s.type === "text" && DEAD_SEGS.has(s.segId));
  const recovered = segs.some((s) => s.type === "text" && s.segId === RECOVERED_SEG);

  return {
    chat: input.status,
    straining: input.straining,
    interrupted: died && !recovered,
    runningTool: running && running.type === "tool" ? running.name : null,
    // "falando" = o turno está vivo E a última coisa na tela é texto crescendo (se a última coisa é uma tool,
    // quem manda é a tool — é a pill viva que o operador está olhando).
    streamingText: input.status === "typing" && last?.type === "text" && last.text.length > 0,
  };
}
