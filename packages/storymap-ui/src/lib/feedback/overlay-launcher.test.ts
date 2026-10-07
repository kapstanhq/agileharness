import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FEEDBACK_TOGGLE_EVENT, HOST_LAUNCHER, feedbackOverlayReady, toggleFeedbackMarking } from "./overlay-launcher";

// A porta do «Marcar ajuste» saiu da pílula flutuante (que pousava em cima do card da Triagem) para o menu da
// engrenagem. O contrato tem duas pontas que não se importam uma à outra — o overlay é vanilla em public/ — então o
// teste confere o MESMO nome de evento e o MESMO valor de `launcher` nas duas, e o caminho até o item do menu.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const overlay = read("../../../public/ah-overlay.js");
const layout = read("../../app/layout.tsx");
const settings = read("../../components/shell/SettingsMenu.tsx");
const menu = read("../../components/nav/BoardMenu.tsx");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a ponte app → overlay", () => {
  it("disparar a marcação emite o evento na window; sem window (servidor), é no-op", () => {
    expect(() => toggleFeedbackMarking()).not.toThrow();
    const win = new EventTarget();
    vi.stubGlobal("window", win);
    const heard = vi.fn();
    win.addEventListener(FEEDBACK_TOGGLE_EVENT, heard);
    toggleFeedbackMarking();
    expect(heard).toHaveBeenCalledTimes(1);
  });
  it("o item só existe com o overlay montado (a marca que o próprio script põe na window)", () => {
    expect(feedbackOverlayReady()).toBe(false);
    vi.stubGlobal("window", {});
    expect(feedbackOverlayReady()).toBe(false);
    vi.stubGlobal("window", { __AH_OVERLAY_MOUNTED__: true });
    expect(feedbackOverlayReady()).toBe(true);
    expect(overlay).toContain("window.__AH_OVERLAY_MOUNTED__ = true;");
  });
});

describe("o overlay obedece ao `launcher` do host", () => {
  it("escuta o MESMO evento e alterna a marcação, como a pílula", () => {
    expect(overlay).toContain(`var TOGGLE_EVENT = "${FEEDBACK_TOGGLE_EVENT}";`);
    expect(overlay).toMatch(/window\.addEventListener\(TOGGLE_EVENT, function \(\) \{[\s\S]{0,160}setPicking\(!picking\);/);
  });
  it("com `launcher: \"host\"` a pílula some em repouso e volta durante a marcação (o «Parar») ou com anotações", () => {
    expect(overlay).toContain(`var hostLauncher = cfg.launcher === "${HOST_LAUNCHER}";`);
    expect(overlay).toContain('".ah-bar.ah-idle{display:none}"');
    expect(overlay).toContain('bar.classList.toggle("ah-idle", hostLauncher && !picking && !pins.length);');
    // e a pílula continua sendo o PADRÃO para quem embute o overlay sem dizer nada (o embed do produto)
    expect(overlay).not.toMatch(/cfg\.launcher !== "button"/);
  });
  it("o layout do AgileHarness reivindica a porta", () => {
    expect(layout).toContain("launcher: HOST_LAUNCHER,");
  });
});

describe("a porta nova: o item da engrenagem", () => {
  it("o BoardMenu mostra «Marcar ajuste» só quando recebe a ação", () => {
    expect(menu).toMatch(/onMarkAdjust\?: \(\) => void;/);
    expect(menu).toMatch(/\{onMarkAdjust && \(\s*<MenuAction\s*icon=\{SquareDashedMousePointer\}\s*label="Marcar ajuste"[\s\S]{0,160}onClick=\{onMarkAdjust\}/);
  });
  it("a engrenagem liga o item ao overlay montado: fecha o menu e dispara a marcação", () => {
    expect(settings).toMatch(/onMarkAdjust=\{\s*feedbackOverlayReady\(\)\s*\? \(\) => \{\s*setOpen\(false\);\s*toggleFeedbackMarking\(\);\s*\}\s*: undefined\s*\}/);
  });
});

describe("durante a marcação o «Parar» fica alcançável", () => {
  it("o painel, o chip minimizado e o aviso empilham ACIMA da pílula (que fica acima do rodapé do host), nunca por cima dela", () => {
    const above = "bottom:calc(60px + var(--ah-bottom-reserve, 0px) + env(safe-area-inset-bottom, 0px))";
    for (const cls of [".ah-panel", ".ah-min", ".ah-notice"]) expect(overlay).toContain(`"${cls}{position:fixed;left:16px;${above}`);
    expect(overlay).not.toMatch(/left:16px;bottom:60px/);
  });
});
