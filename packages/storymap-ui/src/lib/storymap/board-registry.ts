// O REGISTRO DE UM BOARD NOVO — o onboarding agent-first, do lado do motor.
//
// POR QUE ESTE MÓDULO EXISTE. Registrar um app no harness era, até aqui, um gesto de EDITOR: criar
// `storymap/boards/<id>/board.yaml` à mão sabendo de cor quais chaves são obrigatórias, quais são
// herdadas do `_base` e quais são perigosas. Um agente sem contexto humano não tem como fazer isso —
// e o contrato que ele precisaria ler (BoardConfigSchema) só existia como Zod DENTRO do processo.
//
// A LACUNA QUE ELE FECHA, e que é a razão de a validação morar AQUI e não no caminho de escrita:
//   - `writeBoardConfig` (write.ts) NÃO valida contra o Zod — nunca validou;
//   - `readBoardConfig` (repo.ts) valida, mas o alarme é LOG-ONLY de propósito ("o board nunca apaga
//     por um detalhe de schema") — ele imprime `console.error` e devolve a config assim mesmo.
// Ou seja: para um board NOVO não existe, em nenhum lugar da árvore, um ponto onde o contrato RECUSE.
// Este módulo é esse ponto. É o único lugar onde o `superRefine` de `BoardDeployConfigSchema` morde de
// verdade, e é por isso que a recusa não é cerimônia — é a capacidade.
//
// O QUE O REGISTRO DELIBERADAMENTE NÃO ACEITA (contenção pelo ESQUEMA, não pelo nível de token):
//   - `orchestrator` — a `riskMatrix` de um board é relida pelo guard A CADA CHAMADA (mcp/guard.ts).
//     Um board que nascesse com `riskMatrix: {run: auto, deploy: auto}` AUTO-CONCEDERIA ao próprio
//     agente tudo naquele board. O clamp `NEVER_AUTO_RISK_CLASSES` (types.ts) só cobre `run-free` e
//     `destructive`; `run`, `deploy`, `merge-resolve`, `write-board` e `reversible-delete` são
//     auto-concedíveis por board.yaml — e `HUMAN_BOARD_FIELDS` (ownership.js) não lista `orchestrator`,
//     então o owner-guard também não o pega. Fora do esquema é a única contenção que não depende de
//     ninguém lembrar de nada.
//   - `statuses` — a pipeline vem do `_base` por herança. Um board que a re-inline nasce surdo às
//     mudanças futuras do canônico (é o defeito que `deriveBoardConfigForPersist` existe para evitar).
//   - `autorunDisabled: false` — não é um parâmetro. Um board nasce DESARMADO, ponto; armar é gesto
//     separado. Medido: o `_base` traz 12 status com `autorun: true`, então sem esta trava um board
//     recém-registrado dispararia `claude` headless na máquina de quem o registrou.
//
// `deploy` ENTRA, e a decisão tem base: os três campos de comando do board-data já passam pela régua
// de `runner/deploy-command-guard.ts` — um módulo puro, fail-closed, escrito exatamente porque
// board-data "é editado por humanos E por agentes". A régua está uma camada abaixo e cobre esta
// classe; recusar `deploy` aqui não fecharia nada e tiraria do registro o campo que mais define um app.

import fs from "node:fs/promises";
import yaml from "js-yaml";
import { BoardDeployConfigSchema } from "./contracts";
import { parseYamlMap } from "./frontmatter";
import { baseBoardConfigPath, boardConfigPath, boardDir, cardsDir, sanitizeId } from "./paths";
import { scheduleBoardDataFlush } from "./runner/board-data-flush";

/**
 * O ID VÁLIDO de um board, como REGRA e não como faxina.
 *
 * `sanitizeId` (paths.ts) DESCARTA o que não casa em vez de recusar: `"../evil"` vira `"evil"`, e
 * `"Meu App"` vira `"meuapp"`. Para um caminho isso é a defesa certa (nada escapa do diretório de
 * dados). Para um REGISTRO é a coisa errada: o chamador pediria um id e receberia outro, silenciosamente,
 * e depois não acharia o board que acabou de criar. Aqui a coerção silenciosa é o modo de falha —
 * então o registro EXIGE que o id já seja um slug, e devolve o motivo quando não é.
 *
 * O `_` inicial é reservado ao template `_base`: `listBoards` pula diretório `_`-prefixado, então um
 * board com esse nome existiria no disco e seria invisível à ferramenta inteira.
 */
