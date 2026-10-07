import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// O «…» da página do card e o «Mover para» abrem por hover E por clique. No toque o hover é EMULADO e chega antes do
// clique: com `onMouseEnter` + clique que alterna, o painel abria e fechava no mesmo toque (v0.15.0 a 390: «Parar
// condutor» e «Devolver ao fluxo» inalcançáveis). O contrato: hover só do mouse, e o clique confirma o que o hover abriu.
// Rig sem DOM: afirmado contra o fonte (a composição do JSX é o contrato).
const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("popover de hover + clique", () => {
  it("o hook só abre/fecha por hover com o MOUSE e o clique não fecha o que o hover acabou de abrir", () => {
    const nav = src("./NavShell.tsx");
    expect(nav).toMatch(/const hoverOpen = \(e: ReactPointerEvent\) => \{\s*if \(e\.pointerType === "mouse"\) openNow\(\);/);
    expect(nav).toMatch(/const hoverClose = \(e: ReactPointerEvent\) => \{\s*if \(e\.pointerType === "mouse"\) closeSoon\(\);/);
    expect(nav).toMatch(/setOpen\(\(o\) => \(o && keep \? true : !o\)\)/);
  });

  for (const [file, name] of [["../doc/DocShell.tsx", "overflow"], ["../card/CardMoveMenu.tsx", "menu"]] as const) {
    it(`${file}: gatilho com hover de ponteiro filtrado e clique pelo toggle`, () => {
      const s = src(file);
      expect(s).toContain(`onPointerEnter={${name}.hoverOpen}`);
      expect(s).toContain(`onPointerLeave={${name}.hoverClose}`);
      expect(s).toContain(`onClick={${name}.toggle}`);
      expect(s).not.toContain(`onMouseEnter={${name}.openNow}`);
    });
  }
});
