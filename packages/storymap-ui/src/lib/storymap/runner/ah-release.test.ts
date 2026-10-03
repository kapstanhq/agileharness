// contrib/ah-release — o release da ferramenta com recibo: o plano em --dry-run, as recusas, o recibo gravado no swap, a
// conferência da versão VIVA depois do restart e o rollback quando ela diverge. O script roda DE VERDADE (bash), mas num
// repositório descartável e com `bun`, `ah-safe-restart` e `curl` trocados por shims no PATH: nada toca o serviço real, o
// systemd nem a rede, e o ambiente do filho é montado do zero (nenhum token real vaza para o teste).
//
// O «PROCESSO» É FIEL À ROTA (revisão do WP6b). O curl de antes respondia a tag que o teste mandasse, e foi assim que a
// conferência pareceu provar algo que a rota real não provava. Agora o processo vivo é uma FOTO (`process.json`) tirada
// como o register() tira: o recibo do disco e o BUILD_ID do `.next`, no instante em que ele «sobe» — o restart. Sem restart,
// o processo segue dizendo o que carregou, por mais que o disco mude.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "../../../../../../contrib/ah-release");
const TOKEN = "tok-de-teste-NAO-E-SEGREDO-0123456789abcdef";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const FULL_SHA = (src: string, tag: string) => git(src, "rev-parse", `${tag}^{commit}`).stdout.trim();

interface Sandbox {
  root: string;
  src: string;
  rel: string;
  ui: string;
  log: string;
  /** roda o script com o ambiente descartável (sem herdar o do processo). */
  run(args: string[], env?: Record<string, string>): { code: number; out: string; err: string };
  calls(): string[];
  /** o processo «sobe» agora: fotografa o recibo e o BUILD_ID do disco (o que o register() faz). */
  boot(): void;
  /** grava um recibo do release no disco (sha REAL da tag, build «old» = o `.next` de agora, salvo `over`). */
  receipt(tag: string, over?: Record<string, unknown>): void;
}

/**
 * O mundo do release: um repositório de desenvolvimento (`src`, com as tags v1.0.0 e v1.1.0), o clone de release (`rel`, no
 * v1.0.0, com o bundle e o `.next` «velhos» no lugar), e os shims. `rel` nasce SEM recibo, como na primeira vez que o release
 * passa a existir; o teste do recibo anterior o escreve.
 */
