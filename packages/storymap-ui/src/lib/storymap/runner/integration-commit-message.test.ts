import { describe, expect, it } from "vitest";
import { authoredMessages, composeIntegrationMessage, parseCommitLog } from "./integration-commit-message";

const opts = { fallbackSubject: "chore(sessão): integra a sessão sess-ex9310", provenance: "Merge-Train-Entry: sessão sess-ex9310" };

describe("composeIntegrationMessage — a mensagem do autor no commit de integração", () => {
  it("uma mensagem: intacta (assunto, corpo, trailers), com a proveniência no MESMO bloco de trailers", () => {
    const msg = "feat(ops): relatório por serviço\n\nAgrupa por serviço.\n\nCo-Authored-By: Pessoa Exemplo <p@example.test>";
    expect(composeIntegrationMessage([msg], opts)).toBe(`${msg}\nMerge-Train-Entry: sessão sess-ex9310\n`);
  });

  it("várias: assunto da primeira, um item por commit seguinte, trailers juntos e deduplicados no fim", () => {
    const a = "fix(hooks): a\n\ncorpo a\n\nCo-Authored-By: P <p@example.test>";
    const b = "test(hooks): b\n\nCo-Authored-By: P <p@example.test>\nRefs: story-ex9311";
    expect(composeIntegrationMessage([a, b], opts)).toBe(
      "fix(hooks): a\n\ncorpo a\n\n* test(hooks): b\n\nCo-Authored-By: P <p@example.test>\nRefs: story-ex9311\nMerge-Train-Entry: sessão sess-ex9310\n",
    );
  });

  it("nunca reaproveita um rótulo `board:` como mensagem do autor; sem autor, o fallback", () => {
    expect(composeIntegrationMessage(["board: estado vivo (bancada)"], opts)).toBe(
      "chore(sessão): integra a sessão sess-ex9310\n\nMerge-Train-Entry: sessão sess-ex9310\n",
    );
    expect(composeIntegrationMessage(["board: flush", "fix: c"], { fallbackSubject: "x" })).toBe("fix: c\n");
  });

  it("um último parágrafo que NÃO é só trailers fica no corpo", () => {
    expect(composeIntegrationMessage(["fix: d\n\nNota: isto é prosa\ncom uma segunda linha"], { fallbackSubject: "x" })).toBe(
      "fix: d\n\nNota: isto é prosa\ncom uma segunda linha\n",
    );
  });

  it("parseCommitLog separa por RS e authoredMessages tira os rótulos do sistema", () => {
    const log = "fix: a\n\nCo-Authored-By: P <p@example.test>\n\x1e\nboard: estado vivo\n\x1e\n";
    const parsed = parseCommitLog(log);
    expect(parsed).toEqual(["fix: a\n\nCo-Authored-By: P <p@example.test>", "board: estado vivo"]);
    expect(authoredMessages(parsed)).toEqual(["fix: a\n\nCo-Authored-By: P <p@example.test>"]);
  });

  it("o commit de stage do próprio train (`usm(...): código staged`) também é rótulo do sistema", () => {
    const staged = "usm(sessão): código staged (sessão sess-ex9399)\n\nfix: outra\n\nRefs: story-ex9399";
    const card = "usm(story-ex9312): código staged (run run-ex9312)";
    expect(authoredMessages([staged, card, "fix: e"])).toEqual(["fix: e"]);
    expect(composeIntegrationMessage([staged, "fix: e"], { fallbackSubject: "x" })).toBe("fix: e\n");
  });
});
