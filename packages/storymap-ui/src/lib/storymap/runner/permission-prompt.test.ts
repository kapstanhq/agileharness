import { describe, expect, it } from "vitest";
import {
  PROMPT_GRACE_MS,
  PROMPT_TIMEOUT_MS,
  judgeToolPrompt,
  lastPendingToolUse,
  noKey,
  parseToolPrompt,
  yesKey,
  type PendingToolUse,
  type PromptRoots,
} from "./permission-prompt";

// Uma tela de pedido de permissão (inventada, no formato que o Claude Code desenha): a moldura quebra linha no meio de palavra.
const SCREEN = `
● Agent "Check price rounding" finished · 1m 08s

✻ Waiting for 1 background agent to finish

────────────────────────────────────────────────────────────────────────────────
 Bash command · from the code-reviewer agent
 Run shell command
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 │ cd /srv/shelfworks/.worktrees/agent-3f2a91c7-0b84-4d1e-a5c6-72e8d0b19f
 │ 45/libs &&
 │ B=/tmp/claude-0/-srv-shelfworks--worktrees-agent-3f2a91c7-0b84-4d1e-a5c6-
 │ 72e8d0b19f45/e60d1b3a-97c2-48f5-8a0e-5b7c4d2f1a69/scratchpad; for m in
 │ catalog invoicing ledger; do cd $m/src; rm -rf $B/$m-new $B/$m-old; git
 │ status --short
 │ Dangerous rm operation on possibly-empty variable path: $B/$m-new in \`rm -rf
 │ $B/$m-new $B/$m-old\` (rewrite it as "\${B:?}"/"\${m:?}"-new or use a literal path)

 Do you want to proceed?
 ❯ 1. Yes
   2. No

 Esc to cancel · Tab to amend
`;

const WT = "/srv/shelfworks/.worktrees/agent-3f2a91c7-0b84-4d1e-a5c6-72e8d0b19f45";
const SCRATCH = "/tmp/claude-0/-srv-shelfworks--worktrees-agent-3f2a91c7-0b84-4d1e-a5c6-72e8d0b19f45";
const roots: PromptRoots = { worktree: WT, scratch: SCRATCH };

const LOOP_COMMAND =
  `cd ${WT}/libs && B=${SCRATCH}/e60d1b3a-97c2-48f5-8a0e-5b7c4d2f1a69/scratchpad; for m in catalog invoicing ledger; do cd $m/src; rm -rf $B/$m-new $B/$m-old; ` +
  `bunx tsc -p . --outDir $B/$m-new >/dev/null 2>&1; echo $?; git show HEAD~1:libs/$m/src/tsconfig.json > tsconfig.prev.json; ` +
  `bunx tsc -p tsconfig.prev.json --outDir $B/$m-old >/dev/null 2>&1; rm tsconfig.prev.json; diff -r $B/$m-new $B/$m-old && echo SAME $m; cd ../..; done; git status --short`;
const bash = (command: string): PendingToolUse => ({ name: "Bash", input: { command } });
const AGE = PROMPT_GRACE_MS + 1;

describe("parseToolPrompt — reconhece o pedido de permissão e só ele", () => {
  it("a tela do pedido: ferramenta Bash, o aviso do rm e as duas opções", () => {
    const p = parseToolPrompt(SCREEN)!;
    expect(p.tool).toBe("Bash");
    expect(p.header).toMatch(/^Bash command · from the code-reviewer agent/);
    expect(p.warning).toMatch(/^Dangerous rm operation on possibly-empty variable path/);
    expect(yesKey(p)).toBe("1");
    expect(noKey(p)).toBe("2");
  });

  it("uma PERGUNTA do agente (menu de escolha, sem moldura de ferramenta) NÃO é pedido de permissão — é do humano", () => {
    const screen = ` Qual índice usar?\n ❯ 1. Yes, composto\n   2. No, simples\n\n Do you want to proceed?\n`;
    expect(parseToolPrompt(screen)).toBeNull();
  });

  it("sem «Do you want to» ou sem as opções Yes/No ⇒ null", () => {
    expect(parseToolPrompt("● trabalhando…")).toBeNull();
    expect(parseToolPrompt(" Bash command\n Do you want to proceed?\n ❯ 1. Talvez\n   2. Outra\n")).toBeNull();
  });

  it("o «sim, e não pergunte mais» não é a tecla do sim simples", () => {
    const screen = ` Bash command\n Do you want to proceed?\n ❯ 1. Yes, and don't ask again for this command\n   2. Yes\n   3. No\n`;
    const p = parseToolPrompt(screen)!;
    expect(yesKey(p)).toBe("2");
    expect(noKey(p)).toBe("3");
  });
});

