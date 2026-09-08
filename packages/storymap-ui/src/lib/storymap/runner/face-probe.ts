// face-probe.ts — the harness half of the published-face canary: run the DEPLOYMENT'S OWN fidelity
// check and read its verdict. Zero product names, zero product imports — the consumer repository
// declares the command (`board.yaml` `deploy.canaryCommand`, else `settings.yaml` `deploy.canaryCommand`)
// and this module runs THAT. It knows nothing about what the command measures, only about the verdict
// shape: per surface, "what we EXPECTED it to serve" vs "what it ACTUALLY serves". A consumer proving
// that with a /version.json, an ETag or a build digest plugs in unchanged.
//
// WHAT THIS REPLACED, AND WHY (acme/story-w3y6ml, 2026-07-22 — the 3rd recurrence of one defect,
// after story-qb8z2c was reverted 3x into backoff and story-b3es7k fixed only half of it):
//
// The canary used to be a SECOND AUTHORITY on the question "is this card's code live?", asking
// "does the sha served at the BOARD's declared surface CONTAIN the card's `releasedSha`?". That
// question is unsound on both halves wherever several apps share one origin and the build is
// diff-aware:
//   - the surface a BOARD declares is not the surface the CARD's code reaches (a card can ship
//     entirely inside an app served on a different path), so the probe measured a DIFFERENT app; and
//   - `releasedSha` is repo-wide, while an app whose inputs did not change SKIPS its build and keeps
//     serving its previous artifact — which legitimately does NOT contain `releasedSha`.
// So a correct deploy was called "stale", the card was reverted out of "No ar", and the ancestry
// ruler (deploy-reconcile) then immediately contradicted the revert. Two mechanisms, one question,
// opposite answers — that contradiction WAS the defect. Measured that day: the surface published
// `3d06c0b31` and served `3d06c0b31`.
//
// Now there is ONE ruler per question:
//   - "is this card's code live?"             → measureDeployAncestry, over the card's deploy targets
//   - "does the CDN serve what we published?" → this canary, per surface, with no card in sight
// This module therefore never sees a `releasedSha`, never shells out to git, and never decides which
// surface belongs to whom — the deployment answers that, because only it knows its own topology.
// Guarded by a test that fails if `releasedSha` reappears here.
//
// FAIL-OPEN ON READING. An absent command, an unparseable verdict, a thrown probe: all "unknown",
// never "stale". Only a surface the deployment CONFIRMS is serving other bytes is a failure.
//
// PURE verdict + injectable exec (testable without a network). SERVER-ONLY (the canary shells out).

import type { BoardConfig, RunnerSettings } from "@/lib/storymap/types";
import type { ExecFn } from "./worktree";
// story-dlsxfj (3ª passada) — o canário é o TERCEIRO campo de comando do MESMO bloco `deploy:` do
// board.yaml, e era o único sem régua: ele chegava a `/bin/sh -c` (o `defaultExec` é
// `promisify(child_process.exec)`) como STRING CRUA, sem parser, sem allow-list e sem re-citação. Ou seja,
// todo o trabalho das duas ondas anteriores — que cobriu `surfaces[].deployCmd` e `kind=command` — era
// contornável escrevendo o payload no campo vizinho. A régua vive num módulo PURO e sem imports de
// propósito: este arquivo NÃO pode importar `deploy.ts` (o import de `product-deploy` de lá lê um manifesto
// em tempo de carga — a mina que forçou o split deste módulo), e foi por isso que o campo ficou de fora.
import { authorizeDeployCommand, quoteArgv } from "./deploy-command-guard";

/**
 * O comando de canário APROVADO para execução — uma string que já passou pela régua (board-data) ou que
 * vem do canal do OPERADOR (settings.yaml / env do serviço).
 *
 * É um tipo MARCADO (brand) e não um `string` porque a marca é o chokepoint: {@link runFaceCanary} só
 * aceita este tipo, então uma superfície NOVA que tente executar um `canaryCommand` cru não compila. A
 * régua deixa de ser convenção — a mesma lição do chokepoint de frontmatter e do de env de spawn, que
 * precisaram de duas ondas cada por não terem obrigação.
 */
