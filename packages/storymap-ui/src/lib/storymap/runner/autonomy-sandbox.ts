// A POSTURA DE AUTONOMIA de um spawn: como o tier `full` compra Bash headless SEM comprar
// "nenhuma checagem". (F0 do plano multi-target — docs/plans/agileharness-oss/09; vereditos em ADR-067.)
//
// ── O QUE ISTO SUBSTITUI ────────────────────────────────────────────────────────────────────────────
// O tier `full` emitia `--dangerously-skip-permissions` e, como o serviço roda como root, o engine ainda
// injetava `IS_SANDBOX=1` para furar a trava do próprio CLI. O comentário que acompanhava a injeção já
// dizia a verdade em voz alta: aquilo NÃO É UM SANDBOX — o único efeito era PERMITIR a flag como root.
// Ou seja, autonomia comprada desligando a checagem, com um nome que sugeria contenção.
//
// A troca disponível desde 2026 é comprar autonomia com ISOLAMENTO em vez de com desligamento:
// `sandbox.autoAllowBashIfSandboxed` devolve exatamente o Bash não-interativo que era o único motivo
// de a flag perigosa existir, só que dentro de uma fronteira imposta pelo SO (bubblewrap no Linux,
// Seatbelt no macOS) que sobrevive ao agente decidir ignorá-la.
//
// ── A DEGRADAÇÃO INVERTE DE SINAL ───────────────────────────────────────────────────────────────────
// Antes: sandbox indisponível ⇒ roda com bypass (fail-OPEN, e ninguém percebia).
// Agora: `required` ⇒ NÃO spawna · `preferred` ⇒ rebaixa para `write` com aviso ALTO · `off` ⇒ NÃO usa
// sandbox e por isso também rebaixa (sem shell).
// ⚠ `off` NÃO devolve a postura legada — uma revisão pegou este comentário prometendo isso. A postura
// legada (shell irrestrito) é alcançável APENAS por `AGILEHARNESS_ALLOW_UNSANDBOXED_FULL=1`, e é assim de
// propósito: um env chamado "off" que reativasse autonomia sem contenção seria uma armadilha para o
// operador cujo run está falhando e que lê "off" como "desligar essa novidade".
// Um rebaixamento silencioso seria auto-negação de serviço que nenhum teste reclama, então ele é ruidoso.
//
// ── POR QUE ARQUIVO, E NÃO JSON INLINE ──────────────────────────────────────────────────────────────
// `quoteArg` (engine.ts) envolve em ASPAS DUPLAS e declara não neutralizar `$`/crase. Um JSON inline —
// que é feito de aspas duplas — quebraria o comando inteiro. O settings viaja como CAMINHO de arquivo,
// que passa pelo regex de token seguro sem citação. Também é mais depurável: o arquivo fica no disco.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { boardsDir, findRepoRoot, runnerStateDir } from "@/lib/storymap/paths";
import type { AutonomyTier } from "@/lib/storymap/types";

/** O env que ESTE módulo consome — só as chaves que ele lê, não o `ProcessEnv` inteiro. Pedir menos torna
 *  a função testável sem fabricar um ambiente completo, e documenta a superfície real de configuração. */
export type EnvLike = Record<string, string | undefined>;

/**
 * `required` = sem sandbox o run NÃO roda · `preferred` = sem sandbox rebaixa para `write` · `off` = não
 * usa sandbox, e portanto TAMBÉM rebaixa (não é "volta ao comportamento antigo" — para isso existe
 * `AGILEHARNESS_ALLOW_UNSANDBOXED_FULL`, que é explícito sobre o que concede).
 */
export type SandboxMode = "required" | "preferred" | "off";

export const DEFAULT_SANDBOX_MODE: SandboxMode = "preferred";

/**
 * Domínios que um run precisa alcançar para EXISTIR. Deliberadamente mínimo: o resto é declarado.
 *
 * ⚠ O QUE ISTO CUSTA, medido (ADR-067 §Sonda E): dentro do sandbox, `git ls-remote https://github.com/...`
 * sai 128 com `CONNECT tunnel failed, response 403`. Ou seja, um run contido NÃO alcança github.com, o
 * registry do npm, `gh`, WebFetch/WebSearch nem API alguma. Para muitos boards isso é exatamente o
 * desejado; para outros é o run inteiro falhando com um erro de rede que não menciona sandbox. Por isso
 * existe {@link resolveAllowedDomains} — sem uma alavanca, a única saída seria desligar TODA a contenção,
 * e contenção tudo-ou-nada empurra o operador para o "nada".
 */
export const DEFAULT_ALLOWED_DOMAINS = ["api.anthropic.com", "statsig.anthropic.com"] as const;

/**
 * A allowlist EFETIVA: os defaults MAIS o que o operador declarou. Sempre ESTENDE, nunca substitui —
 * a mesma disciplina de `AGILEHARNESS_DEPLOY_LAUNCHERS`. Substituir permitiria um typo tirar
 * `api.anthropic.com` da lista e transformar "abri o egresso para o meu registry" em "nenhum run
 * consegue mais falar com a API", que é um modo de falha muito pior do que o que se queria resolver.
 *
 * Entradas vazias são descartadas e a saída é deduplicada, para um `,,foo,` acidental não virar erro.
 */

