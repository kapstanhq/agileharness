// A POLÍTICA DE RELEASE — a única declaração de quem publica um board.
//
// O que estes testes trancam é um defeito de MODELAGEM, não um bug pontual: `publishQueue.boards`
// respondia duas perguntas ("pode publicar?" e "publica sozinho?") com uma flag só, e desligá-la
// tirava as duas. Trabalho de sessão do `acme` ficou 6 dias em `stage` sem NADA capaz de movê-lo —
// não porque um humano precisava decidir, mas porque a flag que daria o botão ao humano era a mesma
// que tirava o humano do caminho.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RELEASE_MODE,
  DEPLOY_STEP_ID,
  deployStepAutorun,
  mayRequestPublish,
  publishRefusalReason,
  publishesItself,
  releaseModeOf,
  shouldAutoEnqueue,
  withDerivedDeployAutorun,
} from "./release-policy";
import type { StatusDef } from "./types";

describe("releaseModeOf — o default é seguro, não conveniente", () => {
  it("board sem declaração cai em `manual`", () => {
    // Um board que ainda não declarou política NÃO pode começar publicando em produção sozinho.
    expect(DEFAULT_RELEASE_MODE).toBe("manual");
    expect(releaseModeOf(null)).toBe("manual");
    expect(releaseModeOf(undefined)).toBe("manual");
    expect(releaseModeOf({})).toBe("manual");
  });

  it("lê o que o board declarou", () => {
    expect(releaseModeOf({ release: { mode: "auto" } })).toBe("auto");
    expect(releaseModeOf({ release: { mode: "manual" } })).toBe("manual");
  });

  it("valor inválido cai no default em vez de virar um terceiro modo", () => {
    expect(releaseModeOf({ release: { mode: "sim" } } as never)).toBe("manual");
  });
});

describe("as duas perguntas são independentes", () => {
  it("PODE publicar não depende do modo do board", () => {
    // O coração da correção. Se algum dia isto passar a olhar o modo, o `acme` volta a ficar preso.
    const machinery = { queueEnabled: true, stagingEnabled: true };
    expect(mayRequestPublish(machinery)).toBe(true);
    // …e a função nem recebe o board/modo: a independência é estrutural, não uma convenção.
    expect(mayRequestPublish.length).toBe(1);
  });

  it("PUBLICA SOZINHO depende só do modo", () => {
    expect(publishesItself("auto")).toBe(true);
    expect(publishesItself("manual")).toBe(false);
  });

  it("o kill-switch global e o staging derrubam a permissão — e dizem qual dos dois", () => {
    expect(mayRequestPublish({ queueEnabled: false, stagingEnabled: true })).toBe(false);
    expect(publishRefusalReason({ queueEnabled: false, stagingEnabled: true })).toContain("publishQueue.enabled");
    expect(mayRequestPublish({ queueEnabled: true, stagingEnabled: false })).toBe(false);
    expect(publishRefusalReason({ queueEnabled: true, stagingEnabled: false })).toContain("staging");
    expect(publishRefusalReason({ queueEnabled: true, stagingEnabled: true })).toBeNull();
  });
});

describe("withDerivedDeployAutorun — o passo Publicar não tem opinião própria", () => {
  const steps = (autorun: boolean): StatusDef[] =>
    [
      { id: "desenvolver", name: "Desenvolver", autorun: true },
      { id: DEPLOY_STEP_ID, name: "Publicar", autorun, onEnter: "promote-and-deploy" },
    ] as never;

  it("`auto` faz o passo avançar sozinho; `manual` o mantém parado", () => {
    expect(withDerivedDeployAutorun(steps(false), "auto").find((s) => s.id === DEPLOY_STEP_ID)?.autorun).toBe(true);
    expect(withDerivedDeployAutorun(steps(true), "manual").find((s) => s.id === DEPLOY_STEP_ID)?.autorun).toBe(false);
    expect(deployStepAutorun("auto")).toBe(true);
    expect(deployStepAutorun("manual")).toBe(false);
  });

  it("SOBRESCREVE o que o board tiver autorado — é isto que impede a segunda verdade", () => {
    // Um board que declare `autorun: true` no passo e `release.mode: manual` estaria dizendo duas
    // coisas contrárias sobre o mesmo ato. O runtime fica com UMA; o lint reprova a autoria.
    const out = withDerivedDeployAutorun(steps(true), "manual");
    expect(out.find((s) => s.id === DEPLOY_STEP_ID)?.autorun).toBe(false);
  });

  it("não toca nos outros passos nem muta a lista recebida", () => {
    const input = steps(false);
    const out = withDerivedDeployAutorun(input, "auto");
    expect(out.find((s) => s.id === "desenvolver")?.autorun).toBe(true);
    expect(input.find((s) => s.id === DEPLOY_STEP_ID)?.autorun).toBe(false); // original intacto
    expect(out).not.toBe(input);
  });

  it("lista sem o passo `deploy` passa inalterada (board com pipeline próprio)", () => {
    const own = [{ id: "revisao", name: "Revisão" }] as never as StatusDef[];
    expect(withDerivedDeployAutorun(own, "auto")).toEqual(own);
  });
});

describe("shouldAutoEnqueue — o produtor do modo `auto`", () => {
  const base = { mode: "auto" as const, stagedTotal: 3, hasOpenRequest: false };

  it("pede quando há trabalho staged e o board publica sozinho", () => {
    expect(shouldAutoEnqueue(base)).toBe(true);
  });

  it("nunca pede por um board `manual` — é o que preserva o portão humano", () => {
    expect(shouldAutoEnqueue({ ...base, mode: "manual" })).toBe(false);
  });

  it("não pede sem trabalho staged nem com pedido já aberto", () => {
    // Nível em vez de borda só é seguro por causa destas duas guardas: sem elas, um tick a cada
    // batida viraria enxame de pedidos supersedendo uns aos outros.
    expect(shouldAutoEnqueue({ ...base, stagedTotal: 0 })).toBe(false);
    expect(shouldAutoEnqueue({ ...base, hasOpenRequest: true })).toBe(false);
  });
});
