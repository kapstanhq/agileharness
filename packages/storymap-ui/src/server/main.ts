// O ENTRYPOINT do AgileHarness — um servidor HTTP próprio que delega ao Next e é dono do `upgrade`.
//
// ── O que isto substitui, e por quê ────────────────────────────────────────────────────────────
// Até 2026-07-27 o serviço subia por `next start`. Isso bastava para HTTP, mas `next start` NÃO
// trata o evento `upgrade` do `http.Server` em produção — logo, nenhum WebSocket do produto podia
// ser autenticado pelo app. O terminal (`/terminal` + `/ttyd/*`) ficava então de fora do portão,
// autenticado por um mecanismo PARALELO no proxy (`basic_auth`), com três defeitos:
//   • dois logins em sequência para o mesmo operador (o diálogo nativo do navegador + a nossa tela);
//   • auth que não viaja com o repositório — quem instala o open-source atrás de nginx/Traefik/
//     Cloudflare/nada não herdava proteção nenhuma;
//   • nenhum lugar onde validar o `Origin` do WebSocket (a defesa contra a classe ClawJacked).
//
// Com um servidor próprio há UM portão para tudo: o middleware do Next cuida dos requests e este
// arquivo cuida dos upgrades, ambos chamando a MESMA `verifySession`. O ttyd fica preso em
// loopback, alcançável só por este processo, e o proxy reverso volta a ser o que deve ser — TLS e
// nada mais. O AgileHarness passa a funcionar SEM proxy nenhum (`bun start` → login → terminal),
// que é a propriedade que faltava para o self-host.
//
// ── Como isto roda ─────────────────────────────────────────────────────────────────────────────
// TypeScript, empacotado por `bun build` em `dist/ah-server.mjs` (script `build:server`) e
// executado por **node** — o mesmo runtime de sempre. Empacotar em vez de duplicar: assim o
// servidor importa a `verifySession` do app de verdade, e não existe uma segunda implementação de
// sessão para divergir da primeira. FORA de `.next` de propósito: o dev server do Next limpa
// aquele diretório no boot, e o entrypoint sumiria debaixo do próprio processo.

import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import { loadEnvConfig } from "@next/env";
import next from "next";

import { SESSION_SECRET_ENV, TOKEN_ENV, type EnvLike } from "@/lib/auth/env";
import { avisoDeLegados, resolverAliasesDeEnv } from "@/lib/storymap/env-aliases";
import type { McpLevel } from "@/lib/storymap/types";
import { GENERATE_TOKEN_HINT, secretWeakness, weaknessAdvice } from "@/lib/storymap/mcp/auth";
// O NOME da env vem do módulo que a define — repetir a string aqui criaria uma segunda verdade, e a
// que apodrece é sempre a de fora. É só uma const; nada de token-bootstrap roda no import.
import { MCP_TOKEN_ENV } from "@/lib/storymap/mcp/token-bootstrap";
import { engineBootDurationMs, engineBooted, whenEngineBooted } from "@/lib/storymap/runner/boot-signal";

import {
  isTerminalProxyPath,
  pathnameOf,
  proxyTerminalHttp,
  proxyTerminalUpgrade,
  ttydTargetFromEnv,
} from "@/server/terminal-gateway";

/**
 * MODO — decidido no RUNTIME, por uma env NOSSA, e nunca por `NODE_ENV`.
 *
 * MEDIDO (2026-07-27): `bun build` faz constant-folding de `process.env.NODE_ENV`. Escrito assim,
 * `const dev = process.env.NODE_ENV !== "production"` virou literalmente `var dev = true` no bundle
 * — porque o bundle nasce fora de um ambiente de produção. O servidor de produção subiria com o
 * BUNDLER DE DEV ligado, decidido em tempo de build, e nenhuma env do systemd mudaria isso.
 *
 * `AGILEHARNESS_DEV` não sofre esse folding e falha para o lado SEGURO: ausente ⇒ produção. Depois
 * derivamos `NODE_ENV` dele para que os dois nunca discordem — é o que o próprio CLI do Next faz
 * (`node_modules/next/dist/bin/next`: `process.env.NODE_ENV = process.env.NODE_ENV || defaultEnv`).
 */
export function isDevMode(env: EnvLike = process.env): boolean {
  return env.AGILEHARNESS_DEV === "1";
}
const dev = isDevMode();
// `NODE_ENV` é declarado readonly nos tipos do Next — mas o próprio CLI dele o escreve no arranque
// (`node_modules/next/dist/bin/next`). Como aqui NÓS somos o arranque, a escrita é legítima; o cast
// é o mínimo para dizer isso ao compilador.
(process.env as EnvLike).NODE_ENV = dev ? "development" : "production";

// ── OS ARQUIVOS .env, CARREGADOS AQUI — antes de QUALQUER decisão que dependa deles ──────────────
//
// O que esta linha IMPEDE: que o boot decida sobre segredos que ele ainda não consegue ver.
//
// MEDIDO no serviço vivo (2026-07-29): a unit systemd não tem `EnvironmentFile=`, e
// /proc/<MainPID>/environ carrega os tiers `AGILEHARNESS_MCP_TOKEN_ORCH`/`_RO` mas NÃO o token primário —
// `AGILEHARNESS_MCP_TOKEN` chega SÓ por `packages/storymap-ui/.env.local`. E o `.env.local` era aplicado
// pelo @next/env DENTRO de `app.prepare()` (next/dist/server/config.js → loadEnvConfig), isto é,
// DEPOIS do boot dos segredos e DEPOIS da auto-checagem de perímetro. Duas consequências, ambas ruins:
//   • o bootstrap do token MCP via a env VAZIA e GERAVA um token novo, rotacionando em silêncio a
//     credencial de produção a cada restart — o conector do Claude e as rotas /api/runner/* passavam a
//     responder 404 nu, sem log. A geração automática foi removida (mcp/token-bootstrap.ts), mas a
//     ORDEM errada continuaria envenenando toda decisão de boot que lê um segredo;
//   • a auto-checagem auditava um ambiente SEM os segredos e podia imprimir o PASS afirmativo
//     ("toda credencial alcançável passou o teste de entropia") sobre uma instalação que não os
//     continha. Um controle que emite PASS FALSO é pior que controle nenhum.
//
// `loadEnvConfig` do @next/env — o MESMO mecanismo do Next, nunca um dotenv paralelo (dois leitores de
// .env seriam duas verdades, e a que apodrece é a de fora). Idempotente por construção: ele memoiza o
// resultado e marca `__NEXT_PROCESSED_ENV`, então o `prepare()` adiante não reprocessa os arquivos nem
// sobrescreve o que pusermos na env depois daqui. Precedência preservada: variável presente no
// ambiente REAL (systemd, container) continua vencendo o arquivo.
//
// ⚠️ `AGILEHARNESS_DEV` é a ÚNICA env que NÃO pode vir de arquivo — é ela que decide QUAIS arquivos
// são lidos (`.env.development*` vs `.env.production*`). Mesma propriedade que o `NODE_ENV` tem no
// Next: a chave que escolhe o ambiente não pode morar dentro do ambiente que ela escolhe.
loadEnvConfig(process.cwd(), dev);

// ── A PONTE DE NOMES (Fase 4 do doc 10): `STORYMAP_*`/`USM_*` ⇄ `AGILEHARNESS_*` ─────────────────
// Logo DEPOIS do env estar completo (real + .env.local) e ANTES de qualquer leitura: daqui para baixo o
// código lê só a grafia nova, e o operador que ainda escreve a velha continua atendido — avisado UMA vez,
// aqui, nomeando o que trocar. Ver `lib/storymap/env-aliases.ts`.
const aliasesDeEnv = resolverAliasesDeEnv(process.env as Record<string, string | undefined>);
const avisoDeAliases = avisoDeLegados(aliasesDeEnv);
if (avisoDeAliases) console.warn(avisoDeAliases);

/**
 * LOOPBACK por default — a postura que o plano OSS fixa para um serviço que spawna agentes com
 * poder de execução. Até 2026-07-27 o Next escutava em `*:3008` numa VPS sem firewall e
 * `http://<ip>:3008/board` servia o board inteiro sem autenticação nenhuma (medido, não teórico).
 * Quem quiser expor direto declara `AGILEHARNESS_HOST=0.0.0.0` — e a escolha deixou de ser silenciosa:
 * a auto-checagem logo abaixo audita o perímetro no boot e RECUSA subir aberto sem as garantias.
 *
 * `AGILEHARNESS_HOST`, e não `HOST`/`HOSTNAME`: `HOSTNAME` é setada pelo systemd e por praticamente
 * todo container com o nome da máquina — herdá-la faria o bind falhar por um motivo que ninguém
 * relaciona à configuração do app.
 */
