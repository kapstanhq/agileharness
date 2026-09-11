#!/usr/bin/env node
// scan-secrets.mjs — pre-commit secret scanner (enforce > instruct).
//
// "NEVER commit secrets" used to be instruction-only (CLAUDE.md). This makes it
// evidence-enforced: scans STAGED added lines for high-confidence secret material
// and blocks the commit (exit 2) before it can reach history.
//
// Usage:
//   node scan-secrets.mjs --staged             # scan staged diff (pre-commit default)
//   node scan-secrets.mjs --range HEAD~1..HEAD # scan a COMMITTED range (merge train, SM-08)
//
// Exit codes: 0 = clean, 2 = secret found, 1 = INTERNAL error (fail-CLOSED, SM-08). The merge
// train (worktree.ts / merge-queue.ts) treats ANY non-zero exit as a block — so a scan that
// cannot run (e.g. a diff past git's maxBuffer) blocks rather than silently passing.
//
// Bypass (genuine false positive): add `pragma: allowlist secret` on the line,
// or set SKIP_SECRET_SCAN=1 / SKIP_PRECOMMIT=1 for the whole commit.
//
// Precision-first by design. QUATRO camadas independentes, porque nenhuma sozinha cobre as formas
// reais (story-denyvc mediu: das 12 credenciais de produção de um app real, 10 passavam batido):
//   1. PREFIX_PATTERNS — prefixo conhecido (`AKIA…`, `AIza…`, `sk-proj-…`), independe de rótulo;
//   2. KEYWORD_ASSIGN  — palavra-chave em código (`apiKey = …`), valor com ou SEM aspas;
//   3. ENV_ASSIGN      — nome de env que DECLARA credencial (`PREFIXO_API_KEY`, `*_TOKEN`);
//   4. self-secret + token NU — o segredo do PRÓPRIO produto: por ocorrência literal do valor que
//      está no ambiente, e por FORMA/entropia quando ele aparece sem rótulo nenhum (crase, URL, bloco).
// ...e uma QUINTA que não é regra de conteúdo, e sim de COBERTURA: um arquivo de texto que o git
// recusa apresentar como texto (byte NUL) é reportado como NÃO VARRIDO e BLOQUEIA — ver
// `BINARIO_POR_CONSTRUCAO` e o resgate `--text`. Sem ela, as quatro camadas acima têm um interruptor
// geral de um byte.
// Skips its own directory so the pattern definitions below never self-match.
//
// ESCOPO (limite conhecido, deliberado): o hook só vê o ÍNDICE (`--staged`) e o train só vê o RANGE
// que está integrando. Segredo que já está commitado, ou que está na árvore sem nunca ter sido
// staged, é INVISÍVEL para este script — varrer a árvore/histórico inteiro é outro trabalho.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SELF_DIR = 'scripts/git-hooks/';
const ALLOW_PRAGMA = /(pragma:\s*allowlist\s*secret|gitleaks:\s*allow|allowlist[- ]secret)/i;

