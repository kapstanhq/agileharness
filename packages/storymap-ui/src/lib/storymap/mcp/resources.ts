// OS MCP *RESOURCES* DO AGILEHARNESS — o canal de CONTEXTO, ao lado do canal de AÇÃO (as tools).
//
// POR QUE UM CANAL SEPARADO, e não mais três tools. Está escrito no próprio `onboarding.ts`: quando um
// conector expõe muitas tools, o HARNESS DO CLIENTE defere o schema de algumas — o agente precisa
// procurá-las por nome antes de poder chamá-las. Este servidor já passa de cem tools, então uma tool
// nova de ORIENTAÇÃO nasceria deferida, e quem mais precisa dela é exatamente quem ainda não sabe que
// ela existe. `resources/list` é outro canal, e não sofre esse deferral: o cliente enxerga a lista
// inteira antes da primeira chamada. Resources também são ENDEREÇÁVEIS — reler um deles ao esbarrar
// num gate custa uma leitura pontual, não o guia inteiro de novo.
//
// A RÉGUA QUE CADA UM DESTES QUATRO PRECISOU PASSAR: responder uma pergunta que NENHUMA tool responde
// hoje. Um resource que reembala `list_boards` ou `mcp_onboarding` é peso morto — mais bytes no contexto de
// toda requisição, sem nenhuma resposta nova. Os candidatos óbvios (a lista de boards, o vocabulário, o
// guia) foram descartados por esse critério. Os quatro abaixo passaram porque cada um cobre um BURACO
// MEDIDO na superfície atual, anotado no comentário de cada um.
//
// ⚠️ O QUE NÃO ENTRA AQUI, e o motivo importa: o JSON Schema do `BoardConfig` derivado do Zod. MEDIMOS
// que a derivação ingênua JÁ NASCE DIVERGENTE — os `oneOf` do contrato são `z.custom` e viram `{}`
// (vocabulário fechado publicado como "qualquer coisa"), e o `superRefine` do descritor de deploy
// simplesmente some. O contrato publicado ACEITARIA o payload que o servidor RECUSA. Publicar isso
// seria assinar uma promessa falsa por escrito, legível por máquina — pior que não publicar nada. O
// contrato de deploy, aliás, já viaja no `tools/list`: o `inputSchema.deploy` do `register_board` É o
// `BoardDeployConfigSchema` de verdade.
//
// ⚠️ NENHUM destes devolve dado de board (card, persona, título). É o que os mantém `read` para
// qualquer nível E fora do alcance do envenenamento de instrução: o que sai daqui é o TEMPLATE da
// instalação e o ESTADO dos interruptores, nunca texto que um chamador tenha escrito.

import { existsSync } from "node:fs";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineResource } from "./register";
import { GATES } from "@/lib/storymap/gates";
import { GATE_IDS } from "@/lib/storymap/types";
import { findRepoRoot } from "@/lib/storymap/paths";
import { listBoards, readBaseTemplateConfig, readBoardConfig } from "@/lib/storymap/repo";
import { loadRunnerConfig } from "@/lib/storymap/runner/config";

export const URI_PIPELINE_BASE = "agileharness://pipeline/base";
export const URI_PIPELINE_GATES = "agileharness://pipeline/gates";
export const URI_AUTORUN = "agileharness://autorun";
export const URI_TARGET = "agileharness://target";
export const URI_PREFLIGHT = "agileharness://preflight";

/** Os cinco, para o teste de superfície poder cobrar a lista sem reescrevê-la. */
export const RESOURCE_URIS = [URI_PIPELINE_BASE, URI_PIPELINE_GATES, URI_AUTORUN, URI_TARGET, URI_PREFLIGHT] as const;

