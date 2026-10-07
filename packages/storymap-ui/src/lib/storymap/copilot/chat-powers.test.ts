// A SUPERFÍCIE DO CHAT — o que um turno da conversa do Jido monta (fase 6, decisão do dono de 06/10): poderes amplos no
// chat do board, em QUALQUER modo; a trava dura do host continua valendo (nenhuma tool de shell fora dela); as
// conversas de tela continuam de leitura. O argv é o contrato com o CLI, então ele é testado como o CLI o lê.

import { describe, expect, it } from "vitest";
import { hitlPurposeById, HITL_PURPOSES, CHAT_COMMAND_CENTER_CLAUSE } from "../hitl/purpose-registry";
import { annotatedToolNames, riskClassForTool } from "../mcp/register";
import { HARD_DENY_COVERED_SHELL_TOOLS, SHELL_RUNNING_TOOLS } from "../runner/session-spawn";
import { CHAT_NATIVE_TOOLS, CHAT_TERMINAL_TOOLS, chatSpawnPlan } from "./chat-powers";
import { buildCopilotTurnArgs } from "./protocol";
import type { CopilotTier } from "./tier";

const TIERS: CopilotTier[] = ["chat", "copiloto", "autonomo"];
const copilot = hitlPurposeById("copilot")!;

function argvFor(tools: readonly string[], deniedTools?: string): string[] {
  return buildCopilotTurnArgs({ model: "opus", effort: "medium", sessionId: "s-ex9001", resume: false, mcpConfigPath: "/tmp/m.json", systemPromptPath: "/tmp/p.txt", tools, deniedTools });
}

describe("chatSpawnPlan — o chat do board é a central de comando", () => {
  it("o Jido do board monta o MCP inteiro e edita, em TODO modo do board (o modo governa os autônomos, não o dono)", () => {
    for (const tier of TIERS) {
      const plan = chatSpawnPlan(copilot, tier);
      expect(plan.mcpLevel, tier).toBe("full");
      expect(plan.tools, tier).toEqual(expect.arrayContaining(["Bash", "Edit", "Write", "Read"]));
      expect(plan.deniedTools, tier).toBeUndefined();
    }
  });

  it("as conversas de TELA seguem de leitura: token `ro`, sem Write/Edit e SEM shell — «só leitura» vale para o repositório", () => {
    for (const id of ["doc-editor", "vocab-architect"]) {
      const plan = chatSpawnPlan(hitlPurposeById(id)!, "autonomo");
      expect(plan.mcpLevel, id).toBe("ro");
      expect(plan.tools, id).not.toContain("Write");
      expect(plan.tools, id).not.toContain("Edit");
      // um shell alcança os segredos do serviço e escreve no board por fora do escritor único: não é leitura
      expect(plan.tools, id).not.toContain("Bash");
      expect(plan.tools, id).toContain("Read");
    }
  });

  it("um propósito SEM opinião segue o modo do board (o comportamento histórico) — e a leitura perde o shell", () => {
    expect(chatSpawnPlan({}, "chat")).toMatchObject({ mcpLevel: "ro" });
    expect(chatSpawnPlan({}, "chat").tools).not.toContain("Edit");
    expect(chatSpawnPlan({}, "chat").tools).not.toContain("Bash");
    expect(chatSpawnPlan({}, "autonomo").mcpLevel).toBe("full");
    expect(chatSpawnPlan({}, "autonomo").tools).toContain("Bash");
  });
});

describe("sem a trava dura do host, os poderes amplos não existem", () => {
  it("o Jido do board cai para leitura: MCP `ro`, sem shell, sem editar — e o turno sabe por quê", () => {
    for (const tier of TIERS) {
      const plan = chatSpawnPlan(copilot, tier, { hardDeny: false });
      expect(plan.mcpLevel, tier).toBe("ro");
      for (const t of ["Bash", "Edit", "Write"]) expect(plan.tools, `${tier}/${t}`).not.toContain(t);
      expect(plan.guardMissing, tier).toBe(true);
      // a negação vai também no `--disallowedTools` (redundante com a lista do permitido, de propósito)
      expect(plan.deniedTools?.split(","), tier).toEqual(expect.arrayContaining(["Bash", "Edit", "Write"]));
    }
  });

  it("com a trava instalada, nada muda (os poderes do dono)", () => {
    expect(chatSpawnPlan(copilot, "chat", { hardDeny: true })).toMatchObject({ mcpLevel: "full" });
    expect(chatSpawnPlan(copilot, "chat", { hardDeny: true }).guardMissing).toBeUndefined();
  });
});

describe("a trava dura do host continua valendo para o chat", () => {
  it("nenhuma conversa monta uma tool que roda shell FORA da trava (Monitor/PowerShell) — a lista é do PERMITIDO", () => {
    const shellOutsideLock = SHELL_RUNNING_TOOLS.filter((t) => !HARD_DENY_COVERED_SHELL_TOOLS.includes(t));
    expect(shellOutsideLock.length).toBeGreaterThan(0); // a guarda tem o que pegar
    for (const p of HITL_PURPOSES) {
      for (const tier of TIERS) {
        const { tools } = chatSpawnPlan(p, tier);
        for (const t of shellOutsideLock) expect(tools, `${p.id}/${tier}`).not.toContain(t);
        expect(tools.length, `${p.id}/${tier}: lista vazia = o CLI montaria TODAS`).toBeGreaterThan(0);
      }
    }
    for (const t of shellOutsideLock) expect(CHAT_NATIVE_TOOLS as readonly string[]).not.toContain(t);
  });

  it("o argv passa a lista do permitido como UM argumento de `--tools`, e nada que tire os hooks do host", () => {
    const plan = chatSpawnPlan(copilot, "chat");
    const args = argvFor(plan.tools, plan.deniedTools);
    const i = args.indexOf("--tools");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe(plan.tools.join(","));
    expect(args[i + 2]?.startsWith("--")).toBe(true); // a flag é variádica: o próximo token é sempre outra flag
    expect(args).toContain("--strict-mcp-config");
    // os hooks gerenciados (a trava dura) vêm dos settings; nada no argv os desliga
    for (const flag of ["--bare", "--setting-sources", "--settings"]) expect(args).not.toContain(flag);
  });

  it("sem lista, o argv não passa `--tools` (o default do CLI) — quem chama sempre passa a lista do plano", () => {
    expect(argvFor([])).not.toContain("--tools");
  });
});

describe("os terminais do AgileHarness no chat", () => {
  it("as tools de terminal existem, o nível `full` as monta, e matar é `destructive` (por isso confirma antes)", () => {
    const known = new Set(annotatedToolNames());
    for (const tool of Object.values(CHAT_TERMINAL_TOOLS)) expect(known.has(tool), tool).toBe(true);
    expect(riskClassForTool(CHAT_TERMINAL_TOOLS.kill)).toBe("destructive");
  });

  it("a persona ensina cada uma delas (as duas listas andam juntas)", () => {
    for (const tool of Object.values(CHAT_TERMINAL_TOOLS)) expect(CHAT_COMMAND_CENTER_CLAUSE, tool).toContain(`\`${tool}\``);
  });
});