export function resolveAllowedDomains(env: EnvLike): string[] {
  const extra = (env.AGILEHARNESS_SANDBOX_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  return [...new Set([...DEFAULT_ALLOWED_DOMAINS, ...extra])];
}

/**
 * Credenciais que um run NUNCA precisa ler. A leitura é permitida por default no sandbox, então esta
 * negação é explícita — não herdada.
 *
 * ⚠ AS DO PRÓPRIO PRODUTO ESTAVAM FALTANDO, e uma revisão pegou: a lista nomeava as credenciais do
 * SISTEMA (`~/.ssh`, `~/.aws`, …) e esquecia as do harness — o `auth-token` (o que a tela de login
 * pede), o `session-secret` (com que os cookies são assinados) e o `mcp-handles.json`. Proteger a chave
 * de terceiros e deixar a própria exposta é a definição de perímetro mal desenhado.
 *
 * ⚠ E A PRIMEIRA CORREÇÃO FOI INSUFICIENTE, o que vale registrar: ela emitia esses caminhos em
 * `credentials.files: mode "deny"` — semântica de LEITURA — enquanto o `writeRoot` dos runs não-code era
 * `storymap/`, que CONTÉM o state dir. A ESCRITA seguia concedida, inclusive sobre o diretório `sandbox/`
 * onde ficam os settings que definem a contenção dos runs CONCORRENTES. A correção real não foi somar
 * mais uma negação: foi ESTREITAR o envelope para `storymap/boards/` (engine.ts), tirando o state dir de
 * dentro do envelope de **BASH**. ⚠ O `Write` NATIVO dessas cinco skills continua escopado ao `cwd` (a
 * raiz do repositório) pela camada de permissão, então ele ainda alcança o state dir — o fecho completo
 * é dar worktree ao tier full não-code, e isso é F1. Esta lista de negação de LEITURA continua valendo
 * como defesa em profundidade, e é o que há hoje para o caminho nativo.
 */
/** Uma negação de leitura e o que se SABE sobre ela nesta classe de host. */
export interface CaminhoNegado {
  readonly path: string;
  /** true ⇒ pode legitimamente não existir no momento do wrap. O CLI DESCARTA caminhos de deny-read
   *  inexistentes EM SILÊNCIO (medido no binário: `Skipping non-existent read deny path`), então uma
   *  entrada assim parece proteção e mede zero. Exige `motivo`. */
  readonly podeFaltar?: boolean;
  /** POR QUE a ausência é aceitável. Sem isto a entrada não passa na checagem de forma. */
  readonly motivo?: string;
}

/**
 * A TABELA — e ela substituiu uma lista de strings por um motivo que só apareceu ao ser medido.
 *
 * O QUE FOI MEDIDO (2026-08-12, neste host, HOME=/root): das 6 negações emitidas, **2 não existem** —
 * `~/.aws` e `~/.gnupg`. Elas nunca existiram: são a lista genérica de "credenciais de sistema", e as
 * duas que ENTRARAM POR MEDIÇÃO (`~/.config/gcloud`, `~/.config/configstore`) chegaram depois, com
 * data e modo no comentário. A metade que veio de memória e a que veio de medição são distinguíveis
 * pelo que está escrito ao lado delas — e era só isso que as distinguia.
 *
 * POR QUE ISSO IMPORTA MAIS QUE PARECE: o CLI descarta um caminho inexistente em SILÊNCIO. Três
 * camadas acima anunciam proteção; a mensagem do portão promete ao operador "as chaves de acesso do
 * host e as credenciais que publicam em produção", e a frase é verdade para 4 de 6 sem distinguir.
 * A decisão de manter as duas é DEFENSÁVEL (o dia em que existirem é o dia em que passam a valer, e
 * o custo é zero) — o defeito era ela viver em PROSA, onde nada a confere, enquanto a lista ao lado
 * dizia outra coisa.
 *
 * Agora a ausência é DADO: `podeFaltar` + `motivo`, e uma entrada nova nascida morta REPROVA.
 *
 * Negar o DIRETÓRIO, não o arquivo, continua sendo a regra: não há aqui o equivalente do
 * `findFirstNonExistentComponent` que o denyWRITE usa para bloquear a CRIAÇÃO, então negar o
 * diretório existente cobre o arquivo que nascer depois.
 */
export const DENY_READ_TABELA: readonly CaminhoNegado[] = [
  // Medido em 2026-08-23 no runner ubuntu-latest do GitHub: o `.ssh` sob o home do usuário do job
  // NÃO existe. (O caminho literal fica AQUI e não no `motivo`: `host-tools.test.ts` proíbe endereço
  // de home em linha de código, e uma string de runtime é linha de código — o filtro dele isenta
  // comentário, que é exatamente o lugar de uma medição.)
  {
    path: "~/.ssh",
    podeFaltar: true,
    motivo:
      "host sem chave SSH — runner efêmero de CI, contêiner, imagem recém-provisionada. Onde o " +
      "diretório não existe não há chave a proteger, e o CLI descartaria a entrada de qualquer " +
      "forma; onde ele existe (a estação de quem desenvolve) a negação entra viva.",
  },
  {
    path: "~/.aws",
    podeFaltar: true,
    motivo: "AWS CLI não instalado nesta classe de host (medido ausente em 2026-08-12); entra vivo no dia em que for.",
  },
  {
    path: "~/.gnupg",
    podeFaltar: true,
    motivo: "gpg sem keyring nesta classe de host (medido ausente em 2026-08-12); entra vivo no dia em que for.",
  },
  {
    path: "~/.claude/.credentials.json",
    podeFaltar: true,
    motivo: "ausente quando o CLI autentica por ANTHROPIC_API_KEY em vez de login — e aí não há o que proteger.",
  },
  // ── As credenciais que PUBLICAM EM PRODUÇÃO, e que a lista original não cobria ─────────────────
  // Medido em 2026-08-05 neste host: `~/.config/gcloud/access_tokens.db` (600) e
  // `~/.config/configstore/firebase-tools.json` (600) EXISTEM e eram legíveis por qualquer run de código.
  // E medido em 2026-08-23 no runner ubuntu-latest: lá o `.config/gcloud` sob o home do job NÃO
  // existe. As duas medições convivem — a de cima é por que a negação nasceu, esta é por que ela
  // pode faltar sem que isso seja defeito.
  {
    path: "~/.config/gcloud",
    podeFaltar: true,
    motivo:
      "gcloud não instalado nesta classe de host. Onde ele ESTÁ instalado (medido nesta máquina em " +
      "2026-08-05: o access_tokens.db existe, modo 600, e era legível por qualquer run de código) a " +
      "negação é load-bearing e entra viva; onde não está, não há token a proteger.",
  },
  { path: "~/.config/configstore" },
] as const;

/** A lista EMITIDA — derivada da tabela, para o portão e o call-site não precisarem mudar. */
export const DEFAULT_DENY_READ: readonly string[] = DENY_READ_TABELA.map((e) => e.path);

/**
 * PURA: os problemas da tabela contra um disco. `[]` ⇒ consistente.
 *
 * Recebe `existe` e `home` por parâmetro para que o PAR de prova possa falhar sem depender do host —
 * um teste que só rodasse contra o disco real desta máquina não conseguiria demonstrar a reprovação.
 */
export function problemasDeNegacao(
  tabela: readonly CaminhoNegado[],
  existe: (p: string) => boolean,
  home: string,
): string[] {
  const problemas: string[] = [];
  for (const e of tabela) {
    const abs = e.path.startsWith("~/") ? home + e.path.slice(1) : e.path;
    if (e.podeFaltar) {
      if (!e.motivo?.trim())
        problemas.push(
          `"${e.path}" é podeFaltar sem motivo. Escreva POR QUE a ausência é aceitável — uma negação ` +
            `descartada em silêncio pelo CLI parece proteção e mede zero.`,
        );
      continue;
    }
    if (!existe(abs))
      problemas.push(
        `"${e.path}" (→ ${abs}) NÃO EXISTE e não está declarado podeFaltar. O CLI DESCARTA caminhos de ` +
          `deny-read inexistentes em silêncio ("Skipping non-existent read deny path"), então esta entrada ` +
          `não protege nada. CONSERTE assim: (1) se o caminho mudou de nome, corrija-o; (2) se ele pode ` +
          `legitimamente faltar nesta classe de host, marque podeFaltar:true E escreva o motivo medido; ` +
          `(3) se o alvo real é um arquivo que nasce depois, negue o DIRETÓRIO que já existe.`,
      );
  }
  return problemas;
}

/**
 * Os NOMES dos arquivos de credencial do harness, dentro do state dir.
 *
 * ⚠ Só os nomes: o DIRETÓRIO vem de `runnerStateDir()`, que honra `STORYMAP_RUNNER_STATE_DIR` — um knob
 * documentado no `.env.example` e usado pelo próprio setup de teste. A primeira versão desta lista
 * concatenava o literal `storymap/.runner/...` à raiz, e uma revisão pegou: com o env declarado, a
 * negação apontava para arquivos inexistentes enquanto as credenciais reais viviam em outro lugar —
 * uma defesa que parece ativa e mede zero, que é a classe que este módulo inteiro existe para eliminar.
 */
export const HARNESS_CREDENTIAL_FILES = ["auth-token", "session-secret", "mcp-handles.json"] as const;

/** Os caminhos ABSOLUTOS a negar, resolvidos a partir do state dir REAL. */
export function harnessCredentialPaths(stateDir: string): string[] {
  return HARNESS_CREDENTIAL_FILES.map((f) => path.join(stateDir, f));
}

/**
 * A ESCOLHA DE ENVELOPE de um spawn — pura, e por isso testável.
 *
 * ── POR QUE EXISTE ─────────────────────────────────────────────────────────────────────────────────
 * As duas decisões de perímetro mais delicadas da fase viviam INLINE nos call-sites (um ternário no
 * engine, um literal no `run_task`), cobertas apenas por lint de regex sobre a fonte — a mesma técnica
 * que este arquivo documenta como insuficiente. Um revisor mediu o custo: trocar `boardsDir()` por
 * `cwd` no engine passava em 2757 de 2757 testes; zerar o `denyWrite` do `run_task` passava em 125 de
 * 125. As correções que a fase anunciava como as mais graves regrediam em silêncio.
 *
 * Trazer a decisão para uma função pura é o que transforma "o call-site está escrito assim hoje" em
 * uma propriedade que a suíte defende.
 *
 * As regras, e o porquê de cada uma:
 *  - run de CÓDIGO ⇒ o envelope é o `cwd` (o worktree do run, quando há isolamento);
 *  - run NÃO-CODE ⇒ o `cwd` é a raiz do repositório (não recebe worktree), então o envelope estreita
 *    para a árvore de dados do board — tudo o que essas skills legitimamente escrevem;
 *  - em qualquer caso, o state dir é RECORTADO: ele guarda credenciais do harness e os settings que
 *    definem a contenção dos runs CONCORRENTES. Um run que reescreve a cerca de outro run é a
 *    escalação que a fase inteira existe para cortar.
 */
export function envelopeForSpawn(input: {
  isCode: boolean;
  /** O cwd do spawn — raiz de projeto de onde o CLI lê settings. */
  cwd: string;
  /**
   * A árvore de dados do board. **Opcional de propósito**: em produção NINGUÉM passa, e a função
   * resolve sozinha por `boardsDir()`.
   *
   * ⚠ Ela era obrigatória, e um revisor mostrou o custo: a extração para função pura guardou o CORPO da
   * decisão e deixou os ARGUMENTOS do call-site sob regex. Trocar `boardDataDir: boardsDir()` por
   * `boardDataDir: cwd` no engine passava em **7167 de 7167** provas, porque o único guarda era
   * `expect(src).toMatch(/\.\.\.envelopeForSpawn\(\{/)`. Um argumento que o call-site não fornece é um
   * argumento que ele não pode errar — a mesma lição de "torne o estado inválido inconstruível" que já
   * fez `trigger` virar obrigatório aqui do lado.
   *
   * Continua injetável porque o TESTE precisa: é o parâmetro que deixa a função pura.
   */
  boardDataDir?: string;
  /** A raiz do state dir do harness. Mesma regra do `boardDataDir`: em produção ninguém passa. */
  stateDir?: string;
}): { projectRoot: string; writeRoot: string; denyWrite: string[] } {
  // Resolvidos AQUI quando o chamador não fornece — ver a nota em `boardDataDir`. O call-site de
  // produção passa só o que ele sabe e a função não sabe: `isCode` e `cwd`.
  const boardDataDir = input.boardDataDir ?? boardsDir();
  const stateDir = input.stateDir ?? runnerStateDir();
  const writeRoot = input.isCode ? input.cwd : boardDataDir;
  // Só recorta se o state dir estiver DENTRO do envelope — um denyWrite fora dele é ruído que sugere
  // proteção onde não havia risco.
  const dentro = stateDir === writeRoot || stateDir.startsWith(writeRoot + path.sep);
  return { projectRoot: input.cwd, writeRoot, denyWrite: dentro ? [stateDir] : [] };
}

export interface SandboxSupport {
  available: boolean;
  /** `bubblewrap` | `seatbelt` | `none` — o que efetivamente aplicaria a fronteira. */
  mechanism: "bubblewrap" | "seatbelt" | "none";
  /**
   * MEDIDO, não configurado: este host restringe `setgroups` dentro de um user namespace novo, e por
   * isso o passo de seccomp do CLI não sobe com um `/proc` fresco. Quando true, o settings precisa de
   * `enableWeakerNestedSandbox`. Derivar isto de uma sonda — em vez de exigir um env que vive FORA do
   * repositório — é o que faz o default funcionar na máquina de quem instala, e não só na nossa.
   */
  requiresWeakerNested: boolean;
  /** Legível por humano; entra no aviso e no relatório de prontidão. */
  reason: string;
  /** Dependências ausentes, nomeadas (o operador precisa saber o que instalar). */
  missing: string[];
  /** Como a decisão foi tomada — auditoria: `sonda` vale mais que `presenca-de-binario`. */
  /**
   * COMO se chegou a `available` — e o campo existe justamente para distinguir medição de presunção.
   *
   * `presenca-de-binario` nasceu em 2026-08-05 de um achado: o ramo Darwin carimbava `"sonda"` sem
   * executar sonda alguma (media-se `hasBin("sandbox-exec")` e pronto), e o único guarda do rótulo era
   * um teste que o AFIRMAVA — o antipadrão que este módulo existe para matar, reintroduzido dentro da
   * correção dele. O conserto não foi apagar o suporte a macOS (custo de portabilidade num projeto que
   * vai ser aberto, ganho de segurança ZERO): foi parar de mentir sobre o método.
   */
  method: "sonda" | "presenca-de-binario" | "binario-ausente" | "plataforma" | "override";
}

/** O resultado cru de executar um comando de sonda. Injetável — o teste não toca no host. */
export interface ProbeResult {
  ok: boolean;
  stderr: string;
}

/**
 * A SONDA FUNCIONAL. Executa a operação exata que falha neste host quando o sandbox do CLI não sobe:
 * criar um user namespace com `/proc` novo e escrever em `/proc/self/setgroups`. Medido em 2026-08-03:
 * aqui ela falha com `I/O error`, e é exatamente onde o CLI morre com
 * `apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted)`.
 *
 * POR QUE UMA SONDA E NÃO `existsSync`: a versão anterior decidia disponibilidade por presença de
 * binário no PATH. Nesta caixa os dois binários existem E o sandbox não subia — então `available` era
 * sempre `true`, a degradação "que inverte de sinal" nunca disparava, e o modo `required` nunca recusava
 * nada. Uma detecção que não consegue devolver `false` não é uma detecção.
 */
/** A sonda mais básica: este kernel deixa criar um user namespace? Se não, não existe contenção aqui. */
export const NAMESPACE_PROBE = ["bwrap", "--unshare-user", "--dev-bind", "/", "/", "true"] as const;

export const SETGROUPS_PROBE = [
  "bwrap",
  "--unshare-user",
  "--unshare-pid",
  "--proc",
  "/proc",
  "--dev-bind",
  "/",
  "/",
  "sh",
  "-c",
  "echo deny > /proc/self/setgroups",
] as const;

/** Um binário está no PATH? Memoizado — a detecção roda por spawn e não pode virar um stat por run.
 *  Deliberadamente sem `which`/shell: um spawn a mais por consulta é custo puro. */
const binCache = new Map<string, boolean>();
export function hasExecutable(bin: string, env: EnvLike = process.env): boolean {
  const cached = binCache.get(bin);
  if (cached !== undefined) return cached;
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const found = dirs.some((d) => existsSync(path.join(d, bin)));
  binCache.set(bin, found);
  return found;
}

/** Test-only: rearma o cache de binários. */
export function resetExecutableCache(): void {
  binCache.clear();
}

/** Detecção com deps INJETADAS — o teste controla plataforma, binários e o resultado da sonda. */
export function detectSandboxSupport(deps: {
  platform: NodeJS.Platform;
  hasBin: (bin: string) => boolean;
  /** Executa {@link SETGROUPS_PROBE}. Ausente ⇒ a sonda não roda e o host é tratado como restrito
   *  (fail-SAFE: assumir que precisa do modo weaker degrada a contenção, nunca o funcionamento). */
  runProbe?: () => ProbeResult;
  /** Executa {@link NAMESPACE_PROBE} — "dá para criar user namespace?". Falhou ⇒ NÃO HÁ sandbox. */
  runNamespaceProbe?: () => ProbeResult;
}): SandboxSupport {
  if (deps.platform === "darwin") {
    // ── SONDA, NÃO STRING DE PLATAFORMA (achado de revisão) ─────────────────────────────────────────
    // A versão anterior devolvia `available: true` INCONDICIONALMENTE no Darwin, com `method:
    // "plataforma"`. Consequências que um revisor mediu na leitura: não havia caminho pelo qual
    // `AGILEHARNESS_SANDBOX_MODE=required` pudesse recusar num Mac, e o teste inclusive FIXAVA esse
    // retorno passando `hasBin: noBins` — ou seja, a suíte cimentava a asserção sem prova.
    //
    // "macOS tem Seatbelt" é verdade sobre o SISTEMA e não sobre a INSTALAÇÃO: o binário que o CLI usa
    // (`sandbox-exec`) pode não estar no PATH, e o mesmo caminho de degradação que existe no Linux tem
    // de existir aqui, senão o Mac é o host onde a fase promete contenção sem nunca a verificar. Este é
    // exatamente o "vácuo-verde" que o módulo inteiro existe para eliminar, aplicado à detecção.
    const temSandboxExec = deps.hasBin("sandbox-exec");
    return {
      available: temSandboxExec,
      mechanism: temSandboxExec ? "seatbelt" : "none",
      requiresWeakerNested: false,
      reason: temSandboxExec
        ? "Seatbelt (sandbox-exec presente)"
        : "macOS sem sandbox-exec no PATH — o CLI não consegue montar o Seatbelt",
      missing: temSandboxExec ? [] : ["sandbox-exec"],
      // ⚠ NÃO é "sonda", e a diferença é o achado da 13ª revisão. Aqui NENHUMA sonda roda: mede-se a
      // presença do binário e presume-se que o Seatbelt sobe. Um revisor injetou sondas que FALHAM e
      // contou zero chamadas, com o retorno ainda dizendo `method: "sonda"`. Enquanto não houver a
      // sonda de verdade — `sandbox-exec -p '(version 1)(deny default)' /usr/bin/true`, que distingue
      // "o binário existe" de "o Seatbelt monta" —, o rótulo honesto é este, e ele é o que faz
      // `AGILEHARNESS_SANDBOX_MODE=required` poder um dia recusar num Mac por falta de MEDIÇÃO.
      method: temSandboxExec ? "presenca-de-binario" : "binario-ausente",
    };
  }
  if (deps.platform === "win32") {
    return {
      available: false,
      mechanism: "none",
      requiresWeakerNested: false,
      reason: "Windows nativo não suporta o sandbox; use WSL2",
      missing: [],
      method: "plataforma",
    };
  }
  // Linux: bubblewrap aplica o isolamento de filesystem; socat faz o relay do proxy de rede.
  const missing = ["bwrap", "socat"].filter((b) => !deps.hasBin(b));
  if (missing.length > 0) {
    return {
      available: false,
      mechanism: "none",
      requiresWeakerNested: false,
      reason: `faltam dependências do sandbox: ${missing.join(", ")} (instale com o gerenciador da distro)`,
      missing,
      method: "binario-ausente",
    };
  }

  // Os binários existem — mas isso NÃO prova que o sandbox sobe. As sondas provam, e são DUAS porque há
  // dois desfechos materialmente diferentes (defeito corrigido após revisão: a versão anterior tratava
  // qualquer falha como "só precisa do modo weaker", e por isso `available` nunca podia ser false num
  // Linux com os binários instalados — um detector incapaz de detectar):
  //   1. o kernel não deixa criar user namespace NENHUM  ⇒ não há sandbox  ⇒ available:false
  //   2. cria o namespace, mas `/proc` novo + setgroups é restrito ⇒ há sandbox em modo weaker
  const nsProbe = deps.runNamespaceProbe?.();
  if (nsProbe && !nsProbe.ok) {
    return {
      available: false,
      mechanism: "none",
      requiresWeakerNested: false,
      reason:
        `bubblewrap presente mas o kernel recusa criar user namespace ` +
        `(${nsProbe.stderr.trim().slice(0, 120) || "sonda de namespace falhou"}) — não há sandbox neste host`,
      missing: [],
      method: "sonda",
    };
  }
  const probe = deps.runProbe?.();
  if (!probe) {
    return {
      available: true,
      mechanism: "bubblewrap",
      requiresWeakerNested: true,
      reason: "sonda de userns não executada — assumindo host restrito (modo weaker)",
      missing: [],
      method: "sonda",
    };
  }
  if (probe.ok) {
    return {
      available: true,
      mechanism: "bubblewrap",
      requiresWeakerNested: false,
      reason: "bubblewrap + socat presentes; userns com /proc novo funciona (sonda ok)",
      missing: [],
      method: "sonda",
    };
  }
  // A sonda falhou. Isto NÃO é "sem sandbox": é "sem /proc fresco". O CLI sobe com o modo weaker.
  return {
    available: true,
    mechanism: "bubblewrap",
    requiresWeakerNested: true,
    reason:
      `userns com /proc novo é restrito neste host (${probe.stderr.trim().slice(0, 120) || "sonda falhou"}) — ` +
      `o sandbox sobe em modo weaker, que bind-monta o /proc existente e expõe informação de processo`,
    missing: [],
    method: "sonda",
  };
}

/** A execução REAL da sonda (memoizada por processo — o custo é de milissegundos, mas por run seria puro
 *  desperdício). Isolada aqui para `detectSandboxSupport` continuar pura e testável sem host. */
const probeCache = new Map<string, ProbeResult>();
function runProbeCmd(cmd: readonly string[]): ProbeResult {
  const key = cmd.join(" ");
  const hit = probeCache.get(key);
  if (hit) return hit;
  let out: ProbeResult;
  try {
    const r = spawnSync(cmd[0], cmd.slice(1) as string[], { timeout: 5000, encoding: "utf8" });
    out = { ok: r.status === 0, stderr: `${r.stderr ?? ""}${r.stdout ?? ""}` };
  } catch (err) {
    out = { ok: false, stderr: err instanceof Error ? err.message : String(err) };
  }
  probeCache.set(key, out);
  return out;
}

export const runSetgroupsProbe = (): ProbeResult => runProbeCmd(SETGROUPS_PROBE);
export const runNamespaceProbe = (): ProbeResult => runProbeCmd(NAMESPACE_PROBE);

/** Test-only: rearma a memoização das sondas. */
export function resetSandboxProbeCache(): void {
  probeCache.clear();
}

export function resolveSandboxMode(env: EnvLike): SandboxMode {
  const raw = env.AGILEHARNESS_SANDBOX_MODE?.trim().toLowerCase();
  if (raw === "required" || raw === "preferred" || raw === "off") return raw;
  // ── VALOR PRESENTE E NÃO RECONHECIDO NÃO PODE PASSAR CALADO (achado de revisão) ──────────────────
  // Medido: `AGILEHARNESS_SANDBOX_MODE=require` (sem o "d") e `=requried` caíam em `preferred` em
  // silêncio. O operador que quis EXIGIR contenção acabava com um harness que a dispensa — e nada no
  // log dizia. É a mesma classe de "declarado e inerte" que este módulo persegue, entrando pela porta
  // do próprio knob que a fase introduziu.
  //
  // Ausente/vazio continua sendo o default silencioso: quem não declarou não errou. O que grita é o
  // valor PRESENTE que não existe. Não lança, porque um typo aqui não pode derrubar o serviço no boot
  // — mas o modo escolhido é o mais restritivo entre os dois plausíveis, e o aviso nomeia os aceitos.
  if (raw !== undefined && raw !== "") {
    console.error(
      `[autonomy] AGILEHARNESS_SANDBOX_MODE="${raw}" não é um valor reconhecido. ` +
        `Aceitos: required | preferred | off. Assumindo "${DEFAULT_SANDBOX_MODE}" — se você quis EXIGIR ` +
        `contenção, o harness NÃO está exigindo.`,
    );
  }
  return DEFAULT_SANDBOX_MODE;
}

/**
 * `enableWeakerNestedSandbox` — necessário onde o passo de seccomp não consegue criar userns aninhado
 * (medido neste host: `apply-seccomp: write /proc/self/setgroups ... CAP_SYS_ADMIN`, ADR-067). Ele
 * bind-monta o `/proc` existente em vez de um novo, o que expõe informação de processo — a documentação
 * diz que enfraquece consideravelmente.
 *
 * ⚠ ESTE COMENTÁRIO MENTIA DUAS VEZES, e as duas foram medidas por uma revisão independente:
 *
 *   · dizia "é opt-in por env, NUNCA default" — e a linha logo abaixo faz o CONTRÁRIO. Sem env nenhum,
 *     `resolveWeakerNested({}, measured)` devolve o valor da SONDA, e neste host a sonda de setgroups
 *     falha (`echo: I/O error`) ⇒ `true`. Ou seja: ele é exatamente o default na instalação de
 *     referência. O env é um OVERRIDE (`0` desliga, `1` liga), não a origem.
 *   · dizia que "o `doctor` reporta quando está ligado" — não existe doctor no projeto
 *     (`grep -rn -i doctor src/ scripts/` só achava esta linha). O próprio ADR-067 diz que ele está
 *     previsto para F2 e ainda não existe.
 *
 * Um comentário que promete auditoria inexistente é pior que a ausência dele, porque quem lê para de
 * procurar. Hoje o único relato é o aviso do engine no log do run, e o SECURITY.md diz isso e diz o que
 * a troca custa — que é o que uma limitação nomeada precisa ter para ser auditável.
 */
export function resolveWeakerNested(env: EnvLike, measured: boolean): boolean {
  const raw = env.AGILEHARNESS_SANDBOX_WEAKER_NESTED?.trim();
  if (raw === "1") return true;
  if (raw === "0") return false;
  return measured; // o default é o que a SONDA mediu neste host, não um palpite
}

/** A válvula de escape. Feia de propósito: é a coisa que nunca se liga em host compartilhado. */
export function unsandboxedFullAllowed(env: EnvLike): boolean {
  return env.AGILEHARNESS_ALLOW_UNSANDBOXED_FULL === "1";
}

export interface SandboxSettingsOpts {
  /**
   * A árvore de trabalho do run, ACRESCENTADA ao conjunto de escrita do sandbox.
   *
   * ⚠ NÃO é "a única": o schema do próprio CLI descreve `filesystem.allowWrite` como *"Additional paths
   * to allow writing within the sandbox — merged with paths from Edit(...) allow permission rules"*, e o
   * conjunto efetivo em execução inclui ainda o `$TMPDIR` da sessão e o gitdir resolvido de um worktree
   * linkado (necessário para `git commit` funcionar). Escrever "única" aqui seria a mesma classe de
   * mentira que esta fase existe para remover: o envelope real é maior que o declarado.
   */
  writeRoot: string;
  allowedDomains?: readonly string[];
  denyRead?: readonly string[];
  /**
   * Onde as CREDENCIAIS do harness vivem — a raiz do state dir (`runnerStateDir()`).
   *
   * ⚠ NÃO é o diretório onde o arquivo de settings é escrito, e confundir os dois já custou uma
   * revisão: os call-sites passavam `path.join(runnerStateDir(), "sandbox")` (o subdiretório do
   * settings) e a negação virava `.runner/sandbox/auth-token` — um caminho que não existe. A defesa
   * ficava sintaticamente presente e semanticamente zero, que é a classe exata que este módulo
   * persegue. Nomes diferentes para conceitos diferentes é o que impede a próxima confusão.
   */
  credentialsDir?: string;
  /**
   * Caminhos a RECORTAR de dentro do `allowWrite` — a chave `filesystem.denyWrite` do CLI (real e
   * implementada: o sandbox Linux dela emite bind mounts, verificável no binário). Serve para o caso em
   * que a árvore concedida contém algo que o run nunca deve reescrever, e estreitar o `allowWrite` não
   * é possível — o exemplo vivo é o state dir dentro do writeRoot do `run_task`, que guarda os settings
   * de contenção dos runs CONCORRENTES.
   */
  denyWrite?: readonly string[];
  weakerNested?: boolean;
}

/** O objeto de settings que o CLI consome. PURO — o teste compara a forma sem tocar em disco. */
export function buildSandboxSettings(opts: SandboxSettingsOpts): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {
    enabled: true,
    // Este é o par exato do que a flag perigosa comprava: Bash não-interativo. A diferença é que aqui
    // ele só é auto-aprovado PORQUE a fronteira do SO o contém.
    autoAllowBashIfSandboxed: true,
    // Sem sandbox, o run não roda — em vez de rodar sem contenção e ninguém saber.
    failIfUnavailable: true,
    // O escape hatch do próprio CLI (`dangerouslyDisableSandbox`) fica DESARMADO: um agente que
    // contorna a fronteira ao primeiro erro não tem fronteira.
    allowUnsandboxedCommands: false,
    network: { allowedDomains: [...(opts.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS)] },
    // ACRESCENTA a árvore do run ao conjunto de escrita (ver a nota em SandboxSettingsOpts.writeRoot).
    filesystem: {
      allowWrite: [opts.writeRoot],
      ...(opts.denyWrite?.length ? { denyWrite: [...opts.denyWrite] } : {}),
      // ── A CHAVE QUE O MÓDULO CONHECIA E NUNCA EMITIA ────────────────────────────────────────────
      // `filesystem.denyRead` já estava declarada em SANDBOX_KEYS_QUE_ESTREITAM como monotônica e
      // legítima — o módulo sabia que ela existe, tratava-a como aceitável vinda do alvo, e nunca a
      // preenchia. Os caminhos de leitura iam TODOS para `credentials.files`, que foi medido vazando
      // 3 de 4 execuções para a ferramenta Read NATIVA (2026-08-05). Isto não é uma camada nova: é um
      // campo em branco que agora carrega a mesma lista.
      //
      // ⚠ ESCOPO HONESTO, e ele importa mais que a chave: `denyRead` e `credentials.files` descem
      // pela MESMA rota (`getFsReadConfig` → `denyOnly`) e viram MOUNT do bwrap, logo contêm o BASH
      // sandboxado — não a ferramenta Read nativa, que roda no processo do CLI. Medido: `denyRead`
      // sozinho vazou 1 de 3. Emitir as duas é defesa em profundidade, NÃO é fronteira. A rotulagem
      // é a do `hermes-agent`, que mantém um denylist equivalente e escreve no próprio docstring
      // "**This is NOT a security boundary**" — porque o terminal roda como o mesmo usuário. O mesmo
      // vale aqui, e dizer o contrário seria a proteção-que-mede-zero que este módulo existe para matar.
      denyRead: [...(opts.denyRead ?? DEFAULT_DENY_READ)],
    },
    credentials: {
      files: [
        ...(opts.denyRead ?? DEFAULT_DENY_READ),
        // As credenciais do PRÓPRIO harness, resolvidas a partir do state dir REAL (que honra
        // STORYMAP_RUNNER_STATE_DIR) — ver a nota em HARNESS_CREDENTIAL_FILES. Ausente ⇒ a lista some,
        // que é o caso dos testes puros de forma.
        ...(opts.credentialsDir ? harnessCredentialPaths(opts.credentialsDir) : []),
      ].map((p) => ({ path: p, mode: "deny" })),
    },
  };
  if (opts.weakerNested) sandbox.enableWeakerNestedSandbox = true;
  return { sandbox };
}

