// F0 / ADR-067 — a troca de `--dangerously-skip-permissions` por contenção do SO.
//
// Cada `it` aqui nomeia uma FALHA DE CONTENÇÃO concreta, não uma preferência de estilo. A classe que este
// arquivo existe para impedir é a mais cara do domínio: **isolamento declarado e inerte** — o operador lê
// a config, conclui que está contido, e não está. Este repositório já pagou por ela duas vezes (o
// `EgressDeclaration` carrega `enforced: false` literal no tipo por causa disso), e o `IS_SANDBOX=1` que
// estamos removendo era exatamente ela: um nome que sugeria contenção onde não havia nenhuma.

import { afterAll, describe, expect, it, vi } from "vitest";
import { findRepoRoot, runnerStateDir } from "@/lib/storymap/paths";
import { soDoUmbrella } from "@/lib/storymap/oss-tree";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { quoteArg } from "./engine";
import {
  assertContainmentReachedArgv,
  assertContainmentReachedCommand,
  assertSettingsIsFence,
  buildSandboxSettings,
  buildSpawnFlags,
  detectSandboxSupport,
  detectTargetSandboxOverride,
  diretoriosDeSettings,
  envelopeForSpawn,
  harnessCredentialPaths,
  serializeSandboxSettings,
  tokenizeCommandLine,
  DEFAULT_ALLOWED_DOMAINS,
  readTargetSettings,
  recorteDaInvocacao,
  spawnContidoArgv,
  spawnContidoCmd,
  resolveAllowedDomains,
  resolveAutonomyPosture,
  resolveEnginePosture,
  resolveRunTaskPosture,
  SANDBOX_KEYS_QUE_ESTREITAM,
  resolveSandboxMode,
  resolveWeakerNested,
  unsandboxedFullAllowed,
  DENY_READ_TABELA,
  DEFAULT_DENY_READ,
  problemasDeNegacao,
} from "./autonomy-sandbox";

// ── HIGIENE DE FIXTURE (achado de revisão) ─────────────────────────────────────────────────────────
// Uma revisão contou 14.195 diretórios vazados em /tmp por esta suíte e irmãs (`ah-gate-*` sozinho:
// 4.328). São ~1,3 MB — não é problema de disco, é dívida de inode e de asseio: uma suíte que suja a
// máquina de quem a roda é a primeira coisa que um adotante nota. `mkdtempSync` sem remoção é o padrão
// errado que se copia sozinho, então o registro é central e a limpeza roda uma vez no fim.
const TEMPS: string[] = [];
function tempDir(prefixo: string): string {
  const d = mkdtempSync(path.join(os.tmpdir(), prefixo));
  TEMPS.push(d);
  return d;
}
afterAll(() => {
  for (const d of TEMPS) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* limpeza é best-effort: falhar em limpar NUNCA pode reprovar uma prova */
    }
  }
});

const noBins = () => false;
const allBins = () => true;
const sondaOk = () => ({ ok: true, stderr: "" });
const sondaFalha = () => ({ ok: false, stderr: "echo: I/O error" });
const suporte = (p = {}) => detectSandboxSupport({ platform: "linux", hasBin: allBins, runProbe: sondaOk, ...p });
const capture = () => {
  const seen: Record<string, unknown>[] = [];
  return {
    seen,
    write: (_d: string, s: Record<string, unknown>) => {
      seen.push(s);
      return "/tmp/settings.json";
    },
  };
};
const sandboxOf = (s: Record<string, unknown>) => s.sandbox as Record<string, unknown>;

describe("(1) detecção de suporte — nomear o que falta, nunca degradar calado", () => {
  it("Linux sem bwrap/socat é INDISPONÍVEL e diz QUAIS faltam", () => {
    const s = detectSandboxSupport({ platform: "linux", hasBin: noBins });
    expect(s.available).toBe(false);
    expect(s.missing).toEqual(["bwrap", "socat"]);
    // O operador precisa saber o que instalar; um "indisponível" mudo obriga a adivinhar.
    expect(s.reason).toMatch(/bwrap/);
  });

  it("Linux com as duas dependências E sonda verde: disponível, sem modo weaker", () => {
    const s = detectSandboxSupport({ platform: "linux", hasBin: allBins, runProbe: sondaOk });
    expect(s).toMatchObject({ available: true, mechanism: "bubblewrap", requiresWeakerNested: false, method: "sonda" });
  });

  it("O DEFEITO CORRIGIDO: binários presentes + sonda VERMELHA ⇒ modo weaker, medido e não configurado", () => {
    // A versão anterior decidia por existsSync e devolvia available:true neste host — onde o sandbox
    // comprovadamente NÃO subia. Detecção incapaz de detectar o problema não é detecção.
    const s = detectSandboxSupport({ platform: "linux", hasBin: allBins, runProbe: sondaFalha });
    expect(s.available).toBe(true);
    expect(s.requiresWeakerNested).toBe(true);
    expect(s.reason).toMatch(/I\/O error|restrito/);
  });

  it("sem sonda injetada, assume host RESTRITO (fail-safe: degrada contenção, nunca funcionamento)", () => {
    expect(detectSandboxSupport({ platform: "linux", hasBin: allBins }).requiresWeakerNested).toBe(true);
  });

  it("macOS é medido por SONDA, não por string de plataforma (o teste anterior cimentava o defeito)", () => {
    // ⚠ ESTE TESTE FOI INVERTIDO. Ele afirmava `available: true` passando `hasBin: noBins` — ou seja,
    // fixava por prova que o Darwin ignora a disponibilidade real do mecanismo. Consequência que um
    // revisor apontou: não existia caminho pelo qual `AGILEHARNESS_SANDBOX_MODE=required` recusasse num
    // Mac. Uma suíte que cimenta a asserção não-medida é pior que a ausência do teste, porque dá
    // confiança. A cobertura do comportamento novo está no bloco (16).
    expect(detectSandboxSupport({ platform: "darwin", hasBin: noBins }).available).toBe(false);
    expect(detectSandboxSupport({ platform: "darwin", hasBin: allBins }).available).toBe(true);
  });

  it("Windows nativo NÃO é suportado — e o motivo aponta o caminho (WSL2)", () => {
    const s = detectSandboxSupport({ platform: "win32", hasBin: allBins });
    expect(s.available).toBe(false);
    expect(s.reason).toMatch(/WSL2/);
  });
});

describe("(2) o settings emitido — cada chave compra uma propriedade, e nenhuma é decorativa", () => {
  const settings = buildSandboxSettings({ credentialsDir: "/wt/run-1/.runner", writeRoot: "/wt/run-1" });
  const sb = sandboxOf(settings);

  it("autoAllowBashIfSandboxed é o que SUBSTITUI a flag perigosa (Bash headless sem prompt)", () => {
    expect(sb.autoAllowBashIfSandboxed).toBe(true);
  });

  it("failIfUnavailable inverte a degradação: sem sandbox o run NÃO roda, em vez de rodar sem contenção", () => {
    expect(sb.failIfUnavailable).toBe(true);
  });

  it("allowUnsandboxedCommands=false desarma o escape do próprio CLI", () => {
    // Um agente que contorna a fronteira ao primeiro erro não tem fronteira nenhuma.
    expect(sb.allowUnsandboxedCommands).toBe(false);
  });

  it("a árvore do run é ACRESCENTADA ao conjunto de escrita (aditivo, não exclusivo)", () => {
    // O nome anterior deste teste dizia "a ÚNICA árvore com escrita" — afirmando exatamente o que o
    // módulo retrata 130 linhas acima. `allowWrite` é descrito pelo CLI como "Additional paths ...
    // merged with ...", e o conjunto efetivo inclui $TMPDIR e o gitdir do worktree linkado.
    expect((sb.filesystem as { allowWrite: string[] }).allowWrite).toEqual(["/wt/run-1"]);
  });

  it("egresso é allowlist mínima — o resto é declarado, não herdado", () => {
    expect((sb.network as { allowedDomains: string[] }).allowedDomains).toEqual([...DEFAULT_ALLOWED_DOMAINS]);
  });

  it("credenciais são negadas EXPLICITAMENTE (o sandbox permite leitura por default)", () => {
    const files = (sb.credentials as { files: { path: string; mode: string }[] }).files;
    const paths = files.map((f) => f.path);
    // ANCORADO NA CONSTANTE, não em literais. Antes eram dois `toContain` escritos à mão, e um deles
    // era `~/.aws` — um caminho que NÃO EXISTE nesta classe de host. O efeito era o padrão "teste que
    // cimenta": remover a entrada morta da lista REPROVAVA a suíte, então o defeito ficava protegido
    // pela própria prova que devia guardá-lo.
    expect(paths).toEqual(expect.arrayContaining([...DEFAULT_DENY_READ]));
    expect(files.every((f) => f.mode === "deny")).toBe(true);
  });

  it("`filesystem.denyRead` carrega a lista — a chave que nenhum teste assertava", () => {
    // MEDIDO: o bloco inteiro que testa o settings emitido assertava só `credentials.files`. Apagar a
    // emissão de `filesystem.denyRead` não reprovava NADA — e é ela que vira mount do bwrap.
    expect((sb.filesystem as { denyRead: string[] }).denyRead).toEqual([...DEFAULT_DENY_READ]);
  });

  describe("a tabela de negação é consistente com o disco (uma entrada nascida morta não passa)", () => {
    it("toda negação ou EXISTE, ou está declarada podeFaltar COM motivo", () => {
      expect(problemasDeNegacao(DENY_READ_TABELA, existsSync, os.homedir())).toEqual([]);
    });

    it("PAR: uma entrada nova nascida morta REPROVA, e a mensagem ensina as três saídas", () => {
      const probs = problemasDeNegacao([{ path: "~/.rclone" }], () => false, "/root");
      expect(probs).toHaveLength(1);
      expect(probs[0]).toMatch(/NÃO EXISTE/);
      expect(probs[0]).toMatch(/Skipping non-existent read deny path/);
      expect(probs[0]).toMatch(/podeFaltar:true/);
    });

    it("PAR: a isenção não é gratuita — podeFaltar SEM motivo REPROVA", () => {
      expect(problemasDeNegacao([{ path: "~/.aws", podeFaltar: true }], () => false, "/root")).toEqual([
        expect.stringMatching(/sem motivo/),
      ]);
    });

    it("PAR: a MESMA entrada com motivo passa (senão a checagem recusaria toda isenção)", () => {
      expect(
        problemasDeNegacao([{ path: "~/.aws", podeFaltar: true, motivo: "medido ausente" }], () => false, "/root"),
      ).toEqual([]);
    });
  });

  it("enableWeakerNestedSandbox NUNCA é default — é uma limitação nomeada, opt-in", () => {
    expect(sb.enableWeakerNestedSandbox).toBeUndefined();
    const weaker = sandboxOf(buildSandboxSettings({ credentialsDir: "/wt/.runner", writeRoot: "/wt", weakerNested: true }));
    expect(weaker.enableWeakerNestedSandbox).toBe(true);
  });
});

describe("(3) postura por tier — só `full` é afetado; os outros nunca carregaram a flag", () => {
  const base = { support: suporte(), env: {}, projectRoot: "/wt", writeRoot: "/wt", stateRoot: "/wt", key: "k", trigger: null };

  it("tier full com sandbox disponível ⇒ SANDBOXED, com o settings escrito", () => {
    const cap = capture();
    const p = resolveAutonomyPosture({ ...base, tier: "full", writeSettings: cap.write });
    expect(p.kind).toBe("sandboxed");
    expect(sandboxOf(cap.seen[0]).enabled).toBe(true);
  });

  it.each(["write", "orch", "ro"] as const)("tier %s é NAO-APLICAVEL, não 'rebaixado'", (tier) => {
    // Rotular um tier que nunca foi candidato como "downgraded" conflatava dois casos e obrigava o
    // engine a desambiguar por comparação de tier — e um "não é sandboxed" para `ro` não provava nada
    // sobre a degradação por falta de sandbox, que é a propriedade que importa.
    const cap = capture();
    const p = resolveAutonomyPosture({ ...base, tier, writeSettings: cap.write });
    expect(p.kind).toBe("nao-aplicavel");
    expect(cap.seen).toHaveLength(0);
  });
});

describe("(4) A DEGRADAÇÃO INVERTEU DE SINAL — este é o coração da mudança", () => {
  const semSandbox = detectSandboxSupport({ platform: "linux", hasBin: noBins, runProbe: sondaOk });

  it("required + indisponível ⇒ RECUSA (fail-closed), nomeando o que instalar", () => {
    const p = resolveAutonomyPosture({ trigger: null,
      tier: "full",
      support: semSandbox,
      env: { AGILEHARNESS_SANDBOX_MODE: "required" },
      projectRoot: "/wt", writeRoot: "/wt",
      stateRoot: "/wt",
      key: "k", writeSettings: () => "/fake/sandbox.json",});
    expect(p.kind).toBe("refused");
    if (p.kind === "refused") expect(p.reason).toMatch(/bwrap|socat/);
  });

  it("preferred + indisponível ⇒ REBAIXA para write, e o aviso é ALTO (não silencioso)", () => {
    const p = resolveAutonomyPosture({ trigger: null,
      tier: "full",
      support: semSandbox,
      env: {},
      projectRoot: "/wt", writeRoot: "/wt",
      stateRoot: "/wt",
      key: "k", writeSettings: () => "/fake/sandbox.json",});
    expect(p).toMatchObject({ kind: "downgraded", tier: "write" });
    // Rebaixamento mudo é auto-negação de serviço que nenhum teste reclama.
    if (p.kind === "downgraded") expect(p.warn.length).toBeGreaterThan(0);
  });

  it("REGRESSÃO: sem sandbox e sem válvula, NUNCA volta ao bypass silencioso", () => {
    const p = resolveAutonomyPosture({ trigger: null,
      tier: "full",
      support: semSandbox,
      env: {},
      projectRoot: "/wt", writeRoot: "/wt",
      stateRoot: "/wt",
      key: "k", writeSettings: () => "/fake/sandbox.json",});
    // O comportamento ANTIGO era exatamente este caso rodando com --dangerously-skip-permissions.
    expect(p.kind).not.toBe("unsandboxed-escape");
    expect(p.kind).not.toBe("sandboxed");
  });

  it("a válvula explícita devolve a postura legada — e SÓ ela", () => {
    const p = resolveAutonomyPosture({ trigger: null,
      tier: "full",
      support: semSandbox,
      env: { AGILEHARNESS_ALLOW_UNSANDBOXED_FULL: "1" },
      projectRoot: "/wt", writeRoot: "/wt",
      stateRoot: "/wt",
      key: "k", writeSettings: () => "/fake/sandbox.json",});
    expect(p.kind).toBe("unsandboxed-escape");
    if (p.kind === "unsandboxed-escape") expect(p.warn).toMatch(/SEM CONTENÇÃO/);
  });

  it("a válvula vence até o modo `required` — quem a ligou declarou o risco por escrito", () => {
    const p = resolveAutonomyPosture({ trigger: null,
      tier: "full",
      support: semSandbox,
      env: { AGILEHARNESS_SANDBOX_MODE: "required", AGILEHARNESS_ALLOW_UNSANDBOXED_FULL: "1" },
      projectRoot: "/wt", writeRoot: "/wt",
      stateRoot: "/wt",
      key: "k", writeSettings: () => "/fake/sandbox.json",});
    expect(p.kind).toBe("unsandboxed-escape");
  });
});



