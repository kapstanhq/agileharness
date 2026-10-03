import { describe, expect, it } from "vitest";
import { failureOrigin, nextRunDeathRepeats, noOpVariant, runDeathRepeats, runDeathTitle, toolSignature } from "./failure-origin";
import SANDBOX_DENIED from "./__fixtures__/sandbox-denied-finaltexts.json";

// A régua «de quem é esta falha»: da FERRAMENTA (sandbox, binário, host) — nunca do dono — ou do PRODUTO.

describe("failureOrigin — assinaturas da ferramenta", () => {
  it("os 4 textos finais de um no-op repetido (sandbox sem Bash) ⇒ ferramenta, com a MESMA assinatura", () => {
    const verdicts = SANDBOX_DENIED.map((r) => failureOrigin({ text: r.finalText }));
    for (const v of verdicts) {
      expect(v.origin).toBe("tool");
      expect(v.signature).toBe("sandbox-seccomp/permission-denied");
      expect(v.excerpt).toMatch(/apply-seccomp/);
    }
    // «...» num run e «…» no outro: a chave de dedup é a mesma
    expect(new Set(verdicts.map((v) => v.hash)).size).toBe(1);
    expect(verdicts[0].hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("seccomp/setgroups, userns aninhado, bwrap, ENOENT do claude, EACCES do sandbox e a postura recusada ⇒ ferramenta", () => {
    const cases: Array<[string, string]> = [
      ["apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted)", "sandbox-seccomp/"],
      ["echo deny > /proc/self/setgroups: Permission denied", "sandbox-setgroups/permission-denied"],
      ["the nested user namespace is restricted on this host", "sandbox-userns/"],
      ["bwrap: setting up uid map: Permission denied", "sandbox-bwrap/permission-denied"],
      ["Error: spawn claude ENOENT", "claude-enoent/enoent"],
      ["Error: spawn /root/.local/bin/claude ENOENT", "claude-enoent/enoent"],
      ["sandbox: open /tmp/x EACCES", "sandbox-eacces/eacces"],
      ["autonomia sem contencao recusada: sandbox exigido e indisponível", "posture-refused/"],
    ];
    for (const [text, sig] of cases) {
      const v = failureOrigin({ text });
      expect(v.origin, text).toBe("tool");
      expect(v.signature, text).toContain(sig);
      expect(v.label, text).toBeTruthy();
    }
  });

  // Depois da sonda do Bash contido (autonomy-sandbox.ts), este host REBAIXA o run full para write SEM shell: o passo
  // que avança por Bash termina em no-op e o texto final já não traz «apply-seccomp». O aviso da postura é a evidência.
  it("o aviso da postura REBAIXADA (o run rodou sem shell) ⇒ ferramenta, nas duas causas do rebaixamento", () => {
    const host =
      "REBAIXADO full → write: o bubblewrap sobe, mas o Bash do agente não roda dentro dele: o passo de seccomp do CLI cria um user " +
      "namespace aninhado e o kernel o recusa (sh: 1: cannot create /proc/self/setgroups: Permission denied) — tipicamente a restrição";
    const off = "REBAIXADO full → write porque AGILEHARNESS_SANDBOX_MODE=off foi declarado (o sandbox deste host está DISPONÍVEL: ok).";
    for (const text of [host, off]) {
      const v = failureOrigin({ text, failureClass: "app" });
      expect(v.origin, text).toBe("tool");
      expect(v.signature, text).toMatch(/^posture-no-shell\//);
      expect(v.label, text).toMatch(/sem shell/);
    }
  });

  it("a assinatura vence a classe atribuída (o run-death antigo dizia «app» para o no-op do sandbox)", () => {
    expect(failureOrigin({ text: SANDBOX_DENIED[0].finalText, failureClass: "app" }).origin).toBe("tool");
  });

  it("um texto que só MENCIONA sandbox, sem falha dele, não é assinatura", () => {
    expect(toolSignature("Rodei a suíte dentro do sandbox e passou: 42 testes verdes.")).toBeNull();
    expect(toolSignature("")).toBeNull();
    expect(toolSignature(null)).toBeNull();
  });
});

describe("failureOrigin — classe atribuída e o classificador de mensagens", () => {
  // CONTRATO MUDADO DE PROPÓSITO (revisão do contrato). Antes: `infra` sem assinatura ⇒ `tool`, e `tool` passa por
  // cima do modo do board (decision-class.ts). Mas o carimbo do run-death põe `infra` em TODO `error`/`oom-killed` — o
  // teto de max-turns, a OOM por contenção, o «API Error 529», o lock do worktree —, e nada disso é o sandbox/binário/
  // host que nenhuma resposta do dono conserta. Só uma ASSINATURA conhecida dá `tool`; o resto é `environment`, que
  // segue a régua normal do modo.
  it("infra SEM assinatura ⇒ ambiente (não ferramenta); app/test ⇒ produto", () => {
    expect(failureOrigin({ failureClass: "infra" })).toMatchObject({ origin: "environment", signature: null, hash: null });
    expect(failureOrigin({ text: "API Error: 529 Overloaded", failureClass: "infra" }).origin).toBe("environment");
    expect(failureOrigin({ text: "max-turns atingido 3× (teto 3) — card travado, escalando p/ o operador", failureClass: "infra" }).origin).toBe("environment");
    expect(failureOrigin({ failureClass: "app" }).origin).toBe("product");
    expect(failureOrigin({ failureClass: "test" }).origin).toBe("product");
  });

  it("teste vermelho no diff do card ⇒ produto", () => {
    expect(failureOrigin({ text: "expected 'Salvar' to be visible but it was not" }).origin).toBe("product");
    expect(failureOrigin({ criterionUnmet: true }).origin).toBe("product");
    expect(failureOrigin({ text: "strict mode violation: getByRole('button') resolved to 3 elements" }).origin).toBe("product");
  });

  // CONTRATO MUDADO DE PROPÓSITO (mesma razão acima): o ambiente quebrado do RUN (a stack do produto) não é a ferramenta.
  it("ambiente quebrado reconhecido pelo classificador (MODULE_NOT_FOUND, porta ocupada) ⇒ ambiente, não ferramenta", () => {
    expect(failureOrigin({ text: "Error: Cannot find module 'firebase-functions'" }).origin).toBe("environment");
    expect(failureOrigin({ text: "listen EADDRINUSE: address already in use :::3008" }).origin).toBe("environment");
  });

  it("classe já julgada como desconhecida (null) não é relida do texto; sem nada ⇒ desconhecida", () => {
    expect(failureOrigin({ text: "o run foi interrompido", failureClass: null }).origin).toBe("unknown");
    expect(failureOrigin({}).origin).toBe("unknown");
  });
});

describe("a repetição da morte — o formato do título, escrito e lido num lugar só", () => {
  it("1ª vez sem sufixo; da 2ª em diante, «Nª vez seguida»; a falha da ferramenta aparece no título", () => {
    expect(runDeathTitle("exit")).toBe("run morreu: exit");
    expect(runDeathTitle("no-op", { toolSignature: "sandbox-seccomp/permission-denied", repeats: 3 })).toBe(
      "run morreu: no-op · falha da ferramenta (sandbox-seccomp) · 3ª vez seguida",
    );
    expect(runDeathRepeats("run morreu: no-op · 3ª vez seguida")).toBe(3);
    expect(runDeathRepeats("run morreu: no-op")).toBe(1);
    expect(runDeathRepeats(undefined)).toBe(1);
  });

  it("a mesma morte soma; outra morte (motivo ou origem diferente) recomeça em 1", () => {
    const base = runDeathTitle("no-op", { toolSignature: "sandbox-seccomp/permission-denied" });
    expect(nextRunDeathRepeats(null, base)).toBe(1);
    expect(nextRunDeathRepeats(base, base)).toBe(2);
    expect(nextRunDeathRepeats(`${base} · 2ª vez seguida`, base)).toBe(3);
    expect(nextRunDeathRepeats(base, runDeathTitle("no-op"))).toBe(1);
    expect(nextRunDeathRepeats(runDeathTitle("exit"), runDeathTitle("no-op"))).toBe(1);
  });

  // Revisão do contrato: a chave era só motivo + assinatura. O diagnóstico de morte só fecha com um run de sucesso
  // (mover o card à mão não o fecha), então um no-op em «Especificar» num dia e um no-op de BUILD em «Desenvolver» dias
  // depois viravam «2ª vez seguida» — e o dono perdia a decisão com o motivo falso «o card igual».
  it("o PASSO e o TIPO de no-op entram na chave: outro passo, ou o no-op sem código, recomeça em 1", () => {
    expect(runDeathTitle("no-op", { step: "Especificar" })).toBe("run morreu: no-op em «Especificar»");
    expect(runDeathTitle("no-op", { step: "Desenvolver", variant: "sem código", repeats: 2 })).toBe("run morreu: no-op sem código em «Desenvolver» · 2ª vez seguida");
    const enrich = runDeathTitle("no-op", { step: "Especificar" });
    expect(nextRunDeathRepeats(enrich, enrich)).toBe(2);
    expect(nextRunDeathRepeats(enrich, runDeathTitle("no-op", { step: "Desenvolver" }))).toBe(1);
    expect(nextRunDeathRepeats(runDeathTitle("no-op", { step: "Desenvolver" }), runDeathTitle("no-op", { step: "Desenvolver", variant: "sem código" }))).toBe(1);
    // um diagnóstico antigo, sem o passo no título, nunca soma com um novo que o tem
    expect(nextRunDeathRepeats("run morreu: no-op", enrich)).toBe(1);
  });

  it("noOpVariant: o no-op de build (C2, nenhum artefato de código) é outro desfecho que o no-op de avanço", () => {
    expect(noOpVariant("no-op", "saída limpa mas o run não produziu NENHUM artefato de código (só storymap/boards/) — sucesso-fantasma de build (C2/O3.5)")).toBe("sem código");
    expect(noOpVariant("no-op", "saída limpa mas o card não avançou de enriquecer — sucesso-fantasma (no-op)")).toBeNull();
    expect(noOpVariant("exit", "NENHUM artefato de código")).toBeNull();
    expect(noOpVariant("no-op", null)).toBeNull();
  });
});
