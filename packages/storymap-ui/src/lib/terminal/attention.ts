// "Este terminal está esperando VOCÊ?" — a régua, pura.
//
// O PROBLEMA. O painel de Terminais sabia dizer `AGUARDANDO`, mas `aguardando` ali significa apenas
// "o flag busy/idle do CLI não está em busy" (service-meters.ts `deriveWorkState`) — o mesmo rótulo
// para uma sessão que ACABOU de te fazer uma pergunta e para uma que dorme há 8 horas. Um rótulo que
// vale para tudo não avisa nada: o operador só descobria o prompt parado quando ia olhar. E o Jido,
// que só enxerga o board (cockpit + demandas de card), era cego a essa superfície inteira.
//
// O QUE ESTE MÓDULO DECIDE, e com que evidência (nada aqui é palpite sobre o futuro do CLI):
//
//   • `asking` — a TELA está parada num PROMPT: uma lista de opções com o cursor (`❯ 1. Sim`), um
//     `[y/N]`, um `Password:`, um "Deseja prosseguir?". É o estado que TRAVA trabalho: ninguém anda
//     até você responder. Evidência: o desenho do prompt + a tela CONGELADA por alguns segundos.
//   • `idle`  — um terminal de AGENTE que produziu saída e depois ficou quieto além do limiar. É o
//     "acabou (ou espera sua próxima instrução)". Evidência: estabilidade + ter trabalhado antes.
//   • `null`  — trabalhando, ou não dá para afirmar. NUNCA se inventa um estado por ausência de dado.
//
// POR QUE A ESTABILIDADE DA TELA, E NÃO O FLAG DO CLI. O flag (`pidfile.status`) descreve o TURNO, não
// quem está bloqueado: um prompt de permissão acontece NO MEIO do turno, então o CLI segue `busy`
// enquanto a bola está com você. Ler o flag como "não está esperando" perderia exatamente o caso mais
// importante. Por isso `asking` VENCE o flag, e o flag só é usado onde ele é confiável: para NÃO
// declarar `idle` num pane que o CLI diz estar trabalhando.
//
// AGNÓSTICO POR CONSTRUÇÃO (regra do AgileHarness: a ferramenta é genérica). O detector reconhece
// FORMAS de prompt — cursor de opção, sim/não, senha, "pressione enter" —, não "o Claude Code". Um
// `apt` pedindo confirmação ou um `ssh` pedindo passphrase acendem pelo mesmo caminho.
//
// PURO e ISOMÓRFICO (zero `node:*`): o cliente importa os tipos e as frases; quem lê a tela é o
// watcher (attention-watch.ts). Testado em attention.test.ts.

/** O que o terminal está esperando. Dois degraus, do mais bloqueante para o mais frouxo. */
export type TerminalAttentionKind = "asking" | "idle";

/**
 * Que FORMA de prompt casou.
 *
 * Ela ERA só telemetria ("nunca vira texto de tela"). Passou a ser texto — e é uma promoção honesta:
 * a forma vem da ESTRUTURA que o detector reconheceu, não de um pedaço de tela copiado. Desde que a
 * leitura da pergunta ficou (corretamente) mais exigente, "sem pergunta legível" ficou comum, e a
 * frase genérica que sobrava não distinguia um menu de uma SENHA — coisas com urgências bem
 * diferentes para quem recebe o aviso no celular. Ver `promptAsk`.
 */
export type PromptShape = "options" | "confirm" | "yesno" | "secret" | "enter";

export interface PanePrompt {
  shape: PromptShape;
  /** a pergunta, já limpa da moldura — vazia quando a forma não carrega uma (ex.: `Password:`). */
  question: string;
}

/** Um terminal que está esperando o operador AGORA. É o item que a UI/o Jido/os alertas consomem. */
export interface TerminalAttention {
  /** nome da sessão tmux — a identidade estável (é por ela que se abre `/terminal?b=`). */
  session: string;
  /** o nome que o operador deu/vê (alias ou rótulo derivado). */
  label: string;
  kind: TerminalAttentionKind;
  /** epoch ms desde quando ele está assim. */
  since: number;
  /** um agente Claude dirige este terminal (vs. um shell puro)? */
  agent: boolean;
  /** a pergunta lida da tela, quando deu para ler (só `asking`). */
  question?: string;
  /** a FORMA do prompt que está na tela (só `asking`) — o que dizer quando a pergunta não deu para ler. */
  shape?: PromptShape;
}

/** Quanto tempo a tela precisa ficar PARADA antes de cada veredito. */
export interface AttentionSettle {
  /** prompt desenhado: rápido — a moldura leva ~1 quadro para terminar de pintar. */
  askMs: number;
  /** silêncio de agente: lento — entre dois turnos há pausas normais que não são "acabou". */
  idleMs: number;
  /** tela parada além disto ⇒ o flag busy/idle do CLI deixa de valer (ver {@link cliFlagIsStale}). */
  staleFlagMs: number;
  /** transcript sem UMA escrita há mais que isto ⇒ não há turno em voo (ver {@link cliFlagExpired}). */
  transcriptIdleMs: number;
  /** flag `busy` gravado há mais que isto ⇒ velho demais para um turno plausível. */
  flagBusyAgeMs: number;
}

