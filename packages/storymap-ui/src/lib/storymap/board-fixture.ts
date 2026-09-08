import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parseYamlMap } from "./frontmatter";
import { boardConfigPath, boardsDir } from "./paths";

/**
 * O SUJEITO das provas que precisam de um board REAL no disco.
 *
 * O problema que este módulo resolve. Os boards de produto do dono NÃO viajam na extração OSS — a
 * régua `.ossignore` os corta, e isso é decisão de projeto, não acidente. Mas ~40 provas desta suíte
 * liam esses boards PELO NOME. No repositório extraído elas viravam ENOENT, e as travas anti-vácuo
 * (`expect(n).toBeGreaterThan(0)`) reprovavam por não ter o que medir — que é o comportamento certo
 * delas.
 *
 * A saída NÃO é afrouxar a asserção (um portão que fica verde por não ter sujeito é pior que um
 * portão vermelho): é dar a ela um sujeito que VIAJA. `storymap/boards/demo` e
 * `storymap/boards/demo-legado` são esse sujeito — dado sintético, negados explicitamente na régua,
 * presentes nas DUAS árvores. Por isso as constantes abaixo são incondicionais: no umbrella e no
 * repositório extraído a prova mede a MESMA coisa.
 *
 * UMA constante, não dez cópias: dez arquivos com o nome do board escrito à mão são dez verdades que
 * derivam em silêncio no dia em que uma delas muda.
 *
 * E NENHUM nome de board de produto aparece aqui. Os outros boards da árvore são DESCOBERTOS no
 * disco e classificados pelo que o `board.yaml` deles declara (`inheritPipeline`), nunca por uma
 * lista de nomes — a régua que o `agnostic-lint` guarda: a ferramenta não conhece os produtos do
 * dono. O efeito colateral é o certo: um board novo entra nos lints sozinho.
 */

/** O board de demonstração que HERDA a pipeline canônica do `_base` (o caso dos 99%). */
export const FIXTURE_BOARD = "demo";

/** O board de demonstração que OPTA POR SAIR da pipeline canônica (`inheritPipeline: false`). */
export const FIXTURE_LEGACY_BOARD = "demo-legado";

/** Os dois fixtures, em ordem de id. */
export const FIXTURE_BOARDS = [FIXTURE_BOARD, FIXTURE_LEGACY_BOARD] as const;

/**
 * Falha ALTO se o fixture não estiver no disco. Sem isto, um fixture apagado (ou cortado pela régua)
 * degradaria toda prova que depende dele para "0 boards, 0 cards, nada a reprovar" — o vácuo-verde
 * que este módulo existe para tornar impossível.
 */
export function assertFixturePresent(id: string): string {
  if (!existsSync(boardConfigPath(id))) {
    throw new Error(
      `[board-fixture] o board de teste "${id}" não está em ${boardConfigPath(id)}. ` +
        `Ele é o SUJEITO da suíte e tem de viajar na extração — confira a negação ` +
        `\`!/storymap/boards/${id}/\` no .ossignore antes de mexer nos testes.`,
    );
  }
  return id;
}

