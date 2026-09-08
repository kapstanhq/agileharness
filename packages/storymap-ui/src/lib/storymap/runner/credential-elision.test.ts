// ATAQUE: o "último portão antes do git" devolve a credencial INTACTA e ela vira board-data commitada.
//
// `elideCredentialBytes` é a segunda trava do caminho em que o texto NÃO veio do scanner da raiz: o
// `detail` do blocker de secret-scan é texto LIVRE de quem chamou — o merge train passa a mensagem de
// erro do `exec`, que carrega a linha de comando e o stderr do filho — e `withSecretScanBlockerFinding`
// grava isso em `findings[].detail` do card, que o train COMMITA. Depois daqui é histórico, e commit de
// segredo não se desfaz.
//
// Duas formas comuns de credencial saíam inteiras, porque a régua era "as três classes de caractere":
//   1. token SEM nenhuma maiúscula (minúscula + dígito) — reprovado pelo `!/[A-Z]/`;
//   2. token HEX PURO — dispensado de cara pela isenção de sha/UUID.
// A (2) é a mais grave: é justamente a forma que a OUTRA camada desta onda foi ALARGADA para detectar
// (`looksLikeSecretValue({declared:true})` caiu para 2 classes exatamente por causa das chaves hex de
// 32 chars). Ou seja: o detector pegava, e o portão deixava os bytes passarem para o commit.
//
// Os testes descrevem as FORMAS de credencial, não a implementação — e a metade que protege o valor de
// uso do relatório (sha, runId, nome de env, caminho continuam LEGÍVEIS) é assertada junto, porque um
// portão que elide tudo destrói o diagnóstico e será removido na primeira investigação.
import { describe, expect, it } from "vitest";

import { elideCredentialBytes, withSecretScanBlockerFinding } from "./findings";

/** O que a máscara emite. Nenhum byte do valor sai — só o comprimento (mesma doutrina do `redact`). */
const OCULTO = /oculto \(\d+ chars\)/;

/** Nem os fixtures desta suíte podem carregar credencial de verdade: tudo abaixo é sorteio de mentira. */
const HEX_32 = "9f2c7a1e4b8d60359af1c2e9b7d4a8f6";
const MINUSCULO_32 = "k9xq3mzr7wvb2ntl5hjd8pcf4gsy6a0e";
const BASE64URL_43 = "Kj8mQ2xRt5VnW7pLz3BcH6dF9gJ4sY1uA0eZ2rQ8iOk";

describe("[ATAQUE] elideCredentialBytes deixava passar duas formas comuns de credencial", () => {
  it("token sem NENHUMA maiúscula (minúscula + dígito) é elidido", () => {
    // A exigência das três classes de caractere é uma assinatura de alfabeto sorteado — mas metade dos
    // alfabetos de credencial (hex, base32 minúsculo, boa parte das chaves de provedor) não tem
    // maiúscula nenhuma. Exigi-la transformava a régua num filtro que o atacante satisfaz por omissão.
    const saida = elideCredentialBytes(`falhou: token=${MINUSCULO_32} no comando`);
    expect(saida, "credencial minúscula saiu INTACTA para o card").not.toContain(MINUSCULO_32);
    expect(saida).toMatch(OCULTO);
  });

  it("token HEX PURO é elidido — é a forma que a outra camada da onda passou a detectar", () => {
    const saida = elideCredentialBytes(`OPENWEATHER_API_KEY=${HEX_32}`);
    expect(saida, "credencial hex saiu INTACTA para o card").not.toContain(HEX_32);
    expect(saida).toMatch(OCULTO);
  });

  it("um token base64url (a forma do token do MCP) segue elidido", () => {
    const saida = elideCredentialBytes(`Authorization: Bearer ${BASE64URL_43}`);
    expect(saida).not.toContain(BASE64URL_43);
  });

  it("o portão vale pelo caminho REAL: o detail que o train commita no card sai sem os bytes", () => {
    // A prova de que fechar a função fecha o buraco de verdade — este é o consumidor que grava em disco.
    const [achado] = withSecretScanBlockerFinding([], "run-1", `git push falhou · ${HEX_32} · ${MINUSCULO_32}`);
    expect(achado.detail).not.toContain(HEX_32);
    expect(achado.detail).not.toContain(MINUSCULO_32);
  });
});

describe("o portão não pode cegar o diagnóstico que ele existe para entregar", () => {
  it("sha de commit, sha256 e UUID continuam LEGÍVEIS", () => {
    // Um hex de largura de DIGEST é indistinguível de um nome de objeto git pela forma, e o journal do
    // train é feito deles. Elidi-los tornaria toda mensagem de integração ilegível.
    const sha1 = "a09d389c1e2f3a4b5c6d7e8f9012345678901234";
    const sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const uuid = "b38597ce-3ef1-4805-bca8-0a1f5ed1d520";
    const texto = `merge ${sha1} · gate ${sha256} · sessão ${uuid}`;
    expect(elideCredentialBytes(texto)).toBe(texto);
  });

  it("runId, branch de sessão, nome de env e caminho continuam LEGÍVEIS", () => {
    const texto =
      "run agent-b38597ce-3ef1-4805-bca8-0a1f5ed1d520 · branch failed/agent/b38597ce-3ef1-4805-bca8-0a1f5ed1d520 · " +
      "USM_AUTORUN_NO_PROGRESS_MAX=3 · packages/storymap-ui/src/lib/storymap/runner/merge-queue.ts · " +
      "split-code-not-landed-agent-b38597ce.patch";
    expect(elideCredentialBytes(texto)).toBe(texto);
  });

  it("identificador longo de código (sem dígito) continua LEGÍVEL", () => {
    const texto = "TypeError: supersedeStaleTerminalBlockersResolver is not a function";
    expect(elideCredentialBytes(texto)).toBe(texto);
  });
});
