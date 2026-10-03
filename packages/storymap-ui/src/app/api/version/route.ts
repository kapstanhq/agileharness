// GET /api/version — a versão da FERRAMENTA que está no ar, com prova: {tag, sha, at, prev} do recibo que o
// `contrib/ah-release` grava em `dist/ah-version.json` no swap, mais o estado do serviço (desde quando roda e a última
// leitura de saúde). É a pergunta que faltava: «o serviço vivo roda a tag que eu acabei de liberar?».
//
// A RESPOSTA É A DO PROCESSO, NÃO A DO DISCO (tool-version.ts). O recibo é lido UMA vez, no boot, e só vale se o BUILD_ID
// dele for o do build carregado; o recibo que estiver no disco agora e for outro sai em `pendingRestart` (o swap
// aconteceu, o restart não). Ler o disco a cada request fazia o processo velho «confirmar» a tag nova depois de um release
// interrompido antes do restart — e o ah-release imprimia «conferido» sobre uma versão que não rodava.
//
// POR QUE EXISTE (e por que não é o `/api/health`). O `/api/health` é magro de propósito — um probe sem credencial não
// pode contar versão, commit nem estado a quem estiver sondando (é reconhecimento de graça). Provar a versão exige uma
// rota AUTENTICADA; o `ah-release` a consulta depois do restart e, se a versão viva não for a tag, volta ao bundle
// anterior. Sem ela, um swap digitado à mão podia deixar o bundle de uma versão com o `.next` de outra e nada acusava.
//
// AUTH: `Authorization: Bearer <token>` de um token MCP de nível >= `ro` (o primário, um tier de `settings.mcpTokens` ou um
// handle), pela MESMA porta das rotas do runner (`authorizeRunnerRequest`: compara primeiro, trava por origem, rastro em toda
// recusa). A diferença deliberada: `?secret=` NÃO é aceito aqui. As rotas do runner o toleram por compatibilidade com a
// automação que já existia; esta é nova, e uma credencial na query vazaria em log de acesso e de proxy.
//
// SOMENTE LEITURA: não mede nada (a saúde vem da última leitura gravada, lida do FIM do ledger) e não escreve.

import { NextResponse } from "next/server";
import { legacyMcpTokenTiers } from "@/lib/auth/mcp-handle";
import { PERIMETER_SURFACES } from "@/lib/auth/auth-audit";
import { readLastHealthRecord } from "@/lib/storymap/health/health-deps";
import { lastReadingSummary } from "@/lib/storymap/health/health-view";
import { readLiveToolVersion } from "@/lib/storymap/tool-version";
import { authorizeRunnerRequest, readRunnerCredential, type RunnerSurfaceAuth } from "../runner/perimeter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A superfície no mapa do perímetro: leitura (`ro`), aceitando os tiers escopados que o MCP aceita. */
const VERSION_SURFACE: RunnerSurfaceAuth = { path: PERIMETER_SURFACES.version, minLevel: "ro", tiers: legacyMcpTokenTiers };

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(request: Request): Promise<Response> {
  // Credencial na query string: recusada sem nem comparar (e sem contar na trava — não é uma tentativa de adivinhar, é um
  // cliente que usa o carregador errado). O header é o único carregador desta rota.
  const presented = readRunnerCredential(request);
  if (presented.value && presented.via === "query") {
    return NextResponse.json({ ok: false, error: "credencial na query string não é aceita aqui — use `Authorization: Bearer`" }, { status: 401, headers: NO_STORE });
  }

  const auth = await authorizeRunnerRequest(request, VERSION_SURFACE);
  if (!auth.ok) return auth.response;

  const { running, pending } = readLiveToolVersion();
  const { version, reason } = running;
  const lastReading = await readLastHealthRecord().catch(() => null);

  return NextResponse.json(
    {
      ok: true,
      tag: version?.tag ?? null,
      sha: version?.sha ?? null,
      at: version?.at ?? null,
      prev: version?.prev ?? null,
      // O build que roda (o mesmo id que o Next já expõe em `/_next/static/<id>/`): o release confere a tag E o build, o
      // que separa até duas liberações da MESMA tag (`--force`).
      buildId: version?.buildId ?? null,
      // Sem recibo (build de desenvolvimento, build manual) ou com um recibo que não é o do build carregado (self-deploy,
      // troca manual), a resposta é honesta: tag nula e o motivo — nunca um número inventado.
      reason,
      // O release que está no disco e ainda não roda: o restart não veio depois do swap.
      pendingRestart: pending ? { tag: pending.tag, sha: pending.sha, at: pending.at } : null,
      service: {
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        uptimeSec: Math.round(process.uptime()),
        health: lastReadingSummary(lastReading),
      },
    },
    { headers: NO_STORE },
  );
}
