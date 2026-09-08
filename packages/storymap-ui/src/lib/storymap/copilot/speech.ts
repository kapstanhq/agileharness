// A FALA do Jido — o que o mascote DIZ no topnav, em primeira pessoa.
//
// Por que existe: com o mascote fora do chat e morando no topnav, o estado dele deixou de ter uma linha viva
// ao lado ("dormindo · acme"). Um mascote mudo no canto da barra não conta nada — então ele FALA: um balão
// aparece por alguns segundos quando algo acontece, e no hover para quem quiser conferir.
//
// PURO (sem React, sem IO, sem relógio próprio) → testável, e a regra de produto ("o que ele diz e quando")
// fica num lugar só. O componente que pinta o balão não decide nada: ele recebe {line, note, key, tone}.
//
// ── A REGRA QUE ESTE MÓDULO GANHOU (e o defeito que ela conserta) ─────────────────────────────────
//
// A versão anterior copiava, LITERALMENTE, a última entrada do diário para dentro do balão — enquanto o
// próprio balão listava as entradas seguintes logo abaixo. Com o tick disciplinado (que decide não agir a
// cada ciclo), o resultado medido na tela foi um balão dizendo "Olhei o board: nada acionável para mim
// agora (…)" com as MESMAS três frases repetidas embaixo. Três defeitos, um sintoma:
//
//   1. o balão falava a última entrada, e a última entrada quase sempre é RUÍDO (o tick olhando o board);
//   2. o balão repetia a entrada que o histórico já mostrava (a mesma informação, duas vezes, adjacentes);
//   3. nada ali era STATUS: nem o que ele acabou de fazer, nem o que está te esperando agora.
//
// A régua nova, em ordem de prioridade — o balão responde "o que eu preciso saber AGORA?":
//
//   1. o HUMOR urgente (ele parou e pede confirmação, quebrou, está instável) — o que ele SENTE agora;
//   2. um TERMINAL SEU parado num prompt — trava trabalho, e nada no board é mais urgente que isso;
//   3. ele está OCUPADO (respondendo, rodando, agindo sozinho) — fala do próprio trabalho em voo;
//   4. em repouso, o RECAP: a última coisa que ele DE FATO fez — pulando as N linhas de "olhei e não havia
//      nada", que são exatamente o que enchia o balão de nada;
//   5. sem nada disso, ele fala do próprio estado.
//
// E a NOTA (a segunda linha do balão, que antes nascia sempre vazia) carrega os NÚMEROS: há quanto tempo foi
// aquilo, quantos ciclos passaram sem trabalho, quantos itens esperam você, quantos terminais estão quietos.
// Frase em cima, medidores embaixo — em vez de uma frase de log servindo às duas funções e não cumprindo
// nenhuma.
//
// ANTI-REPETIÇÃO POR CONSTRUÇÃO: quando a fala nasce do diário, ela devolve `sourceId`, e o histórico do
// hover REMOVE essa entrada da lista (BoardHeader) — o balão e o histórico não podem mostrar a mesma coisa
// nem por acidente. Repetições consecutivas idênticas no histórico colapsam numa linha (`groupActivity`).

import { EXPRESSIONS, isUrgentMood, type MoodId, type MoodTone } from "@/lib/storymap/copilot/face";
import type { CopilotActivityEntry } from "@/lib/storymap/copilot/activity";
import { diarySentence, summarizeEntry, tierOf } from "@/lib/storymap/copilot/activity-view";
import { promptAsk, waitedFor, type TerminalAttention } from "@/lib/terminal/attention";

/** O que o balão mostra. */
export interface CopilotSpeech {
  /** o que ele diz, em 1ª pessoa (uma frase curta). */
  readonly line: string;
  /** o rodapé: os NÚMEROS do momento (há quanto tempo, quantos esperam, quantos ciclos vazios). */
  readonly note?: string;
  /** identidade da fala: mudou ⇒ é fala NOVA (o balão aparece sozinho). */
  readonly key: string;
  /** o tom do estado — o ponto do balão o pinta (mesma porta de cor do resto do painel). */
  readonly tone: MoodTone;
  /** pede atenção (o balão fica mais tempo na tela). */
  readonly urgent: boolean;
  /** a entrada do diário que virou fala, quando houve uma. O histórico do hover a EXCLUI. */
  readonly sourceId?: string;
}

/** O teto de caracteres de uma fala — um balão no topnav é uma frase, não um parágrafo. */
const SPEECH_MAX_CHARS = 140;
/** O teto da nota — ela é uma tira de medidores, não uma segunda frase. */
const NOTE_MAX_CHARS = 80;