/**
 * Os limiares padrão. `idleMs` herda os 25s do watcher de "ficou quieto" que este módulo substituiu —
 * número já calibrado em uso real (abaixo disso, uma pausa entre ferramentas virava "terminou").
 *
 * `staleFlagMs` é 90s por MEDIÇÃO, não por gosto: amostrando os panes desta máquina de 6 em 6 segundos,
 * a sessão que de fato trabalhava mudou de hash em TODOS os ciclos (o rodapé do CLI conta os segundos
 * decorridos, então a tela nunca fica parada durante um turno), enquanto as parqueadas ficaram
 * byte-idênticas por horas. 90s é ~15 ciclos de folga sobre o único caso plausível de tela parada com
 * trabalho em voo — uma ferramenta longa que não imprime nada —, e ainda assim 3 ordens de grandeza
 * abaixo das 22h de latch que motivaram esta régua.
 *
 * `transcriptIdleMs`/`flagBusyAgeMs` são o SEGUNDO limbo (ver {@link cliFlagExpired}), e vieram de uma
 * medição que mostrou a tela sendo uma testemunha mais fraca do que este arquivo supunha (2026-07-31):
 * a sessão `meu-monorepo-c2` carregava `busy` havia 42,6h com um JOB EM BACKGROUND dentro, cujo
 * rodapé ("Burrowing… (9m 56s)") repinta a cada segundo — a tela NUNCA ficava parada 90s, o flag nunca
 * vencia, e a home anunciava "trabalhando" para um composer parado. 10 min de transcript mudo é ~2
 * ordens de grandeza acima do intervalo entre registros de um turno vivo (um turno escreve a cada
 * ferramenta), e os 30 min de flag protegem o único falso positivo plausível: um turno legítimo preso
 * numa ferramenta longa e silenciosa carrega um flag JOVEM, e por isso não é demovido.
 */
export const ATTENTION_SETTLE: AttentionSettle = {
  askMs: 6_000,
  idleMs: 25_000,
  staleFlagMs: 90_000,
  transcriptIdleMs: 10 * 60_000,
  flagBusyAgeMs: 30 * 60_000,
};

/**
 * O flag do CLI já passou da validade? PURA — a régua de UMA CASA para "esta afirmação ainda vale".
 *
 * O PORQUÊ. `pidfile.status` (busy/idle) é a melhor fonte que existe para "o que este agente está
 * fazendo", e por isso todo mundo aqui a usa. Mas ela é um LATCH, não um sinal vivo: o CLI escreve o
 * arquivo na TRANSIÇÃO e mais nunca. Medido em produção (2026-07-30): uma sessão que despachou um job
 * em background e parqueou ficou com `status:"busy"` gravado havia **21,9 horas**, com a tela congelada
 * num composer vazio depois de um `/clear` — e a interface a anunciava como "trabalhando", no topo da
 * lista e com o card aberto. É o MESMO erro do ponto verde que o medidor existe para corrigir
 * (`status === "running"` provava só que o processo existia), uma camada abaixo: um flag cuja única
 * prova é que alguém um dia o escreveu.
 *
 * A correção não é desconfiar do flag — é EXIGIR CORROBORAÇÃO da única testemunha independente que já
 * temos de graça: a TELA. Um agente em turno mexe o pane; um parqueado não mexe. Enquanto a tela
 * corrobora, o flag manda; quando ela contradiz, o flag vira "não sei" — nunca vira o estado oposto
 * (inventar "ocioso" por ausência de dado seria repetir o erro na direção contrária).
 *
 * `screenStillMs == null` = ninguém olhou a tela desta sessão (vigia desligado, sessão fora do teto,
 * serviço recém-subido). Sem evidência não há demoção: o flag continua valendo, como antes.
 */
export function cliFlagIsStale(
  screenStillMs: number | null | undefined,
  settle: AttentionSettle = ATTENTION_SETTLE,
): boolean {
  return screenStillMs != null && screenStillMs >= settle.staleFlagMs;
}

/** O que se sabe, agora, sobre a validade do flag desta sessão. Todo campo é opcional e `null`
 *  significa "não olhei" — nunca "está parado". */
export interface FlagEvidence {
  /** ms desde a última mudança na TELA do pane (vigia). */
  screenStillMs?: number | null;
  /** ms desde a última ESCRITA no transcript da sessão (mtime do arquivo). */
  transcriptIdleMs?: number | null;
  /** ms desde que o CLI gravou o flag atual (`pidfile.statusUpdatedAt`). */
  flagAgeMs?: number | null;
}