function sandbox(): Sandbox {
  const root = mkdtempSync(path.join(os.tmpdir(), "ah-release-"));
  roots.push(root);
  const src = path.join(root, "src");
  const rel = path.join(root, "rel");
  const bin = path.join(root, "bin");
  const log = path.join(root, "log");
  mkdirSync(src);
  mkdirSync(bin);
  mkdirSync(log);
  git(src, "init", "-q", "-b", "main");
  writeFileSync(path.join(src, "a.txt"), "1\n");
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "um");
  git(src, "tag", "v1.0.0");
  writeFileSync(path.join(src, "a.txt"), "2\n");
  git(src, "commit", "-q", "-am", "dois");
  git(src, "tag", "v1.1.0");
  git(root, "clone", "-q", src, rel);
  git(rel, "checkout", "-q", "--detach", "v1.0.0");

  const ui = path.join(rel, "packages", "storymap-ui");
  mkdirSync(path.join(ui, "dist"), { recursive: true });
  mkdirSync(path.join(ui, ".next"), { recursive: true });
  writeFileSync(path.join(ui, "dist", "ah-server.mjs"), "OLD-BUNDLE\n");
  writeFileSync(path.join(ui, ".next", "BUILD_ID"), "old\n");

  const shim = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  shim(
    "bun",
    `echo "bun $*" >> "$SHIM_LOG/calls.log"
if [ "$1" = run ] && [ "$2" = build:staged ]; then mkdir -p dist .next-staging; echo NEW-BUNDLE > dist/ah-server.staged.mjs; echo new > .next-staging/BUILD_ID; fi
exit 0`,
  );
  // O BOOT do processo, como o register() faz (tool-version.ts): fotografa o recibo e o BUILD_ID do .next; a versão que a
  // rota dirá é a do recibo SÓ se o buildId dele for o do build carregado.
  shim(
    "shim-boot",
    `python3 - "$SHIM_UI" "$SHIM_LOG/process.json" <<'PY'
import json, sys
ui, out = sys.argv[1], sys.argv[2]
try:
    built = open(ui + "/.next/BUILD_ID").read().strip()
except Exception:
    built = None
try:
    r = json.load(open(ui + "/dist/ah-version.json"))
except Exception:
    r = None
ok = bool(r) and built is not None and r.get("buildId") == built
json.dump({"ok": True, "tag": r["tag"] if ok else None, "buildId": built if ok else None}, open(out, "w"))
PY`,
  );
  // O 1º restart devolve $SHIM_RESTART_RC; o restart do ROLLBACK (o 2º) sempre devolve 0. Restart bem-sucedido = o processo
  // sobe de novo (nova foto) — salvo $SHIM_RESTART_STALE=1 (o systemd disse ok, mas o processo velho ficou). Com
  // $SHIM_RESTART_KILL=1 o 1º restart MATA o script (o timeout do tool que a revisão descreveu) antes de reiniciar nada.
  shim(
    "ah-safe-restart",
    `echo restart >> "$SHIM_LOG/calls.log"
n=$(grep -c '^restart$' "$SHIM_LOG/calls.log")
if [ "$n" -le 1 ] && [ "\${SHIM_RESTART_KILL:-0}" = 1 ]; then kill -KILL "$PPID"; exit 1; fi
rc=0
if [ "$n" -le 1 ]; then rc="\${SHIM_RESTART_RC:-0}"; fi
if [ "$rc" = 0 ] && { [ "$n" -gt 1 ] || [ "\${SHIM_RESTART_STALE:-0}" != 1 ]; }; then shim-boot; fi
exit "$rc"`,
  );
  // O curl de mentira lê a config do stdin (é por onde o token DEVE chegar), registra o argv e responde o que o PROCESSO
  // fotografou no boot. $SHIM_VERSION_TAG força outra tag na resposta (o serviço diz rodar outra coisa).
  shim(
    "curl",
    `echo "$@" >> "$SHIM_LOG/curl-argv.log"
cat >> "$SHIM_LOG/curl-stdin.log"
case "\${SHIM_CURL_MODE:-ok}" in
  ok) python3 -c 'import json, os, sys; d = json.load(open(sys.argv[1])); t = os.environ.get("SHIM_VERSION_TAG"); d.update({"tag": t} if t else {}); print(json.dumps(d))' "$SHIM_LOG/process.json"; printf '200' ;;
  unauthorized) printf 'Unauthorized\\n401' ;;
  down) exit 7 ;;
esac`,
  );

  const sb: Sandbox = {
    root,
    src,
    rel,
    ui,
    log,
    run(args, env = {}) {
      const r = spawnSync("bash", [SCRIPT, ...args], {
        encoding: "utf8",
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: root,
          AH_SRC: src,
          AH_REL: rel,
          AH_VERIFY_SLEEP: "0",
          // sem credencial por padrão E sem o arquivo de token real da máquina: cada teste declara o que quer
          AH_TOKEN_ENV_FILE: path.join(root, "nao-existe.env"),
          SHIM_LOG: log,
          SHIM_UI: ui,
          NODE_ENV: "test",
          ...env,
        },
      });
      return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
    },
    calls: () => (existsSync(path.join(log, "calls.log")) ? readFileSync(path.join(log, "calls.log"), "utf8").split("\n").filter(Boolean) : []),
    boot: () => {
      spawnSync(path.join(bin, "shim-boot"), [], { env: { PATH: `${bin}:/usr/bin:/bin`, SHIM_LOG: log, SHIM_UI: ui, NODE_ENV: "test" } });
    },
    receipt: (tag, over = {}) =>
      writeFileSync(
        path.join(ui, "dist", "ah-version.json"),
        JSON.stringify({ tag, sha: FULL_SHA(src, tag), at: "2026-10-01T00:00:00Z", prev: null, buildId: "old", ...over }),
      ),
  };
  // o processo que está no ar quando o release começa: subiu com o disco de agora (sem recibo, build «old»)
  sb.boot();
  return sb;
}