export function resolveHost(env: EnvLike = process.env): string {
  return env.AGILEHARNESS_HOST?.trim() || "127.0.0.1";
}
const host = resolveHost();
const port = Number(process.env.AGILEHARNESS_PORT || process.env.PORT) || 3008;

// `runner/service-lock.ts` publica a porta do serviço lendo `PORT` (o hook de board-data e o
// diagnóstico de /processes leem esse arquivo). Com a porta resolvida aqui, reexportá-la mantém
// aquele contrato verdadeiro mesmo quando ela veio de `AGILEHARNESS_PORT` ou do default.
process.env.PORT = String(port);

// ── A AUTO-CHECAGEM DE BIND — o `security audit` do boot ────────────────────────────────────────
//
// O default acima é loopback, mas ABRIR o bind era um footgun DOCUMENTADO e SEM GUARDA NENHUMA:
// bastava `AGILEHARNESS_HOST=0.0.0.0` e o serviço subia CALADO (o log de `listen` imprime o host
// como informação neutra, sem juízo). O que esta checagem IMPEDE é a repetição silenciosa do
// incidente medido logo acima: a porta de frente para a rede com uma credencial que dá para
// ADIVINHAR. Nela vivem o `/login` (token do operador), o `/api/mcp/<token>/mcp` — cujas tools
// spawnam `claude --dangerously-skip-permissions` NESTA máquina — e o `/terminal` (um shell).
//
// Por que "adivinhar" e não "entrar sem credencial": todo portão daqui já é fail-closed (middleware,
// `isOperatorTokenValid`, `isMcpTokenValid`, `verifySession`) — ninguém entra com as mãos vazias. O
// buraco que sobrava é de ENTROPIA: os pisos que autenticam olham só o TAMANHO, então
// `AGILEHARNESS_AUTH_TOKEN=changeme-changeme-changeme-change` (33 chars) autentica hoje.
//
// MEDIR é incondicional; RECUSAR é que depende do bind. A auditoria não retorna mais cedo em loopback,
// porque a topologia REAL deste produto é loopback + TÚNEL (a máquina viva tem
// `AGILEHARNESS_HOST=127.0.0.1` e o endpoint MCP está na internet pública POR DESENHO): um bind fechado
// nunca quis dizer "inalcançável", e a credencial de tutorial atravessava sem exame exatamente a
// configuração que de fato ship. Em loopback ela vira AVISO alto (quem está na máquina já está dentro,
// e derrubar o boot custaria a capacidade inteira do agente); com o bind aberto, RECUSA.
//
// CUSTO DE AUTONOMIA: ZERO. Nada aqui olha para skip-permissions, deploy, delete ou qualquer poder
// do agente — é postura de REDE. E tem válvula para o dono assumir o risco: `ALLOW_PUBLIC_BIND_ENV`,
// literal EXATO (mesma régua de `AGILEHARNESS_ENGINE=on`, para desarmar uma guarda nunca ser um typo),
// com o aviso saindo em stderr a CADA start — inclusive com a válvula armada.

/** A válvula explícita: o dono assume um bind aberto que reprovou a auto-checagem. */
export const ALLOW_PUBLIC_BIND_ENV = "AGILEHARNESS_ALLOW_PUBLIC_BIND";

/**
 * O caminho EXPLÍCITO para ganhar um token MCP forte: `node dist/ah-server.mjs --generate-mcp-token`.
 *
 * Existe porque a alternativa é o adotante inventar um segredo memorizável para uma URL pública cujas
 * tools executam código nesta máquina. É um COMANDO e não um passo de boot: gerar automaticamente
 * armava a porta em toda instalação, inclusive nas que nunca pediram por ela.
 */
export const GENERATE_MCP_TOKEN_FLAG = "--generate-mcp-token";

/**
 * O relatório de prontidão, sem subir o serviço: `node dist/ah-server.mjs --preflight [--json]`.
 *
 * É a superfície LOAD-BEARING para instalação, e não o resource MCP: no primeiro contato a
 * superfície MCP nem existe (nada gera credencial no boot, de propósito — ver token-bootstrap.ts),
 * então um adotante que ainda não armou nada só alcança este diagnóstico por aqui.
 *
 * SAI SEMPRE 0, inclusive reprovando. Um doutor chamado de dentro de um script com `set -e` que
 * termina não-zero é MORTO antes de a saída dele ser lida — quem chama ramifica no `worst` (ou no
 * JSON), que é o lugar onde o veredito está.
 */
export const PREFLIGHT_FLAG = "--preflight";

import { FLAGS_CONHECIDAS, textoDeAjuda, classificarArgv } from "./argv";
export { FLAGS_CONHECIDAS, MODIFICADORES, textoDeAjuda, classificarArgv } from "./argv";



/**
 * O unit do systemd para ESTA máquina: `node dist/ah-server.mjs --generate-systemd-unit`.
 *
 * IMPRIME, nunca instala. Escrever em /etc/systemd/system/ é mais privilegiado que
 * `--generate-mcp-token`, que já só imprime e deixa o humano colocar.
 */
export const GENERATE_SYSTEMD_UNIT_FLAG = "--generate-systemd-unit";

/**
 * A fiação do cliente MCP: `node dist/ah-server.mjs --print-mcp-client-config --credential <valor>`.
 *
 * Fecha um buraco medido: NADA que viaja documenta como ligar o Claude Code (ou o app) a este board.
 * O adotante recebia o comando de emitir credencial e um curl cru — e a promessa de "orquestre pelo
 * celular" não tinha instrução nenhuma.
 *
 * Ele NÃO inventa credencial e NÃO lê a do ambiente: quem chama passa a que acabou de emitir. Um
 * comando que fosse buscar o token sozinho imprimiria em tela um segredo que ninguém pediu.
 */
export const PRINT_MCP_CLIENT_CONFIG_FLAG = "--print-mcp-client-config";

// ── OS COMANDOS DO HANDLE REVOGÁVEL — sem eles a mitigação não EXISTE ───────────────────────────
//
// O que estes três comandos IMPEDEM: que "revogável na hora, sem restart" continue sendo uma
// promessa que o operador NÃO CONSEGUE cumprir.
//
// `lib/auth/mcp-handle.ts` nasceu (onda 2) com `createMcpHandle`/`revokeMcpHandle` e ZERO chamador
// fora dos próprios testes. Isso é exatamente o anti-padrão que este repo já pagou uma vez
// ("capacidade DECLARADA com zero produtores"): o handle vazava no log de um intermediário — o dano
// MEDIDO em story-u4yf1i, 174 gravações do token em texto claro — e o dono não tinha comando nenhum
// para tirá-lo do ar. A alternativa real era editar `storymap/.runner/mcp-handles.json` à mão,
// concorrendo com o serviço vivo, que é a corrida que o lock entre processos daquele módulo fecha.
//
// Estes comandos são o CAMINHO DE ROTAÇÃO que não exige restart, e é por isso que eles fecham
// story-u4yf1i sem tocar no `.env.local`: emita um handle, mova o conector para ele, e a partir daí
// TODA troca futura é um comando — não uma janela de manutenção com autorização do dono.
//
// Por que comandos de processo separado e não uma tela: a rotação tem de funcionar quando o rosto
// está fora do ar (deploy, boot travado) e sem depender do login. É a mesma postura do
// `--generate-mcp-token`, e o `pid` no lock existe justamente porque o escritor normal aqui é um
// segundo processo.

/** Emite um handle novo. Exige `--level <ro|write|orch|full>`; aceita `--label "..."`. */
export const GENERATE_MCP_HANDLE_FLAG = "--generate-mcp-handle";
/** Lista os handles conhecidos — id público, nível, rótulo, datas. NUNCA o segredo. */
export const LIST_MCP_HANDLES_FLAG = "--list-mcp-handles";
/** Revoga por id público: `--revoke-mcp-handle <id>`. Vale no request seguinte, sem restart. */
export const REVOKE_MCP_HANDLE_FLAG = "--revoke-mcp-handle";

