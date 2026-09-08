// ── AS DUAS PERGUNTAS QUE ERAM "PROCEDIMENTO" ───────────────────────────────────────────────────────
//
// Um plano de migração acumula passos que alguém tem de LEMBRAR. Dois deles sobreviveram a todas as
// rodadas de conserto porque pareciam config de host, não código:
//
//   1. «inventarie as units cravadas num caminho literal» — o plano falava de UMA unit; medindo, são
//      cinco e três timers, e duas estavam quebradas havia semanas sem ninguém ver. Um serviço que
//      muda de árvore deixa para trás toda unit que aponta para a antiga.
//   2. «drene antes de reiniciar» — não havia procedimento escrito em lugar nenhum, e ninguém tinha
//      perguntado «e se houver três cards rodando?».
//
// Passo lembrado é passo esquecido. Estes dois cores são PUROS (recebem o que foi medido, não medem):
// o preflight os lê e NOMEIA, que é a única forma de um item destes sobreviver a quem não leu o plano.

export interface UnitMedida {
  /** nome da unit, como o systemd a chama. */
  unit: string;
  /** os caminhos ABSOLUTOS que as diretivas dela citam (ExecStart, WorkingDirectory, EnvironmentFile…). */
  caminhos: readonly string[];
  /**
   * Subconjunto de `caminhos` que NÃO EXISTE no disco e que o systemd não declarou opcional (o
   * prefixo `-`). Ausente ⇒ a sonda não mediu existência, e o veredito diz isso em vez de aprovar.
   */
  ausentes?: readonly string[];
}

export type ColunaDaUnit =
  /** aponta para o ALVO, e o arquivo é do alvo — fica como está. */
  | "alvo"
  /** aponta para o ALVO mas o arquivo é DA FERRAMENTA — é item do cutover: ela vai deixar de existir ali. */
  | "ferramenta-no-alvo"
  /** nem um nem outro: config do HOST, declarada como tal. */
  | "host";

export interface UnitClassificada {
  unit: string;
  caminho: string;
  coluna: ColunaDaUnit;
}

/** Um caminho está DENTRO de uma raiz? Compara por SEGMENTO — `/repo-outro` não está em `/repo`. */
function dentroDe(caminho: string, raiz: string): boolean {
  const c = caminho.replace(/\/+$/, "");
  const r = raiz.replace(/\/+$/, "");
  return c === r || c.startsWith(`${r}/`);
}

/**
 * Classifica cada caminho literal que as units citam. PURA.
 *
 * A régua: um caminho dentro do ALVO que aponta para o PACOTE DA FERRAMENTA é o caso perigoso — ele
 * resolve hoje por acidente de topologia e deixa de resolver no instante em que a ferramenta muda de
 * árvore. `pacoteDaFerramentaNoAlvo` é esse prefixo (ex.: `<alvo>/packages/storymap-ui`), passado como
 * dado para o cálculo não depender do layout desta casa.
 */
export function classificarUnits(
  unidades: readonly UnitMedida[],
  opts: { raizDoAlvo: string; pacoteDaFerramentaNoAlvo: string },
): UnitClassificada[] {
  const out: UnitClassificada[] = [];
  for (const u of unidades) {
    for (const caminho of u.caminhos) {
      const coluna: ColunaDaUnit = dentroDe(caminho, opts.pacoteDaFerramentaNoAlvo)
        ? "ferramenta-no-alvo"
        : dentroDe(caminho, opts.raizDoAlvo)
          ? "alvo"
          : "host";
      out.push({ unit: u.unit, caminho, coluna });
    }
  }
  return out;
}

// ── O DRENO ─────────────────────────────────────────────────────────────────────────────────────────

export interface EstadoParaReiniciar {
  /** quantos runs de card o motor está executando AGORA. */
  runsAtivos: number;
  /** entradas da fila de merge ainda aguardando integração. */
  filaEsperando: number;
  /** boards com autorun ARMADO — enquanto houver, um run novo pode nascer no meio do dreno. */
  boardsArmados: readonly string[];
}

export interface VereditoDeReinicio {
  seguro: boolean;
  /** o que impede, na ordem em que tem de ser resolvido. Vazio sse `seguro`. */
  impedimentos: string[];
  /** o que fazer, nomeando a ação — nunca um "aguarde". */
  comoDrenar: string[];
}

/**
 * «Dá para reiniciar agora?» PURA — recebe o estado medido.
 *
 * A ordem dos impedimentos é load-bearing e não é cosmética: desarmar os boards vem ANTES de esperar
 * os runs, porque esperar com o autorun armado é uma corrida que não termina — cada card que avança
 * dispara o próximo. Um dreno que espera primeiro pode esperar para sempre.
 *
 * Um restart mata os filhos headless (eles vivem no cgroup da unit, e o motor CONTA com isso: o sweep
 * de recuperação no boot os retoma). Por isso o perigo não é o run morrer — é o run morrer no mesmo
 * instante em que o ledger que saberia recuperá-lo é trocado. Daí a fila entrar na conta.
 */
