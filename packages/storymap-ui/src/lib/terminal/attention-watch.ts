// O VIGIA dos terminais — o ÚNICO amostrador de tela da casa.
//
// Ele responde, a qualquer momento e sem ninguém ter aberto uma página, à pergunta: "algum terminal
// está esperando o operador?". Três consumidores bebem da MESMA fonte:
//   1. os ALERTAS (som + notificação do sistema + push no celular) — o "me avise";
//   2. o BALÃO do Jido no topnav — ele passa a saber que um terminal seu travou;
//   3. o CONTEXTO do chat e o `claude_sessions` do MCP — o Jido consegue LER os terminais.
//
// POR QUE ELE É "ALWAYS-ON" (e o antecessor não era). Este módulo substitui o `idle-watch`, que só
// existia enquanto a página do terminal estava aberta e a armava por sessão. Isso resolvia o caso do
// celular com a aba fechada e NENHUM outro: um prompt parado num terminal que ninguém abriu era
// invisível para o sistema inteiro — inclusive para o Jido. Um vigia só serve se vigia sem plateia.
//
// UM POLLER, NÃO DOIS. Dois laços amostrando os MESMOS panes com duas noções de "quieto" é a dívida
// clássica: divergem no dia em que um dos dois muda. A "campainha" da página do terminal continua
// existindo, mas como uma PREFERÊNCIA deste vigia (`armQuietPush`), não como um segundo relógio.
//
// CUSTO. Por ciclo: 1 `tmux list-sessions` + 1 snapshot memoizado (5s) de panes/pidfiles + 1
// `capture-pane` por sessão vigiada (teto {@link MAX_WATCHED}). Com ~5 sessões e 6s de ciclo isso é
// ruído estatístico numa VPS — e o serviço já paga esse mesmo preço quando alguém abre /processes.
//
// SERVER-ONLY (tmux/child_process via os coletores). A REGRA fica em attention.ts (pura, testada);
// aqui só há IO, relógio e fan-out.

import { capturePane } from "./tmux";
import { loadPrefs, prunePrefs } from "./prefs-store";
import { listSessions } from "@/lib/vps/tmux";
import { classifyTmux, isAgentKind, operatorLabel } from "@/lib/vps/processes";
import { paneClaudeMap, type PaneResolution } from "@/lib/vps/pane-claude-map";
import { publishAgentAlert } from "@/lib/notifications/server/alert-bus";
import { ALERT_URGENCY, type AgentAlertKind } from "@/lib/notifications/event";
import {
  byAttentionUrgency,
  describeAttention,
  initialAttention,
  planWatchCycle,
  shouldAlert,
  stepAttention,
  type AttentionState,
  type TerminalAttention,
} from "./attention";

/** Intervalo entre amostras. Curto o bastante para o prompt não esfriar, longo para não pesar. */
const POLL_MS = Math.max(2_000, Number(process.env.AGILEHARNESS_TERMINAL_WATCH_SECONDS ?? 6) * 1_000);

/** Teto de sessões amostradas por ciclo — um `capture-pane` cada. Protege a máquina de uma máquina
 *  cheia de tmux: acima disso o vigia prefere as sessões com atividade mais RECENTE, e AVISA no log
 *  quantas ficaram de fora (um retrato incompleto se parece com "ninguém esperando"). */
const MAX_WATCHED = Math.max(1, Number(process.env.AGILEHARNESS_TERMINAL_WATCH_MAX ?? 12));

/** A campainha da página do terminal (o `idle` empurrado ao celular) vale enquanto a aba renova. */
const QUIET_PUSH_TTL_MS = 30 * 60_000;

interface WatchStore {
  /** estado da máquina por sessão tmux. */
  states: Map<string, AttentionState>;
  /** quem foi AMOSTRADO no último ciclo — não é o mesmo que "quem existe". Uma sessão empurrada para
   *  fora do teto {@link MAX_WATCHED} continua no `states` (com o `changedAt` de quando ainda a
   *  olhávamos), então o tempo desde ali seguiria crescendo sozinho e se pareceria com uma tela
   *  congelada. Quem responde "há quanto tempo esta tela não muda" só pode falar de quem acabou de
   *  olhar — ver {@link screenStillness}. */
  watchedNow: Set<string>;
  /** o retrato atual — o que os consumidores leem sem tocar em IO. */
  snapshot: TerminalAttention[];
  /** sessões cuja campainha o operador armou na página do terminal → epoch ms de expiração. */
  quietPush: Map<string, number>;
  /** assinantes do RETRATO (só notificados quando ele de fato muda). */
  listeners: Set<(snapshot: TerminalAttention[]) => void>;
  timer: ReturnType<typeof setInterval> | null;
  /** um ciclo ainda rodando — nunca sobrepor amostragens. */
  ticking: boolean;
  /** quantas sessões o teto deixou de fora no ciclo anterior — só para avisar na BORDA. */
  lastDropped: number;
}

