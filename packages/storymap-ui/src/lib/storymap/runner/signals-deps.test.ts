// O serviço roda os comandos das fontes de sinal como ELE MESMO, sem hook no caminho: só os roda como estão no commit (o
// que passou pela pergunta do dono) e só depois de a trava dura do host não recusar. O git é falso aqui.

import path from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "@/lib/storymap/paths";
import { argvAsShellLine, signalsSettingsRefusal } from "./signals-deps";

const file = path.join(findRepoRoot(), "storymap", "settings.yaml");
const git = (tracked: string, diffCode: number | null, lsCode: number | null = 0) => async (args: string[]) =>
  args[0] === "ls-tree" ? { code: lsCode, stdout: tracked } : { code: diffCode, stdout: "" };

describe("signalsSettingsRefusal — os comandos de sinal só rodam como o dono aprovou", () => {
  it("versionado e igual ao commit: roda", async () => {
    expect(await signalsSettingsRefusal(file, git("storymap/settings.yaml\n", 0))).toBeNull();
  });

  it("versionado e EDITADO sem commit (um agente plantou um comando): nada roda", async () => {
    expect(await signalsSettingsRefusal(file, git("storymap/settings.yaml\n", 1))).toMatch(/não commitada/);
  });

  it("git que não responde: nada roda (fail-closed); fora do git (config local do operador): roda", async () => {
    expect(await signalsSettingsRefusal(file, git("", 0, null))).toMatch(/não consegui/);
    expect(await signalsSettingsRefusal(file, git("storymap/settings.yaml\n", null))).toMatch(/não consegui/);
    expect(await signalsSettingsRefusal(file, git("", 0))).toBeNull();
  });
});

describe("argvAsShellLine — o argv como a trava dura do host o lê", () => {
  it("cita o que tem espaço ou metacaractere", () => {
    expect(argvAsShellLine(["just", "errors", "--json"])).toBe("just errors --json");
    expect(argvAsShellLine(["sh", "-c", "rm -rf / ; echo 'x'"])).toBe(`sh -c 'rm -rf / ; echo '\\''x'\\'''`);
  });
});
