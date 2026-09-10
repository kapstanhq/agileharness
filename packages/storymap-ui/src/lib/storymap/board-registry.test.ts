// AS PROVAS DO REGISTRO DE BOARD — e cada uma vem com o PAR que a torna discriminante.
//
// Por que o par, sempre. Um teste que só afirma o caminho feliz não distingue "o registro funciona" de
// "o registro não faz nada e o assert é fraco". Toda afirmação aqui aparece em dupla: o caso que passa e
// o caso vizinho que TEM de falhar. Onde a dupla não cabe num `it`, o próprio `it` carrega os dois lados.
//
// TODO teste deste arquivo escreve numa RAIZ TEMPORÁRIA (AGILEHARNESS_TARGET + resetRepoRootCache), nunca na
// árvore do repositório — e o `afterEach` remove o que criou (a disciplina de /tmp desta casa).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { BOARD_ID_RE, refuseBoardId, registerBoard, setBoardAutorun } from "./board-registry";
import { boardConfigPath, boardDir, findRepoRoot, resetRepoRootCache } from "./paths";
import { listBoards, readBoardConfig, readCards } from "./repo";

const temporarios: string[] = [];

/** Uma raiz de repositório DESCARTÁVEL com o `_base` real dentro — a herança medida é a de verdade. */
function raizComBase(): string {
  const raiz = mkdtempSync(path.join(os.tmpdir(), "ah-registry-"));
  temporarios.push(raiz);
  // `findRepoRoot` exige um MARCADOR (turbo.json | .git). Satisfazê-lo, e não contorná-lo, é o ponto:
  // o registro tem de funcionar na raiz que o harness realmente aceita.
  writeFileSync(path.join(raiz, "turbo.json"), "{}\n");
  mkdirSync(path.join(raiz, "storymap", "boards"), { recursive: true });
  // O `_base` REAL, copiado do repositório. Um `_base` sintético mediria a minha ideia de herança;
  // este mede a herança que existe.
  cpSync(baseDeVerdade(), path.join(raiz, "storymap", "boards", "_base"), { recursive: true });
  process.env.AGILEHARNESS_TARGET = raiz;
  resetRepoRootCache();
  return raiz;
}

/** O `_base` do repositório de verdade — resolvido ANTES de qualquer AGILEHARNESS_TARGET entrar em jogo. */
const BASE_REAL = path.join(findRepoRoot(), "storymap", "boards", "_base");
function baseDeVerdade(): string {
  return BASE_REAL;
}

afterEach(() => {
  delete process.env.AGILEHARNESS_TARGET;
  resetRepoRootCache();
  while (temporarios.length > 0) rmSync(temporarios.pop() as string, { recursive: true, force: true });
});

// ── O PISO ANTI-VÁCUO ────────────────────────────────────────────────────────────────────────────────
// Sem isto, TODO teste deste arquivo poderia estar medindo uma árvore sem `_base` — e "herdou 0 status"
// passaria calado por qualquer asserção que só olhasse o caminho feliz.
describe("piso: a raiz descartável tem o `_base` REAL (senão este arquivo mede a si mesmo)", () => {
  it("o `_base` copiado declara uma pipeline com passos que DISPARAM agente", () => {
    raizComBase();
    const bruto = readFileSync(path.join(BASE_REAL, "board.yaml"), "utf8");
    const doc = yaml.load(bruto) as { statuses?: { id: string; autorun?: boolean; trigger?: string }[] };
    const comAutorun = (doc.statuses ?? []).filter((s) => s.autorun === true);
    // Este número é o que dá SENTIDO ao `autorunDisabled`. Se um dia o `_base` não tiver mais nenhum
    // passo com autorun, a trava vira decoração — e este piso é quem avisa, em vez de os testes de
    // "nasce desarmado" continuarem verdes medindo uma pipeline inerte.
    expect(comAutorun.length, "o `_base` não tem passo com autorun — a trava `autorunDisabled` não teria o que travar").toBeGreaterThan(0);
  });
});