// globalThis-pinned pelo mesmo motivo do resto do runner: bundles de rota diferentes veriam Maps
// diferentes, e aí haveria um vigia por bundle (alertas duplicados, retratos divergentes).
const KEY = Symbol.for("storymap.terminal.attentionWatch");
const store = globalThis as unknown as { [KEY]?: WatchStore };

function watch(): WatchStore {
  return (store[KEY] ??= {
    states: new Map(),
    watchedNow: new Set(),
    snapshot: [],
    quietPush: new Map(),
    listeners: new Set(),
    timer: null,
    ticking: false,
    lastDropped: 0,
  });
}

/**
 * Liga o vigia (idempotente). Chamado UMA vez no boot (instrumentation). Nunca segura o processo
 * vivo (`unref`) e nunca lança — um `tmux` ausente simplesmente devolve zero sessões para sempre.
 */
export function startTerminalAttentionWatch(): void {
  const w = watch();
  if (w.timer) return;
  w.timer = setInterval(() => void tick(), POLL_MS);
  w.timer.unref?.();
  void tick(); // o primeiro retrato não espera um ciclo inteiro
}

/** Desliga (testes / shutdown). */
export function stopTerminalAttentionWatch(): void {
  const w = watch();
  if (w.timer) clearInterval(w.timer);
  w.timer = null;
  w.states.clear();
  w.watchedNow.clear();
  w.snapshot = [];
}

/** O retrato ATUAL — já ordenado por urgência. Leitura pura de memória (zero IO): pode ser chamado
 *  por server action, rota MCP e SSE sem custo. */
export function currentTerminalAttention(): TerminalAttention[] {
  return watch().snapshot;
}

/**
 * Há quanto tempo (ms) a TELA de cada sessão vigiada não muda — a EVIDÊNCIA independente que corrobora
 * (ou desmente) o flag busy/idle que o CLI grava no pidfile. Leitura pura de memória, zero IO.
 *
 * Por que ela sai daqui e não de um amostrador novo: este vigia já hasheia todo pane a cada ciclo, e a
 * regra da casa é UM POLLER, NÃO DOIS (ver o cabeçalho). O medidor de /processes e da home passou a
 * beber deste mesmo relógio em vez de tentar julgar sozinho se um `status:"busy"` de 22 horas ainda
 * significa alguma coisa.
 *
 * Sessão AUSENTE do mapa = "não olhei" (vigia parado, sessão fora do teto {@link MAX_WATCHED}, ou o
 * primeiro ciclo ainda não estabeleceu a linha de base) — e quem consome trata ausência como ausência
 * de evidência, nunca como tela parada. Por isso as sessões sem `hash` ficam de fora: para elas
 * `changedAt` é só "quando comecei a olhar", que não é uma medida de imobilidade.
 */
export function screenStillness(now: number = Date.now()): Map<string, number> {
  const w = watch();
  const out = new Map<string, number>();
  for (const [name, st] of w.states) {
    if (st.hash === null || !w.watchedNow.has(name)) continue;
    // `producingAt`, não `changedAt`: um repaint (alguém abriu o terminal e o redimensionou) mudou a
    // tela sem que nada tenha sido produzido, e zerar o relógio por isso faria uma sessão dormente
    // parecer viva pelo simples fato de o operador estar olhando para ela.
    out.set(name, Math.max(0, now - st.producingAt));
  }
  return out;
}

/**
 * Assina o RETRATO. Chamado sempre que ele MUDA — o que inclui um terminal que DEIXOU de esperar, e
 * é por isso que a assinatura é do retrato e não da borda: o alerta (borda) avisa que algo começou;
 * o balão do Jido precisa saber também quando acabou, ou ele mente enquanto ninguém recarrega.
 * Notifica com o retrato atual na hora da assinatura (uma conexão nova já nasce com a verdade).
 */
export function onTerminalSnapshot(fn: (snapshot: TerminalAttention[]) => void): () => void {
  const w = watch();
  w.listeners.add(fn);
  startTerminalAttentionWatch();
  try {
    fn(w.snapshot);
  } catch {
    /* um assinante que explode na primeira entrega não impede a assinatura */
  }
  return () => w.listeners.delete(fn);
}

/**
 * A CAMPAINHA da página do terminal: "me empurre no celular quando ESTA sessão ficar quieta".
 *
 * Só governa o push do degrau `idle` — um terminal PARADO NUM PROMPT (`asking`) empurra sempre, para
 * qualquer sessão, porque ele trava trabalho de verdade. Idempotente: re-armar só estende o TTL, e um
 * TTL vencido some sozinho (aba fechada ⇒ a campainha para, sem unsubscribe para vazar).
 */
