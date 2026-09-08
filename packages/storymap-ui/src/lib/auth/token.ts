// O TOKEN DO OPERADOR e o segredo de sessão — o lado Node (fs + node:crypto).
//
// ⚠️ NÃO importe este módulo do middleware: ele usa `node:fs`/`node:crypto`, que não existem no
// runtime Edge onde o Next 14 roda middleware. O middleware lê só `process.env`; quem popula a
// env no boot é `instrumentation.ts` chamando `ensureAuthSecrets()`.
//
// POR QUE TOKEN E NÃO SENHA (decisão do plano OSS, D-2 + anexo 07):
// o AgileHarness é instalado na VPS de quem baixou o open-source. Senha escolhida por humano num
// serviço que spawna `claude` com poderes de execução é o elo fraco do espectro — é a classe de
// footgun pré-ClawJacked. Um segredo ALEATÓRIO de 32 bytes gerado no primeiro boot não tem
// default de fábrica para vazar, não tem dicionário para adivinhar, e a UX de digitá-lo uma vez
// só é resolvida pelo cookie de sessão (lib/auth/session.ts).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SESSION_SECRET_ENV, TOKEN_ENV } from "@/lib/auth/env";
import {
  mcpPostureAdvice,
  normalizeMcpTokenEnv,
  type McpTokenPosture,
} from "@/lib/storymap/mcp/token-bootstrap";
import { runnerStateDir } from "@/lib/storymap/paths";

/**
 * Piso do token do operador. Abaixo disto NADA autentica — mesma postura de
 * `lib/storymap/mcp/auth.ts`, que desde story-7q83gx usa o MESMO 32 (antes 24: o segredo mais
 * exposto tinha o piso mais baixo) e ainda exige entropia; aqui o piso é o 32 do plano.
 */
export const MIN_OPERATOR_TOKEN_LEN = 32;

/** Onde o segredo mora quando não veio por env. Ao lado do resto do estado do runner. */
export function authTokenFile(): string {
  return path.join(runnerStateDir(), "auth-token");
}
export function sessionSecretFile(): string {
  return path.join(runnerStateDir(), "session-secret");
}

/**
 * Compara o token apresentado com o esperado, em tempo constante.
 *
 * Fail-closed abaixo do piso: um `expected` ausente, vazio ou fraco (env não setada, arquivo
 * truncado) NUNCA autentica — sem isso, o serviço mal-configurado autenticaria contra `""` e
 * qualquer request entraria. A checagem de comprimento vem antes porque `timingSafeEqual` lança
 * com buffers de tamanhos diferentes; comparar comprimento primeiro vaza só o comprimento, que
 * é o mesmo que o formato do token já entrega.
 */