/**
 * O flag do CLI venceu? PURA — a régua COMPLETA, e a única que os medidores devem chamar.
 *
 * {@link cliFlagIsStale} continua sendo a testemunha da TELA, e sozinha ela não bastava: a tela prova
 * que ALGO se mexeu, não que há um turno em voo. Qualquer repaint a satisfaz — o rodapé de um job em
 * background contando segundos, o operador digitando no composer, um `tail -f` na mesma janela. Foi
 * exatamente assim que um `busy` de 42,6h continuou passando por trabalho (ver ATTENTION_SETTLE).
 *
 * A segunda testemunha é o TRANSCRIPT, e ela é imune a repaint: um turno vivo escreve nele a cada
 * ferramenta e a cada resposta; um composer parado não escreve nada, por mais que a tela pisque.
 * Medido no mesmo instante que a sessão acima: a que estava em turno tinha mtime de segundos atrás; a
 * parada, de 31 minutos; o job que de fato trabalhava, de 49s.
 *
 * As duas exigências do segundo limbo andam JUNTAS (E, não OU) de propósito. `transcriptIdleMs`
 * sozinho condenaria um turno legítimo presa numa ferramenta longa e silenciosa (um build de 15 min);
 * exigir também um flag ANTIGO (`flagBusyAgeMs`) desarma esse caso, porque o flag de um turno assim é
 * tão novo quanto o turno. Um `busy` de 30+ minutos com o transcript mudo há 10+ não é um turno lento:
 * é um latch.
 *
 * Sem evidência não há demoção — a assimetria de sempre. Ausência de dado nunca vira o estado oposto.
 */
export function cliFlagExpired(ev: FlagEvidence, settle: AttentionSettle = ATTENTION_SETTLE): boolean {
  if (cliFlagIsStale(ev.screenStillMs, settle)) return true;
  const idle = ev.transcriptIdleMs;
  const age = ev.flagAgeMs;
  if (idle == null || age == null) return false;
  return idle >= settle.transcriptIdleMs && age >= settle.flagBusyAgeMs;
}

/** O estado por sessão que o watcher carrega entre amostras. Opaco para quem consome. */
export interface AttentionState {
  /** hash da última amostra; null até a primeira estabelecer a linha de base. */
  hash: string | null;
  /** geometria do pane na última amostra (`"120x30"`), ou null se o coletor não a informou. */
  geometry: string | null;
  /** epoch ms da última amostra cujo hash DIFERIU da anterior. */
  changedAt: number;
  /**
   * epoch ms da última mudança de tela que foi PRODUÇÃO — quer dizer, que não veio junto com uma
   * mudança de geometria.
   *
   * A distinção não é sutileza: anexar-se a um terminal o redimensiona, o programa de tela cheia
   * recebe SIGWINCH e repinta tudo. A tela muda sem que nada tenha sido produzido — e quem lesse
   * isso como trabalho concluiria que a sessão está viva **porque alguém olhou para ela**. Era
   * exatamente o que acontecia: abrir um terminal dormente o reprotegia do encerrar por 90s, na
   * própria tela onde o operador foi encerrá-lo.
   */
  producingAt: number;
  /** a tela mexeu ao menos uma vez desde que começamos a olhar — sem isto, uma sessão parada há horas
   *  seria anunciada como "acabou agora" no primeiro ciclo do watcher. */
  sawWork: boolean;
  /** o veredito atual (null = não está esperando). */
  kind: TerminalAttentionKind | null;
  /** epoch ms em que o veredito ATUAL começou. */
  since: number;
  /** a pergunta do veredito `asking`, quando houver. */
  question?: string;
  /** a forma do prompt do veredito `asking` — anda junto da pergunta (sobrevive ao período de acomodação). */
  shape?: PromptShape;
}

/**
 * O estado inicial de uma sessão que o watcher acabou de ver.
 *
 * `sawWork: false` cria uma ASSIMETRIA proposital depois de um restart do serviço (que zera tudo):
 * um pane parado num PROMPT volta a ser anunciado — ele está esperando você AGORA, é um fato presente
 * na tela —, enquanto um pane apenas quieto NÃO é: "ficou quieto" é uma TRANSIÇÃO, e nós não a vimos
 * acontecer. Sem isso, todo restart anunciaria "acabou!" para cada sessão adormecida da máquina.
 * Não "conserte" essa assimetria: ela é a diferença entre observar um estado e presumir um evento.
 */
export function initialAttention(now: number): AttentionState {
  return { hash: null, geometry: null, changedAt: now, producingAt: now, sawWork: false, kind: null, since: now };
}

