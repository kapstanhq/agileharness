import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEPLOY_AUTONOMY_ENABLED, resolutionDoctrineBlock } from "@/lib/storymap/copilot/tier";

// 1.8 — the copiloto spawn inherited `{ ...process.env }` raw, re-introducing the __NEXT_PROCESSED_ENV and
// node_modules/.bin-PATH incident classes (and leaking the service env). Assert it now spawns with a SANITIZED
// env at the call site (the shared sanitizeSpawnEnv is unit-tested separately in spawn-env.test.ts).
const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));
vi.mock("@/lib/storymap/paths", () => ({ findRepoRoot: () => "/repo" }));

import {
  spawnOrchestrator,
  buildOrchestratorMcpConfig,
  parseOrchestratorResult,
  parseOrchestratorFailure,
  buildOrchestratorPrompt,
  buildOrchestratorWakePrompt,
} from "./orchestrator-spawn";

describe("spawnOrchestrator — env sanitizado no spawn (1.8)", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue({ on: vi.fn(), unref: vi.fn(), pid: 123 });
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  });

  it("token ausente → NÃO spawna e retorna false (fail-open)", async () => {
    const ok = await spawnOrchestrator("storymap", "autonomous", { claudeBin: "claude", token: "  " });
    expect(ok).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("o env do spawn é saneado: sem __NEXT_*, sem NODE_ENV, PATH sem node_modules/.bin", async () => {
    const penv = process.env as Record<string, string | undefined>; // NODE_ENV é readonly no typing do Next
    penv.__NEXT_PROCESSED_ENV = "true";
    penv.NODE_ENV = "production";
    penv.PATH = "/repo/node_modules/.bin:/usr/bin:/bin";
    const ok = await spawnOrchestrator("storymap", "autonomous", { claudeBin: "claude", token: "tok" });
    expect(ok).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string | undefined> };
    expect(opts.env.__NEXT_PROCESSED_ENV).toBeUndefined(); // next build filho não pula mais os .env
    expect(opts.env.NODE_ENV).toBeUndefined(); // paridade com um shell manual
    expect(opts.env.PATH).not.toContain("node_modules/.bin"); // shim `just` não sombreia mais o binário de sistema
    expect(opts.env.PATH).toContain("/usr/bin");
  });
});

