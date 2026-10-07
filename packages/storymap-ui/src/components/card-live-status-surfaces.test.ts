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

  // O card por funcionalidade (fase 1) desenha a linha no SEU desenho (a mensagem ao vivo de quem roda, o motivo do
  // erro, o rodapé quieto), mas a frase continua saindo da MESMA régua, e o estado que pinta o card também: o Kanban
  // calcula as linhas do board uma vez e reduz cada uma ao estado do desenho — nunca um palpite por status.
  it("o card do Kanban mostra a linha e pinta o estado pela MESMA régua", () => {
    const k = src("./kanban/FeatureCard.tsx");
    expect(k).toMatch(/const live = useCardLiveStatus\(config\.id, card, config\)/);
    expect(k).toMatch(/const message = live \? \(live\.note \?\? live\.label\) : "";/);
    const board = src("./KanbanBoard.tsx");
    expect(board).toMatch(/const live = useBoardLiveStatuses\(config\.id, stories, config, ownerMap\)/);
    expect(board).toMatch(/live: l \? \{ kind: l\.kind, presence: l\.presence \} : null/);
    expect(board).toMatch(/<BoardLiveProvider value=\{live\}>/);
  });

  it("o selo de execução velho saiu do card — «Terminou» de uma execução antiga não é estado atual", () => {
    const k = src("./kanban/FeatureCard.tsx");
    expect(k).not.toMatch(/<RunSubstateBadge/);
    expect(k).not.toMatch(/<CardIdleDiffBadge/);
  });

  // A linha de Acompanhar (InboxList, com a linha de estado do card) saiu na fase 3: «Os agentes estão cuidando» mostra
  // cada item no formato curto — o que acontece e QUEM CUIDA (decision.next, o mesmo modelo que alimenta a linha do
  // card). A garantia «quem age agora, sem botão» segue lá; a da página do card fica aqui.
  it("o cabeçalho da página do card usa a linha de estado; «Os agentes estão cuidando» diz quem cuida de cada item", () => {
    expect(src("./CardDocument.tsx")).toMatch(/<CardLiveStatusLine boardId=\{boardId\} card=\{card\} config=\{config\} variant="header"/);
    const item = src("./inbox/InboxItem.tsx");
    const short = item.slice(item.indexOf('if (variant === "short")'), item.indexOf("// ── a anatomia inteira"));
    expect(short).toMatch(/\{d\.next\.label\}/);
    expect(short).toMatch(/d\.options\.filter\(isUndoLike\)/);
  });

  // Os ÍCONES do card antigo (Histórico · Mover · Rodar · Console, no RunnerStatusProvider) saíram com ele na fase 1. A
  // garantia que eles davam — o dono sabe o que cada botão faz — vale para o card novo: o único ícone (o chevron) tem
  // nome e diz se está aberto, e as ações são TEXTO por extenso no menu (as palavras moram em kanban-copy.ts).
  it("os botões do card têm NOME (o dono não sabia o que eram os três ícones)", () => {
    const k = src("./kanban/FeatureCard.tsx");
    expect(k).toMatch(/title="Ações"/);
    // o nome do card sem a etiqueta de máquina do começo (display-title.ts) — o leitor de tela lê o que a tela mostra
    expect(k).toMatch(/aria-label=\{`Ações do card \$\{displayTitle\(card\.title\)\}`\}/);
    expect(k).toMatch(/aria-expanded=\{menuOpen\}/);
    expect(k).toMatch(/\{m\.label\}/);
    const p = src("./RunnerStatusProvider.tsx");
    expect(p).not.toMatch(/export function (KanbanCardHistoryButton|KanbanCardRunButton|KanbanCardConsoleButton|MoveToPopover)\b/);
  });

  it("«Rodar» some quando outro ator já está no card (conduzido, rodando, na fila do condutor, integração)", () => {
    const k = src("./kanban/FeatureCard.tsx");
    expect(k).toMatch(/const busy = isConducted\(card\) \|\| state === "waiting" \|\| state === "delivering";/);
    // rodando: só «Parar o condutor» (e só no conduzido); fora disso «Rodar» exige gatilho e ninguém no card
    expect(k).toMatch(/const runItem = running\s*\? isConducted\(card\)/);
    expect(k).toMatch(/: hasTrigger && !busy && !organizeOnly/);
  });
});
