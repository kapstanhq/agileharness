// OS ATAQUES QUE A PORTA DAS 4 ROTAS `/api/runner/*` PRECISA IMPEDIR (story-m9jflb).
//
// Estas quatro superfícies dividem UMA régua (`authorizeRunnerRequest`), e duas delas MUTAM o
// pipeline: `deploy-webhook` reverte card e avança para terminal, `test-webhook` retoma a cascata.
// Foi `/api/runner/pulse` que reproduziu ao vivo o defeito original — 6 GETs com `secret` errado →
// `401,401,401,401,401,401`, e `journalctl -u storymap` no mesmo minuto dizendo `-- No entries --`.
//
// O ataque que ESTE arquivo passou a cobrir é o do lado OPOSTO, e é o que a onda 2.5 construiu e
// deixou desfiado: com a trava consultada ANTES da comparação, um anônimo que martelasse qualquer
// superfície do perímetro trancava a origem e o monitor autônomo do DONO — que compartilha a chave de
// trava com ele em três topologias reais (self-host sem proxy, NAT compartilhado, CDN na frente do
// Caddy) — passava a levar 429 com o token CERTO na mão. Negação de serviço contra o próprio agente,
// de graça, para qualquer pessoa na internet. Cada `it` abaixo nomeia a tentativa de abuso; os dois
// últimos são o contrário — provam que o dono não perdeu nada.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PERIMETER_POLICY,
  PERIMETER_SURFACES,
  flushAuthFailures,
  readAuthFailures,
  recordAuthFailure,
  resetPerimeterState,
} from "@/lib/auth/auth-audit";
import { createMcpHandle, flushHandleTouches } from "@/lib/auth/mcp-handle";
import { MCP_TOKEN_ENV } from "@/lib/storymap/mcp/token-bootstrap";

import {
  RUNNER_SURFACE_AUTH,
  authorizeRunnerRequest,
  resetQueryDeprecationNotice,
  type RunnerSurfaceAuth,
} from "./perimeter";

/** Um token do operador FORTE, no formato que `--generate-mcp-token` produz (32 bytes em base64url). */
const TOKEN = "qW3rT6yU9iO2pA5sD8fG1hJ4kL7zX0cV-bN_mQ2eR4T";

let dirAnterior: string | undefined;
let dirDoTeste = "";
let tokenAnterior: string | undefined;

beforeEach(() => {
  dirAnterior = process.env.STORYMAP_RUNNER_STATE_DIR;
  tokenAnterior = process.env[MCP_TOKEN_ENV];
  // Estado do runner PRÓPRIO por teste: nenhum caso lê o rastro do vizinho nem escreve no do serviço.
  dirDoTeste = mkdtempSync(path.join(tmpdir(), "runner-perimeter-"));
  process.env.STORYMAP_RUNNER_STATE_DIR = dirDoTeste;
  process.env[MCP_TOKEN_ENV] = TOKEN;
  resetPerimeterState();
  resetQueryDeprecationNotice();
});

afterEach(async () => {
  // Drenar ANTES de devolver o dir: o append resolve o caminho na hora da escrita, então trocar o dir
  // com escrita pendente jogaria a linha no estado do teste seguinte.
  await flushAuthFailures();
  await flushHandleTouches();
  if (dirAnterior === undefined) delete process.env.STORYMAP_RUNNER_STATE_DIR;
  else process.env.STORYMAP_RUNNER_STATE_DIR = dirAnterior;
  if (tokenAnterior === undefined) delete process.env[MCP_TOKEN_ENV];
  else process.env[MCP_TOKEN_ENV] = tokenAnterior;
  // Só DEPOIS da drenagem acima: apagar antes trocaria o diretório órfão por um erro de escrita.
  rmSync(dirDoTeste, { recursive: true, force: true });
});

