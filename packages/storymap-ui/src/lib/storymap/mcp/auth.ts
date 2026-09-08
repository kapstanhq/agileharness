// Capability-token check for the AgileHarness MCP endpoint. Pure + constant-time so it is
// unit-testable in isolation and free of a length/timing oracle. Used by the route
// handler (app/api/usm/[secret]/[transport]/route.ts).
//
// story-7q83gx — POR QUE O PISO DAQUI É O MAIS ALTO DO SISTEMA (e não o mais baixo, como era).
// Este é o segredo MAIS exposto do AgileHarness: o endpoint MCP está na internet pública POR
// DESENHO (o conector do Claude conecta da nuvem da Anthropic, não do telefone — ver o cabeçalho
// da route) e as tools que ele monta spawnam `claude --dangerously-skip-permissions` na máquina.
// Mesmo assim era o ÚNICO segredo sem gerador e com piso de 24: o token do operador (loopback,
// lib/auth/token.ts) já nascia auto-gerado com 32 bytes, enquanto aqui qualquer string de 24
// caracteres digitada pelo operador publicava um RCE adivinhável na internet.
//
// O que os pisos abaixo IMPEDEM: que um segredo adivinhável — curto, de um caractere repetido, ou
// um motivo curto repetido — autentique, MESMO configurado. É defesa em profundidade: o boot já
// recusa um token fraco (mcp/token-bootstrap.ts), mas quem faz a verificação por requisição é
// isMcpTokenValid, e um processo subido por outro entrypoint (que nunca chamou o bootstrap) não
// pode virar uma porta aberta.
//
// Quem GERA um token forte é `generateAndPersistMcpToken` (token-bootstrap.ts), chamado SÓ pelo
// comando explícito `node dist/ah-server.mjs --generate-mcp-token`. Nada gera no boot, de
// propósito: geração automática faria toda instalação nascer com a superfície MCP EXISTINDO, e é
// o que tornaria falsa a garantia "o endpoint nunca fica acidentalmente aberto" do header da route.
// (Este comentário apontava para um gerador de BOOT que a onda 2 removeu junto com a geração
// automática. Ponteiro para símbolo morto é como alguém conclui que uma camada é redundante — o nome
// antigo não é repetido aqui porque `security-claims.test.ts` varre `src/` proibindo-o.)

import { timingSafeEqual } from "node:crypto";

/**
 * Minimum secret length we will EVER authenticate against (fail-closed below this).
 *
 * 32 é o MESMO piso do token do operador (`MIN_OPERATOR_TOKEN_LEN`): o segredo mais exposto não
 * pode ter a garantia mais fraca. Era 24 — o valor que deixava um segredo memorizável passar.
 */
export const MIN_TOKEN_LEN = 32;

/**
 * Caracteres DISTINTOS mínimos. Calibrado contra os geradores REAIS, não contra um ideal: um token
 * hex de 32 chars (`openssl rand -hex 16`) tem ~14 distintos, e um base64url de 43 (o que este
 * pacote gera) tem ~31 — 10 deixa margem folgada para os dois e ainda assim mata o degenerado
 * (`"x"*40` = 1 distinto, `"abc"` repetido = 3). É a checagem que pega o caso do card: 32+
 * caracteres de comprimento com quase nenhuma variedade.
 */
export const MIN_DISTINCT_CHARS = 10;

/**
 * Piso de entropia de Shannon (bits TOTAIS, sobre a frequência observada dos caracteres).
 *
 * LIMITE HONESTO: Shannon sobre frequência não vê estrutura de linguagem — uma frase memorizável
 * de 32 caracteres passa. Ela existe para pegar DEGENERAÇÃO (repetição, alfabeto minúsculo), não
 * para julgar senha humana. A defesa contra "humano digitou algo memorizável" é OUTRA: o harness
 * GERA o token (token-bootstrap.ts), então ninguém precisa inventar um.
 */
export const MIN_ENTROPY_BITS = 64;

/** Por que um segredo foi recusado — nomeado, para a recusa dizer o MOTIVO em vez de só falhar. */
export type SecretWeakness = "ausente" | "curto" | "repetido" | "pouca-variedade" | "baixa-entropia";