export function armQuietPush(session: string, opts?: { ttlMs?: number }): void {
  watch().quietPush.set(session, Date.now() + (opts?.ttlMs ?? QUIET_PUSH_TTL_MS));
  startTerminalAttentionWatch();
}

export function disarmQuietPush(session: string): void {
  watch().quietPush.delete(session);
}

/** Quais sessões têm a campainha armada AGORA (a rota ecoa isto; os testes conferem). */
export function armedQuietPush(): string[] {
  const now = Date.now();
  return [...watch().quietPush.entries()].filter(([, exp]) => exp > now).map(([s]) => s);
}

/** O claude que o pidfile do CLI atribui a este pane (ou null) — a prova de "é um agente". */
function claudeOf(pane: PaneResolution | undefined) {
  if (!pane) return null;
  return pane.ok ? pane.pane.claude : pane.claude;
}

/**
 * UM ciclo: lê as sessões, amostra as telas, atualiza a máquina de estado, publica o retrato e
 * dispara os alertas de borda. Best-effort de ponta a ponta — o vigia nunca derruba o serviço.
 */
async function tick(): Promise<void> {
  const w = watch();
  if (w.ticking) return; // um ciclo lento nunca se sobrepõe a si mesmo
  w.ticking = true;
  try {
    const now = Date.now();
    const [sessions, panes] = await Promise.all([
      listSessions().catch(() => []),
      paneClaudeMap(now).catch(() => new Map<string, PaneResolution>()),
    ]);

    // Quem entra no retrato quando há mais sessões que o teto (regra pura, testada).
    const { watched, dropped } = planWatchCycle(sessions, MAX_WATCHED);

    // O teto NÃO PODE SER SILENCIOSO: acima dele há sessões que este vigia simplesmente não olha, e
    // um retrato incompleto se parece com "ninguém esperando". Avisa na BORDA (quando o número de
    // deixadas de fora muda) — um log a cada 6s seria o mesmo silêncio, só que barulhento.
    if (dropped !== w.lastDropped) {
      w.lastDropped = dropped;
      if (dropped > 0) {
        console.warn(
          `[terminal-attention] ${sessions.length} sessões tmux e o teto é ${MAX_WATCHED}: ${dropped} fora do retrato ` +
            `(as de atividade mais antiga). Suba AGILEHARNESS_TERMINAL_WATCH_MAX se isso for o normal desta máquina.`,
        );
      }
    }

    // Sessão que SUMIU leva o estado dela junto — senão a memória do vigia cresce com o uptime.
    //
    // A régua é a lista INTEIRA de sessões, nunca a vigiada: uma sessão que caiu para fora do teto
    // continua EXISTINDO, e limpá-la por isso (a) apagava a campainha que o operador tinha armado nela,
    // sem nada dizer, e (b) zerava o `sawWork`, fazendo-a re-alertar "ficou quieto" ao voltar para o
    // topo. Cap é sobre QUANTO EU OLHO, não sobre o que existe.
    const alive = new Set(sessions.map((s) => s.name));
    for (const name of [...w.states.keys()]) if (!alive.has(name)) w.states.delete(name);
    for (const [name, exp] of [...w.quietPush.entries()]) if (exp <= now || !alive.has(name)) w.quietPush.delete(name);

    // Mesma regra, um degrau mais duradouro: o APELIDO que o operador deu a um terminal também não
    // sobrevive ao terminal. Este é o único laço da casa que conhece o conjunto vivo a todo momento —
    // a rota DELETE só cobre a morte pela app, e as outras (exit, kill-session, reboot) deixavam a
    // entrada órfã, que uma sessão futura de mesmo nome herdava. Best-effort e silencioso quando não há
    // o que podar; a poda em si é ruidosa de propósito (apagar um nome que o operador escolheu não pode
    // acontecer sem rastro).
    void prunePrefs([...alive])
      .then((dropped) => {
        if (dropped.length > 0) {
          console.info(`[terminal-attention] apelido(s) de sessão que não existe mais: ${dropped.join(", ")}`);
        }
      })
      .catch(() => {
        /* prefs são conveniência: uma poda que falhou tenta de novo no próximo ciclo */
      });

    const prefs = loadPrefs();
    const next: TerminalAttention[] = [];
    const edges: TerminalAttention[] = [];
    /** quem este ciclo REALMENTE olhou (a captura pode falhar) — ver WatchStore.watchedNow. */
    const sampled = new Set<string>();

    await Promise.all(
      watched.map(async (s) => {
        const text = await capturePane(s.name, 40);
        if (text === null) {
          w.states.delete(s.name); // sessão morreu entre a listagem e a captura
          return;
        }
        sampled.add(s.name);
        const cls = classifyTmux(s.name);
        const claude = claudeOf(panes.get(s.name));
        // "É um agente?" pela EVIDÊNCIA (o pidfile do próprio CLI aponta um claude neste pane), com o
        // nome da sessão e o comando em primeiro plano como reforço — um `shell` onde alguém subiu
        // claude na mão é um terminal de agente, e o nome dele não sabe disso.
        const agent = Boolean(claude) || isAgentKind(cls.kind) || s.command === "claude";
        const prev = w.states.get(s.name) ?? initialAttention(now);
        const { next: state, alert } = stepAttention(
          prev,
          {
            text,
            // A geometria separa PRODUÇÃO de REPAINT: quem abre o terminal o redimensiona, e sem isso
            // olhar para uma sessão dormente a fazia parecer viva (ver `producingAt` em attention.ts).
            geometry: s.geometry || undefined,
            busy: claude?.status ? claude.status.trim().toLowerCase() === "busy" : null,
            agent,
          },
          now,
        );
        w.states.set(s.name, state);
        if (!state.kind) return;

        const item: TerminalAttention = {
          session: s.name,
          label: operatorLabel(cls.label, s.name, prefs),
          kind: state.kind,
          since: state.since,
          agent,
          ...(state.question ? { question: state.question } : {}),
          // A FORMA do prompt viaja junto: é o que o aviso diz quando a pergunta não deu para ler.
          ...(state.shape ? { shape: state.shape } : {}),
        };
        next.push(item);
        if (alert) edges.push(item);
      }),
    );
    w.watchedNow = sampled;

    const sorted = next.sort(byAttentionUrgency);
    const changed = snapshotSig(sorted) !== snapshotSig(w.snapshot);
    w.snapshot = sorted;
    for (const item of edges) announce(item, now);
    // Só re-emite quando o retrato de fato mudou: um SSE recebendo a mesma lista a cada 6s seria um
    // heartbeat disfarçado de dado, e o React re-renderizaria a barra inteira por nada.
    if (changed) {
      for (const fn of [...w.listeners]) {
        try {
          fn(sorted);
        } catch {
          /* um assinante que explode não derruba o vigia */
        }
      }
    }
  } catch (err) {
    console.error("[terminal-attention] ciclo falhou:", err instanceof Error ? err.message : err);
  } finally {
    w.ticking = false;
  }
}