/** O bloco de uso, impresso quando a invocação está incompleta — nunca um erro nu. */
export const MCP_HANDLE_USAGE =
  `  AgileHarness — handles MCP (credencial revogável para o path /api/mcp/<credencial>/mcp)\n\n` +
  `    node dist/ah-server.mjs ${GENERATE_MCP_HANDLE_FLAG} --level <ro|write|orch|full> [--label "conector do chat web"]\n` +
  `    node dist/ah-server.mjs ${LIST_MCP_HANDLES_FLAG}\n` +
  `    node dist/ah-server.mjs ${REVOKE_MCP_HANDLE_FLAG} <id>\n\n` +
  `  Diferente do ${MCP_TOKEN_ENV}, um handle é revogável SEM reiniciar o serviço: o registro é\n` +
  `  relido a cada resolução, então a revogação vale no request seguinte.\n`;

/**
 * Palavras de credencial-de-EXEMPLO. Não é dicionário de senha — não é senha que estamos defendendo:
 * é a lista do que um `docker-compose.yml` de tutorial, um `.env` colado de um README ou um script de
 * deploy COPIAM. O default de fábrica que o plano OSS quer que não exista.
 */
const PLACEHOLDER_WORDS = [
  "changeme",
  "change-me",
  "change_me",
  "troque",
  "trocar",
  "placeholder",
  "example",
  "exemplo",
  "sample",
  "default",
  "dummy",
  "insecure",
  "password",
  "senha",
  "secret",
  "segredo",
  "agileharness",
] as const;

/**
 * Por que esta credencial não pode ficar de frente para a rede — já em texto prescritivo. `null`
 * quando pode.
 *
 * A régua estatística é a CANÔNICA do pacote (`secretWeakness`, em `lib/storymap/mcp/auth.ts`:
 * comprimento, motivo repetido, variedade, Shannon) e NÃO é recopiada aqui — dois medidores de
 * entropia no mesmo pacote seriam duas verdades, e a que apodrece é sempre a de fora.
 *
 * O que ESTE arquivo acrescenta é o único sinal que aquela régua declara não cobrir ("Shannon sobre
 * frequência não vê estrutura de linguagem — uma frase memorizável de 32 caracteres passa"): a
 * credencial de EXEMPLO. `changeme-changeme-…`, `trocar-esta-senha-…` e `…-secret-token-example`
 * passam por variedade e por entropia, e são exatamente o que se copia de um tutorial. Em loopback
 * isso não é problema de ninguém; com a porta na rede é a chave debaixo do tapete, e o boot é o
 * último lugar onde ainda dá para recusar.
 */
export function weakSecretReason(value: string | undefined): string | null {
  const w = secretWeakness(value);
  if (w) return weaknessAdvice(w);
  const lower = (value ?? "").trim().toLowerCase();
  if (PLACEHOLDER_WORDS.some((p) => lower.includes(p))) {
    return `parece uma credencial de EXEMPLO (contém palavra de placeholder). Gere um forte com:  ${GENERATE_TOKEN_HINT}`;
  }
  return null;
}

/** Atalho legível de {@link weakSecretReason} para quem só precisa do sim/não. */
export function isWeakSecret(value: string | undefined): boolean {
  return weakSecretReason(value) !== null;
}

/**
 * O bind fica restrito a ESTA máquina?
 *
 * Cobre o `127.0.0.0/8` inteiro, o `::1` (com ou sem colchetes, expandido ou não) e `localhost`.
 * Qualquer outra coisa — `0.0.0.0`, `::`, um IP de LAN — é alcançável por outra máquina, e é isso
 * que a auditoria chama de EXPOSTO: a régua não é "a internet chega", é "não é só eu".
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export interface BindAudit {
  /** o bind escolhido é alcançável por outra máquina? */
  exposed: boolean;
  /** o dono declarou o override literal? (não CONSERTA nada — só assume o risco) */
  overridden: boolean;
  /**
   * Credenciais ALCANÇÁVEIS que dá para adivinhar, em texto prescritivo. Medido SEMPRE — inclusive
   * em loopback, porque o bind não é o único caminho até elas (ver `auditBind`).
   */
  weaknesses: string[];
  /**
   * O que IMPEDE subir. É `weaknesses` mais o que é específico de bind aberto — e some por completo
   * em loopback, onde fraqueza é AVISO e não veredito. Vazio = pode ficar de frente para a rede.
   */
  failures: string[];
}

/**
 * A auditoria. PURA sobre um ambiente: é o que a deixa testável sem socket e sem boot, do mesmo
 * jeito que `terminal-gateway.ts` separa política de encanamento.
 *
 * ⚠️ Chame-a DEPOIS do `loadEnvConfig` do topo deste arquivo e DEPOIS de `ensureAuthSecrets()`: só
 * então a env carrega o valor EFETIVO de cada segredo (o do 12-factor, o do `.env.local`, ou o
 * aleatório do arquivo do runner). Auditar a ENTRADA em vez do efetivo erra para os DOIS lados —
 * acusa de fraca uma instalação que usa o segredo forte do arquivo, e, pior, imprime o PASS
 * afirmativo sobre um ambiente que não continha os segredos.
 *
 * A ENTROPIA das credenciais roda SEMPRE, não só com bind aberto. Motivo: a topologia REAL deste
 * produto é loopback + TÚNEL — a máquina viva tem `AGILEHARNESS_HOST=127.0.0.1` e o header de
 * `api/mcp/[secret]/[transport]/route.ts` declara que o endpoint MCP está na internet pública POR
 * DESENHO (o conector do Claude conecta da nuvem da Anthropic). Retornar cedo em loopback deixava
 * `AGILEHARNESS_AUTH_TOKEN=changeme-changeme-changeme-change` passar SEM exame justo na configuração
 * que de fato ship. O que continua condicionado ao bind aberto é só o VEREDITO (`failures` ⇒ recusa)
 * e o item que é específico de bind aberto (o bundler de dev).
 */
export function auditBind(env: EnvLike = process.env): BindAudit {
  const exposed = !isLoopbackHost(resolveHost(env));
  const overridden = env[ALLOW_PUBLIC_BIND_ENV] === "1";
  const weaknesses: string[] = [];

  const sessao = weakSecretReason(env[SESSION_SECRET_ENV]);
  if (sessao) {
    weaknesses.push(
      `${SESSION_SECRET_ENV} — assina o cookie de sessão (fraco ⇒ sessão forjável), e ${sessao} ` +
        `Ou simplesmente APAGUE a env: sem ela o serviço gera um segredo aleatório no boot.`,
    );
  }
  const operador = weakSecretReason(env[TOKEN_ENV]);
  if (operador) {
    weaknesses.push(
      `${TOKEN_ENV} — é a senha do /login, e ${operador} ` +
        `Ou APAGUE a env e use o token que o serviço cria em storymap/.runner/auth-token.`,
    );
  }
  // Todo TIER de token do MCP, achado por PREFIXO — `AGILEHARNESS_MCP_TOKEN`, `_ORCH`, `_SESSION` e o
  // que `settings.yaml` (mcpTokens[].tokenEnv) declarar amanhã. Auditar só o primário deixaria de
  // fora o escopado `write`, que move card, enfileira run e abre worktree.
  // AUSENTE não entra na lista de propósito: `isMcpTokenValid` é fail-closed contra segredo ausente e
  // NADA gera um token por conta própria (mcp/token-bootstrap.ts), então sem env a superfície fica
  // FECHADA — exigir que exista não fecharia porta nenhuma, só obrigaria configuração.
  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith("AGILEHARNESS_MCP_TOKEN")) continue;
    if (!env[name]?.trim()) continue;
    const mcp = weakSecretReason(env[name]);
    if (mcp) {
      weaknesses.push(
        `${name} — vale a superfície MCP inteira, cujas tools spawnam ` +
          `\`claude --dangerously-skip-permissions\` nesta máquina, e ${mcp}`,
      );
    }
  }

  // O VEREDITO é o que depende do bind. Em loopback a lista fica vazia: quem já está na máquina já
  // está dentro, e recusar o boot ali tiraria o serviço inteiro de quem roda local — custo alto por
  // risco baixo. A medição, essa, o operador vê nos dois casos.
  const failures = exposed ? [...weaknesses] : [];
  if (exposed && isDevMode(env)) {
    // A checagem de Origin (a defesa contra a classe ClawJacked) só cobre TODO upgrade quando o app
    // é dono EXCLUSIVO do evento — o que vale em produção, onde `wsOwner` é o emissor morto e um
    // upgrade sem dono morre em `socket.destroy()`. Em dev o listener do Next volta ao servidor de
    // verdade (o HMR precisa dele) e passa a aceitar handshake sem Origin nenhum; de brinde, o
    // bundler de dev serve fonte e overlay para quem chegar.
    failures.push(
      `AGILEHARNESS_DEV=1 com bind aberto — em dev o app não é dono exclusivo do evento \`upgrade\`, ` +
        `então a validação de Origin do WebSocket não cobre tudo, e o bundler serve fonte a qualquer um.`,
    );
  }
  return { exposed, overridden, weaknesses, failures };
}