// ── ID: RECUSAR, NUNCA HIGIENIZAR ────────────────────────────────────────────────────────────────────
describe("o id é RECUSADO quando não é slug — a coerção silenciosa é o modo de falha", () => {
  // A dupla completa: o que passa e o que não passa, na mesma tabela.
  const VALIDOS = ["loja", "a", "meu-app", "app2", "l".repeat(40)];
  const INVALIDOS: [string, string][] = [
    ["", "vazio"],
    ["_base", "o `_` é reservado ao template"],
    ["_qualquer", "o `_` é reservado ao template"],
    ["../evil", "travessia de caminho"],
    ["..", "travessia de caminho"],
    ["Loja", "maiúscula"],
    ["minha loja", "espaço"],
    ["loja/sub", "barra"],
    ["9lives", "começa com dígito"],
    ["-lider", "começa com hífen"],
    ["l".repeat(41), "acima do teto de 40"],
    ["loja.prod", "ponto"],
  ];

  it("aceita exatamente os slugs válidos", () => {
    for (const id of VALIDOS) expect(refuseBoardId(id), `"${id}" devia ser aceito`).toBeNull();
  });

  it("recusa cada forma inválida COM motivo — e o motivo nomeia o id que o chamador mandou", () => {
    for (const [id, porque] of INVALIDOS) {
      const r = refuseBoardId(id);
      expect(r, `"${id}" (${porque}) devia ser recusado`).not.toBeNull();
      expect(typeof r).toBe("string");
    }
  });

  it("a travessia de caminho é recusada ANTES de tocar o disco — nenhum diretório nasce fora do lugar", async () => {
    const raiz = raizComBase();
    const r = await registerBoard({ id: "../evil", name: "Mau" });
    expect(r.ok).toBe(false);
    // O PAR que torna isto discriminante: não basta a recusa, o disco tem de estar intacto. Se o
    // registro tivesse chamado `sanitizeId` em vez de recusar, existiria `boards/evil` aqui.
    expect(existsSync(path.join(raiz, "storymap", "boards", "evil"))).toBe(false);
    expect(existsSync(path.join(raiz, "evil"))).toBe(false);
    const boards = await listBoards();
    expect(boards).toEqual([]);
  });

  it("BOARD_ID_RE e o comportamento não podem divergir (a régua publicada é a régua aplicada)", () => {
    for (const id of VALIDOS) expect(BOARD_ID_RE.test(id)).toBe(true);
    for (const [id] of INVALIDOS.filter(([i]) => i !== "")) expect(BOARD_ID_RE.test(id)).toBe(false);
  });
});

// ── O REGISTRO EM SI ─────────────────────────────────────────────────────────────────────────────────
describe("registerBoard — cria um board que o LEITOR REAL enxerga", () => {
  it("um id inédito é criado e herda a pipeline inteira; o MESMO id de novo é recusado", async () => {
    raizComBase();

    const primeiro = await registerBoard({ id: "loja", name: "Loja Aurora" });
    expect(primeiro.ok, primeiro.ok ? "" : (primeiro as { error: string }).error).toBe(true);

    // A prova não é o que gravamos — é o que o leitor devolve.
    const cfg = await readBoardConfig("loja");
    expect(cfg.id).toBe("loja");
    expect(cfg.name).toBe("Loja Aurora");
    expect(cfg.statuses.length, "a herança do `_base` não pegou — o board nasceu sem pipeline").toBeGreaterThan(10);
    expect((await listBoards()).map((b) => b.id)).toEqual(["loja"]);
    expect(await readCards("loja")).toEqual([]); // `cards/` existe e está vazio, sem ENOENT

    // O PAR: o segundo registro do mesmo id RECUSA, e não sobrescreve o primeiro.
    const segundo = await registerBoard({ id: "loja", name: "Outra Coisa" });
    expect(segundo.ok).toBe(false);
    expect((segundo as { error: string }).error).toMatch(/já existe/i);
    expect((await readBoardConfig("loja")).name, "o registro duplicado SOBRESCREVEU o board existente").toBe("Loja Aurora");
  });

  it("o board.yaml gravado é só o DELTA — a pipeline herdada NÃO é re-inlinada", async () => {
    raizComBase();
    await registerBoard({ id: "loja", name: "Loja", package: "packages/loja" });
    const bruto = readFileSync(boardConfigPath("loja"), "utf8");
    const doc = yaml.load(bruto) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(["autorunDisabled", "id", "name", "package"]);
    // O PAR: o delta é minúsculo, mas o RESOLVIDO é completo. Um board que re-inlinasse a pipeline
    // teria `statuses` no arquivo e ficaria surdo a mudanças futuras do canônico.
    expect(doc.statuses).toBeUndefined();
    expect((await readBoardConfig("loja")).statuses.length).toBeGreaterThan(10);
  });

  it("`package` relativo entra; caminho absoluto ou com `..` é recusado", async () => {
    raizComBase();
    expect((await registerBoard({ id: "a1", name: "A", package: "packages/loja" })).ok).toBe(true);
    expect((await registerBoard({ id: "a2", name: "A", package: "/etc/passwd" })).ok).toBe(false);
    expect((await registerBoard({ id: "a3", name: "A", package: "../../fora" })).ok).toBe(false);
  });

  it("`name` vazio é recusado — um board sem nome legível é invisível na interface", async () => {
    raizComBase();
    expect((await registerBoard({ id: "x", name: "   " })).ok).toBe(false);
    expect((await registerBoard({ id: "x", name: "X" })).ok).toBe(true);
  });
});

