import { describe, expect, it } from "vitest";
import { resolvePaneSession, transcriptPathFor } from "./pane-claude-map";
import type { ClaudePidfile } from "@/lib/vps/claude-pidfile";
import type { PaneOwner, ProcRow } from "@/lib/vps/process-attribution";
import type { AgentSession } from "@/lib/storymap/runner/session-worktree";

// O join "qual sessão Claude roda NESTE painel" é a peça que decide se o medidor de contexto conta a
// verdade ou mente. Estes testes exercitam SÓ a superfície PURA (resolvePaneSession + transcriptPathFor)
// sobre snapshots injetados — nenhuma sonda na máquina, nenhum /proc, nenhum tmux.
//
// A ordem dos tiers (registro > pidfile > argv) e as duas RECUSAS (`no-claude`, `unmapped`) são o
// contrato: cada tier CONHECE o id, nenhum o infere. "Não sei" é resposta de primeira classe.

const SESSION = "shell";
const PANE_PID = 100;
const CLAUDE_PID = 101;
/** uuid real de uma sessão desta máquina — casa com o UUID de `sessionIdOf` e com o guard de traversal. */
const SID = "4aa0a1a0-3ec8-475f-8b58-7847b2353f44";
const CWD = "/root/meu-monorepo";
const HOME = "/home/x";

/** Uma linha da tabela de processos. Default = o claude do painel (filho do bash do pane). */
function proc(over: Partial<ProcRow> = {}): ProcRow {
  return { pid: CLAUDE_PID, ppid: PANE_PID, etime: "05:00", comm: "claude", args: "claude", ...over };
}

/** O bash que É o pane pid — a raiz da árvore por onde `attributeClaudeProcesses` sobe. */
function shell(over: Partial<ProcRow> = {}): ProcRow {
  return proc({ pid: PANE_PID, ppid: 1, comm: "bash", args: "-bash", ...over });
}

function pane(over: Partial<PaneOwner> = {}): PaneOwner {
  return { session: SESSION, pid: PANE_PID, ...over };
}

function pidfile(over: Partial<ClaudePidfile> = {}): ClaudePidfile {
  return {
    pid: CLAUDE_PID,
    sessionId: SID,
    cwd: CWD,
    startedAt: null,
    procStart: null,
    version: null,
    kind: "interactive",
    name: null,
    nameSource: null,
    status: null,
    updatedAt: null,
    statusUpdatedAt: null,
    ...over,
  };
}

function agentRow(over: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId: SID,
    agentId: SID,
    role: "free",
    task: "trabalho",
    tmuxSession: SESSION,
    openedAt: "2026-07-23T00:00:00.000Z",
    heartbeatAt: "2026-07-23T00:00:00.000Z",
    ...over,
  };
}

type ResolveInput = Parameters<typeof resolvePaneSession>[0];

/** O snapshot completo: um painel `shell` hospedando um claude, sem registro e sem pidfile. */
function snap(over: Partial<ResolveInput> = {}): ResolveInput {
  return {
    tmuxSession: SESSION,
    panes: [pane()],
    procs: [shell(), proc()],
    registry: [],
    pidfiles: new Map<number, ClaudePidfile>(),
    home: HOME,
    ...over,
  };
}

