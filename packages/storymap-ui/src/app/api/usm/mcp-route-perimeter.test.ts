// OS ATAQUES QUE A ROTA MCP PRECISA IMPEDIR (story-h8tmzh + a trava/rastro de story-m9jflb).
//
// Esta é a superfície de MAIOR privilégio do sistema: o próprio cabeçalho da rota declara que as
// tools que ela monta spawnam `claude --dangerously-skip-permissions` na máquina. E a credencial dela
// VIAJA NO PATH — o que produziu dano MEDIDO (story-u4yf1i): 174 gravações do token em texto claro,
// 168 no journal do Caddy e 6 em `/var/log/syslog*`, entre 2026-06-06 e 2026-07-29, pelo logger de
// ERRO DEFAULT do Caddy. Não houve misconfiguração: enquanto a credencial FOR o path, todo
// intermediário tem a oportunidade de gravá-la, e o default de um deles já gravou.
//
// Antes desta onda a rota tinha duas lacunas, as duas exercitadas abaixo:
//
//   1. NÃO HAVIA COMO REVOGAR. A única credencial aceita era o valor de uma env var, e trocá-la exige
//      reiniciar o serviço — o que o guardrail do projeto proíbe fazer sem autorização. Na prática a
//      rotação estava TRAVADA, e foi por isso que o token vazado ficou vivo 54 dias.
//   2. A RECUSA ERA CEGA. O comentário da rota admitia recusar "with nothing logged": seis GETs com
//      credencial errada não geravam UMA linha, então uma invasão em curso era 100% invisível.
//
// Cada `it` descreve UMA tentativa de abuso, não uma função. E dois deles são o contrário — provam que
// o dono NÃO perdeu capacidade: o token legado do conector dele continua entrando, e a trava não o
// tranca de fora quando ele erra abaixo do teto.

import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O handler MCP é substituído por um espelho do ATOR: a rota é o que está sob teste, não o protocolo.
 *
 * Devolver `currentMcpActor()` no corpo da resposta é o que prova a fiação inteira de uma vez — a
 * credencial resolveu, o nível certo foi baked, e a identidade viajou pelo AsyncLocalStorage até onde
 * o guard por chamada e o ledger a leem. Um mock que só respondesse 200 provaria só o portão.
 */
vi.mock("mcp-handler", () => ({
  createMcpHandler:
    (_register: unknown, _info: unknown, opts: { basePath: string }) =>
    async (): Promise<Response> => {
      const { currentMcpActor } = await import("@/lib/storymap/mcp/actor");
      const a = currentMcpActor();
      return Response.json({ level: a?.level ?? null, actor: a?.tokenEnv ?? null, basePath: opts.basePath });
    },
}));

// A superfície de tools não participa de nenhuma asserção daqui, e montá-la de verdade arrastaria o
// engine/child_process para dentro de um teste de autenticação.
vi.mock("@/lib/storymap/mcp/tools", () => ({ registerStorymapTools: () => {} }));
vi.mock("@/lib/storymap/mcp/dev-tools", () => ({ registerDevTools: () => {} }));
vi.mock("@/lib/storymap/mcp/onboarding", () => ({
  registerOnboarding: () => {},
  MCP_INSTRUCTIONS: "instruções",
}));
vi.mock("@/lib/storymap/mcp/register", () => ({ setServerLevel: () => {} }));

/**
 * A resolução FORJADA — o cenário do último portão (ver o `it` correspondente).
 *
 * O módulo real é preservado por `importOriginal`; só `resolveMcpCredential` passa a poder ser
 * desviado, e SÓ quando um teste o pede. É lido tarde (na chamada), não na fábrica, então a
 * hoisting do `vi.mock` não o alcança na zona morta.
 */
let resolucaoForjada: { ok: true; credential: McpCredential } | null = null;

vi.mock("@/lib/auth/mcp-handle", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/mcp-handle")>();
  return {
    ...real,
    resolveMcpCredential: (apresentado: string, opts?: Parameters<typeof real.resolveMcpCredential>[1]) =>
      resolucaoForjada ? Promise.resolve(resolucaoForjada) : real.resolveMcpCredential(apresentado, opts),
  };
});

import { PERIMETER_POLICY, authFailuresPath, flushAuthFailures, readAuthFailures, resetPerimeterState } from "@/lib/auth/auth-audit";
import { createMcpHandle, flushHandleTouches, revokeMcpHandle, type McpCredential } from "@/lib/auth/mcp-handle";
import { POST } from "@/app/api/usm/[secret]/[transport]/route";