/**
 * Grava o settings e devolve o CAMINHO (ver o cabeçalho: JSON inline quebraria a citação do shell).
 *
 * ⚠ INVARIANTE DE NÃO-INTRUSÃO: `dir` NUNCA pode ser a árvore do alvo. O settings é estado operacional
 * do harness, e estado operacional dentro do repositório do usuário é exatamente o que suja o `git status`
 * dele e acaba num commit. (Escrito depois de eu ter cometido esse erro: a primeira versão usava o
 * worktree do run como diretório e deixou 40+ `sandbox-*.json` rastreados no diff.)
 */
export function writeSandboxSettingsFile(dir: string, settings: Record<string, unknown>, key: string): string {
  const file = path.join(dir, `sandbox-${key.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    pruneOldSettings(dir);
    writeFileSync(file, serializeSandboxSettings(settings), "utf8");
    return file;
  } catch {
    // Diretório de estado indisponível NÃO pode virar "roda sem sandbox" — cai no temp do SO, que é
    // sempre escrevível, em vez de degradar a contenção por um problema de disco.
    const fallback = path.join(os.tmpdir(), `ah-sandbox-${key.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
    writeFileSync(fallback, serializeSandboxSettings(settings), "utf8");
    return fallback;
  }
}

/**
 * A TRADUÇÃO postura → flags do spawn, isolada e PURA.
 *
 * POR QUE ESTA FUNÇÃO EXISTE (achado de revisão, e é o defeito mais caro que a fase teve): antes, a
 * montagem vivia inline no meio de `runSkill`, e um revisor comentou o espalhamento do `postureArgs` no
 * array de flags — o arquivo de settings continuava sendo construído, escrito em disco e LOGADO, mas
 * nunca chegava ao CLI. **2704 testes seguiram verdes.** O run rodaria com zero contenção e o log diria
 * que estava contido: exatamente a classe "isolamento declarado e inerte" que este módulo existe para
 * eliminar. Extraída, a propriedade vira asserção — e a mutação morre.
 */
export function buildSpawnFlags(input: {
  posture: AutonomyPosture;
  permissionArgs: readonly string[];
  streamFlags?: readonly string[];
  policyArgs?: readonly string[];
  extraArgs?: readonly string[];
}): { flags: string[]; needsRootBypass: boolean } {
  const postureArgs: string[] = [];
  let needsRootBypass = false;
  if (input.posture.kind === "sandboxed") {
    postureArgs.push("--settings", input.posture.settingsFile);
  } else if (input.posture.kind === "unsandboxed-escape") {
    postureArgs.push("--dangerously-skip-permissions");
    needsRootBypass = true;
  } else if (input.posture.kind === "downgraded") {
    // ── O REBAIXAMENTO PRECISA COMPRAR O QUE ANUNCIA (achado de revisão) ──────────────────────────
    // Antes, "rebaixar full → write" era só uma linha de log: `TIER_PERMISSION_ARGS.full` e `.write`
    // são o MESMO array, então o argv do run rebaixado era byte-idêntico ao do full menos o
    // `--settings`. O aviso dizia ao operador "o run NÃO terá shell; passos que dependem de Bash vão
    // falhar" — e era falso.
    //
    // Pior que falso: com `acceptEdits` e SEM sandbox, o `permissions.allow` do próprio alvo passa a
    // valer (a Sonda E mostrou que num caminho confiado essas entradas são honradas). O
    // `.claude/settings.json` rastreado deste repositório libera `Bash(bun *)`, `Bash(node -e *)`,
    // `Bash(gcloud *)`; o `settings.local.json`, `Bash(node *)`, `Bash(git *)`, `Bash(claude *)`. Ou
    // seja: o caminho de DEGRADAÇÃO — que é o default em qualquer host sem bwrap, a maioria dos alvos
    // que o objetivo OSS quer atender — entregava execução arbitrária como root, sem contenção,
    // anunciando o contrário. É exatamente a classe "contenção declarada e inerte" que esta fase existe
    // para eliminar, cometida dentro da própria fase.
    //
    // `--disallowedTools Bash` NEGA a ferramenta no nível do CLI, acima de qualquer `permissions.allow`
    // do alvo. O rebaixamento passa a ser uma perda de capacidade real, que é o que o aviso promete.
    postureArgs.push("--disallowedTools", "Bash");
  }
  return {
    flags: [
      ...input.permissionArgs,
      ...postureArgs,
      ...(input.streamFlags ?? []),
      ...(input.policyArgs ?? []),
      ...(input.extraArgs ?? []),
    ],
    needsRootBypass,
  };
}

/**
 * O ÚLTIMO PORTÃO: a contenção prometida está no COMANDO que vai ser executado?
 *
 * ── POR QUE ISTO NÃO É UM TESTE ─────────────────────────────────────────────────────────────────────
 * `buildSpawnFlags` é pura e testada, e mesmo assim um revisor matou a fase duas vezes seguidas com a
 * MESMA mutação, deslocada uma linha por vez: primeiro espalhando `postureArgs` fora do array, depois
 * filtrando `--settings` do retorno (`spawnFlags.flags.filter(f => f !== "--settings")`). Nos dois casos
 * a suíte inteira — 7027 testes — ficou verde, porque os guardas eram regex sobre a FONTE e qualquer
 * chamador que descarte ou transforme o retorno os satisfaz. Entre montar as flags e o comando existir
 * há ~150 linhas e dois `flags.push(...)`; nenhum teste de array cobre esse intervalo.
 *
 * A lição é que a propriedade não pode viver num teste: um teste afirma que o código está certo HOJE.
 * Esta função faz o sistema RECUSAR-SE a operar sem a contenção que ele mesmo acabou de prometer — a
 * mutação deixa de passar despercebida porque deixa de rodar. É a diferença entre detectar e impedir.
 *
 * Roda sobre a STRING FINAL, depois de todo `push` e de `quoteArg`, porque é o último ponto onde ainda
 * se pode saber o que será executado. Custo: duas buscas de substring por spawn.
 */
/**
 * TOKENIZAÇÃO EM VEZ DE REGEX — por que o portão parou de olhar a string crua.
 *
 * ── O DEFEITO MEDIDO ────────────────────────────────────────────────────────────────────────────────
 * A versão anterior juntava o argv por espaço e rodava regex sobre o resultado, sob um comentário que
 * afirmava ser seguro "porque um argumento com espaço no meio não cria nem apaga um --settings". Um
 * revisor mediu e derrubou o comentário pela porta mais barata de todas: o PROMPT é um argumento. Um
 * prompt contendo o texto `--settings` fazia o portão contar dois e ABORTAR; um contendo
 * `--dangerously-skip-permissions` fazia o portão acusar contorno da fronteira. Um portão que reprova
 * pelo ASSUNTO da conversa não é um portão.
 *
 * E o falso positivo é só o lado visível: a mesma confusão entre DADO e SINTAXE produz o falso
 * negativo. Se um dia a checagem virasse "o comando NÃO contém X", bastaria o dado conter X para
 * mascarar a sintaxe — a assimetria é de sorte, não de desenho.
 *
 * ── A CORREÇÃO ──────────────────────────────────────────────────────────────────────────────────────
 * A regra é a que a indústria convergiu para esta classe: **nunca re-analise o que você mesmo
 * construiu**. O `run_task` roda com `execFile` e JÁ TEM o argv — ele passa a ser verificado intacto,
 * sem nunca virar string. O engine roda com `shell:true` e só tem a string final (o portão precisa
 * rodar DEPOIS dos wrappers, senão verifica outra coisa que não a executada) — mas essa string foi
 * montada por `quoteArg`, então desfazer a citação é determinístico e é o que esta função faz.
 *
 * A propriedade que amarra as duas pontas está testada: `tokenize(args.map(quoteArg).join(" "))` tem
 * de devolver `args` — para qualquer `args`, inclusive os adversariais.
 */
export function tokenizeCommandLine(cmd: string): string[] {
  const tokens: string[] = [];
  let atual = "";
  let iniciado = false;
  let aspa: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (aspa) {
      if (ch === aspa) {
        aspa = null;
        continue;
      }
      // Aspas simples são literais em POSIX (nem escape vale dentro delas); só as duplas processam `\`.
      if (aspa === '"' && ch === "\\" && i + 1 < cmd.length) {
        atual += cmd[++i];
        continue;
      }
      atual += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      aspa = ch;
      iniciado = true;
      continue;
    }
    if (ch === "\\" && i + 1 < cmd.length) {
      atual += cmd[++i];
      iniciado = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (iniciado) {
        tokens.push(atual);
        atual = "";
        iniciado = false;
      }
      continue;
    }
    atual += ch;
    iniciado = true;
  }
  if (iniciado) tokens.push(atual);
  return tokens;
}