export interface AttentionSample {
  /** o texto da tela (tail do `capture-pane`). */
  text: string;
  /** geometria do pane (`"120x30"`) — omitir desliga a distinção repaint×produção (ver `producingAt`). */
  geometry?: string;
  /** o flag PRÓPRIO do CLI (pidfile) — `true` = turno em voo. `null` = não sabemos (shell puro). */
  busy: boolean | null;
  /** um agente dirige este terminal? Só agente pode ser declarado `idle` (um shell ocioso é o normal). */
  agent: boolean;
}

/**
 * UMA amostra → o próximo estado + se isto merece um ALERTA agora.
 *
 * `alert` é uma BORDA, nunca um nível: dispara quando o terminal ENTRA em espera (null → asking/idle)
 * ou quando ESCALA (idle → asking, "estava só quieto, agora te perguntou"). Voltar de `asking` para
 * `idle` não alerta — é alívio, não notícia. Sem isto, um terminal parado à noite tocaria o alarme a
 * cada 8 segundos até de manhã.
 *
 * PURA e determinística (o relógio e a leitura de tela entram por parâmetro).
 */
export function stepAttention(
  prev: AttentionState,
  sample: AttentionSample,
  now: number,
  settle: AttentionSettle = ATTENTION_SETTLE,
): { next: AttentionState; alert: TerminalAttentionKind | null } {
  const hash = hashPane(sample.text);
  const geometry = sample.geometry ?? prev.geometry;
  // REPAINT: a tela mudou E o pane mudou de tamanho ⇒ foi o SIGWINCH de quem se anexou, não produção.
  const repaint = sample.geometry != null && prev.geometry != null && sample.geometry !== prev.geometry;

  // 1. Primeira amostra: só estabelece o que "não mudou" quer dizer. Nunca é veredito.
  if (prev.hash === null) {
    return { next: { ...prev, hash, geometry, changedAt: now, producingAt: now, since: now }, alert: null };
  }

  // 2. A tela mexeu. Zera o relógio da estabilidade e derruba qualquer veredito — mas só conta como
  //    PRODUÇÃO (e como "já vi trabalhar") quando não foi um repaint: olhar para um terminal não pode
  //    ser o que prova que ele está vivo.
  if (hash !== prev.hash) {
    return {
      next: {
        hash,
        geometry,
        changedAt: now,
        producingAt: repaint ? prev.producingAt : now,
        sawWork: repaint ? prev.sawWork : true,
        kind: null,
        since: now,
      },
      alert: null,
    };
  }

  // 3. Tela PARADA. Quanto tempo faz?
  const stableFor = now - prev.changedAt;
  // O relógio que decide se o flag do CLI ainda vale é o da PRODUÇÃO, não o da última pintura.
  const producingFor = now - prev.producingAt;
  const prompt = detectPanePrompt(sample.text);

  let kind: TerminalAttentionKind | null;
  let question: string | undefined;
  let shape: PromptShape | undefined;
  if (prompt && stableFor >= settle.askMs) {
    // O prompt VENCE o flag do CLI de propósito — ver o cabeçalho (uma permissão acontece no meio do
    // turno, com o CLI ainda `busy`, e é justamente o caso que mais importa).
    kind = "asking";
    question = prompt.question || undefined;
    shape = prompt.shape;
  } else if (sample.busy === true && !cliFlagIsStale(producingFor, settle)) {
    // O CLI diz que está trabalhando e não há prompt: não afirmamos espera nenhuma.
    //
    // O veto EXPIRA (ver cliFlagIsStale). Sem isso, uma sessão cujo flag latchou em `busy` ficava
    // CEGA para este vigia para sempre — por mais horas que a tela ficasse congelada ela nunca
    // chegava ao degrau `idle`, então nem o Jido nem os alertas jamais falavam dela. Era o mesmo
    // defeito que o medidor sofria, só que aqui aparecia como silêncio em vez de mentira.
    kind = null;
  } else if (sample.agent && prev.sawWork && stableFor >= settle.idleMs) {
    kind = "idle";
  } else {
    // Ainda no período de acomodação: preserva o veredito anterior em vez de piscar entre estados.
    kind = prev.kind;
    question = prev.question;
    shape = prev.shape;
  }

  const entered = kind !== null && prev.kind === null;
  const escalated = kind === "asking" && prev.kind === "idle";
  return {
    next: {
      hash,
      geometry,
      changedAt: prev.changedAt,
      producingAt: prev.producingAt,
      sawWork: prev.sawWork,
      kind,
      // O "desde" é quando a TELA congelou, não quando o watcher percebeu — senão o operador leria
      // "esperando há 2s" para um prompt que está parado desde as 3 da manhã.
      since: kind === prev.kind ? prev.since : prev.changedAt,
      ...(question ? { question } : {}),
      ...(shape ? { shape } : {}),
    },
    alert: entered || escalated ? kind : null,
  };
}