const read = (...p: string[]) => readFileSync(path.join(...p), "utf8");
const sha = (sb: Sandbox, ref: string) => git(sb.src, "rev-parse", `${ref}^{commit}`).stdout.trim();

describe("ah-release --dry-run — só o plano", () => {
  it("imprime o plano COMPLETO (inclusive o recibo e a conferência da versão) e não toca em nada", () => {
    const sb = sandbox();
    const r = sb.run(["v1.1.0", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/plano: v1\.0\.0 → v1\.1\.0/);
    for (const passo of ["1. git", "2. bun install", "3. suíte inteira", "4. bun run build:staged", "5. swap atômico", "recibo dist/ah-version.json", "6. ah-safe-restart", "7. conferir", "8. se o restart OU a conferência falharem"]) {
      expect(r.out, `plano sem «${passo}»`).toContain(passo);
    }
    expect(r.out).toMatch(/dry-run: nada foi alterado/);
    expect(sb.calls()).toEqual([]); // nem bun, nem restart
    expect(existsSync(path.join(sb.ui, ".next-prev"))).toBe(false);
    expect(existsSync(path.join(sb.ui, "dist", "ah-version.json"))).toBe(false);
    expect(git(sb.rel, "describe", "--tags", "--exact-match").stdout.trim()).toBe("v1.0.0"); // o clone de release não saiu do lugar
  });

  it("recusa tag inexistente, tag com caractere perigoso, argumento desconhecido e uso sem tag", () => {
    const sb = sandbox();
    const missing = sb.run(["v9.9.9", "--dry-run"]);
    expect(missing.code).toBe(2);
    expect(missing.err).toMatch(/tag inexistente.*v9\.9\.9/);
    const evil = sb.run(["v1.1.0;rm", "--dry-run"]);
    expect(evil.code).toBe(2);
    expect(evil.err).toMatch(/tag inválida/);
    expect(sb.run(["v1.1.0", "--dry-run", "--nada"]).code).toBe(2);
    expect(sb.run([]).code).toBe(2);
  });

  it("recusa a árvore de desenvolvimento SUJA (o que foi taguado tem de ser o que está no disco)", () => {
    const sb = sandbox();
    writeFileSync(path.join(sb.src, "a.txt"), "mexi depois da tag\n");
    const r = sb.run(["v1.1.0", "--dry-run"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/árvore de desenvolvimento SUJA/);
  });
});

describe("ah-release — o swap grava o recibo e confere a versão viva", () => {
  it("caminho feliz: o bundle novo entra, o recibo {tag, sha inteiro, at, prev, buildId} é gravado e a versão VIVA é conferida (token só pelo stdin)", () => {
    const sb = sandbox();
    const r = sb.run(["v1.1.0", "--skip-tests"], { AH_VERSION_TOKEN: TOKEN });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no ar e CONFERIDO: v1\.1\.0/);

    expect(read(sb.ui, "dist", "ah-server.mjs")).toBe("NEW-BUNDLE\n");
    expect(read(sb.ui, "dist", "ah-server.v1.0.0.bak.mjs")).toBe("OLD-BUNDLE\n"); // o anterior, guardado com nome
    expect(read(sb.ui, ".next", "BUILD_ID")).toBe("new\n");
    expect(read(sb.ui, ".next-prev", "BUILD_ID")).toBe("old\n");

    const receipt = JSON.parse(read(sb.ui, "dist", "ah-version.json")) as { tag: string; sha: string; at: string; prev: string; buildId: string };
    // o buildId é o do `.next` que o swap pôs no lugar: é o que liga o recibo ao build (tool-version.ts)
    expect(receipt).toMatchObject({ tag: "v1.1.0", sha: sha(sb, "v1.1.0"), prev: "v1.0.0", buildId: "new" });
    expect(receipt.sha).toHaveLength(40);
    expect(Number.isFinite(Date.parse(receipt.at))).toBe(true);
    expect(existsSync(path.join(sb.ui, "dist", "ah-version.json.tmp"))).toBe(false); // tmp + mv: nunca meio-escrito

    expect(sb.calls().filter((c) => c === "restart")).toHaveLength(1);
    // o token chegou ao curl pelo STDIN (config) e NUNCA pela linha de comando (qualquer usuário lê `ps`)
    expect(read(sb.log, "curl-stdin.log")).toContain(`Authorization: Bearer ${TOKEN}`);
    expect(read(sb.log, "curl-argv.log")).not.toContain(TOKEN);
    expect(r.out + r.err).not.toContain(TOKEN);
  });

  it("o recibo anterior fica guardado e o `prev` do novo aponta para ele", () => {
    const sb = sandbox();
    sb.receipt("v1.0.0");
    sb.boot();
    const r = sb.run(["v1.1.0", "--skip-tests"], { AH_VERSION_TOKEN: TOKEN });
    expect(r.code).toBe(0);
    expect(JSON.parse(read(sb.ui, "dist", "ah-version.v1.0.0.bak.json")).tag).toBe("v1.0.0");
    expect(JSON.parse(read(sb.ui, "dist", "ah-version.json"))).toMatchObject({ tag: "v1.1.0", prev: "v1.0.0" });
  });

  it("a credencial pode vir do arquivo de token (a variável de LEITURA), sem ser impressa", () => {
    const sb = sandbox();
    const tokenFile = path.join(sb.root, "ro-token.env");
    writeFileSync(tokenFile, `AGILEHARNESS_MCP_TOKEN_RO=${TOKEN}\n`);
    const r = sb.run(["v1.1.0", "--skip-tests"], { AH_TOKEN_ENV_FILE: tokenFile });
    expect(r.code).toBe(0);
    expect(read(sb.log, "curl-stdin.log")).toContain(`Bearer ${TOKEN}`);
    expect(r.out + r.err).not.toContain(TOKEN);
  });
});

describe("ah-release — a versão viva diverge ou o restart falha: rollback", () => {
  it("o serviço diz rodar OUTRA tag ⇒ volta ao bundle, ao .next e ao recibo anteriores e reinicia de novo (saída 5)", () => {
    const sb = sandbox();
    sb.receipt("v1.0.0");
    sb.boot();
    const r = sb.run(["v1.1.0", "--skip-tests"], { AH_VERSION_TOKEN: TOKEN, SHIM_VERSION_TAG: "v1.0.0" });
    expect(r.code).toBe(5);
    expect(r.err).toMatch(/o serviço vivo diz rodar «v1\.0\.0».*não v1\.1\.0/);
    expect(r.err).toMatch(/A VERSÃO VIVA NÃO É v1\.1\.0 — voltando ao v1\.0\.0/);
    expect(read(sb.ui, "dist", "ah-server.mjs")).toBe("OLD-BUNDLE\n");
    expect(read(sb.ui, ".next", "BUILD_ID")).toBe("old\n");
    expect(JSON.parse(read(sb.ui, "dist", "ah-version.json")).tag).toBe("v1.0.0"); // o recibo volta com o bundle
    expect(sb.calls().filter((c) => c === "restart")).toHaveLength(2); // o do swap e o do rollback
  });

  it("o restart diz ok mas o processo VELHO ficou (mesma tag, outro build) ⇒ a conferência pelo build pega, e é rollback", () => {
    // --force da MESMA tag: a tag sozinha não separa o processo velho do novo; o BUILD_ID separa.
    const sb = sandbox();
    sb.receipt("v1.1.0");
    sb.boot();
    const r = sb.run(["v1.1.0", "--skip-tests", "--force"], { AH_VERSION_TOKEN: TOKEN, SHIM_RESTART_STALE: "1" });
    expect(r.code).toBe(5);
    expect(r.err).toMatch(/build old.*não v1\.1\.0 \(build new\)/);
    expect(read(sb.ui, ".next", "BUILD_ID")).toBe("old\n");
  });

  it("sem recibo anterior, o rollback não deixa recibo mentindo: nenhum arquivo", () => {
    const sb = sandbox();
    const r = sb.run(["v1.1.0", "--skip-tests"], { AH_VERSION_TOKEN: TOKEN, SHIM_VERSION_TAG: "v1.0.0" });
    expect(r.code).toBe(5);
    expect(existsSync(path.join(sb.ui, "dist", "ah-version.json"))).toBe(false);
    expect(read(sb.ui, "dist", "ah-server.mjs")).toBe("OLD-BUNDLE\n");
  });

  it("o serviço NÃO responde à conferência ⇒ também é rollback (não dá para dizer que a versão está no ar)", () => {
    const sb = sandbox();
    const r = sb.run(["v1.1.0", "--skip-tests"], { AH_VERSION_TOKEN: TOKEN, SHIM_CURL_MODE: "down" });
    expect(r.code).toBe(5);
    expect(r.err).toMatch(/não respondeu/);
    expect(read(sb.ui, "dist", "ah-server.mjs")).toBe("OLD-BUNDLE\n");
  });

  it("o restart falha ⇒ rollback (o comportamento de antes continua) e o recibo novo não fica", () => {
    const sb = sandbox();
    const r = sb.run(["v1.1.0", "--skip-tests"], { AH_VERSION_TOKEN: TOKEN, SHIM_RESTART_RC: "5" });
    expect(r.code).toBe(5);
    expect(r.err).toMatch(/REINÍCIO FALHOU — voltando ao v1\.0\.0/);
    expect(read(sb.ui, "dist", "ah-server.mjs")).toBe("OLD-BUNDLE\n");
    expect(existsSync(path.join(sb.ui, "dist", "ah-version.json"))).toBe(false);
    expect(existsSync(path.join(sb.log, "curl-argv.log"))).toBe(false); // nem chegou a conferir
  });
});

describe("ah-release — o rollback devolve o CLONE também, e o próximo release sabe de onde parte (defeito 2 da revisão)", () => {
  it("rollback ⇒ o clone volta ao sha que estava no ar e as dependências dele são reinstaladas ANTES do restart do rollback", () => {
    const sb = sandbox();
    sb.receipt("v1.0.0");
    sb.boot();
    const r = sb.run(["v1.1.0", "--skip-tests"], { AH_VERSION_TOKEN: TOKEN, SHIM_VERSION_TAG: "v1.0.0" });
    expect(r.code).toBe(5);
    expect(git(sb.rel, "rev-parse", "HEAD").stdout.trim()).toBe(sha(sb, "v1.0.0"));
    // a ordem: install da tag nova, restart do swap, install do rollback (o node_modules de v1.0.0), restart do rollback
    expect(sb.calls()).toEqual(["bun install --frozen-lockfile", "bun run build:staged", "restart", "bun install --frozen-lockfile", "restart"]);
  });

  it("rollback seguido de um release novo: o `prev` do recibo, o backup e o plano dizem a versão que DE FATO estava no ar", () => {
    // Reproduzido pela revisão: o clone ficava na tag recusada (v1.1.0) e o release seguinte gravava prev=v1.1.0 — uma
    // versão que nunca rodou —, guardava o bundle v1.0.0 com o nome de v1.1.0 e um rollback dele «voltaria ao v1.1.0».
    const sb = sandbox();
    sb.receipt("v1.0.0");
    sb.boot();
    expect(sb.run(["v1.1.0", "--skip-tests"], { AH_VERSION_TOKEN: TOKEN, SHIM_VERSION_TAG: "v1.0.0" }).code).toBe(5);

    writeFileSync(path.join(sb.src, "a.txt"), "3\n");
    git(sb.src, "commit", "-q", "-am", "três");
    git(sb.src, "tag", "v1.2.0");
    const r = sb.run(["v1.2.0", "--skip-tests"], { AH_VERSION_TOKEN: TOKEN });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/plano: v1\.0\.0 → v1\.2\.0/);
    expect(JSON.parse(read(sb.ui, "dist", "ah-version.json"))).toMatchObject({ tag: "v1.2.0", prev: "v1.0.0" });
    expect(read(sb.ui, "dist", "ah-server.v1.0.0.bak.mjs")).toBe("OLD-BUNDLE\n");
    expect(existsSync(path.join(sb.ui, "dist", "ah-server.v1.1.0.bak.mjs"))).toBe(false);
  });

  it("sem recibo válido, o ponto de partida é o clone (o que o release manual de antes deixava)", () => {
    const sb = sandbox();
    const r = sb.run(["v1.1.0", "--dry-run"]);
    expect(r.out).toMatch(/plano: v1\.0\.0 → v1\.1\.0/);
  });
});