describe("(9) OS DOIS DEFEITOS QUE UMA REVISÃO INDEPENDENTE ACHOU — e que não podem voltar", () => {
  // Ambos vinham da MESMA raiz: o código tratava "sandbox disponível" como um fato binário decidido cedo,
  // e daí decorriam duas mentiras — a alavanca de reversão que não reverte, e um detector que não detecta.
  const sondaVermelha = () => ({ ok: false, stderr: "echo: I/O error" });
  const sondaNsVermelha = () => ({ ok: false, stderr: "No permissions to creating new namespace" });

  it("A VÁLVULA FUNCIONA MESMO COM O SANDBOX 'DISPONÍVEL' — é justamente o caso em que se puxa a alavanca", () => {
    // O defeito: `resolveAutonomyPosture` só consultava a válvula DEPOIS de concluir indisponibilidade.
    // Nesta VPS (binários presentes + sonda de setgroups vermelha) `available` é true, então a env que a
    // ADR e o README anunciam como A alavanca de reversão não fazia absolutamente nada.
    const p = resolveAutonomyPosture({ trigger: null,
      tier: "full",
      support: detectSandboxSupport({ platform: "linux", hasBin: allBins, runProbe: sondaVermelha }),
      env: { AGILEHARNESS_ALLOW_UNSANDBOXED_FULL: "1" },
      projectRoot: "/wt", writeRoot: "/wt",
      stateRoot: "/state",
      key: "k", writeSettings: () => "/fake/sandbox.json",});
    expect(p.kind).toBe("unsandboxed-escape");
  });

  it("a válvula vence em TODAS as combinações de modo e disponibilidade", () => {
    const combos = [
      { hasBin: allBins, runProbe: sondaOk },
      { hasBin: allBins, runProbe: sondaVermelha },
      { hasBin: noBins, runProbe: sondaOk },
    ];
    for (const c of combos) {
      for (const mode of ["required", "preferred", "off", undefined]) {
        const env: Record<string, string> = { AGILEHARNESS_ALLOW_UNSANDBOXED_FULL: "1" };
        if (mode) env.AGILEHARNESS_SANDBOX_MODE = mode;
        const p = resolveAutonomyPosture({ trigger: null,
          tier: "full",
          support: detectSandboxSupport({ platform: "linux", ...c }),
          env, projectRoot: "/wt", writeRoot: "/wt", stateRoot: "/s", key: "k", writeSettings: () => "/fake/sandbox.json",});
        expect(p.kind, `modo=${mode} combo=${JSON.stringify(Object.keys(c))}`).toBe("unsandboxed-escape");
      }
    }
  });

  it("A DETECÇÃO CONSEGUE RECUSAR: kernel sem userns ⇒ available:false, mesmo com os binários instalados", () => {
    // O defeito: com bwrap+socat no PATH, NENHUM caminho devolvia available:false — então a degradação
    // "que inverte de sinal" e o modo `required` eram inalcançáveis, e um host sem sandbox real recebia
    // um settings com failIfUnavailable:true, matando todo run sem nunca rebaixar.
    const s = detectSandboxSupport({
      platform: "linux", hasBin: allBins,
      runNamespaceProbe: sondaNsVermelha, runProbe: sondaVermelha,
    });
    expect(s.available).toBe(false);
    expect(s.reason).toMatch(/namespace/i);
  });

  it("com userns OK mas setgroups restrito, o veredito é 'disponível em modo weaker' — os dois casos são distintos", () => {
    const s = detectSandboxSupport({
      platform: "linux", hasBin: allBins,
      runNamespaceProbe: sondaOk, runProbe: sondaVermelha,
    });
    expect(s.available).toBe(true);
    expect(s.requiresWeakerNested).toBe(true);
  });

  it("kernel sem userns + modo required ⇒ RECUSA (a cadeia inteira agora é alcançável)", () => {
    const p = resolveAutonomyPosture({ trigger: null,
      tier: "full",
      support: detectSandboxSupport({
        platform: "linux", hasBin: allBins, runNamespaceProbe: sondaNsVermelha, runProbe: sondaVermelha,
      }),
      env: { AGILEHARNESS_SANDBOX_MODE: "required" },
      projectRoot: "/wt", writeRoot: "/wt", stateRoot: "/s", key: "k", writeSettings: () => "/fake/sandbox.json",});
    expect(p.kind).toBe("refused");
  });
});