/** Todo diretório de board com um `board.yaml` legível (mesma regra de `listBoards`: `_` não é board). */
export function boardIdsOnDisk(): string[] {
  const entries = readdirSync(boardsDir(), { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && existsSync(boardConfigPath(e.name)))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * O board.yaml CRU (antes da herança do `_base`) — é nele que mora a declaração de opt-out.
 *
 * Pelo CHOKEPOINT, não por `yaml.load` direto: este módulo lê bytes de `storymap/boards/**`, que é
 * exatamente a classe que `frontmatter.test.ts` fecha (teto de bytes/nós/profundidade e guard de
 * `__proto__`). A primeira versão daqui usava `yaml.load` e o lint a pegou VERMELHA — é ele
 * funcionando, e a saída certa era passar pelo chokepoint, não abrir exceção na allowlist dele.
 */
function rawBoardYaml(id: string): Record<string, unknown> {
  const p = boardConfigPath(id);
  return parseYamlMap(readFileSync(p, "utf8"), p);
}

/** Um board OPTA POR SAIR da pipeline canônica quando o próprio yaml diz isso. */
function optsOut(id: string): boolean {
  return rawBoardYaml(id).inheritPipeline === false;
}

/**
 * Todo board que `listBoards()` deve enxergar nesta árvore, em ordem de id.
 *
 * A lista é lida do DISCO de propósito — a alternativa (nomes fixos) só existiria enquanto os boards
 * do dono estivessem presentes, e é exatamente ela que morre na extração. O que a asserção guarda
 * segue sendo real e é outro: `listBoards()` não pode PULAR um board com yaml válido nem INVENTAR um
 * que não está no disco. O piso anti-vácuo (os dois fixtures) é conferido aqui, não deduzido.
 */
export function expectedBoardIds(): string[] {
  const ids = boardIdsOnDisk();
  for (const f of FIXTURE_BOARDS) {
    assertFixturePresent(f);
    if (!ids.includes(f)) throw new Error(`[board-fixture] "${f}" não apareceu na varredura de ${boardsDir()}`);
  }
  return ids;
}

/**
 * A disciplina das funções abaixo é sempre a mesma: **o fixture é o PISO** (incondicional, em
 * qualquer árvore) e os demais boards da árvore entram por CLASSIFICAÇÃO, não por nome. Nenhuma
 * cobertura do umbrella é trocada pela do fixture — ela é somada.
 */
function withOthers(fixture: string, wantOptOut: boolean): string[] {
  assertFixturePresent(fixture);
  // O fixture é o piso, mas piso NÃO É ISENÇÃO: ele entra na lista pela mesma régua que todo mundo
  // (o que o `board.yaml` dele declara), e não por ser o fixture.
  //
  // ⚠ MEDIDO: a primeira versão daqui prependava o fixture INCONDICIONALMENTE. O efeito era um guarda
  // que não guardava — trocar `inheritPipeline: false` por `true` no `demo-legado` mantinha a suíte
  // 126/126 VERDE, porque o board seguia listado como opt-out por decreto enquanto o disco dizia o
  // contrário. A prova de que a porta de saída funciona estava sendo feita sobre uma classificação
  // que ninguém conferia. Este erro é a diferença entre a suíte discriminar e a suíte concordar.
  if (optsOut(fixture) !== wantOptOut) {
    throw new Error(
      `[board-fixture] o board de teste "${fixture}" devia ter \`inheritPipeline: ${wantOptOut ? "false" : "!== false"}\` ` +
        `e o board.yaml dele diz o contrário. O fixture é o SUJEITO da prova de herança/opt-out: ` +
        `reclassificá-lo silenciosamente deixaria essa prova sem sujeito.`,
    );
  }
  const others = boardIdsOnDisk().filter(
    (id) => !(FIXTURE_BOARDS as readonly string[]).includes(id) && optsOut(id) === wantOptOut,
  );
  return [fixture, ...others];
}

/** Boards que HERDAM a pipeline canônica do `_base` — era `const BOARD = "storymap"` nos lints. */
export function subjectBoards(): string[] {
  return withOthers(FIXTURE_BOARD, false);
}

/** Alias de intenção: os mesmos boards, quando a prova fala de HERANÇA e não de sujeito. */
export function inheritingBoards(): string[] {
  return subjectBoards();
}

/** Boards que OPTAM POR SAIR da pipeline canônica (`inheritPipeline: false`). */
export function optOutBoards(): string[] {
  return withOthers(FIXTURE_LEGACY_BOARD, true);
}

/**
 * A UNIÃO das pipelines vivas — o que os lints de skill/rótulo cruzam contra o código. Precisa das
 * DUAS formas (herdada e própria) porque uma skill é compartilhada e board-aware: ela pode citar
 * legitimamente um passo que só existe na pipeline própria.
 */
export function pipelineBoards(): string[] {
  return [...new Set([...inheritingBoards(), ...optOutBoards()])];
}