/** Um request como o monitor do dono o faz: Bearer preferido, `?secret=` legado, XFF do Caddy. */
function chamar(opts: {
  ip: string;
  bearer?: string;
  secret?: string;
  surface?: RunnerSurfaceAuth;
}): ReturnType<typeof authorizeRunnerRequest> {
  const url = new URL("https://ah.example/api/runner/pulse");
  if (opts.secret !== undefined) url.searchParams.set("secret", opts.secret);
  const headers = new Headers({ "x-forwarded-for": opts.ip });
  if (opts.bearer !== undefined) headers.set("authorization", `Bearer ${opts.bearer}`);
  return authorizeRunnerRequest(new Request(url, { headers }), opts.surface ?? RUNNER_SURFACE_AUTH.pulse);
}

/**
 * Tranca a origem `ip` do jeito que um ATACANTE tranca: martelando OUTRA superfície do perímetro.
 *
 * O balde é UM por origem para o perímetro inteiro (é o que impede rotacionar de rota e multiplicar o
 * orçamento por seis), então a trava que o anônimo cria no `/login` é a mesma que o monitor do dono
 * encontra no `/pulse`. É exatamente essa propriedade que transforma a ordem trava→compara em DoS.
 */
function trancarOrigem(ip: string): void {
  for (let i = 0; i < PERIMETER_POLICY.maxFailures; i += 1) {
    recordAuthFailure({
      headers: new Headers({ "x-forwarded-for": ip }),
      surface: PERIMETER_SURFACES.login,
      via: "body",
      reason: "desconhecida",
    });
  }
}

/** O rastro durável, já drenado. */
async function rastro() {
  await flushAuthFailures();
  return readAuthFailures();
}

describe("ATAQUE: trancar a origem para DESLIGAR o monitor autônomo do dono", () => {
  it("origem TRANCADA + token CERTO continua autenticando — a trava não é interruptor de DoS", async () => {
    // O ATAQUE: qualquer anônimo gasta o orçamento da origem (aqui, no `/login`) e o monitor do dono,
    // que divide a chave de trava com ele, para de conseguir pollar o próprio board — sem que nada do
    // lado dele tenha mudado. A defesa não é "aumentar o teto": é COMPARAR A CREDENCIAL PRIMEIRO.
    const ip = "203.0.113.10";
    trancarOrigem(ip);

    const dono = await chamar({ ip, bearer: TOKEN });
    expect(dono.ok, "a trava recusou o token válido do dono — DoS contra o próprio agente").toBe(true);
    if (dono.ok) expect(dono.credential.level).toBe("full");
  });

  it("o acerto durante o bloqueio PERDOA a janela — o dono não fica arrastando backoff alheio", async () => {
    // Sem isto, o dono entraria uma vez e continuaria trancado no request seguinte: a trava do atacante
    // sobreviveria ao acerto e o DoS voltaria em regime.
    const ip = "203.0.113.11";
    trancarOrigem(ip);
    expect((await chamar({ ip, bearer: TOKEN })).ok).toBe(true);

    // Janela inteira de novo: as 8 tentativas erradas seguintes ainda são recusa por CREDENCIAL (401),
    // não recusa por trava herdada.
    for (let i = 0; i < PERIMETER_POLICY.maxFailures - 1; i += 1) {
      const r = await chamar({ ip, bearer: `chute-${i}` });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.response.status, `tentativa ${i + 1} depois do acerto`).toBe(401);
    }
  });
});