/** O relato de boot do bind aberto: o risco nomeado, o que reprovou, e a saída para cada caso. */
export function bindAuditMessage(audit: BindAudit, host: string, port: number): string {
  const cabeca =
    `\n[ah-server] ⚠ BIND ABERTO — ${host}:${port} NÃO é loopback: outras máquinas alcançam este ` +
    `serviço e, sem firewall, a internet também.\n` +
    `  Nesta porta vivem o /login (token do operador), o /api/mcp/<token>/mcp (cujas tools spawnam ` +
    `claude com skip-permissions nesta máquina) e o /terminal (um shell).\n`;
  if (audit.failures.length === 0) {
    return `${cabeca}  Auto-checagem: OK — toda credencial alcançável passou o teste de entropia.\n`;
  }
  const lista = audit.failures.map((f) => `    • ${f}`).join("\n");
  const rodape = audit.overridden
    ? `  ${ALLOW_PUBLIC_BIND_ENV}=1 declarado: subindo ASSIM MESMO, com ${audit.failures.length} ` +
      `garantia(s) ausente(s). O risco é seu, e este aviso sai em todo start.\n`
    : `  RECUSANDO subir. Conserte o que está listado acima, ou declare ${ALLOW_PUBLIC_BIND_ENV}=1 ` +
      `(literal exato) para assumir o risco.\n`;
  return `${cabeca}  Auto-checagem REPROVOU ${audit.failures.length} garantia(s):\n${lista}\n${rodape}`;
}

/**
 * O relato de LOOPBACK: a MESMA medição de entropia, sem veredito. `null` quando não há nada a dizer.
 *
 * Por que avisar num bind fechado: o bind não é o único caminho até estas credenciais. A instalação
 * real é loopback + TÚNEL, e `/api/mcp/<token>/mcp` atravessa o túnel por desenho — então
 * "loopback" nunca quis dizer "inalcançável". O que este aviso IMPEDE é a credencial de tutorial
 * envelhecer em silêncio até o dia em que alguém abre a porta (ou publica o túnel) e ninguém lembra
 * que ela está lá. Aviso, e não recusa, porque em loopback quem já está na máquina já está dentro:
 * derrubar o serviço custaria a capacidade inteira do agente sem fechar porta nenhuma.
 */
export function weakCredentialsMessage(audit: BindAudit): string | null {
  if (audit.weaknesses.length === 0) return null;
  const lista = audit.weaknesses.map((f) => `    • ${f}`).join("\n");
  return (
    `\n[ah-server] ⚠ auto-checagem de credenciais REPROVOU ${audit.weaknesses.length} item(ns) — o bind está ` +
    `em loopback, então isto NÃO impede o boot:\n${lista}\n` +
    `  Vale mesmo em loopback porque o túnel/proxy que publica este serviço não passa pelo bind: o ` +
    `/api/mcp/<token>/mcp está na internet pública por desenho. Com AGILEHARNESS_HOST fora do loopback, ` +
    `cada item acima RECUSA o boot.\n`
  );
}

/** A flag está presente, nas duas formas que um operador digita (`--f v` e `--f=v`)? */
/**
 * As sondas do host, montadas uma vez e usadas pelos DOIS consumidores (boot e `--preflight`).
 *
 * `claudeName` fica de fora de propósito: `preflight.ts` não pode importar `runner/config.ts` sem
 * arrastar o yaml e a árvore de board para dentro deste bundle. O relatório DIZ que mediu o nome
 * default — divergência visível vale mais que precisão silenciosa.
 */
async function sondasDoHost() {
  const { spawnSync } = await import("node:child_process");
  const { existsSync, readdirSync, readFileSync } = await import("node:fs");
  const { findRepoRoot, runnerStateDir } = await import("@/lib/storymap/paths");
  let raiz: string | null = null;
  let toolPkg: string | null = null;
  try {
    const { findToolPackageDir } = await import("@/lib/storymap/paths");
    toolPkg = findToolPackageDir();
  } catch {
    toolPkg = null;
  }
  try {
    raiz = findRepoRoot();
  } catch {
    raiz = null; // o próprio preflight relata isto como `repo.root: missing`, com o conserto.
  }
  // O AMBIENTE DO SERVIÇO, e não o deste shell. `service.lock` publica o pid; em Linux o env real
  // dele está em /proc/<pid>/environ. É esta leitura que faz o diagnóstico falar do processo que
  // de fato spawna os agentes — sem ela o relatório mede o PATH de quem digitou o comando.
  let envMedido: Record<string, string | undefined> = process.env;
  let fonte: { kind: "servico"; pid: number } | { kind: "processo" } = { kind: "processo" };
  if (raiz) {
    try {
      const { readFileSync } = await import("node:fs");
      const lock = JSON.parse(readFileSync(`${raiz}/storymap/.runner/service.lock`, "utf8")) as { pid?: number };
      const pid = Number(lock?.pid);
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
        const bruto = readFileSync(`/proc/${pid}/environ`, "utf8");
        const doServico: Record<string, string> = {};
        // String.fromCharCode(0) e nao um escape: `"\0"` num literal e barra-invertida + zero,
        // e /proc/<pid>/environ e separado pelo BYTE NUL. O engano passa no typecheck e devolve
        // uma lista de um elemento so — verde silencioso.
        for (const par of bruto.split(String.fromCharCode(0))) {
          const i = par.indexOf("=");
          if (i > 0) doServico[par.slice(0, i)] = par.slice(i + 1);
        }
        if (doServico.PATH) {
          envMedido = doServico;
          fonte = { kind: "servico", pid };
        }
      }
    } catch {
      // Sem lock, pid morto, ou /proc ausente (macOS): fica o env deste processo, e o relatório DIZ.
    }
  }

  // A PORTA: ocupada por nós mesmos é o normal (o serviço está de pé); por outro processo é o
  // EADDRINUSE que mata o boot. O preflight distingue os dois no texto; aqui só medimos.
  const { createServer } = await import("node:net");
  const portaOcupada = (h: string, porta: number): boolean | null => {
    try {
      const s = createServer();
      let veredito: boolean | null = null;
      s.once("error", (e: NodeJS.ErrnoException) => { veredito = e.code === "EADDRINUSE"; });
      s.listen({ host: h, port: porta, exclusive: true });
      // `listen` é assíncrono; esta sonda é síncrona por contrato, então o que sai daqui é o que já
      // se sabe. Sem resposta ⇒ `null`, que o relatório reporta como NÃO MEDIDO — nunca como livre.
      s.close();
      return veredito;
    } catch {
      return null;
    }
  };

  return {
    repoRoot: raiz,
    env: envMedido,
    // O env DESTE processo, ao lado do medido: e o que deixa o relatorio dizer QUANDO os dois
    // divergem. Uma instancia subindo AO LADO de um servico vivo lia a porta do vizinho sem
    // saber (medido em 2026-08-27: subiu em 3044, o relatorio disse 3008).
    envDesteProcesso: process.env,
    // AS UNITS DO SYSTEMD que citam caminho ABSOLUTO desta árvore. Lidas dos ARQUIVOS, não do
    // `systemctl`: o daemon pode não existir (container, macOS) e um erro dele viraria "não medi"
    // quando a resposta honesta é a mesma — mas o arquivo é o que o operador vai editar, então é
    // dele que o relatório tem de falar. Drop-ins entram, porque é neles que um override se esconde.
    unidades: await (async () => {
      if (!raiz) return null;
      const { lerCaminhosDeUnit } = await import("@/lib/storymap/cutover-checks");
      const out: { unit: string; caminhos: string[]; ausentes: string[] }[] = [];
      const varrer = (arquivo: string, unit: string) => {
        let texto = "";
        try {
          texto = readFileSync(arquivo, "utf8");
        } catch {
          return;
        }
        const { caminhos, ausentes } = lerCaminhosDeUnit(texto, { raiz, existe: existsSync });
        if (caminhos.length) out.push({ unit, caminhos, ausentes });
      };
      try {
        const base = "/etc/systemd/system";
        for (const e of readdirSync(base, { withFileTypes: true })) {
          if (e.isFile() && /\.(service|timer)$/.test(e.name)) varrer(`${base}/${e.name}`, e.name);
          else if (e.isDirectory() && e.name.endsWith(".d")) {
            for (const d of readdirSync(`${base}/${e.name}`, { withFileTypes: true })) {
              if (d.isFile() && d.name.endsWith(".conf")) varrer(`${base}/${e.name}/${d.name}`, `${e.name}/${d.name}`);
            }
          }
        }
      } catch {
        return null; // sem /etc/systemd/system nada é afirmado — o check não aparece
      }
      return out;
    })(),
    // «DÁ PARA REINICIAR AGORA?» — as três medições, lidas do ledger DURÁVEL (é ele que sobrevive ao
    // restart, e é dele que o sweep de recuperação parte). Qualquer uma ilegível ⇒ `null`, e o check
    // não aparece: um "seguro" afirmado sobre estado que ninguém leu é pior que item nenhum.
    reinicio: (() => {
      if (!raiz) return null;
      const ler = (nome: string): unknown => {
        try {
          return JSON.parse(readFileSync(`${runnerStateDir()}/${nome}`, "utf8"));
        } catch {
          return null;
        }
      };
      const journal = ler("journal.json");
      const fila = ler("merge-queue.json");
      if (journal == null || fila == null) return null;
      const entradas = (x: unknown): { status?: string }[] => {
        if (Array.isArray(x)) return x as { status?: string }[];
        const o = x as { entries?: unknown; runs?: unknown };
        const a = o?.entries ?? o?.runs;
        return Array.isArray(a) ? (a as { status?: string }[]) : [];
      };
      // Run ATIVO = tudo que o ledger não deu por encerrado. A régua é por NEGAÇÃO de propósito: um
      // status novo que ninguém previu conta como ativo, e errar para o lado de "não reinicie" é o
      // lado barato do engano.
      const ENCERRADOS = new Set(["done", "failed", "cancelled", "interrupted", "aborted"]);
      const runsAtivos = entradas(journal).filter((e) => !ENCERRADOS.has(String(e.status ?? ""))).length;
      const filaEsperando = entradas(fila).filter((e) => String(e.status ?? "") === "waiting").length;
      let boardsArmados: string[] = [];
      try {
        boardsArmados = readdirSync(`${raiz}/storymap/boards`, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
          .filter((d) => !/^\s*autorunDisabled:\s*true\s*$/m.test(readFileSync(`${raiz}/storymap/boards/${d.name}/board.yaml`, "utf8")))
          .map((d) => d.name);
      } catch {
        return null; // não consegui medir os boards ⇒ não afirmo nada sobre reiniciar
      }
      return { runsAtivos, filaEsperando, boardsArmados };
    })(),
    pacoteDaFerramentaNoAlvo: (() => {
      if (!raiz) return null;
      // O pacote da ferramenta COMO ELE APARECE DENTRO DO ALVO. Enquanto as duas árvores coincidem é
      // o mesmo diretório; quando divergirem, é exatamente este caminho que as units vão continuar
      // citando e que terá deixado de ser a ferramenta.
      try {
        const rel = toolPkg && toolPkg.startsWith(`${raiz}/`) ? toolPkg.slice(raiz.length + 1) : "packages/storymap-ui";
        return `${raiz}/${rel}`;
      } catch {
        return null;
      }
    })(),
    // OS BOARDS DA RAIZ e o ESTADO DO MOTOR: as duas sondas que impedem o relatorio de ficar
    // verde no caso perigoso (raiz = o proprio checkout da ferramenta) e de cobrar um servico
    // vivo que a postura segura proibe existir (motor inerte nao escreve service.lock).
    boardsNaRaiz: (() => {
      if (!raiz) return undefined;
      try {
        return readdirSync(`${raiz}/storymap/boards`, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch {
        return undefined; // sem diretorio de boards nada e afirmado
      }
    })(),
    motorInerte: (process.env.AGILEHARNESS_ENGINE ?? "").trim().toLowerCase() === "off",
    envSource: fonte,
    portaOcupada,
    run: (cmd: string, args: string[]) => {
    try {
      // Teto por comando: quatro sondas spawnam, e um host doente não pode transformar um
      // diagnóstico em travamento de boot.
      const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 1500 });
      if (r.error || r.status == null) return null;
      return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    } catch {
      return null;
  }
    },
  };
}

