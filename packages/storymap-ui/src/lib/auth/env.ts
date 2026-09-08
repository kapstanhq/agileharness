// AS ENVS DA AUTENTICAÇÃO — o nome delas e a leitura, em UM lugar.
//
// Este módulo existe porque os segredos são lidos de `process.env` por consumidores em runtimes
// DIFERENTES, e cada um deles tinha a sua cópia da string:
//   • o middleware (Edge) — não pode importar `lib/auth/token` (usa `node:fs`/`node:crypto`);
//   • as rotas e a página de login (Node, dentro do Next);
//   • o servidor HTTP próprio (`src/server/main.ts`, fora do bundle do Next), que autentica o
//     upgrade de WebSocket do terminal.
// Três runtimes, um contrato. Enquanto o nome da env vivia dentro de `token.ts`, o middleware o
// repetia como literal (`process.env.AGILEHARNESS_SESSION_SECRET`) — uma segunda verdade que só
// falharia em produção, e em silêncio: um rename derruba o portão em vez de quebrar o build.
//
// ⚠️ Mantenha este módulo SEM imports. Ele é carregado no Edge (middleware) e num entrypoint Node
// puro (o servidor) — qualquer dependência transitiva de `node:*` quebraria o primeiro.

/** Env que sobrepõe o arquivo `storymap/.runner/auth-token` — o caminho 12-factor. */
export const TOKEN_ENV = "AGILEHARNESS_AUTH_TOKEN";

/** Env que sobrepõe o arquivo `storymap/.runner/session-secret`. */
export const SESSION_SECRET_ENV = "AGILEHARNESS_SESSION_SECRET";

/**
 * O mínimo que estas funções precisam de um ambiente. Deliberadamente NÃO `NodeJS.ProcessEnv`:
 * aquele tipo exige `NODE_ENV`, o que obrigaria todo teste a montar um ambiente falso inteiro só
 * para ler duas chaves.
 */
export type EnvLike = Record<string, string | undefined>;

export interface AuthSecretsFromEnv {
  sessionSecret: string;
  operatorToken: string;
}

/**
 * Os dois segredos como `verifySession`/`signSession` os querem.
 *
 * Ausência vira `""` de propósito: `session.ts` recusa qualquer segredo abaixo de
 * {@link MIN_SESSION_SECRET_LEN}, então "env não populada" cai no MESMO caminho fail-closed de
 * "segredo truncado" — sem `undefined` circulando e sem nenhum chamador precisando lembrar do
 * `?? ""`. Quem popula a env é `instrumentation.ts` (ensureAuthSecrets) no boot.
 */
export function authSecretsFromEnv(env: EnvLike = process.env): AuthSecretsFromEnv {
  return {
    sessionSecret: env[SESSION_SECRET_ENV] ?? "",
    operatorToken: env[TOKEN_ENV] ?? "",
  };
}
