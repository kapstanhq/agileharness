// TRAVA DE REGRESSÃO do perímetro CSRF do logout (story-l9y3wh).
//
// Logout é a rota que parece inofensiva e por isso perde o guarda num refactor: "não vaza nada".
// O que ela protege não é confidencialidade, é DISPONIBILIDADE — sem o guarda de content-type,
// qualquer página que o operador abrisse conseguia derrubá-lo do board de fora, em laço, para
// sempre. Numa ferramenta que pilota agentes headless, ser deslogado no meio de um run é dano real.

import { describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "@/lib/auth/session";
import { POST } from "./route";

function logout(contentType?: string | null): Promise<Response> {
  const headers = new Headers();
  const ct = contentType === undefined ? "application/json" : contentType;
  if (ct) headers.set("content-type", ct);
  return POST(new Request("http://localhost:3008/api/auth/logout", { method: "POST", headers, body: "{}" }));
}

/** Os atributos do Set-Cookie como o NAVEGADOR os lê — chave minúscula, valor cru. */
function cookieAttrs(res: Response): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const part of (res.headers.get("set-cookie") ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    attrs.set(k.toLowerCase(), rest.join("="));
  }
  return attrs;
}

describe("POST /api/auth/logout — perímetro", () => {
  it("CSRF de logout: outro site não consegue deslogar o operador", async () => {
    // ATAQUE: qualquer página que o operador abra dispara `<form method="POST">` contra o logout.
    // Um form cross-site emite só estes três content-types (nenhum precisa de preflight) — e
    // nenhum deles é json. Sem este guarda, dá para repetir o ataque indefinidamente e manter o
    // operador fora do board.
    for (const ct of ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]) {
      const res = await logout(ct);
      expect(res.status, `content-type ${ct} deveria ser recusado`).toBe(415);
      expect(res.headers.get("set-cookie"), "a sessão não pode ser apagada por um form alheio").toBeNull();
    }
  });

  it("CSRF de logout: sem content-type nenhum também não passa", async () => {
    const res = await logout(null);
    expect(res.status).toBe(415);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("o logout legítimo apaga o cookie — e o apaga com os MESMOS atributos", async () => {
    // Um cookie só é sobrescrito quando nome/path batem: mudar o `path` aqui deixaria o cookie
    // antigo vivo no navegador e o "logout" seria decorativo.
    const res = await logout();
    expect(res.status).toBe(200);

    const attrs = cookieAttrs(res);
    expect(attrs.get(SESSION_COOKIE)).toBe("");
    expect(attrs.get("path")).toBe("/");
    expect(attrs.has("httponly")).toBe(true);
    expect((res.headers.get("set-cookie") ?? "").toLowerCase()).toMatch(/;\s*samesite=lax\b/);
    // Max-Age=0 é o que faz o navegador DESCARTAR o cookie agora.
    expect(attrs.get("max-age")).toBe("0");
  });

  it("nenhuma resposta de logout é cacheável — nem a negativa", async () => {
    // ATAQUE: um cache guarda a resposta do logout (com o Set-Cookie que zera a sessão) e a serve
    // para outro pedido, deslogando quem não pediu.
    expect((await logout()).headers.get("cache-control")).toContain("no-store");
    expect((await logout("text/plain")).headers.get("cache-control")).toContain("no-store");
  });
});
