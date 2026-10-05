// A AUTORIZAÇÃO DO DONO para publicar código guardado — o lado da ferramenta do botão «Autorizar publicar».
//
// O QUE FALTAVA. O comando de deploy de um board podia sair com código de erro dizendo «há mudança que só o dono publica»
// (uma regra de dinheiro: o código que cobra). O alvo já sabia receber o sim dele — uma autorização gravada,
// presa à mudança EXATA (o diff daqueles arquivos) — e o plano já trazia o pedido em cada entrada
// (`ownerApproval: { subject, record }`). Só que nenhuma tela o mostrava: o Inbox dizia «Ninguém resolve daqui», o dono
// não tinha onde dizer sim, e a publicação do board inteiro ficava parada atrás de um card.
//
// O CONTRATO (do alvo; a ferramenta não conhece o script dele). O pedido traz o ASSUNTO (o hash do diff, base, head,
// arquivos) e, informativo, o texto do comando que o log imprimiu (`record`). No clique do dono a ferramenta escreve a
// autorização — o assunto é o do pedido, copiado — e roda o comando que o ALVO DECLAROU (settings.yaml →
// `deploy.proof.record.ownerApproval`, um argv com `{file}`), sem shell: o TEXTO `record` do log não escolhe o programa
// que roda com o privilégio do serviço. Quem confere que o assunto ainda é o do checkout é o ALVO, ao gravar: uma
// autorização de outra mudança é recusada lá (a frase é a que ele declara em `deploy.proof.staleMarkers`), e aqui vira
// «o código mudou».
// Depois a publicação é disparada de novo pelo mesmo efeito do «Publicar de novo».
//
// O núcleo ({@link authorizeOwnerPublish}) só fala por dependências — o disco, o comando e o disparo ficam na borda
// ({@link defaultOwnerApprovalDeps}).

import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { findRepoRoot } from "@/lib/storymap/paths";
import { buildOwnerApproval, declaredStaleMarkers, recordRefusedAsStale, runDeclaredRecord, type OwnerApproval, type OwnerApprovalRequest } from "./deploy-proof";
import { cardBoardOf, freshApprovals, grantDeployApprovals, markRerequested, mutateDeployBlocks, readDeployBlocks, type DeployBlockRow } from "./deploy-blocks";

const pexec = promisify(execFile);

export type RecordOutcome = { ok: true } | { ok: false; stale: boolean; error: string };

export interface OwnerApprovalDeps {
  /** a linha da causa no livro de bloqueios, ou null. */
  readRow(board: string, causeKey: string): Promise<DeployBlockRow | null>;
  /** grava a autorização pelo comando do alvo; `stale` = o alvo recusou porque a mudança já é outra. */
  record(approval: OwnerApproval, request: OwnerApprovalRequest): Promise<RecordOutcome>;
  /** tira da linha os pedidos atendidos (o botão some na hora). */
  grant(board: string, causeKey: string, hashes: string[]): Promise<void>;
  /** dispara de novo a publicação do card — o mesmo efeito do «Publicar de novo». */
  republish(board: string, cardId: string): Promise<{ ok: boolean; error?: string }>;
  /**
   * REFAZ os pedidos da causa NA HORA ({@link rerequestPublishRequests}): roda a medição/o deploy do pacote no board que o
   * PUBLICA, mesmo sem nada staged, e marca a linha «refazendo o pedido…» até o plano novo chegar. `staleHashes` = os
   * pedidos que o alvo recusou por serem de outra mudança (saem da linha: o botão deles autorizaria o que já mudou).
   */
  rerequest(row: DeployBlockRow, staleHashes: string[]): Promise<RerequestOutcome>;
  now(): number;
}

/** O desfecho de refazer os pedidos: por qual board (e se pelo plano ou pelo deploy), ou por que não deu. */
export type RerequestOutcome =
  | { ok: true; board: string; via: "plan" | "deploy" }
  | { ok: false; reason: "no-publisher" | "not-run"; board: string | null; error: string };

export type AuthorizeOutcome =
  | { ok: true; recorded: number; stale: number; republished: string | null; message: string }
  | { ok: false; error: string };

/**
 * A gravação recusou porque a autorização é de OUTRA mudança (o código guardado andou desde o pedido)? A frase é a do
 * script do ALVO, então é o ALVO quem a declara (`deploy.proof.staleMarkers`) — a ferramenta não supõe o idioma nem o
 * texto de erro dele. SEM marcas nunca é «stale»: a falha vira erro nomeado para o dono, jamais um «o código mudou»
 * adivinhado. PURA sobre `markers` (o default lê a declaração do alvo).
 */
export function approvalRefusedAsStale(stderr: string, markers: readonly string[] = declaredStaleMarkers()): boolean {
  return recordRefusedAsStale(stderr, markers);
}