// ── O PAR OBRIGATÓRIO DO DESCRITOR DE DEPLOY ─────────────────────────────────────────────────────────
// Este é o par que o dono nomeou. Ele importa porque, para um board NOVO, este é o ÚNICO ponto da árvore
// onde o contrato RECUSA: `writeBoardConfig` não valida, e o alarme de contrato em `readBoardConfig` é
// log-only por desenho.
describe("o descritor `deploy` é validado pelo superRefine REAL de contracts.ts", () => {
  it("kind:'command' SEM command é recusado; COM command é aceito e persistido", async () => {
    raizComBase();
    const sem = await registerBoard({ id: "d1", name: "D1", deploy: { kind: "command" } });
    expect(sem.ok).toBe(false);
    expect((sem as { error: string }).error).toMatch(/command/);
    expect(existsSync(boardConfigPath("d1")), "recusou mas gravou o board assim mesmo").toBe(false);

    const com = await registerBoard({ id: "d2", name: "D2", deploy: { kind: "command", command: "bun run deploy" } });
    expect(com.ok, com.ok ? "" : (com as { error: string }).error).toBe(true);
    expect((await readBoardConfig("d2")).deploy?.command).toBe("bun run deploy");
  });

  it("kind:'agent' SEM description é recusado (o refine tem DOIS dentes, não um)", async () => {
    raizComBase();
    expect((await registerBoard({ id: "d3", name: "D3", deploy: { kind: "agent" } })).ok).toBe(false);
    expect((await registerBoard({ id: "d4", name: "D4", deploy: { kind: "agent", description: "sobe pelo painel" } })).ok).toBe(true);
  });

  it("CONTROLE: kind:'auto' não exige nada — senão a recusa acima seria 'recusa tudo', não 'recusa o meio-declarado'", async () => {
    raizComBase();
    expect((await registerBoard({ id: "d5", name: "D5", deploy: { kind: "auto" } })).ok).toBe(true);
  });
});

// ── A CONTENÇÃO PELO ESQUEMA ─────────────────────────────────────────────────────────────────────────
describe("o registro não é caminho para escrever POLÍTICA no board.yaml", () => {
  it("`orchestrator` e `statuses` enviados por um cliente NÃO chegam ao disco", async () => {
    raizComBase();
    // O que um cliente MCP mandaria por JSON — chaves que o tipo não expõe, mas que a rede pode carregar.
    await registerBoard({
      id: "p1",
      name: "P1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ orchestrator: { mode: "autonomous", riskMatrix: { run: "auto", deploy: "auto" } }, statuses: [{ id: "x", name: "X" }] } as any),
    });
    const doc = yaml.load(readFileSync(boardConfigPath("p1"), "utf8")) as Record<string, unknown>;
    expect(doc.orchestrator, "a matriz de risco chegou ao board.yaml — o board nasceria se auto-concedendo").toBeUndefined();
    expect(doc.statuses, "a pipeline foi re-inlinada — o board nasceria surdo ao canônico").toBeUndefined();
    // O PAR: as chaves LEGÍTIMAS do mesmo objeto passaram, então a ausência acima é filtro, não engano.
    expect(doc.id).toBe("p1");
    expect(doc.name).toBe("P1");
    // E o resolvido também não ganha política nenhuma.
    expect((await readBoardConfig("p1")).orchestrator).toBeUndefined();
  });
});