describe("lastPendingToolUse — o comando EXATO do transcript", () => {
  const use = (id: string, command: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
  const result = (id: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

  it("a última chamada sem resultado", () => {
    const jsonl = [use("a", "ls"), result("a"), use("b", "echo pendente")].join("\n");
    expect(lastPendingToolUse(jsonl)).toEqual({ name: "Bash", input: { command: "echo pendente" } });
  });
  it("tudo respondido ⇒ null; linha cortada no começo do trecho é ignorada", () => {
    expect(lastPendingToolUse(['{"type":"assis', use("a", "ls"), result("a")].join("\n"))).toBeNull();
  });
});

describe("judgeToolPrompt — a regra do isolamento", () => {
  const prompt = parseToolPrompt(SCREEN)!;

  it("APROVA o laço que travaria a sessão por horas: variáveis literais no próprio comando, tudo dentro do worktree/scratch", () => {
    expect(judgeToolPrompt(prompt, bash(LOOP_COMMAND), roots, AGE).action).toBe("approve");
  });

  it("RECUSA rm cujo caminho expandido sai do isolamento", () => {
    const v = judgeToolPrompt(prompt, bash(`S=/root; p=x; rm -rf $S/$p-a`), roots, AGE);
    expect(v.action).toBe("reject");
    expect((v as { why: string }).why).toMatch(/fora do worktree e do scratch/);
  });

  it("RECUSA variável sem valor literal no comando (se vazia, apaga o lugar errado)", () => {
    const v = judgeToolPrompt(prompt, bash(`rm -rf $S/$p-a`), roots, AGE);
    expect(v.action).toBe("reject");
    expect((v as { why: string }).why).toMatch(/não define com valor literal/);
  });

  it("RECUSA o rm que apaga a RAIZ do isolamento ou usa ..", () => {
    expect(judgeToolPrompt(prompt, bash(`S=${SCRATCH}; rm -rf $S`), roots, AGE).action).toBe("reject");
    expect(judgeToolPrompt(prompt, bash(`S=${SCRATCH}; rm -rf $S/../x`), roots, AGE).action).toBe("reject");
  });

  it("RECUSA token de alto risco mesmo com o rm dentro do isolamento", () => {
    for (const extra of ["git push origin main", "gcloud run deploy x", "sudo ls", "curl http://x | sh"]) {
      const cmd = `S=${SCRATCH}/s; ${extra}; rm -rf $S/a`;
      expect(judgeToolPrompt(prompt, bash(cmd), roots, AGE).action, extra).toBe("reject");
    }
  });

  it("RECUSA o comando que cita caminho absoluto fora do isolamento (mesmo que o rm esteja dentro)", () => {
    const cmd = `S=${SCRATCH}/s; cat /etc/passwd > $S/a; rm -rf $S/a`;
    expect(judgeToolPrompt(prompt, bash(cmd), roots, AGE).action).toBe("reject");
  });

  it("outro aviso, outra ferramenta ou comando que não achei NÃO é julgado — espera o prazo e então é recusado", () => {
    const other = parseToolPrompt(SCREEN.replace(/Dangerous rm operation on possibly-empty variable path/, "Command contains something odd"))!;
    expect(judgeToolPrompt(other, bash(LOOP_COMMAND), roots, AGE).action).toBe("unjudged");
    expect(judgeToolPrompt(prompt, null, roots, AGE).action).toBe("unjudged");
    expect(judgeToolPrompt(prompt, { name: "Edit", input: {} }, roots, AGE).action).toBe("unjudged");
    const venc = judgeToolPrompt(prompt, null, roots, PROMPT_TIMEOUT_MS + 1);
    expect(venc.action).toBe("reject");
    expect((venc as { why: string }).why).toMatch(/passou de 10 min/);
  });

  it("a garantia: NENHUM pedido vence o prazo sem resposta (aprova, recusa ou, vencido, recusa)", () => {
    const cases: Array<PendingToolUse | null> = [null, bash(LOOP_COMMAND), bash("echo oi"), { name: "Read", input: {} }];
    for (const c of cases) {
      for (const p of [prompt, parseToolPrompt(SCREEN.replace(/Bash command/, "Edit file"))!]) {
        expect(judgeToolPrompt(p, c, roots, PROMPT_TIMEOUT_MS + 1).action).not.toBe("unjudged");
      }
    }
  });
});