/** Quantos cards da causa se tenta republicar até um disparar (o deploy é do pacote: um basta). */
const REPUBLISH_TRIES = 8;

/**
 * O clique do dono em «Autorizar publicar»: grava uma autorização por pedido da causa e dispara a publicação de novo.
 * Nada gravado ⇒ erro (com o porquê, em palavras do dono). Gravou ⇒ os pedidos atendidos saem da linha e UM card da
 * causa republica (o que carrega o código guardado primeiro; se ele não estiver num passo que publica, o próximo).
 */
export async function authorizeOwnerPublish(deps: OwnerApprovalDeps, input: { board: string; causeKey: string; via?: string }): Promise<AuthorizeOutcome> {
  const row = await deps.readRow(input.board, input.causeKey);
  // só os pedidos que ainda valem: o que o sistema já sabe velho (um arquivo do assunto mudou na main) autorizaria o que mudou
  const requests = row?.decider === "owner" ? freshApprovals(row) : [];
  if (!row || requests.length === 0) {
    if (row?.decider === "owner" && row.staleApprovals?.length) {
      return { ok: false, error: `O código guardado mudou desde este pedido — nada foi autorizado. Refaça o pedido pela Esteira do board «${row.board}» («Refazer os pedidos de publicação»).` };
    }
    return { ok: false, error: "Não há autorização pendente para esta publicação: ela já foi dada, ou o plano de publicação mudou. Atualize o Inbox." };
  }
  const at = new Date(deps.now()).toISOString();
  const granted: string[] = [];
  const staleHashes: string[] = [];
  let firstError: string | null = null;
  for (const request of requests) {
    const r = await deps.record(buildOwnerApproval(request, { at, via: input.via ?? "inbox", card: row.attributedCard }), request);
    if (r.ok) granted.push(request.subject.hash);
    else if (r.stale) staleHashes.push(request.subject.hash);
    else firstError ??= r.error;
  }
  const stale = staleHashes.length;
  const candidates = [...new Set([row.attributedCard, ...row.cardIds].filter((id): id is string => !!id))].slice(0, REPUBLISH_TRIES);
  // cada card republica no board DELE (a linha mora no board que publica o pacote; o card pode ser de outro)
  const republish = async (): Promise<string | null> => {
    for (const cardId of candidates) if ((await deps.republish(cardBoardOf(row, cardId), cardId).catch(() => ({ ok: false }))).ok) return cardId;
    return null;
  };
  if (granted.length === 0) {
    if (stale > 0) {
      // O pedido envelheceu: a medição/o deploy do pacote roda AGORA, no board que o publica, só para o plano dizer qual é
      // a mudança de agora — e o Inbox mostra «refazendo o pedido…» até ele chegar.
      const again = await deps.rerequest(row, staleHashes).catch((err): RerequestOutcome => ({ ok: false, reason: "not-run", board: null, error: err instanceof Error ? err.message : String(err) }));
      return { ok: false, error: `O código guardado mudou desde este pedido — nada foi autorizado. ${rerequestWords(again, row.pkg)}` };
    }
    return { ok: false, error: `A autorização não pôde ser gravada: ${firstError ?? "o comando do board não respondeu"}. Nada foi publicado.` };
  }
  await deps.grant(input.board, input.causeKey, granted).catch(() => {});
  const republished = await republish();
  const partial = stale > 0 || firstError ? ` ${granted.length} de ${requests.length} pedido(s) foram gravados; o restante volta ao Inbox com a mudança de agora.` : "";
  const message = republished
    ? `Autorização gravada — a publicação foi disparada de novo. Se outra coisa ainda segurar, o Inbox diz o quê.${partial}`
    : `Autorização gravada. Nenhum card desta causa está num passo que publica agora; a próxima publicação do board já a encontra.${partial}`;
  return { ok: true, recorded: granted.length, stale, republished, message };
}

/** O que o dono lê sobre o pedido refeito: por onde ele vem, ou por que não vem (nunca «volta em instantes» sem motivo). PURA. */
export function rerequestWords(o: RerequestOutcome, pkg: string): string {
  if (o.ok) {
    return `O sistema já está refazendo o pedido: ${o.via === "plan" ? "a medição" : "o deploy"} do pacote «${pkg}» roda agora no board «${o.board}», que o publica (sem publicar nada enquanto houver o que só você autoriza). O Inbox mostra «refazendo o pedido…» até o pedido novo chegar.`;
  }
  if (o.reason === "no-publisher") {
    return `Nenhum board publica o pacote «${pkg}» (nenhum board.yaml declara o deploy dele), então não há como refazer o pedido daqui: declare o deploy desse pacote no board que o publica, ou publique por fora.`;
  }
  return `O sistema tentou refazer o pedido no board «${o.board ?? "?"}», mas a medição não rodou: ${o.error}. Nada foi publicado; tente de novo pela Esteira desse board («Refazer os pedidos de publicação»).`;
}

