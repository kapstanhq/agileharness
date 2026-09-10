#!/usr/bin/env node
// scan-snapshot-secrets.mjs — GATE DO SNAPSHOT DE PUBLICAÇÃO (story-jxwrsk).
//
// O que este gate IMPEDE: publicar uma árvore que contém credencial. O único controle de segredo do
// repo até aqui é o pre-commit (`scan-secrets.mjs --staged`), que enxerga **o índice** — logo, é cego a
// tudo que já está commitado ou simplesmente já está no disco. Num repo OSS novo isso é o pior cenário
// possível: o snapshot nasce de `git init` (zero hooks) e o commit único É o artefato publicado — não há
// histórico onde se esconder nem segunda chance. Este script varre a ÁRVORE INTEIRA do snapshot,
// respeitando `.gitignore`, e reprova (exit 2) antes do primeiro push.
//
// REUSA as regras do pre-commit em vez de duplicá-las: importa `runScan`/`buildDiffArgs`/`buildNameArgs`
// de `scripts/git-hooks/scan-secrets.mjs` e injeta um `git` sintético que apresenta a árvore como se
// fosse um diff de adição integral. Uma segunda cópia dos regexes seria uma segunda verdade — e a que
// apodrece. Consequência de desenho: o gate tem exatamente a cobertura das regras do pre-commit, nem
// mais nem menos (por isso a ordem dura do card: as regras corrigidas primeiro, o baseline depois).
//
// LIGADO (não é capacidade declarada): `just oss-snapshot-gate` roda este script sobre o que a lista de
// extração deixa viajar, e é o passo do runbook de publicação (docs/plans/agileharness-oss/
// 06-frente-release.md, WS-H) antes do primeiro push; `just scan-snapshot-secrets` roda o baseline da
// árvore inteira. O amarrado é guardado por um teste de PRODUTOR
// (packages/storymap-ui/src/lib/storymap/runner/snapshot-gate-wiring.test.ts): ele executa o alvo do
// justfile de ponta a ponta, então o gate não pode voltar a existir sem que nada o chame.
//
// Uso:
//   node scripts/security/scan-snapshot-secrets.mjs [<dir>] [--json] [--allowlist <arq>]
//                                                  [--exclude-from <arq>] [--max-bytes N]
//                                                  [--fail-on-unscanned]
//
// Exit codes: 0 = limpo (ou todo achado reconhecido na allowlist) · 2 = achado bloqueia a publicação ·
// 1 = erro interno/uso (fail-CLOSED: um gate que não conseguiu rodar NUNCA devolve verde).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BINARIO_POR_CONSTRUCAO,
  buildDiffArgs,
  buildNameArgs,
  buildTextDiffArgs,
  runScan,
} from '../git-hooks/scan-secrets.mjs';

const ALLOWLIST_PADRAO = 'scripts/security/secret-baseline-allowlist.json';
const MAX_BYTES_PADRAO = 2 * 1024 * 1024;
const LOTE_BYTES = 4 * 1024 * 1024;

// As válvulas de bypass do commit — legítimas para desbloquear UM commit local — são REMOVIDAS do
// ambiente antes de chamar as regras. Isso IMPEDE que quem publica silencie o gate exportando uma
// variável, justamente no lugar onde não existe "depois eu arrumo".
const VALVULAS_DE_BYPASS = ['SKIP_SECRET_SCAN', 'SKIP_PRECOMMIT', 'HUSKY_SKIP_HOOKS'];

// ...e o RESTO do ambiente passa de propósito. As regras casam também os LITERAIS das credenciais do
// próprio produto, lendo o VALOR delas do ambiente (`selfSecretLiterals`, scan-secrets.mjs). Zerar o
// ambiente para ganhar imunidade desarmaria em silêncio exatamente a regra que pega o token do produto
// nu na árvore — trocaria um bypass explícito por um ponto cego invisível. Remove-se a válvula, não o ar.
function envParaAsRegras(base = process.env) {
  const env = { ...base };
  for (const v of VALVULAS_DE_BYPASS) delete env[v];
  return env;
}
const ENV_SEM_VALVULAS = envParaAsRegras();

// O adapter casa a invocação de git PELOS BUILDERS EXPORTADOS do scanner: se ele mudar a forma como
// chama git, o casamento continua válido (ou estoura alto, nunca em silêncio).
const SPEC = Object.freeze({ staged: true });
const ARGS_NAMES = JSON.stringify(buildNameArgs(SPEC));
const ARGS_DIFF = JSON.stringify(buildDiffArgs(SPEC));
// O resgate `--text` do scanner (a camada de COBERTURA do byte NUL) é escopado por pathspec, então a
// cauda de argumentos varia — casa-se pelo CABEÇALHO fixo.
const ARGS_TEXTO_CABECA = buildTextDiffArgs(SPEC, []);

class ErroDeUso extends Error {}

// ---------------------------------------------------------------------------
// 1) Que arquivos formam o snapshot
// ---------------------------------------------------------------------------

function raizDoSnapshot(alvo) {
  const dir = path.resolve(alvo || process.cwd());
  try {
    statSync(dir);
  } catch {
    throw new ErroDeUso(`alvo não existe: ${dir}`);
  }
  try {
    const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return realpathSync(top);
  } catch {
    throw new ErroDeUso(
      `o alvo não é um worktree git: ${dir}\n` +
        '  Quem decide o que ENTRA no snapshot é o .gitignore, e é o git que sabe lê-lo — sem repo o\n' +
        '  gate não adivinha (adivinhar aqui seria varrer node_modules e/ou perder um .env de verdade).\n' +
        '  Rode `git init` no snapshot e repita: não precisa commitar, `--others --exclude-standard`\n' +
        '  já enxerga a árvore inteira menos o que o .gitignore exclui.',
    );
  }
}