// 2026-07-13 — o Jido NASCIA MORTO: exit 1 em <1s, todo tick, custo $0. Causa: o spawn não declarava modo de
// permissão, então herdava `permissions.defaultMode: "bypassPermissions"` do settings.json GLOBAL do operador; o
// CLI equipara isso a --dangerously-skip-permissions e RECUSA rodar como root (o serviço é root). Estes testes
// travam o contrato de ARRANQUE — e o de CONTENÇÃO, que só é verdadeiro porque o modo é declarado.
describe("spawnOrchestrator — o contrato de ARRANQUE (o Jido precisa NASCER) e o de contenção", () => {
  const savedEnv = { ...process.env };
  const argsOf = () => spawnMock.mock.calls[0][1] as string[];
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue({ on: vi.fn(), unref: vi.fn(), pid: 123 });
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  });

  it("declara --permission-mode default (sem isto o bypass do settings global mata o run no guard de root)", async () => {
    await spawnOrchestrator("acme", "autonomous", { claudeBin: "claude", token: "tok" });
    const args = argsOf();
    const i = args.indexOf("--permission-mode");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("default");
  });

  it("NUNCA passa --dangerously-skip-permissions (seria o shell irrestrito que o 6.5 fechou)", async () => {
    await spawnOrchestrator("acme", "autonomous", { claudeBin: "claude", token: "tok" });
    expect(argsOf()).not.toContain("--dangerously-skip-permissions");
  });

  it("a superfície é SÓ o MCP do AgileHarness", async () => {
    await spawnOrchestrator("acme", "autonomous", { claudeBin: "claude", token: "tok" });
    const args = argsOf();
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__storymap");
    expect(args).toContain("--strict-mcp-config");
  });

  // A porta dos fundos: --allowedTools não RESTRINGE as tools nativas, só pré-aprova o MCP. O allowlist do projeto
  // concede Bash(sh *)/Bash(bash *)/Bash(git *)/… — um shell completo, com que o Jido autônomo contornaria
  // guard, approval, rate-limit e audit inteiros. deny remove a tool da superfície; é a única contenção real.
  it("NEGA as tools nativas que MUTAM (o allowlist do projeto concede um shell inteiro por baixo)", async () => {
    await spawnOrchestrator("acme", "autonomous", { claudeBin: "claude", token: "tok" });
    const args = argsOf();
    const denied = args[args.indexOf("--disallowedTools") + 1].split(",");
    for (const t of ["Bash", "Write", "Edit", "NotebookEdit"]) expect(denied).toContain(t);
  });

  it("...mas MANTÉM as read-only (Read/Grep/Glob são o que dá ao Jido o poder de diagnosticar)", async () => {
    await spawnOrchestrator("acme", "autonomous", { claudeBin: "claude", token: "tok" });
    const denied = argsOf()[argsOf().indexOf("--disallowedTools") + 1].split(",");
    for (const t of ["Read", "Grep", "Glob"]) expect(denied).not.toContain(t);
  });

  // WS2A — o tick RETOMA a sessão durável do board (o ponteiro board→sessionId que o chat também usa) para que
  // seu trabalho aterrisse no transcript alcançável (visível no refresh). Nunca roda SEM sessão (senão o
  // transcript seria órfão). Sem ponteiro (ambiente de teste) → cunha e passa --session-id (um uuid).
  it("WS2A — sempre passa uma sessão DURÁVEL do board (--session-id/--resume com um uuid)", async () => {
    await spawnOrchestrator("acme", "autonomous", { claudeBin: "claude", token: "tok" });
    const args = argsOf();
    const flag = args.includes("--resume") ? "--resume" : "--session-id";
    expect(args).toContain(flag);
    expect(args[args.indexOf(flag) + 1]).toMatch(/^[0-9a-f-]{36}$/i);
  });

  // req lease — como o tick RETOMA a sessão do board (que pode ter conversa do operador), acorda com um system
  // prompt que cobre os DOIS casos e reafirma a contenção. Guidance, não gate (o gate é matriz+disallowedTools).
  it("req lease — passa o system prompt de ACORDAR (dois casos + stance do estado) via --append-system-prompt-file", async () => {
    await spawnOrchestrator("acme", "autonomous", { claudeBin: "claude", token: "tok" });
    expect(argsOf()).toContain("--append-system-prompt-file");
    // A stance é derivada do tier (pura): Copiloto cobre os dois casos de conversa E defere decisões/deploy.
    const copiloto = buildOrchestratorWakePrompt("copiloto");
    expect(copiloto).toMatch(/SE houver contexto de conversa/i);
    expect(copiloto).toMatch(/SE NÃO houver/i);
    expect(copiloto).toMatch(/DECISÃO HUMANA|NÃO decida/i);
  });

  // O tick NÃO lê tier.ts — ele lê ESTE prompt. A doutrina existir e não chegar aqui seria o incidente de
  // novo, só que com um teste verde por perto: o board acme estava em Autônomo, a stance autorizava decidir, e
  // o que o tick recebeu na hora H foi o que decidiu o desfecho.
  it("o wake prompt do AUTÔNOMO carrega a doutrina de resolução; o do Copiloto não", async () => {
    const autonomo = buildOrchestratorWakePrompt("autonomo");
    if (DEPLOY_AUTONOMY_ENABLED) {
      expect(autonomo).toContain(resolutionDoctrineBlock("autonomo"));
      expect(autonomo).toMatch(/options/i);
      expect(autonomo).toMatch(/triage_finding/);
    }
    expect(buildOrchestratorWakePrompt("copiloto")).not.toMatch(/Resolver o que está aberto/);
  });

  // salvage (endgame §5.4b) — as FRASES da doutrina, pinadas literalmente. O teste acima prova que o BLOCO
  // chega ao wake prompt; este prova que o bloco ainda DIZ o que a regra WS-7 (story-f6rr4p) exige — se o
  // texto de tier.ts drifta ("devolva o PRÓPRIO card" some, "NUNCA um card paralelo" é afrouxado), o teste
  // do bloco continuaria verde por containment. Doutrina só contém se o conteúdo sobreviver.
  it("§5.4b — a doutrina manda devolver o PRÓPRIO card (nunca card paralelo) e nomeia o teto do shell — literalmente", () => {
    if (DEPLOY_AUTONOMY_ENABLED) {
      const doctrine = resolutionDoctrineBlock("autonomo");
      expect(doctrine).toContain("devolva o PRÓPRIO card");
      expect(doctrine).toContain("NUNCA um card paralelo");
      // a frase que ancora o teto do tick na própria doutrina: quem edita código é o run da coluna.
      expect(doctrine).toContain("Você não tem shell");
      const wake = buildOrchestratorWakePrompt("autonomo");
      expect(wake).toContain("devolva o PRÓPRIO card");
      expect(wake).toContain("NUNCA um card paralelo");
    }
    // Fora do Autônomo a doutrina nem é emitida — deferir lá é o comportamento certo, não omissão.
    expect(resolutionDoctrineBlock("copiloto")).toBe("");
  });

  it("captura o stderr num descritor (era `ignore` — e a causa da morte ia p/ o lixo)", async () => {
    await spawnOrchestrator("acme", "autonomous", { claudeBin: "claude", token: "tok" });
    const opts = spawnMock.mock.calls[0][2] as { stdio: unknown[] };
    expect(opts.stdio[2]).not.toBe("ignore");
    expect(typeof opts.stdio[2]).toBe("number"); // fd do arquivo de stderr
  });

  // autonomy-endgame WS-5.1 — O TETO DO TICK, PROVADO NO ARGV, com o nome que a próxima investigação grepa.
  // "o tick não escreve código" reaparecia como DESCOBERTA em toda investigação porque vivia só em doc-comment.
  // Aqui vira uma asserção que o CI roda: o argv do tick contém EXATAMENTE `Bash,Write,Edit,NotebookEdit` no
  // --disallowedTools, e NENHUMA flag da família skip-permissions. A asserção negativa é a que pega o regresso
  // de verdade: --dangerously-skip-permissions é a flag que os runs `run-free` usam por desenho, e um
  // copy-paste entre spawns é o modo plausível de ela vazar para o spawn do tick.
  it("WS-5.1 — o tick não tem shell (--disallowedTools Bash,Write,Edit,NotebookEdit; ZERO skip-permissions)", async () => {
    await spawnOrchestrator("acme", "autonomous", { claudeBin: "claude", token: "tok" });
    const args = argsOf();
    // NÃO ESCREVE: a contenção de REGISTRO (deny vence allow, remove a tool da superfície) é EXATAMENTE estas 4.
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("Bash,Write,Edit,NotebookEdit");
    // NENHUMA porta de bypass: nem a flag exata, nem qualquer variante da família skip-permissions.
    expect(args.some((a) => /skip-permissions/i.test(a))).toBe(false);
    expect(args).toContain("--permission-mode"); // e o modo é DECLARADO (senão herda o bypass do settings global)
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("default");
  });
});

