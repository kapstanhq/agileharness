// orchestrator-spawn.ts — WS8 (F7) — the IO that launches ONE copiloto run: a headless
// `claude -p "/harness-orchestrator <board> <mode> --tick"` wired to the AgileHarness MCP surface. Board-level
// (no card worktree, no merge train) — the copiloto reads the board over MCP and acts gate-respecting.
//
// The AgileHarness MCP server is the running service's own HTTP endpoint (/api/mcp/<token>/<transport>), so the
// spawn mounts an on-the-fly config pointing there. O token é o SCOPED do orquestrador
// (AGILEHARNESS_MCP_TOKEN_ORCH, nível `write`) — NÃO o token full do operador. Fail-open: sem token ⇒ SKIP com log
// (o Jido não age sem as tools, mas o tick nunca quebra). Detached + unref'd so the run outlives the tick
// that started it; board-data cwd = repo root.
//
// Wake: o run agora escreve a saída (`--output-format json`) num arquivo temporário e, ao morrer, devolve o
// CUSTO REAL (total_cost_usd) + o RESUMO (o texto final) via `onResult` — é assim que o budget de $/dia deixa
// de ser decorativo (o caller cobrava sempre 0) e que a UI consegue dizer O QUE o Jido fez no último tick.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { makeHarnessTempDir } from "./temp";
import os from "node:os";
import { findRepoRoot } from "@/lib/storymap/paths";
import { readCopilotSessionPointer, writeCopilotSessionPointer } from "@/lib/storymap/copilot/session-store";
import { locateTranscript } from "@/lib/storymap/copilot/transcript-history";
import { buildAgentSpawnEnv } from "./headroom";
import { readBoardConfig } from "@/lib/storymap/repo";
import { copilotTier, resolutionDoctrineBlock, liberdadeDoctrineBlock, stewardPlaybooksBlock, tierStance, type CopilotTier } from "@/lib/storymap/copilot/tier";
import { resolveCopilotModelEffort } from "@/lib/storymap/copilot/model";
import type { OrchestratorMode } from "@/lib/storymap/types";

/** Build the MCP config JSON that points a headless run at THIS service's AgileHarness MCP endpoint. The token is
 *  the URL `secret` segment; 6.5 — level enforcement is now REAL server-side (register.ts filters the tool
 *  surface by the token's McpLevel), so a scoped `write` orchestrator token never even mounts deploy/destructive
 *  tools. Pair this with the spawn's `--allowedTools mcp__storymap` (no built-in Bash) for defense in depth. PURE. */
export function buildOrchestratorMcpConfig(token: string, port: number): string {
  return JSON.stringify({
    mcpServers: {
      storymap: { type: "http", url: `http://localhost:${port}/api/mcp/${token}/mcp` },
    },
  });
}

/** O que UM run do Jido devolve ao morrer (best-effort — um run morto por restart nunca chega aqui). */
export interface OrchestratorRunResult {
  board: string;
  /** total_cost_usd do run (0 quando a saída não pôde ser lida). */
  costUSD: number;
  /** o texto final do Jido (truncado) — "o que ele fez". */
  summary?: string;
  /** POR QUE morreu, quando exit≠0: a cauda do stderr do CLI. Sem isto, "exit 1" é indepurável. */
  failure?: string;
  exitCode: number | null;
  durationMs: number;
}

/** Quanto do texto final guardamos (a UI mostra 1 linha; o resto é ruído no JSON de estado). */
const SUMMARY_MAX = 400;

/** Quanto do stderr guardamos ao morrer (a causa útil está sempre nas últimas linhas). */
const FAILURE_MAX = 300;

/**
 * O system prompt que ACORDA o tick (req lease), agora CIENTE DO ESTADO (tier). Como o tick RETOMA a sessão
 * durável do board (WS2A) — que pode ou não ter conversa recente do operador —, esta instrução cobre os DOIS
 * casos e injeta a STANCE do estado atual: Copiloto defere decisões de produto e propõe/aguarda no deploy;
 * Autônomo decide e publica sozinho (quando o gate §4 abre). Guidance (não é gate): a contenção REAL é a matriz
 * de risco + os gates + o --disallowedTools; este texto só reflete a regra do estado. Exportado p/ teste. PURA.
 */
