// A NEGAÇÃO NATIVA CHEGA AO CLI — a fiação, ponta a ponta, sobre o que vai para o disco e para o argv.
//
// O módulo puro (credential-deny.test.ts) prova a FORMA das regras. Aqui se prova que elas CHEGAM:
//   · a declaração do adotante (`autorun.sandbox.denyReadGlobs` no settings.yaml) é LIDA — um knob sem
//     leitor é a classe que config-dead-knobs.test.ts existe para caçar;
//   · a postura CONTIDA grava as regras DENTRO do settings da cerca (um único `--settings`, que o portão
//     exige) e o portão RECUSA um settings sem elas;
//   · toda postura SEM sandbox (tiers write/orch/ro, rebaixada, válvula) recebe um `--settings` só de
//     negação — antes elas não tinham negação NENHUMA para o `Read` nativo.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// O leitor do settings.yaml é GOVERNADO daqui: o mock delega ao módulo real e só `loadRunnerConfig` é
// trocado, devolvendo o config real com a declaração do adotante enxertada.
const DECLARADO = ["/srv/segredos-do-adotante/**"];
let declarar = true;
vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return {
    ...actual,
    loadRunnerConfig: vi.fn(() => {
      const real = actual.loadRunnerConfig();
      return declarar ? { ...real, autorun: { ...real.autorun, sandbox: { denyReadGlobs: [...DECLARADO] } } } : real;
    }),
  };
});

import { applyEnvOverrides, coerceRunnerSettings, coerceSandboxDecl, DEFAULT_RUNNER_SETTINGS } from "./config";
import {
  assertContainmentReachedCommand,
  assertSettingsIsFence,
  buildSandboxSettings,
  buildSpawnFlags,
  credentialDenyRulesDoHost,
  declaredDenyReadGlobs,
  denySettingsFileFor,
  detectSandboxSupport,
  harnessCredentialPaths,
  resolveAutonomyPosture,
  writeCredentialDenySettingsFile,
  type AutonomyPosture,
} from "./autonomy-sandbox";
import { DEFAULT_CREDENTIAL_DENY_RULES, DENY_READ_ENV } from "./credential-deny";

const TEMPS: string[] = [];
const tempDir = (p: string) => {
  const d = mkdtempSync(path.join(os.tmpdir(), p));
  TEMPS.push(d);
  return d;
};
afterAll(() => {
  for (const d of TEMPS) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  declarar = true;
});

const suporte = () =>
  detectSandboxSupport({ platform: "linux", hasBin: () => true, runProbe: () => ({ ok: true, stderr: "" }) });
const lerJson = (f: string) => JSON.parse(readFileSync(f, "utf8")) as { permissions?: { deny?: string[] } };

describe("o settings.yaml — `autorun.sandbox.denyReadGlobs` tem coerção E leitor", () => {
  it("coerção: só strings não-vazias, aparadas; o resto some", () => {
    expect(coerceSandboxDecl({ denyReadGlobs: [" /a/** ", 7, "", null, "~/.kube/config"] })).toEqual({
      denyReadGlobs: ["/a/**", "~/.kube/config"],
    });
    expect(coerceSandboxDecl({ denyReadGlobs: "não-é-lista" })).toBeUndefined();
    expect(coerceSandboxDecl(undefined)).toBeUndefined();
  });

  it("ausente ⇒ a chave NÃO existe (config byte-idêntico ao de hoje); presente ⇒ atravessa o env override", () => {
    expect(coerceRunnerSettings({ autorun: {} }).autorun.sandbox).toBeUndefined();
    expect("sandbox" in DEFAULT_RUNNER_SETTINGS.autorun).toBe(false);
    const s = coerceRunnerSettings({ autorun: { sandbox: { denyReadGlobs: ["/srv/x/**"] } } });
    expect(s.autorun.sandbox).toEqual({ denyReadGlobs: ["/srv/x/**"] });
    const e = applyEnvOverrides(s);
    expect(e.autorun.sandbox).toEqual({ denyReadGlobs: ["/srv/x/**"] });
    expect(e.autorun.sandbox).not.toBe(s.autorun.sandbox); // clone, não referência
  });

  it("o LEITOR devolve o que o settings.yaml declara", () => {
    expect(declaredDenyReadGlobs()).toEqual(DECLARADO);
    declarar = false;
    expect(declaredDenyReadGlobs()).toEqual([]);
  });

  it("as regras do host somam: defaults ⊕ credenciais do harness ⊕ settings.yaml ⊕ env", () => {
    const regras = credentialDenyRulesDoHost({
      env: { [DENY_READ_ENV]: "~/.kube/config" },
      stateRoot: "/estado",
      toolPackageDir: () => "/ferramenta/pacote",
    });
    for (const r of DEFAULT_CREDENTIAL_DENY_RULES) expect(regras).toContain(r);
    expect(regras).toContain("Read(//srv/segredos-do-adotante/**)"); // do settings.yaml, sem ninguém passar
    expect(regras).toContain("Read(~/.kube/config)");
    expect(regras).toContain("Read(//estado/auth-token)");
    expect(regras).toContain("Read(//ferramenta/pacote/.env.local)");
  });
});