/**
 * O aviso da TELA, compartilhado pelos comandos que mostram uma credencial.
 *
 * Uma constante e não duas cópias: os dois comandos advertem o MESMO canal, e duas redações divergem
 * — a que apodrece é sempre a que menos gente lê. O texto NÃO nomeia o mecanismo de propósito: este
 * bloco chega ao chat pelo próprio ato que ele adverte.
 */
export const AVISO_DE_CREDENCIAL_NA_TELA =
  "  ⚠️ Commit e log de proxy JÁ são barrados. O que não tem portão é ESTA TELA: colada num chat com um\n" +
  "  agente ela sai da máquina para a nuvem de um modelo; deixada no scrollback, outra sessão do board a\n" +
  "  lê. Copie o valor, limpe a tela — se ela já saiu daqui, revogue com o comando de revogação.";

function temFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag) || argv.some((a) => a.startsWith(`${flag}=`));
}

/**
 * O valor de uma flag. `undefined` quando ela não veio ou veio vazia.
 *
 * Recusar um próximo token que começa com `--` é o que impede `--revoke-mcp-handle --list-mcp-handles`
 * de tentar revogar um id chamado "--list-mcp-handles": um comando destrutivo que adivinha o
 * argumento faltante é pior que um que reclama.
 */
function valorDaFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0) {
    const prox = argv[i + 1];
    if (prox && !prox.startsWith("--")) return prox.trim() || undefined;
  }
  const colado = argv.find((a) => a.startsWith(`${flag}=`));
  return colado ? colado.slice(flag.length + 1).trim() || undefined : undefined;
}

/**
 * OS COMANDOS DE HANDLE. `true` = uma delas foi reconhecida e o processo NÃO deve subir o serviço.
 *
 * Exportada para o teste poder exercer cada desfecho, mas quem PROVA a fiação é o teste que passa
 * pela `main()` com o argv real — uma primitiva com produtor só no teste é o defeito que esta onda
 * está fechando, e o mesmo cuidado vale para o produtor.
 *
 * Falha sempre com `process.exitCode = 1` e mensagem prescritiva, NUNCA com exceção nua: quem chama
 * isto é um script de provisionamento, e um `--revoke-mcp-handle` que "termina" sem revogar (id
 * errado, registro travado por outro processo) tem de ser detectável pelo código de saída. Uma
 * revogação que mente sobre ter acontecido é pior que nenhuma.
 */
