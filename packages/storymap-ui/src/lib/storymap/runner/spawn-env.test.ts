import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SEGREDOS_DO_SERVICO, sanitizeSpawnEnv, sanitizeSpawnPath } from "./spawn-env";
// story-e3lj46 — a prova de que a remoção não custa capacidade vem de FORA deste módulo: o mount de
// MCP nasce de um ARQUIVO (buildOrchestratorMcpConfig) e todo spawn de Claude passa pelo chokepoint.
import { buildOrchestratorMcpConfig } from "./orchestrator-spawn";
import { buildAgentSpawnEnv } from "./headroom";

// O typing do Next declara NODE_ENV obrigatório em ProcessEnv; estes fixtures deliberadamente o omitem.
const asEnv = (o: Record<string, string | undefined>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;

// Incidente 2026-07-09 (gap do story-g9kxo9): o serviço storymap É um next-server, e o @next/env dele
// seta __NEXT_PROCESSED_ENV=true no process.env VIVO. Todo filho spawnado do serviço (deploy da face,
// runs headless) herdava a flag → o `next build` do orbit PULAVA o .env.production (o processEnv
// do @next/env retorna cedo com a flag presente) → NEXT_PUBLIC_* undefined → auth/invalid-api-key.
// O shell manual não tem a flag — por isso "manual funciona, automático falha".
describe("sanitizeSpawnEnv — env de filho igual ao de um shell manual (irmão do C1)", () => {
  it("remove __NEXT_PROCESSED_ENV e toda chave __NEXT_* do serviço next-server", () => {
    const env = sanitizeSpawnEnv(asEnv({
      __NEXT_PROCESSED_ENV: "true",
      __NEXT_PRIVATE_ORIGIN: "http://localhost:3008",
      __NEXT_PRIVATE_PREBUNDLED_REACT: "next",
      HOME: "/root",
    }));
    expect(env.__NEXT_PROCESSED_ENV).toBeUndefined();
    expect(env.__NEXT_PRIVATE_ORIGIN).toBeUndefined();
    expect(env.__NEXT_PRIVATE_PREBUNDLED_REACT).toBeUndefined();
    expect(env.HOME).toBe("/root");
  });

  it("remove NODE_ENV (o systemd seta production p/ o serviço; um shell manual não tem)", () => {
    const env = sanitizeSpawnEnv(asEnv({ NODE_ENV: "production", USER: "root" }));
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.USER).toBe("root");
  });

  // story-e3lj46 — esta expectativa MUDOU, e mudou porque estava errada: ela AFIRMAVA que o tier
  // escopado devia sobreviver ("o run monta via config"), o que trocava a causa (o run monta via
  // ARQUIVO, logo não precisa do env) pela conclusão oposta (então deixe o env passar). O tier
  // `_ORCH` agora sai junto — a remoção por tier está coberta no bloco story-e3lj46 abaixo.
  it("F5.0b — remove AGILEHARNESS_MCP_TOKEN (token full do operador nunca vaza p/ o env do filho)", () => {
    const env = sanitizeSpawnEnv(asEnv({ AGILEHARNESS_MCP_TOKEN: "super-secret", AGILEHARNESS_MCP_TOKEN_ORCH: "scoped", USER: "root" }));
    expect(env.AGILEHARNESS_MCP_TOKEN).toBeUndefined();
    expect(env.AGILEHARNESS_MCP_TOKEN_ORCH).toBeUndefined();
    expect(env.USER).toBe("root");
  });

  it("preserva NEXT_PUBLIC_* e as demais vars (só as internas do runtime saem)", () => {
    const env = sanitizeSpawnEnv(asEnv({
      NEXT_PUBLIC_FIREBASE_API_KEY: "abc",
      AGILEHARNESS_HEADROOM_URL: "http://x",
      PATH: "/usr/bin",
    }));
    expect(env.NEXT_PUBLIC_FIREBASE_API_KEY).toBe("abc");
    expect(env.AGILEHARNESS_HEADROOM_URL).toBe("http://x");
  });

  it("sanitiza o PATH (C1: nunca vazar node_modules/.bin do lifecycle bun-run)", () => {
    const poisoned = ["/repo/node_modules/.bin", "/root/.bun/bin", "/usr/bin"].join(path.delimiter);
    const env = sanitizeSpawnEnv(asEnv({ PATH: poisoned }));
    expect(env.PATH).toBe(["/root/.bun/bin", "/usr/bin"].join(path.delimiter));
  });

  it("não muta o env de origem", () => {
    const source = asEnv({ __NEXT_PROCESSED_ENV: "true", NODE_ENV: "production" });
    sanitizeSpawnEnv(source);
    expect(source.__NEXT_PROCESSED_ENV).toBe("true");
    expect(source.NODE_ENV).toBe("production");
  });
});