/**
 * Quanto tempo o balão fica na tela sozinho. Propriedade do BALÃO, não de quem o preenche — por isso
 * mora aqui e tem DOIS leitores: o `useSpeechCue` (a fala de estado) e o anúncio de notícias
 * (`copilot/announce`). Cada um tinha a sua cópia dos mesmos dois números; duas cópias do mesmo tempo
 * é a dívida que aparece no dia em que alguém ajusta uma e a outra fica para trás — e aí a mesma
 * superfície passa a durar dois tempos diferentes conforme o que a encheu.
 */
export const BUBBLE_DWELL_MS = 5_500;
/** O que pede atenção fica mais — mas nada fica para sempre. */
export const BUBBLE_DWELL_URGENT_MS = 9_000;

/**
 * O que cada humor DIZ. É o par falado do `short` de EXPRESSIONS (que é rótulo de estado, não fala): o topnav
 * mostrava "dormindo" e agora ele diz "Estou dormindo — me acorde quando precisar". Exaustivo por MoodId.
 */
const MOOD_LINE: Record<MoodId, string> = {
  feliz: "Tudo tranquilo por aqui.",
  piscando: "Prontinho — é só falar comigo.",
  falando: "Estou te respondendo…",
  pensativo: "Estou pensando…",
  codigo: "Estou trabalhando nisso…",
  surpreso: "Preciso de você para seguir.",
  panico: "Isso é irreversível — só sigo com a sua confirmação.",
  erro: "Deu erro do meu lado.",
  glitch: "A conexão está instável — estou tentando de novo.",
  conectado: "Estou agindo sozinho no board.",
  amoroso: "Feito!",
  triste: "A conversa está pesada — vale compactar.",
  dormindo: "Estou dormindo — me acorde quando precisar.",
};

/** Os humores em que ele está OCUPADO agora — falam por si, e o recap espera a vez. */
const BUSY_MOODS = new Set<MoodId>(["falando", "pensativo", "codigo", "conectado"]);

export interface CopilotSpeechInput {
  /** o humor já derivado (`deriveMood`) — a mesma fonte que desenha o rosto. */
  mood: MoodId;
  /** o diário do tick autônomo, MAIS NOVO PRIMEIRO. */
  activity?: readonly CopilotActivityEntry[];
  /** os terminais que esperam o operador AGORA (vigia de terminais). */
  terminals?: readonly TerminalAttention[];
  /** quantos itens do Inbox precisam de você. `null`/ausente = não sei (e aí não se afirma nada). */
  needsYou?: number | null;
  /** o relógio, injetado (mantém a função pura e o teste determinístico). */
  now?: number;
}

/** O que o Jido está dizendo AGORA. PURA. */
export function copilotSpeech(input: CopilotSpeechInput): CopilotSpeech {
  const { mood, needsYou } = input;
  const now = input.now ?? Date.now();
  const activity = input.activity ?? [];
  const terminals = input.terminals ?? [];
  const asking = terminals.filter((t) => t.kind === "asking");
  const quiet = terminals.filter((t) => t.kind === "idle");

  // O RECAP: a última coisa que ele DE FATO fez. As entradas de tier `idle` (acordei / agendei / fiquei
  // de fora) são o batimento cardíaco do tick, não trabalho — elas viram CONTAGEM na nota, nunca a fala.
  const recap = activity.find((e) => tierOf(e.kind) !== "idle") ?? null;
  const quietCycles = countLeadingIdle(activity);

  const note = buildNote({
    recapAt: recap ? Date.parse(recap.at) : null,
    quietCycles,
    needsYou: needsYou ?? null,
    quietTerminals: quiet.length,
    now,
  });

  // 1. O que ele SENTE, quando é urgente — uma aprovação irreversível parada ganha de tudo. O terminal
  //    esperando não some: ele desce para a nota (nada de perder um bloqueio por causa de outro).
  if (isUrgentMood(mood)) {
    return {
      line: MOOD_LINE[mood],
      note: joinNote(asking.length ? terminalNote(asking) : null, note),
      key: `mood:${mood}`,
      tone: EXPRESSIONS[mood].tone,
      urgent: true,
    };
  }

  // 2. Um TERMINAL SEU está parado num prompt. Nada anda até você responder — inclusive o trabalho que
  //    ele mesmo esperaria daquela sessão. É a única coisa que fala mais alto que o estado dele.
  if (asking.length > 0) {
    return {
      line: summarizeEntry(terminalLine(asking, now), SPEECH_MAX_CHARS),
      note,
      // A identidade é (sessão, desde quando): o MESMO terminal esperando não re-abre o balão a cada
      // poll, mas um prompt novo — ou um segundo terminal — sim.
      key: `term:${asking.map((t) => `${t.session}@${t.since}`).join(",")}`,
      tone: "warn",
      urgent: true,
    };
  }

  // 3. O RECAP: a última coisa que ele DE FATO fez. Um recap que PEDE ALGO (`attention`/`error`) fala
  //    mesmo com ele ocupado — é o "preciso de você" do tick, e segurá-lo até o trabalho acabar seria
  //    esconder um bloqueio atrás de um progresso. O recap de rotina, esse sim, espera a vez.
  if (recap) {
    const tier = tierOf(recap.kind);
    const loud = tier === "attention" || tier === "error";
    if (loud || !BUSY_MOODS.has(mood)) {
      return {
        line: summarizeEntry(diarySentence(recap.text), SPEECH_MAX_CHARS),
        note,
        key: `act:${recap.id}`,
        tone: tier === "error" ? "danger" : tier === "attention" ? "warn" : EXPRESSIONS[mood].tone,
        urgent: loud,
        sourceId: recap.id,
      };
    }
  }

  // 4. Ocupado agora, ou nada aconteceu ainda (só ciclos vazios): ele fala do próprio estado. A nota
  //    conta os ciclos — a informação honesta de um board parado, e a que o balão antes não dava.
  return { line: MOOD_LINE[mood], note, key: `mood:${mood}`, tone: EXPRESSIONS[mood].tone, urgent: false };
}

