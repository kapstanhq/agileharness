// ATAQUE: uma credencial HIFENIZADA sai INTACTA do último portão antes do git, porque a isenção de
// "identificador segmentado" a confunde com um runId.
//
// A onda 2 trocou a régua de `elideCredentialBytes` de "contagem de classes de caractere" para "FORMA do
// token" — e fechou duas portas grandes (token sem maiúscula, hex puro). A régua nova isenta um token
// SEGMENTADO por `-`/`_` cujos pedaços tenham forma de palavra/hex, para o diagnóstico do train seguir
// legível (`agent-<uuid>`, `failed/agent/<uuid>`, `USM_AUTORUN_NO_PROGRESS_MAX`).
//
// A isenção era larga demais num ponto MEDIDO: um segmento como `abcDEF123456` casa
// `^[a-z][A-Za-z0-9]*$`, então um token de bot do Slack (`xoxb-<dígitos>-<dígitos>-<run>`) satisfazia a
// isenção INTEIRA e voltava legível — e ele vai para `findings[].detail`, que o merge train COMMITA.
// Duas coisas fazem disso uma regressão, e não um risco herdado: (a) a régua ANTERIOR (três classes de
// caractere + entropia) ELIDIA essa mesma forma, e (b) este repositório detecta `xox[baprs]-…` por
// prefixo no `scan-secrets.mjs` — ou seja, o detector pega e o portão deixava os bytes passarem, que é
// exatamente o argumento com que a onda justificou fechar o hex de 32 chars.
//
// Os testes descrevem FORMAS de credencial, e vêm com as não-regressões do que o portão NÃO pode cegar —
// sem elas, apertar a isenção transformaria todo diagnóstico de integração em `oculto (N chars)` e alguém
// desligaria o portão inteiro.
import { describe, expect, it } from "vitest";

import { elideCredentialBytes, withSecretScanBlockerFinding } from "./findings";

const OCULTO = /oculto \(\d+ chars\)/;

/**
 * Nenhum fixture aqui é credencial de verdade: todos são sorteio de mentira, com a FORMA do real.
 * O marcador `FAKE` vai DENTRO do valor de propósito — é o que o `scan-secrets` do pre-commit exige
 * para distinguir fixture de vazamento. Sem ele o scanner (corretamente) recusa o commit deste
 * arquivo, e a saída seria alguém desligar o scanner em vez de marcar o fixture.
 */
const SLACK_BOT = "xoxb-2345678901-FAKE23456701-abcDEF123456";
const KEBAB_CRED = "wq8ZR2mk4TxL-p7NvB3jH9cQ";

describe("[ATAQUE] credencial HIFENIZADA passava pela isenção de identificador segmentado", () => {
  it("um token de bot (prefixo + dígitos + run alfanumérico) é elidido", () => {
    const saida = elideCredentialBytes(`git push falhou: SLACK_BOT_TOKEN=${SLACK_BOT}`);
    expect(saida, "a credencial hifenizada saiu INTACTA para o card").not.toContain(SLACK_BOT);
    expect(saida).toMatch(OCULTO);
  });

  it("um token de dois segmentos de 12 chars sorteados é elidido", () => {
    // O caso genérico da mesma classe: nada aqui é palavra, mas cada pedaço caberia na régua de
    // "segmento com forma de palavra" se ela não recusasse maiúscula E dígito no mesmo segmento.
    const saida = elideCredentialBytes(`Authorization: Bearer ${KEBAB_CRED}`);
    expect(saida).not.toContain(KEBAB_CRED);
  });

  it("vale pelo caminho REAL: o detail que o train commita no card sai sem os bytes", () => {
    const [achado] = withSecretScanBlockerFinding([], "run-1", `exec falhou · ${SLACK_BOT}`);
    expect(achado.detail).not.toContain(SLACK_BOT);
  });
});

describe("apertar a isenção não pode cegar o diagnóstico do train", () => {
  it("runId, branch de sessão, nome de env, caminho e sha continuam LEGÍVEIS", () => {
    const texto =
      "run agent-b38597ce-3ef1-4805-bca8-0a1f5ed1d520 · branch failed/agent/b38597ce-3ef1-4805-bca8-0a1f5ed1d520 · " +
      "USM_AUTORUN_NO_PROGRESS_MAX=3 · packages/storymap-ui/src/lib/storymap/runner/merge-queue.ts · " +
      "merge a09d389c1e2f3a4b5c6d7e8f9012345678901234 · split-code-not-landed-agent-b38597ce.patch";
    expect(elideCredentialBytes(texto)).toBe(texto);
  });

  it("nomes compostos de código (camelCase, kebab, SCREAMING) continuam LEGÍVEIS", () => {
    // Um segmento pode ter maiúscula (camelCase) OU dígito (`0001`) — o que a régua recusa é os DOIS
    // juntos no mesmo segmento, que é assinatura de sorteio, não de nome escrito por gente.
    const texto =
      "supersedeStaleTerminalBlockers_resolver · packages-storymap-ui-runner · acme.cinemaSessionsView · " +
      "token-de-repasse-do-app-0001";
    expect(elideCredentialBytes(texto)).toBe(texto);
  });
});
