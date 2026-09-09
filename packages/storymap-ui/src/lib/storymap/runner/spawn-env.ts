// Env de SPAWN saneado — a única fonte do "env de filho igual ao de um shell manual".
//
// O serviço storymap é um next-server (`next start` sob systemd), e o runtime do Next MUTA o
// process.env VIVO do serviço — notadamente `__NEXT_PROCESSED_ENV=true` (setado pelo @next/env ao
// carregar os .env do storymap-ui) e chaves `__NEXT_PRIVATE_*`. Essas mutações não aparecem no
// /proc/<pid>/environ (que só mostra o env de exec), mas TODO child_process.spawn as herda.
//
// Incidente 2026-07-09 (gap do story-g9kxo9): o deploy da face (`just deploy-mosaico-site`) spawnado
// pelo serviço herdou `__NEXT_PROCESSED_ENV=true` → o `next build` do orbit (via build-mosaico.mjs,
// que espalha `...process.env`) viu a flag e PULOU a aplicação do .env.production (o processEnv do
// @next/env retorna cedo quando a flag está presente — o banner "Environments: .env.production" ainda
// lista o arquivo, o que mascara o skip) → todas as NEXT_PUBLIC_* undefined → auth/invalid-api-key em
// todo prerender. O MESMO comando num shell manual (sem a flag) funciona — a assinatura clássica
// "automático falha, manual passa". Irmão do C1 (PATH com node_modules/.bin do lifecycle bun-run).
//
// NODE_ENV sai pelo mesmo princípio de paridade: o systemd seta NODE_ENV=production PARA O SERVIÇO;
// um shell manual não o tem. Filhos que precisam de production setam explicitamente (build-mosaico.mjs
// seta NODE_ENV=production; `next build` força production sozinho) — herdá-lo muda comportamento de
// ferramentas nos filhos (ex.: `bun install` omite devDependencies; vitest deixa de assumir test).
//
// Pure + sem imports do runner → importável por engine.ts, product-deploy.ts E smart-capture/claude.ts sem ciclo.
//
// QUEM OBRIGA A PASSAR POR AQUI: `runner/spawn-chokepoint.test.ts` (lint). Ele varre `src/**`, acha TODA
// superfície que spawna o binário `claude` e reprova a que monte o env do filho à mão. Sem esse lint a régua
// era só convenção — e foi exatamente assim que a 8ª superfície (`smart-capture/claude.ts`, a que ingere TEXTO
// LIVRE não confiável) nasceu fora do chokepoint e ficou meses entregando `process.env` cru ao filho.
// Ao criar um spawn de agente novo: `sanitizeSpawnEnv(process.env)` (ou `buildAgentSpawnEnv`, que é este ⊕
// headroom) e PASSE o resultado na chamada — o lint checa as duas coisas, e o censo dele exige registrar a
// superfície nova, que é o momento em que um humano decide se aquele agente devia existir.

import path from "node:path";

// C1 (2026-07-08, ny4v26): o serviço roda sob lifecycle bun-run, que PREPENDE todo node_modules/.bin
// ao process.env.PATH. Spawns herdavam isso e um bin-shim de dependência sombreava binário de sistema
// para TODOS os runs (o shim `just` do just-install saía 0 mudo → no-op silencioso). Runs resolvem
// binários de sistema só de dirs de sistema; infra-guard.test.ts vigia o shim.
/** Remove todo segmento node_modules/.bin de um valor de PATH. Pure — exportado para testes. */
export function sanitizeSpawnPath(pathValue: string | undefined, delimiter: string = path.delimiter): string | undefined {
  if (!pathValue) return pathValue;
  return pathValue
    .split(delimiter)
    .filter((seg) => !seg.replace(/\\/g, "/").includes("node_modules/.bin"))
    .join(delimiter);
}