/** Árvore de trabalho INTEIRA (rastreado ∪ não-rastreado), menos o que o .gitignore exclui. */
function arquivosDoSnapshot(raiz) {
  const saida = execFileSync(
    'git',
    ['-C', raiz, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  return [...new Set(saida.split('\0').filter(Boolean))].sort();
}

/**
 * Só o conteúdo RASTREADO. É o que a extração OSS copia: o artefato é "cópia do SHA congelado + um
 * commit" (docs/plans/agileharness-oss/06-frente-release.md, WS-H), então arquivo não-commitado deste
 * checkout não viaja e reprová-lo mediria o disco de quem rodou, não o que vai a público. NUNCA é o
 * default: no snapshot já extraído, e no baseline da árvore, o não-rastreado É parte do que se publica
 * (um `.env.local` do primeiro boot entra no `git add -A` do repo novo).
 */
function arquivosRastreados(raiz) {
  const saida = execFileSync('git', ['-C', raiz, 'ls-files', '-z', '--cached'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return [...new Set(saida.split('\0').filter(Boolean))].sort();
}

/**
 * Quais destes arquivos uma LISTA DE EXCLUSÃO tira do snapshot — `--exclude-from <arquivo>` (a lista
 * executável do que NÃO viaja: nela a raiz inteira sai e só a ferramenta volta por negação).
 *
 * Por que isto existe: sem escopo, o gate rodado a partir do monorepo mede uma árvore que NÃO é o
 * artefato publicado — hoje ele acha 73 credenciais de OUTROS pacotes (os apps do monorepo de origem),
 * nenhuma delas viajando na extração. Um gate permanentemente vermelho por achados que não são do
 * artefato é um gate que ninguém roda — e um gate que ninguém roda não protege publicação nenhuma. Com
 * a lista, `--exclude-from` mede exatamente o que vai a público.
 *
 * A régua é o próprio git (`check-ignore` com a lista em `core.excludesFile`), como a lista prescreve —
 * globbing próprio seria uma segunda interpretação da mesma sintaxe. CAVEAT deliberado: um `.gitignore`
 * DENTRO da árvore tem precedência sobre `core.excludesFile`, então um caminho re-incluído por negação
 * local continua no escopo. O erro é para o lado de varrer MAIS, nunca menos.
 */
function arquivosExcluidos(raiz, arquivos, listaAbs) {
  try {
    if (!statSync(listaAbs).isFile()) throw new Error('não é arquivo');
  } catch {
    // fail-CLOSED: silenciar uma lista ausente faria o gate varrer a árvore inteira ACHANDO que mediu o
    // artefato — o verde/vermelho sairia sobre outra coisa que não o que se pretendia medir.
    throw new ErroDeUso(`lista de exclusão não encontrada: ${listaAbs}`);
  }
  if (arquivos.length === 0) return new Set();
  let saida = '';
  try {
    saida = execFileSync(
      'git',
      ['-C', raiz, '-c', `core.excludesFile=${listaAbs}`, 'check-ignore', '--no-index', '-z', '--stdin'],
      { input: arquivos.join('\0'), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
  } catch (err) {
    // `check-ignore` sai 1 quando NENHUM caminho casou — é resultado, não erro. Só 128 é falha real.
    if (err?.status === 1) saida = String(err.stdout ?? '');
    else throw new Error(`check-ignore falhou ao aplicar ${listaAbs}: ${err?.message ?? err}`);
  }
  return new Set(saida.split('\0').filter(Boolean));
}

/**
 * Lê um arquivo como texto ou diz por que NÃO deu. Nada aqui é silencioso: todo arquivo que o gate não
 * varreu vira uma linha do relatório, porque "não varri" contado como "está limpo" é o falso-negativo
 * que este script existe para não ter.
 *
 * Cada pulo se declara ESTRUTURAL ou não, e a distinção é o que `--fail-on-unscanned` julga:
 *  - ESTRUTURAL = não existe texto para varrer, e nenhuma ação do operador muda isso (um PNG é um PNG).
 *    Continua no relatório — o gate segue não afirmando nada sobre o conteúdo dele.
 *  - ACIDENTAL = o gate TERIA lido, e algo atravessou (teto de `--max-bytes`, arquivo não-regular,
 *    entrada só do índice). É o bucket onde um segredo se esconde de fato, e é o que a flag reprova.
 *
 * ⚠️ "As REGRAS não olham este caminho" NÃO é nenhum dos dois, e por isso não é mais um pulo: ali o
 * texto EXISTE (chamar aquilo de ESTRUTURAL contradizia a definição acima, e o efeito era o gate liberar
 * em silêncio o único arquivo cego do artefato). O gate passou a RE-APRESENTAR esse conteúdo sob um
 * rótulo que a régua de prefixo do scanner não pula — ver `ROTULO_DE_CAMINHO_CEGO` — e só se nem assim
 * as regras olharem é que sobra um pulo, aí declarado ACIDENTAL (reprova com a flag).
 *
 * O byte NUL deixou de ser pulo: num arquivo de extensão de TEXTO ele é o bypass do scanner (uma edição
 * de um caractere apaga as regras inteiras — ver `BINARIO_POR_CONSTRUCAO` em scan-secrets.mjs), então o
 * conteúdo é varrido NORMALMENTE e o NUL vira ACHADO que bloqueia. Só extensão de binário conhecido
 * segue como pulo estrutural.
 */
function leTexto(abs, arquivo, maxBytes) {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return { pulo: 'não existe no disco (entrada só do índice)' };
  }
  if (!st.isFile()) return { pulo: 'não é arquivo regular' };
  if (st.size === 0) return { vazio: true };
  if (st.size > maxBytes) return { pulo: `maior que o teto de leitura (${st.size} bytes)` };
  const buf = readFileSync(abs);
  const iNul = buf.indexOf(0);
  if (iNul < 0) return { texto: buf.toString('utf8') };
  if (BINARIO_POR_CONSTRUCAO.test(arquivo)) {
    return { pulo: 'binário por construção (byte NUL, extensão de formato binário)', estrutural: true };
  }
  // Varre a árvore INTEIRA do arquivo, não só os ~8000 bytes que o git olha para decidir binário: o
  // NUL depois dessa janela não cega o pre-commit, mas continua sendo um arquivo de texto corrompido
  // que ninguém deveria publicar — e o custo de reportá-lo é uma linha, não um falso-negativo.
  return { texto: buf.toString('utf8'), nul: iNul };
}

// ---------------------------------------------------------------------------
// 2) Apresentar a árvore às regras do pre-commit
// ---------------------------------------------------------------------------

/**
 * Monta um diff unificado sintético em que TODO o conteúdo do arquivo é linha adicionada — a mesma forma
 * que o scanner já sabe ler, e a forma correta para um snapshot (num commit inicial, cada linha É uma
 * adição).
 */
function diffSintetico(entradas) {
  const partes = [];
  for (const { arquivo, texto } of entradas) {
    const linhas = texto.split('\n');
    if (linhas.length > 0 && linhas[linhas.length - 1] === '') linhas.pop(); // \n final não é linha
    if (linhas.length === 0) continue;
    partes.push(`+++ b/${arquivo}`);
    partes.push(`@@ -0,0 +1,${linhas.length} @@`);
    for (const l of linhas) {
      // Uma linha de CONTEÚDO que começa com `++` viraria `+++…` ao ser prefixada, e o parser de diff
      // descarta `+++` (é cabeçalho de arquivo). Isso IMPEDE dois estragos: o segredo escondido numa
      // linha assim escaparia do gate, e a linha descartada desalinharia a numeração de todo o resto do
      // arquivo. O espaço extra preserva o conteúdo para as regras (nenhuma delas é ancorada no início
      // da linha) e só desloca em 1 a coluna — que nem aparece no relatório.
      partes.push(l.startsWith('++') ? `+ ${l}` : `+${l}`);
    }
  }
  return partes.join('\n');
}

function capturaStderr(fn) {
  const pedacos = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, enc, cb) => {
    pedacos.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  };
  try {
    const res = fn();
    return { texto: pedacos.join(''), res };
  } finally {
    process.stderr.write = original;
  }
}

// O relatório do scanner é a superfície de saída dele: `  ✗ [regra] arquivo:linha → oculto (N chars)`.
// O gate consome JÁ MASCARADO — nunca tem o valor bruto em mãos —, e é isso que faz a máscara ser
// estrutural: não existe caminho no código por onde bytes do segredo possam vazar para log ou allowlist.
// A máscara do scanner elide o valor INTEIRO (só o comprimento sai), então a identidade do achado abaixo
// não carrega material do segredo — e é por isso que a allowlist consome UMA entrada por ocorrência
// (ver `aplicaAllowlist`).
const LINHA_DE_ACHADO = /^\s*✗\s+\[([^\]]+)\]\s+(\S.*?)\s+→\s+(.+?)\s*$/;

function parseRelatorio(texto) {
  const achados = [];
  for (const linha of texto.split('\n')) {
    const m = linha.match(LINHA_DE_ACHADO);
    if (!m) continue;
    const [, regra, loc, preview] = m;
    const ml = loc.match(/^(.*):(\d+)$/);
    achados.push({
      rule: regra,
      file: ml ? ml[1] : loc,
      line: ml ? Number(ml[2]) : 0,
      preview,
    });
  }
  return achados;
}

function chamaRegras(diff, nomes) {
  const git = (args) => {
    const chave = JSON.stringify(args);
    if (chave === ARGS_NAMES) return nomes.join('\n');
    if (chave === ARGS_DIFF) return diff;
    // O resgate `--text` do scanner existe para arrancar conteúdo de um blob que o GIT recusou mostrar.
    // Aqui não há blob nem git: o gate lê os bytes do DISCO e já detecta o NUL ele mesmo (`leTexto`),
    // reportando-o como achado. Devolver vazio é a resposta HONESTA — "nenhum arquivo deste diff foi
    // apresentado como binário" —, e não um silenciamento: o controle do NUL está a montante, não aqui.
    if (ARGS_TEXTO_CABECA.every((a, i) => args[i] === a)) return '';
    // fail-CLOSED: uma invocação que não reconhecemos significa que o contrato do scanner mudou.
    throw new Error(`invocação de git inesperada pelo scanner: ${args.join(' ')}`);
  };
  const { texto, res } = capturaStderr(() =>
    runScan({ argv: ['--staged'], git, env: ENV_SEM_VALVULAS }),
  );
  if (res.code === 1) throw new Error(`o scanner falhou internamente: ${texto.trim() || 'sem detalhe'}`);
  const achados = parseRelatorio(texto);
  if (res.code === 2 && achados.length === 0) {
    // O scanner bloqueou e não conseguimos ler o achado: reportar "limpo" aqui seria transformar uma
    // mudança de formato do relatório num falso-negativo silencioso no gate de publicação.
    throw new Error(
      'o scanner bloqueou mas nenhuma linha de achado foi reconhecida — o formato do relatório mudou;\n' +
        'atualize LINHA_DE_ACHADO neste arquivo antes de confiar no gate',
    );
  }
  return achados;
}

/**
 * As regras do pre-commit IGNORAM por desenho o diretório onde elas próprias moram (senão as definições
 * de padrão se auto-acusariam). Para um gate de árvore isso é um ponto cego real, então em vez de copiar
 * a constante (que apodreceria) o gate DESCOBRE o ponto cego: manda um token sintético pelo caminho e vê
 * se o achado volta. Não voltar ⇒ aquele caminho não é varrido, e isso vai para o relatório.
 * Memoizado por diretório porque a régua do scanner é prefixo de caminho.
 */
// Montada em pedaços: o literal desta fonte NÃO pode casar com a regra que ela exercita, senão este
// arquivo trancaria o pre-commit do próprio repo.
const FORMA_DE_SONDA = ['AK', 'IA', 'ZQ7X4M2LP9WT6BND'].join('');
const memoCego = new Map();
function caminhoEhCego(arquivo) {
  const dir = path.posix.dirname(arquivo);
  if (memoCego.has(dir)) return memoCego.get(dir);
  const sonda = dir === '.' ? '__sonda__' : `${dir}/__sonda__`;
  const diff = [`+++ b/${sonda}`, '@@ -0,0 +1,1 @@', `+const sonda = '${FORMA_DE_SONDA}'`].join('\n');
  let cego;
  try {
    cego = chamaRegras(diff, []).length === 0;
  } catch {
    cego = false; // se a sonda não conclui, não invente ponto cego — o erro real aparece na varredura
  }
  memoCego.set(dir, cego);
  return cego;
}

/**
 * O prefixo sob o qual um arquivo de caminho CEGO é RE-APRESENTADO às regras.
 *
 * A cegueira do scanner é uma régua de PREFIXO DE CAMINHO (ele pula o diretório das próprias
 * definições, senão os padrões se auto-acusariam) — e quem monta o caminho do diff sintético é este
 * gate. Logo, o ponto cego não precisa existir: apresenta-se o MESMO conteúdo sob um rótulo que a régua
 * não pula, e mapeia-se o achado de volta para o caminho real.
 *
 * O que isto IMPEDE, medido: um `AKIA…` plantado em `scripts/git-hooks/scan-secrets.mjs` — arquivo que
 * VIAJA para o repo público (a antiga lista de extração o re-incluía explicitamente) — não produzia nenhum achado e o
 * gate o liberava como "ponto cego ESTRUTURAL", inclusive com `--fail-on-unscanned`. Sob o rótulo, o
 * mesmo byte bloqueia com exit 2. Era o único arquivo cego do snapshot de publicação, e era exatamente
 * o arquivo onde um segredo ficaria mais invisível.
 */
const ROTULO_DE_CAMINHO_CEGO = '__caminho-cego__';

/** O rótulo preserva o basename e a extensão: as regras de arquivo-proibido e de binário-por-construção
 *  julgam o NOME, então trocar `x/y/.env` por um nome qualquer trocaria a cobertura por outra. */
function rotuloParaCaminhoCego(arquivo) {
  return `${ROTULO_DE_CAMINHO_CEGO}/${arquivo}`;
}

// ---------------------------------------------------------------------------
// 3) Allowlist versionada (baseline acionável em vez de ruído)
// ---------------------------------------------------------------------------

/**
 * Identidade do achado = regra + valor MASCARADO. Deliberadamente NÃO é hash do valor bruto: um baseline
 * versionado com o hash do segredo real seria um oráculo de confirmação publicado junto com o código.
 * Também não inclui a LINHA: um falso-positivo não deve se reabrir só porque o arquivo andou.
 */
function hashDoAchado(achado) {
  return createHash('sha256').update(`${achado.rule}\u0000${achado.preview}`).digest('hex').slice(0, 16);
}

function leAllowlist(arq) {
  let bruto;
  try {
    bruto = readFileSync(arq, 'utf8');
  } catch {
    return { entries: [], caminho: arq, existe: false };
  }
  let doc;
  try {
    doc = JSON.parse(bruto);
  } catch (err) {
    // fail-CLOSED: uma allowlist ilegível não pode virar "nenhum reconhecimento" nem "tudo reconhecido".
    throw new ErroDeUso(`allowlist inválida (${arq}): ${err.message}`);
  }
  const entries = Array.isArray(doc) ? doc : doc?.entries;
  if (!Array.isArray(entries)) {
    throw new ErroDeUso(`allowlist inválida (${arq}): esperado um objeto com "entries": [] ou um array`);
  }
  for (const [i, e] of entries.entries()) {
    if (!e || typeof e.path !== 'string' || typeof e.hash !== 'string' || typeof e.reason !== 'string') {
      throw new ErroDeUso(
        `allowlist inválida (${arq}): entrada #${i} precisa de "path", "hash" e "reason" (o motivo é ` +
          'obrigatório: um baseline sem justificativa é ruído com aparência de decisão)',
      );
    }
  }
  return { entries, caminho: arq, existe: true };
}

// ---------------------------------------------------------------------------
// 4) Varredura
// ---------------------------------------------------------------------------

function varre(raiz, { maxBytes, excluirCom, somenteRastreados }) {
  const todos = somenteRastreados ? arquivosRastreados(raiz) : arquivosDoSnapshot(raiz);
  const fora = excluirCom ? arquivosExcluidos(raiz, todos, excluirCom) : new Set();
  const arquivos = fora.size > 0 ? todos.filter((a) => !fora.has(a)) : todos;
  const achados = [];
  const naoVarridos = [];
  let varridos = 0;

  // rótulo de re-apresentação → caminho REAL. O relatório, a allowlist (que casa por `path`) e o operador
  // falam do arquivo; o rótulo é detalhe interno de como o gate contorna a cegueira por prefixo.
  const deRotulo = new Map();

  let lote = [];
  let loteNomes = [];
  let loteBytes = 0;
  const drena = () => {
    if (loteNomes.length === 0) return;
    const doLote = chamaRegras(diffSintetico(lote), loteNomes);
    for (const a of doLote) a.file = deRotulo.get(a.file) ?? a.file;
    achados.push(...doLote);
    lote = [];
    loteNomes = [];
    loteBytes = 0;
  };

  for (const arquivo of arquivos) {
    const r = leTexto(path.join(raiz, arquivo), arquivo, maxBytes);
    if (r.pulo) {
      naoVarridos.push({ file: arquivo, reason: r.pulo, structural: r.estrutural === true });
      continue;
    }
    // O arquivo existe no snapshot e TEM texto, mas as regras se recusam a olhar aquele caminho (elas
    // ignoram o diretório das próprias definições, senão os padrões se auto-acusariam). Isso NUNCA foi
    // ponto cego estrutural — estrutural é "não existe texto para varrer" —, e classificá-lo assim fazia o
    // gate LIBERAR em silêncio, mesmo com `--fail-on-unscanned`, justamente o caminho que ele escolheu não
    // varrer. O remédio não é reclassificar: é VARRER, re-apresentando o conteúdo sob um rótulo que a
    // régua de prefixo não pula (ver ROTULO_DE_CAMINHO_CEGO).
    let rotulo = arquivo;
    if (caminhoEhCego(arquivo)) {
      rotulo = rotuloParaCaminhoCego(arquivo);
      if (caminhoEhCego(rotulo)) {
        // Nem sob o rótulo as regras olham — a cegueira não é (só) de prefixo, e aí realmente não há como
        // varrer este arquivo com as regras do pre-commit. ACIDENTAL de propósito: existe texto, ele não
        // foi lido, e `--fail-on-unscanned` REPROVA. Liberar aqui seria o falso-negativo silencioso de
        // novo, agora sem nem a desculpa de ter tentado.
        naoVarridos.push({
          file: arquivo,
          reason: 'as regras não olham este caminho nem sob rótulo — conteúdo NÃO varrido',
          structural: false,
        });
        continue;
      }
      deRotulo.set(rotulo, arquivo);
    }
    if (r.nul !== undefined) {
      // O achado é de COBERTURA, não de conteúdo: o arquivo tem extensão de texto e carrega um byte que
      // faz o git escondê-lo do pre-commit inteiro. A `line` é a do NUL, para o operador ir direto; o
      // `preview` é estável de propósito (a identidade do achado, e portanto o hash da allowlist, não
      // pode mudar a cada byte que o arquivo cresce).
      achados.push({
        rule: 'nul-in-text-file',
        file: arquivo,
        line: r.texto.slice(0, r.nul).split('\n').length,
        preview: 'byte NUL em arquivo de texto — cega o scanner de segredo do pre-commit',
      });
    }
    varridos += 1;
    // Vazio ainda entra na lista de NOMES (a regra de arquivo-proibido é por nome: um `.env` vazio
    // hoje é um `.env` cheio amanhã, e o nome já não deveria estar no snapshot). O NOME apresentado é o
    // rótulo — a regra de arquivo-proibido também pula o diretório das definições, então usar o caminho
    // real aqui deixaria um `.env` plantado num caminho cego passar pela régua de nome também.
    loteNomes.push(rotulo);
    if (r.texto) {
      lote.push({ arquivo: rotulo, texto: r.texto });
      loteBytes += r.texto.length;
    }
    if (loteBytes >= LOTE_BYTES) drena();
  }
  drena();

  achados.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
  for (const a of achados) a.hash = hashDoAchado(a);
  return { achados, naoVarridos, varridos, total: arquivos.length, fora };
}

/**
 * Casa achados contra a allowlist. Uma entrada reconhece UMA OCORRÊNCIA — o índice já usado não
 * reconhece o achado seguinte.
 *
 * O que o consumo por ocorrência IMPEDE: que reconhecer um falso-positivo passe a reconhecer, de
 * carona, um segredo REAL que apareça depois no mesmo arquivo. A identidade do achado (regra + valor
 * mascarado) deixou de carregar bytes do valor — de propósito, ver `redact` em scan-secrets.mjs —, logo
 * dois achados DIFERENTES de mesmo comprimento, mesma regra e mesmo arquivo têm hash IGUAL. Sem o
 * consumo, a entrada viraria um mute por (arquivo, regra, comprimento). N ocorrências legítimas exigem N
 * entradas, e o relatório imprime uma linha pronta por achado, então declarar as N é o caminho normal.
 *
 * `fora` = caminhos que a lista de exclusão tirou desta varredura. Uma entrada sem uso cujo caminho está
 * `fora` NÃO é baseline podre: ela existe para o baseline da árvore inteira e está apenas fora do escopo
 * desta passagem. Sem essa distinção, o gate do artefato OSS pediria a remoção de entradas que o baseline
 * da árvore precisa — e limpar o "podre" reabriria 8 falso-positivos lá.
 */
function aplicaAllowlist(achados, allowlist, fora = new Set()) {
  const usadas = new Set();
  const bloqueiam = [];
  const reconhecidos = [];
  for (const a of achados) {
    const i = allowlist.entries.findIndex(
      (e, idx) => !usadas.has(idx) && e.path === a.file && e.hash === a.hash,
    );
    if (i >= 0) {
      usadas.add(i);
      reconhecidos.push({ ...a, reason: allowlist.entries[i].reason });
    } else {
      bloqueiam.push(a);
    }
  }
  const semUso = allowlist.entries
    .map((e, i) => ({ e, i }))
    .filter(({ i }) => !usadas.has(i))
    .map(({ e }) => ({ path: e.path, rule: e.rule ?? null, hash: e.hash, reason: e.reason }));
  const podres = semUso.filter((e) => !fora.has(e.path));
  const foraDeEscopo = semUso.filter((e) => fora.has(e.path));
  return { bloqueiam, reconhecidos, podres, foraDeEscopo };
}

// ---------------------------------------------------------------------------
// 5) Saída
// ---------------------------------------------------------------------------

const AJUDA = `
scan-snapshot-secrets — GATE DO SNAPSHOT DE PUBLICAÇÃO

  É o gate que precisa passar ANTES do primeiro push público. Ele varre a ÁRVORE INTEIRA do snapshot de
  publicação (rastreado + não-rastreado, respeitando .gitignore) procurando credencial. O pre-commit
  (scan-secrets.mjs --staged) NÃO substitui isto: ele olha o índice, então é cego a tudo que já está
  commitado — e num repo novo o commit único é o próprio artefato publicado.

  Ele REUSA as regras do pre-commit (scripts/git-hooks/scan-secrets.mjs), não tem as suas. Logo a ordem
  de dependência é dura:

      regras cobrindo os tokens do próprio produto  →  este baseline sobre a árvore  →  primeiro push

  Rodar o gate antes de corrigir as regras produz um verde que não significa nada.

Como rodar (está LIGADO — os dois alvos existem no justfile)
  (passo oss-snapshot-gate)     o gate da PUBLICAÇÃO no CI: mede a árvore rastreada inteira (a lista de exclusão
                                deixa viajar — é o passo do runbook antes do primeiro push público
  just scan-snapshot-secrets    o baseline da ÁRVORE INTEIRA deste checkout (inclui o que não viaja)

Uso
  node scripts/security/scan-snapshot-secrets.mjs [<dir>] [opções]

  <dir>                  qualquer caminho dentro do snapshot (padrão: cwd). A varredura é sempre da RAIZ
                         do worktree git para baixo — "a árvore inteira" é literal.

Opções
  --json                 relatório estruturado em stdout (para CI)
  --allowlist <arquivo>  padrão: <raiz>/${ALLOWLIST_PADRAO}
  --exclude-from <arq>   restringe o snapshot ao que a lista deixa viajar (sintaxe de .gitignore, avaliada
                         pelo git). Opcional: nesta árvore tudo que existe é o que se publica. Sem isto, num monorepo o
                         gate mede uma árvore que NÃO é o artefato — e reprova por credencial de pacote
                         que nunca vai a público. O relatório SEMPRE diz quando houve escopo.
  --tracked-only         varre só o conteúdo RASTREADO — o que a extração copia (SHA congelado). Use junto
                         de --exclude-from na pré-checagem a partir do monorepo; NÃO use no snapshot já
                         extraído nem no baseline da árvore, onde o não-rastreado também é publicável.
  --max-bytes <n>        teto de leitura por arquivo (padrão: ${MAX_BYTES_PADRAO}); acima disso o arquivo
                         é reportado como NÃO varrido, nunca como limpo
  --fail-on-unscanned    reprova também se sobrou ponto cego ACIDENTAL — arquivo que o gate TERIA lido e
                         não leu (teto de --max-bytes, não-regular, só no índice). É o alvo da publicação
                         que roda com isto: liberar o que não se varreu é confiança falsa no momento
                         irreversível. Binário POR CONSTRUÇÃO (png/woff/lockb) é ponto cego ESTRUTURAL:
                         segue no relatório e NÃO reprova — do contrário a flag nasceria vermelha e sairia
                         do alvo na primeira semana. O diretório das próprias regras JÁ NÃO é ponto cego:
                         o conteúdo dele é re-apresentado sob rótulo e varrido de verdade.
                         Byte NUL em arquivo de EXTENSÃO DE TEXTO não é ponto cego: é ACHADO (bloqueia
                         com ou sem esta flag), porque é o bypass de um byte do scanner do pre-commit.
  -h, --help             esta ajuda

Saída
  O valor achado sai sempre ELIDIDO (só o comprimento) porque o relatório vai para log de CI, para o
  journal do merge train e para findings[].detail do card — board-data commitada. O achado se identifica
  por REGRA + CAMINHO + LINHA + hash, nunca por bytes do valor. O gate nunca tem o valor bruto em mãos:
  ele consome o relatório já redigido pelas regras.

Allowlist (baseline acionável)
  Falso-positivo se reconhece por caminho + hash do achado MASCARADO + motivo obrigatório, e cada entrada
  vale por UMA ocorrência (o hash não distingue dois valores de mesmo comprimento sob a mesma regra, então
  reconhecer em bloco reconheceria de carona o segredo real que aparecesse depois). O hash NÃO é do valor
  bruto, de propósito: um baseline versionado com o hash do segredo real seria um oráculo de confirmação
  publicado junto do código. Achado sem entrada correspondente bloqueia; entrada que não casa com nada é
  reportada como baseline podre.

Exit codes
  0 limpo (ou tudo reconhecido)   2 achado bloqueia a publicação   1 erro interno/uso (fail-CLOSED)

  As válvulas de bypass do commit (SKIP_SECRET_SCAN / SKIP_PRECOMMIT / HUSKY_SKIP_HOOKS) NÃO valem aqui.
`;

function imprimeTexto(rel) {
  const l = [];
  l.push('');
  l.push('🔒 gate de segredo do SNAPSHOT DE PUBLICAÇÃO');
  l.push(`   raiz: ${rel.root}`);
  l.push(
    `   arquivos no snapshot: ${rel.totalFiles} · varridos: ${rel.scannedFiles}` +
      (rel.trackedOnly ? ' · só RASTREADO (o que a extração copia)' : ''),
  );
  if (rel.excludeFrom) {
    l.push(`   escopo: ${rel.excludedFiles} arquivo(s) FORA do snapshot por ${rel.excludeFrom}`);
  }
  l.push(`   allowlist: ${rel.allowlist}${rel.allowlistExists ? '' : ' (ausente)'}`);
  l.push('');
  if (rel.findings.length > 0) {
    l.push(`✗ ${rel.findings.length} achado(s) BLOQUEIAM a publicação:`);
    l.push('');
    for (const f of rel.findings) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      l.push(`  ✗ [${f.rule}] ${loc} → ${f.preview}`);
    }
    l.push('');
    // Três saídas, e a ordem é a de julgamento: primeiro decida SE é segredo, depois SE viaja, e só
    // então reconheça. Uma mensagem que só oferece a allowlist convida a silenciar credencial real.
    l.push('  O que fazer com cada achado:');
    l.push('  1) É segredo DE VERDADE → ROTACIONE a credencial (quem tem esta árvore já a tem) e tire o');
    l.push('     valor do snapshot. Não existe reconhecer segredo real aqui.');
    l.push('  2) É segredo real, mas o arquivo NÃO VIAJA no artefato publicado (outro pacote, dado do');
    l.push('     dono) → exclua o caminho numa lista de exclusão e rode com');
    l.push('     `--exclude-from <lista>`, que mede o snapshot em vez da árvore inteira.');
    l.push('  3) É FALSO-POSITIVO (delimitador em .env.example, chave pública) → reconheça em');
    l.push(`     ${rel.allowlist} com motivo — UMA entrada por ocorrência:`);
    l.push('');
    for (const f of rel.findings.slice(0, 30)) {
      l.push(
        `    ${JSON.stringify({ path: f.file, rule: f.rule, hash: f.hash, reason: 'POR QUE não é segredo', addedAt: rel.today })},`,
      );
    }
    if (rel.findings.length > 30) l.push(`    … e mais ${rel.findings.length - 30} (use --json para a lista inteira)`);
    l.push('');
  }
  if (rel.allowlisted.length > 0) {
    l.push(`ℹ ${rel.allowlisted.length} achado(s) reconhecido(s) na allowlist:`);
    for (const f of rel.allowlisted) l.push(`  · [${f.rule}] ${f.file} — ${f.reason}`);
    l.push('');
  }
  if (rel.staleAllowlist.length > 0) {
    l.push(`ℹ ${rel.staleAllowlist.length} entrada(s) de allowlist não casaram com nada (baseline podre — remova):`);
    for (const e of rel.staleAllowlist) l.push(`  · ${e.path} ${e.hash}`);
    l.push('');
  }
  if (rel.outOfScopeAllowlist.length > 0) {
    // Distinto de podre DE PROPÓSITO: estas entradas servem o baseline da árvore inteira, e removê-las
    // por parecerem inúteis aqui reabriria os falso-positivos lá.
    l.push(
      `ℹ ${rel.outOfScopeAllowlist.length} entrada(s) de allowlist fora do escopo desta varredura ` +
        '(caminho excluído pela lista) — NÃO são baseline podre, não remova.',
    );
    l.push('');
  }
  if (rel.unscanned.length > 0) {
    // As duas listas saem SEPARADAS porque a régua do `--fail-on-unscanned` é a diferença entre elas —
    // um relatório que as misturasse deixaria o operador sem saber o que a flag vai julgar.
    const acidentais = rel.unscanned.filter((u) => !u.structural);
    const estruturais = rel.unscanned.filter((u) => u.structural);
    if (acidentais.length > 0) {
      l.push(
        `⚠ ${acidentais.length} arquivo(s) não varrido(s) que o gate TERIA lido` +
          `${rel.failOnUnscanned ? ' — REPROVAM (--fail-on-unscanned)' : ' (use --fail-on-unscanned para reprovar)'}:`,
      );
      for (const u of acidentais.slice(0, 40)) l.push(`  · ${u.file} — ${u.reason}`);
      if (acidentais.length > 40) l.push(`  · … e mais ${acidentais.length - 40}`);
      l.push('');
    }
    if (estruturais.length > 0) {
      l.push(
        `ℹ ${estruturais.length} arquivo(s) não varrido(s) por não terem texto (binário por construção / ` +
          'fora do alcance das regras) — o gate não afirma nada sobre o conteúdo deles:',
      );
      for (const u of estruturais.slice(0, 40)) l.push(`  · ${u.file} — ${u.reason}`);
      if (estruturais.length > 40) l.push(`  · … e mais ${estruturais.length - 40}`);
      l.push('');
    }
  }
  if (rel.ok) l.push('✓ snapshot liberado para publicação por este gate.');
  l.push('');
  process.stdout.write(l.join('\n'));
}

// ---------------------------------------------------------------------------
// 6) CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { alvo: '', json: false, allowlist: '', excluirCom: '', somenteRastreados: false, maxBytes: MAX_BYTES_PADRAO, falharSeNaoVarrido: false, ajuda: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') opts.ajuda = true;
    else if (a === '--fail-on-unscanned') opts.falharSeNaoVarrido = true;
    else if (a === '--allowlist') opts.allowlist = argv[++i] ?? '';
    else if (a === '--exclude-from') opts.excluirCom = argv[++i] ?? '';
    else if (a === '--tracked-only') opts.somenteRastreados = true;
    else if (a === '--max-bytes') opts.maxBytes = Number(argv[++i]);
    else if (a.startsWith('-')) throw new ErroDeUso(`opção desconhecida: ${a}`);
    else if (!opts.alvo) opts.alvo = a;
    else throw new ErroDeUso(`argumento posicional extra: ${a}`);
  }
  if (!Number.isFinite(opts.maxBytes) || opts.maxBytes <= 0) throw new ErroDeUso('--max-bytes precisa ser um número > 0');
  return opts;
}