export function buildOrchestratorWakePrompt(tier: CopilotTier): string {
  const steward = stewardPlaybooksBlock(tier);
  // A doutrina de RESOLUÇÃO vem junto da stance porque, sem ela, a stance é abstrata no momento exato em que o
  // tick precisa dela: o Autônomo do acme leu 2 perguntas com opções, chamou-as de "dúvida de negócio" e deferiu
  // — cumprindo a letra da stance e falhando o propósito dela. Ver AUTONOMO_RESOLUTION (tier.ts) p/ o incidente.
  const resolution = resolutionDoctrineBlock(tier);
  // autonomo-liberdade-humana (2026-07-18): blocos IRMÃOS de peer-review (M1) + soft-delete (M2), cada um sob o
  // SEU gate. Sem eles, o tick não pediria par para a própria proposta nem saberia que a exclusão virou reversível.
  const liberdade = liberdadeDoctrineBlock(tier);
  return [
    "Você está ACORDANDO para avançar este board de forma autônoma, num tick. Objetivo: mover o máximo possível em",
    "direção ao deploy, respeitando as regras de decisão/deploy do seu MODO ATUAL abaixo (a matriz de risco e os",
    "gates enforçam a contenção).",
    "",
    tierStance(tier),
    ...(resolution ? ["", resolution] : []),
    ...(liberdade ? ["", liberdade] : []),
    // WS-8.4 — os playbooks de steward. O passe determinístico (copilot/steward.ts) já rodou ANTES deste spawn e
    // resolveu o que era FATO mecânico; isto é para o que sobrou chegar até você com a MESMA doutrina, em vez de
    // o agente inventar um playbook pior (re-implementar um card cujo fix está num branch preservado).
    ...(steward ? ["", steward] : []),
    "",
    "Esta sessão pode conter conversa recente do operador:",
    "- SE houver contexto de conversa relevante: honre a última intenção/orientação dele antes de agir por conta própria.",
    "- SE NÃO houver: prossiga pelo seu julgamento, priorizando o que está travado, acionável ou em conflito no board.",
  ].join("\n");
}

/**
 * A CAUSA de uma morte, extraída do stderr: as últimas linhas não-vazias, achatadas. O CLI falha no ARRANQUE
 * escrevendo UMA linha em stderr e nada em stdout (foi assim que o guard de root — bypassPermissions herdado do
 * settings.json global — matou todo tick por horas, e o operador só via "exit 1" sem causa). Nunca lança. PURA.
 */
export function parseOrchestratorFailure(rawStderr: string): string | undefined {
  const lines = rawStderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  return lines.slice(-3).join(" · ").slice(0, FAILURE_MAX);
}

/**
 * Extrai custo + resumo da saída `--output-format json` do CLI. O formato canônico é UM objeto JSON com
 * {total_cost_usd, result}; toleramos lixo à volta (um log solto na frente) varrendo linha a linha de trás p/
 * frente atrás do primeiro objeto parseável. Nunca lança — saída ilegível ⇒ custo 0, sem resumo. PURA (testada).
 */
export function parseOrchestratorResult(raw: string): { costUSD: number; summary?: string } {
  const takeFrom = (obj: unknown): { costUSD: number; summary?: string } | null => {
    if (!obj || typeof obj !== "object") return null;
    const o = obj as Record<string, unknown>;
    const cost = typeof o.total_cost_usd === "number" && Number.isFinite(o.total_cost_usd) ? o.total_cost_usd : undefined;
    const text = typeof o.result === "string" ? o.result.trim() : undefined;
    if (cost === undefined && text === undefined) return null;
    return {
      costUSD: Math.max(0, cost ?? 0),
      ...(text ? { summary: text.slice(0, SUMMARY_MAX) } : {}),
    };
  };

  const whole = (() => {
    try {
      return takeFrom(JSON.parse(raw));
    } catch {
      return null;
    }
  })();
  if (whole) return whole;

  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const hit = takeFrom(JSON.parse(line));
      if (hit) return hit;
    } catch {
      /* linha truncada/parcial — continua varrendo */
    }
  }
  return { costUSD: 0 };
}

/** O prompt do run. `reason` (o evento que acordou o Jido) entra como CONTEXTO — argv é um array (sem
 *  shell), então não há injeção; ainda assim achatamos aspas/quebras p/ o prompt ficar legível. PURA. */