/** Bits totais de entropia de Shannon sobre a frequência observada dos caracteres de `value`. */
function shannonBits(value: string): number {
  const freq = new Map<string, number>();
  for (const ch of value) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let perChar = 0;
  for (const n of freq.values()) {
    const p = n / value.length;
    perChar -= p * Math.log2(p);
  }
  return perChar * value.length;
}

/** True quando `value` é a repetição exata de um motivo mais curto (`"abcd".repeat(8)`). */
function isRepeatedMotif(value: string): boolean {
  const n = value.length;
  for (let d = 1; d <= n / 2; d++) {
    if (n % d !== 0) continue;
    if (value.slice(0, d).repeat(n / d) === value) return true;
  }
  return false;
}

/**
 * A fraqueza de um segredo, ou `null` quando ele é forte. Ordem das checagens = da mais concreta
 * para a mais estatística, para a mensagem ao operador nomear a causa óbvia primeiro.
 *
 * Isto NÃO julga o token apresentado pelo cliente (isso seria um oráculo): julga o segredo
 * CONFIGURADO, que é o que decide se a porta pode existir.
 */
export function secretWeakness(value: string | undefined | null): SecretWeakness | null {
  const v = (value ?? "").trim();
  if (!v) return "ausente";
  if (v.length < MIN_TOKEN_LEN) return "curto";
  if (isRepeatedMotif(v)) return "repetido";
  if (new Set(v).size < MIN_DISTINCT_CHARS) return "pouca-variedade";
  if (shannonBits(v) < MIN_ENTROPY_BITS) return "baixa-entropia";
  return null;
}

/** Atalho legível: o segredo alcança TODOS os pisos (comprimento + variedade + entropia). */
export function isStrongSecret(value: string | undefined | null): boolean {
  return secretWeakness(value) == null;
}

/** O comando que gera um token aceitável — toda recusa carrega isto, senão ela só bloqueia. */
export const GENERATE_TOKEN_HINT =
  `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`;

/** Frase pronta para log/erro: o motivo + como sair dele. NUNCA inclui o valor do segredo. */
export function weaknessAdvice(w: SecretWeakness): string {
  const motivo: Record<SecretWeakness, string> = {
    ausente: "não está definido",
    curto: `tem menos de ${MIN_TOKEN_LEN} caracteres`,
    repetido: "é a repetição de um motivo curto (adivinhável)",
    "pouca-variedade": `usa menos de ${MIN_DISTINCT_CHARS} caracteres distintos`,
    "baixa-entropia": `tem menos de ${MIN_ENTROPY_BITS} bits de entropia`,
  };
  return `${motivo[w]}. Gere um forte com:  ${GENERATE_TOKEN_HINT}`;
}

/**
 * Descreve um segredo para log SEM revelar nada dele — nem prefixo, nem sufixo.
 *
 * Um "mascarado" que mostra as 4 primeiras e 4 últimas letras entrega 8 caracteres de um segredo de
 * 32 a quem lê o log (e log vai para journald, para o board, e para o próximo relatório de bug).
 * Aqui só sai o COMPRIMENTO, que é o que o formato do token já anuncia.
 */
export function maskSecret(value: string | undefined | null): string {
  const v = (value ?? "").trim();
  return v ? `<oculto: ${v.length} chars>` : "<ausente>";
}

/**
 * Validate a path-carried MCP token against the configured secret.
 *
 * Fails closed: um segredo esperado ausente, vazio ou FRACO (curto/degenerado — ver
 * `secretWeakness`) NUNCA autentica, então o endpoint público não pode ficar aberto por env var
 * faltando nem por token adivinhável configurado à mão. Constant-time compare, guarded by a length
 * check (timingSafeEqual throws on unequal lengths and a raw length compare would itself leak
 * length via timing).
 *
 * A checagem de força roda só sobre `expected` — medir `provided` seria um oráculo sobre o que o
 * atacante mandou, e ele já sabe o que mandou.
 */
export function isMcpTokenValid(provided: string, expected: string | undefined): boolean {
  const exp = expected ?? "";
  if (!isStrongSecret(exp)) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(exp, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