describe("resolvePaneSession — precedência dos tiers", () => {
  // ORDEM CORRIGIDA POR REVISÃO. Antes o registro vinha primeiro, o que reimportava pela porta dos
  // fundos a atribuição por mtime que este módulo rejeita: `AgentSession.transcriptFile` é escrito
  // por session-spawn.ts como `findTranscript(startedAt)`, ligado em produção a `findNewTranscript`
  // — a varredura do ~/.claude/projects pelo .jsonl mais recente. Ele também casa só pelo NOME do
  // tmux, sem checar liveness, então uma linha velha de um nome reusado descreve um agente morto.
  // O pidfile é o único tier cuja evidência amarra a resposta ao processo VIVO daquele painel
  // (pid + starttime do /proc), então é ele que vence.
  it("pidfile vence registro vence argv: com os três disponíveis, a fonte é o pidfile", () => {
    const r = resolvePaneSession(
      snap({
        procs: [shell(), proc({ args: `claude -p --session-id ${SID}` })],
        registry: [agentRow({ transcriptFile: "/reg/pinado.jsonl", cwd: CWD, model: "opus[1m]" })],
        pidfiles: new Map([[CLAUDE_PID, pidfile()]]),
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pane.source).toBe("pidfile");
    // o caminho é CONSTRUÍDO a partir do sessionId que o próprio CLI registrou para este pid —
    // NUNCA o valor pinado pelo registro, que pode ter vindo da varredura por mtime
    expect(r.pane.transcriptPath).not.toBe("/reg/pinado.jsonl");
    expect(r.pane.transcriptPath.endsWith(`/projects/-root-meu-monorepo/${SID}.jsonl`)).toBe(true);
    // o modelo ainda vem do registro: é o que o spawner PINOU, e é o único lugar onde [1m] aparece
    expect(r.pane.model).toBe("opus[1m]");
  });

  it("sem pidfile, o registro AINDA serve — é fallback, não fonte proibida", () => {
    const r = resolvePaneSession(
      snap({
        procs: [shell(), proc({ args: "claude" })],
        registry: [agentRow({ transcriptFile: "/reg/pinado.jsonl", cwd: CWD, model: "sonnet" })],
        pidfiles: new Map(),
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pane.source).toBe("registry");
    expect(r.pane.transcriptPath).toBe("/reg/pinado.jsonl");
  });

  it("tabela de processos VAZIA é falha da sonda, não ausência de agente: unmapped, nunca no-claude", () => {
    // `no-claude` é renderizado como NADA (um shell bash não tem contexto). Devolvê-lo quando o `ps`
    // falhou faria a leitura sumir de todos os painéis, indistinguível de uma caixa sem agentes.
    const r = resolvePaneSession(snap({ procs: [], pidfiles: new Map() }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unmapped");
  });

  it("registro sem transcriptFile cai para o pidfile — a fonte é `pidfile`, não `registry`", () => {
    const r = resolvePaneSession(
      snap({
        procs: [shell(), proc({ args: `claude -p --session-id ${SID}` })],
        registry: [agentRow({ model: "sonnet" })],
        pidfiles: new Map([[CLAUDE_PID, pidfile()]]),
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pane.source).toBe("pidfile");
    expect(r.pane.sessionId).toBe(SID);
    expect(r.pane.transcriptPath.endsWith(`/projects/-root-meu-monorepo/${SID}.jsonl`)).toBe(true);
  });

  it("sem registro e sem pidfile, o uuid do argv é o último tier — a fonte é `argv`", () => {
    const r = resolvePaneSession(
      snap({
        procs: [shell(), proc({ args: `claude -p --session-id ${SID}` })],
        cwdOf: () => CWD,
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pane.source).toBe("argv");
  });

  it("o nome e o status do agente vêm do pidfile (tier 2 carrega a identidade, não só o caminho)", () => {
    const r = resolvePaneSession(
      snap({
        pidfiles: new Map([
          [
            CLAUDE_PID,
            pidfile({
              name: "meu-monorepo-b7",
              status: "busy",
              statusUpdatedAt: 1784813994111,
              version: "2.1.218",
            }),
          ],
        ]),
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pane.claude).toEqual({
      pid: CLAUDE_PID,
      name: "meu-monorepo-b7",
      status: "busy",
      // A data do flag viaja JUNTO com o flag: quem consome precisa poder perguntar a idade dele
      // sem voltar ao disco (ver cliFlagExpired).
      statusUpdatedAt: 1784813994111,
      version: "2.1.218",
    });
    expect(r.pane.cwd).toBe(CWD);
  });

  it("argv usa o cwd INJETADO quando o registro não tem — e constrói o caminho com ele", () => {
    const r = resolvePaneSession(
      snap({
        procs: [shell(), proc({ args: `claude -p --session-id ${SID} --output-format stream-json` })],
        registry: [],
        pidfiles: new Map<number, ClaudePidfile>(),
        cwdOf: (pid) => (pid === CLAUDE_PID ? CWD : null),
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pane.source).toBe("argv");
    expect(r.pane.cwd).toBe(CWD);
    expect(r.pane.sessionId).toBe(SID);
    expect(r.pane.transcriptPath.endsWith(`/projects/-root-meu-monorepo/${SID}.jsonl`)).toBe(true);
  });
});

describe("resolvePaneSession — as recusas (uma resposta honesta vale mais que um palpite)", () => {
  it("painel sem processo claude devolve `no-claude` — e nenhum claude a exibir", () => {
    const r = resolvePaneSession(snap({ procs: [shell()] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("no-claude");
    expect(r.claude).toBeNull();
  });

  it("claude vivo sem id em lugar nenhum é `unmapped`, nunca um palpite — e o claude NÃO é null", () => {
    const r = resolvePaneSession(snap());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unmapped");
    // sabemos que há um processo ali; só não sabemos nomeá-lo
    expect(r.claude).toEqual({ pid: CLAUDE_PID, name: null, status: null, statusUpdatedAt: null, version: null });
  });

  it("NUNCA escolhe por mtime: o claude anônimo segue unmapped e NENHUM transcript é produzido — escolher o arquivo mais novo do diretório do projeto devolveu, em 5 de 5 amostras, os 384.725 tokens de OUTRA sessão para um painel que tinha 146.979 (mentira silenciosa de 2,6×)", () => {
    const r = resolvePaneSession(snap());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unmapped");
    // nenhum caminho vaza pela recusa — nem por um campo extra, nem por um `pane` parcial
    expect("pane" in r).toBe(false);
    expect(JSON.stringify(r)).not.toContain(".jsonl");
  });

  it("registro obsoleto NÃO ressuscita leitura: pane sem claude vivo é `no-claude`, mesmo com transcriptFile pinado", () => {
    const r = resolvePaneSession(
      snap({
        procs: [shell()],
        registry: [agentRow({ transcriptFile: "/reg/agente-morto.jsonl", cwd: CWD })],
        pidfiles: new Map([[CLAUDE_PID, pidfile()]]),
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // a checagem de processo roda ANTES do registro — senão um agente morto reportaria contexto para sempre
    expect(r.reason).toBe("no-claude");
    expect(r.claude).toBeNull();
  });

  it("registro de OUTRO painel não é emprestado — um claude anônimo continua unmapped", () => {
    const r = resolvePaneSession(
      snap({ registry: [agentRow({ tmuxSession: "agent-outro", transcriptFile: "/reg/de-outro.jsonl" })] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unmapped");
  });

  it("pidfile com cwd vazio não fabrica caminho — cai para unmapped, preservando nome/status", () => {
    const r = resolvePaneSession(
      snap({ pidfiles: new Map([[CLAUDE_PID, pidfile({ cwd: "", name: "sem-cwd", status: "idle" })]]) }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unmapped");
    expect(r.claude?.name).toBe("sem-cwd");
  });
});

describe("transcriptPathFor — o caminho é CONSTRUÍDO, não procurado", () => {
  it("<configDir>/projects/<slug(cwd)>/<sessionId>.jsonl a partir do id e do cwd", () => {
    const p = transcriptPathFor(SID, CWD, HOME);
    expect(p).not.toBeNull();
    expect(p!.endsWith(`/projects/-root-meu-monorepo/${SID}.jsonl`)).toBe(true);
  });

  it("o slug troca `/` E `.` por `-` — um worktree pontuado vira `-root-meu-monorepo--worktrees-agent-7`", () => {
    const p = transcriptPathFor(SID, "/root/meu-monorepo/.worktrees/agent-7", HOME);
    expect(p).not.toBeNull();
    expect(p!.endsWith(`/projects/-root-meu-monorepo--worktrees-agent-7/${SID}.jsonl`)).toBe(true);
  });

  it("sessionId inválido barra traversal: `..`, curto demais e com barra ⇒ null", () => {
    expect(transcriptPathFor("../../etc/passwd", CWD, HOME)).toBeNull();
    expect(transcriptPathFor("x", CWD, HOME)).toBeNull();
    expect(transcriptPathFor("abcdefgh/ijklmnop", CWD, HOME)).toBeNull();
  });

  it("cwd vazio não produz caminho — sem cwd não há diretório de projeto para nomear", () => {
    expect(transcriptPathFor(SID, "", HOME)).toBeNull();
  });
});