describe("ah-release — a tag tem de DESCENDER do que está no ar (defeito 5 da revisão)", () => {
  /** v1.3.0 numa branch que saiu de v1.0.0 e nunca viu v1.1.0: liberá-la sobre v1.1.0 no ar apagaria v1.1.0 em silêncio. */
  const lateral = (sb: Sandbox) => {
    git(sb.src, "checkout", "-q", "-b", "wt-b", "v1.0.0");
    writeFileSync(path.join(sb.src, "b.txt"), "b\n");
    git(sb.src, "add", "-A");
    git(sb.src, "commit", "-q", "-m", "lateral");
    git(sb.src, "tag", "v1.3.0");
    git(sb.src, "checkout", "-q", "main");
  };

  it("tag que não descende do sha do recibo ⇒ saída 2, no dry-run e no real, sem tocar em nada", () => {
    const sb = sandbox();
    sb.receipt("v1.1.0");
    sb.boot();
    lateral(sb);
    const dry = sb.run(["v1.3.0", "--dry-run"]);
    expect(dry.code).toBe(2);
    expect(dry.err).toMatch(/v1\.3\.0 .*não descende do que está no ar \(v1\.1\.0/);
    expect(dry.err).toMatch(/--rollback/);
    const real = sb.run(["v1.3.0", "--skip-tests"], { AH_VERSION_TOKEN: TOKEN });
    expect(real.code).toBe(2);
    expect(sb.calls()).toEqual([]);
    expect(read(sb.ui, "dist", "ah-server.mjs")).toBe("OLD-BUNDLE\n");
  });

  it("voltar de propósito a uma versão anterior só com --rollback explícito", () => {
    const sb = sandbox();
    sb.receipt("v1.1.0");
    sb.boot();
    const sem = sb.run(["v1.0.0", "--skip-tests"], { AH_VERSION_TOKEN: TOKEN });
    expect(sem.code).toBe(2);
    const com = sb.run(["v1.0.0", "--skip-tests", "--rollback"], { AH_VERSION_TOKEN: TOKEN });
    expect(com.code).toBe(0);
    expect(com.out).toMatch(/plano: v1\.1\.0 → v1\.0\.0 \([0-9a-f]+\) \(rollback explícito\)/);
    expect(JSON.parse(read(sb.ui, "dist", "ah-version.json"))).toMatchObject({ tag: "v1.0.0", prev: "v1.1.0" });
  });

  it("um sha no ar que o repositório de desenvolvimento nem conhece também recusa (não dá para provar a descendência)", () => {
    const sb = sandbox();
    sb.receipt("v1.0.0", { sha: "a".repeat(40) });
    sb.boot();
    expect(sb.run(["v1.1.0", "--dry-run"]).code).toBe(2);
  });
});

describe("ah-release — sem credencial NÃO é divergência: no ar, mas dito como não conferido", () => {
  it("sem nenhuma credencial: o release fica (nada divergiu), sai 6 e manda conferir pelo ah_health", () => {
    const sb = sandbox();
    const r = sb.run(["v1.1.0", "--skip-tests"]);
    expect(r.code).toBe(6);
    expect(r.err).toMatch(/VERSÃO NÃO CONFERIDA/);
    expect(r.err).toMatch(/ah_health/);
    expect(read(sb.ui, "dist", "ah-server.mjs")).toBe("NEW-BUNDLE\n"); // o swap NÃO foi desfeito
    expect(JSON.parse(read(sb.ui, "dist", "ah-version.json")).tag).toBe("v1.1.0");
    expect(sb.calls().filter((c) => c === "restart")).toHaveLength(1);
  });

  it("credencial RECUSADA (401): mesma coisa — não é a versão que diverge, é a medida que não foi possível", () => {
    const sb = sandbox();
    const r = sb.run(["v1.1.0", "--skip-tests"], { AH_VERSION_TOKEN: TOKEN, SHIM_CURL_MODE: "unauthorized" });
    expect(r.code).toBe(6);
    expect(read(sb.ui, "dist", "ah-server.mjs")).toBe("NEW-BUNDLE\n");
  });
});

describe("ah-release — idempotente: a mesma tag duas vezes não reconstrói nada", () => {
  it("o recibo já diz a tag e o serviço vivo a roda ⇒ só confere (saída 0, nem build, nem swap, nem restart)", () => {
    const sb = sandbox();
    sb.receipt("v1.1.0");
    sb.boot();
    const r = sb.run(["v1.1.0", "--skip-tests"], { AH_VERSION_TOKEN: TOKEN });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/já no ar e conferido: v1\.1\.0/);
    expect(sb.calls()).toEqual([]); // nenhum bun, nenhum restart
    expect(read(sb.ui, "dist", "ah-server.mjs")).toBe("OLD-BUNDLE\n"); // intocado
  });

  it("o recibo diz a tag mas o serviço roda OUTRA ⇒ saída 7 (restart pendente), sem desfazer nada e sem swap", () => {
    const sb = sandbox();
    sb.receipt("v1.1.0"); // gravado DEPOIS do boot do processo: ele não o carregou
    const r = sb.run(["v1.1.0", "--skip-tests"], { AH_VERSION_TOKEN: TOKEN });
    expect(r.code).toBe(7);
    expect(r.err).toMatch(/restart pendente/);
    expect(sb.calls()).toEqual([]);
  });

  it("release MORTO entre o swap e o restart, e reexecutado: saída 7 (restart pendente), nunca «conferido» (defeito 1 da revisão)", () => {
    // O cenário da revisão: o timeout do tool mata o script durante o ah-safe-restart; o processo v1.0.0 segue no ar com o
    // recibo v1.1.0 já no disco. A reexecução cai no caminho idempotente — e tem de dizer que a v1.1.0 NÃO roda.
    const sb = sandbox();
    sb.receipt("v1.0.0");
    sb.boot();
    const morto = sb.run(["v1.1.0", "--skip-tests"], { AH_VERSION_TOKEN: TOKEN, SHIM_RESTART_KILL: "1" });
    expect(morto.code).not.toBe(0);
    expect(JSON.parse(read(sb.ui, "dist", "ah-version.json")).tag).toBe("v1.1.0"); // o swap aconteceu

    const de_novo = sb.run(["v1.1.0", "--skip-tests"], { AH_VERSION_TOKEN: TOKEN });
    expect(de_novo.code).toBe(7);
    expect(de_novo.out).not.toMatch(/conferido/);
    expect(de_novo.err).toMatch(/«v1\.0\.0»[\s\S]*restart pendente/);
  });

  it("o recibo é de OUTRO build (self-deploy ou swap manual depois do release) ⇒ não é «já no ar»: reconstrói, partindo do clone", () => {
    const sb = sandbox();
    sb.receipt("v1.1.0", { buildId: "buildDoRelease" }); // o .next de agora é «old»: alguém trocou o build depois
    sb.boot();
    const dry = sb.run(["v1.1.0", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).not.toMatch(/nada a reconstruir/);
    expect(dry.out).toMatch(/plano: v1\.0\.0 → v1\.1\.0/);
  });

  it("--force refaz o release mesmo com o recibo dizendo a tag; o dry-run diz que não há nada a reconstruir", () => {
    const sb = sandbox();
    sb.receipt("v1.1.0");
    sb.boot();
    const dry = sb.run(["v1.1.0", "--dry-run"]);
    expect(dry.out).toMatch(/nada a reconstruir/);
    expect(sb.calls()).toEqual([]);
    const forced = sb.run(["v1.1.0", "--skip-tests", "--force"], { AH_VERSION_TOKEN: TOKEN });
    expect(forced.code).toBe(0);
    expect(read(sb.ui, "dist", "ah-server.mjs")).toBe("NEW-BUNDLE\n");
  });
});
