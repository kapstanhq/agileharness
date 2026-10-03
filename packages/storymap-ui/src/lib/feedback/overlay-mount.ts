// ONDE o overlay de feedback deve ser montado — e como o layout descobre a rota.
//
// O overlay (`public/ah-overlay.js`) é injetado pelo ROOT layout, que no App Router não conhece o
// pathname. Enquanto isso não importava, ele ia em toda página. Passou a importar quando o portão
// de autenticação entrou: em `/login` o script é um recurso GATEADO, então o middleware o
// redirecionava para `/login` e o navegador recusava o HTML como se fosse JS
// (`net::ERR_BLOCKED_BY_ORB`) — uma requisição falhada a cada carregamento da tela de login.
//
// Havia duas saídas e a tentadora é a errada: liberar `/ah-overlay.js` no portão faria a requisição
// passar, mas aí o botão "Marcar ajuste" apareceria NA TELA DE LOGIN, apontando para endpoints que
// exigem sessão. O overlay não tem o que fazer antes de você entrar — o certo é não montá-lo.
//
// O layout descobre a rota por um header que o middleware carimba no request (o padrão do Next
// para levar o pathname a um server component). O contrato entre os dois vive AQUI, para não haver
// uma string mágica em cada ponta.

import { isPublicPath } from "@/lib/auth/public-routes";

/** Header que `src/middleware.ts` carimba no request e o root layout lê via `headers()`. */
export const PATHNAME_HEADER = "x-ah-pathname";

/**
 * Montar o overlay nesta rota?
 *
 * A régua é a MESMA do portão (`isPublicPath`), não um `=== "/login"` cravado: rota pública é
 * exatamente aquela que se alcança sem sessão, e é exatamente onde o overlay não tem contexto nem
 * permissão para trabalhar. Uma tela pública futura herda o comportamento certo de graça.
 *
 * Pathname DESCONHECIDO (header ausente — um caminho que não passou pelo middleware) monta, que é
 * o comportamento histórico: se o carimbo falhar, o pior resultado é o overlay de volta onde já
 * estava, nunca o overlay sumindo do app inteiro em silêncio.
 */
export function shouldMountOverlay(pathname: string | null | undefined): boolean {
  if (!pathname) return true;
  return !isPublicPath(pathname);
}
