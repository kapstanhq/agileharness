import { describe, expect, it } from "vitest";
import { heldRequests, isBlocked, parseStagedLog, stagedTotalOf, STAGED_LOG_FORMAT } from "./delivery-view";
import { releaseCodePrefixes } from "./release-scope";
import type { PublishRequest } from "./publish-queue";

function req(over: Partial<PublishRequest> = {}): PublishRequest {
  return {
    id: "pub-1",
    board: "storymap",
    requestedSha: "aaa",
    requestedBy: "human",
    requestedAt: "2026-07-28T00:00:00.000Z",
    allowNewer: false,
    status: "waiting",
    ...over,
  };
}

describe("stagedTotalOf — o total real, não o tamanho da janela", () => {
  it("usa a contagem do git quando ela é legível", () => {
    expect(stagedTotalOf("47\n", 30)).toBe(47);
    expect(stagedTotalOf("3", 3)).toBe(3);
  });

  it("contagem ilegível cai na lista — sub-reportar é barato, inventar um total não", () => {
    expect(stagedTotalOf(null, 30)).toBe(30);
    expect(stagedTotalOf("", 30)).toBe(30);
    expect(stagedTotalOf("fatal: bad revision", 30)).toBe(30);
  });

  it("contagem MENOR que a lista é incoerente ⇒ vale a lista (as duas leituras discordaram)", () => {
    expect(stagedTotalOf("2", 30)).toBe(30);
  });
});

describe("fila de publicação — o que está segurado e o que está travado", () => {
  it("heldRequests exige o carimbo de adiamento — um pedido recém-enfileirado não é 'segurado'", () => {
    const rows = [req({ id: "novo" }), req({ id: "segurado", heldSince: "2026-07-28T00:00:00.000Z" })];
    expect(heldRequests(rows).map((r) => r.id)).toEqual(["segurado"]);
  });

  it("isBlocked: espera longa COM contagem alta é bloqueio; qualquer uma sozinha ainda é lentidão", () => {
    const now = Date.parse("2026-07-28T01:00:00.000Z");
    const heldSince = "2026-07-28T00:00:00.000Z"; // 60 min
    expect(isBlocked(req({ heldSince, heldCount: 50 }), now)).toBe(true);
    expect(isBlocked(req({ heldSince, heldCount: 2 }), now)).toBe(false);
    expect(isBlocked(req({ heldSince: "2026-07-28T00:59:00.000Z", heldCount: 50 }), now)).toBe(false);
    expect(isBlocked(req({ heldCount: 50 }), now)).toBe(false); // sem heldSince = nunca foi adiado
    expect(isBlocked(req({ heldSince, heldCount: 50, status: "published" }), now)).toBe(false);
  });

});

describe("parseStagedLog", () => {
  const line = (sha: string, at: string, subject: string) => `${sha} ${at} ${subject}`;

  it("lê sha, data e assunto — com o assunto podendo ter espaços", () => {
    const out = parseStagedLog(
      [
        line("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", "2026-07-28T00:10:00-03:00", "usm(sessão): código staged"),
        "",
      ].join("\n"),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      at: "2026-07-28T00:10:00-03:00",
      subject: "usm(sessão): código staged",
    });
  });

  it("extrai a sessão dona quando o assunto a nomeia", () => {
    const out = parseStagedLog(
      line("abc1234", "2026-07-28T00:10:00Z", "usm(sessão): código staged (sessão c4a91e07-83bd-4f52)"),
    );
    expect(out[0].sessionId).toBe("c4a91e07-83bd-4f52");
  });

  it("sem sessão no assunto, o campo simplesmente não existe", () => {
    const out = parseStagedLog(line("abc1234", "2026-07-28T00:10:00Z", "fix: qualquer coisa"));
    expect(out[0].sessionId).toBeUndefined();
  });

  it("descarta linha malformada sem derrubar a lista", () => {
    const out = parseStagedLog(
      ["lixo sem sha valido aqui", line("abc1234", "2026-07-28T00:10:00Z", "ok"), "   "].join("\n"),
    );
    expect(out.map((d) => d.subject)).toEqual(["ok"]);
  });

  it("o formato declarado é o que o parser espera (sha, data, assunto)", () => {
    expect(STAGED_LOG_FORMAT).toBe("%H %cI %s");
  });
});

describe("releaseCodePrefixes — o escopo que a promoção leva", () => {
  it("sem `package`, cai no prefixo global (legado)", () => {
    expect(releaseCodePrefixes(null, ["packages/"])).toEqual(["packages/"]);
    expect(releaseCodePrefixes({ package: undefined } as never, ["packages/"])).toEqual(["packages/"]);
  });

  it("junta pacote + compartilhados + superfícies, todos com barra final", () => {
    expect(
      releaseCodePrefixes(
        {
          package: "packages/acmeapp",
          sharedPackages: ["packages/acme-shared/"],
          deploy: { surfaces: [{ prefix: "tools/web-terminal" }] },
        } as never,
        ["packages/"],
      ),
    ).toEqual(["packages/acmeapp/", "packages/acme-shared/", "tools/web-terminal/"]);
  });

  it("não deixa a lista global ser mutada por quem a recebe", () => {
    const global = ["packages/"];
    const out = releaseCodePrefixes(null, global);
    out.push("outro/");
    expect(global).toEqual(["packages/"]);
  });
});

// A raia "No stage" faz uma PROMESSA em cada linha. Estes testes pinam quando ela pode fazê-la.