/**
 * O PREFIXO por onde um tier de credencial MCP se chama: `STORYMAP_MCP_TOKEN` (primário, nível
 * `full`), `_ORCH`, `_RO`, `_SESSION` e o que `settings.yaml` (`mcpTokens[].tokenEnv`) declarar
 * amanhã. É a MESMA régua por prefixo que `runner/config.ts` usa para ACEITAR a declaração de um
 * tier e que `server/main.ts` usa para AUDITAR a força dele.
 *
 * Casar por prefixo — e não pelo nome de um tier — é o controle, não estilo: é o que faz um tier
 * NOVO nascer já removido do env de filho, em vez de voltar a viajar em silêncio. Foi exatamente
 * assim que o `_ORCH` sobrou quando a remoção nomeava só o primário.
 */
export const MCP_TOKEN_ENV_PREFIX = "STORYMAP_MCP_TOKEN";

/**
 * OS SEGREDOS DO SERVIÇO que não são tier MCP — e por que esta lista precisa existir.
 *
 * ── O QUE FOI MEDIDO ────────────────────────────────────────────────────────────────────────────────
 * Uma pesquisa de arte prévia rodou os dois denylists de produção que existem no mercado (Buildkite e
 * o do Codex) contra 14 variáveis plausíveis: **cada um erra 11 de 14**. O motivo é estrutural — o
 * segredo quase nunca se chama `*_TOKEN`; ele se chama `DATABASE_URL`, `SENTRY_DSN`, `KUBECONFIG`.
 * A regra de ouro da indústria (sudo `env_reset`, OpenSSH "The default is not to accept any environment
 * variables", systemd, e o próprio SDK do MCP com seis nomes herdados) é a INVERSA: allowlist mínima.
 *
 * ── POR QUE AQUI AINDA É DENYLIST, E O QUE COMPENSA ────────────────────────────────────────────────
 * Virar allowlist muda o ambiente de TODO spawn de agente de uma vez, e o filho é um CLI que lê dezenas
 * de variáveis operacionais. Trocar um vazamento medido por um apagão é exatamente o que esta fase se
 * proibiu de fazer. Então a denylist fica — mas deixa de depender da minha memória: `spawn-env.test.ts`
 * varre `src/` atrás de TODA leitura de env com nome de cara secreta e exige que cada uma esteja ou
 * nesta lista, ou declarada como não-segredo com o motivo. Um segredo novo no projeto não consegue
 * nascer viajando para o filho em silêncio.
 *
 * A allowlist continua sendo o alvo, e está registrada como dívida com a lista pronta
 * (`DEFAULT_INHERITED_ENV_VARS` do SDK do MCP: HOME, LOGNAME, PATH, SHELL, TERM, USER).
 *
 * ⚠ E vale repetir o limite honesto que já está no comentário abaixo: nada disto é perímetro. O filho
 * roda com o mesmo uid e lê `/proc/<ppid>/environ` do pai — medido. Isto é higiene do canal acidental.
 */
export const SEGREDOS_DO_SERVICO = [
  // Assina as sessões do painel: um filho com este valor forja sessão de operador.
  "AGILEHARNESS_SESSION_SECRET",
  // O token de LOGIN do operador (lib/auth/env.ts, TOKEN_ENV): com ele um filho não precisa forjar
  // nada — troca o token por uma sessão real em /api/auth/login. Ficou fora desta lista até
  // 2026-09-09 porque env.ts o lê por constante, e o scanner de exaustividade só enxerga
  // `process.env.NOME` literal; foi um teste novo com o literal que o expôs (issue #2 do repo).
  "AGILEHARNESS_AUTH_TOKEN",
  // Chave privada de Web Push.
  "STORYMAP_VAPID_PRIVATE_KEY",
  // Tokens de ingestão de feedback (escrita em board-data por integração externa).
  "STORYMAP_FEEDBACK_INGEST_TOKENS",
  // Credencial de terceiro; não é usada por nenhum run, e vazá-la é custo puro.
  "OPENAI_API_KEY",
] as const;

