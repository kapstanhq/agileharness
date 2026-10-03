// A AUTORIZAÇÃO DO DONO para publicar código guardado — o lado da ferramenta do botão «Autorizar publicar».
//
// O QUE FALTAVA. O comando de deploy de um board podia sair com código de erro dizendo «há mudança que só o dono publica»
// (uma regra de dinheiro: o código que cobra). O alvo já sabia receber o sim dele — uma autorização gravada,
// presa à mudança EXATA (o diff daqueles arquivos) — e o plano já trazia o pedido em cada entrada
// (`ownerApproval: { subject, record }`). Só que nenhuma tela o mostrava: o Inbox dizia «Ninguém resolve daqui», o dono
// não tinha onde dizer sim, e a publicação do board inteiro ficava parada atrás de um card.
//
// O CONTRATO (do alvo; a ferramenta não conhece o script dele). O pedido traz o ASSUNTO (o hash do diff, base, head,
// arquivos) e o comando que grava (`record`, com `<approval.json>` no lugar do arquivo). No clique do dono a ferramenta
// escreve a autorização — o assunto é o do pedido, copiado — e roda esse comando, sem shell. Quem confere que o assunto
// ainda é o do checkout é o ALVO, ao gravar: uma autorização de outra mudança é recusada lá, e aqui vira «o código mudou».
// Depois a publicação é disparada de novo pelo mesmo efeito do «Publicar de novo».
//
// O núcleo ({@link authorizeOwnerPublish}) só fala por dependências — o disco, o comando e o disparo ficam na borda
// ({@link defaultOwnerApprovalDeps}).

import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { findRepoRoot } from "@/lib/storymap/paths";
import { OWNER_APPROVAL_PLACEHOLDER, buildOwnerApproval, recordCommandFor, type OwnerApproval, type OwnerApprovalRequest } from "./deploy-proof";
import { grantDeployApprovals, mutateDeployBlocks, readDeployBlocks, type DeployBlockRow } from "./deploy-blocks";

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
  now(): number;
}

export type AuthorizeOutcome =
  | { ok: true; recorded: number; stale: number; republished: string | null; message: string }
  | { ok: false; error: string };

/** A gravação recusou porque a autorização é de OUTRA mudança (o código guardado andou desde o pedido)? PURA. */
export function approvalRefusedAsStale(stderr: string): boolean {
  return /OUTRA mudança|another change|OUTRO assunto|another subject/i.test(stderr ?? "");
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
  const requests = row?.decider === "owner" ? (row.approvals ?? []) : [];
  if (!row || requests.length === 0) {
    return { ok: false, error: "Não há autorização pendente para esta publicação: ela já foi dada, ou o plano de publicação mudou. Atualize o Inbox." };
  }
  const at = new Date(deps.now()).toISOString();
  const granted: string[] = [];
  let stale = 0;
  let firstError: string | null = null;
  for (const request of requests) {
    const r = await deps.record(buildOwnerApproval(request, { at, via: input.via ?? "inbox", card: row.attributedCard }), request);
    if (r.ok) granted.push(request.subject.hash);
    else if (r.stale) stale += 1;
    else firstError ??= r.error;
  }
  const candidates = [...new Set([row.attributedCard, ...row.cardIds].filter((id): id is string => !!id))].slice(0, REPUBLISH_TRIES);
  const republish = async (): Promise<string | null> => {
    for (const cardId of candidates) if ((await deps.republish(input.board, cardId).catch(() => ({ ok: false }))).ok) return cardId;
    return null;
  };
  if (granted.length === 0) {
    if (stale > 0) {
      // O pedido envelheceu: a publicação roda de novo só para o plano dizer qual é a mudança de AGORA.
      await republish();
      return { ok: false, error: "O código guardado mudou desde este pedido — nada foi autorizado. O sistema está refazendo o pedido com a mudança de agora; ele volta ao Inbox em instantes." };
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

/** As dependências de produção: o livro no disco, o comando do alvo (sem shell, no repositório alvo) e o efeito de entrada. */
export function defaultOwnerApprovalDeps(): OwnerApprovalDeps {
  return {
    readRow: async (board, causeKey) => (await readDeployBlocks()).find((r) => r.board === board && r.causeKey === causeKey) ?? null,
    record: async (approval, request) => {
      const { withHarnessTempDir } = await import("./temp");
      return withHarnessTempDir("owner-approval", async (dir) => {
        const file = path.join(dir, "approval.json");
        await fsp.writeFile(file, `${JSON.stringify(approval, null, 2)}\n`, "utf8");
        const argv = recordCommandFor(request.record, file, OWNER_APPROVAL_PLACEHOLDER);
        if (!argv) return { ok: false as const, stale: false, error: `o comando de gravação está fora do contrato: ${request.record.slice(0, 120)}` };
        try {
          await pexec(argv[0], argv.slice(1), { cwd: findRepoRoot(), timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
          return { ok: true as const };
        } catch (err) {
          const stderr = String((err as { stderr?: unknown }).stderr ?? (err instanceof Error ? err.message : err));
          return { ok: false as const, stale: approvalRefusedAsStale(stderr), error: stderr.trim().slice(-300) };
        }
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
    now: () => Date.now(),
  };
}