export function registerResources(server: McpServer): void {
  // ── R1 — A PIPELINE QUE UM BOARD NOVO HERDA ────────────────────────────────────────────────────
  // O buraco: o template `_base` é INALCANÇÁVEL por toda a superfície MCP. `list_boards` pula
  // diretórios com `_` na frente, e `list_statuses({board:"_base"})` procura `boards/base/` (o `_` é
  // removido pela normalização de caminho) e devolve "board não encontrado". Ou seja, a pergunta "o que
  // eu ganho ao registrar um board?" não tinha resposta — e ela é a pergunta ANTERIOR a `register_board`.
  // Ler o board de demonstração no lugar mediria outra coisa: ele LIGA passos que no template estão
  // desligados.
  defineResource(
    server,
    "pipeline-base",
    URI_PIPELINE_BASE,
    {
      title: "Pipeline canônica (o template herdado)",
      description:
        "A pipeline que TODO board novo herda ao ser criado por register_board: colunas, status, gates, " +
        "quais status disparam agente e quais são terminais. Leia ANTES de registrar um board — é o que " +
        "você está prestes a ganhar. Não é a pipeline de nenhum board específico (para essa, " +
        "list_statuses); é o template, que nenhuma tool consegue devolver.",
      mimeType: "application/json",
    },
    async () => {
      const base = await readBaseTemplateConfig();
      return {
        fonte: "boards/_base/board.yaml — o template que todo board novo herda",
        colunas: (base.columns ?? []).map((c) => ({ id: c.id, nome: c.name })),
        status: base.statuses.map((s) => ({
          id: s.id,
          nome: s.name,
          coluna: s.column ?? null,
          gate: s.gate ?? null,
          skill: s.trigger ?? null,
          autorun: s.autorun === true,
          terminal: s.terminal === true,
        })),
        linkTypes: base.linkTypes.map((l) => ({ id: l.id, nome: l.name })),
        // A lista que o portão de `set_board_autorun` pede que você confirme — ANTES de confirmar.
        disparamQuandoArmado: base.statuses.filter((s) => s.autorun === true && s.trigger).map((s) => s.id),
        nota:
          "um board registrado nasce DESARMADO (autorunDisabled): nenhum destes dispara até " +
          "set_board_autorun({enabled:true}). Um board declara só os DELTAS sobre este template.",
      };
    },
  );

  // ── R2 — O QUE CADA GATE EXIGE, E COMO SE CUMPRE ───────────────────────────────────────────────
  // O buraco, medido: cada gate declara `message` E `fix` — a remediação acionável. Mas o caminho que
  // recusa um `move_card` propaga só a `message`; o `fix` é descartado antes de chegar ao fio. A tela do
  // humano mostra os dois (ela chama outro caminho, que não é exposto por tool nenhuma). Ou seja, o
  // agente recebe hoje um "não" com menos informação do que o humano recebe pela mesma recusa. Isto é
  // assimetria medida entre as duas superfícies, não reembalagem de `list_statuses` (que devolve o ID do
  // gate e mais nada).
  defineResource(
    server,
    "pipeline-gates",
    URI_PIPELINE_GATES,
    {
      title: "Os gates da pipeline — o que cada um exige",
      description:
        "Todo gate do pipeline com o que ele cobra e COMO se cumpre (o campo `comoCumprir`, que a recusa " +
        "de move_card não carrega). Leia quando um move for rejeitado por gate, ou antes de planejar o " +
        "caminho de um card: list_statuses diz QUAL gate guarda cada coluna, este diz o que satisfazer.",
      mimeType: "application/json",
    },
    () => ({
      fonte: "gate-core — a mesma fonte que o motor usa para aceitar ou recusar um move",
      gates: GATE_IDS.map((id) => {
        const g = GATES[id];
        return { id, rotulo: g?.label ?? null, exige: g?.message ?? null, comoCumprir: g?.fix ?? null };
      }),
      nota:
        "um gate é avaliado quando o card ENTRA no status, não enquanto ele está lá. Cumprir o " +
        "pré-requisito é o caminho; não existe como forçar a passagem.",
    }),
  );

  // ── R3 — OS INTERRUPTORES ──────────────────────────────────────────────────────────────────────
  // O buraco: "criei o card e nada aconteceu" tem quatro causas possíveis, e nenhuma tool as distingue.
  // `list_boards` devolve `{id,name}` e nada mais — não diz se o board está armado. `runner_status`
  // devolve o que está RODANDO, e é byte-idêntico entre "autorun desligado" e "autorun ligado e ocioso".
  // Este resource é o mapa dos interruptores.
  //
  // ⚠️ DE PROPÓSITO NÃO EXISTE um booleano `vaiRodar`. Ele seria promessa falsa: há quatro causas
  // independentes para um card não andar (o interruptor mestre, a trava do board, o modo economia e um
  // gate reprovado), e um único booleano teria de mentir sobre pelo menos uma delas.
  defineResource(
    server,
    "autorun",
    URI_AUTORUN,
    {
      title: "Os interruptores do autorun",
      description:
        "O estado dos interruptores que decidem se um card anda sozinho: o mestre da instalação e a trava " +
        "por board (armado / desarmado). Leia quando um card não avançar e você não souber se está " +
        "desligado ou se não há o que fazer. Não promete que um card VAI rodar — um gate reprovado " +
        "também para o card (veja o resource dos gates).",
      mimeType: "application/json",
    },
    async () => {
      const cfg = loadRunnerConfig();
      const boards = await listBoards();
      const estados = await Promise.all(
        boards.map(async (b) => {
          const c = await readBoardConfig(b.id).catch(() => null);
          return { id: b.id, armado: c ? c.autorunDisabled !== true : null };
        }),
      );
      return {
        mestre: {
          ligado: cfg.autorun.enabled,
          fonte: "storymap/settings.yaml → autorun.enabled (env AGILEHARNESS_AUTORUN tem precedência)",
        },
        boards: estados,
        modoEconomia: cfg.economyMode === true,
        atalhoManual:
          "run_skill e enqueue NÃO passam pela trava do board — disparam mesmo com o board desarmado.",
        comoArmar: "set_board_autorun({board, enabled:true, confirm:<o id do board>})",
      };
    },
  );

  // ── R4 — QUAL ÁRVORE É ESTA ────────────────────────────────────────────────────────────────────
  // O buraco, MEDIDO num teste de adoção real (2026-08-21): um agente que ia instalar isto no próprio
  // projeto JÁ TINHA tools `AgileHarness` no ambiente dele — ligadas a OUTRA instalação, a de um
  // repositório de produção alheio. Toda a nossa documentação usa dêixis ("DESTE repositório", "o
  // repositório em que ele roda"), que é justamente o que o agente do outro lado do fio NÃO consegue
  // resolver. Ele desviou por dedução própria; se tivesse obedecido ao `register_board({id:"loja"})`
  // do guia, teria criado o board dele dentro do repositório de outra pessoa.
  //
  // Nenhuma superfície de PRIMEIRO CONTATO respondia isso: nem as instructions do initialize, nem
  // `mcp_onboarding`, nem os outros três resources, nem `list_boards`. A única resposta literal vivia no
  // payload de SUCESSO do próprio `register_board` — ou seja, depois da escrita.
  //
  // NÃO devolve dado de board (nem títulos, nem cards): só o endereço da instalação e o número de
  // boards, que é o suficiente para o agente reconhecer uma casa que não é a dele.
  defineResource(
    server,
    "target",
    URI_TARGET,
    {
      title: "Qual repositório este servidor opera",
      description:
        "O caminho absoluto da árvore que este servidor lê e escreve, e como ele chegou a ela. Leia ANTES " +
        "da primeira escrita (register_board, create_card, usm_capture) se houver QUALQUER chance de você " +
        "estar falando com mais de uma instalação — as tools não dizem de qual casa são, e escrever na " +
        "errada cria board de terceiro no repositório de terceiro.",
      mimeType: "application/json",
    },
    async () => {
      const declarado = process.env.AGILEHARNESS_TARGET?.trim();
      const raiz = findRepoRoot();
      const boards = await listBoards().catch(() => []);
      return {
        raiz,
        origem: declarado
          ? "AGILEHARNESS_TARGET (declarado no ambiente do serviço)"
          : "descoberta subindo até .git / turbo.json / storymap/boards",
        ehRepoGit: existsSync(path.join(raiz, ".git")),
        boards: boards.length,
        confira:
          "Se esta raiz não é o SEU projeto, PARE: você está falando com outra instalação. Não escreva — " +
          "suba a sua própria instância com AGILEHARNESS_TARGET apontando para o seu repositório.",
      };
    },
  );
  // ── R5 — O RELATÓRIO DE PRONTIDÃO ──────────────────────────────────────────────────────────────
  // RESOURCE, e não tool, de propósito. Este servidor já publica dezenas de tools, e o harness de
  // alguns clientes DEFERE o schema quando há muitas — a superfície de que um agente de diagnóstico
  // precisa PRIMEIRO é a pior candidata possível a ser deferida. Um resource é buscado sem isso.
  //
  // ⚠️ E ele NÃO é a superfície de instalação. Para ler isto a porta MCP já precisa estar armada, e no
  // primeiro contato ela não está (nada gera credencial no boot — ver mcp/token-bootstrap.ts). Quem
  // está instalando usa `node dist/ah-server.mjs --preflight`; este resource serve o agente que JÁ
  // conectou e está diagnosticando depois.
  defineResource(
    server,
    "preflight",
    URI_PREFLIGHT,
    {
      title: "Prontidão do ambiente (o que precisa ser verdade para isto funcionar)",
      description:
        "MEDE o host: o CLI do Claude Code que todo agente usa, as dependências de contenção e se o " +
        "bwrap SOBE de verdade, a identidade que assina os commits do motor, a pipeline herdável, se os " +
        "segredos do runtime estão fora do git e com a permissão certa. Cada item diz o que foi MEDIDO, " +
        "e o que reprova NOMEIA o conserto. O primeiro item diz de qual ambiente o relatório fala — do " +
        "serviço vivo ou deste processo — porque um PATH de shell mente sobre o PATH que um unit fixa.",
      mimeType: "application/json",
    },
    async () => {
      const { runPreflight } = await import("@/lib/storymap/preflight");
      const { spawnSync } = await import("node:child_process");
      let raiz: string | null = null;
      try {
        raiz = findRepoRoot();
      } catch {
        raiz = null;
      }
      return runPreflight({
        repoRoot: raiz,
        claudeName: loadRunnerConfig().autorun.claudeBin,
        run: (cmd, args) => {
          try {
            const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 1500 });
            if (r.error || r.status == null) return null;
            return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
          } catch {
            return null;
          }
        },
      });
    },
  );

}