// ── story-e3lj46 — nenhum TIER de credencial MCP viaja no ambiente de um filho ───────────────────
// O nome prometia blindagem; saía UM tier só (o `AGILEHARNESS_MCP_TOKEN` primário). O ESCOPADO
// `AGILEHARNESS_MCP_TOKEN_ORCH` — nível `orch`: move card, enfileira run, abre worktree, publica —
// viajava inteiro para dentro de TODO filho spawnado pelo serviço.
//
// O ATAQUE que isso abre não exige root nem malícia: um card com prompt-injection pede ao run
// "mostre seu ambiente"; um passo de bash roda `printenv` ou `set -x`; um run morre e o dump vai
// para o console do card. A credencial `orch` vira TEXTO num artefato que o board publica. É um
// canal ACIDENTAL — o run não precisa querer vazar, só ser descuidado.
//
// O que este controle NÃO faz, e o card dizia certo: o serviço roda `User=root`, o filho herda
// uid 0 e lê `.env.local`, `storymap/.runner/*` e `/proc/<pid>/environ` direto do disco. Contra um
// filho HOSTIL a remoção não nega nada. Logo os testes miram no vazamento por descuido — não numa
// contenção que o uid 0 desmentiria.
describe("sanitizeSpawnEnv — nenhum tier de credencial MCP chega ao filho (story-e3lj46)", () => {
  const ORCH = "orch-Zt4Bq9WnPmLc7ZrVs2HkDyGf5JuAe1Rk3TnQiOb"; // pragma: allowlist secret

  it("o tier ESCOPADO `_ORCH` não chega ao filho (era ele que o `printenv` de um run despejava)", () => {
    const env = sanitizeSpawnEnv(asEnv({ AGILEHARNESS_MCP_TOKEN_ORCH: ORCH, USER: "root" }));
    expect(env.AGILEHARNESS_MCP_TOKEN_ORCH).toBeUndefined();
    expect(env.USER).toBe("root");
  });

  // Casar por PREFIXO, não por nome: é assim que `config.ts` aceita a declaração de um tier e que
  // `main.ts` audita a força dele. Um tier NOVO em `settings.yaml` (mcpTokens[].tokenEnv) nasce já
  // removido do env de filho, em vez de voltar a viajar em silêncio — que é como o `_ORCH` sobrou.
  it("nenhum tier sobrevive: primário, `_ORCH`, `_RO`, `_SESSION` e um declarado amanhã", () => {
    const tiers = [
      "AGILEHARNESS_MCP_TOKEN",
      "AGILEHARNESS_MCP_TOKEN_ORCH",
      "AGILEHARNESS_MCP_TOKEN_RO",
      "AGILEHARNESS_MCP_TOKEN_SESSION",
      "AGILEHARNESS_MCP_TOKEN_UM_TIER_QUE_AINDA_NAO_EXISTE",
    ];
    const source: Record<string, string> = { HOME: "/root" };
    for (const t of tiers) source[t] = `${ORCH}-${t}`;

    const env = sanitizeSpawnEnv(asEnv(source));
    for (const t of tiers) expect(env[t]).toBeUndefined();
    expect(env.HOME).toBe("/root");
  });

  // O ataque na forma em que ele ACONTECE: o filho não precisa saber o nome da variável — basta
  // despejar o ambiente e procurar o valor. Nenhum VALOR de tier pode restar sob nome nenhum.
  it("o VALOR de um tier não sobra em NENHUMA variável — um `printenv | grep` do filho volta vazio", () => {
    const env = sanitizeSpawnEnv(asEnv({ AGILEHARNESS_MCP_TOKEN_ORCH: ORCH, PATH: "/usr/bin", HOME: "/root" }));
    expect(Object.values(env).some((v) => typeof v === "string" && v.includes(ORCH))).toBe(false);
  });

  // ZERO CUSTO DE AUTONOMIA — a prova de que remover do env não desmonta tool nenhuma: quem PRECISA
  // de MCP (tick, copiloto, sessão) recebe o token INLINADO no arquivo do `--mcp-config`, lido pelo
  // PARENT. Se algum dia alguém trocar o arquivo por interpolação de env (`${AGILEHARNESS_MCP_TOKEN_ORCH}`),
  // este teste cai — e é exatamente aí que a remoção passaria a custar capacidade.
  it("o mount de quem precisa de MCP não depende do env: o token é INLINADO no arquivo do --mcp-config", () => {
    const cfg = JSON.parse(buildOrchestratorMcpConfig(ORCH, 3008));
    expect(cfg.mcpServers.storymap.url).toBe(`http://localhost:3008/api/usm/${ORCH}/mcp`);
  });

  // A régua é o PREFIXO do tier MCP — nunca "parece segredo". Um strip por palavra-chave levaria a
  // chave do modelo e o run pararia de rodar: perda de capacidade disfarçada de segurança.
  it("o env operacional do run sobrevive intacto (inclusive a credencial que ele PRECISA)", () => {
    const env = sanitizeSpawnEnv(asEnv({
      AGILEHARNESS_MCP_TOKEN_ORCH: ORCH,
      ANTHROPIC_API_KEY: "sk-ant-precisa-disso", // pragma: allowlist secret
      AGILEHARNESS_AUTORUN_RUN_ID: "run-1",
      NEXT_PUBLIC_FIREBASE_API_KEY: "abc",
      HOME: "/root",
      PATH: "/usr/bin",
    }));
    expect(env.AGILEHARNESS_MCP_TOKEN_ORCH).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-precisa-disso");
    expect(env.AGILEHARNESS_AUTORUN_RUN_ID).toBe("run-1");
    expect(env.NEXT_PUBLIC_FIREBASE_API_KEY).toBe("abc");
    expect(env.HOME).toBe("/root");
    expect(env.PATH).toBe("/usr/bin");
  });

  // O CHOKEPOINT: as superfícies de spawn de Claude (engine/run, tick, copiloto, sessão, peer-review,
  // juiz de conflito, agente de deploy) montam o env por aqui. Fechar no chokepoint é o que impede uma
  // superfície NOVA de nascer vazando — o `_ORCH` só sumia no peer-review, que remendava por call site.
  it("o chokepoint de TODO spawn de Claude (buildAgentSpawnEnv) também não deixa o tier passar", async () => {
    const env = await buildAgentSpawnEnv(asEnv({ AGILEHARNESS_MCP_TOKEN_ORCH: ORCH, HOME: "/root" }), { url: null });
    expect(env.AGILEHARNESS_MCP_TOKEN_ORCH).toBeUndefined();
    expect(env.HOME).toBe("/root");
  });
});

