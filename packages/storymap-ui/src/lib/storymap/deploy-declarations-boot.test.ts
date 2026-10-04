import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootDeployPreflight, DEPLOY_DECLARED_CHECK_IDS, resetDeployPreflightForTest, startDeployPreflightInBackground } from "./deploy-declarations-boot";
import { deployDeclarationsProbe, runPreflight, type DeployDeclarationsProbe } from "./preflight";

// O boot do serviço passa a medir o deploy declarado (o que o boot empacotado não mede, por não importar a config).
// Fixtures inventadas: um lançador `relay` e um board de estufa.

const policy = (launchers: string[]) => ({ launchers, recipeRunners: new Set<string>(), recipes: ["push-app"] });
const probe = (launchers: string[], boardCmd?: string): DeployDeclarationsProbe =>
  deployDeclarationsProbe({ policy: policy(launchers), argvs: [["relay", "push-app", "{target}"]] }, boardCmd ? [{ id: "estufa", deploy: { kind: "command", command: boardCmd } }] : []);

function rodar(measure: () => Promise<DeployDeclarationsProbe | null>) {
  const logs: string[] = [];
  const warns: string[] = [];
  return bootDeployPreflight({ measure, runPreflight, repoRoot: null, env: { PATH: "/usr/bin:/bin" }, log: (l) => logs.push(l), warn: (l) => warns.push(l) }).then((checks) => ({ checks, logs, warns }));
}

describe("bootDeployPreflight — o deploy declarado medido no boot do serviço", () => {
  it("tudo passa ⇒ UMA linha de OK que diz o que mediu (prova de que rodou), só os dois checks do deploy", async () => {
    const r = await rodar(async () => probe(["relay"], "relay push-app estufa"));
    expect(r.checks.map((c) => c.id).sort()).toEqual([...DEPLOY_DECLARED_CHECK_IDS].sort());
    expect(r.warns).toEqual([]);
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toMatch(/^\[harness-boot\] preflight do deploy declarado: OK — /);
    expect(r.logs[0]).toContain("deploy.declared-commands");
  });

  it("um comando de board que a política recusaria ⇒ aviso com o medido e o conserto, sem derrubar nada", async () => {
    const r = await rodar(async () => probe([], "relay push-app estufa"));
    const declarado = r.checks.find((c) => c.id === "deploy.declared-commands");
    expect(declarado?.status).toBe("degraded");
    expect(r.logs).toEqual([]);
    expect(r.warns).toHaveLength(1);
    expect(r.warns[0]).toMatch(/pedem atenção/);
    expect(r.warns[0]).toMatch(/conserto: /);
    expect(r.warns[0]).toMatch(/NÃO impede o boot/);
  });

  it("config ilegível ⇒ «não medido» (unknown), nunca OK", async () => {
    const r = await rodar(async () => null);
    expect(r.checks.find((c) => c.id === "deploy.declared-commands")?.status).toBe("unknown");
    expect(r.logs).toEqual([]);
    expect(r.warns[0]).toMatch(/não medido/);
  });

  it("a medição que lança não escapa: vira um aviso e lista vazia", async () => {
    const r = await rodar(async () => {
      throw new Error("disco sumiu");
    });
    expect(r.checks).toEqual([]);
    expect(r.warns[0]).toMatch(/não pôde rodar: disco sumiu/);
  });

  it("o boot do serviço dispara a passada em segundo plano (sem await) e o resource do MCP usa a MESMA medição", () => {
    const src = (f: string) => readFileSync(path.join(__dirname, "..", "..", f), "utf8");
    expect(src("instrumentation.ts")).toMatch(/void import\("@\/lib\/storymap\/deploy-declarations-boot"\)\s*\.then\(\(m\) => m\.startDeployPreflightInBackground\(\)\)/);
    expect(src("lib/storymap/mcp/resources.ts")).toMatch(/await measureDeployDeclarations\(\)/);
  });
});

describe("startDeployPreflightInBackground — não segura o boot, não propaga erro, roda uma vez", () => {
  afterEach(() => resetDeployPreflightForTest());
  const base = { runPreflight, repoRoot: null, env: { PATH: "/usr/bin" }, log: () => {}, warn: () => {} };

  it("devolve na hora: a medição ainda não terminou quando a chamada retorna", async () => {
    let release!: (v: DeployDeclarationsProbe | null) => void;
    const pending = new Promise<DeployDeclarationsProbe | null>((r) => (release = r));
    let done = false;
    const p = startDeployPreflightInBackground({ ...base, measure: () => pending });
    void p.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    release(probe(["relay"]));
    expect((await p).map((c) => c.id).sort()).toEqual([...DEPLOY_DECLARED_CHECK_IDS].sort());
  });

  it("um erro da passada vira aviso e lista vazia — a Promise nunca rejeita", async () => {
    const warns: string[] = [];
    const p = startDeployPreflightInBackground({ ...base, warn: (l) => warns.push(l), runPreflight: () => { throw new Error("relatório quebrou"); }, measure: async () => probe(["relay"]) });
    await expect(p).resolves.toEqual([]);
    expect(warns.join("\n")).toMatch(/relatório quebrou/);
  });

  it("nem uma falha FORA da passada (o próprio aviso quebrando) escapa: a Promise resolve vazia", async () => {
    const warns: string[] = [];
    let first = true;
    const warn = (l: string) => {
      if (first) {
        first = false;
        throw new Error("o log caiu");
      }
      warns.push(l);
    };
    const p = startDeployPreflightInBackground({ ...base, warn, runPreflight: () => { throw new Error("relatório quebrou"); }, measure: async () => probe(["relay"]) });
    await expect(p).resolves.toEqual([]);
    expect(warns.join("\n")).toMatch(/o log caiu/);
  });

  it("uma vez por processo: a segunda chamada devolve a MESMA passada e não mede de novo", async () => {
    let medicoes = 0;
    const measure = async () => {
      medicoes++;
      return probe(["relay"]);
    };
    const a = startDeployPreflightInBackground({ ...base, measure });
    const b = startDeployPreflightInBackground({ ...base, measure });
    expect(b).toBe(a);
    await a;
    expect(medicoes).toBe(1);
  });
});