/** A identidade do retrato: quem está esperando, como, e desde quando. Muda ⇔ há notícia. */
function snapshotSig(list: readonly TerminalAttention[]): string {
  return list.map((t) => `${t.session}:${t.kind}:${t.since}`).join("|");
}

/**
 * Publica UMA borda: o alerta no barramento (som/notificação/push).
 *
 * SABER ≠ INTERROMPER, e a linha entre os dois passa AQUI. O retrato (`currentTerminalAttention`)
 * inclui todo mundo que espera — é ele que alimenta a fala do Jido, o `claude_sessions` e o contexto
 * do chat, e conhecimento amplo não custa atenção a ninguém. O ALERTA é outra coisa: ele tira o
 * operador de onde ele está.
 *
 *   • `asking` — trava trabalho ⇒ alerta e empurra SEMPRE, em qualquer sessão. É a capacidade nova.
 *   • `quiet`  — cortesia ⇒ alerta e empurra SÓ na sessão em que o operador armou a campainha.
 *
 * A segunda regra conserta uma REGRESSÃO que eu tinha introduzido: o antecessor (`idle-watch`) só
 * observava sessões armadas, então "ficou quieto" avisava no máximo pelas que você pediu. Ao passar a
 * observar TODAS, o aviso passou junto — com som ligado, cada fim de turno de cada agente da máquina
 * viraria um bipe. Ampliar a VISÃO era o objetivo; ampliar a INTERRUPÇÃO não era, e ninguém pediu.
 *
 * A `tag` repete a do antecessor (`terminal:<sessão>`) para o SO COLAPSAR duas notificações da mesma
 * sessão em uma.
 */
function announce(item: TerminalAttention, now: number): void {
  // A régua é pura e testada (shouldAlert): cortesia sem campainha fica no retrato e não interrompe.
  if (!shouldAlert(item.kind, armedQuietPush().includes(item.session))) return;
  const { title, body } = describeAttention(item, now);
  const kind: AgentAlertKind = item.kind === "asking" ? "terminal-waiting" : "terminal-quiet";
  publishAgentAlert({
    id: `term:${item.session}:${item.since}`,
    kind,
    urgency: ALERT_URGENCY[kind],
    at: now,
    title,
    body,
    tag: `terminal:${item.session}`,
    url: `/terminal?b=${encodeURIComponent(item.session)}`,
    // Chegar aqui já significa "merece interromper" (ver o guard acima), então os dois casos empurram.
    push: true,
  });
}
