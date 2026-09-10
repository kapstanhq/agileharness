// story-7q83gx — A POSTURA DO SEGREDO MCP: opt-in FECHADO, geração EXPLÍCITA do operador.
//
// A assimetria original: o token do OPERADOR (exposto só em loopback) já nascia auto-gerado com 32
// bytes; o token MCP — o MAIS exposto, porque o endpoint fica na internet pública por desenho e as
// tools dele spawnam `claude --dangerously-skip-permissions` — não tinha gerador nenhum nem piso de
// entropia. Era "o que o operador digitou na env". O piso de entropia FICOU (mcp/auth.ts). O que
// mudou de rumo foi o GERADOR: ele saiu do boot.
//
// ── Por que NADA é gerado no boot (correção da onda 2, contra o que a onda 1 fez) ───────────────
//
//   1. ROTAÇÃO SILENCIOSA DA CREDENCIAL DE PRODUÇÃO — o pior desfecho possível, porque REMOVE
//      capacidade do agente. MEDIDO (2026-07-29): no serviço vivo o token primário chega SÓ pelo
//      `packages/storymap-ui/.env.local` (a unit systemd não tem `EnvironmentFile=`; em
//      /proc/<MainPID>/environ existem apenas os tiers `_ORCH` e `_RO`). E o `.env.local` é aplicado
//      pelo @next/env DENTRO de `app.prepare()`. Gerar no boot rodava ANTES disso, com a env vazia:
//      nascia um token novo, era injetado em process.env, e o @next/env — que NÃO sobrescreve o que
//      já está lá — deixava o valor do operador de fora para sempre. A URL do conector do Claude e
//      as 4 rotas /api/runner/* passavam a responder 404 nu, sem log, no primeiro restart. A ORDEM
//      foi consertada (`src/server/main.ts` carrega os .env no topo), mas a geração automática saiu
//      de vez pelo motivo (2).
//
//   2. ENDPOINT SEMPRE-ARMADO. Gerar no boot faz TODA instalação nascer com a superfície MCP
//      EXISTINDO — e torna FALSA a garantia escrita no header de
//      `api/usm/[secret]/[transport]/route.ts`: "Authentication is refused outright unless
//      AGILEHARNESS_MCP_TOKEN is set ... so the endpoint can never be accidentally left open". Numa
//      superfície cujas tools spawnam `claude --dangerously-skip-permissions`, o default tem de ser
//      FECHADO: sem env não há porta (404 nu, `isMcpTokenValid` é fail-closed contra ausente).
//      Quem quer a porta DECLARA a env — e para não ter de inventar um segredo, pede um gerado:
//      `node dist/ah-server.mjs --generate-mcp-token`.
//
// O que este módulo faz, então: NORMALIZA e JULGA o que a env carrega (sem inventar nada), e oferece
// o caminho EXPLÍCITO de geração. Julgar e não matar: quem decide RECUSAR o boot é a auto-checagem
// de perímetro (`src/server/main.ts`), que sabe se o bind está aberto — matar o processo por um token
// MCP fraco em loopback não fecharia porta nenhuma (o request já é recusado) e destruiria TODA a
// capacidade do agente de uma vez.
//
// SEPARAÇÃO DELIBERADA de `mcp/auth.ts`: aquele módulo é puro (só node:crypto) e é o que roda por
// REQUISIÇÃO; este toca disco e roda UMA vez no boot. Misturar os dois tiraria a testabilidade
// isolada que o cabeçalho do auth.ts promete.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { secretWeakness, weaknessAdvice, type SecretWeakness } from "@/lib/storymap/mcp/auth";
import { runnerStateDir } from "@/lib/storymap/paths";

/** A env var que segura o token PRIMÁRIO (nível `full`) — a que a route resolve antes de qualquer outra. */
export const MCP_TOKEN_ENV = "AGILEHARNESS_MCP_TOKEN";

/** Onde o token gerado fica REGISTRADO a 0600 (gitignorado). Não é o que arma a porta — a env é. */
export function mcpTokenFile(): string {
  return path.join(runnerStateDir(), "mcp-token");
}