describe("parseOrchestratorFailure — a CAUSA da morte (PURE)", () => {
  it("extrai a linha de erro do arranque que o CLI escreve em stderr", () => {
    const err = "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons\n";
    expect(parseOrchestratorFailure(err)).toBe(
      "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons",
    );
  });

  it("fica com as ÚLTIMAS linhas (a causa está no fim, não no ruído de progresso)", () => {
    expect(parseOrchestratorFailure("warm-up\nnoise\nA\nB\nC\n")).toBe("A · B · C");
  });

  it("stderr vazio/em branco ⇒ sem causa (nunca lança, nunca inventa)", () => {
    expect(parseOrchestratorFailure("")).toBeUndefined();
    expect(parseOrchestratorFailure("\n  \n")).toBeUndefined();
  });

  it("trunca uma cauda gigante (o estado é um JSON, não um log)", () => {
    expect(parseOrchestratorFailure("x".repeat(5000))!.length).toBe(300);
  });
});

describe("buildOrchestratorMcpConfig — aponta o filho ao MCP AgileHarness deste serviço (PURE)", () => {
  it("monta o http endpoint com token na URL e a porta dada", () => {
    const cfg = JSON.parse(buildOrchestratorMcpConfig("tok", 3008));
    expect(cfg.mcpServers.storymap).toEqual({ type: "http", url: "http://localhost:3008/api/usm/tok/mcp" });
  });
});

// ── Wake — o custo REAL e o motivo do acordar ────────────────────────────────────────────────────────────
describe("parseOrchestratorResult — o custo que o budget cobra", () => {
  it("lê total_cost_usd + o texto final do JSON do CLI", () => {
    const raw = JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.1734, result: "Movi 2 cards e abri 1 aprovação." });
    expect(parseOrchestratorResult(raw)).toEqual({ costUSD: 0.1734, summary: "Movi 2 cards e abri 1 aprovação." });
  });

  it("tolera lixo em volta (um log solto antes do JSON) — varre de trás p/ frente", () => {
    const raw = `algum log\n{"total_cost_usd":0.5,"result":"ok"}\n`;
    expect(parseOrchestratorResult(raw).costUSD).toBe(0.5);
  });

  it("saída ilegível/vazia ⇒ custo 0 (nunca NaN no budget, nunca lança)", () => {
    expect(parseOrchestratorResult("")).toEqual({ costUSD: 0 });
    expect(parseOrchestratorResult("run morto pelo restart")).toEqual({ costUSD: 0 });
  });

  it("custo negativo é clampado (um valor absurdo não pode CREDITAR budget)", () => {
    expect(parseOrchestratorResult(JSON.stringify({ total_cost_usd: -5 })).costUSD).toBe(0);
  });
});

describe("buildOrchestratorPrompt — o motivo do wake vai p/ o agente", () => {
  it("sem motivo: o prompt do tick periódico", () => {
    expect(buildOrchestratorPrompt("acme", "autonomous")).toBe("/storymap-orchestrator acme autonomous --tick");
  });

  it("com motivo: o evento que o acordou entra como contexto", () => {
    expect(buildOrchestratorPrompt("acme", "autonomous", "card X travou")).toBe(
      '/storymap-orchestrator acme autonomous --tick --motivo "card X travou"',
    );
  });

  it("achata aspas e quebras de linha do motivo (o prompt fica legível, argv nunca vira shell)", () => {
    const p = buildOrchestratorPrompt("acme", "autonomous", 'Blocker em "Login"\nsegunda linha');
    expect(p).not.toContain("\n");
    expect(p).toBe('/storymap-orchestrator acme autonomous --tick --motivo "Blocker em Login segunda linha"');
  });
});
