// O DIÁRIO DE DECISÕES do Jido — o que ele fez, o que está fazendo, e o que ele DECIDIU NÃO fazer.
//
// Antes, uma decisão autônoma só existia em três lugares que o operador não vê: o `lastTick` (sobrescrito a
// cada tick — a decisão anterior evaporava), o ledger de tool calls (agent-actions, sem superfície) e o log do
// systemd. O resultado prático: o Jido trabalhava (ou se recusava a trabalhar) em silêncio, e a única
// forma de saber era ir ler arquivo. Um "pulei porque o budget acabou" é tão importante quanto um "movi 2
// cards" — sem ele o operador só vê um copiloto que não faz nada e não sabe por quê.
//
// Aqui é um journal APPEND-ONLY por board (.runner/copilot-activity/<board>.jsonl), que o chat lê e mostra no
// corpo da conversa. Best-effort em TUDO: escrever no diário nunca pode derrubar um tick nem uma tool call.

import { promises as fs } from "node:fs";
import path from "node:path";
import { runnerStateDir, sanitizeId } from "@/lib/storymap/paths";
import { ACTIVITY_MAX_ENTRIES, diarySentence } from "@/lib/storymap/copilot/activity-view";
import type { OrchestratorTickStatus } from "@/lib/storymap/runner/orchestrator-tick";
import { SPAWN_BREAKER_THRESHOLD } from "@/lib/storymap/runner/orchestrator-state";

/** O tipo de decisão — o cliente escolhe o ícone/cor por aqui, nunca por regex no texto. */
export type CopilotActivityKind =
  /** o tick acordou e DISPAROU o Jido de verdade (nasceu um processo). NUNCA para uma intenção. */
  | "woke"
  /**
   * um wake foi AGENDADO — uma PROMESSA de olhar o board daqui a Ns, não trabalho.
   *
   * Existe porque a promessa vinha marcada como `woke`, e um wake agendado que depois PULA é
   * indistinguível de um ciclo que rodou: o diário mostrava "⚡ Vi um evento e vou acordar" e nada mais
   * acontecia. Foi assim que um copiloto parado há 10h passou por um copiloto trabalhando — e o silêncio
   * seguinte virou "o chat quebrou". Uma intenção nunca pode vestir a roupa de um fato.
   */
  | "scheduled"
  /** o tick decidiu NÃO agir por disciplina (sem trabalho, sem budget, humano no comando). Ruído de fundo. */
  | "stood-down"
  /**
   * o tick DESISTIU de um trabalho acionável e o devolveu ao humano (backoff por item estourado).
   *
   * NÃO é `stood-down`: "não há o que fazer" é ruído; "eu tentei, não consegui, agora é SEU e só destrava
   * se você re-armar" é a transferência de uma pendência — a linha mais importante que este diário emite.
   * Como `stood-down` (tier idle) ela era pintada em cinza e colapsada junto com o resto, exatamente o
   * oposto do que precisa acontecer. A distinção JÁ existia no texto (tickOutcomeText a escrevia); só não
   * chegava ao kind, que é o que o cliente pinta.
   */
  | "handed-back"
  /** o run terminou (com o resumo do que fez + custo). */
  | "finished"
  /** o Jido executou uma ação sozinho (a matriz permitia). */
  | "acted"
  /** o Jido PAROU e pediu sua aprovação. */
  | "asked"
  /** o Jido RECUSOU uma ação irreversível (nunca é automática). */
  | "refused"
  /** algo quebrou. */
  | "error";

export interface CopilotActivityEntry {
  /** id monotônico (ts + seq) — o cliente deduplica por ele. */
  id: string;
  /** ISO. */
  at: string;
  kind: CopilotActivityKind;
  /** a frase que o operador lê no chat. */
  text: string;
  /** detalhe opcional (tool, card, custo) — vai no tooltip/segunda linha. */
  detail?: string;
}

// O teto do diário vem de activity-view.ts — o MESMO número que o feed usa para exibir, para armazenamento e
// exibição nunca discordarem. Era 300 aqui: arquivo morto que ninguém rolava até o fim (ver o doc-comment lá).
const MAX_KEEP = ACTIVITY_MAX_ENTRIES;

function activityPath(board: string): string {
  return path.join(runnerStateDir(), "copilot-activity", `${sanitizeId(board)}.jsonl`);
}

/**
 * A frase HUMANA de cada desfecho do tick. É o coração do pedido "me avise até quando você pular": cada
 * stand-down vira uma explicação que o operador entende sem abrir código. PURA (testada).
 * Devolve null p/ os desfechos que NÃO merecem uma linha (um board que nem é autônomo não "decidiu" nada).
 */