describe("postura CONTIDA — as regras vão DENTRO do settings da cerca, e o portão as cobra", () => {
  it("o settings gravado pela postura carrega a declaração do adotante e passa pelo portão", () => {
    const dir = tempDir("ah-deny-wiring-");
    const posture = resolveAutonomyPosture({
      tier: "full",
      trigger: null,
      support: suporte(),
      env: { [DENY_READ_ENV]: "~/.kube/config" },
      projectRoot: dir,
      writeRoot: dir,
      stateRoot: dir,
      key: "k1",
      readTarget: () => null,
    });
    expect(posture.kind).toBe("sandboxed");
    if (posture.kind !== "sandboxed") return;
    const deny = lerJson(posture.settingsFile).permissions?.deny ?? [];
    for (const r of DEFAULT_CREDENTIAL_DENY_RULES) expect(deny).toContain(r);
    expect(deny).toContain("Read(//srv/segredos-do-adotante/**)");
    expect(deny).toContain("Edit(//srv/segredos-do-adotante/**)");
    expect(deny).toContain("Read(~/.kube/config)");
    expect(deny).toContain(`Read(/${path.join(dir, "auth-token")})`);
    // e o comando contido segue com UM --settings — o de negação não entra aqui
    const { flags } = buildSpawnFlags({ posture, permissionArgs: ["--permission-mode", "acceptEdits"], denySettingsFile: "/nao/deve/entrar.json" });
    expect(flags.filter((f) => f === "--settings")).toHaveLength(1);
    expect(flags).not.toContain("/nao/deve/entrar.json");
    expect(() =>
      assertContainmentReachedCommand(posture, `claude -p "x" ${flags.map((f) => `"${f}"`).join(" ")}`, "claude"),
    ).not.toThrow();
  });

  const CRED = "/estado";
  const esperado = { writeRoot: "/wt", credentialPaths: harnessCredentialPaths(CRED), denyWrite: [] as readonly string[], origem: "fixture" };
  const bom = () => buildSandboxSettings({ writeRoot: "/wt", credentialsDir: CRED }) as { permissions: { deny: string[] } };

  it("sem permissions.deny ⇒ o portão RECUSA (a cerca conteria o Bash e deixaria o Read nativo livre)", () => {
    const s = bom();
    delete (s as { permissions?: unknown }).permissions;
    expect(() => assertSettingsIsFence(s, esperado)).toThrow(/permissions\.deny/);
  });

  it.each(["Read(~/.ssh/**)", "Read(~/.aws/**)", "Read(**/.env.*)", "Edit(~/.config/gcloud/**)"])(
    "sem %s ⇒ RECUSA",
    (regra) => {
      const s = bom();
      s.permissions.deny = s.permissions.deny.filter((r) => r !== regra);
      expect(() => assertSettingsIsFence(s, esperado)).toThrow(/permissions\.deny/);
    },
  );

  it("uma exceção `!` intrusa (reabre .env) ⇒ RECUSA; a do .env.example passa", () => {
    const s = bom();
    s.permissions.deny.push("Read(!**/.env)");
    expect(() => assertSettingsIsFence(s, esperado)).toThrow(/exceção/);
    expect(() => assertSettingsIsFence(bom(), esperado)).not.toThrow();
  });
});

describe("posturas SEM sandbox — o `--settings` só-de-negação chega ao argv", () => {
  const semSandbox: AutonomyPosture[] = [
    { kind: "nao-aplicavel", tier: "write" },
    { kind: "nao-aplicavel", tier: "ro" },
    { kind: "downgraded", tier: "write", warn: "sem bwrap" },
    { kind: "unsandboxed-escape", tier: "full", warn: "válvula" },
  ];

  it.each(semSandbox)("postura %j ⇒ o arquivo de negação vira `--settings`", (posture) => {
    const file = denySettingsFileFor(posture);
    expect(file, "sem sandbox e sem negação: o Read nativo lê ~/.aws").toBeTruthy();
    const deny = lerJson(file!).permissions?.deny ?? [];
    for (const r of DEFAULT_CREDENTIAL_DENY_RULES) expect(deny).toContain(r);
    expect(deny).toContain("Read(//srv/segredos-do-adotante/**)"); // a declaração chega aqui também
    const { flags } = buildSpawnFlags({ posture, permissionArgs: ["--permission-mode", "acceptEdits"], denySettingsFile: file });
    const i = flags.indexOf("--settings");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(flags[i + 1]).toBe(file);
  });

  it("contida e recusada NÃO recebem arquivo de negação (a contida já o carrega; a recusada não spawna)", () => {
    expect(denySettingsFileFor({ kind: "refused", reason: "x" })).toBeNull();
    const sandboxed = {
      kind: "sandboxed",
      tier: "full",
      settingsFile: "/s.json",
      settingsSha256: "0",
      credentialPaths: [],
      denyWrite: [],
      mechanism: "bubblewrap",
      weakerNested: false,
      writeRoot: "/wt",
    } as const;
    expect(denySettingsFileFor(sandboxed)).toBeNull();
  });

  it("endereçado por conteúdo: as mesmas regras são o MESMO arquivo, e ele não é reescrito", () => {
    const dir = tempDir("ah-deny-file-");
    const a = writeCredentialDenySettingsFile(["Read(~/.ssh/**)"], dir);
    const antes = statSync(a).ino;
    const b = writeCredentialDenySettingsFile(["Read(~/.ssh/**)"], dir);
    expect(b).toBe(a);
    // reescrever truncaria o arquivo que o CLI de um run concorrente pode estar lendo
    expect(statSync(b).ino).toBe(antes);
    const c = writeCredentialDenySettingsFile(["Read(~/.aws/**)"], dir);
    expect(c).not.toBe(a);
    expect(existsSync(c)).toBe(true);
    expect(path.basename(c).startsWith("sandbox-"), "a poda de sandbox-*.json não pode apagá-lo").toBe(false);
  });
});