export const BOARD_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

export interface RegisterBoardInput {
  id: string;
  name: string;
  /** o pacote/diretório que este board mapeia (`packages/<app>`), quando existe. Opcional por desenho:
   *  um board de discovery mapeia uma jornada de produto que ainda não tem código. */
  package?: string;
  /** o descritor de deploy — validado pelo `BoardDeployConfigSchema` REAL (nada é reimplementado aqui). */
  deploy?: unknown;
}

export type RegisterBoardResult =
  | { ok: true; id: string; path: string; armed: false }
  | { ok: false; error: string };

/** A recusa de id, separada para o teste poder cobrá-la sem tocar em disco. */
export function refuseBoardId(id: string): string | null {
  const raw = String(id ?? "");
  if (!raw.trim()) return "id vazio — informe o identificador do board (slug minúsculo, ex.: \"loja\").";
  if (raw.startsWith("_"))
    return `id "${raw}" começa com "_", que é reservado ao template \`_base\`: a listagem de boards pula diretórios "_"-prefixados, então o board existiria no disco e seria invisível. Escolha um id que comece por letra.`;
  if (!BOARD_ID_RE.test(raw))
    return `id "${raw}" não é um slug válido. A regra é ${BOARD_ID_RE.source}: minúsculas, dígitos e hífen, começando por letra, até 40 caracteres. O id vira o NOME DO DIRETÓRIO em storymap/boards/, e o registro recusa em vez de higienizar — corrigir em silêncio devolveria um id diferente do que você pediu.`;
  // Cinto e suspensório: se algum dia a régua acima e a de caminho divergirem, quem manda é o disco.
  if (sanitizeId(raw) !== raw)
    return `id "${raw}" não sobrevive à normalização de caminho (viraria "${sanitizeId(raw)}"). Use exatamente o id normalizado.`;
  return null;
}

/**
 * Registra um board NOVO. Cria `storymap/boards/<id>/{board.yaml,cards/}` e devolve o caminho.
 *
 * ATOMICIDADE DA CRIAÇÃO: o `board.yaml` é escrito com `flag: "wx"` — criar-ou-falhar, uma syscall.
 * A alternativa idiomática da casa (`atomicWriteFile`) termina num `rename`, que SOBRESCREVE; com ela
 * seria preciso um `exists` antes, e entre o `exists` e o `rename` cabe outro registro do mesmo id
 * (um modelo emite vários `tool_use` numa mensagem só e o cliente MCP os despacha em PARALELO — foi
 * exatamente essa corrida que acordou `updateBoardConfigOnDisk`). Com `wx` não há janela: o EEXIST do
 * kernel É a recusa.
 */
