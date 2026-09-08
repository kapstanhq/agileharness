// Liveness SEM segredo — o único 200 que o serviço dá a quem não tem sessão.
//
// Existe porque o portão (src/middleware.ts) passou a redirecionar a raiz para /login, e
// `runner/stack-health.ts` faz `probeGet` com `redirect: "manual"` aceitando só `res.ok`: um 307
// marcaria o próprio serviço como DOENTE. Aponte monitores externos para cá, não para `/`.
//
// O corpo é deliberadamente magro: um probe não autenticado não conta versão, commit, board nem
// contagem de runs — isso é reconhecimento de graça para quem estiver sondando.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return NextResponse.json({ ok: true, service: "agileharness" });
}
