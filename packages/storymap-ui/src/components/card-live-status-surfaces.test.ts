import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A LINHA DE ESTADO do card é UMA régua (lib/storymap/card-live-status.ts) desenhada por UM componente
// (CardLiveStatus.tsx), e as três superfícies que o dono lê a usam — o card do Kanban, o cabeçalho da página do card e
// a linha de «Acompanhar» do Inbox. O rig de teste é node sem DOM (ver kanban-card-footer.test.ts), então o contrato é
// afirmado contra o fonte, como os vizinhos.
const src = (rel: string) => {
  const p = fileURLToPath(new URL(rel, import.meta.url));
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};

describe("a linha de estado do card — uma régua, três superfícies", () => {
  it("o componente existe e pergunta à régua pura (nunca decide o texto sozinho)", () => {
    const c = src("./CardLiveStatus.tsx");
    expect(c).toMatch(/projectCardLiveStatus\(/);
    expect(c).toMatch(/cardLiveFactsFor\(/);
    expect(c).toMatch(/cardLiveText\(status, now, timeZone\)/);
    // a hora é a do DONO (OwnerTimeZone), nunca a do navegador
    expect(c).toMatch(/useOwnerTimeZone\(\)/);
  });

  it("o card do Kanban mostra a linha e pinta o filete pela MESMA presença", () => {
    const k = src("./KanbanCard.tsx");
    expect(k).toMatch(/const live = useCardLiveStatus\(config\.id, card, config\)/);
    expect(k).toMatch(/<CardLiveStatusLine boardId=\{config\.id\} card=\{card\} config=\{config\} status=\{live\}/);
    // O filete sai da PRESENÇA (presence-tone.ts), a mesma cor do nav — o «tom» próprio da linha saiu.
    expect(k).toMatch(/cardLiveRail\(live\)/);
  });

  it("o selo de execução velho saiu do card — «Terminou» de uma execução antiga não é estado atual", () => {
    const k = src("./KanbanCard.tsx");
    expect(k).not.toMatch(/<RunSubstateBadge/);
    expect(k).not.toMatch(/<CardIdleDiffBadge/);
  });

  it("o cabeçalho da página do card e a linha de Acompanhar usam a mesma linha", () => {
    expect(src("./CardDocument.tsx")).toMatch(/<CardLiveStatusLine boardId=\{boardId\} card=\{card\} config=\{config\} variant="header"/);
    const list = src("./inbox/InboxList.tsx");
    expect(list).toMatch(/sectionLabel === "Acompanhar"/);
    expect(list).toMatch(/<CardLiveStatusLine [^>]*variant="row"/);
  });

  it("os botões do card têm NOME visível e aria-label (o dono não sabia o que eram os três ícones)", () => {
    const p = src("./RunnerStatusProvider.tsx");
    for (const [label, aria] of [
      ["Histórico", "Ver o histórico do card"],
      ["Mover", "Mover o card para outra etapa"],
      ["Rodar", "Rodar o agente desta etapa"],
      ["Console", "Abrir o console da execução"],
    ]) {
      expect(p, label).toMatch(new RegExp(`<span>${label}</span>`));
      expect(p, aria).toMatch(new RegExp(`aria-label="${aria}"`));
    }
  });

  it("«Rodar» some quando outro ator já está no card (conduzido, sessão viva, fila, integração)", () => {
    const k = src("./KanbanCard.tsx");
    expect(k).toMatch(/isConducted\(card\)/);
    expect(k).toMatch(/<KanbanCardRunButton [^>]*busy=\{busy\}/);
    expect(src("./RunnerStatusProvider.tsx")).toMatch(/if \(!hasTrigger \|\| busy\) return null;/);
  });
});