export async function registerBoard(input: RegisterBoardInput): Promise<RegisterBoardResult> {
  const recusa = refuseBoardId(input.id);
  if (recusa) return { ok: false, error: recusa };
  const id = input.id;

  const name = String(input.name ?? "").trim();
  if (!name) return { ok: false, error: "name vazio — informe o nome legível do board (ex.: \"Loja Aurora\")." };

  // O CONTRATO REAL, não uma cópia dele. Se o schema de deploy mudar em contracts.ts, esta recusa muda
  // junto — não há régua duplicada aqui que possa driftar.
  //
  // ⚠️ QUAL CAMADA MORDE, MEDIDO (não presumido): pelo caminho MCP quem recusa primeiro é o SDK, porque
  // `deploy` entra no `inputSchema` como o PRÓPRIO `BoardDeployConfigSchema` e o SDK dá parse no shape
  // inteiro antes de chamar o handler — então este `safeParse` aqui NÃO é o que uma chamada MCP
  // exercita. Ele existe para o outro público: `registerBoard` é API do módulo (bancada, um CLI futuro,
  // um teste), e um contrato que só vale quando o chamador já validou não é contrato. Dizer isso por
  // escrito importa porque um teste que cobrisse só esta linha e se anunciasse como "a prova do
  // superRefine no MCP" estaria medindo um caminho que ninguém percorre.
  let deploy: unknown;
  if (input.deploy !== undefined) {
    const v = BoardDeployConfigSchema.safeParse(input.deploy);
    if (!v.success) {
      const issues = v.error.issues.map((i) => `${i.path.join(".") || "deploy"}: ${i.message}`).join(" · ");
      return { ok: false, error: `descritor \`deploy\` inválido — ${issues}` };
    }
    deploy = v.data;
  }

  const pkg = input.package?.trim();
  if (pkg && (pkg.startsWith("/") || pkg.split(/[\\/]/).includes("..")))
    return { ok: false, error: `package "${pkg}" precisa ser um caminho RELATIVO dentro do repositório (ex.: "packages/loja").` };

  // ⚠️ O BOARD NÃO PODE NASCER SURDO (2026-08-19). Este caminho grava só DELTAS: a pipeline inteira —
  // status, gates, colunas — vem por herança de `boards/_base/board.yaml`. Se o alvo não tem esse
  // arquivo, o board é criado, aparece na listagem e resolve com ZERO status: sem coluna, sem gate,
  // autorun inerte. MEDIDO num alvo virgem: `registerBoard` devolvia `ok: true` e `readBoardConfig`
  // devolvia `statuses: 0` — sucesso aparente, board inútil, nenhum erro em lugar nenhum.
  //
  // A recusa é a correção honesta, e não um seed automático: o `_base` canônico é DADO do repositório
  // em que a ferramenta roda, e é o mesmo arquivo que traz 12 passos com `autorun: true`. Materializar
  // isso sozinho, na árvore de outra pessoa, é escrever política de execução de agente sem ninguém ter
  // pedido. Melhor dizer exatamente o que falta e de onde copiar.
  const pipelineHerdavel = await temPipelineHerdavel();
  if (!pipelineHerdavel) {
    return {
      ok: false,
      error:
        `esta árvore não tem uma pipeline herdável em ${baseBoardConfigPath()} — um board registrado ` +
        `aqui nasceria com ZERO status: sem coluna, sem gate e sem autorun, aparecendo na listagem como ` +
        `se estivesse pronto. Copie o \`storymap/boards/_base/board.yaml\` do repositório do ` +
        `AgileHarness para esta árvore (ele é o canônico: pipeline + vocabulário compartilhado) e ` +
        `registre de novo.`,
    };
  }

  // A ORDEM É PROPRIEDADE DE SEGURANÇA: `cards/` primeiro (mkdir recursivo é idempotente e cria o
  // diretório do board de quebra), `board.yaml` por último. Invertido, um EEXIST no yaml deixaria para
  // trás um board meio-criado; nesta ordem o que sobra de uma recusa é um diretório vazio, que
  // `listBoards` já ignora por não ter yaml legível.
  await fs.mkdir(cardsDir(id), { recursive: true });

  const raw: Record<string, unknown> = { id, name };
  if (pkg) raw.package = pkg;
  // Nasce DESARMADO. Não é default nem opção: é invariante deste caminho.
  raw.autorunDisabled = true;
  if (deploy !== undefined) raw.deploy = deploy;

  const corpo = yaml.dump(raw, { lineWidth: 120, noRefs: true });
  const cabecalho = [
    `# Board registrado por \`register_board\`. Ele declara só os DELTAS: a pipeline (status, gates,`,
    `# colunas) e o vocabulário compartilhado são HERDADOS de \`boards/_base/board.yaml\`. Não re-inline`,
    `# a pipeline aqui — um board que a copia deixa de receber as mudanças futuras do canônico.`,
    `#`,
    `# \`autorunDisabled: true\` é o que faz este board nascer DESARMADO: a pipeline herdada traz passos`,
    `# com \`autorun\`, e sem esta linha entrar num deles dispararia um agente headless sozinho. ARMAR é um`,
    `# gesto separado e deliberado — remova a linha quando quiser que o board processe cards por conta.`,
    ``,
  ].join("\n");

  try {
    await fs.writeFile(boardConfigPath(id), cabecalho + corpo, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "EEXIST")
      return {
        ok: false,
        error: `o board "${id}" já existe (${boardConfigPath(id)}). Ids de board são únicos nesta árvore — escolha outro, ou use as tools de edição para mexer no que já está lá.`,
      };
    throw err;
  }

  // Board-data é versionado pelo flush debounced, o mesmo chokepoint de toda escrita de config (é no-op
  // sob VITEST, então a suíte nunca toca em git).
  scheduleBoardDataFlush();

  return { ok: true, id, path: boardConfigPath(id), armed: false };
}

