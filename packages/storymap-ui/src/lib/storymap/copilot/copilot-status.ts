// copilot-status.ts — A VERDADE sobre o que o Jido vai fazer neste board, em uma frase.
//
// Por que existe: "auto" aceso na UI significava coisas MUITO diferentes — pode estar agindo, pode estar
// INERTE (sem o token do orquestrador, ou com o tick global desarmado), ou pode estar aceso e só LENDO (a
// matriz de risco default manda todo write-board para aprovação humana). O operador via o mesmo botão aceso
// nos quatro casos e concluía "está trabalhando". Isto aqui é a fonte ÚNICA que derruba a ambiguidade — o chip
// persistente do header, o tooltip e a confirmação de ativação leem daqui.
//
// PURA (sem React, sem IO) → testável e usável nos dois lados (server action e client component).

import type { OrchestratorMode, RiskDisposition } from "@/lib/storymap/types";

export type CopilotStatusLevel =
  | "off"
  | "paired"
  /** autônomo, mas o tick global está desarmado em settings ⇒ nunca roda. */
  | "auto-disarmed"
  /** autônomo e armado, mas sem STORYMAP_MCP_TOKEN_ORCH no serviço ⇒ o spawn é pulado. */
  | "auto-inert"
  /** autônomo de verdade, mas a matriz só permite `read` ⇒ ele lê e PEDE aprovação p/ qualquer escrita. */
  | "auto-readonly"
  /** autônomo, armado, com token e com permissão de escrever no board ⇒ age sozinho. */
  | "auto-active";

export interface CopilotStatus {
  level: CopilotStatusLevel;
  /** verde = está fazendo o que o rótulo promete; âmbar = aceso mas NÃO faz o que parece; neutro = desligado. */
  tone: "ok" | "warn" | "neutral";
  /** chip CURTO (1–2 palavras: o header do chat tem ~420px e já carrega o segmented + o countdown + a
   *  engrenagem — um label longo quebrava a linha). A frase inteira vive em `detail` (tooltip). */
  label: string;
  /** frase completa (tooltip / confirmação) — diz o que ele faz E o que falta, quando falta algo. */
  detail: string;
  /** true quando o board está autônomo mas NÃO vai agir — o caso que o operador precisa enxergar. */
  inert: boolean;
}

export interface CopilotStatusInput {
  mode: OrchestratorMode;
  /** settings.orchestrator.enabled — o tick global. */
  enabled: boolean;
  /** STORYMAP_MCP_TOKEN_ORCH presente no env do serviço. */
  orchTokenPresent: boolean;
  /** a disposição RESOLVIDA da classe `write-board` (a que decide se ele edita cards sozinho). */
  writeBoard: RiskDisposition;
  /** a disposição RESOLVIDA de `deploy` — distingue Copiloto (ask/never) de Autônomo (auto) no chip ativo.
   *  Ausente ⇒ tratado como não-auto (Copiloto). */
  deploy?: RiskDisposition;
}

/** O estado REAL do Jido no board. PURA. */
export function copilotStatus(s: CopilotStatusInput): CopilotStatus {
  if (s.mode === "off") {
    return {
      level: "off",
      tone: "neutral",
      label: "manual",
      detail:
        "Copiloto desligado neste board: sem tick autônomo. O CHAT continua funcionando normalmente — o modo governa só o que ele faz SEM você.",
      inert: false,
    };
  }
  if (s.mode === "paired") {
    return {
      level: "paired",
      tone: "neutral",
      label: "sugere",
      detail:
        "Pareado: você dirige. O copiloto vê o board e sugere no seu chat, mas nunca age sozinho — nenhum tick dispara neste modo.",
      inert: false,
    };
  }
  if (!s.enabled) {
    return {
      level: "auto-disarmed",
      tone: "warn",
      label: "tick desarmado",
      detail:
        "Autônomo LIGADO, mas o tick global está DESARMADO em settings — o Jido não vai agir até você armá-lo (engrenagem → Jido ligado).",
      inert: true,
    };
  }
  if (!s.orchTokenPresent) {
    return {
      level: "auto-inert",
      tone: "warn",
      label: "inerte",
      detail:
        "Autônomo LIGADO, mas INERTE: falta o token do orquestrador (STORYMAP_MCP_TOKEN_ORCH) no env do serviço — sem ele o spawn é pulado e nada roda.",
      inert: true,
    };
  }
  if (s.writeBoard !== "auto") {
    return {
      level: "auto-readonly",
      tone: "warn",
      label: "só leitura",
      detail:
        "Autônomo, mas SÓ LEITURA: a matriz de risco manda toda escrita no board para aprovação humana. Ele lê, diagnostica e enfileira pedidos — não move nem edita card sozinho. Para dar autonomia real, ponha `write-board: auto` na matriz.",
      inert: false,
    };
  }
  // auto-active: o board age sozinho. O QUE ele faz sozinho depende do ESTADO (Copiloto × Autônomo): ambos movem,
  // rodam a skill da coluna e resolvem merge; Autônomo (deploy:auto) ainda decide produto e PUBLICA. O chip diz a
  // verdade de cada um — o texto anterior ("rodar pipeline/merge continuam exigindo você") virou FALSO para o
  // Copiloto, que os faz sozinho.
  if (s.deploy === "auto") {
    return {
      level: "auto-active",
      tone: "ok",
      label: "publica",
      detail:
        "Autônomo: orquestra este board de ponta a ponta — move, roda a skill da coluna, resolve merge E PUBLICA em produção sozinho. Abrir shell (run-free) e apagar dados (destructive) continuam exigindo você.",
      inert: false,
    };
  }
  return {
    level: "auto-active",
    tone: "ok",
    label: "agindo",
    detail:
      "Copiloto: lê, move e roda o board sozinho (skill da coluna, destrava merge preso). Deploy e decisões de produto/UX param em você — ele propõe e aguarda.",
    inert: false,
  };
}