describe("(8) A CONTENÇÃO CHEGA AO COMANDO — o teste que mata a mutação", () => {
  // Um revisor comentou o espalhamento do postureArgs no array de flags do engine: o settings continuava
  // sendo construído, escrito em disco e LOGADO, mas nunca chegava ao CLI — e 2704 testes passaram.
  // O run rodaria com contenção ZERO e o log diria "sandbox: bubblewrap". Estes testes existem para que
  // essa mutação seja impossível de sobreviver.
  const perm = ["--permission-mode", "acceptEdits"];

  it("postura sandboxed ⇒ o comando CARREGA --settings <arquivo> e NÃO carrega a flag perigosa", () => {
    const p = resolveAutonomyPosture({ trigger: null,
      tier: "full",
      support: suporte(),
      env: {},
      projectRoot: "/wt", writeRoot: "/wt",
      stateRoot: "/state",
      key: "k",
      writeSettings: () => "/state/sandbox-k.json",
    });
    const { flags, needsRootBypass } = buildSpawnFlags({ posture: p, permissionArgs: perm });
    expect(flags).toContain("--settings");
    expect(flags[flags.indexOf("--settings") + 1]).toBe("/state/sandbox-k.json");
    expect(flags).not.toContain("--dangerously-skip-permissions");
    expect(needsRootBypass).toBe(false);
  });

  it("postura de escape ⇒ carrega a flag perigosa E pede o bypass de root — nunca as duas coisas juntas", () => {
    const p = resolveAutonomyPosture({ trigger: null,
      tier: "full",
      support: detectSandboxSupport({ platform: "linux", hasBin: noBins, runProbe: sondaOk }),
      env: { AGILEHARNESS_ALLOW_UNSANDBOXED_FULL: "1" },
      projectRoot: "/wt", writeRoot: "/wt",
      stateRoot: "/state",
      key: "k", writeSettings: () => "/fake/sandbox.json",});
    const { flags, needsRootBypass } = buildSpawnFlags({ posture: p, permissionArgs: perm });
    expect(flags).toContain("--dangerously-skip-permissions");
    expect(flags).not.toContain("--settings");
    expect(needsRootBypass).toBe(true);
  });

  it.each(["downgraded", "nao-aplicavel"] as const)("postura %s ⇒ nem contenção nem bypass", (kind) => {
    const p =
      kind === "downgraded"
        ? resolveAutonomyPosture({ trigger: null,
            tier: "full",
            support: detectSandboxSupport({ platform: "linux", hasBin: noBins, runProbe: sondaOk }),
            env: {},
            projectRoot: "/wt", writeRoot: "/wt",
            stateRoot: "/state",
            key: "k", writeSettings: () => "/fake/sandbox.json",})
        : resolveAutonomyPosture({ trigger: null, tier: "ro", support: suporte(), env: {}, projectRoot: "/wt", writeRoot: "/wt", stateRoot: "/state", key: "k", writeSettings: () => "/fake/sandbox.json",});
    const { flags, needsRootBypass } = buildSpawnFlags({ posture: p, permissionArgs: perm });
    expect(flags).not.toContain("--settings");
    expect(flags).not.toContain("--dangerously-skip-permissions");
    expect(needsRootBypass).toBe(false);
  });

  it("as demais fontes de flag são preservadas na ordem (o array não é reescrito por engano)", () => {
    const p = resolveAutonomyPosture({ trigger: null,
      tier: "full", support: suporte(), env: {}, projectRoot: "/wt", writeRoot: "/wt", stateRoot: "/s", key: "k",
      writeSettings: () => "/s/x.json",
    });
    const { flags } = buildSpawnFlags({
      posture: p, permissionArgs: perm,
      streamFlags: ["--output-format", "stream-json"], policyArgs: ["--model", "opus"], extraArgs: ["--extra"],
    });
    expect(flags).toEqual([...perm, "--settings", "/s/x.json", "--output-format", "stream-json", "--model", "opus", "--extra"]);
  });

  it("o engine USA buildSpawnFlags — a montagem não voltou para inline", () => {
    const src = readFileSync(path.join(__dirname, "engine.ts"), "utf8");
    expect(src).toMatch(/buildSpawnFlags\(\{/);
    // e o array de flags não pode voltar a espalhar postureArgs à mão
    expect(src).not.toMatch(/\.\.\.postureArgs/);
  });
});

/** O state dir dos fixtures: as credenciais do harness saem daqui, e o portão confere que o settings as nega. */
const CRED_DIR = "/state";

/**
 * Monta uma postura `sandboxed` COMPLETA e coerente: settings real em temp, sha dos bytes escritos, e
 * os caminhos de credencial que o portão vai cobrar.
 *
 * `mutar` altera o settings ANTES de escrever — então o sha bate e quem reprova é a checagem de
 * CONTEÚDO. Para exercitar a checagem de sha (o arquivo mudou depois), mexa no arquivo DEPOIS de
 * chamar isto, sem reconstruir a postura.
 */
function posturaSandboxed(
  mutar?: (s: { sandbox: Record<string, unknown> }) => void,
  opts: { writeRoot?: string } = {},
) {
  const writeRoot = opts.writeRoot ?? "/wt";
  const dir = tempDir("ah-gate-");
  const file = path.join(dir, "sandbox-k.json");
  const settings = buildSandboxSettings({ writeRoot, credentialsDir: CRED_DIR }) as { sandbox: Record<string, unknown> };
  mutar?.(settings);
  const bytes = serializeSandboxSettings(settings);
  writeFileSync(file, bytes, "utf8");
  return {
    kind: "sandboxed" as const,
    tier: "full" as const,
    settingsFile: file,
    settingsSha256: createHash("sha256").update(bytes).digest("hex"),
    credentialPaths: harnessCredentialPaths(CRED_DIR),
    denyWrite: [],
    mechanism: "bubblewrap",
    weakerNested: false,
    writeRoot,
  };
}

describe("(10) O ÚLTIMO PORTÃO — a contenção é VERIFICADA no comando final, em produção", () => {
  // ── POR QUE ESTE BLOCO EXISTE, escrito com precisão ────────────────────────────────────────────────
  // O bloco (8) acima se anuncia como "o teste que mata a mutação" e NÃO a matava. Um revisor
  // independente provou: trocou, no engine, `const flags = spawnFlags.flags;` por
  //     const flags = spawnFlags.flags.filter((f) => f !== "--settings" && !f.endsWith(".json"));
  // Isso preserva `buildSpawnFlags({` na fonte e mantém `...postureArgs` ausente — os dois regex do
  // bloco (8) seguem verdes — e a suíte INTEIRA (7027 testes) passou. O run spawnaria sem contenção
  // nenhuma com o log dizendo "sandbox: bubblewrap".
  //
  // A lição não é "escrever um regex melhor". É que uma propriedade sobre o que o processo EXECUTA não
  // pode ser guardada por asserções sobre o TEXTO do código: entre `buildSpawnFlags` e o comando final
  // há ~240 linhas, dois `flags.push(...)` e dois wrappers, e qualquer uma dessas etapas pode desfazer
  // o trabalho. Por isso a verificação virou código de PRODUÇÃO — `assertContainmentReachedCommand`,
  // chamada sobre `finalCmd` — e o que estes testes cobrem é o portão em si.
  const sandboxed = posturaSandboxed();
  const perm = ["--permission-mode", "acceptEdits"];

  it("A CERCA DESARMADA É RECUSADA — o portão lê o arquivo, não só o ponteiro", () => {
    // A MUTAÇÃO EXATA de um revisor: `enabled: true` → `false` em buildSandboxSettings. Das 7068 provas,
    // UMA reprovava (um teste de forma); o portão ficava mudo, o comando saía com `--settings` e o log
    // anunciava "sandbox: bubblewrap". Ponteiro válido, cerca desarmada.
    const p = posturaSandboxed((s) => { s.sandbox.enabled = false; });
    expect(() =>
      assertContainmentReachedCommand(p, `claude -p "x" --permission-mode acceptEdits --settings ${p.settingsFile}`, "claude"),
    ).toThrow(/NÃO é uma fronteira[\s\S]*enabled/);
  });

  it.each(["autoAllowBashIfSandboxed", "failIfUnavailable"] as const)(
    "sem %s o settings também é recusado — cada chave compra uma propriedade",
    (chave) => {
      const p = posturaSandboxed((s) => { s.sandbox[chave] = false; });
      expect(() =>
        assertContainmentReachedCommand(p, `claude -p "x" --permission-mode acceptEdits --settings ${p.settingsFile}`, "claude"),
      ).toThrow(new RegExp(chave));
    },
  );

  it("allowUnsandboxedCommands=true é recusado — é o escape do próprio CLI, rearmado", () => {
    const p = posturaSandboxed((s) => { s.sandbox.allowUnsandboxedCommands = true; });
    expect(() =>
      assertContainmentReachedCommand(p, `claude -p "x" --permission-mode acceptEdits --settings ${p.settingsFile}`, "claude"),
    ).toThrow(/allowUnsandboxedCommands/);
  });

  it("settings que sumiu do disco entre a escrita e o spawn ⇒ LANÇA (não presume)", () => {
    const p = { ...sandboxed, settingsFile: path.join(os.tmpdir(), "ah-nao-existe-" + process.pid + ".json") };
    expect(() =>
      assertContainmentReachedCommand(p, `claude -p "x" --permission-mode acceptEdits --settings ${p.settingsFile}`, "claude"),
    ).toThrow(/não pôde ser LIDO/);
  });

  it("comando COM a contenção passa (o portão não é um bloqueio cego)", () => {
    expect(() =>
      assertContainmentReachedCommand(sandboxed, `claude -p "x" --permission-mode acceptEdits --settings ${sandboxed.settingsFile}`, "claude"),
    ).not.toThrow();
  });

  it("A MUTAÇÃO EXATA DO REVISOR: --settings filtrado fora ⇒ LANÇA (o run não acontece)", () => {
    // Reprodução literal do efeito daquele `.filter(...)`: as flags de permissão sobrevivem, o
    // --settings não. Antes, isto rodava. Agora, aborta.
    expect(() =>
      assertContainmentReachedCommand(sandboxed, `claude -p "x" --permission-mode acceptEdits --output-format stream-json`, "claude"),
    ).toThrow(/CONTENÇÃO PROMETIDA E AUSENTE/);
  });

  it("--settings presente mas apontando para OUTRO arquivo ⇒ LANÇA", () => {
    // O caso sutil: alguém troca o caminho por um settings que não é o que a postura montou. A presença
    // da flag sozinha não prova nada — o que importa é que seja O arquivo desta postura.
    expect(() =>
      assertContainmentReachedCommand(sandboxed, `claude -p "x" --permission-mode acceptEdits --settings /outro/qualquer.json`, "claude"),
    ).toThrow(/--settings EFETIVO do comando/);
  });

  it("sandboxed + --dangerously-skip-permissions no mesmo comando ⇒ LANÇA", () => {
    // Fronteira montada e depois contornada: as duas juntas são pior que nenhuma, porque o log anuncia
    // contenção enquanto o comando a desfaz.
    expect(() =>
      assertContainmentReachedCommand(
        sandboxed,
        `claude -p "x" --permission-mode acceptEdits --settings ${sandboxed.settingsFile} --dangerously-skip-permissions`,
        "claude",
      ),
    ).toThrow(/montada e depois contornada/);
  });

  it("postura REBAIXADA que ainda carrega a flag perigosa ⇒ LANÇA", () => {
    expect(() =>
      assertContainmentReachedCommand(
        { kind: "downgraded", tier: "write", warn: "sem sandbox" },
        `claude -p "x" --dangerously-skip-permissions`,
        "claude",
      ),
    ).toThrow(/postura REBAIXADA/);
  });

  it("a válvula explícita NÃO é barrada — ela é a única forma legítima da flag perigosa", () => {
    expect(() =>
      assertContainmentReachedCommand(
        { kind: "unsandboxed-escape", tier: "full", warn: "declarado" },
        `claude -p "x" --dangerously-skip-permissions`,
        "claude",
      ),
    ).not.toThrow();
  });

  it("o caminho citado por quoteArg ainda é reconhecido (o portão não quebra com espaço no caminho)", () => {
    // Caminho COM ESPAÇO, e real: o portão lê o arquivo, então um literal inventado só exercitaria o
    // ramo de erro de leitura em vez da citação.
    const dirComEspaco = tempDir("ah gate ");
    const arquivo = path.join(dirComEspaco, "sandbox-k.json");
    const settings = buildSandboxSettings({ writeRoot: "/wt", credentialsDir: CRED_DIR });
    const bytes = serializeSandboxSettings(settings);
    writeFileSync(arquivo, bytes, "utf8");
    const p = {
      ...sandboxed,
      settingsFile: arquivo,
      settingsSha256: createHash("sha256").update(bytes).digest("hex"),
    };
    expect(() =>
      assertContainmentReachedCommand(
        p,
        `claude -p "x" --permission-mode acceptEdits --settings "${arquivo}"`,
        "claude",
      ),
    ).not.toThrow();
  });

  // ── OS DOIS VETORES DE CONFIGURAÇÃO (achado de revisão) ──────────────────────────────────────────
  // O portão verificava PRESENÇA de `--settings` e AUSÊNCIA da flag perigosa, e nada mais. Duas coisas
  // que um operador escreve em `USM_AUTORUN_EXTRA_ARGS` — não um bug de programação — desfaziam a
  // contenção com o log ainda anunciando "sandbox: bubblewrap".

  it("extraArgs com `--permission-mode bypassPermissions` ⇒ LANÇA (o ÚLTIMO modo é o que vale)", () => {
    // Medido em ADR-067: com bypassPermissions dentro do MESMO sandbox, o Write NATIVO escapou e
    // gravou em /root. O modo é parte da contenção, então entra no portão.
    expect(() =>
      assertContainmentReachedCommand(
        sandboxed,
        `claude -p "x" --permission-mode acceptEdits --settings ${sandboxed.settingsFile} --permission-mode bypassPermissions`,
        "claude",
      ),
    ).toThrow(/precisa ser acceptEdits/);
  });

  it("extraArgs com um SEGUNDO --settings ⇒ LANÇA (presença não é efeito)", () => {
    expect(() =>
      assertContainmentReachedCommand(
        sandboxed,
        `claude -p "x" --permission-mode acceptEdits --settings ${sandboxed.settingsFile} --settings /outro.json`,
        "claude",
      ),
    ).toThrow(/mais de um --settings/);
  });

  it("postura RECUSADA que chegou a virar comando ⇒ LANÇA incondicionalmente", () => {
    // O fail-closed da Sonda W era um `throw` solto que NENHUM teste cobria: um revisor o trocou por
    // comentário e 372 testes passaram. A branch entra no portão, como as outras.
    expect(() =>
      assertContainmentReachedCommand(
        { kind: "refused", reason: "o alvo declara sandbox próprio" },
        `claude -p "x" --permission-mode acceptEdits`,
        "claude",
      ),
    ).toThrow(/RECUSADA e um comando foi montado/);
  });

  it("DEFESA EM PROFUNDIDADE: mesmo SEM o throw do engine, a recusa ainda aborta o run", () => {
    // A pergunta honesta que o achado abre: o `throw` do engine some num refactor — o run passa a
    // acontecer? Aqui a sequência EXATA do engine é reproduzida (postura → buildSpawnFlags → comando →
    // portão) PULANDO o throw, e o desfecho é medido. Antes desta fase, o resultado era um comando com
    // `acceptEdits` e sem `--settings`, executado em silêncio. Agora, aborta um passo depois.
    const p = resolveAutonomyPosture({ trigger: null,
      tier: "full",
      support: suporte(),
      env: {},
      projectRoot: "/wt", writeRoot: "/wt",
      stateRoot: "/state",
      key: "k",
      writeSettings: () => "/state/x.json",
      readTarget: (f) => (f.endsWith(".claude/settings.json") ? JSON.stringify({ sandbox: { filesystem: { allowWrite: ["/"] } } }) : null),
    });
    expect(p.kind).toBe("refused"); // guarda de não-vacuidade: o cenário é mesmo o de recusa
    // …o engine lançaria AQUI. Suponha que essa linha não exista mais:
    const { flags } = buildSpawnFlags({ posture: p, permissionArgs: perm });
    const cmd = `claude -p "x" ${flags.join(" ")}`;
    expect(cmd).not.toContain("--settings"); // o comando de fato nasceria sem contenção…
    expect(() => assertContainmentReachedCommand(p, cmd, "claude")).toThrow(/RECUSADA/); // …e o portão o mata.
  });

  it("postura REBAIXADA sem --disallowedTools Bash ⇒ LANÇA", () => {
    expect(() =>
      assertContainmentReachedCommand(
        { kind: "downgraded", tier: "write", warn: "sem sandbox" },
        `claude -p "x" --permission-mode acceptEdits`,
        "claude",
      ),
    ).toThrow(/sem --disallowedTools Bash/);
  });

  it("postura REBAIXADA COM --disallowedTools Bash passa — e é o que buildSpawnFlags emite", () => {
    const { flags } = buildSpawnFlags({
      posture: { kind: "downgraded", tier: "write", warn: "sem sandbox" },
      permissionArgs: perm,
    });
    expect(flags).toEqual([...perm, "--disallowedTools", "Bash"]);
    expect(() =>
      assertContainmentReachedCommand(
        { kind: "downgraded", tier: "write", warn: "sem sandbox" },
        `claude -p "x" ${flags.join(" ")}`,
        "claude",
      ),
    ).not.toThrow();
  });

  it("O REBAIXAMENTO COMPRA O QUE ANUNCIA: o aviso fala em perder Bash, e o argv tira o Bash", () => {
    // A reprovação foi literal: 'TIER_PERMISSION_ARGS.full e .write são o MESMO array, o argv rebaixado
    // é byte-idêntico ao de full menos o --settings'. Sem sandbox e com acceptEdits, o
    // `permissions.allow` do ALVO concede shell — o run rebaixado tinha execução arbitrária como root
    // enquanto o operador lia que tinha perdido o Bash. Este teste amarra o aviso ao argv.
    const p = resolveAutonomyPosture({ trigger: null,
      tier: "full",
      support: detectSandboxSupport({ platform: "linux", hasBin: noBins, runProbe: sondaOk }),
      env: {},
      projectRoot: "/wt", writeRoot: "/wt",
      stateRoot: "/state",
      key: "k",
      writeSettings: () => "/state/x.json",
      readTarget: () => null,
    });
    expect(p.kind).toBe("downgraded");
    if (p.kind !== "downgraded") throw new Error("inalcançável");
    expect(p.warn).toMatch(/Bash/); // o aviso promete a perda…
    const { flags } = buildSpawnFlags({ posture: p, permissionArgs: perm });
    expect(flags).toContain("--disallowedTools"); // …e o argv a entrega
    expect(flags[flags.indexOf("--disallowedTools") + 1]).toBe("Bash");
  });

  it("o engine verifica o comando FINAL — depois dos wrappers, dentro do estrangulamento", () => {
    // ⚠ ESTE TESTE ERA UM REGEX DE ORDEM entre duas linhas ("o assert vem antes do spawn"), e a ordem
    // era exatamente o que NÃO bastava: um revisor mediu que, com 50 linhas entre elas, reescrever o
    // comando na chamada do spawn passava em 7167 de 7167. A ordem virou irrelevante quando as duas
    // viraram uma expressão só (`spawnContidoCmd`), e o que sobra a verificar aqui é que o valor
    // entregue é o `finalCmd` — o pós-wrapper — e não o `cmd` de antes dos wraps.
    const src = readFileSync(path.join(__dirname, "engine.ts"), "utf8");
    expect(src).toMatch(/spawnContidoCmd\(posture,\s*finalCmd,/);
    // A propriedade de verdade — "adulterar o comando impede o spawn" — é comportamental e vive no
    // bloco (22); o lint do mesmo bloco garante que nenhuma superfície escape do estrangulamento.
  });
});

describe("(11) A CERCA QUE O CONTIDO AMPLIA — o alvo declara sandbox ⇒ run RECUSADO", () => {
  // ── O QUE FOI MEDIDO (ADR-067 §Sonda W) ────────────────────────────────────────────────────────────
  // O CLI mescla o `sandbox.*` do `.claude/settings.json` do PROJETO no envelope efetivo. Controle
  // estrito, mesmo caminho-alvo, variando só a presença do arquivo hostil: sem ele a escrita fora do
  // worktree é NEGADA ("Read-only file system"); com ele, PERMITIDA. E permanece permitida com
  // `--setting-sources ""` e com `--setting-sources user` — nenhuma variante da flag impede.
  //
  // O vetor que torna isto urgente não é "repositório alheio": o agente pode escrever DENTRO do
  // worktree (é o ponto do sandbox), logo pode escrever `.claude/settings.json` lá, e o run SEGUINTE
  // nasce com a cerca ampliada. Escalação entre runs usando o próprio mecanismo de contenção.
  const semArquivo = () => null;

  it("alvo sem settings ⇒ nenhum override (o caso normal não é penalizado)", () => {
    expect(detectTargetSandboxOverride("/wt", semArquivo, (q) => q === "/wt/.git")).toEqual([]);
  });

  it("settings SEM a chave sandbox ⇒ nenhum override (hooks/permissions/env são legítimos)", () => {
    // O repositório real tem hooks e permissions declarados. Recusar por causa deles seria quebrar a
    // operação de hoje para proteger de uma ameaça que eles não são.
    const ler = (p: string) => (p.endsWith("settings.json") ? JSON.stringify({ hooks: {}, permissions: {} }) : null);
    expect(detectTargetSandboxOverride("/wt", ler, (q) => q === "/wt/.git")).toEqual([]);
  });

  it("settings COM sandbox.filesystem ⇒ override detectado, com o arquivo e as chaves", () => {
    const ler = (p: string) =>
      p.endsWith(".claude/settings.json") ? JSON.stringify({ sandbox: { filesystem: { allowWrite: ["/"] } } }) : null;
    // `exists` marca "/wt" como topo do repositório para a varredura parar ali — sem isso ela subiria
    // até "/" e o mesmo `ler` responderia para cada nível, que é o comportamento correto e não o que
    // este caso quer medir.
    const achados = detectTargetSandboxOverride("/wt", ler, (q) => q === "/wt/.git");
    expect(achados).toHaveLength(1);
    // O caminho é ABSOLUTO: com a varredura da cadeia, um relativo seria ambíguo entre níveis, e é o
    // arquivo exato que o operador precisa remover.
    expect(achados[0].file).toBe("/wt/.claude/settings.json");
    expect(achados[0].keys).toEqual(["filesystem.allowWrite"]);
  });

  it("o settings.LOCAL também é lido — é o arquivo que um run escreveria sem sujar o git", () => {
    const ler = (p: string) =>
      p.endsWith("settings.local.json") ? JSON.stringify({ sandbox: { enabled: false } }) : null;
    expect(detectTargetSandboxOverride("/wt", ler, (q) => q === "/wt/.git")[0]?.file).toBe("/wt/.claude/settings.local.json");
  });

  it("JSON quebrado conta como override — não saber NÃO pode virar permissão", () => {
    const ler = (p: string) => (p.endsWith(".claude/settings.json") ? "{ isto nao e json" : null);
    expect(detectTargetSandboxOverride("/wt", ler, (q) => q === "/wt/.git")[0]?.keys).toEqual(["<ilegível>"]);
  });

  it("POSTURA: alvo com sandbox declarado ⇒ RECUSADO, e o motivo diz o arquivo e a saída", () => {
    const p = resolveAutonomyPosture({ trigger: null,
      tier: "full",
      support: suporte(),
      env: {},
      projectRoot: "/wt", writeRoot: "/wt",
      stateRoot: "/state",
      key: "k",
      writeSettings: () => "/state/sandbox-k.json",
      readTarget: (f) => (f.endsWith(".claude/settings.json") ? JSON.stringify({ sandbox: { network: { allowedDomains: ["*"] } } }) : null),
    });
    expect(p.kind).toBe("refused");
    if (p.kind !== "refused") throw new Error("inalcançável");
    expect(p.reason).toMatch(/\.claude\/settings\.json/);
    expect(p.reason).toMatch(/AGILEHARNESS_ALLOW_UNSANDBOXED_FULL/); // a saída declarada
    expect(p.reason).toMatch(/run ANTERIOR/); // nomeia o vetor de escalação
  });

  it("a VÁLVULA vence a recusa — quem declarou o risco já abriu mão da fronteira", () => {
    // Coerência: recusar por "a cerca seria ampliada" para alguém que pediu explicitamente NENHUMA
    // cerca seria um obstáculo sem propósito.
    const p = resolveAutonomyPosture({ trigger: null,
      tier: "full",
      support: suporte(),
      env: { AGILEHARNESS_ALLOW_UNSANDBOXED_FULL: "1" },
      projectRoot: "/wt", writeRoot: "/wt",
      stateRoot: "/state",
      key: "k",
      writeSettings: () => "/state/sandbox-k.json",
      readTarget: () => JSON.stringify({ sandbox: { filesystem: { allowWrite: ["/"] } } }),
    });
    expect(p.kind).toBe("unsandboxed-escape");
  });

  it("A DETECÇÃO LÊ O projectRoot, NÃO O writeRoot — o defeito que deixou a defesa inerte", () => {
    // ── O QUE ESTE TESTE IMPEDE ────────────────────────────────────────────────────────────────────
    // Ao estreitar o writeRoot das skills não-code para `storymap/`, o detector passou a inspecionar
    // `<raiz>/storymap/.claude/settings.json` — caminho que o CLI nunca lê — enquanto o CLI seguia
    // mesclando `<raiz>/.claude/settings.json`. Para 5 das 13 skills `full`, a recusa fail-closed
    // virou decoração: o arquivo hostil existia no lugar certo e nada acusava.
    //
    // Os dois diretórios divergem SEMPRE que o run não recebe worktree próprio, então o teste os
    // separa de propósito. Com a implementação antiga (lendo do writeRoot) ele reprova.
    const CWD = "/repo"; // o cwd do spawn: de onde o CLI resolve settings de projeto
    const WRITE = "/repo/storymap"; // a árvore que o sandbox libera — mais estreita
    const p = resolveAutonomyPosture({ trigger: null,
      tier: "full",
      support: suporte(),
      env: {},
      projectRoot: CWD,
      writeRoot: WRITE,
      stateRoot: "/state",
      key: "k",
      writeSettings: () => "/state/x.json",
      // O arquivo hostil está onde o CLI o lê: na raiz de PROJETO.
      readTarget: (f) => (f === "/repo/.claude/settings.json" ? JSON.stringify({ sandbox: { filesystem: { allowWrite: ["/"] } } }) : null),
    });
    expect(p.kind, "o settings hostil está no cwd e a postura tem de RECUSAR").toBe("refused");
  });

  it("um settings hostil no writeRoot (mas fora do cwd) NÃO é o vetor — e não recusa por engano", () => {
    // O simétrico: recusar por um arquivo que o CLI não lê seria falso positivo, e falso positivo em
    // fail-closed vira negação de serviço. A checagem tem de ser exatamente onde o CLI olha.
    const p = resolveAutonomyPosture({ trigger: null,
      tier: "full",
      support: suporte(),
      env: {},
      projectRoot: "/repo",
      writeRoot: "/repo/storymap",
      stateRoot: "/state",
      key: "k",
      writeSettings: () => "/state/x.json",
      readTarget: (f) =>
        f === "/repo/storymap/.claude/settings.json" ? JSON.stringify({ sandbox: { filesystem: { allowWrite: ["/"] } } }) : null,
    });
    expect(p.kind).toBe("sandboxed");
  });

  it("as credenciais do PRÓPRIO harness são negadas — não só as do sistema", () => {
    // O writeRoot dos runs não-code é `storymap/`, que CONTÉM `storymap/.runner/` — onde vivem o
    // auth-token (o que a tela de login pede), o session-secret (que assina os cookies) e o
    // mcp-handles.json. Proteger `~/.ssh` e deixar a própria credencial dentro do envelope concedido
    // é perímetro mal desenhado, e uma revisão pegou.
    const sb = sandboxOf(buildSandboxSettings({ writeRoot: "/repo/storymap/boards", credentialsDir: "/repo/storymap/.runner" }));
    const paths = (sb.credentials as { files: { path: string; mode: string }[] }).files.map((f) => f.path);
    expect(paths).toContain("/repo/storymap/.runner/auth-token");
    expect(paths).toContain("/repo/storymap/.runner/session-secret");
    expect(paths).toContain("/repo/storymap/.runner/mcp-handles.json");
    expect(paths).toContain("~/.ssh"); // e as do sistema seguem lá
  });

  it("a postura de produção usa a leitura REAL por DEFAULT — não é estrutura inerte", () => {
    // ⚠ Este teste era um regex sobre engine.ts (`readTarget: readTargetSettings`), e o argumento saiu
    // do call-site: hoje `resolveEnginePosture` o deriva. O guarda passou a ser COMPORTAMENTAL — sem
    // `readTarget` injetado, a postura tem de recusar diante de uma árvore hostil de verdade, o que só
    // acontece se o leitor real estiver ligado. (O caso completo, com disco, está no bloco (23).)
    const raiz = tempDir("ah-eng-hostil-");
    mkdirSync(path.join(raiz, ".git"), { recursive: true });
    mkdirSync(path.join(raiz, ".claude"), { recursive: true });
    writeFileSync(
      path.join(raiz, ".claude", "settings.json"),
      JSON.stringify({ sandbox: { filesystem: { allowWrite: ["/"] } } }),
      "utf8",
    );
    const p = resolveEnginePosture(
      { tier: "full", trigger: null, isCode: true, cwd: raiz, key: "k" },
      { support: suporte(), env: {}, writeSettings: () => "/fake/sandbox.json" },
    );
    expect(p.kind).toBe("refused");
  });
});

describe("(7) NÃO-INTRUSÃO — o harness não suja o repositório do usuário", () => {
  // Este bloco nasceu de um defeito REAL cometido nesta mesma fase: a primeira versão passava o worktree
  // do run como diretório de estado, e o diff apareceu com 40+ `sandbox-*.json` rastreados dentro da
  // árvore do alvo. A propriedade que o plano cobra do onboarding — "após uma varredura completa, o
  // `git status` do usuário mostra apenas o que ele autorizou" — vale para TODO artefato do harness.

  it("o settings vai para o stateRoot, e NUNCA para dentro da árvore de escrita do run", () => {
    const wt = tempDir("ah-wt-");
    const state = tempDir("ah-state-");
    const p = resolveAutonomyPosture({ trigger: null,
      tier: "full",
      support: detectSandboxSupport({ platform: "linux", hasBin: allBins }),
      env: {},
      projectRoot: wt,
      writeRoot: wt,
      stateRoot: state,
      key: "sess-1",
      // SEM injeção de propósito: este é o único teste que exercita o escritor REAL — e ele o faz
      // contra diretórios de mkdtemp, que é a forma legítima. É o que prova que o caminho de produção
      // deposita no stateRoot e não na árvore do run.
    });
    expect(p.kind).toBe("sandboxed");
    if (p.kind !== "sandboxed") return;
    expect(p.settingsFile.startsWith(state)).toBe(true);
    // A asserção que importa: nada do harness dentro da árvore do alvo.
    expect(p.settingsFile.startsWith(wt)).toBe(false);
    expect(readdirSync(wt)).toEqual([]);
  });

  it("nenhum teste escreve num caminho LITERAL do host (mkdtemp é legítimo; \"/wt\" não)", () => {
    // Nasceu de um defeito real: helpers em autonomy-tier.test.ts chamavam `resolveAutonomyPosture` com
    // `stateRoot: "/wt"` e sem injetar `writeSettings`, e o escritor real criou `/wt/sandbox-k.json` na
    // RAIZ do filesystem, como root. A regra correta não é "nunca use o escritor real" — é "nunca
    // escreva num caminho fixo do host": um teste que usa mkdtemp está certo, um que usa "/wt" não.
    const dir = __dirname;
    const infratores: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".test.ts"))) {
      const src = readFileSync(path.join(dir, f), "utf8");
      for (const m of src.matchAll(/resolveAutonomyPosture\(\{[\s\S]{0,600}?\n\s*\}\)/g)) {
        const chamada = m[0];
        if (/writeSettings/.test(chamada)) continue; // injetado ⇒ não toca disco
        const sd = /stateRoot:\s*"([^"]+)"/.exec(chamada);
        if (sd) infratores.push(`${f}: stateRoot literal ${sd[1]}`);
      }
    }
    expect(
      infratores,
      'use mkdtempSync para o stateRoot, ou injete writeSettings — caminho literal escreve no host',
    ).toEqual([]);
  });

  it("o estrangulamento de postura substituiu os guardas de call-site por regex", () => {
    // ⚠ AQUI HAVIA DOIS TESTES DE REGEX sobre engine.ts (`stateRoot: runnerStateDir()` e a forma da
    // chamada de `envelopeForSpawn`). Um revisor mostrou que eles mediam substring e não valor: escrever
    // o MESMO bug como `runnerStateDir() + "/sandbox"` passava. Os argumentos saíram do call-site e
    // viraram derivação dentro de `resolveEnginePosture`/`resolveRunTaskPosture`; o que os guarda agora
    // é o bloco (25), que afirma o VALOR da postura devolvida.
    const src = readFileSync(path.join(__dirname, "engine.ts"), "utf8");
    expect(src).not.toMatch(/stateRoot:/);
    expect(src).toMatch(/resolveEnginePosture\(\{/);
  });
});