/** Quantas entradas de RUÍDO (tier idle) vieram antes da última ação real — os "ciclos sem trabalho". */
function countLeadingIdle(activity: readonly CopilotActivityEntry[]): number {
  let n = 0;
  for (const e of activity) {
    if (tierOf(e.kind) !== "idle") break;
    n++;
  }
  return n;
}

/** A FALA sobre terminais esperando — nomeia o terminal (1) ou conta e nomeia os dois primeiros (N). */
function terminalLine(asking: readonly TerminalAttention[], now: number): string {
  const [first, second] = asking;
  if (asking.length === 1) {
    // Com a pergunta legível, ela; sem ela, a FORMA do prompt (o que ele está pedindo). Nunca nada:
    // "um terminal está esperando" sem dizer o quê obriga o operador a ir olhar para descobrir.
    const q = first.question ? `“${first.question}”` : promptAsk(first.shape).toLowerCase();
    return `O terminal “${first.label}” está esperando você há ${waitedFor(first.since, now)} — ${q}.`;
  }
  const rest = asking.length - 2;
  const names = [first, second].map((t) => `“${t.label}”`).join(" e ");
  return `${asking.length} terminais estão esperando você: ${names}${rest > 0 ? ` e mais ${rest}` : ""}.`;
}

/** A versão CURTA do mesmo fato, para quando a linha já foi tomada por algo mais urgente. */
function terminalNote(asking: readonly TerminalAttention[]): string {
  return asking.length === 1 ? "1 terminal esperando você" : `${asking.length} terminais esperando você`;
}

/**
 * A NOTA: os medidores do momento, na ordem em que o operador os procura — quando foi, quanto tempo de
 * silêncio, quem espera. Cada pedaço só aparece quando ele DIZ algo (um "0 itens" ao lado de "0 ciclos" é
 * mobília, não informação).
 */
function buildNote(input: {
  recapAt: number | null;
  quietCycles: number;
  needsYou: number | null;
  quietTerminals: number;
  now: number;
}): string | undefined {
  const parts: string[] = [];
  if (input.recapAt && Number.isFinite(input.recapAt)) parts.push(`há ${waitedFor(input.recapAt, input.now)}`);
  // 1 ciclo vazio é o normal de um board em dia; a partir de 2 vira informação ("faz tempo que não há o
  // que fazer" — ou "algo está preso e ele não está pegando").
  if (input.quietCycles >= 2) parts.push(`${input.quietCycles} ciclos sem trabalho`);
  if (input.needsYou && input.needsYou > 0) {
    parts.push(`${input.needsYou} ${input.needsYou === 1 ? "item espera" : "itens esperam"} você`);
  }
  if (input.quietTerminals > 0) {
    parts.push(`${input.quietTerminals} ${input.quietTerminals === 1 ? "terminal quieto" : "terminais quietos"}`);
  }
  if (parts.length === 0) return undefined;
  return summarizeEntry(parts.join(" · "), NOTE_MAX_CHARS);
}

function joinNote(a: string | null, b: string | undefined): string | undefined {
  const parts = [a, b].filter((p): p is string => Boolean(p));
  return parts.length ? summarizeEntry(parts.join(" · "), NOTE_MAX_CHARS) : undefined;
}