/**
 * Cópia SANEADA do env do serviço para um filho spawnado: remove as chaves internas do runtime Next
 * (`__NEXT_*` — inclui `__NEXT_PROCESSED_ENV`, que faz um `next build` filho PULAR seus .env), o
 * `NODE_ENV` do systemd e TODO tier de credencial MCP (`STORYMAP_MCP_TOKEN*`), e aplica
 * {@link sanitizeSpawnPath} ao PATH (C1). Não muta a fonte. Pure.
 */
export function sanitizeSpawnEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Record em vez de ProcessEnv: o typing do Next declara NODE_ENV obrigatório/readonly, e este env
  // deliberadamente NÃO o carrega (o cast no return é o boundary de volta ao tipo nominal).
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith("__NEXT_")) continue; // runtime interno do next-server do serviço — nunca do filho
    if (key === "NODE_ENV") continue; // do systemd do serviço; um shell manual não tem (paridade)
    // F5.0b ⊕ story-e3lj46 — NENHUM tier de credencial MCP viaja no env de um filho. Antes saía só o
    // primário (`STORYMAP_MCP_TOKEN`), e o ESCOPADO `_ORCH` — que move card, enfileira run, abre worktree
    // e publica — ia inteiro, apesar de o nome "sanitize" prometer o contrário.
    //
    // O que a remoção IMPEDE: que a credencial apareça onde o filho a despeja SEM QUERER — `printenv`
    // ou `set -x` num passo de bash, um dump de crash, o stderr que vira console do card. Um card com
    // prompt-injection só precisa pedir "mostre seu ambiente" para o segredo virar texto num artefato
    // que o board publica; e o valor não sobra sob nome nenhum, então grep por valor também volta vazio.
    //
    // O que ela NÃO impede, e é preciso dizer em vez de fingir: o serviço roda `User=root` e o filho
    // herda uid 0 — ele lê `.env.local`, `storymap/.runner/*` e `/proc/<pid>/environ` do serviço direto
    // do disco. Contra um filho HOSTIL isto não nega NADA (só o filho deixar de ser root negaria, e isso
    // está fora deste recorte). É higiene do canal acidental, não perímetro.
    //
    // ZERO custo de autonomia, porque quem precisa de MCP não lê o env: `buildOrchestratorMcpConfig`
    // INLINA o token no arquivo do `--mcp-config` (tick, copiloto, sessão a 0600), e o run `harness-*` sobe
    // com `--strict-mcp-config` sem nenhum mount do AgileHarness — nunca teve o que perder. O webhook de
    // deploy importa o token por `systemd-run --setenv` a partir do env do SERVIÇO (plain exec, não passa
    // por aqui) — não é afetado.
    if (key.startsWith(MCP_TOKEN_ENV_PREFIX)) continue;
    // ── IS_SANDBOX HERDADO (F0, achado de medição) ────────────────────────────────────────────────
    // `IS_SANDBOX=1` é o que faz o CLI aceitar autonomia plena como root. O harness passou a setá-lo
    // DELIBERADAMENTE, só quando a válvula explícita foi puxada — mas ele também é uma variável comum
    // de ambiente, e quando o PRÓPRIO serviço roda dentro de um sandbox (o caso desta máquina de
    // desenvolvimento) todo filho o herdava de graça. Efeito: o bypass reaparecia sem ninguém pedir e
    // sem aparecer em lugar nenhum do código — "declarado e inerte" invertido, o pior dos dois.
    //
    // Removê-lo aqui torna a INTENÇÃO do harness a única fonte: quem precisa do bypass o acrescenta
    // depois desta função, no ramo que o justifica. Herdar nunca é decidir.
    if (key === "IS_SANDBOX") continue;
    // Os segredos do serviço que não são tier MCP — ver a nota em SEGREDOS_DO_SERVICO. A lista é
    // mantida honesta por um lint exaustivo, não pela minha memória.
    if ((SEGREDOS_DO_SERVICO as readonly string[]).includes(key)) continue;
    env[key] = value;
  }
  env.PATH = sanitizeSpawnPath(env.PATH);
  return env as NodeJS.ProcessEnv;
}