/** 32 bytes de aleatoriedade criptográfica em base64url (43 chars) — mesmo gerador do token do operador. */
export function generateMcpToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A postura da porta MCP neste boot — LIDA da env, nunca inventada.
 *
 *  - `fechada`  → ninguém declarou o token: a superfície não existe (404 nu). É o DEFAULT, e é uma
 *                 postura válida, não um erro de configuração.
 *  - `armada`   → a env carrega um segredo que passa todos os pisos: a porta existe.
 *  - `recusada` → a env carrega algo que NÃO passa. A porta continua FECHADA (`isMcpTokenValid`
 *                 recusa por requisição) e o operador precisa saber, com o motivo nomeado.
 */
export type McpTokenPosture =
  | { state: "fechada" }
  | { state: "armada"; token: string }
  | { state: "recusada"; weakness: SecretWeakness };

/**
 * Normaliza o token MCP da env e diz o que ele IMPLICA para a superfície. Idempotente e sem disco.
 *
 * Escreve o valor NORMALIZADO (trimado) de volta na env, e isso é correção de bug, não estética: o
 * julgamento aqui usava o valor trimado enquanto `resolveActor` (`api/usm/[secret]/[transport]/
 * route.ts`) compara byte-a-byte contra `process.env`. Um token com espaço/quebra de linha sobrando
 * — o que um `Environment=` de systemd ou um `.env` editado à mão produz — era APROVADO no boot e
 * batia 404 em toda requisição, sem log e sem pista. Uma verdade só: o que a env carrega depois
 * daqui é exatamente o que autentica.
 */
export function normalizeMcpTokenEnv(env: NodeJS.ProcessEnv = process.env): McpTokenPosture {
  const bruto = env[MCP_TOKEN_ENV];
  const valor = (bruto ?? "").trim();
  if (!valor) return { state: "fechada" };
  if (bruto !== valor) env[MCP_TOKEN_ENV] = valor;
  const weak = secretWeakness(valor);
  return weak ? { state: "recusada", weakness: weak } : { state: "armada", token: valor };
}

/**
 * O que dizer ao operador sobre a postura — texto PRESCRITIVO, ou `null` quando não há nada a dizer.
 *
 * NUNCA inclui o valor do segredo (só o motivo). E nomeia o EFEITO em vez do sintoma: a porta está
 * fechada, não "meio aberta" — sem isso o operador acha que configurou e fica caçando 404.
 */
export function mcpPostureAdvice(posture: McpTokenPosture): string | null {
  if (posture.state !== "recusada") return null;
  return (
    `[mcp] ${MCP_TOKEN_ENV} RECUSADO: ${weaknessAdvice(posture.weakness)}\n` +
    `  A superfície MCP fica FECHADA enquanto isso valer: /api/usm/<token>/mcp responde 404 e o conector não conecta.\n` +
    `  Caminho pronto:  node dist/ah-server.mjs --generate-mcp-token  (gera, grava a 0600 e imprime a linha do .env.local)\n` +
    `  Ou remova a variável do ambiente — sem ela a porta simplesmente não existe, que é o default seguro.`
  );
}

export interface GeneratedMcpToken {
  token: string;
  /** onde o valor ficou registrado a 0600, para o operador reler se perder o terminal. */
  file: string;
}

/**
 * GERA um token MCP forte a pedido EXPLÍCITO do operador e o registra a 0600.
 *
 * Só é chamado pelo caminho declarado (`--generate-mcp-token`) — nunca por um boot. Gera SEMPRE um
 * valor novo: quem chama está pedindo um segredo, e reaproveitar um arquivo antigo faria este
 * comando devolver silenciosamente uma credencial que talvez já tenha vazado.
 *
 * O arquivo é REGISTRO, não interruptor: nada no boot o lê. Se ele armasse a porta, a superfície
 * voltaria a existir sem ninguém declarar nada — exatamente o default sempre-armado que esta story
 * desfez.
 */
export function generateAndPersistMcpToken(): GeneratedMcpToken {
  const token = generateMcpToken();
  const file = mcpTokenFile();
  mkdirSync(path.dirname(file), { recursive: true });
  // 0600 na criação E logo depois: `writeFileSync` com `mode` só aplica quando o arquivo NASCE, e um
  // arquivo pré-existente com modo folgado (0644) continuaria legível por qualquer usuário da máquina
  // — que é o cenário de rodar este comando uma segunda vez.
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { token, file };
}