const TOKEN_ENV = "AGILEHARNESS_MCP_TOKEN";

/** Um token legado FORTE, no formato que `--generate-mcp-token` produz (32 bytes em base64url). */
const TOKEN_LEGADO = "wA7fQ2mZ9pX4vK1sT6bR8yL3nC5hJ0dG-eU_iO2aP4Q";

let dirAnterior: string | undefined;
let dirDoTeste = "";
let tokenAnterior: string | undefined;

beforeEach(() => {
  dirAnterior = process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  tokenAnterior = process.env[TOKEN_ENV];
  // Estado do runner PRÓPRIO por teste: o rastro de um caso não pode ser lido pelo seguinte.
  dirDoTeste = mkdtempSync(path.join(tmpdir(), "mcp-route-"));
  process.env.AGILEHARNESS_RUNNER_STATE_DIR = dirDoTeste;
  // A porta nasce FECHADA em cada caso: quem quiser o caminho legado declara a env explicitamente,
  // como uma instalação de verdade faz.
  delete process.env[TOKEN_ENV];
  resetPerimeterState();
  resolucaoForjada = null;
});

afterEach(async () => {
  // Drenar ANTES de devolver o dir: o append resolve o caminho no momento da escrita, então trocar o
  // dir com escrita pendente jogaria a linha no estado do teste seguinte.
  await flushAuthFailures();
  await flushHandleTouches();
  resolucaoForjada = null;
  if (dirAnterior === undefined) delete process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  else process.env.AGILEHARNESS_RUNNER_STATE_DIR = dirAnterior;
  if (tokenAnterior === undefined) delete process.env[TOKEN_ENV];
  else process.env[TOKEN_ENV] = tokenAnterior;
  // Só DEPOIS da drenagem acima: apagar antes trocaria o diretório órfão por um erro de escrita.
  rmSync(dirDoTeste, { recursive: true, force: true });
});

/**
 * Um request como o Next o entrega: o segmento de path já percent-encodado (o App Router NÃO decodifica
 * params) e o XFF como o Caddy desta instalação o escreve — ele SUBSTITUI o header pelo peer real.
 */
function chamar(credencial: string, ip: string): Promise<Response> {
  const seg = encodeURIComponent(credencial);
  const req = new Request(`https://ah.example/api/usm/${seg}/mcp`, {
    method: "POST",
    headers: { "x-forwarded-for": ip },
  });
  return POST(req, { params: Promise.resolve({ secret: seg, transport: "mcp" }) });
}

/** O rastro durável, já drenado. */
async function rastro() {
  await flushAuthFailures();
  return readAuthFailures();
}

/**
 * Toda janela de 8 chars de `segredo` — a varredura que prova que nem um PEDAÇO dele sobrou no rastro.
 * 8 e não 4 porque o arquivo carrega ids hex e uma janela curta casaria por sorte, fazendo o teste piscar.
 */
function janelas(segredo: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 8 <= segredo.length; i++) out.push(segredo.slice(i, i + 8));
  return out;
}

