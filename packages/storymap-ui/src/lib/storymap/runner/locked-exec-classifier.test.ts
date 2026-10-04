import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EXEC_CHECK_PREFIXES_ENV, EXEC_CLASSIFIER_ENV, EXEC_LOCK_CONFIG_ENV, checkPrefixesFromEnv, classifierArgvFromEnv, matchesCheckPrefix, classifierFromEnv, lockConfigRefusal, makeClassifier, parseClassification, type ClassifierRun } from "./locked-exec-classifier";

// O CLASSIFICADOR: a trava do host diz se um comando é travado e se pode ganhar o botão. Fail-closed em tudo: sem
// declaração a feature fica inerte; resposta fora do contrato nunca vira «pode».

describe("classifierArgvFromEnv", () => {
  it("ausente ⇒ null (inerte); JSON de textos ⇒ argv; o resto ⇒ erro dizendo o que está errado", () => {
    expect(classifierArgvFromEnv({})).toBeNull();
    expect(classifierArgvFromEnv({ [EXEC_CLASSIFIER_ENV]: '["/opt/porteiro/bin/classifica","--json"]' })).toEqual({ ok: true, argv: ["/opt/porteiro/bin/classifica", "--json"] });
    for (const bad of ["/opt/porteiro/bin/classifica --json", "[]", '[""]', "[1]", '{"a":1}']) {
      expect(classifierArgvFromEnv({ [EXEC_CLASSIFIER_ENV]: bad })).toMatchObject({ ok: false });
    }
  });
  it("classifierFromEnv sem declaração explica que a função está desligada", () => {
    expect(classifierFromEnv(() => "/srv", {})).toMatchObject({ ok: false, why: expect.stringMatching(/desligada/) });
  });
});

describe("parseClassification — estrita", () => {
  it("travado e aprovável só com a palavra explícita da trava", () => {
    expect(parseClassification('{"locked":true,"approvable":true,"rule":"vault-rotate"}')).toMatchObject({ locked: true, approvable: true, rule: "vault-rotate" });
    expect(parseClassification('{"locked":true}')).toMatchObject({ locked: true, approvable: false });
    // «aprovável» sem estar travado não significa nada
    expect(parseClassification('{"locked":false,"approvable":true}')).toMatchObject({ locked: false, approvable: false });
  });
  it.each(["", "nada", "[]", '{"locked":"true"}', '{"locked":true,"approvable":"sim"}', '{"locked":true,"reason":3}'])("fora do contrato ⇒ null: %s", (s) => {
    expect(parseClassification(s)).toBeNull();
  });
});

describe("makeClassifier", () => {
  it("manda a linha de shell citada + cwd no stdin; repassa a config da trava; tira CLAUDE_PROJECT_DIR; roda fora do repo", async () => {
    let seen: { stdin: string; env: NodeJS.ProcessEnv; cwd: string } | null = null;
    const run: ClassifierRun = async (_argv, stdin, opts) => {
      seen = { stdin, env: opts.env, cwd: opts.cwd };
      return { code: 0, stdout: '{"locked":true,"approvable":true}', stderr: "" };
    };
    const classify = makeClassifier({
      argv: ["trava"],
      cwd: () => "/srv/alvo",
      run,
      env: { PATH: "/usr/bin", [EXEC_LOCK_CONFIG_ENV]: "/opt/porteiro/regras.json", CLAUDE_PROJECT_DIR: "/srv/alvo" },
    });
    const r = await classify(["cofre-cli", "rotate", "--lote=2026 b"]);
    expect(r).toMatchObject({ ok: true, c: { locked: true, approvable: true } });
    expect(JSON.parse(seen!.stdin)).toEqual({ command: "cofre-cli rotate '--lote=2026 b'", cwd: "/srv/alvo" });
    expect(seen!.env[EXEC_LOCK_CONFIG_ENV]).toBe("/opt/porteiro/regras.json");
    expect(seen!.env.CLAUDE_PROJECT_DIR).toBeUndefined();
    expect(seen!.cwd).toBe("/");
  });

  it("a cada consulta, reconfere a config: se ela deixou de valer, recusa sem rodar a trava", async () => {
    let ran = 0;
    const classify = makeClassifier({
      argv: ["trava"],
      cwd: () => "/srv",
      run: async () => (ran++, { code: 0, stdout: '{"locked":true,"approvable":true}', stderr: "" }),
      env: {},
      preflight: () => ({ ok: false, why: "config sumiu" }),
    });
    expect(await classify(["cofre-cli"])).toEqual({ ok: false, why: "config sumiu" });
    expect(ran).toBe(0);
  });
  it.each([
    ["saída ≠ 0", { code: 2, stdout: '{"locked":true,"approvable":true}', stderr: "" }],
    ["erro ao rodar", { code: null, stdout: "", stderr: "", error: "ENOENT" }],
    ["JSON torto", { code: 0, stdout: "ok", stderr: "" }],
  ])("falhou (%s) ⇒ recusa, nunca «pode»", async (_n, out) => {
    const classify = makeClassifier({ argv: ["trava"], cwd: () => "/srv", run: async () => out, env: {} });
    expect(await classify(["cofre-cli"])).toMatchObject({ ok: false });
  });
});

