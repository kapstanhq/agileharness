import { describe, expect, it } from "vitest";
import { anchorHandleLabel, featureAnchorSkipsApproval } from "./handle-scope";

// Decisão do dono (07/10): a âncora pendurar o card numa funcionalidade é organização — passa sem a aprovação do board.
// Só `update_card` com `{ feature }` (e os ids); qualquer outro campo, outra tool ou outra credencial segue a regra.
const anchor = { credentialLabel: anchorHandleLabel("demo") };

describe("featureAnchorSkipsApproval", () => {
  it("update_card só com feature, pela credencial da âncora: livre", () => {
    expect(featureAnchorSkipsApproval("update_card", anchor, { board: "demo", cardId: "story-ex9701", feature: "lista" })).toBe(true);
  });

  it("qualquer campo além de feature volta à regra do board", () => {
    expect(featureAnchorSkipsApproval("update_card", anchor, { board: "demo", cardId: "story-ex9701", feature: "lista", title: "x" })).toBe(false);
    expect(featureAnchorSkipsApproval("update_card", anchor, { board: "demo", cardId: "story-ex9701" })).toBe(false);
  });

  it("outras tools da âncora e outras credenciais seguem a regra do board", () => {
    expect(featureAnchorSkipsApproval("propose_change", anchor, { board: "demo", feature: "lista" })).toBe(false);
    expect(featureAnchorSkipsApproval("update_card", { credentialLabel: "conductor:demo" }, { board: "demo", cardId: "story-ex9701", feature: "lista" })).toBe(false);
    expect(featureAnchorSkipsApproval("update_card", null, { feature: "lista" })).toBe(false);
  });
});
