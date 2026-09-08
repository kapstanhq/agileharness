import { describe, expect, it } from "vitest";
import { boardForTmux, classifyTmux, fleetBoardByTmux, operatorLabel } from "./processes";
import { servesBoard } from "./types";
import type { TerminalPrefs } from "../terminal/prefs-store";

// Regression: the home Terminais panel + /processes showed the name-derived label (raw tmux name or
// the generic "Shell (bash)"), IGNORING the alias the operator set on the /terminal page. These pin
// that the operator's real name wins — the SAME precedence the terminal picker's deriveLabel uses.

describe("operatorLabel — o nome real do operador vence o rótulo derivado", () => {
  const prefs: TerminalPrefs = {
    shell: { alias: "Feedback visual" },
    "teminal-upgrade": { alias: "quick wins de performance" },
    blank: { alias: "   " }, // só espaços — não conta como apelido
  };

  it("o apelido vence o rótulo genérico de um `shell`", () => {
    expect(operatorLabel("Shell (bash)", "shell", prefs)).toBe("Feedback visual");
  });

  it("o apelido vence o nome cru de uma sessão ad-hoc", () => {
    expect(operatorLabel("teminal-upgrade", "teminal-upgrade", prefs)).toBe("quick wins de performance");
  });

  it("sem apelido, o rótulo derivado permanece", () => {
    expect(operatorLabel("Claude master (interativo)", "claude-jonatas", prefs)).toBe(
      "Claude master (interativo)",
    );
  });

  it("uma linha sem sessão tmux (run headless) mantém o rótulo derivado", () => {
    expect(operatorLabel("sincronizar · Comprar", undefined, prefs)).toBe("sincronizar · Comprar");
  });

  it("um apelido só de espaços é ignorado (fica com o derivado)", () => {
    expect(operatorLabel("Terminal · x", "blank", prefs)).toBe("Terminal · x");
  });

  it("prefs vazio nunca altera o rótulo", () => {
    expect(operatorLabel("Shell (bash)", "shell", {})).toBe("Shell (bash)");
  });
});

// O bloco Terminais da home mostrava a MÁQUINA inteira: com N boards no mesmo host, o operador via
// terminal de board alheio sem ter como atribuí-lo. Estas fixam as DUAS metades do conserto — de
// onde vem o board de uma linha, e quem passa no recorte.

describe("fleetBoardByTmux — o board de uma sessão da frota chega à linha do terminal", () => {
  it("indexa por nome de tmux a sessão que tem board", () => {
    const idx = fleetBoardByTmux([
      { tmuxSession: "agent-a91f", board: "acme" },
      { tmuxSession: "agent-7c2d", board: "storymap" },
    ]);
    expect(idx.get("agent-a91f")).toBe("acme");
    expect(idx.get("agent-7c2d")).toBe("storymap");
  });

  it("ignora sessão SEM board (self-dev) — nunca vira chave vazia", () => {
    const idx = fleetBoardByTmux([{ tmuxSession: "agent-0000" }, { board: "acme" }]);
    expect(idx.size).toBe(0);
  });

  it("o nome `card-<board>__<card>` já resolve sozinho — a frota é o fallback, não a fonte", () => {
    expect(classifyTmux("card-acme__story-4k2p").board).toBe("acme");
    expect(classifyTmux("agent-a91f").board).toBeUndefined();
  });
});

describe("servesBoard — a régua ESTRITA da home (sem board ⇒ fora)", () => {
  it("aceita a linha do próprio board", () => {
    expect(servesBoard({ board: "acme" }, "acme")).toBe(true);
  });

  it("recusa a linha de outro board — era o vazamento", () => {
    expect(servesBoard({ board: "storymap" }, "acme")).toBe(false);
  });

  it("recusa o trabalho SEM board (master, shell, cop-*, sessão sem card)", () => {
    expect(servesBoard({}, "acme")).toBe(false);
    expect(servesBoard({ board: undefined }, "acme")).toBe(false);
  });

  it("board vazio não casa com boardId vazio (não existe recorte sem nome)", () => {
    expect(servesBoard({ board: "" }, "")).toBe(false);
  });
});

describe("boardForTmux — a estrutura vence a preferência; o manual só preenche o vazio", () => {
  // O DEFEITO original: um tmux aberto à mão (`shell`, `term-2`, `term-3`) não ganhava board por
  // NENHUM caminho, então `servesBoard` o excluía da home de todos os boards — e não havia alavanca.
  // O vínculo manual é essa alavanca, mas ele NÃO pode contradizer um vínculo estrutural.
  const fleet = new Map([["agent-a91f", "acme"]]);
  const prefs: TerminalPrefs = {
    "card-acme__story-4k2p": { board: "quartz" }, // tentativa de reapontar um card
    "agent-a91f": { board: "quartz" }, //            tentativa de reapontar uma sessão da frota
    "term-2": { board: "storymap" }, //                o caso legítimo
    vazio: { board: "   " }, //                        só espaços — não conta como vínculo
  };

  it("o nome do card vence tudo — reapontá-lo faria a home de um board listar o card de outro", () => {
    expect(boardForTmux("card-acme__story-4k2p", "acme", fleet, prefs)).toEqual({
      board: "acme",
      boardSource: "card",
    });
  });

  it("a frota vence o manual — o claim é estrutural", () => {
    expect(boardForTmux("agent-a91f", undefined, fleet, prefs)).toEqual({
      board: "acme",
      boardSource: "fleet",
    });
  });

  it("sem board estrutural, o vínculo do operador vale — é o conserto do terminal invisível", () => {
    expect(boardForTmux("term-2", undefined, fleet, prefs)).toEqual({
      board: "storymap",
      boardSource: "manual",
    });
  });

  it("sem nenhuma das três fontes, não há board (e a origem também some)", () => {
    expect(boardForTmux("shell", undefined, fleet, prefs)).toEqual({});
    expect(boardForTmux("vazio", undefined, fleet, prefs)).toEqual({});
  });
});