export function main(argv) {
  const opts = parseArgs(argv);
  if (opts.ajuda) {
    process.stdout.write(AJUDA);
    return 0;
  }
  const root = raizDoSnapshot(opts.alvo);
  const allowlist = leAllowlist(opts.allowlist ? path.resolve(opts.allowlist) : path.join(root, ALLOWLIST_PADRAO));
  const excluirCom = opts.excluirCom ? path.resolve(opts.excluirCom) : '';
  const { achados, naoVarridos, varridos, total, fora } = varre(root, {
    maxBytes: opts.maxBytes,
    excluirCom,
    somenteRastreados: opts.somenteRastreados,
  });
  const { bloqueiam, reconhecidos, podres, foraDeEscopo } = aplicaAllowlist(achados, allowlist, fora);

  // A flag reprova o ponto cego ACIDENTAL (o gate teria lido e algo atravessou), não o ESTRUTURAL (não
  // existe texto para ler). Sem essa distinção a flag nasceria vermelha pelos 21 PNG/ICO do artefato e
  // seria removida do alvo na primeira semana — e gate que ninguém roda não protege publicação nenhuma.
  const naoVarridosAcidentais = naoVarridos.filter((u) => !u.structural);
  const reprovaPorNaoVarrido = opts.falharSeNaoVarrido && naoVarridosAcidentais.length > 0;
  const rel = {
    ok: bloqueiam.length === 0 && !reprovaPorNaoVarrido,
    root,
    today: new Date().toISOString().slice(0, 10),
    totalFiles: total,
    scannedFiles: varridos,
    // O escopo SAI no relatório: um verde sobre um subconjunto não pode ser lido como verde da árvore.
    excludeFrom: excluirCom || null,
    excludedFiles: fora.size,
    trackedOnly: opts.somenteRastreados,
    allowlist: allowlist.caminho,
    allowlistExists: allowlist.existe,
    findings: bloqueiam,
    allowlisted: reconhecidos,
    staleAllowlist: podres,
    outOfScopeAllowlist: foraDeEscopo,
    unscanned: naoVarridos,
    // Contagem separada para o consumidor de CI não ter de reimplementar a régua da flag.
    unscannedAccidental: naoVarridosAcidentais.length,
    failOnUnscanned: opts.falharSeNaoVarrido,
  };
  if (opts.json) process.stdout.write(JSON.stringify(rel, null, 2) + '\n');
  else imprimeTexto(rel);
  return rel.ok ? 0 : 2;
}

function chamadoComoScript() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (chamadoComoScript()) {
  let code;
  try {
    code = main(process.argv.slice(2));
  } catch (err) {
    // fail-CLOSED em qualquer erro: erro de uso, allowlist ilegível, contrato do scanner mudado — nada
    // disso pode virar exit 0, porque o consumidor deste código é um `&&` antes de um push público.
    process.stderr.write(`\n✗ [scan-snapshot-secrets] ${err instanceof ErroDeUso ? err.message : (err?.stack ?? err)}\n\n`);
    code = 1;
  }
  process.exit(code);
}