describe("ATAQUE: usar a credencial que vazou no log de um intermediário", () => {
  it("o handle revogado deixa de entrar NO REQUEST SEGUINTE — sem o restart que o guardrail proíbe", async () => {
    const { handle, record } = await createMcpHandle({ level: "full", label: "conector do chat web" });

    // Cenário do dano: o valor apareceu no journal do proxy e alguém o copiou. Enquanto vivo, ele entra
    // — um handle no path é credencial portadora como qualquer outra, e chamá-lo de "público" seria teatro.
    const vivo = await chamar(handle, "198.51.100.10");
    expect(vivo.status).toBe(200);
    expect(await vivo.json()).toMatchObject({ level: "full", actor: `handle:${record.id}` });

    // A CONTENÇÃO: o operador revoga. Nada é reiniciado, nada é rotacionado.
    expect(await revokeMcpHandle(record.id)).toBe("revogado");

    const queimado = await chamar(handle, "198.51.100.10");
    // 404 NU, exatamente como uma rota inexistente: a revogação não pode virar o oráculo que confirma
    // que o endpoint existe (era a postura correta antes desta onda e continua sendo).
    expect(queimado.status).toBe(404);
    expect(queimado.headers.get("retry-after")).toBeNull();

    // Do lado de DENTRO, a recusa é nomeada: um handle revogado reapresentado é vazamento EM USO, e o
    // rastro precisa distinguir isso de um scanner qualquer.
    const linhas = await rastro();
    expect(linhas.at(-1)).toMatchObject({
      surface: "/api/usm",
      via: "path",
      reason: "handle-revogado",
      handleId: record.id,
      client: "198.51.100.10",
    });
  });

  it("o handle vazado pode NÃO carregar a autoridade máxima — o nível vem dele, não da rota", async () => {
    // A segunda propriedade que o env var não tem: escopo. `full` continua podendo ser emitido (contenção
    // que custasse autonomia estaria errada), mas o conector que só lê pode receber `ro`.
    const { handle, record } = await createMcpHandle({ level: "ro", label: "leitura" });
    const r = await chamar(handle, "198.51.100.11");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ level: "ro", actor: `handle:${record.id}` });
  });

  it("nem um PEDAÇO da credencial tentada entra no rastro (foi assim que o Caddy vazou 174×)", async () => {
    // O ATAQUE aqui é contra o operador, não contra a porta: se o NOSSO arquivo forense gravasse o valor
    // tentado, teríamos reproduzido dentro de casa o defeito do logger de erro default do proxy — e o
    // rastro de segurança viraria a nova fonte de vazamento.
    const tentado = "ahk_0123456789ab.ZZZtentativaDeAtacanteQueNaoDeveVazar123";
    const r = await chamar(tentado, "203.0.113.5");
    expect(r.status).toBe(404);

    await flushAuthFailures();
    const bruto = await readFile(authFailuresPath(), "utf8");
    for (const janela of janelas(tentado)) expect(bruto).not.toContain(janela);
    // O que sobra é o COMPRIMENTO — que o formato do token já anuncia — e mais nada.
    expect((await rastro()).at(-1)).toMatchObject({ presented: `<oculto: ${tentado.length} chars>` });
  });
});

describe("ATAQUE: varrer a URL até achar a credencial", () => {
  it("a origem TRANCA, a resposta segue muda, e a rajada deixa de ser invisível", async () => {
    const ip = "203.0.113.66";
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i++) {
      const r = await chamar(`tentativa-numero-${i}-de-um-scanner-qualquer`, ip);
      expect(r.status).toBe(404);
    }

    // Já trancada. A resposta NÃO muda de forma: 404 nu, sem `Retry-After` — o header confirmaria que
    // existe algo ali, e a trava não pode contar o que a recusa se recusa a contar.
    const depois = await chamar("mais-uma-tentativa-do-mesmo-scanner", ip);
    expect(depois.status).toBe(404);
    expect(depois.headers.get("retry-after")).toBeNull();

    const linhas = (await rastro()).filter((l) => l.client === ip);
    expect(linhas.length).toBeGreaterThan(0);
    // A linha que TRANCOU está no arquivo, e a tentativa recebida já trancado é nomeada — é isso que
    // torna a invasão em curso reconstruível depois de um restart.
    expect(linhas.some((l) => l.locked && l.reason === "desconhecida")).toBe(true);
    expect(linhas.some((l) => l.reason === "trancado")).toBe(true);
  });
});

describe("ATAQUE: trancar a origem para DESLIGAR o conector do dono", () => {
  it("origem TRANCADA + credencial VÁLIDA continua entrando — a trava não é interruptor de DoS", async () => {
    // O ATAQUE, e é de graça: o balde da trava é UM por origem para o perímetro inteiro (é o que impede
    // rotacionar de rota e multiplicar o orçamento por seis), e há três topologias REAIS em que o
    // atacante e o dono dividem a MESMA chave — self-host sem proxy (todos caem em `sem-proxy`), NAT
    // compartilhado, CDN na frente do Caddy. Bastava um anônimo martelar qualquer superfície de máquina
    // para o conector do chat web do dono passar a levar 404 com a credencial CERTA na mão: qualquer
    // pessoa na internet desligava a superfície MCP por até 60 minutos. A defesa não é aumentar o teto —
    // é COMPARAR A CREDENCIAL PRIMEIRO, e só então deixar a trava decidir.
    process.env[TOKEN_ENV] = TOKEN_LEGADO;
    const ip = "203.0.113.77";
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i += 1) {
      expect((await chamar(`anonimo-martelando-${i}`, ip)).status).toBe(404);
    }

    const dono = await chamar(TOKEN_LEGADO, ip);
    expect(dono.status, "a trava recusou a credencial válida do dono — DoS contra o próprio agente").toBe(200);
    expect(await dono.json()).toMatchObject({ level: "full", actor: TOKEN_ENV });
  });

  it("a recusa por TRAVA é indistinguível da recusa por credencial — a trava não vira oráculo", async () => {
    // O ATAQUE de reconhecimento: se a resposta mudasse de forma ao trancar (429, `Retry-After`, outro
    // corpo), o atacante saberia que existe algo ali E que ele encostou num controle — e a postura desta
    // rota é justamente NÃO confirmar que o endpoint existe. As duas recusas têm de ser o MESMO byte.
    const ip = "203.0.113.78";
    const porCredencial = await chamar("chute-com-a-origem-limpa", ip);
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i += 1) await chamar(`enchendo-o-balde-${i}`, ip);
    const porTrava = await chamar("chute-com-a-origem-trancada", ip);

    expect(porTrava.status).toBe(porCredencial.status);
    expect(porTrava.status).toBe(404);
    expect(porTrava.headers.get("retry-after")).toBeNull();
    expect(await porTrava.text()).toBe(await porCredencial.text());

    // Do lado de DENTRO a diferença existe e é nomeada — é o que o forense precisa.
    const linhas = (await rastro()).filter((l) => l.client === ip);
    expect(linhas.some((l) => l.reason === "desconhecida")).toBe(true);
    expect(linhas.some((l) => l.reason === "trancado")).toBe(true);
  });
});

