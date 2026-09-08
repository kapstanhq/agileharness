import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { ENTITY_ACTIONS, confirmFor, type EntityActionId } from "./entity-actions";

describe("entity-actions — o catálogo declarativo de ações", () => {
  // O INCIDENTE que este arquivo guarda (2026-07-31): na bancada de Ideias, o «Gerar tarefas» da linha
  // disparava no PRIMEIRO clique enquanto o «Excluir», a 24px dele, perguntava. Um toque de raspão gastou um
  // agente, minutos e tokens, e deixou um contêiner de captura + uma proposta para o operador limpar à mão.
  //
  // A causa não foi o botão: era o catálogo não ter vocabulário para "consequente mas não destrutivo", então
  // cada superfície decidia sozinha se perguntava — e as quatro decidiam diferente.
  it("gerar tarefas PERGUNTA antes: ela dispara um agente e custa tokens", () => {
    const gen = ENTITY_ACTIONS.find((a) => a.id === "generate-stories");
    expect(gen?.confirm, "gerar tarefas sem confirmação — foi exatamente o clique acidental de 2026-07-31").toBeDefined();
  });

  it("excluir PERGUNTA antes, e com peso de perigo", () => {
    const del = ENTITY_ACTIONS.find((a) => a.id === "delete");
    expect(del?.confirm).toBeDefined();
    expect(del?.confirm?.tone).toBe("danger");
  });

  // `destructive` é PESO VISUAL; `confirm` é o GATE. Uma ação pode precisar de confirmação sem destruir nada
  // (gerar tarefas é o caso) — se alguém voltar a amarrar as duas, este teste cai.
  it("confirmar não é o mesmo que destruir: gerar confirma sem ser destrutiva", () => {
    const gen = ENTITY_ACTIONS.find((a) => a.id === "generate-stories");
    expect(gen?.destructive).toBeFalsy();
    expect(gen?.confirm).toBeDefined();
  });

  it("a cópia fala da CONSEQUÊNCIA e concorda em número (1 × N)", () => {
    for (const a of ENTITY_ACTIONS) {
      if (!a.confirm) continue;
      const one = confirmFor(a.id, 1)!;
      const many = confirmFor(a.id, 3)!;
      expect(one.title).not.toBe(many.title); // "esta ideia?" × "3 ideias?"
      expect(many.title).toContain("3");
      // A descrição diz o que ACONTECE — não repete o rótulo do botão.
      for (const c of [one, many]) {
        expect(c.description.length).toBeGreaterThan(30);
        expect(c.description.toLowerCase()).not.toBe(a.label.toLowerCase());
      }
      expect(one.confirmLabel.length).toBeGreaterThan(0);
    }
  });

  it("confirmFor devolve null para ação sem gate (e nunca lança)", () => {
    expect(confirmFor("nao-existe" as EntityActionId, 1)).toBeNull();
  });

  // O GATE só vale se as superfícies o respeitarem, e um teste de render não pega isto (a suíte não renderiza
  // React sob rolldown-vite) — foi justamente essa lacuna que deixou o acidente passar. Então este teste lê o
  // CÓDIGO das três superfícies e exige, em cada uma, a FORMA exata que estava errada antes.
  //
  // Cada `notMatch` abaixo é literalmente o que o arquivo continha em 2026-07-31 — é assim que se sabe que o
  // guarda pega o defeito, e não só descreve o conserto. Um teste de forma envelhece com o refactor; quando
  // ele quebrar por mudança legítima de shape, releia a intenção (o clique PERGUNTA) antes de afrouxar.
  const SURFACES: { file: string; mustNot: RegExp[]; why: string }[] = [
    {
      file: "../../components/IdeiasView.tsx",
      mustNot: [/"generate-stories":\s*\{\s*run:\s*\(\)\s*=>\s*generateOne\(/],
      why: "a linha da bancada disparava a captura no primeiro clique (o acidente)",
    },
    {
      file: "../../components/IdeaDocActions.tsx",
      mustNot: [/onClick=\{\s*run\s*\}/],
      why: "o botão do documento chamava o executor direto",
    },
    {
      file: "../../components/SmartCaptureModal.tsx",
      mustNot: [
        /onRun:\s*batchGenerate\b/,
        // O BURACO que a 1ª versão deste guarda deixou passar: ela procurava pelo nome da action
        // ASSÍNCRONA, e o HUB dispara a SÍNCRONA (`generateStories` → proposeTasksForIdeaAction). Mesma
        // ação do catálogo, outro executor — e um clique de raspão gastava uma chamada de modelo.
        /onGenerate=\{\s*generateStories\s*\}/,
      ],
      why: "a modal disparava geração (em lote e por ideia) sem perguntar",
    },
  ];

  it.each(SURFACES)("$file: o clique PERGUNTA, não dispara", ({ file, mustNot, why }) => {
    const src = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    // A superfície RENDERIZA a ação do catálogo? (por qualquer executor — é o descritor que manda)
    expect(src, `${file} não usa mais a ação generate-stories — releia este teste`).toMatch(
      /generate-stories|generateTasksForIdeaAction|proposeTasksForIdeaAction/,
    );
    for (const re of mustNot) expect(src, `${file}: ${why}`).not.toMatch(re);
    // e a superfície tem de tirar a cópia do CATÁLOGO, não escrever a sua
    expect(src, `${file} não lê o catálogo de confirmação`).toMatch(/confirmFor\(/);
  });
});