/**
 * SABER ≠ INTERROMPER — a régua de quem merece um ALERTA (som/notificação/push), pura.
 *
 * O RETRATO inclui todo mundo que espera: é ele que alimenta a fala do Jido, o `claude_sessions` e o
 * contexto do chat, e conhecimento amplo não custa a atenção de ninguém. Já o alerta tira o operador
 * de onde ele está, então ele é estreito:
 *
 *   • `asking` — trava trabalho ⇒ SEMPRE, em qualquer sessão. É a capacidade nova.
 *   • `idle`   — cortesia ⇒ só na sessão em que o operador armou a campainha.
 *
 * A segunda regra existe porque ampliar a VISÃO (o vigia passou a olhar TODAS as sessões, e não só as
 * armadas como o `idle-watch` fazia) ampliaria de carona a INTERRUPÇÃO: com som ligado, cada fim de
 * turno de cada agente da máquina viraria um bipe. Ninguém pediu isso — o pedido era enxergar mais.
 */
export function shouldAlert(kind: TerminalAttentionKind, bellArmed: boolean): boolean {
  return kind === "asking" || bellArmed;
}

/** Quem entra no retrato quando há mais sessões que o teto: as de atividade mais RECENTE (é onde um
 *  prompt novo tende a estar). Devolve também quantas ficaram de fora — um teto que não se anuncia faz
 *  um retrato incompleto passar por "ninguém esperando". PURA. */
export function planWatchCycle<T extends { name: string; activityAt: number | null }>(
  sessions: readonly T[],
  cap: number,
): { watched: T[]; dropped: number } {
  const watched = [...sessions].sort((a, b) => (b.activityAt ?? 0) - (a.activityAt ?? 0)).slice(0, Math.max(1, cap));
  return { watched, dropped: Math.max(0, sessions.length - watched.length) };
}

/** Hash barato e sem dependência (FNV-1a 32 bits). A única pergunta é "mudou?". */
export function hashPane(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ── O detector de prompt ──────────────────────────────────────────────────────────────────────────

/**
 * Quantas linhas COM CONTEÚDO do fim da tela o detector olha. Um prompt mora no rodapé; o resto é histórico.
 *
 * "Com conteúdo" não é detalhe: `capture-pane` devolve a ALTURA INTEIRA do pane, e um `read -p "… [y/N] "`
 * imprime na primeira linha e deixa as outras ~40 em branco. Cortando as N últimas linhas CRUAS, a janela
 * cai toda no vazio e o prompt fica de fora — medido contra um pane real, que o detector classificou como
 * "nada" tendo o `[y/N]` na tela. As vazias (e as bordas de caixa, que viram vazias ao limpar) são
 * descartadas ANTES do corte.
 */
const TAIL_LINES = 24;

/** Traços de moldura/box-drawing que embrulham o texto num TUI — viram espaço para a frase aparecer. */
const BOX_CHARS = /[│┃|╭╮╰╯─━┄┈┌┐└┘├┤┬┴┼█▌▐▏▕]/g;

/**
 * O cursor de seleção sobre uma opção NUMERADA: `❯ 1. Sim`, `> 2) Não`. O sinal mais forte que existe.
 *
 * O número é OBRIGATÓRIO, e isso não é excesso de zelo: medido nesta máquina, o campo de digitação ocioso
 * do Claude Code é uma linha `❯ ` — o MESMO glifo. Aceitar "glifo + texto" faria toda sessão com uma
 * mensagem meio digitada ("❯ escreve isso pra mim") ser anunciada como "parado esperando você", que é a
 * notificação falsa mais irritante possível. Os diálogos que de fato bloqueiam são numerados.
 */
const OPTION_CURSOR = /^[❯>»▸➤]\s*\d+[.)]\s*\S/;

/** Uma opção da lista (sem o cursor) — usada só para NÃO confundi-la com a pergunta acima dela. */
const OPTION_ROW = /^\d+[.)]\s*\S/;

/** Confirmação em prosa, PT e EN. Ancorada em verbo + interrogação para não pegar prosa qualquer. */
const CONFIRM = /(do you want to|would you like to|are you sure|deseja (?:seguir|continuar|prosseguir|aplicar)|posso (?:seguir|continuar|aplicar)|tem certeza)\b|(?:proceed|continue|prosseguir|continuar)\?\s*$/i;

/** O clássico `[y/N]` / `(yes/no)` / `(s/n)`. */
const YESNO = /[[(](?:y(?:es)?\s*\/\s*n(?:o)?|s(?:im)?\s*\/\s*n(?:ão|ao)?)[\])]/i;

/** Segredo pedido na linha: `Password:`, `[sudo] senha para root:`, `Enter passphrase for key …:`. */
const SECRET = /(?:^|\s)(?:password|senha|passphrase)\b[^:]*:\s*$/i;

/** "Pressione ENTER para continuar" e primos. */
const ENTER_KEY = /press(?:ione)?\s+(?:enter|return|any key|qualquer tecla)/i;