// --- Known high-confidence token prefixes (flag regardless of keyword) -------
// Built so the literal source here does NOT match the compiled pattern.
const PREFIX_PATTERNS = [
  { name: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  // O `[A-Za-z0-9]{20,}` original MORRIA no primeiro hífen — ou seja, `sk-proj-…` (a forma que a
  // OpenAI emite hoje, e a que está no env de produção de um app real) passava INTEIRA pelo gate: a regra
  // só via as chaves legadas `sk-<48 alfanuméricos>`. Aceitar `-`/`_` no corpo, por si só, faria
  // qualquer classe CSS longa `sk-…` (skeleton) virar achado, então o `guard` exige a assinatura de
  // alfabeto aleatório que um identificador kebab-case não tem: maiúscula E dígito no mesmo token.
  {
    name: 'openai-key',
    re: /\bsk-(?!or-)[A-Za-z0-9][A-Za-z0-9_-]{18,}[A-Za-z0-9]/,
    guard: (m) => /[A-Z]/.test(m) && /[0-9]/.test(m),
  },
  { name: 'openrouter-key', re: /\bsk-or-v1-[A-Za-z0-9]{20,}\b/ },
  { name: 'asaas-key', re: /\$aact_(prod|hmlg)_[A-Za-z0-9:=+/-]{20,}/ },
  { name: 'github-pat', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'stripe-secret', re: /\b[rs]k_(live|test)_[A-Za-z0-9]{20,}\b/ },
  { name: 'private-key-block', re: new RegExp('-----BEGIN [A-Z ]*PRIVATE KEY-----') },
  { name: 'json-private-key-field', re: /"private_key"\s*:\s*"-----BEGIN/ },
  // ── A CREDENCIAL DO PRÓPRIO PRODUTO ───────────────────────────────────────────────────────────
  //
  // O handle MCP nasceu COM prefixo justamente para ser julgável por forma, e o comentário que o
  // define (`lib/auth/mcp-handle.ts`) afirma que ele segue "a mesma régua que scan-secrets.mjs já
  // aplica nesta onda". A afirmação era falsa: o prefixo foi desenhado para ser varrido e a regra
  // nunca foi escrita. Um comentário que descreve uma proteção inexistente é pior que nenhum — ele
  // encerra a pergunta.
  //
  // MEDIDO com um canário em caminho que a régua de extração PERMITE, contra o gate de publicação:
  // das cinco formas em que esta credencial realmente aparece, ele liberava QUATRO. Só passava a que
  // usa um nome de env terminando em TOKEN/KEY/SECRET. Ficavam de fora: o mesmo valor sob um nome
  // que o produto de fato usa (…_HANDLE), o valor nu entre aspas sem palavra-chave, e as duas
  // formas de URL — que são as que importam.
  //
  // Forma exata, lida de `mcp-handle.ts` e não inventada: prefixo + 12 hex + "." + 43 base64url
  // (HANDLE_ID_RE e HANDLE_SECRET_RE). Uma regra de PREFIXO, e não de valor, porque só ela enxerga
  // o segredo em qualquer contexto — comentário, crase, JSON, meio de URL.
  { name: 'agileharness-mcp-handle', re: /\bahk_[0-9a-f]{12}\.[A-Za-z0-9_-]{43}\b/ },
  // A FORMA COMO ESTA CREDENCIAL DE FATO CIRCULA: dentro da URL do endpoint MCP. É assim que ela vai
  // para o `.mcp.json` de um cliente, para um README de onboarding, para um exemplo em comentário —
  // e foi assim que ela já vazou de verdade, para um log persistente do proxy.
  //
  // Nenhuma camada de VALOR podia pegá-la, e não por acaso: `looksLikeSecretValue` recusa, por
  // desenho, todo valor que começa com http(s):// (senão qualquer URL longa viraria achado). O preço
  // desse desenho é que uma credencial que VIVE dentro do caminho da URL fica num ponto cego
  // estrutural. Uma regra de prefixo é a única camada que olha o texto e não o "valor".
  //
  // O piso de 32 chars é o que separa credencial de PLACEHOLDER: `<credencial>`, `SEU_TOKEN` e o
  // `REDIGIDO` que o filtro de log escreve têm todos menos que isso, então documentação honesta não
  // vira achado — e um valor real (43 chars de token cru, 60 de handle) não escapa.
  { name: 'agileharness-mcp-url-credential', re: /\/api\/usm\/[A-Za-z0-9_.-]{32,}\// },
];

// --- Keyword-assignment of a literal value -----------------------------------
// O valor pode vir ENTRE ASPAS (código) ou NU (YAML/dotenv/`export` de shell). O gate original só
// aceitava valor entre aspas — e o arquivo que carrega 12 credenciais de produção
// (um `deployment/cloud-run/config/environment.production.env.yaml`) é YAML de env.
// `\x60` = crase, escrita assim para não fechar o template literal.
// A aspa que FECHA tem de ser a MESMA que abriu (`\k<q>`), e não "qualquer aspa".
//
// PORQUÊ, medido: a versão com duas classes independentes (`['"\x60] … ['"\x60]`) casava ABRINDO numa
// crase e FECHANDO numa aspa dupla — o que uma string literal real nunca faz, mas PROSA faz o tempo
// todo, porque a crase em comentário é markdown de trecho de código:
//
//   it("COMPATIBILIDADE: `?secret=` continua funcionando e ANUNCIA a depreciação…", …)
//                               └ vira "abre aspas"                              └ vira "fecha"
//
// O "valor" capturado era a frase inteira (66 chars com espaços e acentos).
//
// HONESTIDADE SOBRE O CRÉDITO: 26 releases seguidos foram reprovados por esse falso positivo, mas a
// simetria NÃO é o que os desbloqueia — medido, a régua de FORMA do `looksLikeSecretValue` já rejeita
// prosa nesta versão do arquivo, e o que reprovava era `main` rodar uma versão DEFASADA do scanner
// (sem `ENV_ASSIGN` nem `BARE_VALUE_SHAPE`). A simetria entra como correção de PRECISÃO da regra em
// si: delimitador assimétrico é um defeito de expressão regular independentemente de quem filtra
// depois, e depender só do filtro a jusante é deixar a primeira camada mentir sobre o que ela casa.
//
// Named groups (não índices) porque estes fragmentos entram em DUAS regexes com quantidades
// diferentes de grupos antes deles — um `\1` apontaria para alvos diferentes em cada uma.
const VALUE_QUOTED = String.raw`(?<q>['"\x60])(?<qv>[^'"\x60]{12,})\k<q>`;
const VALUE_BARE = String.raw`(?<bv>[^\s'"\x60,;]{12,})`;

// A aspa de FECHAMENTO da CHAVE, em JSON/JS-object. `"apiKey": "<valor>"` não casava em NENHUMA das
// duas regras porque entre a palavra-chave e o `:` existe um `"` — e o gate exigia `\s*[:=]` colado.
// Medido: config JSON com a chave entre aspas (o formato de package.json, appsettings, firebase config)
// atravessava inteira, tanto antes quanto depois de corrigir o `\b`.
const KEY_CLOSE_QUOTE = String.raw`['"\x60]?`;

const CRED_WORD = String.raw`(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|passwd|password|credential)`;

// PORQUÊ lookaround em vez de `\b`: não existe `\b` entre `_` e uma letra (o `_` É word char), então
// `OPENAI_API_KEY=…` era INVISÍVEL para esta regra — e esse é o formato dominante de credencial em
// env/YAML/dotenv. Medido no card story-denyvc: 10 das 12 credenciais reais de produção passavam.
// `(?<![A-Za-z0-9])` aceita `_`, `-`, início de linha, aspa e espaço como separador, e continua
// recusando o MEIO de palavra (`capikey`, `mysecretariat`). O `(?![A-Za-z0-9])` à direita absorve o
// antigo `(?!s\b)`: `secrets:` já não casa, porque depois de `secret` vem um alfanumérico.
const KEYWORD_ASSIGN = new RegExp(
  `(?<![A-Za-z0-9])${CRED_WORD}(?![A-Za-z0-9])${KEY_CLOSE_QUOTE}\\s*[:=]\\s*(?:${VALUE_QUOTED}|${VALUE_BARE})`,
  'i',
);

// --- Nome de env que DECLARA credencial (SCREAMING_SNAKE terminando em KEY/TOKEN/SECRET/…) -----
// Existe porque metade das credenciais reais não usa NENHUMA palavra da lista acima:
// `WHATSAPP_VERIFY_TOKEN`, `PINECONE_API_KEY` sem prefixo reconhecível, e — o mais grave — o
// `AGILEHARNESS_MCP_TOKEN` do próprio produto. Aqui o NOME é o contexto, e é ele que autoriza afrouxar
// a exigência de classes de caractere no valor (ver `looksLikeSecretValue({ declared: true })`).
const ENV_CRED_NAME = String.raw`[A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PWD)`;
const ENV_ASSIGN = new RegExp(
  `(?<![A-Za-z0-9_-])(${ENV_CRED_NAME})(?![A-Z0-9_])${KEY_CLOSE_QUOTE}\\s*[:=]\\s*(?:${VALUE_QUOTED}|${VALUE_BARE})`,
);

// Um valor NU (sem aspas) só conta como credencial se for um "run" opaco de env/YAML — sem espaço,
// parêntese ou chamada de função. Impede que `apiKey: buildFrom(cfg.provider)` (código legítimo)
// vire achado agora que a regra aceita valor sem aspas.
const BARE_VALUE_SHAPE = /^[A-Za-z0-9._~+/=:@-]+$/;

const PLACEHOLDER =
  /^(x{3,}|0{3,}|\.{3,}|\*{3,}|<.*>|\$\{.*\}|process\.env|import\.meta|your[-_ ]|my[-_]|example|sample|placeholder|changeme|change-me|dummy|fake|redacted|todo|null|none|undefined|test[-_]?(key|secret|token)?|abc123|secret|password)/i;

// --- Fixture markers (reduce fixture false positives WITHOUT relaxing the gate) -----------------
// A test fixture that embeds a realistic-but-FAKE credential (e.g. the canonical `AKIA…EXAMPLE`, or
// `AIzaSy…FAKE…`) is a false positive that only the pragma could bypass. This skips a match — for BOTH
// the prefix rule AND the keyword rule — ONLY when the matched VALUE ITSELF carries an EXPLICIT non-secret
// marker ANYWHERE in it (unanchored, unlike PLACEHOLDER's `^`). A real random credential never contains
// `example`/`fake`/`dummy`/… (coincidental substrings are astronomically unlikely and would also require a
// real key to be committed), so the gate stays strong; a marker-less fixture still needs `pragma: allowlist
// secret`. The check is on the VALUE, not the whole line, so an unrelated comment can never excuse a real key.
const FIXTURE_MARKER =
  /(example|placeholder|redacted|change[-_]?me|fixture|dummy|sample|not[-_]?real|your[-_]|fake|mock|x{4,}|0{4,}|<[a-z0-9._-]+>|test[-_]?(key|token|secret|value|api))/i;

/** Does the matched credential VALUE carry an explicit fixture/placeholder marker? (skip → not a real secret) */
function looksLikeFixture(value) {
  return FIXTURE_MARKER.test(String(value));
}

function shannonEntropy(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let e = 0;
  for (const c of freq.values()) {
    const p = c / s.length;
    e -= p * Math.log2(p);
  }
  return e;
}

/** Maior corrida de caracteres NÃO-vogais. Texto humano distribui vogais; um sorteio aleatório
 *  empilha consoantes e dígitos (num valor de 20+ chars sorteado, uma corrida ≥6 é quase certa). */
function maxNonVowelRun(val) {
  let run = 0;
  let max = 0;
  for (const ch of val) {
    if (/[aeiouAEIOU]/.test(ch)) run = 0;
    else if (++run > max) max = run;
  }
  return max;
}

/** Um segmento com forma de PALAVRA: `cinemaSessionsView`, `ASAAS`, `0001`. Curto por definição. */
function isWordShapedSegment(p) {
  return p.length <= 24 && (/^[a-z][A-Za-z0-9]*$/.test(p) || /^[A-Z][A-Z0-9]*$/.test(p) || /^[0-9]+$/.test(p));
}

/**
 * O valor é NOME/REFERÊNCIA escrito por gente, não credencial? Duas formas, ambas calibradas contra o
 * repositório REAL — varrendo a árvore rastreada inteira, as regras novas saíram de 203 achados para 73
 * ao aplicar esta régua e as vizinhas, e o que ela derrubou era 100% desta natureza:
 *
 *  1. decompõe INTEIRO em segmentos de palavra separados por `-_.:/` — `app.cinemaSessionsView`
 *     (chave de localStorage), `path/to/serviceAccountKey.json` (caminho), `ASAAS_API_KEY:latest`
 *     (referência do Secret Manager), `minimum_32_characters_random_token_here` (placeholder de
 *     `.env.example`), `token-de-repasse-do-app-0001` (fixture de teste);
 *  2. é um camelCase inteiro SEM dígito com vogais distribuídas como texto humano —
 *     `whatsappConfig.accessToken`, `__playpackEcosystemBarLease__`.
 *
 * Uma credencial real não se parte assim: ou é um run opaco sem separador (hex/base64url), ou o
 * segmento aleatório começa com maiúscula/dígito, ou passa de 24 chars. RISCO RESIDUAL assumido: uma
 * chave hipotética toda minúscula e segmentada em pedaços curtos seria dispensada aqui — o token do
 * próprio produto não depende desta régua (tem a checagem por literal e a por forma nua, independentes).
 */
function looksLikeHumanIdentifier(val) {
  const parts = val.split(/[-_.:/]/).filter(Boolean);
  if (parts.length >= 2 && parts.every(isWordShapedSegment)) return true;
  // Um único segmento: julga o SEGMENTO, não o valor cru — senão o sentinela `__nomeAssim__` (com
  // separador nas pontas) escapa da régua e volta a ser achado.
  return parts.length === 1 && /^[a-z][A-Za-z]*$/.test(parts[0]) && maxNonVowelRun(parts[0]) < 6;
}

/**
 * O VALOR casado parece credencial?
 *
 * `declared` = o NOME da variável já declarou que aquilo é credencial (env `*_KEY`/`*_TOKEN`/…). Nesse
 * caso a exigência de 3 classes de caractere cai para 2, porque uma fatia grande das chaves reais é
 * hex puro (32 chars minúsculo+dígito, ex.: OpenWeather) — e era exatamente essa forma que atravessava
 * o gate. O contexto perdido (classe de caractere) é reposto pelo nome, e o desconto é pago com a
 * dispensa explícita de nomes/referências escritos por gente (`looksLikeHumanIdentifier`).
 *
 * @param {string} v @param {{ declared?: boolean }} [opts]
 */
function looksLikeSecretValue(v, { declared = false } = {}) {
  const val = v.trim();
  if (val.length < 16) return false;
  if (PLACEHOLDER.test(val)) return false;
  if (looksLikeFixture(val)) return false; // fixture com marcador explícito (mock/example/…) → não é segredo real
  if (val.includes('${') || val.startsWith('process.env') || val.startsWith('import.meta')) return false;
  if (/^https?:\/\//.test(val)) return false;
  // Credencial não tem ESPAÇO. Aceitar valor com espaço fazia a regra casar prosa e código de dentro
  // de aspas na mesma linha (`console.log('OPENAI_API_KEY:', …)`, `INVALID_TOKEN = "Token inválido"`).
  // Chave privada multi-linha é pega pela regra de prefixo `private-key-block`, não por esta.
  if (/\s/.test(val)) return false;
  if (/^(\.{0,2}\/|~\/|\$)/.test(val)) return false; // caminho de arquivo ou `$VAR`/`$env:` — não é o valor
  if (looksLikeHumanIdentifier(val)) return false;
  const classes =
    (/[a-z]/.test(val) ? 1 : 0) +
    (/[A-Z]/.test(val) ? 1 : 0) +
    (/[0-9]/.test(val) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(val) ? 1 : 0);
  return val.length >= 20 && classes >= (declared ? 2 : 3) && shannonEntropy(val) >= 3.2;
}

/** Escolhe o valor casado por uma regra `quoted|bare`, recusando valor nu que não seja run opaco. */
function matchedValue(quoted, bare) {
  if (typeof quoted === 'string') return quoted;
  if (typeof bare === 'string' && BARE_VALUE_SHAPE.test(bare)) return bare;
  return null;
}

// --- Segredos do PRÓPRIO produto: ocorrência LITERAL (determinística, zero falso-positivo) ------
// O token do MCP do AgileHarness é o segredo mais perigoso deste repositório — quem o tem fala com o
// board como Operador (enfileirar runs, deploy, delete). Ele não tem prefixo que o denuncie, então a
// checagem mais barata e exata é: se o valor está no AMBIENTE de quem commita, QUALQUER ocorrência
// literal dele numa linha adicionada bloqueia — nu, dentro de URL, em bloco de markdown ou em args
// JSON do mcp-remote, dá no mesmo. Isto COMPLEMENTA (não substitui) a régua por FORMA abaixo, que é a
// que protege o repositório publicado, onde o token de quem commita não é o token vazado.
const SELF_SECRET_ENV_VARS = [
  'AGILEHARNESS_MCP_TOKEN',
  'AGILEHARNESS_MCP_TOKEN_ORCH',
  'AGILEHARNESS_MCP_TOKEN_RO',
  'AGILEHARNESS_VAPID_PRIVATE_KEY',
  'AGILEHARNESS_AUTH_TOKEN',
  'AGILEHARNESS_SESSION_SECRET',
  // As grafias LEGADAS (ponte de nomes, packages/storymap-ui/src/lib/storymap/env-aliases.ts): o ambiente de
  // quem commita pode ainda tê-las — e o valor é o mesmo segredo.
  'STORYMAP_MCP_TOKEN',
  'STORYMAP_MCP_TOKEN_ORCH',
  'STORYMAP_MCP_TOKEN_RO',
  'STORYMAP_VAPID_PRIVATE_KEY',
];

/** Literais a bloquear, lidos do ambiente. Nunca ecoa o valor — o achado nomeia só a variável. */
function selfSecretLiterals(env) {
  const extra = String(env.SECRET_SCAN_LITERAL_VARS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const name of [...SELF_SECRET_ENV_VARS, ...extra]) {
    const value = String(env[name] ?? '').trim();
    // <16 chars ou placeholder = knob de dev, não segredo: bloquear por ele geraria ruído sem proteger.
    if (value.length >= 16 && !PLACEHOLDER.test(value) && !looksLikeFixture(value)) out.push({ name, value });
  }
  return out;
}

// --- Token NU de alta entropia (a régua por FORMA) ---------------------------------------------
// A causa estrutural da segunda cegueira era a ORDEM, não a lista de regex: a checagem de entropia
// existia, mas só era alcançada DEPOIS do gate "palavra-chave + aspas". Um token nu — em crase de
// markdown, num path/query de URL, ou sozinho numa linha de bloco de código — nunca chegava nela.
// Aqui a entropia roda SOZINHA, sem exigir palavra-chave nem aspas, nos contextos em que um token
// aparece sem rótulo. As travas de precisão são o que separa isto de um gerador de falso-positivo:
// assinatura de alfabeto aleatório (minúscula E maiúscula E dígito — o que derruba kebab-case,
// SCREAMING_SNAKE e path), entropia ≥4.0, e exclusão de sha/UUID (ruído onipresente num repo de
// agentes: `agent-<uuid>`, sha de commit).
//
// O piso de 32 chars é MEDIDO, não arbitrário: um uid do Firebase Auth tem exatamente 28 chars com a
// mesma assinatura (maiúscula+minúscula+dígito, entropia alta) e este repositório cita uids reais em
// docs e runbooks — com piso 28 a regra reprovava esses arquivos. O segredo que ela existe para pegar,
// o token do MCP, tem 43.
const NAKED_MIN_LEN = 32;
const NAKED_MIN_ENTROPY = 4.0;

// Arquivos cujo conteúdo é alta entropia POR CONSTRUÇÃO (hash de integridade, snapshot, bundle). A
// régua por forma não se aplica a eles — as demais regras continuam se aplicando.
const HIGH_ENTROPY_BY_DESIGN =
  /(^|\/)(bun\.lock|bun\.lockb|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.(snap|map|lockb)$|\.min\.js$/;

// Blob binário embutido na LINHA (imagem em base64, `data:` URI). Também é alta entropia por
// construção, e o `/` do alfabeto base64 se disfarça de separador de path — sem esta trava, uma
// fixture de 53KB com um JPEG (uma fixture de teste de 53KB com um JPEG embutido)
// gerava 82 achados sozinha. As outras regras continuam valendo na linha.
const EMBEDDED_BLOB = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,|[A-Za-z0-9+/]{120,}={0,2}/;

/** Candidatos a token nu na linha: em crase, como segmento de path/valor de query, ou linha sozinha. */
function nakedTokenCandidates(text) {
  const out = [];
  const push = (m) => m && out.push(m);
  // crase de markdown — o conteúdo INTEIRO tem de ser o token (um `caminho/de/arquivo` não casa)
  for (const m of text.matchAll(new RegExp(String.raw`\x60([A-Za-z0-9_-]{${NAKED_MIN_LEN},})\x60`, 'g'))) push(m[1]);
  // segmento de path (`/api/mcp/<tok>/mcp`) ou valor de query/atribuição (`?secret=<tok>`)
  for (const m of text.matchAll(
    new RegExp(String.raw`[/=]([A-Za-z0-9_-]{${NAKED_MIN_LEN},})(?=[/?&#\s"'\x60,)\]}]|$)`, 'g'),
  ))
    push(m[1]);
  // linha contendo SÓ o token (bloco de código de markdown, heredoc)
  push(text.match(new RegExp(String.raw`^\s*([A-Za-z0-9_-]{${NAKED_MIN_LEN},})\s*$`))?.[1]);
  return out;
}

/** O token nu tem forma de credencial (e não de sha/UUID/identificador)? */
function looksLikeNakedToken(tok) {
  if (tok.length < NAKED_MIN_LEN) return false;
  if (PLACEHOLDER.test(tok) || looksLikeFixture(tok)) return false;
  if (/^[0-9a-fA-F-]+$/.test(tok)) return false; // sha de commit, digest hex, UUID
  // assinatura de alfabeto aleatório: as três classes juntas. Derruba `AGILEHARNESS_AUTORUN_PUBLISH_ENABLED`,
  // `packages-storymap-ui-runner` e afins sem precisar de lista de exceções.
  if (!/[a-z]/.test(tok) || !/[A-Z]/.test(tok) || !/[0-9]/.test(tok)) return false;
  return shannonEntropy(tok) >= NAKED_MIN_ENTROPY;
}

// --- COBERTURA: o arquivo que o git recusa apresentar como texto (o bypass do byte NUL) ----------
// O QUE ESTE CONTROLE IMPEDE: desligar as quatro camadas de regra acima com UM byte. Um único NUL nos
// primeiros ~8000 bytes faz o git classificar o arquivo como binário e emitir apenas
// `Binary files … differ` — sem cabeçalho `+++`, sem NENHUMA linha `+`. Como todas as regras varrem
// linhas ADICIONADAS, elas viram no-op de uma vez e o commit sai VERDE com a credencial sentada depois
// do NUL. Plantar o byte é uma edição de um caractere.
//
// A classe existe HOJE neste repositório, não é hipótese: `git ls-files --eol | grep '^i/-text'`
// devolve arquivos `.ts`/`.js` de TEXTO que o git já classifica assim.
//
// A RÉGUA é a EXTENSÃO, e é deliberadamente ela e NÃO o atributo `-diff`/`binary` do git: o
// `.gitattributes` viaja no MESMO commit que o atacante controla, então deixá-lo decidir o que é
// "binário legítimo" devolveria o bypass por outra porta. A lista abaixo enumera o que é binário POR
// CONSTRUÇÃO; tudo fora dela é TEXTO e precisa ser varrido. O erro é para o lado de varrer DEMAIS
// (ruído num formato binário novo), nunca de varrer de menos (segredo publicado). `.snap` fica FORA de
// propósito: snapshot de teste é texto e já vazou valor antes.
//
// RISCO RESIDUAL assumido: as extensões de blob GENÉRICO (`.bin`, `.dat`, `.db`) não nomeiam formato
// nenhum, então dispensá-las dispensa também um segredo que alguém batize assim. É o preço de não gerar
// falso-positivo em binário legítimo, e o flanco não fica sem cobertura: o gate de publicação LISTA todo
// arquivo não varrido, nomeando cada um, antes de liberar o push.
export const BINARIO_POR_CONSTRUCAO =
  /\.(png|jpe?g|gif|webp|avif|bmp|tiff?|ico|icns|psd|svgz|woff2?|ttf|ttc|otf|eot|pdf|zip|gz|tgz|bz2|xz|zst|7z|rar|br|wasm|mp[34]|m4a|wav|ogg|flac|webm|mov|avi|mkv|so|dylib|dll|exe|node|bin|dat|class|jar|pyc|onnx|pt|safetensors|tflite|lockb|pack|idx|sqlite3?|db|xlsx?|docx?|pptx?|odt|ods)$/i;

// Default git runner (real child_process). Injectable so the scan logic is unit-testable
// WITHOUT a repo (tests pass a fake that returns canned diffs / throws to model maxBuffer).
// PORQUÊ 256 MiB e não 64: o gate do SNAPSHOT varre a árvore INTEIRA de um monorepo (não o diff de
// um commit), e 64 MiB estourava de fato — medido aqui, com o gate parando em
// `INTERNAL_ERROR could not scan diff: stdout maxBuffer length exceeded`.
//
// Estourar NÃO abria buraco (o caminho é fail-CLOSED: exit 1, ver o bloco INTERNAL_ERROR no fim do
// arquivo), mas um gate que não CONSEGUE rodar bloqueia todo release sem apontar nada acionável — e
// é assim que alguém decide que o gate é o problema e o desliga. O teto continua existindo para
// impedir que um repositório patológico consuma a memória da máquina; ele só deixou de disparar no
// tamanho normal deste repo.
function defaultGit(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

// --- Diff selectors (SM-08) --------------------------------------------------
// `--staged` (pre-commit) scans the CACHED diff; `--range A..B` (merge train) scans a COMMITTED
// range. Pure arg builders so the exact git invocation is assertable in a unit test.
/** @param {{ staged?: boolean, range?: string }} spec @returns {string[]} */
export function buildNameArgs(spec) {
  return spec.staged
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR']
    : ['diff', '--name-only', '--diff-filter=ACMR', spec.range];
}
/** @param {{ staged?: boolean, range?: string }} spec @returns {string[]} */
export function buildDiffArgs(spec) {
  return spec.staged
    ? ['diff', '--cached', '--diff-filter=ACMR', '-U0', '--no-color']
    : ['diff', '--diff-filter=ACMR', '-U0', '--no-color', spec.range];
}
/**
 * O RESGATE: força o diff TEXTUAL (`--text`) de caminhos específicos — os que o git apresentou como
 * binários. É o que faz o conteúdo depois do NUL voltar a ser varrido pelas quatro camadas, em vez de
 * apenas reprovado às cegas. Escopado por pathspec de propósito: `--text` na árvore inteira despejaria
 * cada PNG como linhas de lixo (falso-positivo em massa e diff além do maxBuffer).
 *
 * @param {{ staged?: boolean, range?: string }} spec @param {string[]} paths @returns {string[]}
 */
export function buildTextDiffArgs(spec, paths) {
  return [...buildDiffArgs(spec), '--text', '--', ...paths];
}

// --- COBERTURA: o NOME do arquivo não pode desligar o scanner (o quoting de caminho do git) ---------
// O QUE ESTE CONTROLE IMPEDE: apagar as quatro camadas de regra com um CARACTERE NO NOME, sem tocar em
// byte nenhum do conteúdo. Com um caractere não-ASCII (ou `"`/`\`/controle) no caminho, o git ENVOLVE o
// nome em aspas e escapa os bytes em octal — e faz isso nos DOIS lugares que este scanner lê, com
// sintaxes diferentes: `--name-only` devolve `"pkg/configura\303\247\303\243o.ts"` e o cabeçalho do
// diff sai como `+++ "b/pkg/configura\303\247\303\243o.ts"`, com a aspa FORA do prefixo `b/`.
//
// Sem desfazer o quoting, três coisas falham de uma vez, todas em SILÊNCIO:
//  1. o regex do `+++` não casa ⇒ `file` fica vazio ⇒ nenhuma linha daquele arquivo é varrida;
//  2. a régua de arquivo PROIBIDO compara `.env.produção"` (com a aspa) contra o padrão e não casa;
//  3. o resgate `--text` recebe o nome COM as aspas como pathspec, não casa arquivo nenhum, devolve
//     diff vazio — e a rede de cobertura do byte NUL conclui "benigno" (ela julga pela ausência de
//     linhas, que é o mesmo sintoma de rename puro/arquivo vazio).
// MEDIDO neste repositório antes do conserto: `AKIA…` + byte NUL em `pkg/configuração.ts` saía exit 0.
//
// A régua é a FORMA da saída do git, não uma config: `core.quotePath=false` só faz o git já entregar o
// nome cru, e aí esta função é no-op. Não se pede ao git para desligar o quoting porque a saída CRUA
// continuaria ambígua para nomes com `"`/`\` — desfazer o escape é o que remove a ambiguidade.
/** @param {string} p @returns {string} */
export function unquoteGitPath(p) {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const corpo = p.slice(1, -1);
  const bytes = [];
  const SIMPLES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let i = 0; i < corpo.length; i++) {
    if (corpo[i] !== '\\') {
      bytes.push(...Buffer.from(corpo[i], 'utf8'));
      continue;
    }
    const c = corpo[++i];
    if (c === undefined) break; // barra solta no fim: nada a decodificar (não inventa byte)
    if (c >= '0' && c <= '7') {
      // escape OCTAL de UM byte (`\303`) — é assim que o git emite UTF-8; os bytes são remontados no fim
      bytes.push(parseInt(corpo.slice(i, i + 3), 8) & 0xff);
      i += 2;
      continue;
    }
    if (SIMPLES[c] !== undefined) bytes.push(SIMPLES[c]);
    else bytes.push(...Buffer.from(c, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * O caminho que o cabeçalho `+++ …` anuncia, já sem quoting e sem o prefixo `b/` — ou `''` quando a
 * linha não anuncia um arquivo do lado NOVO (`+++ /dev/null` de uma deleção).
 *
 * O TAB do fim: para um caminho com espaço o git separa o nome do resto com `\t` (`+++ b/my cfg.ts\t`).
 * Mantê-lo faria o mesmo arquivo ter DOIS nomes no scanner (o do `--name-only`, sem tab, e o do
 * cabeçalho, com tab) — o que já não é um furo (o resgate re-varre), mas duplica trabalho e reporta um
 * caminho que ninguém consegue abrir. Um nome que TERMINE em tab é sempre entregue com aspas, então
 * remover UM tab final aqui nunca corrompe um nome real.
 *
 * @param {string} raw @returns {string}
 */
function pathFromDiffHeader(raw) {
  let alvo = raw.slice(4);
  if (!alvo.startsWith('"') && alvo.endsWith('\t')) alvo = alvo.slice(0, -1);
  alvo = unquoteGitPath(alvo);
  return alvo.startsWith('b/') ? alvo.slice(2) : '';
}

/**
 * Descreve o valor achado SEM devolver nenhum byte dele — só o comprimento.
 *
 * O que esta máscara IMPEDE: que quem lê o relatório saia com material do segredo. O molde anterior
 * (`prefixo…sufixo (N chars)`) entregava 6 caracteres de uma credencial REAL por achado, e o relatório
 * não morre no terminal — ele viaja para o journal do merge train e, por
 * `withSecretScanBlockerFinding` (runner/findings.ts), para `findings[].detail` do card, que é
 * board-data COMMITADA. Um scan de árvore deste monorepo rende 73 achados: ~400 bytes de credencial de
 * produção num texto versionado.
 *
 * É a MESMA doutrina do `maskSecret` do MCP (packages/storymap-ui/src/lib/storymap/mcp/auth.ts), que
 * recusa o mascarado de pontas com o mesmo argumento. O achado continua acionável porque a identidade
 * dele é REGRA + CAMINHO + LINHA (+ nome da variável, quando a regra o conhece) — nunca os bytes.
 */
function redact(s) {
  return `oculto (${s.length} chars)`;
}

/**
 * Percorre as LINHAS ADICIONADAS de um diff unificado chamando `visita(file, text, lineNo)`, e devolve
 * o conjunto de arquivos que APARECERAM no diff (pelo cabeçalho `+++`).
 *
 * Extraído para o resgate `--text` rodar EXATAMENTE este parser: duas cópias seriam duas verdades, e a
 * que apodrece é a do caminho raro — que aqui é justamente o caminho do ataque.
 */
function percorreLinhasAdicionadas(diff, visita) {
  const arquivosNoDiff = new Set();
  let file = '';
  let lineNo = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      // `pathFromDiffHeader` (e NÃO um regex `^\+\+\+ b\/`) porque o git QUOTA o cabeçalho quando o nome
      // tem caractere não-ASCII, e ali a aspa cai FORA do `b/` — ver `unquoteGitPath`.
      file = pathFromDiffHeader(raw);
      if (file) arquivosNoDiff.add(file);
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      lineNo = m ? parseInt(m[1], 10) : 0;
      continue;
    }
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;

    const text = raw.slice(1);
    const here = lineNo;
    lineNo += 1;

    if (!file || file.startsWith(SELF_DIR)) continue; // never scan the scanner's own defs
    visita(file, text, here);
  }
  return arquivosNoDiff;
}

/** Aplica as quatro camadas de regra a UMA linha adicionada, empilhando os achados. */
function aplicaRegras(findings, file, text, here, selfSecrets) {
  // 2a) Segredo do PRÓPRIO produto, por ocorrência LITERAL — ANTES do pragma, e de propósito.
  // O `pragma: allowlist secret` existe para desculpar FALSO-POSITIVO de heurística; um casamento
  // literal com um valor lido do AMBIENTE não pode ser falso-positivo — não há o que desculpar. Se
  // essa linha aceitasse pragma, o segredo mais perigoso do repositório (o token que fala com o MCP
  // como Operador) sairia com um comentário de uma linha, escrito por qualquer um — inclusive por um
  // agente tentando destravar o próprio commit. A válvula que sobra é deliberada e do Operador:
  // `SKIP_SECRET_SCAN=1` no comando inteiro.
  for (const s of selfSecrets) {
    if (text.includes(s.value)) {
      // O preview NUNCA carrega o valor: um scanner que ecoa o segredo no stderr (log de CI,
      // journal do train, terminal compartilhado) vaza justamente o que veio bloquear.
      findings.push({
        file,
        line: here,
        rule: 'self-secret-literal',
        preview: `valor de ${s.name} (${s.value.length} chars)`,
        dedupe: `${s.name}\x00${s.value}`,
      });
    }
  }

  if (ALLOW_PRAGMA.test(text)) return;

  for (const p of PREFIX_PATTERNS) {
    const m = text.match(p.re);
    // skip a prefix match whose VALUE is an explicit fixture (e.g. AKIA…EXAMPLE); a marker-less token flags.
    // `guard` (opcional) é a trava de precisão de um prefixo que tolera hífen — ver `openai-key`.
    if (m && !looksLikeFixture(m[0]) && (!p.guard || p.guard(m[0]))) {
      findings.push({ file, line: here, rule: p.name, preview: redact(m[0]), dedupe: m[0] });
    }
  }

  // 2b) Atribuição com palavra-chave (código) — agora também sem aspas.
  const ka = text.match(KEYWORD_ASSIGN);
  const kaValue = ka && matchedValue(ka.groups?.qv, ka.groups?.bv);
  if (kaValue && looksLikeSecretValue(kaValue)) {
    findings.push({ file, line: here, rule: 'hardcoded-secret', preview: redact(kaValue), dedupe: kaValue });
  }

  // 2c) Atribuição a nome de env que DECLARA credencial (`PREFIXO_API_KEY`, `*_TOKEN`, …).
  const ea = text.match(ENV_ASSIGN);
  const eaValue = ea && matchedValue(ea.groups?.qv, ea.groups?.bv);
  if (eaValue && looksLikeSecretValue(eaValue, { declared: true })) {
    findings.push({
      file,
      line: here,
      rule: 'env-credential',
      preview: `${ea[1]} → ${redact(eaValue)}`,
      dedupe: `${ea[1]} ${eaValue}`,
    });
  }

  // 2d) Token NU de alta entropia, sem palavra-chave nem aspas (crase, URL, linha de bloco).
  if (!HIGH_ENTROPY_BY_DESIGN.test(file) && !EMBEDDED_BLOB.test(text)) {
    for (const tok of nakedTokenCandidates(text)) {
      if (looksLikeNakedToken(tok)) {
        findings.push({ file, line: here, rule: 'naked-high-entropy-token', preview: redact(tok), dedupe: tok });
      }
    }
  }
}

function scanDiff(spec, git, env) {
  const findings = [];
  const selfSecrets = selfSecretLiterals(env);

  // 1) Block added .env / key files (defense-in-depth; .gitignore can be bypassed with -f).
  // `unquoteGitPath` em TODO nome: sem ele, um caminho com caractere não-ASCII chega aqui entre aspas e
  // com os bytes escapados — a régua de arquivo proibido não casa (`.env.produção"`) e o resgate `--text`
  // recebe um pathspec que não existe. Ver `unquoteGitPath`.
  const names = git(buildNameArgs(spec))
    .split('\n')
    .map((s) => unquoteGitPath(s.trim()))
    .filter(Boolean);
  for (const f of names) {
    const base = f.split('/').pop();
    const isEnv = /^\.env(\.[A-Za-z0-9_-]+)?$/.test(base) && !/\.(example|sample|template|dist)$/.test(base);
    const isKeyFile = /(-key\.json|service[-_]?account.*\.json|\.pem|\.p12|\.pfx)$/i.test(base);
    if (isEnv || isKeyFile) {
      findings.push({ file: f, line: 0, rule: 'secret-file', preview: base, dedupe: base });
    }
  }

  // 2) Scan added lines of the diff.
  const noDiff = percorreLinhasAdicionadas(git(buildDiffArgs(spec)), (file, text, here) =>
    aplicaRegras(findings, file, text, here, selfSecrets),
  );

  // 3) COBERTURA — os arquivos que o git NÃO apresentou como texto (o bypass do byte NUL).
  // Um arquivo listado pelo `--name-only` e AUSENTE do diff é conteúdo que nenhuma regra viu. A causa
  // grave é o NUL; as benignas (rename puro, mudança só de modo, arquivo vazio) também caem aqui e são
  // filtradas pelo próprio resgate: ele não devolve linha nenhuma para elas, então não geram achado.
  // Binário POR CONSTRUÇÃO fica fora — ver `BINARIO_POR_CONSTRUCAO` para a régua e o porquê.
  const semConteudo = names.filter(
    (f) => !noDiff.has(f) && !f.startsWith(SELF_DIR) && !BINARIO_POR_CONSTRUCAO.test(f),
  );
  if (semConteudo.length > 0) {
    // O NUL é julgado pelo lado NOVO, nunca pelo veredito "binário" do git: com o blob ANTIGO sujo e o
    // novo limpo o git ainda diz `Binary files … differ`, e reprovar por isso tornaria o próprio
    // conserto (remover o NUL) impossível de commitar.
    const nulPorArquivo = new Map();
    percorreLinhasAdicionadas(git(buildTextDiffArgs(spec, semConteudo)), (file, text, here) => {
      if (text.includes('\x00') && !nulPorArquivo.has(file)) nulPorArquivo.set(file, here);
      aplicaRegras(findings, file, text, here, selfSecrets);
    });
    for (const [file, line] of nulPorArquivo) {
      // ANTES do pragma por construção (é empilhado fora do caminho de `aplicaRegras`): um arquivo que
      // o scanner não pôde ler não é falso-positivo de heurística, então não há o que desculpar — e um
      // pragma valendo aqui devolveria o bypass inteiro por um comentário de uma linha.
      findings.push({
        file,
        line,
        rule: 'nul-in-text-file',
        preview: 'byte NUL — o git diffa este arquivo como binário e as regras não o alcançam',
        dedupe: `nul\x00${file}`,
      });
    }
  }
  // Um mesmo segredo casa em várias regras (prefixo + nome de env + forma nua) — reportar 3 vezes a
  // mesma linha enterra os OUTROS achados. A dedupe é por linha + VALOR CRU (campo `dedupe`), e o campo
  // é REMOVIDO aqui: deduplicar pelo `preview` deixou de servir quando a máscara passou a elidir os
  // bytes (dois segredos DIFERENTES de mesmo comprimento na mesma linha mascaram igual e o segundo
  // desapareceria do relatório), e o valor cru não pode sair desta função — o `findings[]` que ela
  // devolve é serializado para o card.
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const key = `${f.file}:${f.line}:${f.dedupe}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { dedupe: _valorCru, ...semValor } = f;
    out.push(semValor);
  }
  return out;
}

// Parse the CLI selector: `--range A..B` (committed range) wins; otherwise `--staged` (the
// pre-commit default, also assumed when neither flag is given).
function parseSpec(argv) {
  const i = argv.indexOf('--range');
  if (i >= 0 && argv[i + 1]) return { range: argv[i + 1] };
  return { staged: true };
}

/**
 * Run one scan and RETURN an exit code (does NOT call process.exit — the caller does), so the
 * whole contract is unit-testable over an injected `git`/`env`. Codes: 0 clean · 2 secret found ·
 * 1 INTERNAL error (SM-08 fail-CLOSED — a scan that cannot complete must block, never pass).
 *
 * `findings` volta no resultado (com preview já redigido — nunca o valor cru) para o teste poder
 * afirmar QUAL regra pegou o vazamento, e não só que o commit foi barrado.
 *
 * @param {{ argv?: string[], git?: (args: string[]) => string, env?: Record<string, string | undefined> }} [opts]
 * @returns {{ code: number, internalError?: boolean, findings?: Array<{ file: string, line: number, rule: string, preview: string }> }}
 */
export function runScan({ argv = [], git = defaultGit, env = process.env } = {}) {
  if (env.SKIP_SECRET_SCAN === '1' || env.SKIP_PRECOMMIT === '1' || env.HUSKY_SKIP_HOOKS === '1') {
    return { code: 0, findings: [] };
  }
  const spec = parseSpec(argv);
  let findings = [];
  try {
    findings = scanDiff(spec, git, env);
  } catch (err) {
    // SM-08: an internal scan failure (e.g. a diff past git's maxBuffer) used to exit 0 (fail-OPEN),
    // silently bypassing the gate. Emit an identifiable INTERNAL_ERROR token and exit 1 (fail-CLOSED)
    // so the merge train blocks the push rather than treating an un-scanned diff as clean.
    process.stderr.write(`[scan-secrets] INTERNAL_ERROR could not scan diff: ${err.message}\n`);
    return { code: 1, internalError: true };
  }
  if (findings.length === 0) return { code: 0, findings };

  process.stderr.write('\n🔒 secret scan BLOCKED the commit:\n\n');
  for (const f of findings) {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    process.stderr.write(`  ✗ [${f.rule}] ${loc} → ${f.preview}\n`);
  }
  if (findings.some((f) => f.rule === 'nul-in-text-file')) {
    // Mensagem PRÓPRIA porque o conserto é outro: não há valor para mover nem heurística para
    // desculpar — o arquivo simplesmente não pôde ser varrido, e `pragma` não vale para ele.
    process.stderr.write(
      '\n[nul-in-text-file] O arquivo acima carrega um byte NUL, então o git o diffa como BINÁRIO e as\n' +
        'regras de segredo não veem uma única linha dele — um arquivo NÃO VARRIDO não é um arquivo limpo.\n' +
        'Conserto: remova o NUL (`perl -i -pe \'s/\\0//g\' <arquivo>`) e re-stageie. Se o arquivo é de fato\n' +
        'binário, dê a ele a extensão do formato (a régua é a extensão — ver BINARIO_POR_CONSTRUCAO).\n' +
        '`pragma: allowlist secret` NÃO desculpa este achado; a válvula é SKIP_SECRET_SCAN=1.\n',
    );
  }
  process.stderr.write(
    '\nMove the value to a secret manager / .env (gitignored). ' +
      'If it is a TEST FIXTURE, embed an explicit marker in the value itself (e.g. EXAMPLE / FAKE / DUMMY / MOCK). ' +
      'Otherwise, for a genuine false positive add `pragma: allowlist secret` on the line ' +
      'or bypass once with SKIP_SECRET_SCAN=1 git commit ...\n\n',
  );
  return { code: 2, findings };
}

// Entry point — only when invoked AS the script (not when imported by a test). Resolve argv[1]
// (which may be relative, e.g. the pre-commit hook's `node scripts/git-hooks/scan-secrets.mjs`)
// to a real path and compare against this module's path; mismatch/throw ⇒ imported, do nothing.
function invokedAsScript() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
if (invokedAsScript()) {
  process.exit(runScan({ argv: process.argv.slice(2) }).code);
}