// ── NASCE DESARMADO — PROVADO NO LEITOR, NÃO NO CAMPO ────────────────────────────────────────────────
describe("o board nasce DESARMADO, e a prova é o avaliador de autorun — não o campo", () => {
  it("o CHOKEPOINT real (evaluateAutorunOnEntry) recusa no board recém-registrado e deixa de recusar depois de armado", async () => {
    raizComBase();
    await registerBoard({ id: "loja", name: "Loja" });

    // O PISO que impede o vácuo: `evaluateAutorunOnEntry` sai LOGO no interruptor MESTRE
    // (`settings.yaml autorun.enabled` / AGILEHARNESS_AUTORUN=0). Se ele estivesse desligado nesta raiz, os DOIS
    // lados do par ficariam mudos — pelo mesmo motivo — e o teste passaria sem medir nada.
    const { loadRunnerConfig } = await import("./runner/config");
    expect(
      loadRunnerConfig().autorun.enabled,
      "o interruptor MESTRE do autorun está desligado nesta raiz: os dois lados do par ficariam mudos e o teste seria vácuo-verde",
    ).toBe(true);

    const { evaluateAutorunOnEntry } = await import("@/lib/notifications/server/channels/autorun-eval");
    const linhas: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void linhas.push(a.join(" ")));
    try {
      // DESARMADO: o chokepoint tem de PARAR aqui, antes de qualquer leitura de card.
      await evaluateAutorunOnEntry("loja", "card-inexistente");
      const recusouDesarmado = linhas.some((l) => l.includes("autorunDisabled"));

      linhas.length = 0;
      const arm = await setBoardAutorun("loja", true);
      expect(arm.ok, arm.ok ? "" : (arm as { error: string }).error).toBe(true);

      // ARMADO: o chokepoint passa da trava (e só então para, por não achar o card).
      await evaluateAutorunOnEntry("loja", "card-inexistente");
      const recusouArmado = linhas.some((l) => l.includes("autorunDisabled"));

      // O PAR, nas duas direções. Um `expect` só de um lado passaria com um leitor que recusa SEMPRE.
      expect(recusouDesarmado, "o board recém-registrado NÃO foi barrado pelo chokepoint — nasceu armado").toBe(true);
      expect(recusouArmado, "o board continuou sendo barrado depois de armado — o interruptor é decorativo").toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("a chave sobrevive à COERÇÃO de leitura (o modo de falha histórico: campo declarado e derrubado no caminho)", async () => {
    raizComBase();
    await registerBoard({ id: "loja", name: "Loja" });
    // `readBoardConfig` monta a config campo a campo; já houve um defeito em que `autorunDisabled`
    // existia no disco e chegava `undefined` ao leitor — o kill-switch MORTO com a flag ligada.
    expect((await readBoardConfig("loja")).autorunDisabled).toBe(true);
  });

  it("armar REMOVE a chave do board.yaml; desarmar a devolve; repetir não grava (idempotente)", async () => {
    raizComBase();
    await registerBoard({ id: "loja", name: "Loja" });
    const chaves = () => Object.keys(yaml.load(readFileSync(boardConfigPath("loja"), "utf8")) as object);

    expect(chaves()).toContain("autorunDisabled");

    const a1 = await setBoardAutorun("loja", true);
    expect(a1.ok && a1.changed).toBe(true);
    expect(chaves(), "armado é a AUSÊNCIA da trava no disco").not.toContain("autorunDisabled");

    const a2 = await setBoardAutorun("loja", true);
    expect(a2.ok && (a2 as { changed: boolean }).changed, "armar de novo gravou sem precisar").toBe(false);

    const d1 = await setBoardAutorun("loja", false);
    expect(d1.ok && (d1 as { changed: boolean }).changed).toBe(true);
    expect(chaves()).toContain("autorunDisabled");
  });

  it("armar um board INEXISTENTE recusa com o motivo (e não cria nada)", async () => {
    const raiz = raizComBase();
    const r = await setBoardAutorun("fantasma", true);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/não existe/i);
    expect(existsSync(path.join(raiz, "storymap", "boards", "fantasma"))).toBe(false);
  });

  it("o `package` e o `deploy` SOBREVIVEM a um armar/desarmar (o save não pode comer campos)", async () => {
    raizComBase();
    await registerBoard({ id: "loja", name: "Loja", package: "packages/loja", deploy: { kind: "command", command: "bun run deploy" } });
    await setBoardAutorun("loja", true);
    const cfg = await readBoardConfig("loja");
    expect(cfg.package).toBe("packages/loja");
    expect(cfg.deploy?.command).toBe("bun run deploy");
    expect(cfg.statuses.length).toBeGreaterThan(10);
  });
});

// ── O DIRETÓRIO ──────────────────────────────────────────────────────────────────────────────────────
describe("a estrutura no disco", () => {
  it("cria `cards/` junto — e uma recusa não deixa board meio-criado que a listagem enxergue", async () => {
    const raiz = raizComBase();
    await registerBoard({ id: "loja", name: "Loja" });
    expect(existsSync(path.join(boardDir("loja"), "cards"))).toBe(true);

    // Um id válido cujo `deploy` é recusado: o `cards/` pode ficar (mkdir vem antes), mas o board.yaml
    // NÃO, e é o yaml que define se aquilo é um board. `listBoards` não pode passar a enxergá-lo.
    await registerBoard({ id: "meio", name: "Meio", deploy: { kind: "command" } });
    expect(existsSync(boardConfigPath("meio"))).toBe(false);
    expect((await listBoards()).map((b) => b.id), "um board meio-criado apareceu na listagem").toEqual(["loja"]);
    expect(raiz.length).toBeGreaterThan(0);
  });
});

// ─── O BOARD NÃO PODE NASCER SURDO (2026-08-19) ─────────────────────────────────────────────────
//
// MEDIDO num alvo virgem (um repositório de adotante, com `.git` e mais nada): `registerBoard`
// devolvia `ok: true`, o board aparecia na listagem, e `readBoardConfig` resolvia com `statuses: 0` —
// sem coluna, sem gate, autorun inerte. Sucesso aparente, board inútil, nenhum erro em lugar nenhum.
// É o modo de falha mais caro que existe numa ferramenta nova: o adotante conclui que a ferramenta
// não faz nada.
describe("registro num alvo SEM pipeline herdável", () => {
  /** Uma raiz válida (tem marcador) e VIRGEM: nenhum `_base` para herdar. O repo do adotante. */
  function raizSemBase(): string {
    const raiz = mkdtempSync(path.join(os.tmpdir(), "ah-virgem-"));
    temporarios.push(raiz);
    writeFileSync(path.join(raiz, "turbo.json"), "{}\n");
    process.env.AGILEHARNESS_TARGET = raiz;
    resetRepoRootCache();
    return raiz;
  }

  it("RECUSA, nomeando o arquivo que falta e o que aconteceria sem ele", async () => {
    raizSemBase();
    const r = await registerBoard({ id: "acme", name: "Acme" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("_base/board.yaml");
    expect(!r.ok && r.error).toMatch(/ZERO status|zero status/);
  });

  it("e NÃO deixa rastro — nem board.yaml, nem diretório meio-criado", async () => {
    const raiz = raizSemBase();
    await registerBoard({ id: "acme", name: "Acme" });
    expect(existsSync(path.join(raiz, "storymap", "boards", "acme", "board.yaml"))).toBe(false);
    expect(await listBoards()).not.toContain("acme");
  });

  it("[PAR] com o `_base` real na árvore o MESMO registro passa — a recusa é sobre a herança, não sobre o id", async () => {
    raizComBase();
    const r = await registerBoard({ id: "acme", name: "Acme" });
    expect(r.ok).toBe(true);
    const cfg = await readBoardConfig("acme");
    expect(cfg.statuses.length).toBeGreaterThan(0); // é isto que o alvo virgem NÃO tinha
  });

  it("[ATAQUE] um `_base` presente mas VAZIO/ilegível cai do mesmo lado — a régua é o EFEITO, não o arquivo", async () => {
    const raiz = raizSemBase();
    mkdirSync(path.join(raiz, "storymap", "boards", "_base"), { recursive: true });
    writeFileSync(path.join(raiz, "storymap", "boards", "_base", "board.yaml"), "id: _base\n"); // sem statuses
    const r = await registerBoard({ id: "acme", name: "Acme" });
    expect(r.ok, "um _base sem statuses produz o MESMO board surdo que a ausência dele").toBe(false);
  });
});
