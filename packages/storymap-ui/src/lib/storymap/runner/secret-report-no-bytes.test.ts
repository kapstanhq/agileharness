// ATAQUE: quem LÊ o relatório do scan de segredo sai com bytes do segredo na mão — e o relatório não
// morre no terminal.
//
// O caminho medido até o disco: o merge train roda `scan-secrets.mjs` sobre o commit, e a saída dele
// vira o `detail` de um finding `security:blocker` (`withSecretScanBlockerFinding`, findings.ts) gravado
// no card — board-data COMMITADA e publicada junto do repositório. O molde antigo de máscara
// (`prefixo…sufixo (N chars)`) entregava 4+2 = 6 caracteres de um segredo REAL por achado; um scan da
// árvore deste monorepo produz 73 achados, ou seja ~400 bytes de credencial de produção, num texto que
// vai para journal, log de CI e git.
//
// A doutrina forte já existe no MESMO repositório e diz o contrário: `maskSecret` (mcp/auth.ts) recusa
// explicitamente o mascarado de pontas ("mostrar as 4 primeiras e 4 últimas entrega 8 caracteres de um
// segredo de 32 a quem lê o log") e imprime SÓ o comprimento. Estes testes cobram a mesma régua do
// scanner: o achado se identifica por REGRA + CAMINHO + LINHA + comprimento, nunca por bytes do valor.
import { describe, expect, it } from "vitest";
import { runScan } from "../../../../../../scripts/git-hooks/scan-secrets.mjs";
import { withSecretScanBlockerFinding } from "./findings";

// Segredos PLANTADOS, montados em pedaços: nenhum literal desta fonte tem a forma que as regras casam,
// senão este arquivo trancaria o pre-commit do próprio repositório. Nenhum pedaço carrega marcador de
// fixture (`fake`/`mock`/`example`/…) — com marcador as regras dispensariam o valor e o teste mediria
// nada.
const TOKEN = ["7Kq3", "Xv9Lb", "2Md6", "Tz8Rn", "4Wp1", "Yc5Hj", "0Fs7", "Bg2Vk", "9Nx4"].join("");
const CHAVE_AWS = ["AK", "IA", "R7QM4XZ2VP9TLBND"].join("");

/**
 * Toda janela de `n` caracteres do segredo. É a régua honesta de "vazou byte?": afirmar só
 * `not.toContain(segredo)` passa com o segredo inteiro publicado em pedaços, que é exatamente o que uma
 * máscara de pontas faz.
 */
function janelas(segredo: string, n = 4): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= segredo.length; i++) out.push(segredo.slice(i, i + n));
  return out;
}

function bytesVazados(texto: string, segredo: string): string[] {
  return [...new Set(janelas(segredo).filter((j) => texto.includes(j)))];
}

/** Roda o scanner sobre um diff sintético, capturando o RELATÓRIO (que ele escreve em stderr). */
function scan(diff: string, names = "src/config.ts") {
  const git = (args: string[]) => (args.includes("--name-only") ? names : diff);
  const pedacos: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    pedacos.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const res = runScan({ argv: ["--staged"], git, env: {} });
    return { ...res, relatorio: pedacos.join("") };
  } finally {
    process.stderr.write = original;
  }
}

const diffCom = (linha: string, arquivo = "src/config.ts") =>
  [`+++ b/${arquivo}`, "@@ -0,0 +1 @@", `+${linha}`].join("\n");