/**
 * OS TOKENS QUE SÃO SINTAXE — o valor de `-p` sai fora, porque ele é DADO.
 *
 * ── POR QUE ISTO É NECESSÁRIO ALÉM DA TOKENIZAÇÃO ──────────────────────────────────────────────────
 * Tokenizar já resolve o caso comum (um prompt que MENCIONA `--settings` vira um token só, diferente
 * de `--settings`). Mas não resolve o patológico: um prompt cujo conteúdo INTEIRO seja exatamente
 * `--settings` produz um token idêntico à flag, e o portão volta a contar dois.
 *
 * E a direção perigosa é a inversa, que uma medição independente encontrou e o revisor não tinha
 * apontado: com o prompt carregando o PAR `--settings <caminho-do-settings-desta-postura>`, a mutação
 * histórica (filtrar `--settings` do argv logo antes do spawn) satisfazia o portão em silêncio — o
 * comando sairia SEM contenção nenhuma e a verificação passaria verde, porque as duas condições que
 * ela testava eram satisfeitas por texto que o chamador controla.
 *
 * A regra que fecha as duas pontas é a mesma: o portão não pode olhar para o campo de DADOS. O prompt
 * está sempre no valor de `-p`/`--print` — nas duas superfícies, por construção — então excluí-lo é
 * exato, uniforme e não precisa que o call-site informe índice nenhum (o que seria mais uma costura
 * para alguém esquecer).
 */
const FLAGS_DE_PROMPT = new Set(["-p", "--print"]);

export function tokensDeSintaxe(tokens: readonly string[]): string[] {
  const saida: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    // ── `--` É FIM DE OPÇÕES, E IGNORÁ-LO SERIA FALSO NEGATIVO ────────────────────────────────────
    // Medido contra o CLI real: `claude -p -- "hello" --settings /nao/existe.json` roda NORMALMENTE e
    // ignora a flag EM SILÊNCIO — o `--` a transformou em operando. Um portão que contasse tokens
    // depois do `--` veria a cerca presente enquanto o CLI a descartou: contenção anunciada, ausente,
    // e verificada verde. Parar aqui faz o caso virar "nenhum --settings" ⇒ o run aborta.
    if (t === "--") break;
    if (FLAGS_DE_PROMPT.has(t)) {
      saida.push(t);
      i++; // pula o VALOR: é dado do usuário, não sintaxe do comando
      continue;
    }
    // A forma `-p=...` carrega o dado no mesmo token; o token inteiro sai.
    if ([...FLAGS_DE_PROMPT].some((f) => t.startsWith(`${f}=`))) continue;
    saida.push(t);
  }
  return saida;
}

/**
 * Uma flag pode chegar como `--x valor` ou `--x=valor`. As três funções abaixo tratam as duas formas,
 * porque contar só a primeira deixaria a segunda passando por baixo do portão.
 */
function ocorrenciasDaFlag(tokens: readonly string[], flag: string): number {
  return tokens.filter((t) => t === flag || t.startsWith(`${flag}=`)).length;
}

function temFlag(tokens: readonly string[], flag: string): boolean {
  return ocorrenciasDaFlag(tokens, flag) > 0;
}

/** O valor EFETIVO de uma flag: o ÚLTIMO, porque é o que vence no parsing de qualquer CLI. */
function valorDaFlag(tokens: readonly string[], flag: string): string | undefined {
  let valor: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === flag) valor = tokens[i + 1];
    else if (t.startsWith(`${flag}=`)) valor = t.slice(flag.length + 1);
  }
  return valor;
}

/**
 * A verificação sobre um ARGV — a forma canônica. A do engine converte para cá.
 *
 * Existe separada porque as duas superfícies de produção montam o comando de formas diferentes: o
 * engine produz uma STRING (roda com `shell:true`, para o shell resolver o `claude` do PATH), e
 * `run_task` produz um ARGV (roda com `execFile`, sem shell). A primeira migração do `run_task`
 * esqueceu o portão, e um revisor provou o custo: filtrando `--settings` do argv, a suíte inteira do
 * módulo seguiu verde.
 */
export function assertContainmentReachedArgv(posture: AutonomyPosture, argv: readonly string[]): void {
  assertContainmentReachedTokens(posture, tokensDeSintaxe(argv));
}

/**
 * As chaves SEM AS QUAIS o settings não é uma fronteira — verificadas no DISCO, no último instante.
 *
 * Cada uma compra uma propriedade concreta, e por isso a ausência de qualquer uma aborta:
 *  - `enabled`: sem isto não há sandbox nenhum, só um arquivo bonito;
 *  - `autoAllowBashIfSandboxed`: é o que substitui a flag perigosa; sem isto o run trava no primeiro Bash;
 *  - `failIfUnavailable`: é o que inverte o sinal da degradação (sem sandbox, não roda);
 *  - `allowUnsandboxedCommands: false`: desarma o escape do próprio CLI — com ele true, o agente sai
 *    da cerca ao primeiro erro e a fronteira vira sugestão.
 */
const SETTINGS_MINIMO = {
  enabled: true,
  autoAllowBashIfSandboxed: true,
  failIfUnavailable: true,
  allowUnsandboxedCommands: false,
} as const;

/** A serialização CANÔNICA do settings. Uma só, porque o hash da postura e os bytes no disco têm de
 *  ser a mesma coisa — se divergirem, a comparação vira ruído e o portão volta a medir zero. */
export function serializeSandboxSettings(settings: Record<string, unknown>): string {
  return JSON.stringify(settings, null, 2);
}