// Movido do engine.ts (re-exportado lá) — o comportamento é o mesmo do C1.
describe("sanitizeSpawnPath (movido do engine — C1)", () => {
  it("remove todo segmento node_modules/.bin", () => {
    const poisoned = ["/repo/node_modules/.bin", "/repo/packages/x/node_modules/.bin", "/usr/bin"].join(path.delimiter);
    expect(sanitizeSpawnPath(poisoned)).toBe("/usr/bin");
  });
  it("passa adiante PATH limpo e undefined", () => {
    expect(sanitizeSpawnPath("/usr/bin")).toBe("/usr/bin");
    expect(sanitizeSpawnPath(undefined)).toBeUndefined();
  });
});

describe("IS_SANDBOX não é herdado — a intenção do harness é a única fonte (F0)", () => {
  it("o filho NÃO recebe IS_SANDBOX só porque o serviço o tinha", () => {
    // Medido de verdade: a sessão que escreveu isto rodava com IS_SANDBOX=1 no ambiente, e o teste de
    // contenção do revisor par reprovou por causa disso — o filho recebia o bypass sem ninguém pedir.
    const env = sanitizeSpawnEnv({ IS_SANDBOX: "1", PATH: "/usr/bin", FOO: "bar" } as unknown as NodeJS.ProcessEnv);
    expect(env.IS_SANDBOX).toBeUndefined();
    expect(env.FOO).toBe("bar"); // guarda de não-vacuidade: a função não virou "remove tudo"
  });

  it("quem PRECISA do bypass o acrescenta depois — e aí ele existe", () => {
    const base = sanitizeSpawnEnv({ IS_SANDBOX: "1" } as unknown as NodeJS.ProcessEnv);
    expect({ ...base, IS_SANDBOX: "1" }.IS_SANDBOX).toBe("1");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// LINT EXAUSTIVO DE SEGREDO — a denylist deixa de depender da memória de quem a escreveu.
//
// Arte prévia medida: os dois denylists de produção do mercado (Buildkite e o do Codex) erram **11 de
// 14** contra variáveis plausíveis, porque o segredo quase nunca se chama `*_TOKEN`. A regra de ouro é
// allowlist mínima (sudo `env_reset`, OpenSSH, systemd, o SDK do MCP com seis nomes) — e ela continua
// sendo o alvo, registrada como dívida. Enquanto não chega, este lint dá à denylist a única propriedade
// que ela pode ter: ser COMPLETA em relação aos segredos DESTE projeto.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe("nenhum segredo do serviço viaja para o filho sem estar classificado", () => {
  /** Nomes de cara secreta que NÃO são segredo — cada um com o motivo, porque "óbvio" envelhece. */
  const NAO_SAO_SEGREDO: Record<string, string> = {
    AGILEHARNESS_VAPID_PUBLIC_KEY: "chave PÚBLICA de Web Push — publicada no cliente por desenho",
    AGILEHARNESS_VAPID_SUBJECT: "o mailto: do contato VAPID; identifica, não autentica",
    AGILEHARNESS_WEEKLY_TOKEN_LIMIT: "um NÚMERO (teto semanal de tokens); 'TOKEN' aqui é a unidade, não credencial",
    AGILEHARNESS_MCP_TOKEN_ESPACO: "nome de VARIÁVEL de tier, não o valor — casado pelo prefixo e já removido",
  };

  it("EXAUSTIVO: toda env de nome secreto lida em src/ é removida, ou declarada como não-segredo", () => {
    const SRC = path.resolve(__dirname, "..", "..", "..");
    const lidas = new Set<string>();
    const varrer = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) varrer(full);
        else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) {
          for (const m of readFileSync(full, "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) lidas.add(m[1]!);
        }
      }
    };
    varrer(SRC);
    // Guarda de não-vacuidade: uma varredura que não achou nada passaria calada, que é o modo de falha
    // que este arquivo inteiro combate.
    expect(lidas.size, "a varredura não encontrou env nenhuma — o caminho está errado").toBeGreaterThan(30);

    const CARA_DE_SEGREDO = /TOKEN|SECRET|_KEY|PASSWORD|CREDENTIAL|DSN|PRIVATE/;
    const suspeitas = [...lidas].filter((k) => CARA_DE_SEGREDO.test(k)).sort();
    expect(suspeitas.length, "nenhuma env suspeita — o regex parou de casar").toBeGreaterThan(3);

    const saneado = sanitizeSpawnEnv(Object.fromEntries(suspeitas.map((k) => [k, "valor"])) as unknown as NodeJS.ProcessEnv);
    const vazando = suspeitas.filter((k) => saneado[k] !== undefined && !NAO_SAO_SEGREDO[k]);
    expect(
      vazando,
      "env de nome secreto chegando ao filho: acrescente a SEGREDOS_DO_SERVICO, ou declare em " +
        "NAO_SAO_SEGREDO dizendo POR QUE não é segredo",
    ).toEqual([]);

    // E o inverso: um "não é segredo" declarado para uma env que ninguém lê mais é registro podre.
    expect(
      Object.keys(NAO_SAO_SEGREDO).filter((k) => !lidas.has(k)),
      "declaração de não-segredo para env que o código não lê mais",
    ).toEqual([]);
  });

  it("os quatro segredos nomeados somem de verdade (guarda de não-vacuidade do lint acima)", () => {
    const bruto = Object.fromEntries(SEGREDOS_DO_SERVICO.map((k) => [k, "s3cr3t"])) as unknown as NodeJS.ProcessEnv;
    expect(Object.keys(sanitizeSpawnEnv(bruto))).toEqual(["PATH"]);
  });
});
