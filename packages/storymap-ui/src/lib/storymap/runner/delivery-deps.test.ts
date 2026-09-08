// A FRONTEIRA de um board: o que a raia "No stage" conta como "ainda não no ar".
//
// Regressão de um número ERRADO em produção, não de um crash. A base do delta é a fronteira do board
// (`refs/promoted/<board>`), e `base..stage` significa "alcançável do stage e não da fronteira" — o que
// inclui commits que voltaram de `main` para o stage no refluxo. Com o pathspec do `acme` cobrindo
// `packages/orbit*` (sharedPackages), o commit `release:` de OUTRO board caiu dentro do escopo e a
// página anunciou por 5 dias uma entrega "ainda não no ar" que era ancestral de HEAD.
//
// O objeto do teste são os ARGUMENTOS do git: a exclusão tem de existir nas DUAS consultas (a lista e a
// contagem), senão o contador e a raia divergem — e é o contador que decide publicar.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storymap/paths", () => ({ findRepoRoot: () => "/repo" }));
vi.mock("./config", () => ({
  loadRunnerConfig: () => ({
    autorun: {
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
      publishQueue: { enabled: true },
    },
  }),
}));
vi.mock("@/lib/storymap/repo", () => ({
  listBoards: vi.fn(async () => [{ id: "acme" }]),
  readBoardConfig: vi.fn(async () => ({
    package: "packages/acmeapp",
    sharedPackages: ["packages/orbit/", "packages/acme-shared/"],
    // Sem `release` declarado ⇒ o default seguro (`manual`), que é o que o teste abaixo espera.
  })),
}));
// Colaboradores que `collectDelivery` usa e que este teste não exercita — presentes só para o módulo carregar.
vi.mock("./fleet-view", () => ({ collectFleet: vi.fn(async () => []) }));
vi.mock("./fleet-deps", () => ({ defaultFleetDeps: {} }));
vi.mock("./publish-queue", () => ({ listPublishRequests: vi.fn(async () => []) }));
vi.mock("./worktree", () => ({ defaultExec: vi.fn() }));

import { frontierOf } from "./delivery-deps";

const LIVE = "daac07e92aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STAGE = "20b717fcbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FRONTIER = "772e5384accccccccccccccccccccccccccccccc";

/** Um `exec` que registra os comandos e responde por casamento de prefixo. */
function fakeExec(responses: Array<[RegExp, string]>, seen: string[]) {
  return vi.fn(async (cmd: string) => {
    seen.push(cmd);
    for (const [re, out] of responses) if (re.test(cmd)) return { stdout: out, stderr: "" };
    throw new Error(`comando não esperado: ${cmd}`);
  });
}

function baseResponses(count: string, log: string): Array<[RegExp, string]> {
  return [
    [/log -1 --format=/, `${LIVE} 2026-07-28T19:44:13+02:00`],
    [/rev-parse --verify --quiet "stage\^\{commit\}"/, STAGE],
    [/rev-parse --verify --quiet "refs\/promoted\/acme"/, FRONTIER],
    [/merge-base --is-ancestor/, ""],
    [/rev-list --no-merges --count/, count],
    [/^git log --no-merges --max-count=/, log],
  ];
}

describe("frontierOf — o que já está NO AR não conta como entrega pendente", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exclui o sha vivo nas DUAS consultas (lista e contagem)", async () => {
    const seen: string[] = [];
    const f = await frontierOf("acme", fakeExec(baseResponses("7", ""), seen) as never);

    const list = seen.find((c) => c.startsWith("git log --no-merges --max-count="));
    const count = seen.find((c) => c.includes("rev-list --no-merges --count"));
    expect(list).toContain(`--not ${JSON.stringify(LIVE)}`);
    expect(count).toContain(`--not ${JSON.stringify(LIVE)}`);
    expect(f.stagedTotal).toBe(7);
  });

  it("mantém a base na fronteira do board e o pathspec dos pacotes dele", async () => {
    const seen: string[] = [];
    await frontierOf("acme", fakeExec(baseResponses("7", ""), seen) as never);

    const count = seen.find((c) => c.includes("rev-list --no-merges --count"))!;
    // A ordem importa: `base..stage` PRIMEIRO, a exclusão depois, o pathspec por último — `--` encerra
    // as revisões, então um `--not` do outro lado dele viraria caminho.
    expect(count).toMatch(/"772e5384[a-f0-9]*"\.\."stage" --not "daac07e9[a-f0-9]*" -- /);
    expect(count).toContain('"packages/acmeapp/"');
    expect(count).toContain('"packages/orbit/"');
    expect(count).toContain('"packages/acme-shared/"');
    // O pacote de OUTRO board nunca entra no escopo deste.
    expect(count).not.toContain("storymap-ui");
  });

  it("sem sha vivo legível, mede sem a exclusão em vez de não medir", async () => {
    const seen: string[] = [];
    const responses = baseResponses("8", "").map(([re, out]) =>
      /log -1 --format=/.test(String(re)) ? ([re, ""] as [RegExp, string]) : ([re, out] as [RegExp, string]),
    );
    const f = await frontierOf("acme", fakeExec(responses, seen) as never);

    const count = seen.find((c) => c.includes("rev-list --no-merges --count"))!;
    expect(count).not.toContain("--not");
    expect(f.stagedTotal).toBe(8);
    // Falsy, não `null`: o `git` devolveu string VAZIA (não falhou), e o default do destructuring só
    // cobre `undefined` — então sobra `""`. O que a exclusão precisa é exatamente isto: um guard por
    // veracidade, não por `!= null`, senão `--not ""` iria para a linha de comando.
    expect(f.liveSha).toBeFalsy();
  });

  it("separa PODE publicar (máquina) de PUBLICA SOZINHO (board)", async () => {
    // A regressão que isto tranca: as duas respostas vinham de UMA flag, e desligá-la apagava o botão
    // junto com o automático — o board ficava sem alavanca nenhuma, que foi o que prendeu o acme.
    const seen: string[] = [];
    const f = await frontierOf("acme", fakeExec(baseResponses("7", ""), seen) as never);
    expect(f.releaseMode).toBe("manual"); // o board não declarou ⇒ default seguro
    expect(f.canPublish).toBe(true); // …e mesmo assim a publicação PODE ser pedida
  });
});
