// A QUE BOARD UM CARD PERTENCE, pelos arquivos que ele toca: o pacote possui, os caminhos declarados possuem, o pacote
// compartilhado só toca; sem prova clara, o board de origem.

import { describe, expect, it } from "vitest";
import { boardForFiles, type BoardFootprint } from "./card-routing";

const boards: BoardFootprint[] = [
  { id: "estufa", name: "Estufa", package: "apps/estufa", sharedPackages: ["libs/comum/", "apps/galpao/"] },
  { id: "galpao", name: "Galpão", package: "apps/galpao", ownsPaths: ["ops/", "tarefas.toml"] },
  { id: "balcao", name: "Balcão", package: "apps/balcao" },
];

describe("boardForFiles", () => {
  it("o pacote possui: arquivos de outro app vão para o board dele", () => {
    expect(boardForFiles(["apps/galpao/src/caixa.ts"], boards, "estufa")).toMatchObject({ board: "galpao", routed: true });
  });

  it("possuir vence compartilhar: o board que só toca o pacote (sharedPackages) não fica com o card", () => {
    // estufa compartilha apps/galpao/, galpao o possui
    expect(boardForFiles(["apps/galpao/a.ts", "apps/galpao/b.ts"], boards, "estufa").board).toBe("galpao");
  });

  it("os caminhos fora de pacote que um board declara (ownsPaths) roteiam — diretório e arquivo da raiz", () => {
    expect(boardForFiles(["ops/publicar.sh"], boards, "estufa")).toMatchObject({ board: "galpao", routed: true });
    expect(boardForFiles(["tarefas.toml"], boards, "balcao").board).toBe("galpao");
    // prefixo de diretório não casa nome parecido
    expect(boardForFiles(["apps/estufax/a.ts"], boards, "balcao")).toMatchObject({ board: "balcao", routed: false });
  });

  it("os arquivos do próprio board de origem ⇒ fica", () => {
    expect(boardForFiles(["apps/estufa/x.ts"], boards, "estufa")).toMatchObject({ board: "estufa", routed: true });
  });

  it("sem arquivos, sem cobertura ou dividido ⇒ o board de origem, dizendo por quê", () => {
    expect(boardForFiles([], boards, "estufa")).toMatchObject({ board: "estufa", routed: false, reason: expect.stringMatching(/sem arquivos/) });
    expect(boardForFiles(["leiame.md"], boards, "estufa")).toMatchObject({ board: "estufa", routed: false, reason: expect.stringMatching(/nenhum board/) });
    expect(boardForFiles(["apps/galpao/a.ts", "apps/balcao/b.ts"], boards, "estufa")).toMatchObject({ board: "estufa", routed: false, reason: expect.stringMatching(/se dividem/) });
  });

  it("a maioria decide; um empate com o de origem fica na origem", () => {
    expect(boardForFiles(["apps/balcao/a.ts", "apps/balcao/b.ts", "apps/galpao/c.ts"], boards, "estufa").board).toBe("balcao");
    expect(boardForFiles(["apps/estufa/a.ts", "apps/balcao/b.ts"], boards, "estufa").board).toBe("estufa");
  });

  it("caminhos com `./` ou barra inicial são normalizados", () => {
    expect(boardForFiles(["./apps/balcao/a.ts", "/apps/balcao/b.ts"], boards, "estufa").board).toBe("balcao");
  });
});