/**
 * O settings É uma fronteira? — pura, sobre o objeto já parseado.
 *
 * ── POR QUE ISTO É UMA FUNÇÃO SEPARADA, E POR QUE ELA É EXAUSTIVA ──────────────────────────────────
 * A primeira versão conferia só os quatro booleanos; um revisor trocou `allowWrite` por `["/"]` e
 * apenas 1 de 169 provas reprovou. Endurecida, ela passou a conferir `allowWrite` — e o revisor
 * seguinte mutou A PRÓPRIA CHECAGEM de volta à forma fraca e mediu: **7079 de 7079 provas verdes**. O
 * produtor (`buildSandboxSettings`) estava guardado, porque o portão aborta em produção quando ele
 * erra; o VERIFICADOR não estava guardado por nada.
 *
 * É a terceira vez que a mesma lição chega um nível mais fundo, então a resposta desta vez não é "mais
 * uma checagem": é mudar a forma de verificar.
 *  1. A verificação é PURA e recebe o objeto — logo é testável diretamente, sem disco;
 *  2. cada invariante tem um teste de VIOLAÇÃO (o par que faltava);
 *  3. e um teste EXAUSTIVO percorre cada folha do settings conhecido-bom, muta essa folha e exige que
 *     a fronteira reprove — ou que a folha esteja numa lista explícita de "não sustenta a cerca".
 *     Assim, uma chave nova nasce classificada, em vez de nascer não-verificada.
 */
export function assertSettingsIsFence(
  parsed: unknown,
  esperado: { writeRoot: string; credentialPaths: readonly string[]; denyWrite: readonly string[]; origem: string },
): void {
  const sandbox = ((parsed as { sandbox?: Record<string, unknown> } | null)?.sandbox ?? {}) as Record<string, unknown>;
  for (const [chave, valor] of Object.entries(SETTINGS_MINIMO)) {
    if (sandbox[chave] !== valor) {
      throw new Error(
        `[autonomy] o settings apontado por --settings NÃO é uma fronteira: esperava ` +
          `sandbox.${chave} === ${valor}, encontrei ${JSON.stringify(sandbox[chave])} em ${esperado.origem}. ` +
          `O ponteiro estava certo e a cerca, desarmada. Run ABORTADO.`,
      );
    }
  }
  const fs = sandbox.filesystem as { allowWrite?: unknown; disabled?: unknown } | undefined;
  const allowWrite = fs?.allowWrite;
  if (!Array.isArray(allowWrite) || allowWrite.length !== 1 || allowWrite[0] !== esperado.writeRoot) {
    throw new Error(
      `[autonomy] o envelope de escrita do settings NÃO é o da postura: esperava exatamente ` +
        `["${esperado.writeRoot}"], encontrei ${JSON.stringify(allowWrite)} em ${esperado.origem}. A cerca ` +
        `existe e está no lugar errado — o log anunciaria a árvore do run enquanto o CLI concederia outra ` +
        `coisa. Run ABORTADO.`,
    );
  }
  // `filesystem.disabled` desliga o isolamento de filesystem INTEIRO mantendo o resto — é a forma mais
  // direta de "a cerca existe e não contém", e o schema do CLI a documenta como tal.
  if (fs?.disabled === true) {
    throw new Error(
      `[autonomy] sandbox.filesystem.disabled === true em ${esperado.origem}: o isolamento de filesystem ` +
        `está DESLIGADO enquanto o settings anuncia allowWrite. Run ABORTADO.`,
    );
  }
  // Curinga de egresso anula a allowlist inteira, e é a outra forma de "a cerca existe e não contém".
  const dominios = (sandbox.network as { allowedDomains?: unknown } | undefined)?.allowedDomains;
  if (!Array.isArray(dominios) || dominios.length === 0 || dominios.some((d) => String(d).includes("*"))) {
    throw new Error(
      `[autonomy] allowlist de egresso ausente ou com curinga em ${esperado.origem}: ` +
        `${JSON.stringify(dominios)}. Um "*" aqui abre a rede inteira com o log dizendo que o egresso é ` +
        `restrito. Run ABORTADO.`,
    );
  }
  // ── AS CREDENCIAIS (achado de revisão) ───────────────────────────────────────────────────────────
  // A negação das credenciais do harness é o que impede um run de LER o token com que o próprio harness
  // se autentica — e ela era montada por uma derivação implícita (`path.dirname(stateDir)`) que nenhum
  // teste percorria e que o portão não conferia. Duas defesas ausentes sobre o mesmo valor.
  const files = (sandbox.credentials as { files?: unknown } | undefined)?.files;
  const negados = new Set(
    (Array.isArray(files) ? files : [])
      .filter((f): f is { path: string; mode: string } => !!f && typeof f === "object" && (f as { mode?: string }).mode === "deny")
      .map((f) => f.path),
  );
  // O recorte de escrita prometido pela postura — ver a nota em `denyWrite`.
  const denyWrite = (fs as { denyWrite?: unknown } | undefined)?.denyWrite;
  const recortados = new Set(Array.isArray(denyWrite) ? denyWrite.map(String) : []);
  const recortesFaltando = esperado.denyWrite.filter((p) => !recortados.has(p));
  if (recortesFaltando.length > 0) {
    throw new Error(
      `[autonomy] o settings não RECORTA o que a postura prometeu recortar em ${esperado.origem}: ` +
        `faltam ${JSON.stringify(recortesFaltando)} em filesystem.denyWrite. São os caminhos que guardam ` +
        `as credenciais do harness e a cerca dos runs CONCORRENTES — sem eles, um run reescreve a ` +
        `contenção de outro. Run ABORTADO.`,
    );
  }
  // ── A MESMA LISTA, NA CHAVE DE FILESYSTEM (achado de 2026-08-05) ─────────────────────────────────
  // `credentials.files` sozinho foi medido vazando 3 de 4 execuções para a ferramenta Read NATIVA.
  // `filesystem.denyRead` desce pela mesma rota e não fecha o caminho nativo tampouco (1 vazamento em
  // 3) — mas fechar o Bash sandboxado por DUAS chaves em vez de uma custa zero e a chave já era
  // reconhecida pelo módulo como monotônica sem nunca ser emitida.
  //
  // Ancorar em `DEFAULT_DENY_READ`, que é CONSTANTE DE MÓDULO e não vem do call-site, é deliberado:
  // a rodada 13 mostrou que um portão que compara postura × settings — ambos derivados do MESMO
  // valor — é vácuo por construção para todo parâmetro de entrada. Aqui o lado esperado não é
  // derivável pelo chamador, então mutar o argumento não move o alvo junto.
  const denyRead = (fs as { denyRead?: unknown } | undefined)?.denyRead;
  const naoLidos = new Set(Array.isArray(denyRead) ? denyRead.map(String) : []);
  const leituraFaltando = DEFAULT_DENY_READ.filter((p) => !naoLidos.has(p));
  if (leituraFaltando.length > 0) {
    throw new Error(
      `[autonomy] o settings não emite filesystem.denyRead em ${esperado.origem}: faltam ` +
        `${JSON.stringify(leituraFaltando)}. São as chaves de acesso do host e as credenciais que ` +
        `PUBLICAM EM PRODUÇÃO (gcloud, firebase-tools) — sem elas o run lê e exfiltra sem escrever ` +
        `uma linha. Run ABORTADO.`,
    );
  }
  const faltando = [...DEFAULT_DENY_READ, ...esperado.credentialPaths].filter((p) => !negados.has(p));
  if (faltando.length > 0) {
    throw new Error(
      `[autonomy] o settings não NEGA credenciais que a postura prometeu negar em ${esperado.origem}: ` +
        `faltam ${JSON.stringify(faltando)}. O run leria o token com que o próprio harness se autentica. ` +
        `Run ABORTADO.`,
    );
  }
}

/**
 * Lê o settings que será entregue ao CLI e confere DUAS coisas independentes:
 *
 *  1. **que os bytes no disco são os que a postura escreveu** (comparação de sha256). Fecha a janela
 *     entre escrever e spawnar: um run concorrente que sobrescreva o arquivo, uma poda que o trunque,
 *     um editor que passe por ali. Nenhuma lista de chaves cobre isso, porque o defeito não é uma chave
 *     errada — é o arquivo ser outro.
 *  2. **que o conteúdo é semanticamente uma fronteira** ({@link assertSettingsIsFence}). Fecha o caso em
 *     que o produtor emitiu, e portanto escreveu e hasheou, algo que não contém.
 *
 * As duas juntas são o que faz este portão parar de depender de eu lembrar de acrescentar uma checagem
 * por chave nova.
 */