export function podeReiniciar(e: EstadoParaReiniciar): VereditoDeReinicio {
  const impedimentos: string[] = [];
  const comoDrenar: string[] = [];

  if (e.boardsArmados.length > 0) {
    impedimentos.push(
      `${e.boardsArmados.length} board(s) com autorun ARMADO (${e.boardsArmados.join(", ")}) — ` +
        "enquanto estiverem, um run novo nasce no meio do dreno",
    );
    comoDrenar.push(
      `desarme cada um: set_board_autorun({ board, enabled: false }) — ${e.boardsArmados.join(", ")}`,
    );
  }
  if (e.runsAtivos > 0) {
    impedimentos.push(`${e.runsAtivos} run(s) em voo — o restart os mata no cgroup da unit`);
    comoDrenar.push("espere runner_status devolver zero ativos (desarme ANTES, senão a espera não converge)");
  }
  if (e.filaEsperando > 0) {
    impedimentos.push(
      `${e.filaEsperando} entrada(s) aguardando na fila de merge — trabalho commitado e não integrado`,
    );
    comoDrenar.push("drene ou resolva a fila: resolve_merge (sem runId lista as entradas e o motivo de cada)");
  }

  return { seguro: impedimentos.length === 0, impedimentos, comoDrenar };
}

// ── A TERCEIRA PERGUNTA: A UNIT AINDA APONTA PARA ALGO QUE EXISTE? ─────────────────────────────────
//
// `classificarUnits` responde "esta unit sobrevive ao cutover?". Esta responde outra coisa, e é sobre
// HOJE: uma unit cujo `ExecStart` ou `WorkingDirectory` aponta para um arquivo que não existe está
// quebrada AGORA. O systemd só reclama quando alguém a inicia — um timer noturno falha sozinho por
// semanas sem que nada apareça, que foi exatamente o que aconteceu com duas units desta caixa.
//
// A régua honra o `-` do systemd: `EnvironmentFile=-/x` DECLARA que a ausência é esperada, e tratá-la
// como defeito seria um alarme que ensina a ignorar alarmes. Quem mede a existência é a sonda; aqui
// só se lê o que ela mediu.

export interface CaminhoAusente {
  unit: string;
  caminho: string;
}

/**
 * Os caminhos exigidos que não existem. PURA.
 *
 * Units sem o campo `ausentes` são PULADAS, não aprovadas: sonda que não mediu não vira verde.
 */
export function caminhosAusentes(unidades: readonly UnitMedida[]): CaminhoAusente[] {
  const out: CaminhoAusente[] = [];
  for (const u of unidades) {
    for (const caminho of u.ausentes ?? []) out.push({ unit: u.unit, caminho });
  }
  return out;
}

/** Quantas units tiveram a existência de fato MEDIDA — a não-vacuidade deste instrumento. */
export function unidadesComExistenciaMedida(unidades: readonly UnitMedida[]): number {
  return unidades.filter((u) => u.ausentes != null).length;
}

// ── A LEITURA DE UMA UNIT — extraída para poder ser PROVADA ───────────────────────────────────────
//
// Isto morava inline dentro da sonda de `server/main.ts`, onde nenhum teste alcança, e escondia um
// falso negativo por dois meses: o desaspamento tratava só `"`. A linha desta casa que mais importa é
//
//     ExecStart=/bin/sh -c '/usr/bin/tmux ... new-session -d -s shell -c /root/<alvo>'
//
// cujo último token sai como `/root/<alvo>'` — com o apóstrofo colado. Ele não casa o prefixo da
// raiz, a unit inteira some do inventário, e o runbook do cutover chegou a afirmar "o inventário é
// UMA linha" medindo com esse ponto cego ligado. Um inventário que omite em silêncio é pior que
// nenhum: ele parece completo.
//
// Pura por DI (`existe`), que é o que a torna testável sem tocar em `/etc`.

const DIRETIVAS_COM_CAMINHO =
  /^\s*(ExecStart|ExecStartPre|ExecStop|ExecReload|WorkingDirectory|EnvironmentFile)\s*=(.*)$/;

export interface LeituraDeUnit {
  /** os caminhos ABSOLUTOS sob `raiz` que a unit cita, sem aspas e sem o `-` do systemd. */
  caminhos: string[];
  /** os que são EXIGIDOS (sem `-`) e não existem. */
  ausentes: string[];
}

export function lerCaminhosDeUnit(
  texto: string,
  opts: { raiz: string; existe: (p: string) => boolean },
): LeituraDeUnit {
  const caminhos = new Set<string>();
  const ausentes = new Set<string>();
  const raiz = opts.raiz.replace(/\/+$/, "");
  for (const linha of texto.split("\n")) {
    const m = DIRETIVAS_COM_CAMINHO.exec(linha);
    if (!m) continue;
    for (const tok of m[2].split(/\s+/)) {
      // O `-` é PREFIXO DO SYSTEMD, não do caminho: em `EnvironmentFile=-/x` e `ExecStartPre=-/x` ele
      // DECLARA que a ausência é tolerada. Descartá-lo antes de medir transformaria uma opcionalidade
      // explícita num falso defeito — medido nesta caixa, onde uma unit da pilha de QA declara assim
      // um `.env` que de fato não existe, e está certa.
      const opcional = tok.startsWith("-");
      const limpo = tok.replace(/^-/, "").replace(/^["']|["']$/g, "");
      if (!limpo.startsWith(`${raiz}/`) && limpo !== raiz) continue;
      caminhos.add(limpo);
      if (!opcional && !opts.existe(limpo)) ausentes.add(limpo);
    }
  }
  return { caminhos: [...caminhos], ausentes: [...ausentes] };
}