/**
 * Janela de contexto PADRÃO — o piso, usado só quando o modelo não é conhecido. Antes era a única verdade
 * (`200_000`, com um comentário afirmando "o CLI roda opus" — e o settings dizia `sonnet`): um número chumbado
 * que não perguntava nada a ninguém, e que estaria errado em qualquer troca de modelo.
 */
export const CHAT_CONTEXT_WINDOW = 200_000;

/** A janela de 1M, quando o operador pede a variante de contexto longo. */
export const CHAT_CONTEXT_WINDOW_1M = 1_000_000;

/**
 * A janela REAL do modelo que o chat vai rodar. Na API todos os modelos atuais (Opus 4.8, Sonnet 5) já são 1M —
 * mas o CLI do Claude Code trata o contexto longo como uma VARIANTE que se pede pelo sufixo `[1m]` no id do
 * modelo (`claude-opus-4-8[1m]`); um `--model sonnet` seco roda na janela padrão. Verificado ao vivo: o CLI
 * aceita `opus[1m]` e `claude-opus-4-8[1m]` (um modelo inventado devolve 404, então o aceite é real, não silêncio).
 *
 * Por isso a janela é FUNÇÃO do model string que o spawn passa — não uma constante. PURA.
 */
export function contextWindowForModel(model: string | undefined): number {
  return /\[1m\]/i.test(model ?? "") ? CHAT_CONTEXT_WINDOW_1M : CHAT_CONTEXT_WINDOW;
}

/**
 * O id do modelo se decompõe em BASE (`opus`) + VARIANTE de contexto longo (`[1m]`). Separar os dois é o que
 * permite a UI oferecer "modelo" e "janela" como duas escolhas independentes, em vez de um select com
 * `opus`, `opus[1m]`, `sonnet`, `sonnet[1m]` (que cresce por multiplicação e convida ao erro de digitação).
 * PURAS.
 */
export function splitModelVariant(model: string | undefined): { base: string; long: boolean } {
  const raw = (model ?? "").trim();
  return { base: raw.replace(/\[1m\]/i, "").trim(), long: /\[1m\]/i.test(raw) };
}

export function composeModel(base: string, long: boolean): string {
  const b = base.trim().replace(/\[1m\]/i, "");
  return long ? `${b}[1m]` : b;
}

/**
 * O VOCABULÁRIO do chat — os modelos-base e os esforços que o Jido aceita.
 *
 * Mora aqui (módulo isomórfico, sem IO) porque tem DOIS consumidores em lados opostos: a coerção do
 * settings (`runner/config.ts`, servidor — valor fora da lista cai no default e nunca persiste lixo) e as
 * superfícies de escolha (a engrenagem e o comando `/model`, cliente). Uma segunda lista em qualquer um dos
 * dois viraria a lista que apodrece — e o sintoma seria silencioso: a UI oferece um valor que o servidor
 * descarta, e o operador acha que trocou o modelo.
 *
 * Modelo NOVO no CLI = UMA entrada aqui.
 */
export const CHAT_MODEL_BASES = ["sonnet", "opus"] as const;
export const CHAT_EFFORTS = ["medium", "high", "xhigh"] as const;

/** Onde a sessão está na janela de contexto (0–100) e o quão urgente é agir. PURA. */
export function contextPressure(tokens: number, windowTokens = CHAT_CONTEXT_WINDOW): {
  pct: number;
  tone: "ok" | "warn" | "danger";
  /** o conselho: seguir, compactar, ou limpar. */
  advice: string;
} {
  const pct = Math.min(100, Math.max(0, Math.round((tokens / Math.max(1, windowTokens)) * 100)));
  if (pct >= 80) {
    return { pct, tone: "danger", advice: "Contexto quase cheio — compacte (/compact) ou comece uma conversa nova." };
  }
  if (pct >= 55) {
    return { pct, tone: "warn", advice: "Contexto ficando grande — considere compactar para o chat seguir barato e afiado." };
  }
  return { pct, tone: "ok", advice: "Contexto folgado." };
}

/** Tokens em texto curto: 45k, 1.2k, 980. PURA. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  const k = n / 1_000;
  return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

/** Idade legível: "agora", "12min", "3h", "2d". PURA. */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "agora";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Quanto falta p/ o próximo tick, em texto curto ("12min", "40s", "agora"). PURA. */
export function formatCountdown(msLeft: number): string {
  if (!Number.isFinite(msLeft) || msLeft <= 0) return "agora";
  const s = Math.round(msLeft / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}`;
}