describe("relatório do scan de segredo — identifica o achado, NÃO entrega o valor", () => {
  it("ATAQUE: o achado de uma credencial de env não devolve NENHUM byte dela (nem prefixo, nem sufixo)", () => {
    const r = scan(diffCom(`OPENAI_API_KEY=${TOKEN}`));

    expect(r.code, "o gate tem de continuar BLOQUEANDO — a máscara não pode custar detecção").toBe(2);
    const previews = (r.findings ?? []).map((f) => f.preview).join(" | ");
    expect(bytesVazados(previews, TOKEN), `preview vazou bytes do segredo: ${previews}`).toEqual([]);
    expect(bytesVazados(r.relatorio, TOKEN), "o relatório impresso vazou bytes do segredo").toEqual([]);

    // e o que SOBRA é o que torna o achado acionável: a regra, o caminho, a linha, o nome da variável
    // (que não é segredo) e o comprimento.
    expect(r.findings?.map((f) => f.rule)).toContain("env-credential");
    expect(previews).toContain("OPENAI_API_KEY");
    expect(previews).toContain(`(${TOKEN.length} chars)`);
    expect(r.relatorio).toContain("src/config.ts:1");
  });

  it("ATAQUE: o achado de uma chave com prefixo conhecido também não devolve o prefixo casado", () => {
    // A regra de prefixo casa o TOKEN INTEIRO (`AKIA…`), então o mascarado dela é o vazamento mais
    // direto: são os 4 primeiros chars de uma chave real de AWS.
    const r = scan(diffCom(`const k = "${CHAVE_AWS}"`));
    expect(r.code).toBe(2);
    const texto = r.relatorio + (r.findings ?? []).map((f) => f.preview).join(" ");
    expect(bytesVazados(texto, CHAVE_AWS), "o prefixo/sufixo da chave apareceu no relatório").toEqual([]);
    expect(texto).toContain(`(${CHAVE_AWS.length} chars)`);
  });

  it("ATAQUE: token NU em crase de markdown — o achado por FORMA também não ecoa o valor", () => {
    const r = scan(diffCom("**Operator token:** `" + TOKEN + "`", "docs/operacao.md"), "docs/operacao.md");
    expect(r.code).toBe(2);
    expect(r.findings?.map((f) => f.rule)).toContain("naked-high-entropy-token");
    const texto = r.relatorio + (r.findings ?? []).map((f) => f.preview).join(" ");
    expect(bytesVazados(texto, TOKEN)).toEqual([]);
  });

  it("nenhum achado devolvido carrega o valor cru em NENHUM campo (a dedupe não pode virar canal)", () => {
    // A dedupe por linha precisa distinguir DOIS segredos diferentes do mesmo comprimento na mesma
    // linha — o valor cru serve de chave, mas não pode SAIR da função e virar campo de finding
    // (findings[] é serializado para o card).
    const r = scan(diffCom(`OPENAI_API_KEY=${TOKEN}`));
    expect(bytesVazados(JSON.stringify(r.findings), TOKEN)).toEqual([]);
  });

  it("dois segredos DIFERENTES de mesmo comprimento na mesma linha continuam sendo dois achados", () => {
    // Regressão da máscara: deduplicar pelo texto mascarado passaria a fundir segredos distintos de
    // igual comprimento num achado só — o segundo sumiria do relatório.
    const outro = ["3Vf8", "Zt6Qm", "1Ld9", "Hb4Ks", "7Rw2", "Xn5Cj", "8Gp0", "Mv3Yz", "6Bq1"].join("");
    expect(outro).toHaveLength(TOKEN.length);
    const r = scan(diffCom(`ROTA=/api/${TOKEN}/x?t=${outro}`, "docs/rotas.md"), "docs/rotas.md");
    expect(r.code).toBe(2);
    const nus = (r.findings ?? []).filter((f) => f.rule === "naked-high-entropy-token");
    expect(nus).toHaveLength(2);
    expect(bytesVazados(r.relatorio, TOKEN)).toEqual([]);
    expect(bytesVazados(r.relatorio, outro)).toEqual([]);
  });
});

describe("findings[].detail do card — o último portão antes do git", () => {
  it("ATAQUE: o relatório do scan vira detail de finding sem nenhum byte do segredo", () => {
    const r = scan(diffCom(`OPENAI_API_KEY=${TOKEN}`));
    const [finding] = withSecretScanBlockerFinding([], "run-1", r.relatorio);
    expect(finding.severity).toBe("blocker");
    expect(bytesVazados(finding.detail ?? "", TOKEN), "o detail gravado no card vazou bytes do segredo").toEqual([]);
  });

  it("ATAQUE: um detail que chega com o token NU (erro de exec carregando a linha) é elidido aqui", () => {
    // Defesa em profundidade: o `detail` é texto LIVRE de quem chamou (o train passa a mensagem de erro
    // do exec, que carrega a linha de comando e o stderr do filho). Se um caminho futuro trouxer bytes
    // não mascarados, este é o último lugar antes de `updateCardOnDisk` — depois dele é commit.
    const [finding] = withSecretScanBlockerFinding([], "run-2", `git falhou: token=${TOKEN} na linha 3`);
    expect(bytesVazados(finding.detail ?? "", TOKEN)).toEqual([]);
    expect(finding.detail).toContain("git falhou");
    expect(finding.detail).toContain(`${TOKEN.length} chars`); // diz que elidiu, e o tamanho do que elidiu
  });

  it("texto sem forma de credencial atravessa intacto (a elisão não pode comer o diagnóstico)", () => {
    const [finding] = withSecretScanBlockerFinding([], "run-3", "secret scan BLOCKED the commit: src/config.ts:1");
    expect(finding.detail).toContain("secret scan BLOCKED the commit");
    expect(finding.detail).toContain("src/config.ts:1");
  });
});