describe("CUSTO DE AUTONOMIA: o dono não pode perder o que já tinha", () => {
  it("COMPATIBILIDADE: o token do env que o conector do dono usa hoje continua autenticando", async () => {
    // Quebrar isto pararia o conector do chat web — a única superfície que NÃO consegue mandar bearer
    // header. Seria remoção de capacidade disfarçada de hardening, e é o desfecho proibido desta onda.
    process.env[TOKEN_ENV] = TOKEN_LEGADO;
    const r = await chamar(TOKEN_LEGADO, "198.51.100.20");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      level: "full",
      // O ator no ledger continua sendo o NOME DA ENV, cru. `noop-attribution.ts` casa esse campo por
      // igualdade com o tokenEnv do run — reescrevê-lo como rótulo quebraria a atribuição do copiloto.
      actor: TOKEN_ENV,
      // E o endpoint derivado da URL colada continua o mesmo, senão o conector do dono deixaria de casar.
      basePath: `/api/usm/${TOKEN_LEGADO}`,
    });
  });

  it("errar abaixo do teto não tranca o dono de fora — e acertar PERDOA a janela", async () => {
    // O operador com um token velho colado erra algumas vezes antes de perceber. A trava não pode
    // transformar isso em "espere 1 minuto para usar seu próprio board".
    process.env[TOKEN_ENV] = TOKEN_LEGADO;
    const ip = "198.51.100.21";
    for (let i = 0; i < PERIMETER_POLICY.maxFailures - 1; i++) {
      expect((await chamar(`token-velho-${i}`, ip)).status).toBe(404);
    }
    expect((await chamar(TOKEN_LEGADO, ip)).status).toBe(200);

    // Perdoada: depois do acerto ele tem a janela inteira de novo, em vez de carregar um backoff.
    for (let i = 0; i < PERIMETER_POLICY.maxFailures - 1; i++) {
      expect((await chamar(`erro-depois-do-acerto-${i}`, ip)).status).toBe(404);
    }
    expect((await chamar(TOKEN_LEGADO, ip)).status).toBe(200);
  });
});

describe("ÚLTIMO PORTÃO: o piso de força vale mesmo se a resolução regredir", () => {
  it("uma credencial legada que os pisos recusam NÃO autentica, mesmo dada como válida pela resolução", async () => {
    // O ATAQUE é de FUTURO, e concreto: a resolução da credencial saiu deste arquivo para
    // `lib/auth/mcp-handle.ts`, e a função dela aceita um MAPA DE AMBIENTE injetado. Uma edição que
    // passe o mapa errado — ou que afrouxe o piso lá — publicaria um segredo adivinhável na superfície
    // que spawna `claude --dangerously-skip-permissions`. Quem decide por REQUISIÇÃO tem de continuar
    // sendo `isMcpTokenValid`, contra o `process.env` deste serviço.
    process.env[TOKEN_ENV] = "senha-do-operador"; // < 32 chars: `secretWeakness` diz "curto"
    resolucaoForjada = { ok: true, credential: { level: "full", via: "token-legado", tokenEnv: TOKEN_ENV } };

    const r = await chamar("senha-do-operador", "203.0.113.90");
    expect(r.status).toBe(404);
    // E a recusa é nomeada como o que ela é — porta fechada por SETUP, não scanner. É a diferença entre
    // "estou sendo varrido" e "meu conector nunca vai funcionar", lida do mesmo arquivo.
    expect((await rastro()).at(-1)).toMatchObject({ reason: "token-fraco", surface: "/api/usm" });
  });
});
