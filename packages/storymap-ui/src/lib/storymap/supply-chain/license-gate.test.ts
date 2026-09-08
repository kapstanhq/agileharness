// ATAQUE: uma dependência copyleft-FORTE entra no fecho de runtime de um projeto que vai ser publicado como
// OSS permissivo — e ninguém percebe até alguém de fora perceber.
//
// O dano não é técnico, é de licenciamento: uma GPL/AGPL no caminho de distribuição obriga o projeto inteiro
// a se relicenciar (ou a violar a licença dela). É irreversível na prática — código já publicado sob a
// licença errada não volta atrás. Custa nada prevenir e é caríssimo remediar.
//
// As cinco formas de furar um gate de licença ingênuo, todas fechadas aqui:
//   1. FORMA LEGADA — declarar por `licenses: [{type}]` em vez de `license`. Um gate que lê um campo só passa.
//   2. SEM LICENÇA — pacote sem campo nenhum. "Ausente" não é "permissiva": sem concessão explícita o
//      default legal é TODOS OS DIREITOS RESERVADOS, que é PIOR que copyleft. Gate ingênuo passa.
//   3. FALSO-POSITIVO POR SUBSTRING — `LGPL` e `(MIT OR GPL-2.0)` contêm "GPL" mas não são copyleft-forte
//      aplicável. Um gate que reprova por substring nasce vermelho, é desligado, e aí não protege nada.
//   4. RUG-PULL DE RELICENCIAMENTO — o pacote reconhecido no baseline muda de MIT para BUSL/SSPL num bump.
//      Baseline por NOME cobre o novo termo de carona.
//   5. ESCOPO ERRADO — reprovar por ferramenta de dev (que não é distribuída) faz o gate nascer vermelho.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));
const GATE = path.join(REPO_ROOT, "scripts/security/check-licenses.mjs");

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

type Manifesto = Record<string, unknown>;

function arvore(alvo: Manifesto, instalados: Record<string, Manifesto>, baseline?: object): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ah-lic-"));
  dirs.push(dir);
  const pkgDir = path.join(dir, "packages/alvo");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(alvo));
  for (const [nome, m] of Object.entries(instalados)) {
    const d = path.join(dir, "node_modules", nome);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "package.json"), JSON.stringify(m));
  }
  if (baseline) {
    mkdirSync(path.join(dir, "scripts/security"), { recursive: true });
    writeFileSync(path.join(dir, "scripts/security/license-baseline.json"), JSON.stringify(baseline));
  }
  return dir;
}

function gate(raiz: string, extra: string[] = []) {
  try {
    const out = execFileSync(process.execPath, [GATE, "--root", raiz, "--pkg", "packages/alvo", "--json", ...extra], {
      encoding: "utf8",
    });
    return { code: 0, v: JSON.parse(out) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? -1, v: err.stdout ? JSON.parse(err.stdout) : null };
  }
}

