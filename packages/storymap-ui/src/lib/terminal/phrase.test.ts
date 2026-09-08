import { describe, expect, it } from "vitest";
import { deriveActivity, intentionalTitle, shortPath, stripSpinner } from "./phrase";

describe("stripSpinner — o quadro de animação que vem colado no título", () => {
  it("tira o braille do spinner que o CLI do agente escreve no pane_title", () => {
    // Medido nesta máquina: `tmux list-panes -F '#{pane_title}'` devolve o resumo da tarefa em curso
    // com o spinner na frente. O glifo é um QUADRO congelado no instante da amostra — não diz nada e
    // muda a cada ciclo, fazendo o MESMO título parecer dois títulos diferentes.
    expect(stripSpinner("⠂ Remover termo do jargão e implementar notificações")).toBe(
      "Remover termo do jargão e implementar notificações",
    );
    expect(stripSpinner("✳ Refatorar popover com técnica SCAMPER")).toBe("Refatorar popover com técnica SCAMPER");
    expect(stripSpinner("✻ Proofing")).toBe("Proofing");
  });

  it("não mexe num título que já é só texto", () => {
    expect(stripSpinner("deploy do storymap")).toBe("deploy do storymap");
    expect(stripSpinner("")).toBe("");
  });

  it("não come a primeira palavra de um título legítimo", () => {
    // A régua é o GLIFO de spinner, não "o primeiro token" — senão um título inteiro perderia sentido.
    expect(stripSpinner("Ajustar o build")).toBe("Ajustar o build");
  });
});

describe("intentionalTitle — o spinner não faz ruído virar sinal", () => {
  it("um default do tmux fantasiado de spinner continua sendo ruído", () => {
    expect(intentionalTitle("⠂ bash", "bash", "shell")).toBe(false);
    expect(intentionalTitle("✳ claude", "claude", "shell")).toBe(false);
  });

  it("um título de verdade continua sendo sinal", () => {
    expect(intentionalTitle("⠂ Corrigir o vigia de terminais", "claude", "shell")).toBe(true);
  });

  it("um spinner sozinho não é título nenhum", () => {
    expect(intentionalTitle("⠂", "claude", "shell")).toBe(false);
  });

  it("o BANNER do programa não é atividade — foi o que a lista mostrou como o que dois terminais faziam", () => {
    // Medido em produção (2026-07-30): dois terminais parados exibiam "Claude Code" na linha que
    // responde "o que este terminal está fazendo". É o nome do programa, escrito por ele mesmo quando
    // não tem nada a anunciar — o mesmo ruído que `bash`, de marca.
    expect(intentionalTitle("✳ Claude Code", "claude", "Security")).toBe(false);
    expect(intentionalTitle("Node.js", "node", "build")).toBe(false);
  });

  it("mas um título que COMEÇA pelo nome do programa e diz algo continua sendo sinal", () => {
    // A régua não pode virar "qualquer título que mencione o comando é ruído" — aí ela comeria trabalho
    // de verdade.
    expect(intentionalTitle("claude: refatorando o popover do topnav", "claude", "shell")).toBe(true);
    expect(intentionalTitle("node scripts/deploy.mjs", "node", "shell")).toBe(true);
  });
});

describe("deriveActivity", () => {
  it("entrega o título LIMPO — é o texto que a lista de Terminais mostra ao operador", () => {
    expect(deriveActivity("⠂ Corrigir o vigia", "claude", "/root/meu-monorepo", "shell")).toBe("Corrigir o vigia");
  });

  it("sem título intencional, cai no comando + cwd curto", () => {
    expect(deriveActivity("bash", "bash", "/root/meu-monorepo/packages/storymap-ui", "shell")).toBe(
      "bash · …/packages/storymap-ui",
    );
  });

  it("sem nada, devolve vazio (nunca inventa)", () => {
    expect(deriveActivity("", "", "", "shell")).toBe("");
  });
});

describe("shortPath", () => {
  it("guarda os dois últimos segmentos", () => {
    expect(shortPath("/root/meu-monorepo/packages/storymap-ui")).toBe("…/packages/storymap-ui");
    expect(shortPath("/root/x")).toBe("/root/x");
  });
});