describe("a configuração da trava é do HOST (S2)", () => {
  let dir: string;
  let repo: string;
  const ok = '{"liberados":["cofre-rotate"]}';
  const setup = () => {
    dir = mkdtempSync(path.join(tmpdir(), "trava-cfg-"));
    repo = path.join(dir, "alvo");
    mkdirSync(path.join(repo, ".trava"), { recursive: true });
  };
  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  it("fora do repositório, absoluta, JSON objeto ⇒ vale", () => {
    setup();
    try {
      const cfg = path.join(dir, "trava.json");
      writeFileSync(cfg, ok);
      expect(lockConfigRefusal({ [EXEC_LOCK_CONFIG_ENV]: cfg }, repo)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it.each([
    ["ausente", () => ({}), /não declarou/],
    ["relativa", () => ({ [EXEC_LOCK_CONFIG_ENV]: "trava.json" }), /absoluto/],
    ["inexistente", () => ({ [EXEC_LOCK_CONFIG_ENV]: path.join(dir, "nao-existe.json") }), /não existe/],
  ])("%s ⇒ inerte", (_n, envOf, re) => {
    setup();
    try {
      expect(lockConfigRefusal(envOf() as Record<string, string>, repo)).toMatch(re as RegExp);
    } finally {
      cleanup();
    }
  });

  it("DENTRO do repositório alvo — direto ou por link simbólico de fora — ⇒ inerte", () => {
    setup();
    try {
      const inside = path.join(repo, ".trava", "config.json");
      writeFileSync(inside, ok);
      expect(lockConfigRefusal({ [EXEC_LOCK_CONFIG_ENV]: inside }, repo)).toMatch(/DENTRO do repositório/);
      const link = path.join(dir, "atalho.json");
      symlinkSync(inside, link);
      expect(lockConfigRefusal({ [EXEC_LOCK_CONFIG_ENV]: link }, repo)).toMatch(/DENTRO do repositório/);
    } finally {
      cleanup();
    }
  });

  it("JSON ilegível ou que não é objeto ⇒ inerte (a trava cairia noutra config)", () => {
    setup();
    try {
      const cfg = path.join(dir, "trava.json");
      writeFileSync(cfg, "{ quebrado");
      expect(lockConfigRefusal({ [EXEC_LOCK_CONFIG_ENV]: cfg }, repo)).toMatch(/JSON legível/);
      writeFileSync(cfg, "[1]");
      expect(lockConfigRefusal({ [EXEC_LOCK_CONFIG_ENV]: cfg }, repo)).toMatch(/objeto JSON/);
    } finally {
      cleanup();
    }
  });

  it("classifierFromEnv com o classificador declarado mas a config no repositório ⇒ desligada", () => {
    setup();
    try {
      const inside = path.join(repo, ".trava", "config.json");
      writeFileSync(inside, ok);
      const r = classifierFromEnv(() => repo, { [EXEC_CLASSIFIER_ENV]: '["trava"]', [EXEC_LOCK_CONFIG_ENV]: inside });
      expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/desligada/) });
    } finally {
      cleanup();
    }
  });
});

describe("as conferências que o host libera (B2)", () => {
  it("lista declarada ⇒ vale; ausente, ilegível, vazia ou com item torto ⇒ inerte", () => {
    expect(checkPrefixesFromEnv({ [EXEC_CHECK_PREFIXES_ENV]: '[["relogio-cli","consulta"],["cofre-cli","status"]]' })).toEqual({ ok: true, prefixes: [["relogio-cli", "consulta"], ["cofre-cli", "status"]] });
    for (const bad of [undefined, "", "nada", "[]", "[[]]", '[["relogio-cli",""]]', '[["relogio-cli",1]]', '["relogio-cli"]']) {
      expect(checkPrefixesFromEnv(bad === undefined ? {} : { [EXEC_CHECK_PREFIXES_ENV]: bad })).toMatchObject({ ok: false, why: expect.stringMatching(/desligada/) });
    }
  });
  it("casa por prefixo EXATO: programa pelo caminho real, o resto por igualdade", () => {
    const resolve = (a: string) => ({ ok: true as const, path: a.startsWith("/") ? a : `/opt/bin/${a}` });
    const pre = [["cofre-cli", "status", "--json"]];
    expect(matchesCheckPrefix(["cofre-cli", "status", "--json", "--vault=a"], "/opt/bin/cofre-cli", pre, resolve)).toBe(true);
    expect(matchesCheckPrefix(["cofre-cli", "status"], "/opt/bin/cofre-cli", pre, resolve)).toBe(false);
    expect(matchesCheckPrefix(["cofre-cli", "status", "--JSON"], "/opt/bin/cofre-cli", pre, resolve)).toBe(false);
    expect(matchesCheckPrefix(["cofre-cli", "status", "--json"], "/tmp/cofre-cli", pre, resolve)).toBe(false);
  });
});