describe("ATAQUE: martelar as 4 rotas do runner até achar o token", () => {
  it("a origem TRANCA, a recusa vira 429 com Retry-After, e a rajada deixa de ser invisível", async () => {
    const ip = "203.0.113.20";
    for (let i = 0; i < PERIMETER_POLICY.maxFailures - 1; i += 1) {
      const r = await chamar({ ip, secret: `tentativa-${i}-de-um-scanner` });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.response.status, `tentativa ${i + 1} deveria ser 401, não 429 antes da hora`).toBe(401);
    }

    // A falha que TRANCA já sai como 429: estas rotas são `declarada` (já admitiam existir com 401),
    // então o `Retry-After` não conta nada novo — e ensina o cliente legítimo a esperar em vez de
    // martelar, na hora, em vez de descobrir no request seguinte.
    const trancou = await chamar({ ip, secret: "a-tentativa-que-estoura-o-teto" });
    expect(trancou.ok).toBe(false);
    if (!trancou.ok) {
      expect(trancou.response.status).toBe(429);
      expect(trancou.response.headers.get("retry-after")).toBeTruthy();
    }

    // A insistência com a origem já trancada CONTINUA sendo contada e nomeada — é isso que torna uma
    // invasão em curso reconstruível depois de um restart.
    const insistiu = await chamar({ ip, secret: "mais-uma-do-mesmo-scanner" });
    expect(insistiu.ok).toBe(false);
    if (!insistiu.ok) expect(insistiu.response.status).toBe(429);

    const linhas = (await rastro()).filter((l) => l.client === ip);
    expect(linhas.some((l) => l.surface === PERIMETER_SURFACES.runnerPulse && l.locked)).toBe(true);
    expect(linhas.some((l) => l.reason === "trancado")).toBe(true);
    // E nenhuma linha carrega o valor tentado — só o comprimento.
    for (const l of linhas) expect(JSON.stringify(l)).not.toContain("scanner");
  });

  it("request SEM credencial nenhuma é registrado como `ausente`, não como chute", async () => {
    const r = await chamar({ ip: "203.0.113.21" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
    expect((await rastro()).at(-1)).toMatchObject({
      surface: PERIMETER_SURFACES.runnerPulse,
      reason: "ausente",
      client: "203.0.113.21",
    });
  });
});

describe("ESCALADA POR HANDLE ESCOPADO: um handle de leitura não dirige o deploy", () => {
  it("handle `ro` é recusado no webhook que MUTA — e a linha diz qual handle pediu o que não tem", async () => {
    // O ATAQUE: um handle emitido para o monitor LER `/pulse` vaza no log de um proxy e é usado para
    // POSTar no `deploy-webhook`, que reverte card, avança para terminal e retoma a cascata. O nível
    // mínimo por superfície é o que impede que uma credencial de leitura vire controle do pipeline —
    // e é o controle mais fácil de perder numa migração de portão.
    const { handle, record } = await createMcpHandle({ level: "ro", label: "monitor de leitura" });

    const leitura = await chamar({ ip: "203.0.113.30", bearer: handle });
    expect(leitura.ok, "o handle `ro` tem de continuar LENDO o pulse — ele foi emitido para isso").toBe(true);

    const escalada = await chamar({
      ip: "203.0.113.30",
      bearer: handle,
      surface: RUNNER_SURFACE_AUTH.deployWebhook,
    });
    expect(escalada.ok).toBe(false);
    if (!escalada.ok) expect(escalada.response.status).toBe(401);
    expect((await rastro()).at(-1)).toMatchObject({
      surface: PERIMETER_SURFACES.runnerDeployWebhook,
      handleId: record.id,
      levelWanted: "orch",
    });
  });
});

describe("CUSTO DE AUTONOMIA: o dono não pode perder o que já tinha", () => {
  it("COMPATIBILIDADE: os DOIS carregadores continuam autenticando (o `?secret=` do monitor vivo)", async () => {
    // Existe automação VIVA do dono batendo por query (o monitor pollando `/pulse`, o `curl` do
    // self-deploy POSTando o settle). Exigir reconfiguração seria remoção de capacidade disfarçada de
    // hardening — o desfecho proibido desta onda.
    const porHeader = await chamar({ ip: "198.51.100.50", bearer: TOKEN });
    expect(porHeader.ok).toBe(true);
    if (porHeader.ok) expect(porHeader.via).toBe("header");

    const porQuery = await chamar({ ip: "198.51.100.51", secret: TOKEN });
    expect(porQuery.ok).toBe(true);
    if (porQuery.ok) expect(porQuery.via).toBe("query");

    // Nenhum acerto gera linha no rastro: ele é o arquivo das RECUSAS, e uma linha por poll o afogaria.
    expect(await rastro()).toEqual([]);
  });
});