/**
 * A árvore tem uma pipeline HERDÁVEL? Não basta o arquivo existir: um `_base` ilegível ou sem
 * `statuses` produz o mesmo board surdo que a ausência dele. A pergunta é sobre o EFEITO, então ela é
 * respondida pelo conteúdo — e um `_base` quebrado cai no mesmo lado da recusa que um ausente.
 */
export async function temPipelineHerdavel(): Promise<boolean> {
  try {
    // `parseYamlMap` e não `yaml.load` cru: é o chokepoint de YAML seguro desta casa (teto de bytes,
    // schema explícito, erro tipado), e `frontmatter.test.ts` reprova quem o contorna.
    const raw = parseYamlMap(await fs.readFile(baseBoardConfigPath(), "utf8"), "_base/board.yaml");
    return Array.isArray(raw.statuses) && raw.statuses.length > 0;
  } catch {
    return false; // ausente, ilegível ou YAML inválido — os três significam "não há o que herdar"
  }
}

/** O diretório do board — reexportado para quem registra não precisar conhecer `paths.ts`. */
export function registeredBoardDir(id: string): string {
  return boardDir(id);
}

/**
 * ARMAR / DESARMAR um board — o interruptor do `autorunDisabled`.
 *
 * POR QUE ISTO EXISTE, e por que não é um extra do registro. Ao construir o `register_board` MEDIMOS que
 * `autorunDisabled` tinha um LEITOR (`notifications/.../autorun-eval.ts`) e NENHUM ESCRITOR em toda a
 * árvore: nem tool MCP, nem ação de bancada, nem `propose_change` (a governança só alcança os 7 campos de
 * `GOVERNANCE_ARTIFACTS`, e este não é um deles). Duas consequências, e a segunda é a séria:
 *
 *   1. um board registrado desarmado seria um board que NENHUMA superfície consegue destravar — a
 *      ferramenta ofereceria um caminho de onboarding que termina num beco;
 *   2. o KILL-SWITCH POR BOARD, que a própria documentação do harness aponta como o remédio quando o
 *      autorun de um board sai do controle, só era acionável editando YAML no servidor à mão. Num
 *      incidente, isso é o pior momento possível para pedir um editor de texto.
 *
 * Idempotente por desenho: pedir o estado em que o board já está NÃO grava (o `mutate` devolve `null`),
 * então uma chamada repetida não gera commit de board-data nem ruído no diário.
 */
export async function setBoardAutorun(
  boardId: string,
  enabled: boolean,
): Promise<{ ok: true; board: string; armed: boolean; changed: boolean } | { ok: false; error: string }> {
  const recusa = refuseBoardId(boardId);
  if (recusa) return { ok: false, error: recusa };
  // Import tardio: `write.ts` puxa a árvore de escrita inteira, e `board-registry` é importado pelo
  // registro de tools — que roda em TODO handshake MCP, inclusive o de um token só-leitura.
  const { updateBoardConfigOnDisk } = await import("./write");
  try {
    const escrito = await updateBoardConfigOnDisk(boardId, (atual) => {
      const desarmadoAgora = atual.autorunDisabled === true;
      if (desarmadoAgora === !enabled) return null; // já está como pediram ⇒ não grava
      // `deriveBoardConfigForPersist` só persiste a chave quando ela é TRUTHY, então `false` a REMOVE do
      // board.yaml — que é exatamente o que "armado" significa no disco (ausência da trava).
      return { ...atual, autorunDisabled: !enabled };
    });
    return { ok: true, board: boardId, armed: enabled, changed: escrito !== null };
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "ENOENT")
      return { ok: false, error: `board "${boardId}" não existe — registre-o antes (register_board) ou confira o id com list_boards.` };
    return { ok: false, error: `não consegui alterar o autorun de "${boardId}": ${(err as Error).message}` };
  }
}
