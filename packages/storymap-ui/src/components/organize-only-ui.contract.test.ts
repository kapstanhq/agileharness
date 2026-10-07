import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Contrato de TELA do board «só organização»: nenhum controle que dispara execução aparece num board assim. O servidor
// já recusa (o portão e as guardas diretas), mas um botão que só sabe recusar é ruído — e foi visto um «Rodar» num card
// de board só de organização. Cada ponto abaixo é a porta de um disparo na tela; tirar o predicado dele reabre o botão.

const SRC = path.join(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

describe("board só de organização: a tela não oferece disparo de execução", () => {
  it("o «Rodar» do card (Kanban) só aparece fora do board só de organização", () => {
    // o card por funcionalidade (fase 1): «Rodar a etapa agora» / «Parar o condutor» só fora do board só de organização
    const card = read("components/kanban/FeatureCard.tsx");
    expect(card).toMatch(/const organizeOnly = isOrganizeOnly\(config\);/);
    expect(card).toMatch(/isConducted\(card\) && !organizeOnly/);
    expect(card).toMatch(/hasTrigger && !busy && !organizeOnly/);
    // O feed do Início (a 2ª porta deste botão) saiu com o Início na fase 1 — a porta não existe mais, então
    // não há predicado a guardar ali; prova-se a ausência para ela não voltar sem a guarda.
    expect(existsSync(path.join(SRC, "components/inicio/KanbanFeed.tsx"))).toBe(false);
  });

  it("o «Sincronizar» (roda um agente) some do menu do card e da página do card", () => {
    expect(read("components/kanban/FeatureCard.tsx")).toMatch(/\.\.\.\(!organizeOnly \? \[\{ label: ACTION_LABEL\.sync, draft: DRAFT\.sync \}\]/);
    expect(read("components/CardDocScreen.tsx")).toMatch(/isOrganizeOnly\(config\)\s*\n?\s*\? \[\]/);
    // O menu do card ANTIGO (KanbanCardActionsMenu, com o seu próprio «Sincronizar») saiu com o card antigo na fase 1 —
    // a porta não existe mais; prova-se a ausência para ela não voltar sem a guarda.
    expect(read("components/RunnerStatusProvider.tsx")).not.toMatch(/export function KanbanCardActionsMenu/);
  });

  // No quadro novo a coluna Entrega é o TREM (só leitura do merge train); o que espera FORA dele vira o card por
  // funcionalidade, cujo primário é a decisão do Inbox (o servidor a decide) — nenhum botão de passo é desenhado na tela.
  // A porta deixou de existir na tela inteira — prova-se a ausência.
  it("os botões do passo de entrega («Aprovar entrega»/«Publicar») não aparecem", () => {
    expect(read("components/KanbanBoard.tsx")).toMatch(/if \(lane\.role === "delivery"\) \{\s*body = \(\s*<>\s*<TrainColumn\b/);
    for (const f of ["components/KanbanBoard.tsx", "components/kanban/FeatureCard.tsx", "components/kanban/TrainColumn.tsx"])
      expect(read(f), f).not.toMatch(/moveCardAction|onAdvance|Aprovar entrega|"Publicar"/);
  });

  // A página de entrega (a Esteira) saiu na fase 3 — a rota redireciona ao Kanban, e o «Publicar» dela virou item do
  // Inbox, que roda a MESMA action. A garantia segue onde ela sempre morou: a fronteira marca o board e a action recusa.
  it("a Esteira saiu (a rota leva ao Kanban) e a action de publicar recusa o board só de organização", () => {
    expect(existsSync(path.join(SRC, "components/EntregaScreen.tsx"))).toBe(false);
    // o redirect mora no next.config (antes de qualquer render — a página com redirect() estourava o React #310)
    expect(existsSync(path.join(SRC, "app/board/[boardId]/entrega/page.tsx"))).toBe(false);
    expect(read("../next.config.js")).toMatch(/source: "\/board\/:boardId\/entrega", destination: "\/board\/:boardId\/kanban"/);
    expect(read("../next.config.js")).toMatch(/source: "\/entrega", destination: "\/inbox"/);
    expect(read("lib/storymap/runner/delivery-deps.ts")).toMatch(/isOrganizeOnly\(boardConfig\) \? \{ organizeOnly: true \}/);
    expect(read("app/delivery-actions.ts")).toMatch(/if \(organizeOnlyNow\(board\)\) return \{ ok: false/);
  });

  // O botão «Console» saiu do card na fase 1 (o card abre a página dele, onde o console mora). A garantia que ele dava —
  // o que só LÊ ou CONVERSA continua no board só de organização — vale para o menu novo: só os itens que disparam
  // execução são condicionados.
  it("o que só conversa continua no menu do card (não dispara nada)", () => {
    const card = read("components/kanban/FeatureCard.tsx");
    expect(card).toMatch(/const menu = \[\s*\{ label: ACTION_LABEL\.talk, draft: DRAFT\.talk \},\s*\{ label: ACTION_LABEL\.move, draft: DRAFT\.move \}/);
  });
});