declare const AUTHORIZED_CANARY: unique symbol;
export type AuthorizedCanaryCommand = string & { readonly [AUTHORIZED_CANARY]: true };

/**
 * A ÚNICA porta pela qual uma string NÃO examinada pela régua vira {@link AuthorizedCanaryCommand}: o
 * comando declarado pelo OPERADOR.
 *
 * Por que ele não passa pela régua: `settings.yaml` e o env do serviço (systemd) NÃO são board-data. Pela
 * régua de proveniência deste repositório (`classifyDeltaPath`, release.ts) `storymap/boards/**` é a classe
 * `board-data` — auto-skip do gate, editável por humano E por agente — enquanto `storymap/settings.yaml` é
 * `control`: um delta nela é justamente o que o gate examina COM MAIS escrutínio, porque pode desligar o
 * próprio gate. Submeter o canal do operador à allow-list de lançadores quebraria o canário REAL de hoje
 * (`node scripts/deploy/face-canary.mjs`) sem fechar buraco nenhum: quem escreve ali já é quem escolhe o
 * que o serviço roda.
 *
 * O lint em `deploy-command-guard.test.ts` mantém esta função com UM chamador (o resolvedor abaixo): ela é
 * a lavagem de proveniência, e uma segunda chamada seria a régua contornada de novo.
 */
export function trustedCanaryFromOperator(command: string): AuthorizedCanaryCommand {
  return command as AuthorizedCanaryCommand;
}

/** O veredito completo do resolvedor: o comando pronto, DE ONDE ele veio, e o motivo NOMEADO da recusa. */
export interface CanaryCommandVerdict {
  /** pronto para execução (argv re-citada, no caso do board); `null` quando não há canário ou foi recusado */
  command: AuthorizedCanaryCommand | null;
  /** `board` = board.yaml (board-data, passa pela régua); `deployment` = settings.yaml/env (operador) */
  source: "board" | "deployment" | null;
  /** presente SÓ quando um canário DECLARADO no board foi recusado — nunca junto com `command` */
  refusal: string | null;
}

/**
 * PURE — WHICH canary answers for this board: the board's own (`board.yaml` `deploy.canaryCommand`)
 * else the deployment default (`settings.yaml` `deploy.canaryCommand`), else none.
 *
 * Board-first because a repository can publish SEVERAL products to SEVERAL surfaces — one board's
 * face says nothing about another's. A deployment whose boards all share one published surface just
 * declares it once, in settings. "None" is a real answer (fidelity simply is not checked): the
 * harness never falls back to a URL of its own, because a harness-chosen default surface is exactly
 * what measured a different app and reverted live cards.
 *
 * story-dlsxfj — o canário do BOARD passa pela régua dos comandos declarados
 * ({@link authorizeDeployCommand}) e sai RE-CITADO palavra por palavra, porque ele é executado por um
 * shell (`/bin/sh -c`) que expandiria `$(…)`/`$VAR` de dentro de aspas duplas. Uma declaração recusada NÃO
 * cai para o default do deployment: o board declarou uma superfície PRÓPRIA, e sondar a do deployment
 * mediria outro app — a causa raiz que este módulo existe para não repetir. Recusa ⇒ nenhum canário
 * (fail-open na leitura, como toda a cadeia do canário).
 */