/** As dependências de {@link rerequestPublishRequests} — o livro, o board que publica e a medição/o deploy dele. */
export interface RerequestDeps {
  publisherOf(pkg: string): Promise<{ board: string } | null>;
  /** marca as causas como «refazendo o pedido…» (e tira da linha os pedidos recusados por velhos). */
  mark(board: string, causeKeys: string[], at: string, dropHashes: string[]): Promise<void>;
  /** desfaz a marca (a medição não rodou: o Inbox volta a mostrar a causa como ela está). */
  unmark(board: string, causeKeys: string[]): Promise<void>;
  /**
   * roda AGORA a medição (o plano declarado, sem a janela de 15 min) ou, sem plano, o deploy do board sem card.
   * `planOnly` — SÓ o plano (a re-medição automática: medir nunca publica; sem plano declarado ⇒ recusa, nada roda).
   */
  measure(board: string, opts?: { planOnly?: boolean }): Promise<{ ok: true; via: "plan" | "deploy" } | { ok: false; error: string }>;
  now(): number;
}

/**
 * REFAZ os pedidos de publicação do pacote `pkg` NA HORA, no board que o PUBLICA (o cujo deploy declara o pacote): marca
 * as causas do dono dele «refazendo o pedido…» e roda a medição (o `deploy.planCommand`, sem a janela) ou, sem plano, o
 * deploy do board — mesmo sem nada staged: com itens do dono pendentes o deploy não publica nada, só refaz os pedidos
 * (a saída 3). O mesmo caminho serve o «stale» de uma autorização e o botão do operador na Esteira. Sem board que publique
 * o pacote ⇒ diz isso (nada marcado).
 */