export async function runMcpHandleCommand(argv: string[]): Promise<boolean> {
  const emitir = temFlag(argv, GENERATE_MCP_HANDLE_FLAG);
  const listar = temFlag(argv, LIST_MCP_HANDLES_FLAG);
  const revogar = temFlag(argv, REVOKE_MCP_HANDLE_FLAG);
  if (!emitir && !listar && !revogar) return false;

  const { createMcpHandle, listMcpHandles, mcpHandlesPath, revokeMcpHandle } = await import("@/lib/auth/mcp-handle");

  try {
    if (emitir) {
      const { MCP_LEVELS } = await import("@/lib/storymap/types");
      const nivel = valorDaFlag(argv, "--level");
      // O nível é OBRIGATÓRIO e sem default. Um default silencioso aqui seria a instalação decidindo
      // por conta própria QUANTA autoridade a credencial que vai para uma URL pública carrega —
      // emitir `full` (deploy, shell, delete) tem de ser uma escolha escrita pelo operador.
      if (!nivel || !(MCP_LEVELS as readonly string[]).includes(nivel)) {
        console.error(
          `\n  ${GENERATE_MCP_HANDLE_FLAG}: --level é OBRIGATÓRIO e precisa ser um de ` +
            `${MCP_LEVELS.join(" | ")}${nivel ? ` (recebi "${nivel}")` : ""}.\n` +
            `  Sem default de propósito: o nível é QUANTO poder a credencial carrega.\n\n${MCP_HANDLE_USAGE}`,
        );
        process.exitCode = 1;
        return true;
      }
      const { handle, record, file } = await createMcpHandle({
        level: nivel as McpLevel,
        label: valorDaFlag(argv, "--label"),
      });
      // O valor apresentável é impresso AQUI e em nenhum outro lugar — não é persistido nem
      // re-derivável (o registro guarda só o sha-256). Comando interativo cujo produto É esta linha.
      console.info(
        `\n  AgileHarness — handle MCP emitido: nível ${record.level}` +
          `${record.label ? `, rótulo "${record.label}"` : ""}. Registrado em ${file} (modo 0600).\n\n` +
          `  ⚠️ Este valor aparece UMA VEZ. Use-o no lugar do token na URL do connector:\n\n` +
          `    https://<seu-tunel>/api/mcp/${handle}/mcp\n\n` +
          `  Revogar depois — vale no request SEGUINTE, sem reiniciar o serviço:\n\n` +
          `    node dist/ah-server.mjs ${REVOKE_MCP_HANDLE_FLAG} ${record.id}\n\n` +
          // ⚠️ ESTE AVISO MUDOU (2026-08-12) PORQUE ELE AVISAVA O RISCO ERRADO.
          //
          // O texto anterior era "quem o ler num log de proxy entra" + "NUNCA o comite". MEDIDO: os
          // dois canais que ele nomeava JÁ TÊM PORTÃO. O commit é barrado pelo scan de segredos, que
          // reconhece a forma do handle e a da URL do connector — e reconhece SÓ ela: prosa com
          // `<credencial>` e log já redigido atravessam, então não é carimbo. E o log do proxy é
          // redigido na origem desde que 169 linhas com credencial foram achadas num journal
          // persistente. Um aviso que aponta para portas fechadas gasta a atenção do leitor no lugar
          // errado — e ela é finita justamente no instante em que ele tem a credencial na mão.
          //
          // O QUE NÃO TEM PORTÃO é esta tela. Ela sai da máquina por duas portas que nenhum controle
          // deste repositório alcança: colada num chat com um agente (vai para a nuvem de um modelo)
          // ou deixada no scrollback de um terminal do board, que outra sessão consegue ler.
          //
          // O TEXTO NÃO NOMEIA O MECANISMO, e isso é decisão, não descuido: este bloco chega ao chat
          // PELO PRÓPRIO ATO que ele adverte, e o scrollback em que ele fica é lido pela superfície
          // que o risco descreve. Escrever aqui QUAL tool lê a tela e com QUAL nível de token seria
          // entregar a receita colada na credencial. Nomeia-se o canal e a ação; nunca a ferramenta.
          `${AVISO_DE_CREDENCIAL_NA_TELA}\n`,
      );
      return true;
    }

    if (listar) {
      const handles = await listMcpHandles();
      if (handles.length === 0) {
        console.info(
          `\n  Nenhum handle MCP emitido (registro: ${mcpHandlesPath()}).\n` +
            `  A superfície MCP segue aberta só pelo ${MCP_TOKEN_ENV}, que exige restart para rotacionar.\n\n${MCP_HANDLE_USAGE}`,
        );
        return true;
      }
      // Só a projeção pública (`mcpHandleSummary`): nem o segredo — que não é persistido — nem o
      // digest. Este texto vai para o scrollback do terminal e, de lá, para handoffs colados.
      const linhas = handles.map((h) => {
        const uso = h.revokedAt ? `REVOGADO em ${h.revokedAt}` : `último uso ${h.lastUsedAt ?? "nunca"}`;
        return `    ${h.id}  ${h.level.padEnd(5)}  criado ${h.createdAt}  ${uso}${h.label ? `  — ${h.label}` : ""}`;
      });
      console.info(
        `\n  Handles MCP conhecidos (${handles.length}) — registro: ${mcpHandlesPath()}\n\n${linhas.join("\n")}\n\n` +
          `  "último uso nunca" num handle antigo = credencial esquecida; revogue sem medo:\n` +
          `    node dist/ah-server.mjs ${REVOKE_MCP_HANDLE_FLAG} <id>\n`,
      );
      return true;
    }

    const id = valorDaFlag(argv, REVOKE_MCP_HANDLE_FLAG);
    if (!id) {
      console.error(`\n  ${REVOKE_MCP_HANDLE_FLAG} exige o id público do handle.\n\n${MCP_HANDLE_USAGE}`);
      process.exitCode = 1;
      return true;
    }
    const desfecho = await revokeMcpHandle(id);
    if (desfecho === "desconhecido") {
      // exitCode 1: um script que revoga em resposta a incidente NÃO pode achar que deu certo com o
      // id errado — o handle vazado continuaria vivo e ninguém saberia.
      console.error(
        `\n  Handle "${id}" não existe no registro (${mcpHandlesPath()}) — NADA foi revogado.\n` +
          `  Confira o id com:  node dist/ah-server.mjs ${LIST_MCP_HANDLES_FLAG}\n`,
      );
      process.exitCode = 1;
      return true;
    }
    console.info(
      `\n  Handle ${id}: ${desfecho === "revogado" ? "REVOGADO" : "já estava revogado"}.\n` +
        `  O registro é relido a cada resolução, então ele para de autenticar no request SEGUINTE — ` +
        `sem restart do serviço.\n` +
        `  A entrada NÃO foi apagada de propósito: se este handle voltar a ser apresentado, é sinal de ` +
        `vazamento EM USO, e o rastro consegue nomeá-lo.\n`,
    );
    return true;
  } catch (err) {
    console.error(
      `\n  Comando de handle MCP FALHOU: ${err instanceof Error ? err.message : String(err)}\n` +
        `  Nada foi alterado no registro (${mcpHandlesPath()}).\n`,
    );
    process.exitCode = 1;
    return true;
  }
}

const ttyd = ttydTargetFromEnv();
const server = createServer();

/**
 * QUEM É DONO DO EVENTO `upgrade`.
 *
 * O Next anexa o PRÓPRIO listener de `upgrade` no primeiro request (`NextCustomServer.
 * setupWebSocketHandler`, em dist/server/next.js) usando `options.httpServer` — o ÚNICO lugar do
 * Next que lê esse campo (verificado na fonte instalada, next@14.2.35).
 *
 *   • Em DEV ele é obrigatório: é por ali que passa o HMR (`/_next/webpack-hmr`). Passamos o
 *     servidor de verdade e nos limitamos a interceptar `/ttyd/*` (o resolvedor do Next não casa
 *     nenhuma saída para esse path, então ele deixa o socket em paz — comportamento documentado no
 *     próprio código dele: *"user's custom WS server may be listening on the same path"*).
 *   • Em PRODUÇÃO o handler dele só sabe fazer uma coisa com um upgrade que case uma rota:
 *     `socket.end()`. Isso cortaria o nosso túnel no meio, e depender de "ele não vai casar" é
 *     depender de sorte. Damos a ele um EventEmitter que nunca emite, e assumimos a posse
 *     exclusiva do evento. Nenhuma funcionalidade se perde: fora do HMR de dev, o Next não trata
 *     upgrade nenhum.
 */
const wsOwner = dev ? server : new EventEmitter();

const app = next({
  dev,
  dir: process.cwd(),
  hostname: host,
  port,
  // `httpServer` é opção REAL do `next()` (usada por setupWebSocketHandler) mas não aparece no
  // `.d.ts` público — daí o cast, deliberadamente estreito.
  httpServer: wsOwner,
} as Parameters<typeof next>[0]);