/**
 * Marcadores de que o pane está TRABALHANDO — o rodapé "esc to interrupt" do CLI e a linha de spinner.
 * Vetam os sinais fracos (prosa/sim-não podem aparecer no meio de uma saída rolando); NÃO vetam o
 * cursor de opção, que é desenho de prompt e não pode acontecer por acaso.
 */
const WORKING_MARKER = /esc to interrupt|para interromper|\bctrl\+c to (?:stop|cancel)\b/i;

/** Tira a moldura e normaliza os espaços — a frase dentro de uma caixa volta a ser uma frase. */
function cleanLine(line: string): string {
  return line.replace(BOX_CHARS, " ").replace(/\s+/g, " ").trim();
}

/** O teto de uma pergunta na tela do operador: uma frase, não um parágrafo. */
const QUESTION_MAX = 120;

/**
 * A tela está desenhando um PROMPT que espera o operador? Devolve a forma + a pergunta, ou null.
 *
 * Conservador de propósito: falso-positivo aqui vira notificação no celular de madrugada. Por isso o
 * cursor de opção é o único sinal que dispensa contexto; os demais exigem estar no rodapé e não ter
 * marcador de trabalho em voo.
 */
export function detectPanePrompt(text: string): PanePrompt | null {
  const tail = tailLines(text);

  // (1) Lista de opções com o cursor. Vence tudo — inclusive o marcador de trabalho.
  const cursorAt = tail.findIndex((l) => OPTION_CURSOR.test(l.text));
  if (cursorAt >= 0) {
    return { shape: "options", question: questionAbove(tail, cursorAt) };
  }

  const working = tail.some((l) => WORKING_MARKER.test(l.text));
  if (working) return null;

  // (2..5) Os sinais de linha — do fim para o começo, o primeiro que casar. A linha inteira vira a
  // pergunta, mas SÓ se ela não tiver cara de código: um `[y/N]` dentro de um trecho de fonte na tela
  // casa o padrão sem ser prompt nenhum, e a mesma trava que vale para a lista de opções vale aqui.
  // A FORMA continua valendo mesmo assim (o terminal pode estar mesmo esperando) — o que se recusa é
  // publicar o texto; `describeAttention` diz o que ele está pedindo pela forma.
  for (let i = tail.length - 1; i >= 0; i--) {
    const l = tail[i].text;
    const q = looksLikePrompt(l) ? clamp(l) : "";
    if (SECRET.test(l)) return { shape: "secret", question: q };
    if (YESNO.test(l)) return { shape: "yesno", question: q };
    if (ENTER_KEY.test(l)) return { shape: "enter", question: q };
    if (CONFIRM.test(l)) return { shape: "confirm", question: q };
  }
  return null;
}

/**
 * Uma linha COM CONTEÚDO da tela, sabendo se havia vazio logo acima dela.
 *
 * O `breakBefore` é o que devolve ESTRUTURA a um texto que já foi achatado: as linhas em branco (e as
 * bordas de caixa, que viram branco ao limpar) somem da lista — mas ANTES de sumirem deixam a marca de
 * que ali havia uma fronteira. É com ela que se sabe se uma frase está DENTRO do mesmo diálogo que as
 * opções ou se é scrollback que por acaso ficou logo acima da caixa.
 */
interface TailLine {
  readonly text: string;
  readonly breakBefore: boolean;
}

/** As últimas {@link TAIL_LINES} linhas com conteúdo, cada uma marcada com a fronteira acima dela. */
function tailLines(text: string): TailLine[] {
  const kept: TailLine[] = [];
  let broke = true; // o começo da tela é uma fronteira como qualquer outra
  for (const raw of (text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = cleanLine(raw);
    if (!line) {
      broke = true;
      continue;
    }
    kept.push({ text: line, breakBefore: broke });
    broke = false;
  }
  const tail = kept.slice(-TAIL_LINES);
  // O corte da janela é ele mesmo uma fronteira: acima dele não há o que costurar.
  return tail.length > 0 ? [{ text: tail[0].text, breakBefore: true }, ...tail.slice(1)] : tail;
}

/**
 * Um PEDAÇO de frase, não uma frase: começa como continuação (minúscula/pontuação) ou é curta demais
 * para ser uma pergunta inteira. É assim que uma pergunta longa chega à tela de um TUI — quebrada pela
 * largura do pane, com o rabo ("CopilotFace.tsx?") numa linha só dele.
 */
function isFragment(s: string): boolean {
  return /^[a-zà-ÿ0-9,;)\]—-]/u.test(s) || s.split(/\s+/).length < 4;
}

/**
 * Isto pode virar texto de notificação? A régua é pelo NEGATIVO: recusamos o que tem cara de CÓDIGO ou
 * de saída de programa (chaves, `=`, `;`, `//`, `$`, crase, pipe). Uma pergunta de prompt não tem nada
 * disso; um trecho de arquivo aberto na tela tem quase sempre.
 */