export function tickOutcomeText(
  outcome: OrchestratorTickStatus,
  ctx?: {
    reason?: string;
    ticksToday?: number;
    maxTicks?: number;
    /** custo gasto hoje + o teto — dá o "$X/$Y" concreto do budget em vez de um "budget" abstrato. */
    costToday?: number;
    maxCostUSD?: number;
    /** quantos ciclos seguidos gastaram sem mover o MESMO trabalho (backoff). */
    noopStreak?: number;
    /** quantos itens acionáveis esperam AGORA — o "o que eu FARIA" do stand-down pareado. */
    actionableCount?: number;
    /** WS-12.2 (D16) — os itens acionáveis de que o Jido DESISTIU (backoff por-item): o que transforma o
     *  "nada acionável" numa entrega de trabalho explícita ao humano. Vazio/ausente ⇒ não havia mesmo nada. */
    backoffItemIds?: string[];
    /** o cap de tentativas por item (PER_ITEM_NOOP_MAX) — o "após K tentativas" da frase. */
    perItemNoopMax?: number;
    failureStreak?: number;
    failureReason?: string;
    tickInFlight?: boolean;
  },
): { kind: CopilotActivityKind; text: string } | null {
  switch (outcome) {
    case "ran":
      return {
        kind: "woke",
        text: ctx?.reason ? `Acordei: ${ctx.reason}. Analisando o board…` : "Tick periódico — analisando o board…",
      };
    case "skipped-no-work": {
      // WS-12.2 (D16) — "nada acionável" e "N acionáveis, desisti de todos" NÃO são a mesma coisa. A segunda é
      // uma transferência de trabalho: o Jido tentou o que podia, não moveu, e agora o item é do humano.
      // Dizê-la como a primeira é a desistência invisível da colisão #7 (o board acme repetiu "nada acionável"
      // por horas com 6 itens à vista, um deles um card limpo pronto para publicar). A frase NOMEIA os itens.
      const gaveUp = ctx?.backoffItemIds ?? [];
      if (gaveUp.length === 0) {
        return { kind: "stood-down", text: "Olhei o board: nada acionável para mim agora (nenhum card travado, conflito de merge ou pergunta que eu resolva)." };
      }
      const n = gaveUp.length;
      const tries = ctx?.perItemNoopMax != null ? ` após ${ctx.perItemNoopMax} tentativas sem progresso cada` : "";
      return {
        // `handed-back`, não `stood-down`: isto NÃO é "não tinha o que fazer" — é "tinha, tentei, desisti, e
        // agora depende de VOCÊ re-armar". Marcado como ruído, ficava cinza e colapsado; o board do acme passou
        // 10h assim, com o tick parado, e ninguém viu.
        kind: "handed-back",
        text:
          `Olhei o board: ${n} ${n === 1 ? "item acionável" : "itens acionáveis"}, e desisti ` +
          `${n === 1 ? "dele" : "de todos"}${tries} — ${n === 1 ? "ele é" : "eles são"} seu${n === 1 ? "" : "s"} agora: ` +
          `${gaveUp.join(", ")}. Re-arme no Inbox se quiser que eu tente de novo.`,
      };
    }
    case "skipped-budget": {
      // Concreto: quanto dos DOIS tetos (ticks e custo) já gastei hoje, e quando a janela volta.
      const ticks = ctx?.maxTicks != null ? `${ctx.ticksToday ?? "?"}/${ctx.maxTicks} ticks` : null;
      const cost =
        ctx?.costToday != null
          ? `$${ctx.costToday.toFixed(2)}${ctx.maxCostUSD != null ? `/$${ctx.maxCostUSD.toFixed(0)}` : ""}`
          : null;
      const used = [ticks, cost].filter(Boolean).join(" · ");
      return {
        kind: "stood-down",
        text: used
          ? `Parei por budget — já usei ${used} hoje. Zera na virada do dia.`
          : "Parei por budget — o teto do dia (ticks ou custo) acabou. Zera na virada do dia.",
      };
    }
    case "skipped-backoff":
      return {
        kind: "stood-down",
        text: ctx?.noopStreak
          ? `Segurei este ciclo — meus últimos ${ctx.noopStreak} ciclos gastaram sem mover o mesmo trabalho; espero o board mudar antes de gastar de novo.`
          : "Segurei este ciclo — minhas últimas tentativas não moveram nada; espero o board mudar antes de gastar de novo.",
      };
    case "skipped-leased": {
      // WS-4.3 — honest stand-down. Concreto: O QUE eu faria (quantos itens acionáveis esperam) e QUANDO volto
      // (ao soltar o painel). NÃO afirmo "há X min": o pairedLease só guarda o expiry (renovado a cada interação),
      // então "desde quando" não é derivável sem inventar. Se um ciclo iniciado ANTES ainda termina, nomeio isso
      // também (a contradição que o operador via era "fiquei de fora" enquanto um run agia).
      const n = ctx?.actionableCount ?? 0;
      const waiting = n > 0 ? `${n} ${n === 1 ? "item acionável" : "itens acionáveis"} esperando` : "nada acionável agora";
      const inFlight = ctx?.tickInFlight
        ? " Um ciclo autônomo iniciado ANTES ainda está terminando (acompanhe/cancele no chat)."
        : "";
      return {
        kind: "stood-down",
        text: `Fiquei de fora: você está no comando (painel pareado aberto) — ${waiting}; retomo quando você soltar o painel.${inFlight}`,
      };
    }
    case "skipped-running":
      return { kind: "stood-down", text: "Já estou rodando neste board — não abri um segundo Jido." };
    case "skipped-spawn-failed":
      return { kind: "error", text: "Não consegui iniciar: falta o token do orquestrador (AGILEHARNESS_MCP_TOKEN_ORCH) no serviço." };
    case "skipped-spawn-broken":
      // A mensagem NOMEIA o defeito e a causa. O antecessor deste estado dizia "parei por budget" — verdadeiro
      // no contador, falso na causa — e por isso 19 crashes seguidos passaram um dia inteiro sem investigação.
      return {
        kind: "error",
        text:
          `Parei de tentar: meus últimos ${ctx?.failureStreak ?? SPAWN_BREAKER_THRESHOLD} ciclos morreram no ` +
          `arranque, sem chegar a olhar o board` +
          (ctx?.failureReason ? ` (${ctx.failureReason})` : "") +
          `. Não é budget — é um defeito no meu spawn. Vou sondar de novo depois de um tempo; ` +
          `se você corrigir a causa, o primeiro ciclo que sobreviver me destrava.`,
      };
    case "error":
      return { kind: "error", text: "Erro no meu ciclo — não consegui avaliar o board." };
    case "skipped-not-autonomous":
      return null; // o board não é autônomo: não houve decisão a comunicar
  }
}