describe("gate de licença — copyleft-forte NOVA não entra (story-w5ujrj)", () => {
  it("ATAQUE: dependência AGPL no fecho de runtime REPROVA", () => {
    const r = gate(
      arvore({ name: "alvo", version: "1.0.0", dependencies: { util: "^1" } }, {
        util: { name: "util", version: "1.0.0", license: "AGPL-3.0-only" },
      }),
    );
    expect(r.code).toBe(2);
    expect(r.v.blocking.map((b: { name: string }) => b.name)).toContain("util");
  });

  it("ATAQUE 1: declarar pela forma LEGADA `licenses[]` não escapa", () => {
    // Um gate que lê só `license` vê `undefined` e libera.
    const r = gate(
      arvore({ name: "alvo", version: "1.0.0", dependencies: { util: "^1" } }, {
        util: { name: "util", version: "1.0.0", licenses: [{ type: "GPL-3.0-or-later", url: "x" }] },
      }),
    );
    expect(r.code).toBe(2);
    expect(r.v.blocking[0].license).toContain("GPL-3.0-or-later");
  });

  it("ATAQUE 2: pacote SEM licença é bloqueado — ausente não é permissiva", () => {
    // Sem concessão explícita, o default legal é todos-os-direitos-reservados: redistribuir é o risco MAIOR,
    // não o menor. Um gate que só procura "GPL" libera este caso, que é o pior dos dois.
    const r = gate(
      arvore({ name: "alvo", version: "1.0.0", dependencies: { misterioso: "^1" } }, {
        misterioso: { name: "misterioso", version: "1.0.0" },
      }),
    );
    expect(r.code).toBe(2);
    expect(r.v.blocking[0].reason).toMatch(/não declara|unknown/i);
  });

  it("ATAQUE 3: `(MIT OR GPL-2.0)` é PERMITIDA — disjunção deixa escolher o lado permissivo", () => {
    const r = gate(
      arvore({ name: "alvo", version: "1.0.0", dependencies: { dual: "^1" } }, {
        dual: { name: "dual", version: "1.0.0", license: "(MIT OR GPL-2.0-only)" },
      }),
    );
    expect(r.code, "reprovar aqui faria o gate nascer vermelho e ser desligado").toBe(0);
  });

  it("ATAQUE 3b: `(MIT AND GPL-2.0)` REPROVA — conjunção obriga a cumprir as duas", () => {
    const r = gate(
      arvore({ name: "alvo", version: "1.0.0", dependencies: { conj: "^1" } }, {
        conj: { name: "conj", version: "1.0.0", license: "(MIT AND GPL-2.0-only)" },
      }),
    );
    expect(r.code).toBe(2);
  });

  it("ATAQUE 3c: LGPL e MPL não são copyleft-FORTE — não bloqueiam", () => {
    // Ambas contêm/parecem GPL para um gate de substring. LGPL é copyleft fraco (linkagem) e MPL é por
    // ARQUIVO: nenhuma das duas obriga o projeto consumidor a se relicenciar. Bloqueá-las inventaria um
    // problema jurídico que não existe — e este fecho tem 5 pacotes MPL-2.0 de verdade (@blocknote/*, web-push).
    const r = gate(
      arvore({ name: "alvo", version: "1.0.0", dependencies: { a: "^1", b: "^1" } }, {
        a: { name: "a", version: "1.0.0", license: "LGPL-2.1-or-later" },
        b: { name: "b", version: "1.0.0", license: "MPL-2.0" },
      }),
    );
    expect(r.code).toBe(0);
  });

  it("ATAQUE 5: copyleft-forte SÓ em dev não bloqueia, mas é REPORTADO", () => {
    // Ferramenta de build não é distribuída, então não contamina o artefato. Reprovar por ela é o caminho
    // mais curto para o gate ser desligado — mas silenciá-la esconderia o dia em que ela virar runtime.
    const r = gate(
      arvore({ name: "alvo", version: "1.0.0", dependencies: {}, devDependencies: { ferramenta: "^1" } }, {
        ferramenta: { name: "ferramenta", version: "1.0.0", license: "GPL-3.0-only" },
      }),
    );
    expect(r.code).toBe(0);
    expect(r.v.devOnlyCopyleft.map((b: { name: string }) => b.name)).toContain("ferramenta");
  });

  it("baseline reconhece o que JÁ existe — e o NOVO continua reprovando", () => {
    const instalados = {
      antiga: { name: "antiga", version: "1.0.0", license: "GPL-3.0-only" },
      nova: { name: "nova", version: "2.0.0", license: "AGPL-3.0-only" },
    };
    const alvo = { name: "alvo", version: "1.0.0", dependencies: { antiga: "^1", nova: "^2" } };
    const baseline = {
      entries: [{ name: "antiga", license: "GPL-3.0-only", reason: "herdada, migração acordada" }],
    };
    const r = gate(arvore(alvo, instalados, baseline));
    expect(r.code).toBe(2);
    const nomes = r.v.blocking.map((b: { name: string }) => b.name);
    expect(nomes).toContain("nova");
    expect(nomes).not.toContain("antiga");
  });

  it("ATAQUE 4: rug-pull de relicenciamento — o baseline não cobre um TERMO diferente do reconhecido", () => {
    // O padrão real (Redis, Elastic, Terraform, Sentry): o pacote troca MIT por BUSL/SSPL num bump. Se o
    // baseline fosse por NOME, o termo novo entraria coberto pelo reconhecimento do termo ANTIGO.
    const alvo = { name: "alvo", version: "1.0.0", dependencies: { camaleao: "^1" } };
    const baseline = { entries: [{ name: "camaleao", license: "GPL-3.0-only", reason: "revisado em 2026-07" }] };

    const antes = gate(
      arvore(alvo, { camaleao: { name: "camaleao", version: "1.0.0", license: "GPL-3.0-only" } }, baseline),
    );
    expect(antes.code).toBe(0);

    const depois = gate(
      arvore(alvo, { camaleao: { name: "camaleao", version: "2.0.0", license: "SSPL-1.0" } }, baseline),
    );
    expect(depois.code, "licença NOVA precisa de revisão nova, mesmo em pacote já reconhecido").toBe(2);
    expect(depois.v.blocking[0].license).toBe("SSPL-1.0");
  });

  it("EXECUTA sobre o fecho REAL do storymap-ui — o artefato OSS está limpo de copyleft-forte HOJE", () => {
    // O produtor: este é o teste que o merge gate roda a cada integração. Uma dependência copyleft-forte
    // nova entrando no fecho fica vermelha AQUI, antes da publicação, e não depois.
    const out = execFileSync(process.execPath, [GATE, "--pkg", "packages/storymap-ui", "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    const v = JSON.parse(out);
    expect(v.blocking, `copyleft-forte ou pacote sem licença no fecho: ${JSON.stringify(v.blocking)}`).toEqual([]);
    expect(v.scanned).toBeGreaterThan(600);
  });
});