export function resolveCanaryVerdict(
  board: Pick<BoardConfig, "deploy"> | null | undefined,
  settings: Pick<RunnerSettings, "deploy"> | null | undefined,
): CanaryCommandVerdict {
  const boardCmd = board?.deploy?.canaryCommand?.trim();
  if (boardCmd) {
    const { argv, refusal } = authorizeDeployCommand(boardCmd);
    if (!argv) {
      return {
        command: null,
        source: "board",
        refusal:
          `deploy.canaryCommand do board recusado — ${refusal}. O canário roda como root a partir de uma ` +
          `linha de board-data: declare-o como receita versionada (just <receita>) ou no canal do operador ` +
          `(settings.yaml deploy.canaryCommand / STORYMAP_DEPLOY_CANARY_COMMAND)`,
      };
    }
    return { command: quoteArgv(argv) as AuthorizedCanaryCommand, source: "board", refusal: null };
  }
  const deploymentCmd = settings?.deploy?.canaryCommand?.trim();
  return deploymentCmd
    ? { command: trustedCanaryFromOperator(deploymentCmd), source: "deployment", refusal: null }
    : { command: null, source: null, refusal: null };
}

/**
 * O comando a executar, ou `null`. Mesma assinatura de sempre para os chamadores (face-verify, steward),
 * agora sobre {@link resolveCanaryVerdict}.
 *
 * NÃO é estritamente pura, e é de propósito: uma recusa GRITA no log do serviço. Recusa muda seria
 * indistinguível de "nenhum canário declarado" — e é isso que o chamador loga hoje —, então o operador
 * veria "fidelidade não checada" para sempre, sem nunca saber que o que ele declarou foi rejeitado. Mesmo
 * padrão do alarme de drift dos caminhos de leitura (repo.ts): log-only, nunca lança, nunca muda a decisão.
 */
export function resolveCanaryCommand(
  board: Pick<BoardConfig, "deploy"> | null | undefined,
  settings: Pick<RunnerSettings, "deploy"> | null | undefined,
): AuthorizedCanaryCommand | null {
  const verdict = resolveCanaryVerdict(board, settings);
  if (verdict.refusal) console.warn(`[face-probe] ${verdict.refusal}`);
  return verdict.command;
}

export type FaceSurfaceVerdict = "fresh" | "stale" | "unknown";

/** One published surface, as the deployment's canary reported it. The ids/urls are OPAQUE — the
 *  harness never interprets them, it only relays them to the operator. */
export interface FaceSurface {
  id: string;
  url: string;
  /** what the deployment MEANT this surface to serve — a build id, a version, a digest; whatever the
   *  producer can prove it published (null = unreadable). */
  expected: string | null;
  /** what the surface ACTUALLY serves, read from the surface itself (null = unreadable). */
  actual: string | null;
  verdict: FaceSurfaceVerdict;
}

/** The deploy-wide verdict. `ok: false` ONLY when some surface is confirmed serving other bytes. */
export interface FaceCanaryResult {
  ok: boolean;
  surfaces: FaceSurface[];
  /** false when the canary could not be run/parsed at all — the fail-open case (never a failure). */
  measured: boolean;
}

/**
 * The line the deployment's canary prints LAST on stdout: `FACE_CANARY {json}`.
 *
 * A MARKER, not prose. The contract it replaces was an unguarded English sentence
 * ("  last seen: <sha>") matched by a regex, with nothing on either side to notice when one of them
 * drifted. Same shape and same cross-language guard as FACE_GATE_FAIL (`lib/turbo-failure.mjs` ↔
 * `face-gate-detail.ts`): the producing script's own test asserts this exact literal.
 */
export const FACE_CANARY_MARKER = "FACE_CANARY";

/** The unmeasured result — every fail-open path returns THIS, so no caller has to branch on null. */
export const FACE_CANARY_UNMEASURED: FaceCanaryResult = { ok: true, surfaces: [], measured: false };

/**
 * PURE: lift the verdict out of a canary run's output. Takes the LAST marker line (a retry inside a
 * single log must not be decided by its first attempt), and treats ANY malformed payload as
 * unmeasured — a canary we cannot read is not a canary that found staleness.
 */