export function buildOrchestratorPrompt(board: string, mode: OrchestratorMode, reason?: string): string {
  const base = `/harness-orchestrator ${board} ${mode} --tick`;
  const clean = reason
    ?.replace(/[\n\r"]+/g, " ")
    .replace(/\s+/g, " ") // colapsa o que sobrou (senão o motivo chega ao agente cheio de espaços duplos)
    .trim()
    .slice(0, 160);
  return clean ? `${base} --motivo "${clean}"` : base;
}

export interface OrchestratorSpawnDeps {
  /** the `claude` binary (settings.autorun.claudeBin). */
  claudeBin: string;
  /** o token MCP SCOPED do orquestrador (AGILEHARNESS_MCP_TOKEN_ORCH, nível `write`); ausente/vazio ⇒ spawn pulado. */
  token: string | undefined;
  /** the service port the AgileHarness MCP is served on (default 3008). */
  port?: number;
  /** por que o Jido está acordando (evento do wake); ausente = tick periódico comum. */
  reason?: string;
  /** best-effort: chamado quando o processo MORRE, com o custo real + o resumo. Nunca deve lançar. */
  onResult?: (result: OrchestratorRunResult) => void;
}

/**
 * Launch the copiloto for `board` in `mode`. Returns true when a run was started, false when skipped (no
 * token). Never throws — a spawn failure logs and returns false. The MCP config is written to a temp file the
 * run reads at start (mounted via `--strict-mcp-config --mcp-config`), so only the AgileHarness surface is present.
 */
export async function spawnOrchestrator(board: string, mode: OrchestratorMode, deps: OrchestratorSpawnDeps): Promise<boolean> {
  const token = deps.token?.trim();
  if (!token) {
    // A mensagem ANTES nomeava AGILEHARNESS_MCP_TOKEN (o token full do operador) — mas o tick usa o SCOPED. Quem
    // fosse debugar procurava a variável errada e concluía que já estava tudo setado.
    console.warn(`[orchestrator ${board}] AGILEHARNESS_MCP_TOKEN_ORCH ausente — copiloto não pode agir (spawn pulado).`);
    return false;
  }
  // DECLARADO FORA DO `try` de propósito. MEDIDO: 841 diretórios órfãos vieram DESTE site, e por
  // duas portas — (a) o `catch` externo abaixo devolvia `false` sem remover nada, e (b) a remoção
  // real mora dentro de `child.on("exit")`, com o filho `detached` + `unref()`: se o serviço
  // reinicia antes de o filho sair, o handler nunca roda. A (a) se conserta aqui; a (b) NÃO tem
  // conserto local — um filho que sobrevive ao pai não tem `finally` possível —, e é por isso que
  // existe a varredura da raiz (runner/temp.ts), que é a única limpeza honesta para esse caso.
  let dir: string | null = null;
  try {
    dir = await makeHarnessTempDir("orch");
    // Alias não-nulo para o closure do `exit` (o `let` acima é `string | null` por causa do catch).
    const scratch: string = dir;
    const cfgPath = path.join(dir, "mcp.json");
    const outPath = path.join(dir, "out.json");
    const errPath = path.join(dir, "err.txt");
    // MODO 0600 EXPLÍCITO. MEDIDO em 890 arquivos deixados em /tmp: o diretório era 0700 (só root),
    // mas o arquivo COM O TOKEN nascia 0644 — protegido apenas pelo modo do diretório que o contém.
    // Defesa que depende de UMA camada some quando essa camada muda; e um `cp -r` do diretório leva
    // a permissão do arquivo, não a do pai.
    await fs.writeFile(cfgPath, buildOrchestratorMcpConfig(token, deps.port ?? 3008), { encoding: "utf8", mode: 0o600 });
    // req lease — o system prompt que ACORDA o tick (dois casos: há/não há conversa recente na sessão retomada),
    // agora ciente do ESTADO: lê a policy fresca p/ derivar o tier (a matriz é a fonte da verdade, a mesma que o
    // guard lê por chamada) e injeta a stance do Copiloto/Autônomo. Fail-open: sem policy ⇒ chat ⇒ stance
    // conservadora (defere/propõe).
    const wakePath = path.join(dir, "wake.txt");
    const tier = copilotTier((await readBoardConfig(board).catch(() => null))?.orchestrator ?? null);
    await fs.writeFile(wakePath, buildOrchestratorWakePrompt(tier), "utf8");
    // WS2A — o tick RETOMA a MESMA sessão durável do board (o ponteiro board→sessionId que o chat também usa):
    // seu trabalho aterrissa no transcript do CLI → aparece como turno normal no corpo do chat ao reabrir/dar
    // refresh (threaded entre ticks), e o "acordar" pode usar o contexto da conversa. Se não há sessão — ou a
    // apontada foi coletada pelo GC (locateTranscript não a acha) — cunha uma nova e aponta o board p/ ela. O
    // transcript é escrito pelo CLI para QUALQUER --session-id/--resume (independe do --output-format), então o
    // json (custo REAL + resumo) continua valendo. A trava contra dois escritores na mesma sessão (chat vivo ×
    // tick) é o gate runInFlight do buildTickDeps (hasLiveCopilotTurnForBoard).
    const pointer = await readCopilotSessionPointer(board).catch(() => null);
    const resumeId = pointer?.sessionId && (await locateTranscript(pointer.sessionId).catch(() => null)) ? pointer.sessionId : null;
    const sessionId = resumeId ?? randomUUID();
    await writeCopilotSessionPointer(board, sessionId).catch(() => {}); // idempotente ao retomar; aponta à nova ao cunhar
    // O MESMO modelo que o chat resolve (copilot/model.ts) — e a razão é estrutural, não cosmética: o tick
    // RETOMA a sessão do chat logo abaixo, então os dois escrevem no MESMO transcript. Sem esta linha o spawn
    // não passava `--model` NENHUM e caía no default do CLI: a sessão alternava entre a janela de 1M (chat, que
    // pede a variante `[1m]`) e a de 200k (tick) conforme quem escrevesse por último, e a barra de contexto —
    // que mede contra a janela do chat (copilot-actions.ts) — mentia sempre que o tick trabalhava. Uma sessão,
    // um modelo, uma janela.
    const { model } = resolveCopilotModelEffort();
    const args = [
      "-p",
      buildOrchestratorPrompt(board, mode, deps.reason),
      "--model",
      model,
      // a saída estruturada é o que dá custo REAL (total_cost_usd) + o resumo final ao operador.
      "--output-format",
      "json",
      // sessão durável do board: retoma a existente (--resume) ou cunha uma nova (--session-id) → o trabalho do
      // tick fica no transcript ALCANÇÁVEL que o chat/history leem.
      ...(resumeId ? ["--resume", sessionId] : ["--session-id", sessionId]),
      // system prompt de "acordar" (dois casos), re-emitido a cada tick — como o append-system-prompt do chat.
      "--append-system-prompt-file",
      wakePath,
      "--strict-mcp-config",
      "--mcp-config",
      cfgPath,
      // 6.5 — DEFENSE-IN-DEPTH over the server-side MCP level filter. Was `--dangerously-skip-permissions`, which
      // grants UNRESTRICTED built-in Bash/Write/Edit — a deploy/`rm`/`git push` escape hatch. The `--tick`
      // protocol acts via MCP tools, so allow ONLY the AgileHarness MCP server (no built-in shell). Combined with the
      // scoped `write` token, the run's OWN direct surface has NO shell and NO deploy/destructive/spawn tool
      // (run_task/claude_*/enqueue are write-excluded — see levelAllows). CAVEAT (not a full sandbox): the write
      // token still allows `move_card`, which ADVANCES cards through the GATED pipeline; those headless harness-* runs
      // execute with their own permissions — the pre-existing pipeline trust boundary, NOT closed by this token.
      "--allowedTools",
      "mcp__storymap",
      // …E O MODO DE PERMISSÃO EXPLÍCITO — sem isto o Jido NUNCA nasce (bug 2026-07-13, exit 1 em <1s, todo
      // tick). O settings.json GLOBAL do operador (~/.claude) tem `permissions.defaultMode: "bypassPermissions"`;
      // um spawn que não declara modo HERDA esse bypass, o CLI o equipara a --dangerously-skip-permissions e bate
      // no guard de root ("cannot be used with root/sudo privileges") — o serviço roda como root. O 6.5 tirou a
      // flag perigosa daqui (bom) e, com ela, o IS_SANDBOX=1 que furava o guard (engine.ts o injeta SÓ quando
      // passa a flag) — mas o bypass continuou entrando pela porta dos fundos do settings. `default` é o modo
      // CERTO (não `acceptEdits`, que os runs harness-* usam p/ escrever card): o Jido age por MCP, não edita
      // arquivo. Declarar o modo é o que torna a contenção do 6.5 verdadeira em vez de nominal — com allowedTools
      // = só mcp__storymap, qualquer Bash/Write que ele tente é NEGADO em headless em vez de auto-aprovado.
      "--permission-mode",
      "default",
      // A PORTA DOS FUNDOS, fechada (2026-07-13). `--allowedTools mcp__storymap` NÃO restringe as tools nativas —
      // só PRÉ-APROVA o MCP; quem decide o resto é o allowlist de permissões do PROJETO (.claude/settings*.json).
      // E esse allowlist, acumulado em meses de sessões interativas do operador, concede `Bash(sh *)`, `Bash(bash *)`,
      // `Bash(git *)`, `Bash(firebase *)`, `Bash(gcloud *)`, `Bash(rm …)` — isto é, um SHELL COMPLETO. Um tick real
      // executou Bash 3x antes deste fix. Toda a contenção do F8 (matriz de risco, nível MCP `orch`, run-free
      // humano-only, destructive nunca) trancava a porta da frente enquanto a janela ao lado ficava aberta: bastaria
      // `sh -c` para deployar, pushar ou apagar o que quisesse, sem passar por guard, approval, rate-limit ou audit.
      // deny VENCE allow e REMOVE a tool da superfície (o agente nem a enxerga) — contenção de registro, não de
      // permissão. Read/Grep/Glob FICAM: são read-only e são o que dá ao Jido o poder de DIAGNOSTICAR (foi
      // lendo o log de deploy que ele achou a causa-raiz do gate). O chat PAREADO é outro contrato — lá o operador
      // está na frente, vendo, e por isso ele mantém as tools nativas (protocol.ts).
      "--disallowedTools",
      "Bash,Write,Edit,NotebookEdit",
    ];
    // 1.8 — SANEAR o env do filho (era `{ ...process.env }` cru): sanitizeSpawnEnv remove __NEXT_PROCESSED_ENV
    // (faz um next build filho PULAR seus .env) e node_modules/.bin do PATH (shim que engole `just`) — as DUAS
    // classes de incidente que os spawns do engine já fecham — e evita vazar o env vivo do next-server ao filho.
    // ⊕ headroom (2026-07-28): o copiloto/tick é um dos MAIORES consumidores de contexto do serviço
    // e estava 100% fora do proxy — buildAgentSpawnEnv é o chokepoint que sanea E roteia.
    const env = await buildAgentSpawnEnv(process.env);
    // stdout num ARQUIVO (não num pipe): o filho é detached e sobrevive ao serviço — um pipe cujo dono morre
    // manda EPIPE/SIGPIPE e mataria o run no meio. O arquivo é o handoff seguro; a leitura é no `exit`.
    // stderr idem, em arquivo PRÓPRIO: era `"ignore"` — e um CLI que morre no arranque escreve a causa SÓ ali,
    // então toda falha de arranque chegava ao operador como "exit 1" mudo (o bug do bypassPermissions ficou horas
    // invisível por isso). Arquivo separado do stdout p/ não injetar lixo no JSON que parseOrchestratorResult lê.
    const out = await fs.open(outPath, "a");
    const err = await fs.open(errPath, "a");
    const startedAt = Date.now();
    const child = spawn(deps.claudeBin, args, {
      cwd: findRepoRoot(),
      detached: true,
      stdio: ["ignore", out.fd, err.fd],
      env,
    });
    await Promise.all([out.close(), err.close()]); // o filho tem os SEUS descritores (dup no spawn)
    child.on("error", (e) => console.error(`[orchestrator ${board}] spawn error:`, e.message));
    child.on("exit", (code) => {
      void (async () => {
        let parsed: { costUSD: number; summary?: string } = { costUSD: 0 };
        try {
          parsed = parseOrchestratorResult(await fs.readFile(outPath, "utf8"));
        } catch {
          /* saída ilegível (run morto/kill) — custo 0, sem resumo */
        }
        // a CAUSA, só quando morreu mal: um run saudável escreve ruído em stderr (progresso do MCP) que não é falha.
        let failure: string | undefined;
        if (code !== 0) {
          try {
            failure = parseOrchestratorFailure(await fs.readFile(errPath, "utf8"));
          } catch {
            /* sem stderr legível — segue sem causa */
          }
        }
        await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
        console.log(
          `[orchestrator ${board}] copiloto terminou (exit=${code ?? "?"}, custo=$${parsed.costUSD.toFixed(4)})${failure ? ` — ${failure}` : ""}.`,
        );
        try {
          deps.onResult?.({ board, costUSD: parsed.costUSD, summary: parsed.summary, failure, exitCode: code, durationMs: Date.now() - startedAt });
        } catch (err) {
          console.error(`[orchestrator ${board}] onResult falhou:`, err instanceof Error ? err.message : err);
        }
      })();
    });
    child.unref();
    console.log(
      `[orchestrator ${board}] copiloto disparado (mode=${mode}, pid=${child.pid ?? "?"}${deps.reason ? `, motivo=${deps.reason}` : ""}).`,
    );
    return true;
  } catch (err) {
    // O scratch contém o token MCP (buildOrchestratorMcpConfig). Sair por aqui sem remover deixava
    // uma credencial em /tmp por até 30 dias — o prazo da política da distro.
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    console.error(`[orchestrator ${board}] spawn falhou:`, err instanceof Error ? err.message : err);
    return false;
  }
}
