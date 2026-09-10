// O SELF-CHECK DE BOOT quando o bind sai do loopback — o ATAQUE que este arquivo descreve.
//
// O AgileHarness escuta em 127.0.0.1 por default, e isso está CERTO. O que não existia era guarda
// para o caso em que alguém abre o bind: `AGILEHARNESS_HOST=0.0.0.0` subia CALADO, e o único sinal
// era o log de `listen` — que imprime o host como informação neutra. Numa VPS sem firewall (o
// incidente MEDIDO de 2026-07-27, documentado no topo de `main.ts`), o que fica na internet não é
// "um board": é `/login` (token do operador), `/api/usm/<token>/mcp` — cujas tools spawnam
// `claude --dangerously-skip-permissions` nesta máquina — e `/terminal` (um shell).
//
// Todas essas superfícies são fail-closed, então ninguém entra SEM credencial. O ataque não é a
// ausência de credencial: é a credencial ADIVINHÁVEL. `AGILEHARNESS_AUTH_TOKEN=changeme-changeme-
// changeme-change` tem 33 chars, passa o ÚNICO teste que existia (piso de 32) e vale o serviço
// inteiro — e é exatamente o que um `docker-compose.yml` de tutorial, uma imagem de container ou um
// script de deploy copiam sem pensar. Os casos abaixo atacam por essa porta.
//
// O primeiro caso roda o BOOT DE VERDADE: importa o entrypoint com o `next` trocado por um dublê
// cujo `prepare()` EXPLODE. Assim, qualquer regressão que deixe o boot seguir aparece como
// "prepare foi chamado" em vez de subir um servidor de mentira — e nunca chega a um `listen`.

import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_SECRET_ENV, TOKEN_ENV, type EnvLike } from "@/lib/auth/env";

/**
 * O dublê do Next. `prepare()` lança de propósito: o boot que passa pelo self-check NÃO deve seguir
 * dentro de um teste (o passo seguinte seria `server.listen`, numa máquina que já roda o serviço).
 */
const prepare = vi.fn(async (): Promise<void> => {
  throw new Error("SENTINELA — prepare() do Next foi chamado");
});

vi.mock("next", () => ({
  default: () => ({ prepare, getRequestHandler: () => () => undefined }),
}));

/** 33 chars: passa o piso de 32 e é adivinhável — o default de fábrica que o plano OSS não quer. */
const ADIVINHAVEL = "changeme-changeme-changeme-change";

/** Um segredo de verdade, gerado na hora — nada de literal opaco num arquivo versionado. */
const forte = (): string => randomBytes(32).toString("base64url");

const ENVS_TOCADAS = [
  "AGILEHARNESS_HOST",
  "AGILEHARNESS_PORT",
  "AGILEHARNESS_DEV",
  "AGILEHARNESS_ALLOW_PUBLIC_BIND",
  "NODE_ENV",
  "PORT",
  "AGILEHARNESS_MCP_TOKEN",
  // O boot carrega os arquivos .env (main.ts, topo). Este arquivo não é sobre isso, e um `.env.local`
  // na máquina de quem roda a suíte mudaria o cenário — a marca do @next/env neutraliza a leitura.
  "__NEXT_PROCESSED_ENV",
  SESSION_SECRET_ENV,
  TOKEN_ENV,
] as const;

type Main = typeof import("@/server/main");
/** O mínimo que este arquivo precisa de um espião: as chamadas. Evita depender da tipagem interna. */
type Espiao = { mock: { calls: unknown[][] } };

let mod: Main;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let exit: ReturnType<typeof vi.spyOn>;
const salvo: Record<string, string | undefined> = {};

/**
 * Espera o boot ASSÍNCRONO chegar a um desfecho sem ASSERTAR nada — as asserções pertencem aos
 * casos. Um hook que falhasse aqui esconderia o vermelho de verdade atrás de "beforeAll failed".
 */