export function parseFaceCanaryVerdict(output: string): FaceCanaryResult {
  const lines = String(output ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(`${FACE_CANARY_MARKER} `));
  const last = lines[lines.length - 1];
  if (!last) return FACE_CANARY_UNMEASURED;
  try {
    const raw: unknown = JSON.parse(last.slice(FACE_CANARY_MARKER.length + 1));
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { surfaces?: unknown }).surfaces)) {
      return FACE_CANARY_UNMEASURED;
    }
    const surfaces: FaceSurface[] = [];
    for (const s of (raw as { surfaces: unknown[] }).surfaces) {
      if (!s || typeof s !== "object") continue;
      const row = s as Record<string, unknown>;
      surfaces.push({
        id: String(row.id ?? "?"),
        url: String(row.url ?? "?"),
        expected: typeof row.expected === "string" ? row.expected : null,
        actual: typeof row.actual === "string" ? row.actual : null,
        // an unrecognised verdict degrades to "unknown" — never to "stale" (fail-open on reading)
        verdict: row.verdict === "fresh" || row.verdict === "stale" ? row.verdict : "unknown",
      });
    }
    // `ok` is DERIVED here rather than trusted from the payload: what a set of surface verdicts MEANS
    // is the harness's call, so a producer can never claim "ok" while reporting a stale surface.
    return { ok: !surfaces.some((s) => s.verdict === "stale"), surfaces, measured: true };
  } catch {
    return FACE_CANARY_UNMEASURED;
  }
}

/**
 * Run the deployment's declared fidelity canary and parse its verdict. Best-effort: a missing
 * command, a spawn failure, or a non-zero exit with no parseable marker all resolve to
 * {@link FACE_CANARY_UNMEASURED}. The EXIT CODE is deliberately NOT evidence — only the marker is —
 * so a canary that dies on an unrelated error can never be read as "the face is stale".
 *
 * `defaultExec` REJECTS on non-zero with `{code, stdout, stderr}` attached, so the failure path still
 * carries the output holding the verdict (a confirmed-stale run exits non-zero BY DESIGN).
 *
 * story-dlsxfj — o `command` é {@link AuthorizedCanaryCommand}, não `string`: quem executa aqui é
 * `/bin/sh -c`, então um comando de board-data que não tenha passado pela régua seria execução arbitrária
 * como root. O tipo marcado é o chokepoint — só {@link resolveCanaryVerdict} (régua) e
 * {@link trustedCanaryFromOperator} (canal do operador) produzem esse tipo, e uma superfície nova que
 * tente passar uma string crua NÃO COMPILA.
 */
export async function runFaceCanary(
  exec: ExecFn,
  opts: { repoRoot: string; command: AuthorizedCanaryCommand | null | undefined; timeoutMs?: number },
): Promise<FaceCanaryResult> {
  const command = opts.command?.trim();
  if (!command) return FACE_CANARY_UNMEASURED;
  try {
    const r = await exec(command, { cwd: opts.repoRoot, timeout: opts.timeoutMs ?? 180_000 });
    return parseFaceCanaryVerdict(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return parseFaceCanaryVerdict(`${err?.stdout ?? ""}\n${err?.stderr ?? ""}`);
  }
}

/** PURE: the surfaces the canary CONFIRMED are serving something other than what was published. */
export function staleSurfaces(result: FaceCanaryResult): FaceSurface[] {
  return result.surfaces.filter((s) => s.verdict === "stale");
}

/** PURE: one operator-readable clause per confirmed-stale surface — what the finding must SAY, since
 *  "mosaico.app serve um sha antigo" was exactly the claim that turned out to be false. */
export function describeStale(result: FaceCanaryResult): string {
  return staleSurfaces(result)
    .map((s) => `${s.url} serve ${s.actual ?? "<ilegível>"}, mas publicamos ${s.expected ?? "<ilegível>"}`)
    .join("; ");
}