export async function rerequestPublishRequests(
  deps: RerequestDeps,
  input: { pkg: string; rows: readonly DeployBlockRow[]; staleHashes?: string[]; planOnly?: boolean },
): Promise<RerequestOutcome> {
  const pub = await deps.publisherOf(input.pkg);
  if (!pub) return { ok: false, reason: "no-publisher", board: null, error: `nenhum board publica o pacote «${input.pkg}»` };
  const keys = [...new Set(input.rows.filter((r) => r.pkg === input.pkg && r.decider === "owner").map((r) => r.causeKey))];
  await deps.mark(pub.board, keys, new Date(deps.now()).toISOString(), input.staleHashes ?? []);
  const ran = await deps.measure(pub.board, input.planOnly ? { planOnly: true } : undefined).catch((err): { ok: false; error: string } => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  if (!ran.ok) {
    await deps.unmark(pub.board, keys).catch(() => {});
    return { ok: false, reason: "not-run", board: pub.board, error: ran.error };
  }
  return { ok: true, board: pub.board, via: ran.via };
}

/** As linhas `needs-human` do board — os pedidos de publicação que esperam alguém (o que o botão da Esteira refaz). PURA. */
export function needsHumanRows(rows: readonly DeployBlockRow[], board: string): DeployBlockRow[] {
  return rows.filter((r) => r.board === board && r.phase === "needs-human");
}

/**
 * O botão do operador na Esteira («Refazer os pedidos de publicação»): a MESMA re-medição do «stale», para cada pacote das
 * linhas `needs-human` do board. Sem linha assim ⇒ diz que não há o que refazer. Devolve uma frase por pacote.
 */
export async function rerequestBoardPublishRequests(
  board: string,
  deps: RerequestDeps & { readRows(): Promise<DeployBlockRow[]> },
): Promise<{ ok: boolean; message: string }> {
  const rows = needsHumanRows(await deps.readRows(), board);
  if (rows.length === 0) return { ok: false, message: "Não há pedido de publicação esperando alguém neste board — nada a refazer." };
  const outcomes: Array<{ pkg: string; o: RerequestOutcome }> = [];
  for (const pkg of [...new Set(rows.map((r) => r.pkg))]) outcomes.push({ pkg, o: await rerequestPublishRequests(deps, { pkg, rows }) });
  return { ok: outcomes.some((x) => x.o.ok), message: outcomes.map((x) => rerequestWords(x.o, x.pkg)).join(" ") };
}

/** As dependências de produção de {@link rerequestPublishRequests}. */
export function defaultRerequestDeps(): RerequestDeps {
  return {
    publisherOf: async (pkg) => {
      const { publisherResolver, readPublisherCandidates } = await import("./deploy-blocks");
      return publisherResolver(await readPublisherCandidates())(pkg);
    },
    mark: async (board, keys, at, drop) => {
      await mutateDeployBlocks((rows) => markRerequested(rows, board, keys, at, drop));
    },
    unmark: async (board, keys) => {
      await mutateDeployBlocks((rows) => markRerequested(rows, board, keys, null, []));
    },
    measure: async (board, opts) => {
      const [{ readBoardConfig }, blocks] = await Promise.all([import("@/lib/storymap/repo"), import("./deploy-blocks")]);
      const config = await readBoardConfig(board);
      const { isOrganizeOnly, ORGANIZE_ONLY_WHY } = await import("@/lib/storymap/organize-only-core");
      if (isOrganizeOnly(config)) return { ok: false, error: `${ORGANIZE_ONLY_WHY}: nada é medido nem publicado a partir dele` };
      if (config.deploy?.planCommand?.trim()) {
        // a varredura do board, com a re-medição FORÇADA (sem a janela de 15 min): morta ⇒ fecha; re-vista ⇒ os pedidos de
        // agora entram na linha e o «refazendo o pedido…» termina
        const base = await blocks.defaultDeployBlocksSweepDeps();
        const { defaultExec } = await import("./worktree");
        await blocks.sweepDeployBlocks(board, {
          ...base,
          remeasure: (b, c, rows) => blocks.remeasureBoardCauses(b, c, rows, { exec: defaultExec, repoRoot: findRepoRoot(), now: Date.now(), force: true }),
        });
        return { ok: true, via: "plan" };
      }
      if (opts?.planOnly) return { ok: false, error: "o board não declara deploy.planCommand (a medição que não publica)" };
      // sem plano declarado: o deploy do board, sem card — o desfecho (a saída 3 com os pedidos, ou o deploy limpo) chega
      // pelo onDone do registro (trigger-runner-channel.ts → refreshRowsAfterDeploy / closeCausesAfterCleanDeploy)
      const { fireDeployBoard } = await import("./entry-effects");
      const r = await fireDeployBoard(board);
      if (!r) return { ok: false, error: "o deploy do board não respondeu" };
      if (r.fired || r.inFlight || r.attached) return { ok: true, via: "deploy" };
      return { ok: false, error: r.reason ?? "o deploy não disparou" };
    },
    now: () => Date.now(),
  };
}

/** As dependências de produção: o livro no disco, o comando do alvo (sem shell, no repositório alvo) e o efeito de entrada. */
export function defaultOwnerApprovalDeps(): OwnerApprovalDeps {
  return {
    readRow: async (board, causeKey) => (await readDeployBlocks()).find((r) => r.board === board && r.causeKey === causeKey) ?? null,
    // O comando que GRAVA é o que o ALVO declarou (settings.yaml → deploy.proof.record.ownerApproval) — nunca o texto
    // `request.record` que o log do deploy imprimiu: uma linha de saída de comando não escolhe o programa que roda
    // com o privilégio do serviço.
    record: async (approval) => {
      const { withHarnessTempDir } = await import("./temp");
      const { resolveDeclaredProgram } = await import("./product-deploy");
      return withHarnessTempDir("owner-approval", async (dir) => {
        const file = path.join(dir, "approval.json");
        await fsp.writeFile(file, `${JSON.stringify(approval, null, 2)}\n`, "utf8");
        return runDeclaredRecord("ownerApproval", file, {
          resolveProgram: (name) => resolveDeclaredProgram(name),
          exec: async (program, args) => {
            await pexec(program, args, { cwd: findRepoRoot(), timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
          },
        });
      });
    },
    grant: async (board, causeKey, hashes) => {
      await mutateDeployBlocks((rows) => grantDeployApprovals(rows, board, causeKey, hashes));
    },
    republish: async (board, cardId) => {
      const [{ readBoardConfig, readCard }, { republishRefusal }] = await Promise.all([import("@/lib/storymap/repo"), import("@/lib/storymap/preconditions")]);
      const [config, card] = await Promise.all([readBoardConfig(board), readCard(board, cardId)]);
      if (!card) return { ok: false, error: `card não encontrado: ${cardId}` };
      const refusal = republishRefusal(card, config);
      const effect = config.statuses.find((s) => s.id === card.status)?.onEnter;
      if (refusal || !effect) return { ok: false, error: refusal ?? "este passo não dispara ação automática" };
      const { runEntryEffect } = await import("./entry-effects");
      void runEntryEffect(effect, board, cardId).catch((err) => console.error(`[owner-approval republish ${effect} ${board}/${cardId}]`, err instanceof Error ? err.message : err));
      return { ok: true };
    },
    rerequest: (row, staleHashes) => rerequestPublishRequests(defaultRerequestDeps(), { pkg: row.pkg, rows: [row], staleHashes }),
    now: () => Date.now(),
  };
}