describe("(6) LINT DE DÍVIDA — varre TODO o src, casa OS DOIS sinais, e a lista só ENCOLHE", () => {
  // F0 fechou o caminho do AUTORUN. As outras superfícies continuam na postura antiga, e isso é
  // DECLARADO, não esquecido. Três correções vieram de revisões independentes sucessivas:
  //   (a) a lista dizia 3 superfícies; o comentário do engine dizia 5; nenhum dos dois incluía copilot/
  //       e app/. Uma lista de dívida errada é pior que nenhuma: ela afirma cobertura que não existe.
  //   (b) o lint varria só `runner/`, então uma superfície nova em copilot/, mcp/ ou app/ nasceria com o
  //       bypass e o guard ficaria verde. Um guarda que não olha para onde o problema aparece não guarda.
  //   (c) ⚠ O MAIS GRAVE, e o que motiva a reescrita deste bloco: o lint casava a string `IS_SANDBOX`,
  //       que é o SINTOMA (o bypass da trava de root), não a DOENÇA (`--dangerously-skip-permissions`).
  //       `mcp/dev-tools.ts` (a tool `run_task`, que o README nomeia!) e `copilot/protocol.ts` emitem a
  //       flag SEM o env — e por isso eram INVISÍVEIS ao lint "exaustivo". O guarda media um proxy.
  //       Agora casa os dois sinais, separadamente, e a lista da flag é a que manda.
  const SRC = path.resolve(__dirname, "..", "..", "..");

  /**
   * Arquivos que EMITEM `--dangerously-skip-permissions` para um agente filho — a dívida REAL.
   * Cada migração para `resolveAutonomyPosture` APAGA uma linha; a lista só encolhe, e o teste abaixo
   * reprova tanto quem entra sem declarar quanto quem fica declarado depois de já ter saído.
   *
   * ⚠ O jsdoc anterior dizia "São 7 superfícies em 8 arquivos" com SEIS entradas no array — um número
   * que apodreceu na primeira migração e que um revisor pegou. A contagem saiu do texto de propósito:
   * `DIVIDA_FLAG.length` é a fonte, e o README é amarrado a ela pelo lint de documentação.
   */
  // Histórico das saídas, porque a ordem importa para quem lê a fase:
  //  1. `mcp/dev-tools.ts` (tool `run_task`) — alcançável de fora, sem sessão autenticada;
  //  2. `runner/resolution-judge-spawn.ts` e `runner/peer-review-spawn.ts` — as duas alcançáveis EM
  //     BANDA a partir de um run já contido: o merge train as spawna sobre o diff que o run produziu,
  //     sem humano no meio. Enquanto elas ficaram para trás, a fronteira embarcava um caminho nomeado
  //     de escalação de dentro dela para fora (achado de revisão), e é por isso que saíram nesta fase
  //     em vez de esperar F1.
  // ⚠ E o que sobra NÃO é "todas exigem painel", como esta nota afirmava. Medido numa revisão:
  //   · `smart-capture/claude.ts` (a CAPTURA) é alcançável pelo endpoint MCP público — `report_issue` e
  //     `usm_capture` chegam nela com token de nível `write`, porque `requireSession` aceita ator MCP
  //     sem cookie. É a superfície de maior risco de prompt-injection do repositório, e por isso é a
  //     PRIMEIRA da fila de F1 (o modo de permissão dela já foi fixado nesta fase);
  //   · `deploy-agent-spawn.ts` é alcançável EM BANDA: um `move_card` por MCP para uma coluna com
  //     `onEnter` de deploy dispara a classe (medido por leitura, não ponta a ponta);
  //   · copiloto e sessão de card em `/terminal` são, essas sim, atrás do painel (401 no middleware).
  const DIVIDA_FLAG = [
    "app/actions.ts", // sessão de card no tmux (`claude --resume` anexável em /terminal)
    "lib/storymap/copilot/protocol.ts", // chat do copiloto
    "lib/storymap/runner/deploy-agent-spawn.ts", // deploy autônomo
    "lib/storymap/smart-capture/claude.ts", // captura
  ] as const;

  /** Arquivos que ainda injetam `IS_SANDBOX=1` (o bypass da trava de root que acompanha a flag). */
  const DIVIDA_ENV = [
    "app/actions.ts",
    "lib/storymap/copilot/agent-session.ts",
    // ⚠ ENTROU quando `run_task` migrou, e é uma entrada LEGÍTIMA — não uma regressão. A superfície
    // saiu da lista da FLAG (ela emite `--settings` agora), mas o env sobrevive DENTRO da válvula
    // explícita: `AGILEHARNESS_ALLOW_UNSANDBOXED_FULL=1` faz `buildSpawnFlags` emitir a flag perigosa,
    // e sem `IS_SANDBOX=1` o CLI a recusa quando o serviço roda como root — a alavanca declarada
    // ficaria quebrada. Mesmo formato do engine: o env só existe atrás da válvula.
    "lib/storymap/mcp/dev-tools.ts",
    "lib/storymap/runner/deploy-agent-spawn.ts",
    "lib/storymap/runner/peer-review-spawn.ts",
    "lib/storymap/runner/resolution-judge-spawn.ts",
    "lib/storymap/smart-capture/claude.ts",
  ] as const;

  /** O engine é o único sítio LEGÍTIMO do env: lá o bypass vive dentro da válvula explícita. */
  const VALVULA = "lib/storymap/runner/engine.ts";

  /**
   * O SANEADOR cita `IS_SANDBOX` para REMOVÊ-LO — o oposto de injetar. Ele entrou quando uma medição
   * mostrou que a variável estava sendo HERDADA do ambiente do serviço (a máquina onde isto foi escrito
   * roda com ela setada), o que devolvia o bypass a todo filho sem ninguém pedir e sem aparecer no
   * código. Listá-lo como dívida seria registrar como problema justamente a correção dele.
   */
  const SANEADOR = "lib/storymap/runner/spawn-env.ts";

  /**
   * Sítios que CITAM a flag legitimamente, sem emiti-la para um filho — precisam ser nomeados um a um,
   * porque uma isenção genérica ("ignore server/") seria o buraco por onde uma emissão nova entraria.
   */
  const CITACOES_LEGITIMAS = [
    // O módulo desta fase: cita a flag para EMITI-LA só dentro da válvula e para PROIBI-LA no portão.
    "lib/storymap/runner/autonomy-sandbox.ts",
    // Aviso ao operador no boot — a string aparece no TEXTO do alerta sobre o que a ferramenta faz.
    "server/main.ts",
  ] as const;

  const semComentarios = (src: string): string =>
    src
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");

  /** Varre TODO o `src/`, devolvendo os arquivos cujo CÓDIGO (sem comentários) contém `agulha`. */
  const varrer = (agulha: string, dir = SRC, acc: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      const full = path.join(dir, e);
      if (statSync(full).isDirectory()) varrer(agulha, full, acc);
      else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) {
        if (semComentarios(readFileSync(full, "utf8")).includes(agulha)) {
          acc.push(path.relative(SRC, full).replace(/\\/g, "/"));
        }
      }
    }
    return acc;
  };

  it("EXAUSTIVO (flag): nenhum emissor de --dangerously-skip-permissions fora da dívida declarada", () => {
    // ESTE é o teste que faltava. O anterior casava IS_SANDBOX e por isso não via `dev-tools.ts` nem
    // `copilot/protocol.ts` — duas superfícies que emitem a flag sem o env.
    // O engine NÃO entra aqui: depois de F0 ele não emite mais a flag — quem a emite, e só na válvula,
    // é `buildSpawnFlags` (em autonomy-sandbox.ts, listado como citação legítima). Que o lint tenha
    // reprovado a primeira versão desta lista por incluir o engine é a prova de que ele mede.
    const encontrados = varrer("dangerously-skip-permissions").sort();
    const esperados = [...DIVIDA_FLAG, ...CITACOES_LEGITIMAS].sort();
    expect(
      encontrados,
      "superfície emitindo a flag perigosa fora da lista — migre para resolveAutonomyPosture, ou registre a dívida",
    ).toEqual(esperados);
  });

  it("EXAUSTIVO (env): nenhum sítio de IS_SANDBOX fora da dívida declarada + a válvula do engine", () => {
    const encontrados = varrer("IS_SANDBOX").sort();
    const esperados = [...DIVIDA_ENV, VALVULA, SANEADOR].sort();
    expect(
      encontrados,
      "superfície com o bypass de root fora da lista — migre para resolveAutonomyPosture, ou registre a dívida",
    ).toEqual(esperados);
  });

  it("NÃO-VACUIDADE: as duas varreduras examinaram a árvore (um lint que mede zero passa sempre)", () => {
    // Sem esta guarda, um erro de caminho tornaria os testes acima verdes medindo NADA — que é
    // exatamente o modo de falha que este repositório já tem registrado em outro lint.
    expect(varrer("dangerously-skip-permissions").length).toBeGreaterThanOrEqual(DIVIDA_FLAG.length);
    expect(varrer("IS_SANDBOX").length).toBeGreaterThanOrEqual(DIVIDA_ENV.length);
  });

  it("a flag é o sinal PRIMÁRIO: todo injetor de env também emite a flag, ou tem motivo NOMEADO", () => {
    // Invariante de coerência entre as duas listas: `IS_SANDBOX=1` só existe para fazer a flag ser
    // ACEITA como root. Um arquivo que injeta o env sem emitir a flag é ou um erro, ou um caso
    // conhecido — e "conhecido" aqui significa NOMEADO com o motivo, não tolerado por omissão. Sem
    // esta amarra as duas listas divergiriam em silêncio, que foi como a dívida ficou errada da
    // primeira vez.
    const MOTIVO_DECLARADO: Record<string, string> = {
      // O copiloto ocupa dois arquivos: o env aqui, os args em protocol.ts. Uma superfície, duas metades.
      "lib/storymap/copilot/agent-session.ts": "metade de env de uma superfície cujos args vivem em protocol.ts",
      // MIGRADA: a flag não é mais escrita neste arquivo — ela vem de `buildSpawnFlags`, e só no ramo
      // da válvula explícita. O env sobrevive porque sem ele o CLI recusaria a flag como root, ou seja,
      // a alavanca de reversão ficaria declarada e quebrada.
      "lib/storymap/mcp/dev-tools.ts": "migrada para a postura; o env só existe dentro da válvula explícita",
      // Mesmo caso, e migradas nesta fase pelo motivo que um revisor nomeou: são as duas superfícies
      // alcançáveis EM BANDA a partir de um run já contido (o merge train as spawna sobre o diff que o
      // run produziu, sem humano). Deixá-las para trás era embarcar um caminho de escalação de dentro
      // da fronteira para fora.
      "lib/storymap/runner/peer-review-spawn.ts": "migrada para a postura; o env só existe dentro da válvula explícita",
      "lib/storymap/runner/resolution-judge-spawn.ts": "migrada para a postura; o env só existe dentro da válvula explícita",
    };
    const orfaos = DIVIDA_ENV.filter(
      (f) => !DIVIDA_FLAG.includes(f as (typeof DIVIDA_FLAG)[number]) && !MOTIVO_DECLARADO[f],
    );
    expect(orfaos, "injetor de IS_SANDBOX sem emitir a flag e sem motivo declarado").toEqual([]);
    // E o inverso: um motivo declarado para um arquivo que saiu da dívida é registro podre.
    expect(Object.keys(MOTIVO_DECLARADO).filter((f) => !DIVIDA_ENV.includes(f as never))).toEqual([]);
  });

  it("o engine só cita o bypass DENTRO da válvula explícita", () => {
    const src = semComentarios(readFileSync(path.join(SRC, VALVULA), "utf8"));
    expect(src.split("IS_SANDBOX").length - 1).toBeLessThanOrEqual(1);
    expect(src).toMatch(/escapeHatchNeedsRootBypass/);
  });

  it("as listas de dívida não listam arquivo já limpo (mantém o registro honesto)", () => {
    const obsoletosFlag = DIVIDA_FLAG.filter(
      (f) => !semComentarios(readFileSync(path.join(SRC, f), "utf8")).includes("dangerously-skip-permissions"),
    );
    const obsoletosEnv = DIVIDA_ENV.filter(
      (f) => !semComentarios(readFileSync(path.join(SRC, f), "utf8")).includes("IS_SANDBOX"),
    );
    expect(obsoletosFlag, "remova da lista da FLAG — a superfície já foi migrada").toEqual([]);
    expect(obsoletosEnv, "remova da lista do ENV — a superfície já foi migrada").toEqual([]);
  });

  it("o README declara o MESMO número de superfícies que o lint conhece", () => {
    // A reprovação foi literal: "as duas listas de 'seis' são conjuntos diferentes". O README dizia seis
    // e omitia a sessão de card no tmux; o lint dizia seis e omitia dev-tools + protocol. Amarrar as
    // duas é o que impede a prosa e o código de divergirem de novo.
    const readme = readFileSync(path.resolve(SRC, "..", "README.md"), "utf8");
    // O copiloto ocupa dois arquivos (args + env) e conta como UMA superfície.
    const superficies = new Set(
      DIVIDA_FLAG.map((f) => (f.includes("/copilot/") ? "copilot" : f)).concat(
        DIVIDA_ENV.filter((f) => f.includes("/copilot/")).map(() => "copilot"),
      ),
    );
    // ⚠ Aqui havia um `expect(superficies.size).toBe(6)` — um número CRAVADO ao lado do número
    // DERIVADO, no teste cujo propósito declarado é impedir que dois números divirjam. Ele obrigava a
    // editar o próprio guarda a cada migração, que é o momento em que se erra. Some: o que precisa ser
    // verdade é "a prosa concorda com a lista", e a não-vacuidade vem da varredura exaustiva acima.
    expect(superficies.size, "a dívida zerou? então este lint e o README precisam de outra redação").toBeGreaterThan(0);
    // O número é DERIVADO da lista do lint, não escrito à mão aqui: quando uma superfície for migrada,
    // este teste passa a exigir a palavra nova no README, e a prosa é obrigada a acompanhar o código.
    const porExtenso = ["zero", "uma", "duas", "três", "quatro", "cinco", "seis", "sete", "oito"][superficies.size];
    expect(readme, `o README precisa dizer ${porExtenso.toUpperCase()} superfícies não contidas`).toMatch(
      new RegExp(`${porExtenso}\\*{0,2} superf[ií]cies`, "i"),
    );
    // ── E O COMENTÁRIO DO ENGINE TAMBÉM (achado de revisão) ────────────────────────────────────────
    // O laço README↔lint foi construído e o laço comentário↔lint não — e a prosa não amarrada divergiu
    // na primeira rodada seguinte: engine.ts dizia "SEIS" e apontava para um símbolo (`DIVIDA_IS_SANDBOX`)
    // que já não existia. É o arquivo central, onde um contribuidor novo chega primeiro.
    const engineSrc = readFileSync(path.join(SRC, VALVULA), "utf8");
    expect(engineSrc, `o comentário de dívida do engine precisa dizer ${porExtenso.toUpperCase()}`).toMatch(
      new RegExp(`—\\s*${porExtenso}\\b`, "i"),
    );
    // e não pode apontar para um símbolo morto
    expect(engineSrc, "o engine aponta para um identificador que não existe mais").not.toMatch(/DIVIDA_IS_SANDBOX/);
    expect(engineSrc).toMatch(/DIVIDA_FLAG/);
    // ── E O ADR TAMBÉM (achado de revisão) ─────────────────────────────────────────────────────────
    // A amarra cobria README e engine e deixava de fora o ADR — que é o artefato de DECISÃO da fase, o
    // documento que um contribuidor abre para saber o que ficou pendente. Ele divergiu na primeira
    // rodada seguinte: dizia "7 superfícies" e listava como prioridade de F1 justamente a que já havia
    // migrado. Um registro de pendências errado é pior que ausente — ele afirma trabalho que não existe.
    //
    // ⚠ O ADR é o ÚNICO dos três portadores que NÃO viaja na extração OSS (`docs/` inteiro fica: leva o
    // plano OSS, os business-models e medições contra o host do dono — caminho do checkout, kernel,
    // serviço como root). Considerou-se negá-lo na régua para que viajasse; recusado porque sanear 595
    // linhas de prosa de medição não é operação mecânica, e o cabeçalho dele aponta para um plano que
    // também não viaja. O laço que este caso protege — "a prosa concorda com a lista derivada" — segue
    // cobrado no artefato pelos DOIS portadores acima, que são os que um contribuidor de fora lê.
    const adrPath = soDoUmbrella("docs/adr/ADR-067-sondas-f0-multitarget.md");
    if (adrPath) {
      const adr = readFileSync(adrPath, "utf8");
      const linhaDivida = adr.split("\n").find((l) => l.startsWith("| A flag perigosa fora do autorun"));
      expect(linhaDivida, "o ADR perdeu a linha de dívida da flag").toBeTruthy();
      expect(linhaDivida, `o ADR precisa dizer ${DIVIDA_FLAG.length} superfícies`).toMatch(
        new RegExp(`\\*\\*${DIVIDA_FLAG.length} superf[ií]cies\\*\\*`),
      );
      // e não pode listar como pendente uma superfície que já saiu da dívida
      for (const migrada of ["mcp/dev-tools.ts"]) {
        expect(linhaDivida, `o ADR ainda trata ${migrada} como pendente`).not.toMatch(
          new RegExp(`Prioridade[^|]*${migrada.replace("/", "\\/")}`),
        );
      }
    }
  });
});