export function isOperatorTokenValid(provided: string, expected: string | undefined): boolean {
  const exp = expected ?? "";
  if (exp.length < MIN_OPERATOR_TOKEN_LEN) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(exp, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 32 bytes de aleatoriedade criptográfica em base64url (43 chars, sem padding). */
export function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

function readOrCreate(file: string, label: string): { value: string; created: boolean } {
  if (existsSync(file)) {
    const value = readFileSync(file, "utf8").trim();
    if (value.length >= MIN_OPERATOR_TOKEN_LEN) return { value, created: false };
    // Arquivo existe mas está fraco/truncado: NÃO o reaproveitamos silenciosamente — seria
    // autenticar contra lixo. Regenera e avisa.
    console.warn(`[auth] ${label} em ${file} estava fraco/truncado — regenerando`);
  }
  const value = generateSecret();
  mkdirSync(path.dirname(file), { recursive: true });
  // 0600 ANTES de escrever o conteúdo seria o ideal; como `writeFileSync` com `mode` só aplica na
  // CRIAÇÃO, fixamos o modo logo em seguida para cobrir também o caso de arquivo pré-existente.
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { value, created: true };
}

export interface AuthSecrets {
  token: string;
  sessionSecret: string;
  /** true quando o token acabou de nascer — o boot imprime o banner de primeiro uso. */
  tokenCreated: boolean;
  /** de onde veio o token: env (12-factor) ou arquivo no estado do runner. */
  tokenSource: "env" | "file";
  /**
   * A postura da porta MCP depois de normalizar a env — `fechada` quando NINGUÉM declarou o token.
   * Ela não interfere no portão do board: é informação para quem sobe o serviço decidir o que fazer
   * (a auto-checagem de perímetro em `src/server/main.ts` é quem tem contexto de bind para recusar).
   */
  mcpPosture: McpTokenPosture;
}

/**
 * Garante que token e segredo de sessão existem, e os expõe em `process.env` para o middleware
 * (Edge) enxergá-los. Idempotente — chamar de novo relê os mesmos arquivos.
 *
 * Chamado UMA vez no boot pelos DOIS entrypoints — `src/server/main.ts` (produção) e
 * `instrumentation.ts` (o caminho do `next dev`) —, antes de qualquer request ser servido.
 */
export function ensureAuthSecrets(): AuthSecrets {
  const envToken = process.env[TOKEN_ENV]?.trim();
  const tokenFromEnv = !!envToken && envToken.length >= MIN_OPERATOR_TOKEN_LEN;
  // `created` tem de vir do MESMO chamado que cria o arquivo — consultar `existsSync` depois
  // devolveria sempre `false` (o arquivo acabou de ser escrito) e o banner de primeiro uso nunca
  // apareceria, que é justamente quando o operador precisa dele.
  const fromFile = tokenFromEnv ? null : readOrCreate(authTokenFile(), "token do operador");
  const token = tokenFromEnv ? envToken! : fromFile!.value;
  const tokenCreated = fromFile?.created ?? false;

  const envSecret = process.env[SESSION_SECRET_ENV]?.trim();
  const sessionSecret =
    envSecret && envSecret.length >= MIN_OPERATOR_TOKEN_LEN
      ? envSecret
      : readOrCreate(sessionSecretFile(), "segredo de sessão").value;

  // O middleware roda no Edge e não lê arquivo — a env é a ÚNICA ponte até ele.
  process.env[TOKEN_ENV] = token;
  process.env[SESSION_SECRET_ENV] = sessionSecret;

  // O SEGREDO MCP **NÃO NASCE AQUI** — e isso é deliberado (ver o cabeçalho de mcp/token-bootstrap.ts).
  //
  // O que esta linha IMPEDE, sendo só normalização: (a) que o boot ROTACIONE em silêncio o token que
  // o operador declarou no `.env.local` — o serviço vivo recebe o primário SÓ por lá, e a env dele
  // ainda não está aplicada quando este módulo roda pelo caminho do `instrumentation.ts`; e (b) que
  // toda instalação nasça com a superfície MCP ARMADA (`claude --dangerously-skip-permissions` numa
  // URL pública), quando o contrato da route é que sem token declarado a porta não existe.
  //
  // E NÃO LANÇA, de propósito: um token MCP fraco não pode derrubar o serviço. `isMcpTokenValid`
  // recusa segredo fraco por REQUISIÇÃO, então a porta já está fechada com ou sem morte de processo —
  // matar o boot só destruiria a capacidade inteira do agente (board, autorun, terminal) por causa de
  // uma porta que continua fechada de qualquer jeito. Quem RECUSA subir é a auto-checagem de
  // perímetro (`src/server/main.ts`), que é a única com contexto de bind para julgar isso.
  const mcpPosture = normalizeMcpTokenEnv();
  const aviso = mcpPostureAdvice(mcpPosture);
  // Avisado AQUI e não no entrypoint: os dois caminhos de boot (`main.ts` e `instrumentation.ts`)
  // passam por esta função, e um aviso que só sai num deles é o aviso que falta no ambiente errado.
  if (aviso) console.warn(aviso);

  return { token, sessionSecret, tokenCreated, tokenSource: tokenFromEnv ? "env" : "file", mcpPosture };
}