async function main(): Promise<void> {
  // AJUDA E ARGUMENTO DESCONHECIDO — antes de tudo, inclusive da cerca do alvo.
  //
  // Nenhum dos dois toca disco, rede ou credencial, então nada aqui precisa da cerca; e vir ANTES é
  // o que garante que `--help` nunca deposite nada na árvore de quem só queria ler a ajuda.
  {
    const veredito = classificarArgv(process.argv.slice(2));
    if (veredito.tipo === "ajuda") {
      process.stdout.write(textoDeAjuda() + "\n");
      return;
    }
    if (veredito.tipo === "desconhecida") {
      process.stderr.write(
        `argumento não reconhecido: ${veredito.argumentos.join(", ")}\n\n` +
          `NÃO subi o serviço de propósito: um argumento que o entrypoint não conhece é quase sempre um\n` +
          `engano, e subir um servidor em cima de um engano é a pior resposta possível — numa porta\n` +
          `ocupada morre com EADDRINUSE, numa livre sobe um serviço que ninguém pediu.\n\n` +
          textoDeAjuda() +
          "\n",
      );
      process.exitCode = 2;
      return;
    }
  }

  // A CERCA DO ALVO VEM PRIMEIRO — antes até do despacho de flags.
  //
  // A POSIÇÃO É O CONSERTO. Os dois comandos abaixo (`--generate-mcp-token` e os de handle)
  // escrevem credencial em `<alvo>/storymap/.runner/` e dão `return` sem NUNCA chegar ao
  // `ensureAuthSecrets` lá embaixo. MEDIDO num clone virgem de um adotante: um único
  // `--generate-mcp-handle` deposita `mcp-handles.json` na árvore dele, `git status` mostra
  // `?? storymap/`, e `check-ignore` responde que nada o cobre — tudo isso ANTES de qualquer
  // serviço subir. Uma cerca posta depois do despacho chegaria tarde justamente no caminho que o
  // README ensina primeiro.
  try {
    const { ensureTargetFence } = await import("@/lib/storymap/target-fence");
    ensureTargetFence();
  } catch (e) {
    console.warn(`[cerca] não foi possível verificar o ignore do alvo: ${(e as Error).message}`);
  }

  // A GERAÇÃO DO TOKEN MCP É UM COMANDO DO OPERADOR — nunca efeito colateral de subir o serviço.
  //
  // O boot não cria credencial nenhuma para a porta MCP (mcp/token-bootstrap.ts explica por quê:
  // gerar no boot fazia TODA instalação nascer com a superfície ARMADA, e as tools dela spawnam
  // `claude --dangerously-skip-permissions` numa URL pública). Quem quer a porta pede por ela:
  //   node dist/ah-server.mjs --generate-mcp-token
  // Aqui — e SÓ aqui — o valor é impresso: este é um comando interativo, cujo produto é justamente a
  // linha que o operador vai colar no `.env.local`. O SERVIÇO nunca imprime segredo (log vai para o
  // journald e para o próximo relatório de bug); o arquivo a 0600 fica como registro para reler.
  if (process.argv.includes(GENERATE_MCP_TOKEN_FLAG)) {
    const { generateAndPersistMcpToken } = await import("@/lib/storymap/mcp/token-bootstrap");
    const { token, file } = generateAndPersistMcpToken();
    console.info(
      `\n  AgileHarness — token MCP gerado (32 bytes em base64url) e registrado em ${file} (modo 0600).\n\n` +
        `  Ponha esta linha em packages/storymap-ui/.env.local (ou no EnvironmentFile= do systemd) e reinicie:\n\n` +
        `    ${MCP_TOKEN_ENV}=${token}\n\n` +
        `  ⚠️ É a ENV que arma a porta, não o arquivo: enquanto ela não existir, /api/mcp/<token>/mcp responde\n` +
        `     404 e a superfície MCP fica FECHADA. Este token dá autonomia total sobre o repo — NUNCA o comite.\n`,
    );
    return; // o serviço NÃO sobe: isto é um comando, não um boot
  }

  // OS COMANDOS DO HANDLE REVOGÁVEL — emitir / listar / revogar.
  //
  // ⚠️ ESTA é a linha que faz a mitigação EXISTIR. Sem ela, `createMcpHandle`/`revokeMcpHandle` são
  // código que só os testes chamam, e o operador que descobre um handle vazado no journal do proxy
  // não tem NENHUM caminho para tirá-lo do ar — foi exatamente assim que o token MCP vazado ficou
  // vivo 54 dias (story-u4yf1i). Antes do `ensureAuthSecrets`/`prepare` de propósito: revogar tem de
  // funcionar com o rosto fora do ar e sem armar motor nenhum.
  if (temFlag(process.argv, GENERATE_SYSTEMD_UNIT_FLAG)) {
    const { renderSystemdUnit, resolveWorkingDir } = await import("@/lib/storymap/systemd-unit");
    const { resolveHostTool } = await import("@/lib/storymap/runner/host-tools");
    const { findRepoRoot } = await import("@/lib/storymap/paths");
    const { existsSync } = await import("node:fs");
    const os = await import("node:os");
    let raiz: string;
    try {
      raiz = findRepoRoot();
    } catch (e) {
      console.error(`não dá para gerar o unit: ${(e as Error).message}`);
      return;
    }
    const r = renderSystemdUnit({
      repoRoot: raiz,
      workingDir: resolveWorkingDir(raiz, existsSync),
      user: os.userInfo().username,
      host: resolveHost(process.env),
      port: Number(process.env.AGILEHARNESS_PORT || process.env.PORT) || 3008,
      nodePath: process.execPath,
      tools: {
        bun: resolveHostTool("bun"),
        just: resolveHostTool("just"),
        claude: resolveHostTool("claude"),
      },
      unitName: valorDaFlag(process.argv, "--unit-name") || "agileharness",
    });
    if (!r.ok) {
      console.error(r.refusal);
      return;
    }
    console.log(r.unit);
    console.log("# ── COMO INSTALAR (revise o unit acima antes) ───────────────────────────────────");
    console.log(r.install);
    return;
  }

  if (temFlag(process.argv, PRINT_MCP_CLIENT_CONFIG_FLAG)) {
    const credencial = valorDaFlag(process.argv, "--credential");
    const porta = Number(process.env.AGILEHARNESS_PORT || process.env.PORT) || 3008;
    const publica = valorDaFlag(process.argv, "--url");
    if (!credencial) {
      console.error(
        `--credential é obrigatório. Emita uma primeiro:\n` +
          `  node dist/ah-server.mjs ${GENERATE_MCP_HANDLE_FLAG} --level write   # revogável sem restart\n` +
          `  node dist/ah-server.mjs ${GENERATE_MCP_TOKEN_FLAG}                  # nível full\n\n` +
          `Este comando não vai buscar a credencial sozinho: imprimir em tela um segredo que ninguém ` +
          `pediu é o oposto do que ele existe para fazer.`,
      );
      return;
    }
    const local = `http://127.0.0.1:${porta}/api/mcp/${credencial}/mcp`;
    console.log(`# Claude Code, NESTA máquina:\n` + `claude mcp add --transport http agileharness ${local}\n`);
    console.log(
      `# ou, como .mcp.json do projeto:\n` +
        JSON.stringify({ mcpServers: { agileharness: { type: "http", url: local } } }, null, 2) +
        "\n",
    );
    if (publica) {
      console.log(`# Para o conector do app (precisa ser alcançável de fora):\n${publica.replace(/\/$/, "")}/api/mcp/${credencial}/mcp\n`);
    } else {
      console.log(
        `# Para o conector do app, passe --url https://<seu-dominio> — o hostname do túnel não é derivável daqui.\n`,
      );
    }
    console.log(AVISO_DE_CREDENCIAL_NA_TELA);
    console.log(
      `  ⚠️ A credencial viaja no CAMINHO da URL. Um log de proxy grava a URI inteira por default —\n` +
        `  configure a redação ANTES de publicar isto, ou o segredo fica escrito em disco a cada request.`,
    );
    return;
  }

  if (temFlag(process.argv, PREFLIGHT_FLAG)) {
    const { runPreflight, preflightMessage } = await import("@/lib/storymap/preflight");
    const relatorio = runPreflight(await sondasDoHost());
    if (temFlag(process.argv, "--json")) {
      console.log(JSON.stringify(relatorio, null, 2));
    } else {
      const bloco = preflightMessage(relatorio);
      console.log(bloco || `preflight: OK — ${relatorio.checks.length} verificações de ambiente passaram.`);
    }
    return;
  }

  if (await runMcpHandleCommand(process.argv)) return;

  // OS SEGREDOS PRIMEIRO — antes do Next, antes do `listen`.
  //
  // `instrumentation.ts` também chama isto (é o único caminho quando alguém sobe `next dev`
  // direto, como faz `scripts/qa-dev-server.ts`), e a função é idempotente por contrato. Mas o
  // hook de instrumentação NÃO é totalmente aguardado pelo `prepare()`: MEDIDO no boot deste
  // servidor, o log saiu na ordem `[auth]` → `[ah-server] escutando` → `[harness-boot]`, ou seja, o
  // `listen` acontece com o `register()` ainda correndo. É uma janela curta, mas nela o portão
  // (fail-closed) não teria segredo e negaria TODO request — inclusive o login. Chamar aqui fecha
  // a janela por construção: quando o primeiro byte entra, a env já está posta.
  const { ensureAuthSecrets, authTokenFile } = await import("@/lib/auth/token");
  const { tokenCreated } = ensureAuthSecrets();
  if (tokenCreated) {
    // O momento de onboarding do self-host: o token nasceu agora e ninguém o viu ainda.
    console.info(
      `\n  AgileHarness — token do operador criado em ${authTokenFile()}\n` +
        `  Leia com:  cat ${authTokenFile()}\n` +
        `  Use-o na tela de login. Guarde-o num gerenciador de senhas.\n`,
    );
  }

  // A AUTO-CHECAGEM DO PERÍMETRO — com os segredos já resolvidos, e ANTES de qualquer coisa subir.
  //
  // A ordem é o controle, e ela tem DOIS degraus: o `loadEnvConfig` do topo deste arquivo (os
  // arquivos .env, onde o token MCP de fato mora na instalação real) e o `ensureAuthSecrets()` logo
  // acima (o token do operador e o segredo de sessão, do 12-factor ou do arquivo do runner). Só
  // depois dos dois a env carrega o valor EFETIVO de cada segredo — o que autentica. Auditar antes
  // disso era o achado: a checagem imprimia o PASS afirmativo sobre um ambiente que não continha os
  // segredos que ela dizia ter aprovado.
  //
  // E nada foi armado ainda: recusar depois do `prepare()` seria recusar com o motor de pé
  // (service.lock, watcher, runs recuperados, merge train); depois do `listen`, com a porta já aberta.
  const audit = auditBind(process.env);
  if (audit.exposed) {
    // stderr a CADA start, inclusive quando a auditoria PASSA: um bind aberto nunca é silêncio.
    console.warn(bindAuditMessage(audit, host, port));
    if (audit.failures.length > 0 && !audit.overridden) {
      // Lança em vez de sair aqui: o `catch` do fim do arquivo é o boot fail-closed do serviço, e
      // ter DOIS jeitos de morrer no boot é ter um deles esquecido no próximo refactor.
      throw new Error(
        `bind não-loopback (${host}:${port}) com ${audit.failures.length} garantia(s) de segurança ` +
          `ausente(s) — RECUSANDO subir. O aviso acima lista o que conserta cada uma. Válvula ` +
          `explícita, se o risco for aceito de propósito: ${ALLOW_PUBLIC_BIND_ENV}=1.`,
      );
    }
  } else {
    // LOOPBACK: a mesma medição, sem veredito (ver `weakCredentialsMessage`). O PASS também sai —
    // uma auto-checagem que só fala quando reprova não deixa provar que ela rodou, e era exatamente
    // por não ter voz aqui que a credencial de tutorial atravessava a topologia que de fato ship.
    const aviso = weakCredentialsMessage(audit);
    if (aviso) console.warn(aviso);
    else
      console.info(
        `[ah-server] auto-checagem de credenciais: OK — toda credencial alcançável passou o teste de entropia.`,
      );
  }

  // ── PREFLIGHT ──────────────────────────────────────────────────────────────────────────────
  // AVISA, NUNCA RECUSA — e a assimetria com a auditoria de bind acima é deliberada. Aquela recusa
  // porque um bind aberto é uma exposição VIVA; esta não pode, porque derrubar o serviço por um
  // `claude` ausente tiraria do ar o board, a leitura de cards, a superfície MCP e a própria
  // capacidade do operador de consertar — em troca de impedir runs que já não rodariam. O
  // fail-closed mora no sítio de spawn (`runner/claude-bin.ts`), onde a consequência está.
  //
  // A linha afirmativa de PASS também sai, pela MESMA razão que a da auditoria de credenciais: uma
  // auto-checagem que só fala quando reprova não deixa provar que rodou. E foi por não ter voz
  // nenhuma aqui que o `spawn claude ENOENT` atravessou seis dias sem ninguém notar.
  try {
    const { runPreflight, preflightMessage } = await import("@/lib/storymap/preflight");
    const relatorio = runPreflight(await sondasDoHost());
    const bloco = preflightMessage(relatorio);
    if (bloco) console.warn(bloco);
    else
    console.info(
      `[ah-server] preflight: OK — ${relatorio.checks.length} verificações de ambiente passaram.`,
    );
  } catch (e) {
    // Um diagnóstico que derruba o boot é pior que a ausência dele.
    console.warn(`[ah-server] preflight não pôde rodar: ${(e as Error).message}`);
  }

  // `prepare()` é o caminho do `next start` (getRequestHandlers → router-server.initialize): é
  // aqui que `instrumentation.ts` roda — service.lock, recuperação de runs, merge train, fila de
  // publicação e o tick do copiloto.
  await app.prepare();
  const handle = app.getRequestHandler();

  // A JANELA DE BOOT, medida. `next.prepare()` não aguarda `instrumentation.ts` até o fim, então o
  // `listen` abaixo acontece com o motor ainda armando (runner/boot-signal.ts explica por que
  // SINALIZAMOS em vez de bloquear). Um request que chega nessa janela é servido por um processo sem
  // service.lock, sem watcher e sem merge train — inofensivo, mas até aqui invisível. Agora ele grita
  // UMA vez, e o fim do boot é cronometrado.
  let avisouJanelaDeBoot = false;
  const avisarSeAindaArmando = (url: string | undefined) => {
    if (avisouJanelaDeBoot || engineBooted()) return;
    avisouJanelaDeBoot = true;
    console.warn(
      `[ah-server] request servido ANTES de o motor terminar de armar (${url ?? "?"}): sem service.lock, ` +
        `sem watcher, sem merge train e sem fila de publicação ainda. Normal por alguns segundos no boot; ` +
        `se persistir, o register() de instrumentation.ts travou.`,
    );
  };

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    avisarSeAindaArmando(req.url);
    // O gateway do terminal vem ANTES do Next de propósito: assim `/ttyd/*` nunca entra no
    // roteador (nem no middleware), e existe UM dono para o backend de terminal — este arquivo.
    if (isTerminalProxyPath(pathnameOf(req.url))) {
      void proxyTerminalHttp(req, res, ttyd);
      return;
    }
    void handle(req, res);
  });

  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (isTerminalProxyPath(pathnameOf(req.url))) {
      void proxyTerminalUpgrade(req, socket, head, ttyd);
      return;
    }
    // Em dev, o que sobra é o HMR — o listener do próprio Next (ver `wsOwner`) responde. Em
    // produção não existe upgrade legítimo fora do terminal, e um socket sem dono é derrubado em
    // vez de ficar pendurado.
    if (!dev) socket.destroy();
  });

  server.on("error", (err) => {
    console.error("[ah-server] erro no servidor HTTP:", err instanceof Error ? err.message : err);
    process.exit(1);
  });

  server.listen(port, host, () => {
    console.log(
      `[ah-server] AgileHarness em http://${host}:${port} (${dev ? "dev" : "produção"}) — ` +
        `terminal via ${ttyd.host}:${ttyd.port}`,
    );
  });

  // Fecha o relato do boot. Um motor que NUNCA arma deixa de ser silêncio: vira um erro nomeado, com
  // a lista do que não está rodando. `unref`ado lá dentro — nunca segura o processo.
  const BOOT_ALARM_MS = 120_000;
  void whenEngineBooted(BOOT_ALARM_MS).then((booted) => {
    // "boot concluído", NÃO "motor armado" — o sinal não carrega a segunda coisa. `markEngineBooted`
    // é chamado num `finally` de propósito, valendo TAMBÉM quando o motor saiu cedo por estar inerte
    // (`AGILEHARNESS_ENGINE=off`, worktree). Enquanto esta linha dizia "motor armado", ela aparecia UMA
    // LINHA DEPOIS de `[harness-boot] MOTOR INERTE` — e um adotante parou o trabalho para reler três
    // vezes, achando que tinha estragado a instalação. Um log que se contradiz na primeira tela
    // envenena toda leitura seguinte que a pessoa fizer do boot.
    if (booted) console.log(`[ah-server] boot do motor concluído em ${engineBootDurationMs()}ms`);
    else
      console.error(
        `[ah-server] o motor NÃO terminou de armar em ${BOOT_ALARM_MS / 1000}s — o register() de ` +
          `instrumentation.ts está travado. Sem ele NÃO rodam: recuperação de runs, merge train, fila de ` +
          `publicação, watcher de board e tick do copiloto. As páginas seguem servindo.`,
      );
  });
}

// Falha no boot tem de ser BARULHENTA e terminal: um servidor meio-inicializado serviria requests
// sem os segredos que o portão exige, e o portão fail-closed trancaria tudo sem dizer por quê.
main().catch((err) => {
  console.error("[ah-server] falha ao iniciar:", err);
  process.exit(1);
});