/**
 * Grava UMA decisão. Best-effort — nunca lança (um diário indisponível não pode derrubar o Jido).
 *
 * É AQUI que a regra "uma frase corrida, sem tabela e sem quebra de linha" é imposta — este é o ÚNICO
 * chokepoint de escrita do diário (os 5 escritores — guard, steward, orchestrator-run/-wake, noop-rearm —
 * passam todos por aqui), então a regra vale para quem já existe e para quem for escrito depois, sem depender
 * de cada autor lembrar dela. Impor no chamador seria impor em 5 lugares e esquecer no 6º.
 *
 * Nem todo texto é nosso: o `finished` carrega o `summary` do run, que é o texto FINAL do LLM — relatório com
 * `##`, `**`, bullets e tabelas. Não dá para "pedir por favor" a um LLM que ele nunca formate; dá para
 * normalizar de forma determinística na porta de entrada. As entradas que JÁ nascem corridas (tickOutcomeText)
 * passam intactas.
 */
export async function appendCopilotActivity(
  board: string,
  entry: Omit<CopilotActivityEntry, "id" | "at">,
  now = Date.now(),
): Promise<void> {
  try {
    const p = activityPath(board);
    await fs.mkdir(path.dirname(p), { recursive: true });
    const rec: CopilotActivityEntry = {
      id: `${now}-${Math.floor(performance.now() * 1000) % 1000}`,
      at: new Date(now).toISOString(),
      ...entry,
      text: diarySentence(entry.text),
      ...(entry.detail ? { detail: diarySentence(entry.detail) } : {}),
    };
    await fs.appendFile(p, `${JSON.stringify(rec)}\n`, "utf8");
    await pruneIfLarge(p);
  } catch {
    /* best-effort */
  }
}

/** Poda o diário quando ele passa do teto (mantém as MAX_KEEP mais recentes). */
async function pruneIfLarge(p: string): Promise<void> {
  try {
    const lines = (await fs.readFile(p, "utf8")).split("\n").filter(Boolean);
    if (lines.length <= MAX_KEEP * 1.5) return;
    await fs.writeFile(p, `${lines.slice(-MAX_KEEP).join("\n")}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}

/** As últimas `limit` decisões (mais antigas primeiro — a ordem em que o chat as mostra). Nunca lança. */
export async function readCopilotActivity(board: string, limit = 40): Promise<CopilotActivityEntry[]> {
  try {
    const raw = await fs.readFile(activityPath(board), "utf8");
    const out: CopilotActivityEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as CopilotActivityEntry;
        if (e && typeof e.id === "string" && typeof e.text === "string") out.push(e);
      } catch {
        /* linha corrompida (write parcial) — pula, não derruba o feed */
      }
    }
    return out.slice(-Math.max(1, limit));
  } catch {
    return [];
  }
}
