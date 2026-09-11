// AS AFIRMAÇÕES DE SEGURANÇA ESCRITAS NOS COMENTÁRIOS TÊM DE SER VERDADE (story-7q83gx / story-l9y3wh).
//
// Isto não é higiene de documentação. Um comentário que promete uma garantia que o código não tem é
// dívida ATIVA: é por ele que a próxima pessoa conclui que uma camada é redundante e a remove. Dois
// casos MEDIDOS neste pacote, os dois no segredo mais exposto do sistema (o endpoint MCP público, cujas
// tools spawnam `claude --dangerously-skip-permissions`):
//
//  1. O header da route publicava um piso de 24 caracteres DEPOIS de o piso real ter subido para 32 +
//     variedade + entropia + motivo-não-repetido. Quem lesse o header acreditaria que 24 caracteres
//     bastam — e um revisor poderia "simplificar" `secretWeakness` de volta a uma checagem de
//     comprimento sem perceber que estava desarmando três camadas.
//  2. O header do `mcp/auth.ts` mandava o leitor procurar um gerador de BOOT que deixou de existir
//     quando a geração automática saiu do boot. Ponteiro para símbolo morto ensina que a documentação
//     não é confiável, e o próximo leitor para de conferir.
//
// Os NOMES/NÚMEROS obsoletos NÃO são repetidos neste arquivo: as duas lentes abaixo varrem `src/`
// procurando por eles, e citá-los aqui faria a varredura acusar o próprio guard.
//
// A régua aqui é a MESMA do `board-integrity.test.ts` ("uma descrição que nomeia o passo errado é um
// defeito, não estilo"): a prosa é amarrada às CONSTANTES e aos SÍMBOLOS reais, então um bump futuro
// que deixe o texto atrás fica vermelho no lugar de envelhecer em silêncio.
//
// CUSTO DE AUTONOMIA: ZERO. Nada aqui muda o que o agente pode fazer — só impede que a próxima leitura
// do perímetro seja feita em cima de uma promessa falsa.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MIN_DISTINCT_CHARS, MIN_ENTROPY_BITS, MIN_TOKEN_LEN } from "./auth";

const mcpDir = fileURLToPath(new URL(".", import.meta.url));
const srcDir = path.resolve(mcpDir, "../../..");

const AUTH_FILE = path.join(mcpDir, "auth.ts");
const BOOTSTRAP_FILE = path.join(mcpDir, "token-bootstrap.ts");
const ROUTE_REL = path.join("api", "mcp", "[secret]", "[transport]", "route.ts");
const ROUTE_FILE = path.join(srcDir, "app", ROUTE_REL);
const LINT_FILE = path.join(srcDir, "app", "safe-methods-readonly.test.ts");

const read = (file: string): string => readFileSync(file, "utf8");