describe("(5) leitura de env — default SEGURO, valor inválido não vira permissão", () => {
  it("modo ausente ou lixo cai em `preferred`, nunca em `off`", () => {
    expect(resolveSandboxMode({})).toBe("preferred");
    expect(resolveSandboxMode({ AGILEHARNESS_SANDBOX_MODE: "banana" })).toBe("preferred");
    // `off` é alcançável, mas só quando escrito de propósito.
    expect(resolveSandboxMode({ AGILEHARNESS_SANDBOX_MODE: "off" })).toBe("off");
  });

  it("os dois knobs perigosos exigem exatamente '1' — nada de truthiness", () => {
    expect(unsandboxedFullAllowed({ AGILEHARNESS_ALLOW_UNSANDBOXED_FULL: "true" })).toBe(false);
    expect(unsandboxedFullAllowed({ AGILEHARNESS_ALLOW_UNSANDBOXED_FULL: "1" })).toBe(true);
    // O env agora é OVERRIDE de uma medição: ausente ⇒ vale o que a sonda mediu.
    expect(resolveWeakerNested({ AGILEHARNESS_SANDBOX_WEAKER_NESTED: "yes" }, false)).toBe(false);
    expect(resolveWeakerNested({ AGILEHARNESS_SANDBOX_WEAKER_NESTED: "1" }, false)).toBe(true);
    expect(resolveWeakerNested({ AGILEHARNESS_SANDBOX_WEAKER_NESTED: "0" }, true)).toBe(false);
    expect(resolveWeakerNested({}, true)).toBe(true);
    expect(resolveWeakerNested({}, false)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("(12) A ESCOLHA DE ENVELOPE — pura, e agora defendida por teste", () => {
  // ── POR QUE ESTE BLOCO EXISTE ────────────────────────────────────────────────────────────────────
  // As duas decisões de perímetro que a fase anunciou como as mais graves viviam INLINE nos call-sites,
  // cobertas só por lint de regex sobre a fonte. Um revisor mediu: trocar `boardsDir()` por `cwd` no
  // engine passava em 2757/2757; zerar o `denyWrite` do run_task passava em 125/125. Correções que
  // regridem em silêncio são correções que não existem.
  const STATE = "/repo/storymap/.runner";
  const BOARDS = "/repo/storymap/boards";

  it("run de CÓDIGO: o envelope é o worktree do run", () => {
    const e = envelopeForSpawn({ isCode: true, cwd: "/repo/.worktrees/run-1", boardDataDir: BOARDS, stateDir: STATE });
    expect(e.writeRoot).toBe("/repo/.worktrees/run-1");
    expect(e.projectRoot).toBe("/repo/.worktrees/run-1");
    // state dir fora do envelope ⇒ nada a recortar (recortar seria ruído sugerindo risco inexistente)
    expect(e.denyWrite).toEqual([]);
  });

  it("run NÃO-CODE: estreita para a árvore de dados — NÃO fica no cwd (a raiz do repositório)", () => {
    // ESTE é o caso que a mutação do revisor reintroduzia. Com writeRoot = cwd, o envelope seria o
    // repositório inteiro, incluindo o código do próprio harness.
    const e = envelopeForSpawn({ isCode: false, cwd: "/repo", boardDataDir: BOARDS, stateDir: STATE });
    expect(e.writeRoot).toBe(BOARDS);
    expect(e.writeRoot).not.toBe("/repo");
    // e o projectRoot continua sendo o cwd — é de lá que o CLI lê os settings de projeto
    expect(e.projectRoot).toBe("/repo");
  });

  it("o state dir DENTRO do envelope é sempre RECORTADO", () => {
    // O caso do run_task: cwd = raiz, envelope = raiz, state dir dentro.
    const e = envelopeForSpawn({ isCode: true, cwd: "/repo", boardDataDir: "/repo", stateDir: STATE });
    expect(e.denyWrite).toEqual([STATE]);
  });

  it("o recorte protege o que importa: credenciais e a cerca dos runs CONCORRENTES", () => {
    const e = envelopeForSpawn({ isCode: true, cwd: "/repo", boardDataDir: "/repo", stateDir: STATE });
    // o diretório dos settings de sandbox vive sob o state dir — é a cerca dos OUTROS runs
    expect(`${STATE}/sandbox`.startsWith(e.denyWrite[0])).toBe(true);
    expect(`${STATE}/auth-token`.startsWith(e.denyWrite[0])).toBe(true);
  });

  it("prefixo PARCIAL não conta como 'dentro' (…/.runner-old não é …/.runner)", () => {
    // ⚠ O fixture ANTERIOR usava "/repo-outro/.runner" — raízes diferentes, um caso trivialmente fora
    // que passaria até com um `startsWith` ingênuo, sem separador. O nome do teste prometia colisão de
    // PREFIXO e media outra coisa (achado de revisão). "/repository" é o caso real: ele começa com
    // "/repo" e NÃO está dentro de "/repo".
    const e = envelopeForSpawn({ isCode: true, cwd: "/repo", boardDataDir: "/repo", stateDir: "/repository/.runner" });
    expect(e.denyWrite).toEqual([]);
  });

  it("os call-sites de produção não montam mais o envelope — ele vive nas posturas nomeadas", () => {
    // ⚠ ESTE TESTE ERA UM REGEX sobre a chamada dos call-sites, e o bloqueador da 12ª revisão mostrou
    // por que isso nunca ia bastar: cinco mutações nos ARGUMENTOS passavam na suíte inteira. Os
    // argumentos saíram do call-site e viraram derivação dentro de `resolveEnginePosture` /
    // `resolveRunTaskPosture`; o que os guarda agora é o bloco (25), que afirma o VALOR devolvido.
    // O que sobra aqui é a régua de FORMA: ninguém volta a montar a postura à mão.
    for (const f of ["engine.ts", "../mcp/dev-tools.ts"]) {
      const src = readFileSync(path.join(__dirname, f), "utf8");
      expect(src, `${f} voltou a montar a postura inline`).not.toMatch(/resolveAutonomyPosture\(\{/);
      expect(src, `${f} voltou a escolher o writeRoot inline`).not.toMatch(/writeRoot:\s*(isCode\s*\?|cwd|workdir)\b/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// (13) O VERIFICADOR É VERIFICADO — a lição da 10ª revisão, e a terceira vez que ela chega mais fundo.
//
// Trajetória, porque o padrão importa mais que o defeito:
//   1ª — não havia portão: mutar `buildSpawnFlags` passava em 7027 provas;
//   2ª — o portão conferia o PONTEIRO: mutar `enabled: true` → `false` passava em 7068 de 7069;
//   3ª — o portão conferia a CERCA, mas só as partes constantes: `allowWrite: ["/"]` passava em 168/169;
//   4ª — o portão conferia `allowWrite`, e um revisor mutou A PRÓPRIA CHECAGEM de volta à forma fraca:
//        **7079 de 7079 verdes**. O produtor estava guardado (porque o portão aborta em produção quando
//        ele erra); o VERIFICADOR não estava guardado por nada.
//
// A correção não é "mais uma checagem" — é fechar a assimetria: toda invariante da fronteira ganha um
// teste de VIOLAÇÃO, e um teste EXAUSTIVO percorre cada folha do settings conhecido-bom para que uma
// chave nova nasça classificada em vez de nascer não-verificada.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("(13) o VERIFICADOR da fronteira, verificado", () => {
  const bom = () => buildSandboxSettings({ writeRoot: "/wt", credentialsDir: CRED_DIR }) as { sandbox: Record<string, unknown> };
  const esperado = {
    writeRoot: "/wt",
    credentialPaths: harnessCredentialPaths(CRED_DIR),
    denyWrite: [] as readonly string[],
    origem: "fixture",
  };

  it("o settings conhecido-bom PASSA (guarda de não-vacuidade: sem isto, tudo abaixo é vácuo)", () => {
    expect(() => assertSettingsIsFence(bom(), esperado)).not.toThrow();
  });

  // ── AS VIOLAÇÕES, UMA A UMA ────────────────────────────────────────────────────────────────────
  it.each([
    ["enabled", false, /enabled/],
    ["autoAllowBashIfSandboxed", false, /autoAllowBashIfSandboxed/],
    ["failIfUnavailable", false, /failIfUnavailable/],
    ["allowUnsandboxedCommands", true, /allowUnsandboxedCommands/],
  ] as const)("sandbox.%s desarmado ⇒ RECUSA", (chave, valor, re) => {
    const s = bom();
    s.sandbox[chave] = valor;
    expect(() => assertSettingsIsFence(s, esperado)).toThrow(re);
  });

  it("A MUTAÇÃO DO REVISOR: allowWrite = ['/'] ⇒ RECUSA (era o caso que passava com o portão mudo)", () => {
    const s = bom();
    (s.sandbox.filesystem as { allowWrite: string[] }).allowWrite = ["/"];
    expect(() => assertSettingsIsFence(s, esperado)).toThrow(/envelope de escrita/);
  });

  it("allowWrite com a árvore CERTA mais uma segunda ⇒ RECUSA (ampliar é ampliar)", () => {
    const s = bom();
    (s.sandbox.filesystem as { allowWrite: string[] }).allowWrite = ["/wt", "/outro"];
    expect(() => assertSettingsIsFence(s, esperado)).toThrow(/envelope de escrita/);
  });

  it("allowWrite apontando para OUTRA árvore ⇒ RECUSA (a cerca existe e está no lugar errado)", () => {
    const s = bom();
    (s.sandbox.filesystem as { allowWrite: string[] }).allowWrite = ["/outra-arvore"];
    expect(() => assertSettingsIsFence(s, esperado)).toThrow(/envelope de escrita/);
  });

  it("filesystem.disabled = true ⇒ RECUSA — o CLI documenta essa chave como desligar o isolamento", () => {
    const s = bom();
    (s.sandbox.filesystem as Record<string, unknown>).disabled = true;
    expect(() => assertSettingsIsFence(s, esperado)).toThrow(/disabled/);
  });

  it.each([[["*"]], [["api.anthropic.com", "*.evil.com"]], [[]]])(
    "allowedDomains %j ⇒ RECUSA (curinga anula a allowlist inteira; vazia não é allowlist)",
    (dominios) => {
      const s = bom();
      (s.sandbox.network as { allowedDomains: string[] }).allowedDomains = dominios as string[];
      expect(() => assertSettingsIsFence(s, esperado)).toThrow(/egresso/);
    },
  );

  it("credenciais do HARNESS não negadas ⇒ RECUSA (o run leria o token do próprio harness)", () => {
    const s = bom();
    const files = (s.sandbox.credentials as { files: { path: string }[] }).files;
    (s.sandbox.credentials as { files: unknown[] }).files = files.filter((f) => !f.path.startsWith(CRED_DIR));
    expect(() => assertSettingsIsFence(s, esperado)).toThrow(/NEGA credenciais/);
  });

  it("credencial listada com mode != deny NÃO conta como negada (mask não é deny para este fim)", () => {
    const s = bom();
    const files = (s.sandbox.credentials as { files: { path: string; mode: string }[] }).files;
    for (const f of files) if (f.path.startsWith(CRED_DIR)) f.mode = "mask";
    expect(() => assertSettingsIsFence(s, esperado)).toThrow(/NEGA credenciais/);
  });

  // DERIVADO da constante, não uma cópia dela: a lista literal aqui incluía as duas entradas mortas e
  // cimentava a lista inteira em dois lugares ao mesmo tempo.
  it.each([...DEFAULT_DENY_READ])(
    "a negação de %s some ⇒ RECUSA",
    (alvo) => {
      const s = bom();
      const files = (s.sandbox.credentials as { files: { path: string }[] }).files;
      (s.sandbox.credentials as { files: unknown[] }).files = files.filter((f) => f.path !== alvo);
      expect(() => assertSettingsIsFence(s, esperado)).toThrow(/NEGA credenciais/);
    },
  );

  // ── A GUARDA EXAUSTIVA ─────────────────────────────────────────────────────────────────────────
  // As violações acima cobrem o que eu LEMBREI de cobrir — que é exatamente a fraqueza que produziu as
  // quatro rodadas anteriores. Este teste remove a dependência da minha memória: ele percorre CADA
  // folha do settings conhecido-bom, muta aquela folha, e exige que a fronteira reprove. Uma chave nova
  // que não sustente a cerca tem de ser declarada aqui, no ato — não descoberta por um revisor depois.
  it("EXAUSTIVO: toda folha do settings ou sustenta a cerca, ou está declarada como não-sustentante", () => {
    const NAO_SUSTENTAM = new Set<string>([
      // Limitação NOMEADA do host, não parte da fronteira: liga o modo fraco de sandbox aninhado. Ela
      // não aparece no fixture (só é emitida quando `weakerNested`), e está aqui para o dia em que
      // aparecer — o teste falharia com "folha nova não classificada" se ela surgisse sem esta linha.
      "sandbox.enableWeakerNestedSandbox",
      // ⚠ `sandbox.filesystem.denyWrite` SAIU desta lista. Ele estava aqui com o argumento de que
      // "recorte de dentro do envelope é diferente de furar a cerca" — e um revisor mostrou o custo:
      // apagar a emissão dele, ou parar de repassá-lo da postura, deixava a suíte COMPLETA idêntica ao
      // baseline. Ele é o que impede um run de reescrever as credenciais do harness e a cerca dos runs
      // CONCORRENTES; classificá-lo como não-sustentante era o erro.
    ]);

    const folhas = (obj: unknown, prefixo: string): string[] => {
      if (obj === null || typeof obj !== "object") return [prefixo];
      if (Array.isArray(obj)) return [prefixo];
      return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => folhas(v, prefixo ? `${prefixo}.${k}` : k));
    };
    const caminhos = folhas(bom(), "");
    // Guarda de não-vacuidade: se o settings encolher a ponto de não haver folhas, o loop abaixo não
    // mede nada e este teste passaria vazio — que é a classe de defeito que o arquivo inteiro combate.
    expect(caminhos.length).toBeGreaterThanOrEqual(6);

    // ── A PERGUNTA CERTA ────────────────────────────────────────────────────────────────────────
    // A primeira versão deste guarda aplicava UMA mutação por folha e exigia rejeição — e reprovou em
    // `network.allowedDomains`, com razão de estar errada: trocar a allowlist por `["/"]` deixa a cerca
    // MAIS restritiva, não menos. Exigir que a fronteira reclame de toda alteração confunde "esta chave
    // é verificada" com "esta chave é imutável".
    //
    // A propriedade honesta é: **existe alguma mutação desta folha que a fronteira rejeita** — ou seja,
    // a chave é load-bearing, e não uma que ninguém olha. Por isso a bateria abaixo, e por isso o
    // critério é "pelo menos uma rejeitada".
    const bateria = (atual: unknown): unknown[] =>
      typeof atual === "boolean"
        ? [!atual, undefined, "sim"]
        : Array.isArray(atual)
          ? [[], ["*"], ["/"], [...(atual as unknown[]), "/"], undefined, "nao-e-array"]
          : [undefined, "__MUTADO__", null, 0];

    const naoDetectadas: string[] = [];
    for (const caminho of caminhos) {
      if (NAO_SUSTENTAM.has(caminho)) continue;
      const partes = caminho.split(".");
      let algumaRejeitada = false;
      for (const mutacao of bateria(
        partes.reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], bom()),
      )) {
        const s = bom();
        let alvo: Record<string, unknown> = s as unknown as Record<string, unknown>;
        for (const p of partes.slice(0, -1)) alvo = alvo[p] as Record<string, unknown>;
        const ultima = partes.at(-1)!;
        if (mutacao === undefined) delete alvo[ultima];
        else alvo[ultima] = mutacao;
        try {
          assertSettingsIsFence(s, esperado);
        } catch {
          algumaRejeitada = true;
          break;
        }
      }
      if (!algumaRejeitada) naoDetectadas.push(caminho);
    }
    expect(
      naoDetectadas,
      "folha do settings que NENHUMA mutação faz a fronteira reclamar — logo ela não é verificada por " +
        "nada: ou acrescente a checagem em assertSettingsIsFence, ou declare-a em NAO_SUSTENTAM dizendo por quê",
    ).toEqual([]);
  });

  // ── O ARQUIVO MUDOU DEPOIS (a janela que nenhuma lista de chaves cobre) ────────────────────────
  it("o settings reescrito ENTRE a postura e o spawn ⇒ RECUSA por sha, mesmo continuando válido", () => {
    // O caso não é "uma chave errada" — é "o arquivo é outro". Um run concorrente que sobrescreva, uma
    // poda que trunque, um editor que passe por ali. Aqui o conteúdo novo é uma cerca PERFEITAMENTE
    // válida, só que de outra árvore: nenhuma checagem semântica pegaria, o sha pega.
    const p = posturaSandboxed();
    writeFileSync(
      p.settingsFile,
      serializeSandboxSettings(buildSandboxSettings({ writeRoot: "/wt", credentialsDir: CRED_DIR })) + "\n",
      "utf8",
    );
    expect(() =>
      assertContainmentReachedCommand(p, `claude -p "x" --permission-mode acceptEdits --settings ${p.settingsFile}`, "claude"),
    ).toThrow(/MUDOU entre a montagem da postura e o spawn/);
  });

  it("o settings íntegro passa pelo sha (guarda de não-vacuidade do teste acima)", () => {
    const p = posturaSandboxed();
    expect(() =>
      assertContainmentReachedCommand(p, `claude -p "x" --permission-mode acceptEdits --settings ${p.settingsFile}`, "claude"),
    ).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// (14) O PORTÃO LÊ SINTAXE, NÃO DADO — o prompt deixou de envenenar a verificação.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("(14) tokenização: o argumento do usuário não é sintaxe", () => {
  it("PROPRIEDADE: tokenize(args.map(quoteArg).join(' ')) devolve args — inclusive os adversariais", () => {
    // É esta propriedade que autoriza o portão do engine a trabalhar sobre a string final. Sem ela, a
    // conversão string→tokens seria um palpite, e o portão voltaria a ser regex com outro nome.
    const casos: string[][] = [
      ["claude", "-p", "texto simples"],
      ["claude", "-p", "contém --settings no meio", "--settings", "/x.json"],
      ["claude", "-p", "--dangerously-skip-permissions é o assunto"],
      ["claude", "-p", "acentuação, vírgula; ponto."],
      ["claude", "-p", "Bash(git:*)"],
      ["claude", "-p", ""],
      ["claude", "-p", "caminho com espaço/e-hífen_e.ponto"],
      ["claude", "--allowedTools", "mcp__x__y", "--model", "claude-opus-5"],
    ];
    for (const args of casos) {
      expect(tokenizeCommandLine(args.map(quoteArg).join(" ")), JSON.stringify(args)).toEqual(args);
    }
  });

  it("O FALSO POSITIVO MEDIDO PELO REVISOR: prompt contendo `--settings` NÃO aborta o run", () => {
    // Reprodução literal do achado: o portão juntava o argv por espaço e contava dois `--settings`,
    // abortando um run cujo único pecado era o ASSUNTO da conversa. Um portão que reprova pelo assunto
    // não é um portão.
    const p = posturaSandboxed();
    const argv = [
      "-p",
      "explique por que o engine emite --settings aqui",
      "--permission-mode",
      "acceptEdits",
      "--settings",
      p.settingsFile,
    ];
    expect(() => assertContainmentReachedArgv(p, argv)).not.toThrow();
  });

  it("O SEGUNDO FALSO POSITIVO: prompt citando `--dangerously-skip-permissions` NÃO aborta", () => {
    const p = posturaSandboxed();
    const argv = [
      "-p",
      "por que existia --dangerously-skip-permissions?",
      "--permission-mode",
      "acceptEdits",
      "--settings",
      p.settingsFile,
    ];
    expect(() => assertContainmentReachedArgv(p, argv)).not.toThrow();
  });

  it("mas a flag DE VERDADE continua sendo pega — o falso positivo sumiu, o verdadeiro não", () => {
    // A guarda que impede a correção de virar cegueira: se tirar o falso positivo tivesse desarmado o
    // portão, este teste passaria a não lançar.
    const p = posturaSandboxed();
    expect(() =>
      assertContainmentReachedArgv(p, [
        "-p",
        "prompt inocente",
        "--permission-mode",
        "acceptEdits",
        "--settings",
        p.settingsFile,
        "--dangerously-skip-permissions",
      ]),
    ).toThrow(/montada e depois contornada/);
  });

  it("a forma --flag=valor também conta (contar só `--flag valor` deixaria a outra passar)", () => {
    const p = posturaSandboxed();
    expect(() =>
      assertContainmentReachedArgv(p, ["-p", "x", "--permission-mode", "acceptEdits", `--settings=${p.settingsFile}`, "--settings", "/outro.json"]),
    ).toThrow(/mais de um --settings/);
  });

  it("o --permission-mode EFETIVO é o ÚLTIMO, na forma com `=` também", () => {
    const p = posturaSandboxed();
    expect(() =>
      assertContainmentReachedArgv(p, ["-p", "x", "--permission-mode", "acceptEdits", "--settings", p.settingsFile, "--permission-mode=bypassPermissions"]),
    ).toThrow(/precisa ser acceptEdits/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// (15) O BLOQUEADOR: a detecção da cerca ampliável lia UM diretório; o CLI SOBE até a raiz do repo.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("(15) a cadeia de settings que o CLI realmente lê", () => {
  it("varre do cwd até o diretório com .git — inclusive", () => {
    const existe = (p: string) => p === "/repo/.git";
    expect(diretoriosDeSettings("/repo/packages/acmeapp/src", existe)).toEqual([
      "/repo/packages/acmeapp/src",
      "/repo/packages/acmeapp",
      "/repo/packages",
      "/repo",
    ]);
  });

  it("para NO .git — não sobe para o repositório-pai de um monorepo aninhado", () => {
    const existe = (p: string) => p === "/pai/filho/.git";
    expect(diretoriosDeSettings("/pai/filho/sub", existe)).toEqual(["/pai/filho/sub", "/pai/filho"]);
  });

  it("O DEFEITO MEDIDO PELO REVISOR: settings hostil na RAIZ e cwd num subdiretório ⇒ RECUSA", () => {
    // Medição do revisor, com o CLI real: rodando de `projtest/sub/deep`, `claude config list` reporta
    // "Project — projtest/.claude/settings.json (repo root, two levels up from your cwd)". A versão
    // anterior passava `projectRoot = cwd` e lia dois caminhos inexistentes, resolvendo `sandboxed`
    // enquanto o CLI mesclava a raiz. Defesa presente na sintaxe, zero na semântica — e justamente na
    // superfície alcançável pela internet.
    const lidos: string[] = [];
    const p = resolveAutonomyPosture({ trigger: null,
      tier: "full",
      support: suporte(),
      env: {},
      projectRoot: "/repo/packages/acmeapp",
      writeRoot: "/repo/packages/acmeapp",
      stateRoot: "/state",
      key: "k",
      writeSettings: () => "/fake/sandbox.json",
      readTarget: (f) => {
        lidos.push(f);
        return f === "/repo/.claude/settings.json" ? JSON.stringify({ sandbox: { filesystem: { allowWrite: ["/"] } } }) : null;
      },
    });
    expect(p.kind).toBe("refused");
    // E a recusa NOMEIA o arquivo real, não um caminho relativo ambíguo — o operador precisa saber
    // qual arquivo remover.
    if (p.kind === "refused") expect(p.reason).toContain("/repo/.claude/settings.json");
    // Guarda de não-vacuidade: a detecção realmente subiu (se lesse só o cwd, este caminho não estaria lá).
    expect(lidos).toContain("/repo/.claude/settings.json");
  });

  it("a recusa oferece a saída SEGURA, não só a perigosa (achado de revisão)", () => {
    // A mensagem anterior dava duas saídas: remover o arquivo, ou ALLOW_UNSANDBOXED_FULL=1 — que é
    // shell irrestrito como root. A terceira existe no código e é a segura: SANDBOX_MODE=off cai em
    // `downgraded`, sem shell. Omiti-la empurrava o operador apressado para a alavanca perigosa.
    const p = resolveAutonomyPosture({ trigger: null,
      tier: "full",
      support: suporte(),
      env: {},
      projectRoot: "/repo",
      writeRoot: "/repo",
      stateRoot: "/state",
      key: "k",
      writeSettings: () => "/fake/sandbox.json",
      readTarget: (f) => (f === "/repo/.claude/settings.json" ? JSON.stringify({ sandbox: { filesystem: { allowWrite: ["/"] } } }) : null),
    });
    expect(p.kind).toBe("refused");
    if (p.kind === "refused") {
      expect(p.reason).toMatch(/AGILEHARNESS_SANDBOX_MODE=off/);
      expect(p.reason).toMatch(/sem shell|--disallowedTools Bash/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// (16) As duas afirmações que viviam sem medição nenhuma.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("(16) detecção no macOS e allowlist de egresso — o que era afirmado, agora é medido", () => {
  it("macOS SEM sandbox-exec é INDISPONÍVEL — antes devolvia true por string de plataforma", () => {
    // O defeito: `available: true` incondicional no Darwin significava que
    // `AGILEHARNESS_SANDBOX_MODE=required` NUNCA podia recusar num Mac, e o teste antigo CIMENTAVA isso
    // passando `hasBin: noBins` e esperando true. "macOS tem Seatbelt" é verdade sobre o sistema, não
    // sobre a instalação.
    const s = detectSandboxSupport({ platform: "darwin", hasBin: noBins });
    expect(s.available).toBe(false);
    expect(s.missing).toEqual(["sandbox-exec"]);
  });

  // ── PROVA INVERTIDA (2026-08-05), e a razão fica aqui porque é onde a lição sobrevive ─────────────
  // Este teste EXIGIA `method: "sonda"` — e nenhuma sonda rodava. A 13ª revisão injetou sondas que
  // FALHAM (`runProbe`/`runNamespaceProbe` devolvendo ok:false) e contou ZERO chamadas: o Darwin
  // decidia por `hasBin("sandbox-exec")` e carimbava o campo que a própria interface define como a
  // distinção de auditoria entre medir e presumir. O teste não pegava a mentira: ele a CIMENTAVA.
  //
  // É a quinta ocorrência da classe nesta fase, e a única que nasceu DENTRO da correção de outra.
  // A regra que vale daqui em diante: um teste que afirma o estado atual não distingue "está certo"
  // de "está assim" — quando o estado atual é o defeito, a prova vira a defesa dele.
  it("macOS COM sandbox-exec: disponível por PRESENÇA DE BINÁRIO — e o rótulo não finge que mediu", () => {
    const s = detectSandboxSupport({
      platform: "darwin",
      hasBin: (b) => b === "sandbox-exec",
      // As sondas são injetadas FALHANDO de propósito: se alguma delas fosse consultada, o resultado
      // não poderia ser `available: true`. Que ele seja `true` mesmo assim é a prova de que ninguém
      // as chamou — e é exatamente por isso que o método NÃO pode se chamar "sonda".
      runProbe: () => ({ ok: false, stderr: "esta sonda deveria ter sido chamada e não foi" }),
      runNamespaceProbe: () => ({ ok: false, stderr: "idem" }),
    });
    expect(s).toMatchObject({ available: true, mechanism: "seatbelt", method: "presenca-de-binario" });
    expect(s.method).not.toBe("sonda");
  });

  it("macOS SEM sandbox-exec: indisponível, e o método diz que foi o binário que faltou", () => {
    const s = detectSandboxSupport({ platform: "darwin", hasBin: noBins });
    expect(s).toMatchObject({ available: false, mechanism: "none", method: "binario-ausente" });
  });

  it("required + macOS sem sandbox-exec ⇒ RECUSA (o caminho que não existia)", () => {
    const p = resolveAutonomyPosture({ trigger: null,
      tier: "full",
      support: detectSandboxSupport({ platform: "darwin", hasBin: noBins }),
      env: { AGILEHARNESS_SANDBOX_MODE: "required" },
      projectRoot: "/wt",
      writeRoot: "/wt",
      stateRoot: "/state",
      key: "k",
      writeSettings: () => "/fake/sandbox.json",
    });
    expect(p.kind).toBe("refused");
  });

  it("resolveAllowedDomains ESTENDE e nunca SUBSTITUI — a promessa que três documentos fazem", () => {
    // Exportada, dirigida por env, documentada no README, no ADR e no .env.example — e sem um único
    // teste comportamental (achado de revisão). Um refactor que trocasse o spread por atribuição
    // produziria exatamente o modo de falha que o comentário diz querer evitar, em silêncio.
    expect(resolveAllowedDomains({})).toEqual([...DEFAULT_ALLOWED_DOMAINS]);
    const estendido = resolveAllowedDomains({ AGILEHARNESS_SANDBOX_ALLOWED_DOMAINS: "exemplo.dev" });
    for (const d of DEFAULT_ALLOWED_DOMAINS) expect(estendido).toContain(d);
    expect(estendido).toContain("exemplo.dev");
  });

  it("entradas vazias e duplicatas não sujam a allowlist", () => {
    const r = resolveAllowedDomains({
      AGILEHARNESS_SANDBOX_ALLOWED_DOMAINS: `,,exemplo.dev, ,${DEFAULT_ALLOWED_DOMAINS[0]},exemplo.dev,`,
    });
    expect(r.filter((d) => d === "exemplo.dev")).toHaveLength(1);
    expect(r.filter((d) => d === DEFAULT_ALLOWED_DOMAINS[0])).toHaveLength(1);
    expect(r).not.toContain("");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// (17) A ASSIMETRIA AMPLIAR × ESTREITAR — a recusa parou de punir quem só aperta a cerca.
//
// Vem da arte prévia: é o mesmo desenho de `protected configuration` (git), de Workspace Trust
// (VS Code, com `restricted?: boolean` POR CHAVE aplicado no parser) e do que a documentação do próprio
// CLI enuncia: "a deny entry only ever narrows access, so any scope can add one, but no scope can
// remove one that another scope added".
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("(17) só o que AMPLIA a cerca recusa o run", () => {
  const raiz = (q: string) => q === "/wt/.git";
  const comSettings = (sandbox: unknown) => (p: string) =>
    p === "/wt/.claude/settings.json" ? JSON.stringify({ sandbox }) : null;

  it.each([
    ["filesystem.denyWrite", { filesystem: { denyWrite: ["/etc"] } }],
    ["filesystem.denyRead", { filesystem: { denyRead: ["/root/.ssh"] } }],
    ["network.deniedDomains", { network: { deniedDomains: ["evil.com"] } }],
    ["network.strictAllowlist", { network: { strictAllowlist: true } }],
    ["credentials", { credentials: { files: [{ path: "~/.npmrc", mode: "deny" }] } }],
  ])("o alvo declarando %s NÃO recusa — estreitar é sempre aceitável", (_nome, sandbox) => {
    expect(detectTargetSandboxOverride("/wt", comSettings(sandbox), raiz)).toEqual([]);
  });

  it.each([
    ["filesystem.allowWrite", { filesystem: { allowWrite: ["/"] } }],
    ["filesystem.allowRead", { filesystem: { allowRead: ["/root"] } }],
    ["filesystem.disabled", { filesystem: { disabled: true } }],
    ["network.allowedDomains", { network: { allowedDomains: ["*"] } }],
    ["allowUnsandboxedCommands", { allowUnsandboxedCommands: true }],
    ["enabled", { enabled: false }],
    ["excludedCommands", { excludedCommands: ["curl"] }],
    ["bwrapPath", { bwrapPath: "/tmp/bwrap-falso" }],
  ])("o alvo declarando %s RECUSA — amplia, ou desliga", (nome, sandbox) => {
    const achados = detectTargetSandboxOverride("/wt", comSettings(sandbox), raiz);
    expect(achados).toHaveLength(1);
    expect(achados[0].keys).toContain(nome);
  });

  it("FAIL-CLOSED: chave DESCONHECIDA amplia por padrão — é o que sobrevive a um CLI novo", () => {
    // A lista enumera quem ESTREITA justamente para que o desconhecido caia do lado que recusa. Se a
    // lista fosse de quem amplia, uma chave nova do binário entraria em silêncio pelo lado permissivo.
    const achados = detectTargetSandboxOverride("/wt", comSettings({ chaveQueAindaNaoExiste: true }), raiz);
    expect(achados[0]?.keys).toEqual(["chaveQueAindaNaoExiste"]);
  });

  it("mistura: uma que estreita e uma que amplia ⇒ recusa NOMEANDO só a que amplia", () => {
    const achados = detectTargetSandboxOverride(
      "/wt",
      comSettings({ filesystem: { denyWrite: ["/etc"], allowWrite: ["/"] } }),
      raiz,
    );
    expect(achados[0].keys).toEqual(["filesystem.allowWrite"]);
  });

  it("guarda de não-vacuidade: a lista de quem estreita não está vazia nem cobre tudo", () => {
    // Se alguém esvaziar SANDBOX_KEYS_QUE_ESTREITAM, os casos de cima viram vácuo (tudo recusa e os
    // it.each de estreitamento reprovam) — mas se alguém a encher com "*" ou com toda chave conhecida,
    // a defesa some em silêncio. Este assert fixa os dois lados.
    expect(SANDBOX_KEYS_QUE_ESTREITAM.size).toBeGreaterThanOrEqual(5);
    for (const perigosa of ["filesystem.allowWrite", "filesystem.disabled", "enabled", "allowUnsandboxedCommands"]) {
      expect(SANDBOX_KEYS_QUE_ESTREITAM.has(perigosa), `${perigosa} NUNCA pode entrar na lista de quem estreita`).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// (18) O PROMPT NÃO PODE SATISFAZER O PORTÃO — a direção que o revisor não viu, e que é a perigosa.
//
// Uma medição independente encontrou o inverso do falso positivo: com o prompt carregando o PAR
// `--settings <caminho desta postura>`, a mutação histórica (filtrar `--settings` do argv antes do
// spawn) atravessava o portão CALADA — o comando saía sem contenção e a verificação passava verde,
// porque as duas condições que ela testava eram satisfeitas por texto que o chamador controla.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("(18) dado do usuário não conta como sintaxe do comando", () => {
  it("O ATAQUE MEDIDO: prompt carrega `--settings <arquivo real>` e a flag REAL foi filtrada ⇒ LANÇA", () => {
    const p = posturaSandboxed();
    // O argv que a mutação produziria: prompt hostil intacto, flags de verdade removidas.
    const argv = ["-p", `analise isto --settings ${p.settingsFile}`, "--permission-mode", "acceptEdits"];
    expect(() => assertContainmentReachedArgv(p, argv)).toThrow(/CONTENÇÃO PROMETIDA E AUSENTE/);
  });

  it("o caso patológico: o prompt é EXATAMENTE `--settings` ⇒ não conta, o run legítimo passa", () => {
    const p = posturaSandboxed();
    const argv = ["-p", "--settings", "--permission-mode", "acceptEdits", "--settings", p.settingsFile];
    expect(() => assertContainmentReachedArgv(p, argv)).not.toThrow();
  });

  it("o prompt exatamente `--dangerously-skip-permissions` não derruba um run contido", () => {
    const p = posturaSandboxed();
    const argv = ["-p", "--dangerously-skip-permissions", "--permission-mode", "acceptEdits", "--settings", p.settingsFile];
    expect(() => assertContainmentReachedArgv(p, argv)).not.toThrow();
  });

  it("mas a flag REAL depois do prompt continua sendo pega (a exclusão não virou cegueira)", () => {
    const p = posturaSandboxed();
    const argv = ["-p", "--settings", "--permission-mode", "acceptEdits", "--settings", p.settingsFile, "--dangerously-skip-permissions"];
    expect(() => assertContainmentReachedArgv(p, argv)).toThrow(/montada e depois contornada/);
  });

  it("a mesma exclusão vale na forma STRING (engine): prompt citado não vira sintaxe", () => {
    const p = posturaSandboxed();
    expect(() =>
      assertContainmentReachedCommand(
        p,
        `claude -p "analise isto --settings ${p.settingsFile}" --permission-mode acceptEdits`,
        "claude",
      ),
    ).toThrow(/CONTENÇÃO PROMETIDA E AUSENTE/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// (19) `--` É FIM DE OPÇÕES — o falso NEGATIVO que a arte prévia entregou de graça.
//
// Medido contra o CLI real por uma pesquisa independente: `claude -p -- "hello" --settings /A.json`
// executa normalmente e IGNORA a flag. Um portão que conte tokens depois do `--` vê a cerca presente
// enquanto o CLI a descartou — a pior combinação possível, porque a verificação sai verde.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("(19) tokens depois de `--` são operandos, não sintaxe", () => {
  it("`--` ANTES do --settings ⇒ o portão trata como ausente e ABORTA", () => {
    const p = posturaSandboxed();
    expect(() =>
      assertContainmentReachedArgv(p, ["-p", "x", "--permission-mode", "acceptEdits", "--", "--settings", p.settingsFile]),
    ).toThrow(/CONTENÇÃO PROMETIDA E AUSENTE/);
  });

  it("um `--dangerously-skip-permissions` DEPOIS do `--` não é flag — e não derruba o run", () => {
    // O simétrico: se `--` desliga a flag para o CLI, ele a desliga para o portão também. Tratar o
    // mesmo token com duas semânticas conforme convém é como o portão erra nas duas direções.
    const p = posturaSandboxed();
    expect(() =>
      assertContainmentReachedArgv(p, [
        "-p", "x", "--permission-mode", "acceptEdits", "--settings", p.settingsFile, "--", "--dangerously-skip-permissions",
      ]),
    ).not.toThrow();
  });

  it("sem `--`, o comando legítimo continua passando (guarda de não-vacuidade)", () => {
    const p = posturaSandboxed();
    expect(() =>
      assertContainmentReachedArgv(p, ["-p", "x", "--permission-mode", "acceptEdits", "--settings", p.settingsFile]),
    ).not.toThrow();
  });

  it("`--settings=<JSON inline>` não satisfaz o portão — o valor tem de ser O arquivo da postura", () => {
    // A pesquisa apontou que `--settings` aceita JSON INLINE, não só caminho. Uma verificação escrita
    // como "existe --settings" aceitaria a política inteira entrando por string.
    const p = posturaSandboxed();
    expect(() =>
      assertContainmentReachedArgv(p, ["-p", "x", "--permission-mode", "acceptEdits", '--settings={"sandbox":{"enabled":false}}']),
    ).toThrow(/--settings EFETIVO/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// (20) A ISENÇÃO NOMEADA — a Sonda Q quebrou um protocolo, e a saída não podia ser a válvula global.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("(20) isenção de contenção por trigger, declarada pelo operador", () => {
  const base = {
    tier: "full" as const,
    support: suporte(),
    projectRoot: "/wt",
    writeRoot: "/wt",
    stateRoot: "/state",
    key: "k",
    writeSettings: () => "/fake/sandbox.json",
  };

  // ── PROVAS INVERTIDAS (2026-08-05) — a válvula por trigger foi REMOVIDA ───────────────────────────
  // Estas três provas defendiam `AGILEHARNESS_UNCONTAINED_TRIGGERS`: uma exigia que ela fosse vazia por
  // padrão, outra que o trigger declarado rodasse SEM CONTENÇÃO, a terceira que isentar um não isentasse
  // os outros. Elas eram boas provas de um mecanismo que não deveria existir — e é essa a diferença que
  // este bloco registra em vez de apagar.
  //
  // A válvula existia por UM motivo escrito: a contenção dá network namespace próprio a cada chamada
  // Bash, o que quebrava o protocolo do harness-qa (subir servidor num passo, consultar no seguinte). Foi
  // medido que a varredura visual inteira cabe numa ÚNICA chamada contida, e que o `webServer` do
  // playwright sobe o dev server como filho da MESMA chamada. A razão de existir caiu; a peça saiu.
  //
  // Manter uma isenção por skill "por precaução" seria manter o incentivo invertido: silenciosa,
  // permanente, e acionável pelo primeiro plantonista que encontrasse um card travado — devolvendo
  // shell irrestrito no host justamente à skill que mais toca código. O que sobra é
  // `AGILEHARNESS_ALLOW_UNSANDBOXED_FULL`: global, alto, e honesto sobre o que concede.
  it("a válvula por trigger NÃO EXISTE MAIS: declarar a env não compra isenção nenhuma", () => {
    const p = resolveAutonomyPosture({
      ...base,
      // A env de ontem, com o trigger que ela isentava. Hoje é texto inerte.
      env: { AGILEHARNESS_UNCONTAINED_TRIGGERS: "harness-qa" },
      trigger: "harness-qa",
    });
    expect(p.kind).toBe("sandboxed");
    expect(p.kind).not.toBe("unsandboxed-escape");
  });

  it("a saída do operador continua existindo, e é a global — que diz o que concede", () => {
    // Não é um buraco esquecido: é a única porta, e ela é ruidosa. É também a alavanca de rollback do
    // pouso do F0 — o que a torna necessária, não tolerada.
    const p = resolveAutonomyPosture({
      ...base,
      env: { AGILEHARNESS_ALLOW_UNSANDBOXED_FULL: "1" },
      trigger: "harness-qa",
    });
    expect(p.kind).toBe("unsandboxed-escape");
    if (p.kind === "unsandboxed-escape") expect(p.warn).toMatch(/SEM CONTENÇÃO/);
  });

  // A prova do PARSER da lista saiu junto com a lista: ela media a tolerância a espaços e vírgulas de
  // um env que não é mais lido. Guardar o parser de uma feature removida é como manter a fechadura de
  // uma porta que virou parede.

  it("O CAMPO É OBRIGATÓRIO — o compilador cobra o call-site, não um regex sobre a fonte", () => {
    // A primeira versão deste guarda era `expect(src).toMatch(/trigger,/)` sobre engine.ts: a técnica
    // que esta fase já viu falhar três vezes, porque ela prova que a chamada aparece ESCRITA e não que
    // o valor CHEGA. Trocando o tipo para `trigger: string | null` (obrigatório, nullable), uma
    // superfície nova não compila sem decidir — e o teste que sobra é este, que documenta a escolha.
    //
    // @ts-expect-error — omitir `trigger` tem de ser ERRO DE TIPO; se um dia deixar de ser, este
    // expect-error passa a ser "unused" e o typecheck reprova, que é o alarme que queremos.
    const semTrigger: Parameters<typeof resolveAutonomyPosture>[0] = { ...base, env: {} };
    expect(semTrigger).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// (21) O COMANDO FINAL É UMA CADEIA, NÃO UMA INVOCAÇÃO — o recorte que faltava.
//
// Achado durante a própria correção desta rodada, e caro: a semântica de fim-de-opções, aplicada à
// string inteira, truncava no `--` do `systemd-run` e o portão parava de ver o `--settings` do
// `claude`. Onze provas do engine reprovaram sobre comandos perfeitamente contidos.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("(21) recorte da invocação do agente dentro do comando final", () => {
  it("o `--` do WRAPPER não é o fim de opções do claude", () => {
    const p = posturaSandboxed();
    // Forma REAL, copiada de `buildScopePrefix` (governor.ts:102): o prefixo termina em ` --` e o
    // binário vem cru logo depois. Inventar um `bash -lc "…"` aqui — como a primeira versão deste
    // teste fazia — mediria um comando que o engine nunca monta.
    const cmd =
      `systemd-run --scope --collect --unit=harness-run-x.scope --slice=claude-runs.slice ` +
      `-p MemoryMax=2G -p CPUQuota=300% -- claude -p "trabalho" --permission-mode acceptEdits --settings ${p.settingsFile}`;
    expect(() => assertContainmentReachedCommand(p, cmd, "claude")).not.toThrow();
  });

  it("mas o `--` do PRÓPRIO claude continua valendo (o recorte não virou cegueira)", () => {
    const p = posturaSandboxed();
    const cmd =
      `systemd-run --scope -- claude -p "x" --permission-mode acceptEdits -- --settings ${p.settingsFile}`;
    expect(() => assertContainmentReachedCommand(p, cmd, "claude")).toThrow(/CONTENÇÃO PROMETIDA E AUSENTE/);
  });

  it("uma flag homônima do WRAPPER não conta como a do agente", () => {
    // `--settings` de outra ferramenta antes do binário não pode satisfazer nem confundir o portão.
    const p = posturaSandboxed();
    const cmd = `ferramenta --settings /outro/qualquer.json -- claude -p "x" --permission-mode acceptEdits --settings ${p.settingsFile}`;
    expect(() => assertContainmentReachedCommand(p, cmd, "claude")).not.toThrow();
  });

  it("recorta a ÚLTIMA invocação, e reconhece caminho absoluto do binário", () => {
    expect(recorteDaInvocacao(["systemd-run", "--", "bash", "-lc", "/usr/bin/claude", "-p", "x"], "/usr/bin/claude")).toEqual([
      "/usr/bin/claude",
      "-p",
      "x",
    ]);
  });

  it("um binário com OUTRO NOME agora recorta certo — o corte é ancorado, não adivinhado", () => {
    // ANTES DE 2026-08-26 este caso era o defeito. O corte procurava um token cujo basename fosse
    // `claude`, e a régua de `runner/claude-bin.ts` aceita de propósito tanto outro NOME
    // (`autorun.claudeBin: "claude-canary"`) quanto outro ENDEREÇO (`AGILEHARNESS_CLAUDE=/opt/x/bin`).
    // Com qualquer um dos dois o corte devolvia o comando INTEIRO — embrulho junto — e o portão
    // reprovava um run LEGÍTIMO. MEDIDO: 12 testes do governor reproduziam isso.
    //
    // O comentário que estava aqui defendia a suposição dizendo que "o sintoma é ruidoso e não
    // silencioso". A direção do erro estava certa; o custo é que "ruidoso" significa abortar o run de
    // quem configurou uma coisa legítima, sem nada apontando para o nome do binário como causa.
    expect(
      recorteDaInvocacao(["systemd-run", "--", "/opt/x/claude-canary", "-p", "x"], "/opt/x/claude-canary"),
    ).toEqual(["/opt/x/claude-canary", "-p", "x"]);
  });

  it("o binário DECLARADO não está na cadeia ⇒ devolve TUDO — verificar demais é o erro barato", () => {
    // O degrau que sobra, e a escolha continua a mesma: entre abortar um run legítimo e deixar passar
    // um sem cerca, escolhe-se o primeiro. Só que agora esta condição é rara de verdade (o comando é
    // montado COM o binário que se passa aqui), em vez de acontecer sempre que alguém renomeia.
    expect(recorteDaInvocacao(["outro-bin", "-p", "x"], "/usr/bin/claude")).toEqual(["outro-bin", "-p", "x"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// (22) VERIFICAR E EXECUTAR NA MESMA EXPRESSÃO — o TOCTOU do meu próprio conserto.
//
// Um revisor mediu: o portão era chamado numa linha e o spawn acontecia em OUTRA, 50 linhas adiante no
// engine e 12 no run_task. Trocar `finalCmd` por `finalCmd.replace(/ --settings [^ ]+/, "")` NA CHAMADA
// DO SPAWN passava em **7167 de 7167** provas. "Impedir, não detectar" não vale quando a coisa impedida
// pode ser reescrita depois de impedida.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("(22) o spawn contido: nada entre a verificação e a execução", () => {
  it("comando íntegro ⇒ o spawn RECEBE exatamente o valor verificado", () => {
    const p = posturaSandboxed();
    const cmd = `claude -p "x" --permission-mode acceptEdits --settings ${p.settingsFile}`;
    const vistos: string[] = [];
    const r = spawnContidoCmd(
      p,
      cmd,
      (v) => {
        vistos.push(v);
        return "spawnou";
      },
      "claude",
    );
    expect(r).toBe("spawnou");
    expect(vistos).toEqual([cmd]); // o MESMO valor, não uma cópia transformada
  });

  it("comando adulterado ⇒ LANÇA e o spawn NÃO é chamado", () => {
    // A segunda metade é o que importa: um portão que lança DEPOIS de spawnar não impede nada.
    const p = posturaSandboxed();
    const spawn = vi.fn();
    expect(() => spawnContidoCmd(p, `claude -p "x" --permission-mode acceptEdits`, spawn, "claude")).toThrow(
      /CONTENÇÃO PROMETIDA E AUSENTE/,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("a mesma coisa para ARGV (run_task, execFile sem shell)", () => {
    const p = posturaSandboxed();
    const spawn = vi.fn();
    expect(() => spawnContidoArgv(p, ["-p", "x", "--permission-mode", "acceptEdits"], spawn)).toThrow(
      /CONTENÇÃO PROMETIDA E AUSENTE/,
    );
    expect(spawn).not.toHaveBeenCalled();
    const ok = ["-p", "x", "--permission-mode", "acceptEdits", "--settings", p.settingsFile];
    expect(spawnContidoArgv(p, ok, (v) => v)).toBe(ok);
  });

  it("postura RECUSADA nunca chega a spawnar", () => {
    const spawn = vi.fn();
    expect(() => spawnContidoCmd({ kind: "refused", reason: "alvo amplia" }, "claude -p x", spawn, "claude")).toThrow(/RECUSADA/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("LINT: nenhuma superfície spawna `claude` sem passar pelo estrangulamento", () => {
    // Enquanto o protocolo for "lembre-se de chamar o portão antes", a próxima superfície esquece — foi
    // exatamente assim que o `run_task` nasceu sem portão. Aqui a régua vira varredura.
    const SRC = path.resolve(__dirname, "..", "..", "..");
    const infratores: string[] = [];
    const comPostura: string[] = [];
    const varrer = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) varrer(full);
        else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
          const src = readFileSync(full, "utf8");
          const rel = path.relative(SRC, full).replace(/\\/g, "/");
          // O módulo que DEFINE o estrangulamento não precisa chamá-lo (e spawna nas sondas de suporte).
          if (/export function spawnContidoCmd/.test(src)) continue;
          // ⚠ O DETECTOR ANTERIOR ERA `/pexec\("claude"|spawnProcess\(finalCmd|spawn\("claude"/` e
          // enxergava UMA das quatro superfícies. Três spawnam por VARIÁVEL (`doSpawn(deps.claudeBin, …)`,
          // `this.spawnProcess(verificado, …)`), e a ironia medida por um revisor: o engine deixou de
          // casar JUSTAMENTE porque a migração para o estrangulamento trocou `spawnProcess(finalCmd` por
          // `spawnContidoCmd(posture, finalCmd, (verificado) => this.spawnProcess(verificado, …))`. O
          // lint devolvia `[]` por VACUIDADE, não por conformidade — a régua que este módulo apresenta
          // como "o que sobra para o futuro" media zero.
          //
          // O sinal robusto é a POSTURA: um arquivo que resolve postura de contenção existe para
          // spawnar um agente contido. Se ele resolve e não passa pelo estrangulamento, ou a costura
          // quebrou, ou nasceu uma superfície nova sem ela — e os dois casos são o que se quer pegar.
          const temPostura = /resolve(AutonomyPosture|EnginePosture|RunTaskPosture|JudgePosture|ReviewerPosture)\(/.test(src);
          const usaChokepoint = /spawnContido(Cmd|Argv)\(/.test(src);
          if (temPostura) comPostura.push(rel);
          if (temPostura && !usaChokepoint) infratores.push(rel);
        }
      }
    };
    varrer(SRC);
    // GUARDA DE NÃO-VACUIDADE — a que faltava, e que o lint de dívida no mesmo arquivo já tinha.
    // Sem ela, um detector que para de casar devolve `[]` e o lint vira decoração.
    expect(
      comPostura.length,
      `a varredura encontrou ${comPostura.length} superfície(s) com postura; são quatro (engine, ` +
        `run_task, revisor par, juiz de conflito) — se caiu, o DETECTOR quebrou, não o código`,
    ).toBeGreaterThanOrEqual(4);
    expect(
      infratores,
      "superfície que resolve postura de contenção fora de spawnContidoCmd/Argv — a verificação e a " +
        "execução voltaram a ser duas linhas distintas",
    ).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// (23) O LEITOR DE PRODUÇÃO EXISTE E FUNCIONA — nenhum caminho de teste o atravessava.
//
// Um revisor esvaziou `readTargetSettings` para `return null;` e mediu 7167/7167 verdes: as ~20 provas
// da cerca ampliável TODAS injetam um leitor falso, e o único laço com a produção era um regex sobre a
// fonte. A defesa inteira dependia de uma função que nenhuma prova executava.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("(23) readTargetSettings, o de verdade", () => {
  it("lê o arquivo do disco e devolve o conteúdo", () => {
    const dir = tempDir("ah-leitor-");
    const f = path.join(dir, "settings.json");
    writeFileSync(f, '{"sandbox":{"filesystem":{"allowWrite":["/"]}}}', "utf8");
    expect(readTargetSettings(f)).toContain("allowWrite");
  });

  it("arquivo ausente devolve null — e null é o caso NORMAL, não um erro", () => {
    expect(readTargetSettings(path.join(os.tmpdir(), "ah-nao-existe-" + process.pid))).toBeNull();
  });

  it("INTEGRAÇÃO: postura contra uma árvore HOSTIL de verdade, com o leitor de PRODUÇÃO ⇒ RECUSA", () => {
    // Este é o teste que faltava: nenhum caminho atravessava disco + leitor real + resolvedor. Com o
    // leitor esvaziado, ele reprova.
    const raiz = tempDir("ah-alvo-hostil-");
    mkdirSync(path.join(raiz, ".git"), { recursive: true });
    mkdirSync(path.join(raiz, ".claude"), { recursive: true });
    writeFileSync(
      path.join(raiz, ".claude", "settings.json"),
      JSON.stringify({ sandbox: { filesystem: { allowWrite: ["/"] } } }),
      "utf8",
    );
    const sub = path.join(raiz, "packages", "app");
    mkdirSync(sub, { recursive: true });

    const p = resolveAutonomyPosture({
      tier: "full",
      trigger: null,
      support: suporte(),
      env: {},
      projectRoot: sub, // o cwd é um SUBDIRETÓRIO: a detecção tem de subir até a raiz
      writeRoot: sub,
      stateRoot: tempDir("ah-state-"),
      key: "k",
      // SEM readTarget injetado ⇒ usa `readTargetSettings`, o de produção.
    });
    expect(p.kind).toBe("refused");
    if (p.kind === "refused") expect(p.reason).toContain(path.join(raiz, ".claude", "settings.json"));
  });

  it("a MESMA árvore sem o arquivo hostil ⇒ NÃO recusa (guarda de não-vacuidade)", () => {
    const raiz = tempDir("ah-alvo-limpo-");
    mkdirSync(path.join(raiz, ".git"), { recursive: true });
    const p = resolveAutonomyPosture({
      tier: "full",
      trigger: null,
      support: suporte(),
      env: {},
      projectRoot: raiz,
      writeRoot: raiz,
      stateRoot: tempDir("ah-state-"),
      key: "k",
      writeSettings: () => "/fake/sandbox.json",
    });
    expect(p.kind).toBe("sandboxed");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// (24) O RECORTE PROMETIDO É COBRADO — o portão só cobra o que a postura PROMETE.
//
// Um revisor apagou a emissão de `filesystem.denyWrite` em `buildSandboxSettings` e, num segundo teste,
// parou de repassá-lo em `resolveAutonomyPosture`. Nos DOIS casos a suíte completa ficou idêntica ao
// baseline — zero detecção, em pontos independentes. A causa não era esquecimento: a postura carregava
// `writeRoot` e `credentialPaths` (ambos cobrados) e NÃO carregava `denyWrite`, então o portão não
// tinha como saber o que havia sido prometido.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("(24) o denyWrite que a postura promete", () => {
  const comRecorte = () => {
    const settings = buildSandboxSettings({
      writeRoot: "/wt",
      credentialsDir: CRED_DIR,
      denyWrite: ["/wt/.runner"],
    }) as { sandbox: Record<string, unknown> };
    return settings;
  };
  const esperadoCom = {
    writeRoot: "/wt",
    credentialPaths: harnessCredentialPaths(CRED_DIR),
    denyWrite: ["/wt/.runner"] as readonly string[],
    origem: "fixture",
  };

  it("settings COM o recorte prometido passa (guarda de não-vacuidade)", () => {
    expect(() => assertSettingsIsFence(comRecorte(), esperadoCom)).not.toThrow();
  });

  it("MUTAÇÃO 1 — o produtor deixa de emitir denyWrite ⇒ RECUSA", () => {
    const s = comRecorte();
    delete (s.sandbox.filesystem as Record<string, unknown>).denyWrite;
    expect(() => assertSettingsIsFence(s, esperadoCom)).toThrow(/não RECORTA/);
  });

  it("MUTAÇÃO 2 — o recorte existe mas aponta para OUTRO caminho ⇒ RECUSA", () => {
    const s = comRecorte();
    (s.sandbox.filesystem as { denyWrite: string[] }).denyWrite = ["/outro/lugar"];
    expect(() => assertSettingsIsFence(s, esperadoCom)).toThrow(/não RECORTA/);
  });

  it("a POSTURA carrega o recorte — sem isso o portão não teria o que cobrar", () => {
    // Este é o elo que faltava: a mutação 2 do revisor era em `resolveAutonomyPosture`, não no produtor.
    const p = resolveAutonomyPosture({
      tier: "full",
      trigger: null,
      support: suporte(),
      env: {},
      projectRoot: "/repo",
      writeRoot: "/repo",
      stateRoot: "/repo/.runner",
      denyWrite: ["/repo/.runner"],
      key: "k",
      writeSettings: () => "/fake/sandbox.json",
    });
    expect(p.kind).toBe("sandboxed");
    if (p.kind === "sandboxed") expect(p.denyWrite).toEqual(["/repo/.runner"]);
  });

  it("ponta a ponta: o settings NO DISCO carrega o recorte, e o portão o confere", () => {
    const state = tempDir("ah-recorte-");
    const p = resolveAutonomyPosture({
      tier: "full",
      trigger: null,
      support: suporte(),
      env: {},
      projectRoot: "/repo",
      writeRoot: "/repo",
      stateRoot: state,
      denyWrite: [state],
      key: "k",
    });
    expect(p.kind).toBe("sandboxed");
    if (p.kind !== "sandboxed") return;
    expect(JSON.parse(readFileSync(p.settingsFile, "utf8")).sandbox.filesystem.denyWrite).toEqual([state]);
    expect(() =>
      assertContainmentReachedCommand(p, `claude -p "x" --permission-mode acceptEdits --settings ${p.settingsFile}`, "claude"),
    ).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// (25) O PERÍMETRO É UM VALOR OBSERVÁVEL, NÃO UM TEXTO DE CALL-SITE — o bloqueador da 12ª revisão.
//
// Cinco mutações adversariais nos ARGUMENTOS dos call-sites sobreviviam à suíte COMPLETA, porque o
// único guarda era regex sobre a fonte. Cada `it` abaixo mata uma delas afirmando o VALOR que a função
// nomeada devolve — um argumento errado passa a ser uma postura errada.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("(25) as posturas por superfície devolvem o perímetro certo", () => {
  const deps = { support: suporte(), env: {}, writeSettings: () => "/fake/sandbox.json", readTarget: () => null };

  it("skill de CÓDIGO: o envelope é a árvore do run, não a raiz", () => {
    const p = resolveEnginePosture(
      { tier: "full", trigger: "harness-do", isCode: true, cwd: "/repo/.worktrees/run-1", key: "k" },
      deps,
    );
    expect(p.kind).toBe("sandboxed");
    if (p.kind === "sandboxed") expect(p.writeRoot).toBe("/repo/.worktrees/run-1");
  });

  it("MUTAÇÃO `{ isCode: true }` fixo: skill NÃO-CODE tem de escrever na árvore do BOARD, não na raiz", () => {
    // A mutação exata do revisor. Com ela, as 5 skills `full` não-code ganhavam a raiz do repositório
    // inteiro como envelope de escrita — e a suíte completa não via.
    const p = resolveEnginePosture({ tier: "full", trigger: "harness-enrich", isCode: false, cwd: "/repo", key: "k" }, deps);
    expect(p.kind).toBe("sandboxed");
    if (p.kind !== "sandboxed") return;
    expect(p.writeRoot).not.toBe("/repo");
    expect(p.writeRoot).toContain("boards");
  });

  it("o run_task lê a cadeia de settings a partir da RAIZ, não do workdir", () => {
    // A segunda mutação: `projectRoot: findRepoRoot()` → `"/tmp"` deixava a Sonda W cega. Aqui o
    // caminho lido é OBSERVADO, então trocar a raiz por outra coisa quebra a asserção.
    const lidos: string[] = [];
    resolveRunTaskPosture(
      { workdir: path.join(findRepoRoot(), "packages", "storymap-ui"), key: "k" },
      { ...deps, readTarget: (f) => (lidos.push(f), null) },
    );
    expect(lidos.some((f) => f === path.join(findRepoRoot(), ".claude", "settings.json"))).toBe(true);
  });

  // ── PROVA INVERTIDA: o trigger não compra mais NADA, e é isso que precisa ser afirmado ────────────
  // Ela existia para pegar a 4ª mutação da 12ª revisão (`trigger` → `null` no engine, que deixava a
  // isenção nomeada permanentemente inerte com o operador achando que declarara algo). A isenção por
  // trigger foi removida em 2026-08-05, então a propriedade a defender inverteu: nenhum trigger, em
  // nenhuma combinação, pode devolver um run sem contenção.
  //
  // ⚠ DÍVIDA NOMEADA, e ela é da classe que este módulo persegue: com a válvula fora, `trigger` deixou
  // de ter QUALQUER leitor dentro de `resolveAutonomyPosture`. Ele continua obrigatório no tipo — e um
  // parâmetro obrigatório que ninguém lê é uma superfície que PARECE guardar algo. Ou ele volta a ter
  // consumidor, ou sai. Enquanto não sai, esta prova impede que alguém presuma que ele guarda.
  it("nenhum trigger compra isenção — a válvula por skill não existe mais", () => {
    for (const trigger of ["harness-qa", "harness-do", "harness-review", null]) {
      const p = resolveEnginePosture(
        { tier: "full", trigger, isCode: true, cwd: "/repo", key: "k" },
        { ...deps, env: { AGILEHARNESS_UNCONTAINED_TRIGGERS: String(trigger ?? "") } },
      );
      expect(p.kind, `trigger=${trigger}`).toBe("sandboxed");
    }
  });

  it("o state dir é RECORTADO do envelope quando cai dentro dele", () => {
    const p = resolveEnginePosture({ tier: "full", trigger: null, isCode: false, cwd: "/repo", key: "k" }, deps);
    expect(p.kind).toBe("sandboxed");
    if (p.kind !== "sandboxed") return;
    // Ou o state dir está fora do envelope (nada a recortar), ou está dentro E foi recortado.
    const dentro = runnerStateDir().startsWith(p.writeRoot + path.sep);
    expect(dentro ? p.denyWrite : []).toEqual(dentro ? [runnerStateDir()] : []);
  });

  it("LINT: os call-sites de produção NÃO montam a postura à mão", () => {
    // A régua que impede a volta: quem resolve postura usa a função nomeada da sua superfície. Sem
    // isto, o próximo call-site nasce com os argumentos soltos de novo.
    for (const f of ["engine.ts", "../mcp/dev-tools.ts"]) {
      const src = readFileSync(path.join(__dirname, f), "utf8");
      expect(src, `${f} voltou a montar resolveAutonomyPosture inline`).not.toMatch(/resolveAutonomyPosture\(\{/);
      expect(src, `${f} precisa usar a postura nomeada da superfície`).toMatch(/resolve(Engine|RunTask)Posture\(/);
    }
  });
});

describe("(26) knobs de segurança não falham abertos em silêncio", () => {
  const capturando = <T,>(fn: () => T): { r: T; erros: string[] } => {
    const erros: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void erros.push(a.join(" "));
    try {
      return { r: fn(), erros };
    } finally {
      console.error = orig;
    }
  };

  it("AGILEHARNESS_SANDBOX_MODE com typo GRITA — quem quis EXIGIR precisa saber que não exigiu", () => {
    // Medido pelo revisor: `require` (sem o "d") e `requried` caíam em `preferred` calados.
    const { r, erros } = capturando(() => resolveSandboxMode({ AGILEHARNESS_SANDBOX_MODE: "require" }));
    expect(r).toBe("preferred");
    expect(erros).toHaveLength(1);
    expect(erros[0]).toMatch(/require/);
    expect(erros[0], "o aviso precisa dizer a CONSEQUÊNCIA").toMatch(/NÃO está exigindo/);
  });

  it("ausente e vazio seguem silenciosos — quem não declarou não errou", () => {
    const { erros } = capturando(() => {
      resolveSandboxMode({});
      resolveSandboxMode({ AGILEHARNESS_SANDBOX_MODE: "" });
      resolveSandboxMode({ AGILEHARNESS_SANDBOX_MODE: "off" });
    });
    expect(erros).toEqual([]);
  });

  it("o PINO do segundo perímetro: worktreeIsolation nasce LIGADO", () => {
    // O README afirma que sem isso "a promessa de perímetro seria falsa", e trocar o default de volta
    // para `false` não reprovava nada (achado de revisão). O primeiro pino (a contagem de superfícies)
    // já era amarrado; este é o segundo.
    const cfgSrc = readFileSync(path.join(__dirname, "config.ts"), "utf8");
    expect(cfgSrc, "o default de worktreeIsolation voltou a ser false — o envelope de um run de código " +
      "deixaria de ser o worktree e viraria a raiz do repositório").toMatch(/worktreeIsolation:\s*true/);
    const readme = readFileSync(path.resolve(__dirname, "..", "..", "..", "..", "README.md"), "utf8");
    expect(readme, "o README precisa continuar declarando o default que o código tem").toMatch(/worktreeIsolation/);
  });
});