function verificarSettingsNoDisco(
  file: string,
  esperado: { writeRoot: string; credentialPaths: readonly string[]; denyWrite: readonly string[]; sha256: string },
): void {
  let bruto: string;
  try {
    bruto = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(
      `[autonomy] o settings de sandbox não pôde ser LIDO no instante do spawn (${file}): ` +
        `${err instanceof Error ? err.message : String(err)}. O comando apontaria para uma cerca que ` +
        `não se sabe se existe. Run ABORTADO.`,
    );
  }
  const shaNoDisco = createHash("sha256").update(bruto).digest("hex");
  if (shaNoDisco !== esperado.sha256) {
    throw new Error(
      `[autonomy] o settings em ${file} MUDOU entre a montagem da postura e o spawn ` +
        `(sha256 esperado ${esperado.sha256.slice(0, 12)}…, encontrado ${shaNoDisco.slice(0, 12)}…). ` +
        `A cerca que o comando aponta não é a que esta postura montou. Run ABORTADO.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bruto);
  } catch (err) {
    throw new Error(
      `[autonomy] o settings de sandbox em ${file} não é JSON válido: ` +
        `${err instanceof Error ? err.message : String(err)}. Run ABORTADO.`,
    );
  }
  assertSettingsIsFence(parsed, {
    writeRoot: esperado.writeRoot,
    credentialPaths: esperado.credentialPaths,
    denyWrite: esperado.denyWrite,
    origem: file,
  });
}

/**
 * O RECORTE DA INVOCAÇÃO DO `claude` dentro do comando final.
 *
 * ── POR QUE ISTO EXISTE (defeito medido durante a própria correção) ────────────────────────────────
 * O portão roda sobre o comando DEPOIS de todos os wrappers — é o único ponto onde se sabe o que será
 * executado. Só que o comando final não é uma invocação: é uma CADEIA delas. Hoje pode ser
 *
 *     systemd-run --scope --collect --unit=… --slice=… -p MemoryMax=… -p CPUQuota=…% -- claude -p … --settings …
 *
 * (forma REAL, lida de `buildScopePrefix` em governor.ts:102 — o prefixo termina em ` --`.)
 *
 * e o `--` ali é do `systemd-run`, não do `claude`. Quando acrescentei a semântica de fim-de-opções
 * (correta e necessária — ver a nota em `tokensDeSintaxe`), ela passou a truncar no `--` do WRAPPER e
 * o portão deixou de enxergar o `--settings` do `claude`: 11 provas do engine reprovaram com
 * "CONTENÇÃO PROMETIDA E AUSENTE" sobre um comando perfeitamente contido.
 *
 * O erro de fundo é o mesmo que esta rodada inteira persegue, invertido: eu estava aplicando a
 * gramática de UM comando a uma string que contém VÁRIOS. Recortar a última invocação do binário
 * devolve a pergunta ao escopo certo — e, de quebra, impede que uma flag do wrapper (`--property`,
 * um `--settings` de outra ferramenta) seja confundida com uma do agente.
 *
 * Sem o binário na cadeia, devolve tudo: verificar demais pode abortar um run legítimo, mas verificar
 * de menos deixa passar um run sem cerca — e entre os dois erros, este código escolhe sempre o primeiro.
 */
export function recorteDaInvocacao(tokens: readonly string[], binario: string): string[] {
  // ── ANCORADO NO BINÁRIO REAL, e não num nome adivinhado (conserto de 2026-08-26) ──────────────
  // Este corte separa o comando do AGENTE do embrulho do `systemd-run`, e é dele que o portão de
  // contenção depende para medir a coisa certa. Ele procurava o último token cujo basename fosse
  // `claude` — o que assume um nome que o produto NÃO garante: a régua de `runner/claude-bin.ts`
  // aceita, de propósito, tanto um NOME diferente (`autorun.claudeBin: "claude-canary"`) quanto um
  // ENDEREÇO qualquer (`AGILEHARNESS_CLAUDE=/opt/x/meubin`). Com qualquer um dos dois o corte não
  // achava nada, devolvia o comando INTEIRO — embrulho junto — e o portão reprovava um run legítimo
  // com "CONTENÇÃO PROMETIDA E AUSENTE DO COMANDO". MEDIDO: 12 testes do governor reproduzem isso
  // quando o binário se chama outra coisa.
  //
  // Agora quem spawna PASSA o argv0 que resolveu. Dois níveis, do exato para o tolerante:
  //   1. o token IGUAL ao binário — o caso normal, porque o comando é montado com ele;
  //   2. o token cujo BASENAME é o mesmo — cobre o embrulho que reescreve o caminho (um
  //      `systemd-run` com cwd diferente, uma citação de shell que sobrou).
  // Sem casar, devolve tudo: o portão então mede o comando inteiro, que é o lado SEGURO do erro
  // (mede demais, nunca de menos) — e agora é uma condição impossível de alcançar em silêncio,
  // porque o binário é obrigatório na assinatura.
  const alvo = binario.trim();
  const baseDoAlvo = alvo.replace(/^.*[\\/]/, "");
  for (let i = tokens.length - 1; i >= 0; i--) if (tokens[i] === alvo) return tokens.slice(i);
  if (baseDoAlvo) {
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (tokens[i]!.replace(/^.*[\\/]/, "") === baseDoAlvo) return tokens.slice(i);
    }
  }
  return [...tokens];
}

export function assertContainmentReachedCommand(
  posture: AutonomyPosture,
  cmd: string,
  /** o argv0 RESOLVIDO. Obrigatório: adivinhá-lo por nome é o defeito que este parâmetro remove. */
  binario: string,
): void {
  assertContainmentReachedTokens(posture, tokensDeSintaxe(recorteDaInvocacao(tokenizeCommandLine(cmd), binario)));
}

function assertContainmentReachedTokens(posture: AutonomyPosture, tokens: readonly string[]): void {
  // `refused` NÃO PODE TER COMANDO (achado de revisão). O fail-closed da Sonda W era imposto por um
  // `throw` solto no engine que nenhum teste cobria: um revisor o trocou por comentário e 372 testes
  // passaram. É a mesma classe que este portão existe para fechar, uma branch adiante — então a branch
  // entra no portão. Se a postura recusou, chegar aqui já é o defeito.
  if (posture.kind === "refused") {
    throw new Error(
      `[autonomy] postura RECUSADA e um comando foi montado mesmo assim: ${posture.reason} — ` +
        `Run ABORTADO. A recusa deixou de ser aplicada em algum ponto entre resolveAutonomyPosture e a ` +
        `montagem do comando.`,
    );
  }
  if (posture.kind === "sandboxed") {
    // ── O PONTEIRO NÃO É A CERCA (achado de revisão, e o mais fino que este portão recebeu) ────────
    // O portão exigia `--settings <caminho>` e parava aí: verificava que o comando APONTA para o
    // arquivo, nunca o que o arquivo DIZ. Um revisor mutou `enabled: true` para `false` em
    // `buildSandboxSettings` e mediu: de 7068 provas, UMA reprovou (um teste de forma), o portão ficou
    // mudo, o comando saiu com `--settings` e o log anunciou "sandbox: bubblewrap". O run rodaria com a
    // cerca DESARMADA apontada por um ponteiro válido.
    //
    // Então o portão lê o arquivo que vai ser entregue ao CLI e confere o mínimo que faz dele uma
    // fronteira. É a diferença entre "o envelope tem endereço" e "o envelope tem carta dentro".
    verificarSettingsNoDisco(posture.settingsFile, {
      writeRoot: posture.writeRoot,
      credentialPaths: posture.credentialPaths,
      denyWrite: posture.denyWrite,
      sha256: posture.settingsSha256,
    });
    // ── UM ÚNICO --settings, E APONTANDO PARA ESTA POSTURA ────────────────────────────────────────
    // Verificar PRESENÇA não é verificar EFEITO: um segundo `--settings` vindo de `extraArgs`
    // (`USM_AUTORUN_EXTRA_ARGS`, config do operador) VENCE no parsing e o portão passaria verde. Por
    // isso conta-se a ocorrência e compara-se o valor EFETIVO (o último), não a mera presença.
    const ocorrencias = ocorrenciasDaFlag(tokens, "--settings");
    if (ocorrencias === 0) {
      throw new Error(
        `[autonomy] CONTENÇÃO PROMETIDA E AUSENTE DO COMANDO: a postura resolveu como "sandboxed" ` +
          `(${posture.mechanism}, settings em ${posture.settingsFile}) mas o comando montado não carrega ` +
          `esse --settings. O run foi ABORTADO em vez de rodar sem a fronteira que o log anunciou. ` +
          `Isto é um defeito de programação entre buildSpawnFlags e a montagem do comando, não de operação.`,
      );
    }
    if (ocorrencias !== 1) {
      throw new Error(
        `[autonomy] mais de um --settings no comando: o último vence no parsing, então a fronteira ` +
          `efetiva não é a que esta postura montou. Verifique extraArgs (USM_AUTORUN_EXTRA_ARGS). Run ABORTADO.`,
      );
    }
    if (valorDaFlag(tokens, "--settings") !== posture.settingsFile) {
      throw new Error(
        `[autonomy] o --settings EFETIVO do comando (${valorDaFlag(tokens, "--settings") ?? "(sem valor)"}) ` +
          `não é o da postura (${posture.settingsFile}). O run apontaria para outra cerca. Run ABORTADO.`,
      );
    }
    // ── O MODO DE PERMISSÃO É LOAD-BEARING (achado de revisão, apoiado em medição própria) ─────────
    // ADR-067 §"Por que acceptEdits e NÃO bypassPermissions": com `bypassPermissions` DENTRO do mesmo
    // sandbox, a ferramenta Write NATIVA escapou e gravou em /root e na árvore do repo-pai — porque o
    // sandbox do SO cobre só comandos de shell; as ferramentas nativas rodam in-process e são contidas
    // apenas pela camada de permissão. Logo o modo faz parte da contenção e tem de estar no portão.
    // Um `--permission-mode bypassPermissions` em extraArgs é CONFIGURAÇÃO de operador, não bug de
    // programação — e desfazia a contenção com o log ainda anunciando "sandbox: bubblewrap".
    const ultimo = valorDaFlag(tokens, "--permission-mode");
    if (ultimo !== "acceptEdits") {
      throw new Error(
        `[autonomy] postura "sandboxed" com --permission-mode ${ultimo ?? "(ausente)"} — o modo efetivo ` +
          `(o ÚLTIMO do comando) precisa ser acceptEdits. Medido: com bypassPermissions, a ferramenta ` +
          `Write nativa escapa da árvore do run, porque o sandbox do SO só contém comandos de shell. ` +
          `Run ABORTADO.`,
      );
    }
    if (temFlag(tokens, "--dangerously-skip-permissions")) {
      throw new Error(
        `[autonomy] postura "sandboxed" com --dangerously-skip-permissions no comando: as duas coisas ` +
          `juntas significam que a fronteira foi montada e depois contornada. Run ABORTADO.`,
      );
    }
  }
  if (posture.kind === "downgraded") {
    if (temFlag(tokens, "--dangerously-skip-permissions")) {
      throw new Error(
        `[autonomy] postura REBAIXADA (${posture.tier}) com --dangerously-skip-permissions no comando: ` +
          `o rebaixamento existe justamente porque não há contenção neste host. Run ABORTADO.`,
      );
    }
    // O rebaixamento tem de COMPRAR a perda de capacidade que ele anuncia — ver buildSpawnFlags.
    if (valorDaFlag(tokens, "--disallowedTools") !== "Bash") {
      throw new Error(
        `[autonomy] postura REBAIXADA sem --disallowedTools Bash: sem sandbox e com acceptEdits, o ` +
          `permissions.allow do ALVO concede shell — o run teria execução arbitrária enquanto o aviso ` +
          `diz ao operador que ele perdeu o Bash. Run ABORTADO.`,
      );
    }
  }
}

/**
 * AS POSTURAS POR SUPERFÍCIE — cada uma recebe só o que a SUPERFÍCIE sabe, e deriva o resto.
 *
 * ── O BLOQUEADOR QUE ISTO FECHA ─────────────────────────────────────────────────────────────────────
 * `envelopeForSpawn` e `buildSpawnFlags` viraram funções puras testadas, e mesmo assim o perímetro
 * seguia decidido por ARGUMENTOS escritos à mão em quatro call-sites. Um revisor mediu cinco mutações
 * adversariais que a suíte COMPLETA não vê:
 *
 *   · `envelopeForSpawn({ isCode, cwd })` → `{ isCode: true, cwd }` no engine: o `writeRoot` das cinco
 *     skills `full` NÃO-CODE deixa de ser `storymap/boards/` e vira a RAIZ do repositório;
 *   · `projectRoot: findRepoRoot()` → `"/tmp"` no `run_task`: a detecção da cerca ampliável fica CEGA;
 *   · o envelope do revisor par alargado do tempdir para a raiz do repositório;
 *   · `trigger` → `null` no engine: a isenção nomeada fica permanentemente inerte.
 *
 * Nenhuma delas é sutil, e todas passam porque o guarda dos call-sites é regex sobre a FONTE — a
 * técnica que este arquivo condena e continuava usando na última costura que sobrou.
 *
 * ── A CORREÇÃO ──────────────────────────────────────────────────────────────────────────────────────
 * A decisão sai do call-site e vira função nomeada por superfície, que recebe o MÍNIMO que só aquela
 * superfície conhece. O que se testa deixa de ser "o texto do call-site" e passa a ser "o VALOR que a
 * função devolve" — um argumento errado vira uma postura errada, observável. É a mesma jogada que já
 * fez `trigger` virar obrigatório e `boardDataDir` virar derivado: mover o erro para onde uma prova
 * alcança, em vez de vigiar melhor.
 */
export interface PosturaDeps {
  /** Injetáveis para o teste observar o resultado sem tocar no disco real. */
  support?: SandboxSupport;
  env?: EnvLike;
  writeSettings?: (dir: string, settings: Record<string, unknown>, key: string) => string;
  readTarget?: (p: string) => string | null;
}

// Exportada em 2026-08-05: `resolveReviewerPosture` e `resolveJudgePosture` remontavam este mesmo
// objeto À MÃO em outros arquivos. Argumento montado no call-site é argumento que nenhuma prova
// observa — foi a classe do bloqueador da 12ª revisão, e ela seguia viva em metade das superfícies.
export function suporteDoHost(): SandboxSupport {
  return detectSandboxSupport({
    platform: process.platform,
    hasBin: hasExecutable,
    // A SONDA, não a presença do binário: há caixa onde os dois binários existem e o sandbox só sobe em
    // modo weaker. Detecção que nunca devolve "indisponível" não é detecção.
    runProbe: runSetgroupsProbe,
    // A sonda que permite RECUSAR: kernel que não cria userns ⇒ não há sandbox neste host.
    runNamespaceProbe,
  });
}

/** A postura de um run do AUTORUN. O engine sabe três coisas; todo o resto é derivado aqui. */
export function resolveEnginePosture(
  input: { tier: AutonomyTier; trigger: string | null; isCode: boolean; cwd: string; key: string },
  deps: PosturaDeps = {},
): AutonomyPosture {
  return resolveAutonomyPosture({
    tier: input.tier,
    trigger: input.trigger,
    support: deps.support ?? suporteDoHost(),
    env: deps.env ?? process.env,
    ...envelopeForSpawn({ isCode: input.isCode, cwd: input.cwd }),
    stateRoot: runnerStateDir(),
    key: input.key,
    readTarget: deps.readTarget ?? readTargetSettings,
    writeSettings: deps.writeSettings,
  });
}

/**
 * A postura da tool `run_task`. Ela sabe UM caminho — o diretório de trabalho — e nada mais.
 *
 * ⚠ A raiz de PROJETO é a raiz do REPOSITÓRIO, não o `workdir`: o CLI resolve `.claude/settings.json`
 * subindo. Passar o `workdir` deixava a detecção cega quando a tool recebe `cwd` — foi um bloqueador de
 * revisão, e aqui a escolha deixa de ser um argumento que alguém reescreve.
 */
export function resolveRunTaskPosture(
  input: { workdir: string; key: string },
  deps: PosturaDeps = {},
): AutonomyPosture {
  return resolveAutonomyPosture({
    tier: "full",
    // Não é skill de board: a isenção por trigger não se aplica, e dizê-lo é a decisão que o tipo cobra.
    trigger: null,
    support: deps.support ?? suporteDoHost(),
    env: deps.env ?? process.env,
    ...envelopeForSpawn({ isCode: true, cwd: input.workdir }),
    projectRoot: findRepoRoot(),
    stateRoot: runnerStateDir(),
    key: input.key,
    readTarget: deps.readTarget ?? readTargetSettings,
    writeSettings: deps.writeSettings,
  });
}

/**
 * O SPAWN CONTIDO — a verificação e a execução na MESMA expressão, sem nada entre elas.
 *
 * ── O DEFEITO QUE ISTO FECHA, MEDIDO POR UM REVISOR ─────────────────────────────────────────────────
 * O portão virou código de produção, e isso foi certo — mas eu o chamei numa linha e spawnei em OUTRA,
 * com 50 linhas de distância no engine e 12 no `run_task`. O revisor não precisou de sutileza:
 *
 *     - child = this.spawnProcess(finalCmd, {…})
 *     + child = this.spawnProcess(finalCmd.replace(/ --settings [^ ]+/, ""), {…})
 *
 * e a suíte inteira ficou verde: **7167 de 7167**. O portão verificava um valor e o processo executava
 * outro. É o TOCTOU do meu próprio conserto — "impedir, não detectar" não vale quando a coisa impedida
 * pode ser reescrita depois de impedida.
 *
 * E o guarda daquelas duas chamadas era regex sobre a fonte que nem sequer despreza comentário: um
 * segundo revisor transformou as duas chamadas do portão EM COMENTÁRIO e a suíte também ficou verde.
 *
 * ── A CORREÇÃO, E POR QUE ELA É DE FORMA E NÃO DE VIGILÂNCIA ────────────────────────────────────────
 * O valor verificado e o valor executado passam a ser o MESMO parâmetro da MESMA função, e não há
 * instrução entre o `assert` e o `spawn`. Não é que a janela ficou menor: ela deixou de existir, porque
 * não há onde escrever a mutação sem tocar num corpo que a suíte cobre por comportamento
 * (o teste injeta um spawn espião e um comando adulterado, e exige LANÇAR **e** o espião não ter sido
 * chamado).
 *
 * A régua que sobra para o futuro é a de sempre neste módulo: quem spawna um `claude` chama isto. O
 * lint de chokepoint cobra.
 */
export function spawnContidoCmd<T>(
  posture: AutonomyPosture,
  cmd: string,
  spawn: (cmd: string) => T,
  /** o argv0 RESOLVIDO com que `cmd` foi montado — ancora o corte da invocação. */
  binario: string,
): T {
  assertContainmentReachedCommand(posture, cmd, binario);
  return spawn(cmd);
}

/** A mesma coisa para as superfícies que montam ARGV (execFile, sem shell). */
export function spawnContidoArgv<T>(
  posture: AutonomyPosture,
  argv: readonly string[],
  spawn: (argv: readonly string[]) => T,
): T {
  assertContainmentReachedArgv(posture, argv);
  return spawn(argv);
}

/** Um arquivo de settings por run acumularia para sempre (dívida apontada em revisão). A poda é barata,
 *  roda na escrita e é best-effort: falhar em limpar NUNCA pode impedir um run de nascer contido. */
const SETTINGS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function pruneOldSettings(dir: string): void {
  try {
    const limite = Date.now() - SETTINGS_TTL_MS;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith("sandbox-") || !f.endsWith(".json")) continue;
      const full = path.join(dir, f);
      if (statSync(full).mtimeMs < limite) rmSync(full, { force: true });
    }
  } catch {
    /* best-effort por desenho */
  }
}

// ── A CERCA QUE O CONTIDO AMPLIA (medido; ver ADR-067 §Sonda W) ─────────────────────────────────────
//
// O CLI mescla o `sandbox.*` do `.claude/settings.json` DO PROJETO no envelope efetivo. Controle estrito
// — mesmo caminho-alvo, variando só a presença do arquivo hostil:
//
//   | settings hostil | --setting-sources     | escrita fora do worktree |
//   | não             | (nenhuma)             | NEGADA (Read-only fs)    |
//   | SIM             | (nenhuma)             | PERMITIDA                |
//   | não             | ""                    | NEGADA                   |
//   | SIM             | ""                    | PERMITIDA                |
//   | SIM             | user                  | PERMITIDA                |
//
// Ou seja: **nenhuma variante de `--setting-sources` impede a mesclagem** (a flag governa as outras
// chaves, não o `sandbox`). Não há alavanca no CLI. E `systemd-run --scope` recusa `ProtectSystem=`
// ("Unknown assignment"), então a camada externa por scope também não existe — ela exigiria um serviço
// transiente, o que muda a supervisão do processo e não cabe em F0.
//
// POR QUE ISTO IMPORTA MAIS DO QUE "repo alheio é não-confiável": o agente PODE escrever dentro do
// worktree — é o ponto do sandbox. Logo ele pode escrever `.claude/settings.json` LÁ, e o run SEGUINTE
// nasce com a cerca ampliada. É escalação de privilégio ENTRE RUNS, com o próprio mecanismo de contenção
// como veículo. Não depende de repositório hostil nenhum: basta uma injeção de prompt num run.
//
// A RESPOSTA DE F0 é a honesta disponível: DETECTAR e RECUSAR (fail-closed), por spawn, lendo o estado
// atual da árvore. Não é uma garantia do kernel — é o harness se recusando a operar quando não pode
// prometer o que anuncia. Chamar isso de "contenção inviolável" seria a mentira que esta fase remove.
export const TARGET_SETTINGS_FILES = [".claude/settings.json", ".claude/settings.local.json"] as const;

export interface TargetSandboxOverride {
  file: string;
  keys: string[];
}

/**
 * O alvo declara `sandbox.*`? Lê os settings DE PROJETO da árvore que o run vai ocupar.
 *
 * Fail-closed por desenho em duas direções: um arquivo ilegível/mal-formado conta como override (não
 * sabemos o que ele diz, e "não sei" não pode virar "pode"), e a leitura é injetável para o teste não
 * depender de disco.
 */
/**
 * AS CHAVES DO ALVO QUE **ESTREITAM** A CERCA — as únicas que podem ser aceitas sem gate.
 *
 * ── O PRINCÍPIO, E DE ONDE ELE VEM ─────────────────────────────────────────────────────────────────
 * A primeira versão desta detecção recusava o run diante de QUALQUER chave `sandbox.*` no settings do
 * alvo. Isso trata `denyWrite: ["/etc"]` — que só APERTA a cerca — como se fosse `allowWrite: ["/"]`.
 * Sacrifica disponibilidade sem comprar segurança, e é a diferença entre uma defesa e um obstáculo.
 *
 * A assimetria correta é a que a indústria convergiu e que a documentação do próprio CLI enuncia
 * melhor que qualquer outra fonte que eu tenha encontrado:
 *
 *   "deny and ask rules aren't affected, since they only restrict"
 *   "a deny entry only ever narrows access, so any scope can add one, but no scope can remove one
 *    that another scope added"
 *
 * É o mesmo desenho de `protected configuration` do git (escopos system/global/command são confiáveis,
 * local e worktree não) e de Workspace Trust do VS Code (`restricted?: boolean` POR CHAVE, aplicado no
 * parser e não no call-site — o que impede que um consumidor futuro esqueça a checagem).
 *
 * ── POR QUE A LISTA É DE QUEM ESTREITA, E NÃO DE QUEM AMPLIA ───────────────────────────────────────
 * Enumerar quem amplia obriga a lista a estar completa para a defesa valer: uma chave nova do CLI, ou
 * um typo, cai no lado permissivo em silêncio. Enumerando quem ESTREITA, o desconhecido cai no lado
 * que recusa — fail-closed por construção, que é a única forma que sobrevive a uma atualização do
 * binário de terceiro. A CVE-2022-24765 do git é o lembrete de que o vetor não precisa parecer
 * perigoso: quem virou execução de comando lá foi `core.fsmonitor`, uma chave de config comum.
 */
export const SANDBOX_KEYS_QUE_ESTREITAM = new Set<string>([
  "filesystem.denyWrite", // deny é monotônico: acrescentar só aperta
  "filesystem.denyRead",
  "network.deniedDomains", // "always blocked, even if matched by allowedDomains"
  "network.strictAllowlist", // nega deterministicamente host fora da allowlist
  "credentials", // entradas deny/mask só subtraem leitura
]);

/**
 * As chaves `sandbox.*` do alvo que NÃO estão comprovadamente do lado que estreita — em caminho
 * pontilhado, um nível abaixo de `filesystem`/`network` para a granularidade bater com a assimetria
 * (`filesystem.denyWrite` estreita; `filesystem.allowWrite` amplia).
 */
export function chavesQueAmpliam(sandbox: Record<string, unknown>): string[] {
  const achadas: string[] = [];
  for (const [chave, valor] of Object.entries(sandbox)) {
    const aninhado = (chave === "filesystem" || chave === "network") && valor && typeof valor === "object";
    const candidatas = aninhado
      ? Object.keys(valor as Record<string, unknown>).map((sub) => `${chave}.${sub}`)
      : [chave];
    for (const c of candidatas) if (!SANDBOX_KEYS_QUE_ESTREITAM.has(c)) achadas.push(c);
  }
  return achadas.sort();
}

export function detectTargetSandboxOverride(
  projectRoot: string,
  readFile: (p: string) => string | null,
  /** Injetável para o teste. Em produção, o `existsSync` real — usado só para achar o topo do repositório. */
  exists: (p: string) => boolean = existsSync,
): TargetSandboxOverride[] {
  const achados: TargetSandboxOverride[] = [];
  for (const dir of diretoriosDeSettings(projectRoot, exists)) {
    for (const rel of TARGET_SETTINGS_FILES) {
      const full = path.join(dir, rel);
      const raw = readFile(full);
      if (raw == null) continue; // ausente é o caso normal
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const sandbox = parsed.sandbox;
        if (sandbox && typeof sandbox === "object") {
          const ampliam = chavesQueAmpliam(sandbox as Record<string, unknown>);
          // ⚠ SÓ O QUE AMPLIA (ver `chavesQueAmpliam`). Recusar por uma chave que apenas ESTREITA seria
          // sacrificar disponibilidade sem comprar segurança nenhuma.
          if (ampliam.length > 0) achados.push({ file: full, keys: ampliam });
        }
      } catch {
        // Existe e não parseia: conta como override. Um JSON quebrado pode ser truncamento de escrita
        // concorrente — e permitir o run porque não conseguimos ler é exatamente o fail-open que não pode existir.
        achados.push({ file: full, keys: ["<ilegível>"] });
      }
    }
  }
  return achados;
}

/**
 * OS DIRETÓRIOS DE ONDE O CLI PODE LER `.claude/settings.json` — do cwd até o topo do repositório.
 *
 * ── O BLOQUEADOR QUE ISTO FECHA ─────────────────────────────────────────────────────────────────────
 * A versão anterior olhava UM diretório: o `projectRoot` que o call-site passasse. Um revisor mediu o
 * comportamento real do CLI e mostrou que ele SOBE:
 *
 *     $ claude config list          # rodado de projtest/sub/deep
 *     Project — projtest/.claude/settings.json (repo root, two levels up from your cwd sub/deep;
 *                                               no .claude in sub/ or sub/deep/)
 *
 * Consequência medida: `run_task` com `cwd: "packages/acmeapp"` e um settings HOSTIL em
 * `<raiz>/.claude/settings.json` resolvia `sandboxed` — a detecção lia dois caminhos que não existiam
 * enquanto o CLI mesclava o que existia. A defesa ficava INERTE exatamente na superfície que a fase
 * declara ser a única alcançável pela internet. É o mesmo defeito que a fase comemora ter corrigido no
 * engine ("a detecção lê o projectRoot, não o writeRoot"), reintroduzido pela outra porta.
 *
 * ── POR QUE VARRER A CADEIA INTEIRA, E NÃO REPRODUZIR A REGRA DO CLI ───────────────────────────────
 * Reproduzir a regra exigiria acertar, e continuar acertando, a heurística de um binário de terceiros
 * que pode mudar de versão. Varrer do cwd até o topo do repositório é um SUPERCONJUNTO do que o CLI lê:
 * o custo de errar para mais é uma recusa a explicar; o de errar para menos é a fronteira mentir. Numa
 * defesa fail-closed, os dois erros não são simétricos, e a escolha segue o lado barato.
 *
 * O topo é o diretório com `.git` (arquivo ou diretório — num worktree linkado é arquivo); sem
 * `.git` em lugar nenhum, o limite é `MAX_SETTINGS_WALK` níveis.
 */
const MAX_SETTINGS_WALK = 12;

export function diretoriosDeSettings(from: string, exists: (p: string) => boolean = existsSync): string[] {
  const dirs: string[] = [];
  let dir = path.resolve(from);
  for (let i = 0; i < MAX_SETTINGS_WALK; i++) {
    dirs.push(dir);
    if (exists(path.join(dir, ".git"))) break; // topo do repositório: o CLI não sobe além
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/** A leitura real, para produção. `null` = ausente (o caso normal), que NÃO é erro. */
export function readTargetSettings(p: string): string | null {
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
}

export type AutonomyPosture =
  | {
      kind: "sandboxed";
      tier: AutonomyTier;
      settingsFile: string;
      /**
       * O sha256 dos BYTES que esta postura escreveu. O portão o recompõe a partir do disco no instante
       * do spawn: se divergir, o arquivo é outro (run concorrente, poda, edição) e o run aborta. É a
       * única checagem que não depende de eu lembrar de conferir uma chave nova.
       */
      settingsSha256: string;
      /** As credenciais do harness que este settings PROMETEU negar — o portão confere que ele nega. */
      credentialPaths: readonly string[];
      /**
       * Os caminhos RECORTADOS de dentro do envelope (o state dir, quando ele cai lá dentro).
       *
       * ⚠ Ele estava fora da postura, e um revisor mediu o preço: apagar a emissão de
       * `filesystem.denyWrite` em `buildSandboxSettings`, OU parar de repassá-lo em
       * `resolveAutonomyPosture`, deixava a suíte COMPLETA idêntica ao baseline — zero detecção, em dois
       * pontos independentes. A causa era estrutural, não esquecimento: o portão só consegue cobrar o
       * que a postura PROMETE, e a postura não prometia isto. É o recorte que impede um run de reescrever
       * as credenciais do harness e o settings de contenção dos runs CONCORRENTES.
       */
      denyWrite: readonly string[];
      mechanism: string;
      weakerNested: boolean;
      /** A árvore efetivamente liberada para escrita — a MESMA que foi para o settings. O log lê daqui. */
      writeRoot: string;
    }
  | { kind: "nao-aplicavel"; tier: AutonomyTier }
  | { kind: "downgraded"; tier: AutonomyTier; warn: string }
  | { kind: "unsandboxed-escape"; tier: AutonomyTier; warn: string }
  | { kind: "refused"; reason: string };

/**
 * Decide a postura de UM spawn. Só o tier `full` é afetado — `orch`/`write`/`ro` nunca carregaram a flag
 * perigosa e não precisam de sandbox para existir.
 *
 * PURA quanto à decisão; a escrita do arquivo é injetada para o teste não tocar em disco.
 */
export function resolveAutonomyPosture(input: {
  tier: AutonomyTier;
  support: SandboxSupport;
  env: EnvLike;
  /**
   * O `cwd` do spawn — a raiz de PROJETO da qual o CLI resolve `.claude/settings.json`. É daqui que a
   * detecção da cerca ampliável lê, e NÃO do `writeRoot`: os dois divergem sempre que o run não recebe
   * worktree próprio. Colapsá-los deixou a defesa inerte para 5 skills (ver a nota na detecção).
   */
  projectRoot: string;
  /** A árvore que o SANDBOX libera para escrita. Pode ser mais estreita que o `projectRoot`. */
  writeRoot: string;
  /**
   * A RAIZ do state dir do harness (`runnerStateDir()`) — UM caminho, do qual esta função deriva os
   * dois que precisa: as credenciais ficam aqui, e os settings num subdiretório `sandbox/`.
   *
   * ⚠ Antes eram duas entradas (`stateDir`, e as credenciais por `path.dirname(stateDir)`). Um revisor
   * mostrou que isso só tinha MOVIDO a suposição implícita um nível acima: nada obrigava o `stateDir`
   * recebido a terminar em `/sandbox`, o tipo não expressava isso, e a derivação não tinha teste algum.
   * Receber a raiz e derivar aqui elimina a suposição em vez de realocá-la — os dois caminhos passam a
   * ser construídos no mesmo lugar, por construção coerentes.
   */
  stateRoot: string;
  /** Caminhos recortados de dentro do envelope — repassados a {@link buildSandboxSettings}. */
  denyWrite?: readonly string[];
  key: string;
  writeSettings?: (dir: string, settings: Record<string, unknown>, key: string) => string;
  /** Injetável para o teste não tocar disco. Em produção, `readTargetSettings`. */
  readTarget?: (p: string) => string | null;
  /**
   * O trigger da skill (`harness-qa`, `harness-do`, …), ou `null` para uma superfície que não é uma skill de
   * board (a tool `run_task`, por exemplo).
   *
   * ⚠ OBRIGATÓRIO, e nullable de propósito. A primeira versão era opcional e um teste de regex sobre a
   * FONTE guardava o call-site — a mesma técnica que esta fase já viu falhar três vezes, porque ela
   * prova que a CHAMADA aparece escrita, não que o valor chega. Exigir o campo põe o compilador no
   * lugar do regex: uma superfície nova não consegue nascer com a isenção inerte, e quem não tem
   * trigger é obrigado a dizer `null` — uma decisão, em vez de uma omissão.
   */
  trigger: string | null;
}): AutonomyPosture {
  const { tier, support, env, projectRoot, writeRoot, stateRoot, key } = input;
  // As duas derivações, lado a lado e no mesmo lugar — ver a nota em `stateRoot`.
  const settingsDir = path.join(stateRoot, "sandbox");
  const credentialsDir = stateRoot;
  // Tier que nunca foi candidato a sandbox NÃO é um rebaixamento — usar o mesmo rótulo obrigava o
  // engine a desambiguar por comparação de tier, e um teste que afirma "não é sandboxed" para `ro` não
  // prova nada sobre a degradação. `nao-aplicavel` diz o que de fato aconteceu.
  if (tier !== "full") return { kind: "nao-aplicavel", tier };

  const mode = resolveSandboxMode(env);

  // ⚠ ORDEM (defeito corrigido após revisão): a válvula é consultada PRIMEIRO. A versão anterior só a
  // olhava depois de concluir que o sandbox estava indisponível — ou seja, ela era INERTE exatamente no
  // cenário em que alguém a puxaria: sandbox "disponível" que na prática não sobe. A ADR e o README
  // anunciam esta env como A alavanca de reversão; uma alavanca que só funciona quando o sistema já
  // sabe que falhou não é alavanca. Quem declarou o risco por escrito vence sempre.
  if (unsandboxedFullAllowed(env)) {
    return {
      kind: "unsandboxed-escape",
      tier: "full",
      warn:
        `AUTONOMIA SEM CONTENÇÃO: rodando com AGILEHARNESS_ALLOW_UNSANDBOXED_FULL=1 — o run tem shell ` +
        `irrestrito no host (suporte de sandbox: ${support.reason}). Nunca ligue isto em máquina compartilhada.`,
    };
  }

  // ── A EXCEÇÃO POR TRIGGER: REMOVIDA EM 2026-08-05, E A RAZÃO FICA AQUI ────────────────────────────
  // Existiu uma válvula `AGILEHARNESS_UNCONTAINED_TRIGGERS=<skill>` que devolvia shell IRRESTRITO no
  // host à skill nomeada, permanentemente e sem expiração. O comentário dela terminava com "remova o
  // trigger da lista assim que o protocolo do passo deixar de precisar disso". O protocolo deixou.
  //
  // O QUE MUDOU, MEDIDO: a válvula existia porque a contenção dá network namespace próprio a cada
  // chamada Bash (`--unshare-net` por comando, ASRT linux-sandbox-utils.ts:1829), o que impede subir
  // `bun run qa-dev` num passo e consultá-lo no seguinte. Medimos que a varredura visual INTEIRA cabe
  // numa ÚNICA chamada Bash contida — subir o servidor, esperar, abrir Chromium headless, navegar e
  // capturar o PNG — e que o `webServer` do playwright.config sobe o dev server como FILHO da mesma
  // chamada, logo no mesmo namespace. O que se perde não é enxergar a tela: é só a rota INTERATIVA do
  // MCP chrome-devtools, que roda no processo do host e por isso nunca alcançaria um servidor contido.
  //
  // POR QUE NÃO TROCAMOS POR `sandbox.excludedCommands`, que parecia a versão granular: ele NÃO é
  // granular. Medido no CLI 2.1.222 — o casamento é por SUBCOMANDO após split da AST do bash, e se
  // QUALQUER subcomando casa, a LINHA INTEIRA roda fora da jaula. `readlink /proc/self/ns/net; ls -la
  // /proc/self/ns/net` devolveu o namespace do HOST para os DOIS, com uid 0; um comando excluído também
  // escreveu em `/root/`, fora do writeRoot. Ou seja `bun run qa-dev; cat /etc/shadow` rodaria o `cat`
  // sem jaula nenhuma. Somando: não existe `allowManagedExcludedCommandsOnly` no binário, e um
  // `.claude/settings.json` de PROJETO com `excludedCommands` foi HONRADO na medição — o alvo se
  // auto-isenta. É porta larga com nome estreito, e trocar uma válvula por ela seria trocar o nome do
  // buraco.
  //
  // O QUE SOBRA como saída do operador: `AGILEHARNESS_ALLOW_UNSANDBOXED_FULL`, que é global, alto e
  // honesto sobre o que concede. Uma isenção por skill, silenciosa e permanente, seria acionada pelo
  // primeiro plantonista que encontrasse um card travado — e a partir dali a skill que MAIS toca código
  // rodaria sem cerca para sempre. O incentivo invertido morre removendo a peça, não guardando-a.

  // A CERCA AMPLIÁVEL (ver o bloco acima). Verificado DEPOIS da válvula — quem declarou
  // `ALLOW_UNSANDBOXED_FULL` já abriu mão de contenção, e recusar ali seria incoerente — e ANTES de
  // montar o settings, porque montar uma fronteira que o alvo já ampliou é produzir a mentira.
  //
  // ⚠ LÊ O `projectRoot`, NÃO O `writeRoot` — e a diferença já custou uma reprovação. Os dois conceitos
  // são distintos e eu os havia colapsado: `writeRoot` é a árvore que o SANDBOX libera para escrita;
  // `projectRoot` é o `cwd` do spawn, e é dele que o CLI resolve os settings DE PROJETO. Quando passei a
  // estreitar o writeRoot para as skills não-code (`storymapDir()`), o detector passou a inspecionar
  // `<raiz>/storymap/.claude/settings.json` — caminho que o CLI nunca lê — enquanto o CLI seguia
  // mesclando `<raiz>/.claude/settings.json`, que EXISTE neste repositório. A defesa inteira ficou
  // inerte para 5 das 13 skills `full`, com o log dizendo "sandbox: bubblewrap". Contenção declarada e
  // inerte: exatamente a classe que este módulo existe para eliminar, uma camada adiante.
  const overrides = detectTargetSandboxOverride(projectRoot, input.readTarget ?? readTargetSettings);
  if (overrides.length > 0 && support.available && mode !== "off") {
    return {
      kind: "refused",
      reason:
        `o alvo declara configuração de sandbox própria e o CLI a MESCLA no envelope efetivo — medido: ` +
        `nenhuma variante de --setting-sources impede — então a fronteira que este run anunciaria não ` +
        `seria a que ele teria. ` +
        overrides.map((o) => `${o.file} (sandbox.${o.keys.join(", sandbox.")})`).join("; ") +
        `. TRÊS SAÍDAS, da mais segura para a menos: ` +
        `(1) remova a chave "sandbox" desse arquivo — é a única que preserva a contenção; ` +
        `(2) AGILEHARNESS_SANDBOX_MODE=off roda SEM shell (--disallowedTools Bash), então o run perde ` +
        `autonomia mas não ganha risco; ` +
        `(3) AGILEHARNESS_ALLOW_UNSANDBOXED_FULL=1 assume o risco e dá shell IRRESTRITO no host. ` +
        `⚠ Se você não pôs esse arquivo lá, um run ANTERIOR pode tê-lo escrito: é o caminho de escalação ` +
        `entre runs que esta checagem existe para cortar.`,
    };
  }

  if (support.available && mode !== "off") {
    const settings = buildSandboxSettings({
      writeRoot,
      credentialsDir,
      denyWrite: input.denyWrite,
      weakerNested: resolveWeakerNested(env, support.requiresWeakerNested),
      // O egresso EFETIVO: defaults + o que o operador declarou. Antes esta opção existia em
      // `buildSandboxSettings` e nenhum chamador de produção a preenchia — costura sem sujeito, que é
      // a dívida que esta fase já removeu uma vez em outro ponto.
      allowedDomains: resolveAllowedDomains(env),
    });
    const write = input.writeSettings ?? writeSandboxSettingsFile;
    return {
      kind: "sandboxed",
      tier: "full",
      // O envelope REAL, carregado na postura. Existe porque o log do engine imprimia o `cwd` enquanto
      // o settings concedia o `writeRoot` — e para runs não-code os dois divergem. Quem anuncia tem de
      // ler do mesmo lugar que concede, senão o anúncio é palpite.
      writeRoot,
      settingsFile: write(settingsDir, settings, key),
      // O hash dos BYTES que acabaram de ser escritos — ver a nota em `settingsSha256`. Calculado da
      // MESMA serialização que `writeSandboxSettingsFile` usa, senão a comparação nunca bateria.
      settingsSha256: createHash("sha256").update(serializeSandboxSettings(settings)).digest("hex"),
      credentialPaths: harnessCredentialPaths(credentialsDir),
      denyWrite: [...(input.denyWrite ?? [])],
      mechanism: support.mechanism,
      weakerNested: resolveWeakerNested(env, support.requiresWeakerNested),
    };
  }

  // Sem sandbox (indisponível OU desligado por env) e sem válvula: o modo decide entre recusar e rebaixar.
  if (mode === "required") {
    return {
      kind: "refused",
      reason:
        `sandbox exigido (AGILEHARNESS_SANDBOX_MODE=required) e indisponível: ${support.reason}. ` +
        `Instale as dependências${support.missing.length ? ` (${support.missing.join(", ")})` : ""} ` +
        `ou declare AGILEHARNESS_ALLOW_UNSANDBOXED_FULL=1 assumindo o risco.`,
    };
  }
  // ⚠ O AVISO RAMIFICA PELA CAUSA (achado de revisão). A versão anterior interpolava sempre
  // `support.reason`, que descreve a DISPONIBILIDADE do sandbox — não o motivo do rebaixamento. Com
  // `AGILEHARNESS_SANDBOX_MODE=off` num host que TEM sandbox, o operador lia "bwrap + socat presentes;
  // userns funciona (sonda ok) … Instale as dependências do sandbox" — um conselho impossível de seguir,
  // sobre uma causa que não era a dele. Diagnóstico que aponta o culpado errado custa mais tempo do que
  // diagnóstico nenhum.
  return {
    kind: "downgraded",
    tier: "write",
    warn:
      mode === "off"
        ? `REBAIXADO full → write porque AGILEHARNESS_SANDBOX_MODE=off foi declarado (o sandbox deste ` +
          `host está DISPONÍVEL: ${support.reason}). O run NÃO terá shell; passos que dependem de Bash ` +
          `vão falhar. Remova a env para recuperar a autonomia plena — "off" não devolve a postura ` +
          `antiga, para isso existe AGILEHARNESS_ALLOW_UNSANDBOXED_FULL=1.`
        : `REBAIXADO full → write: ${support.reason}. O run NÃO terá shell; passos que dependem de Bash ` +
          `vão falhar. Instale as dependências do sandbox para recuperar a autonomia plena.`,
  };
}