async function assentar(): Promise<void> {
  for (let i = 0; i < 200 && exit.mock.calls.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeAll(async () => {
  for (const k of ENVS_TOCADAS) salvo[k] = process.env[k];

  // O CENÁRIO DO ATAQUE: porta aberta para a rede + token do operador de fábrica.
  process.env.AGILEHARNESS_HOST = "0.0.0.0";
  process.env.AGILEHARNESS_PORT = "39117"; // porta improvável: se o boot regredir, não briga com o :3008 vivo
  process.env[TOKEN_ENV] = ADIVINHAVEL;
  delete process.env.AGILEHARNESS_DEV;
  delete process.env.AGILEHARNESS_ALLOW_PUBLIC_BIND;
  delete process.env.AGILEHARNESS_MCP_TOKEN;
  // Nada de arquivo .env neste cenário: o ambiente é o que está escrito acima, e só. A ORDEM do
  // carregamento tem arquivos próprios (`boot-env-order.test.ts`, `boot-refuses-weak-mcp-token.test.ts`).
  process.env.__NEXT_PROCESSED_ENV = "true";

  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  // `main().catch` chama process.exit(1) — sem este stub o worker do vitest morreria com o boot.
  exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

  mod = (await import("@/server/main")) as Main;
  await assentar();
});

afterAll(() => {
  // Restaura via `EnvLike` porque a lista inclui `NODE_ENV`, que os tipos do Next declaram readonly
  // (o próprio `main.ts` escreve nele com o mesmo cast, sendo o arranque do processo). O worker do
  // vitest é COMPARTILHADO entre arquivos: deixar o ambiente sujo aqui contamina a suíte vizinha.
  for (const k of ENVS_TOCADAS) {
    if (salvo[k] === undefined) delete process.env[k];
    else (process.env as EnvLike)[k] = salvo[k];
  }
  vi.restoreAllMocks();
});

/** Tudo o que um espião de console recebeu, achatado em texto — inclusive o `message` de um Error. */
const saidaDe = (spy: Espiao): string =>
  spy.mock.calls.map((args) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")).join("\n");

describe("boot com bind aberto — o serviço se recusa a virar superfície da internet", () => {
  it("porta aberta + token do operador de fábrica ⇒ o boot RECUSA (o Next nem chega a ser preparado)", () => {
    // A prova de FIAÇÃO, não de predicado: o self-check tem de rodar DEPOIS de os segredos serem
    // resolvidos (é o valor EFETIVO que autentica) e ANTES de qualquer coisa subir. Se `prepare`
    // foi chamado, o serviço estava a um passo de escutar em 0.0.0.0 com um token de tutorial.
    expect(prepare).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(saidaDe(error)).not.toContain("SENTINELA");
    expect(saidaDe(error).toLowerCase()).toContain("recusando");
  });

  it("porta aberta ⇒ um aviso alto vai para stderr nomeando o risco e o bind escolhido", () => {
    const aviso = saidaDe(warn);
    expect(aviso).toContain("0.0.0.0");
    expect(aviso.toLowerCase()).toContain("internet");
    // A mensagem é PRESCRITIVA: nomeia a env que reprovou e a válvula explícita.
    expect(aviso).toContain(TOKEN_ENV);
    expect(aviso).toContain(mod.ALLOW_PUBLIC_BIND_ENV);
  });
});

describe("auditBind — quem pode ficar de frente para a rede", () => {
  /** O ambiente MÍNIMO aprovado: bind aberto, os dois segredos fortes, produção. */
  const aberto = (extra: Record<string, string | undefined> = {}) => ({
    AGILEHARNESS_HOST: "0.0.0.0",
    [SESSION_SECRET_ENV]: forte(),
    [TOKEN_ENV]: forte(),
    ...extra,
  });

  it("aprova o bind aberto quando toda credencial alcançável é forte", () => {
    const a = mod.auditBind(aberto());
    expect(a.exposed).toBe(true);
    expect(a.failures).toEqual([]);
  });

  it("segredo de sessão adivinhável ⇒ reprova (o cookie de sessão passa a ser forjável de fora)", () => {
    const a = mod.auditBind(aberto({ [SESSION_SECRET_ENV]: ADIVINHAVEL }));
    expect(a.failures.join("\n")).toContain(SESSION_SECRET_ENV);
  });

  it("token do operador adivinhável ⇒ reprova (é a senha do /login exposto)", () => {
    const a = mod.auditBind(aberto({ [TOKEN_ENV]: ADIVINHAVEL }));
    expect(a.failures.join("\n")).toContain(TOKEN_ENV);
  });

  it("token do MCP adivinhável ⇒ reprova (essas tools spawnam claude com skip-permissions)", () => {
    // O piso de `mcp/auth.ts` é 24 chars e não olha entropia: um token de tutorial autentica hoje.
    const a = mod.auditBind(aberto({ AGILEHARNESS_MCP_TOKEN: ADIVINHAVEL }));
    expect(a.failures.join("\n")).toContain("AGILEHARNESS_MCP_TOKEN");
  });

  it("qualquer TIER de token do MCP entra na auditoria, não só o primário", () => {
    // `settings.yaml` pode declarar N tokens escopados (`mcpTokens[].tokenEnv`). Auditar só o
    // primário deixaria o escopado `write` — que move card, enfileira run e abre worktree — de fora.
    const a = mod.auditBind(aberto({ AGILEHARNESS_MCP_TOKEN_ORCH: ADIVINHAVEL }));
    expect(a.failures.join("\n")).toContain("AGILEHARNESS_MCP_TOKEN_ORCH");
  });

  it("token do MCP AUSENTE não é falha — a superfície fica fechada, não aberta", () => {
    // Régua honesta, e agora VERDADEIRA de ponta a ponta: `isMcpTokenValid` é fail-closed contra
    // segredo ausente (mcp/auth.ts) e NADA no boot gera um por conta própria (mcp/token-bootstrap.ts
    // só normaliza e julga o que a env carrega). Sem env declarada a porta não existe — exigir que
    // ela exista não fecharia porta nenhuma, só obrigaria configuração. Enquanto o boot GERAVA um
    // token, esta afirmação estava aposentada: toda instalação nascia com a superfície armada.
    const a = mod.auditBind(aberto({ AGILEHARNESS_MCP_TOKEN: undefined }));
    expect(a.failures).toEqual([]);
    expect(a.weaknesses).toEqual([]);
  });

  it("bundler de DEV com a porta aberta ⇒ reprova (o app deixa de ser dono exclusivo do upgrade)", () => {
    // Em dev o `wsOwner` é o servidor de verdade e o Next anexa o listener dele: um upgrade que não
    // seja `/ttyd/*` deixa de cair no `socket.destroy()` e não passa por checagem de Origin nenhuma.
    const a = mod.auditBind(aberto({ AGILEHARNESS_DEV: "1" }));
    expect(a.failures.join("\n")).toContain("AGILEHARNESS_DEV");
  });

  it("loopback nunca RECUSA — mas a credencial fraca deixou de ser invisível", () => {
    // A topologia que este produto de fato ship é loopback + TÚNEL: a máquina viva roda com
    // `AGILEHARNESS_HOST=127.0.0.1` e o `/api/usm/<token>/mcp` está na internet pública por desenho.
    // Uma auditoria que retornasse cedo em loopback (o que ela fazia) deixava
    // `changeme-changeme-changeme-change` passar SEM exame exatamente na configuração real. Então a
    // MEDIÇÃO passou a rodar sempre; o que continua condicionado ao bind é o VEREDITO.
    for (const host of [undefined, "127.0.0.1", "127.0.0.2", "::1", "[::1]", "localhost", "  "]) {
      const a = mod.auditBind({ AGILEHARNESS_HOST: host, [TOKEN_ENV]: ADIVINHAVEL, AGILEHARNESS_DEV: "1" });
      expect(a.exposed, `host ${String(host)} não deveria ser exposto`).toBe(false);
      expect(a.failures, `host ${String(host)} não pode RECUSAR o boot`).toEqual([]);
      expect(a.weaknesses.join("\n"), `host ${String(host)} tinha de MEDIR a credencial`).toContain(TOKEN_ENV);
      // O aviso é prescritivo e explica por que ele existe mesmo com a porta fechada.
      const msg = mod.weakCredentialsMessage(a) ?? "";
      expect(msg).toContain(TOKEN_ENV);
      expect(msg).toContain("NÃO impede o boot");
      expect(msg).toContain("internet pública");
    }
  });

  it("em loopback com tudo forte não há aviso nenhum — nada de alarme decorativo", () => {
    const a = mod.auditBind({ [SESSION_SECRET_ENV]: forte(), [TOKEN_ENV]: forte() });
    expect(a.exposed).toBe(false);
    expect(a.weaknesses).toEqual([]);
    expect(mod.weakCredentialsMessage(a)).toBeNull();
  });

  it("o bundler de dev só reprova com o bind ABERTO — em loopback o HMR é assunto de ninguém", () => {
    // Este item é o único que é específico de bind aberto (o app deixa de ser dono exclusivo do
    // `upgrade`). Vazá-lo para o aviso de loopback seria ruído em todo `bun run dev`.
    const a = mod.auditBind({ [SESSION_SECRET_ENV]: forte(), [TOKEN_ENV]: forte(), AGILEHARNESS_DEV: "1" });
    expect(a.failures).toEqual([]);
    expect(a.weaknesses).toEqual([]);
  });

  it("bind de LAN também é exposição — a régua é 'outra máquina alcança', não 'a internet alcança'", () => {
    expect(mod.auditBind(aberto({ AGILEHARNESS_HOST: "192.168.1.10" })).exposed).toBe(true);
    expect(mod.auditBind(aberto({ AGILEHARNESS_HOST: "::" })).exposed).toBe(true);
  });
});

describe("o override — o dono pode assumir o risco, mas nunca em silêncio", () => {
  const arriscado = (extra: Record<string, string | undefined> = {}) => ({
    AGILEHARNESS_HOST: "0.0.0.0",
    [SESSION_SECRET_ENV]: forte(),
    [TOKEN_ENV]: ADIVINHAVEL,
    ...extra,
  });

  it("com o literal exato =1 o bind aberto passa, e a mensagem diz o que foi dispensado", () => {
    const a = mod.auditBind(arriscado({ [mod.ALLOW_PUBLIC_BIND_ENV]: "1" }));
    expect(a.overridden).toBe(true);
    expect(a.failures.length).toBeGreaterThan(0); // o override não CONSERTA nada — só assume
    const msg = mod.bindAuditMessage(a, "0.0.0.0", 3008);
    expect(msg).toContain(mod.ALLOW_PUBLIC_BIND_ENV);
    expect(msg).toContain(TOKEN_ENV);
  });

  it("só o literal exato arma o override — nada de 'true', 'yes', 'on' ou espaço sobrando", () => {
    // Mesma postura de `AGILEHARNESS_ENGINE=on`: armar por acidente de digitação seria pior que não ter
    // válvula, porque o aviso continuaria saindo e ninguém saberia que a guarda foi desligada.
    for (const valor of ["true", "yes", "on", "0", "", " 1", "1 ", "sim"]) {
      expect(
        mod.auditBind(arriscado({ [mod.ALLOW_PUBLIC_BIND_ENV]: valor })).overridden,
        `"${valor}" não deveria armar o override`,
      ).toBe(false);
    }
  });
});

describe("isWeakSecret — a régua de 'dá para adivinhar'", () => {
  it("aceita o que o próprio serviço gera", () => {
    for (let i = 0; i < 50; i += 1) expect(mod.isWeakSecret(forte())).toBe(false);
  });

  it("reprova o curto, o repetido e o de exemplo — as três formas de segredo de fábrica", () => {
    const fracos = [
      undefined,
      "",
      "curto",
      "x".repeat(31), // um char abaixo do piso
      "a".repeat(64), // longo e sem entropia nenhuma
      "0123456789".repeat(4), // padrão digitado, 10 símbolos distintos
      ADIVINHAVEL,
      "agileharness-secret-token-example",
      "trocar-esta-senha-antes-de-subir!",
    ];
    for (const f of fracos) expect(mod.isWeakSecret(f), `"${String(f)}" deveria ser fraco`).toBe(true);
  });
});