function looksLikePrompt(s: string): boolean {
  return !/[{}<>=;`$|\\]|\/\//.test(s);
}

/**
 * A pergunta que encabeça uma lista de opções — e as TRÊS travas que ela ganhou.
 *
 * O DEFEITO, medido em produção: a notificação do sistema anunciou `“Mascote e no” · parado há 4min`.
 * "Mascote e no" não era pergunta nenhuma — era um pedaço de uma linha que estava na tela por perto,
 * levantada tal e qual porque a única régua aqui era "a linha mais próxima acima do cursor que não é
 * uma opção". Um aviso que interrompe o operador com um fragmento sem sentido gasta a credibilidade de
 * TODOS os outros avisos, inclusive os verdadeiros.
 *
 *   1. MESMO BLOCO — a pergunta tem de estar contígua às opções (`breakBefore`). Uma linha em branco ou
 *      uma borda de caixa entre as duas significa que aquilo é scrollback que por acaso ficou ali em
 *      cima, não o enunciado do diálogo.
 *   2. RECOSTURA — se a candidata é um FRAGMENTO, sobe e junta a linha de cima (que precisa ser uma
 *      frase inacabada: uma que termina em `.`/`?`/`!` é outra frase, não a metade desta). Antes, uma
 *      pergunta quebrada em duas linhas virava notificação com só o rabo dela.
 *   3. NADA DE CÓDIGO — o que sobrar ainda passa pelo `looksLikePrompt`.
 *
 * Falhar aqui é BARATO: `describeAttention` tem a frase honesta para pergunta ausente ("o terminal parou
 * num prompt e não anda sem a sua resposta"), que é curta, verdadeira e nunca é lixo.
 */
function questionAbove(tail: readonly TailLine[], cursorAt: number): string {
  let found = -1;
  for (let i = cursorAt; i > 0 && !tail[i].breakBefore; ) {
    i -= 1;
    const l = tail[i].text;
    if (l.length < 3 || OPTION_ROW.test(l) || OPTION_CURSOR.test(l)) continue; // outra opção, não a pergunta
    found = i;
    break;
  }
  if (found < 0) return "";

  let question = tail[found].text;
  for (let j = found; j > 0 && !tail[j].breakBefore; ) {
    j -= 1;
    if (!isFragment(question) || question.length >= QUESTION_MAX) break;
    const prev = tail[j].text;
    if (prev.length < 3 || OPTION_ROW.test(prev) || OPTION_CURSOR.test(prev)) break;
    if (WORKING_MARKER.test(prev)) break; // rodapé do CLI ("esc to interrupt") — moldura, não enunciado
    if (/[.!?]\s*$/.test(prev)) break; // frase COMPLETA acima ⇒ não é a metade desta
    question = `${prev} ${question}`;
  }
  return looksLikePrompt(question) ? clamp(question) : "";
}

/**
 * Corta no teto — mas na FRONTEIRA DE PALAVRA, não no meio dela.
 *
 * O corte cego produzia notificação terminando em `… implementar notifica…`, que é a mesma sensação de
 * texto quebrado que este módulo acabou de deixar de produzir de outra maneira. Só cede à palavra
 * quando o espaço está razoavelmente perto do fim (60% do teto); antes disso, um corte na fronteira
 * devolveria meia frase, e aí o corte seco é mais honesto.
 */
function clamp(s: string): string {
  if (s.length <= QUESTION_MAX) return s;
  const slice = s.slice(0, QUESTION_MAX - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace >= QUESTION_MAX * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

// ── Apresentação (pura, compartilhada por notificação · balão do Jido · contexto do chat) ─────────

/** "12s" · "4min" · "1h03" — quanto tempo aquilo está parado. Compacto para caber numa linha. */
export function waitedFor(since: number, now: number): string {
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}

/**
 * O terminal mais URGENTE primeiro: `asking` antes de `idle`, e dentro do mesmo degrau o que espera
 * há MAIS tempo. Comparador puro — a UI, o alerta e o contexto do chat ordenam pela mesma régua.
 */
export function byAttentionUrgency(a: TerminalAttention, b: TerminalAttention): number {
  if (a.kind !== b.kind) return a.kind === "asking" ? -1 : 1;
  return a.since - b.since;
}

// ── A LISTA da barra: sessões ⋈ quem está esperando você ─────────────────────────────────────────
//
// O medidor de terminais da barra listava as sessões na ordem que o tmux devolve e dizia de cada uma o
// COMANDO — quer dizer, listava tudo o que NÃO importa para decidir onde clicar. O sinal que importa
// (este módulo: quem parou num prompt e não anda sem você) já viajava pelo mesmo SSE e era consumido
// só pelo Jido: a barra tinha o dado em mãos e mostrava outro.
//
// A junção é por NOME DE SESSÃO, que é a identidade estável dos dois lados (é por ela que se abre
// `?b=`) — e é de propósito que ela é PURA e mora aqui, junto do comparador de urgência: a barra, o
// alerta e a fala do Jido têm de ordenar os mesmos terminais na mesma ordem.

/** O mínimo de uma sessão que a lista precisa — o subconjunto estrutural de `EnrichedSession`. */
export interface TerminalSessionLike {
  name: string;
  label?: string;
  attached?: boolean;
  /** "o que ela está fazendo" (derivePhrase). */
  phrase?: string;
  command?: string;
  cwd?: string;
}

/** Uma linha pronta para desenhar: identidade + o que ela faz + se ela está te esperando. */
export interface TerminalRow {
  session: string;
  label: string;
  attached: boolean;
  /** o que ela está fazendo, já com fallback resolvido ("" quando não dá para dizer). */
  phrase: string;
  /** o pedido de atenção, quando existe — `null` = está trabalhando ou dormindo em paz. */
  waiting: TerminalAttention | null;
}

/** Espera VOCÊ primeiro (`asking` antes de `idle`) · depois a que está aberta · depois o resto. */
function rowRank(r: TerminalRow): number {
  if (r.waiting) return r.waiting.kind === "asking" ? 0 : 1;
  return r.attached ? 2 : 3;
}

/**
 * As sessões na ordem em que o operador precisa vê-las, cada uma sabendo se está esperando por ele.
 * Um item de atenção sem sessão correspondente é DESCARTADO (a lista é das sessões; um alerta órfão
 * viraria uma linha que não abre nada).
 */
export function terminalRows(
  sessions: readonly TerminalSessionLike[],
  attention: readonly TerminalAttention[],
): TerminalRow[] {
  const waitingBy = new Map(attention.map((a) => [a.session, a]));
  return sessions
    .map((s) => ({
      session: s.name,
      label: s.label?.trim() || s.name,
      attached: !!s.attached,
      // `phrase` (o que ela FAZ) na frente do comando; o cwd é o último recurso. O chip lia
      // `s.command || s.path` — e `path` não existe no que a rota devolve (o campo é `cwd`), então o
      // fallback nunca disparava e uma sessão sem comando ficava com a linha vazia.
      phrase: (s.phrase || s.command || s.cwd || "").trim(),
      waiting: waitingBy.get(s.name) ?? null,
    }))
    .sort(
      (a, b) =>
        rowRank(a) - rowRank(b) ||
        (a.waiting && b.waiting ? a.waiting.since - b.waiting.since : 0) ||
        a.label.localeCompare(b.label, "pt-BR"),
    );
}

/** Quantas sessões estão PARADAS num prompt esperando você — o que dá o tom âmbar ao medidor. */
export function countAsking(rows: readonly TerminalRow[]): number {
  return rows.reduce((n, r) => n + (r.waiting?.kind === "asking" ? 1 : 0), 0);
}

/**
 * O QUE ELE ESTÁ PEDINDO, dito pela FORMA do prompt — a frase para quando a pergunta não deu para ler.
 *
 * Vem da estrutura reconhecida pelo detector, não de texto copiado da tela, então nunca é lixo. E não é
 * mobília: "está pedindo uma SENHA" e "está pedindo que você escolha na lista" pedem reações diferentes
 * de quem recebe o aviso — a frase única de antes ("parou num prompt") tratava as duas como a mesma
 * coisa. Exaustiva por `PromptShape`.
 */
const SHAPE_ASK: Record<PromptShape, string> = {
  options: "Está esperando você escolher uma opção da lista",
  confirm: "Está esperando a sua confirmação",
  yesno: "Está esperando um sim ou não",
  // A chave é o NOME da forma de prompt, não uma credencial — o scanner lê `secret: "…"` como par
  // chave/valor e acusa; daí o pragma na própria linha.
  secret: "Está pedindo uma senha", // pragma: allowlist secret
  enter: "Está esperando você apertar ENTER",
};

/** O que o terminal está pedindo, em uma frase. Sem forma conhecida, a verdade mínima. PURA. */
export function promptAsk(shape: PromptShape | undefined): string {
  return shape ? SHAPE_ASK[shape] : "Parou num prompt e não anda sem a sua resposta";
}

/** O texto de UM terminal esperando — o mesmo par (título, corpo) que a notificação e o push usam. */
export function describeAttention(a: TerminalAttention, now: number): { title: string; body: string } {
  const waited = waitedFor(a.since, now);
  if (a.kind === "asking") {
    return {
      title: `“${a.label}” está esperando você`,
      body: a.question ? `${a.question} · parado há ${waited}` : `${promptAsk(a.shape)} · há ${waited}`,
    };
  }
  return {
    title: `“${a.label}” ficou quieto`,
    body: `Parou de produzir saída há ${waited} — provavelmente terminou, ou espera a sua próxima instrução.`,
  };
}