/** Todo `.ts`/`.tsx` de `src/` — a varredura de símbolo morto não pode ter ponto cego. */
function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allSourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("o header da route MCP não pode prometer um piso que o código não exige", () => {
  it("todo piso de comprimento citado na prosa é o MIN_TOKEN_LEN real", () => {
    // A prosa publicava 24 com a constante já em 32: um piso PUBLICADO mais fraco que o implementado
    // convida a "simplificação" que desarma o resto (variedade, entropia, motivo repetido).
    const source = read(ROUTE_FILE);
    const cited = [...source.matchAll(/>=\s*(\d+)\s+chars\b/g)].map((m) => Number(m[1]));
    expect(cited.length, "o header deixou de declarar o piso de comprimento do token MCP").toBeGreaterThan(0);
    for (const n of cited) expect(n).toBe(MIN_TOKEN_LEN);
  });

  it("os pisos de variedade e entropia citados também são os reais", () => {
    const source = read(ROUTE_FILE);
    for (const n of [...source.matchAll(/>=\s*(\d+)\s+distinct chars\b/g)].map((m) => Number(m[1]))) {
      expect(n).toBe(MIN_DISTINCT_CHARS);
    }
    for (const n of [...source.matchAll(/>=\s*(\d+)\s+bits\b/g)].map((m) => Number(m[1]))) {
      expect(n).toBe(MIN_ENTROPY_BITS);
    }
  });

  it("o header aponta para a régua que decide de verdade, não para um número solto", () => {
    // `secretWeakness` é quem julga o segredo configurado. Sem esse ponteiro, o header descreve UMA das
    // quatro checagens e a leitura do perímetro passa a subestimar o que existe.
    expect(read(ROUTE_FILE)).toContain("secretWeakness");
  });

  it("o header diz que a ENV é o único caminho de ARMAR a porta", () => {
    // A garantia "nunca fica acidentalmente aberto" só é verdadeira porque NADA gera token no boot. Se
    // alguém reintroduzir geração automática, esta frase volta a ser falsa — e ela precisa estar escrita
    // aqui para que a contradição seja visível de onde a mudança seria feita.
    const source = read(ROUTE_FILE);
    expect(source).toContain("NOTHING generates this token");
    expect(source).toMatch(/never be accidentally left OPEN/);
  });
});

describe("comentário de segurança não aponta para símbolo morto", () => {
  // Montado por concatenação DE PROPÓSITO: escrever o nome literal aqui faria a própria varredura
  // encontrá-lo neste arquivo e a lente precisaria de uma exceção — exceção que, no dia em que o
  // símbolo voltasse a ser citado por engano, esconderia o achado.
  const DEAD_GENERATOR = ["ensure", "Mcp", "Token"].join("");

  it("nenhum arquivo de src/ cita o gerador que a onda 2 removeu", () => {
    const offenders = allSourceFiles(srcDir).filter((f) => read(f).includes(DEAD_GENERATOR));
    expect(
      offenders.map((f) => path.relative(srcDir, f)),
      `ponteiro para símbolo inexistente (${DEAD_GENERATOR}) — aponte para o gerador que existe hoje`,
    ).toEqual([]);
  });

  it("o gerador que o header do auth.ts nomeia EXISTE e é exportado", () => {
    // O par da checagem acima: proibir o nome morto sem exigir o vivo deixaria passar um header que
    // simplesmente para de dizer quem gera o token.
    expect(read(AUTH_FILE)).toContain("generateAndPersistMcpToken");
    expect(read(BOOTSTRAP_FILE)).toMatch(/export function generateAndPersistMcpToken\b/);
    expect(read(AUTH_FILE), "o caminho EXPLÍCITO de geração precisa estar nomeado").toContain(
      "--generate-mcp-token",
    );
  });
});

describe("a isenção de lint da route é visível DE DENTRO da route", () => {
  it("a route avisa que é isenta e sob qual premissa", () => {
    // O ATAQUE que isto impede é de processo, não de rede: a rota de MAIOR privilégio do app passa no
    // varredor de CSRF por uma ISENÇÃO declarada noutro arquivo. Quem edita a rota (e um dia autentica
    // por cookie/sessão) não era avisado aqui — descobriria pelo vermelho de um lint distante, ou não
    // descobriria, porque a premissa da isenção é justamente o que a mudança quebra.
    const source = read(ROUTE_FILE);
    expect(source).toContain("SHARED_IMPL_EXEMPTIONS");
    expect(source).toContain("safe-methods-readonly");
    expect(source, "o aviso precisa dizer QUANDO a isenção morre").toMatch(/ISENÇÃO MORRE/);
  });

  it("e o lint realmente isenta esta rota (o ponteiro não aponta para o vazio)", () => {
    // Fecha o laço nos dois sentidos: um aviso apontando para uma isenção que não existe mais é a mesma
    // dívida do símbolo morto, só na outra direção.
    expect(read(LINT_FILE)).toContain(ROUTE_REL.split(path.sep).join("/"));
  });
});
