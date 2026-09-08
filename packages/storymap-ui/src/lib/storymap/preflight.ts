// O RELATÓRIO DE PRONTIDÃO — o que precisa ser verdade para esta instalação funcionar, MEDIDO.
//
// POR QUE ELE EXISTE, e a história é constrangedora. Um comentário em `runner/autonomy-sandbox.ts`
// afirmava que "o `doctor` reporta quando está ligado", e o campo `SandboxSupport.reason` está
// anotado como "entra no aviso e no relatório de prontidão". Uma revisão rodou
// `grep -rn -i doctor src/` e achou UMA linha: o próprio comentário. O relatório que o código citava
// nunca existiu — capacidade declarada com zero produtores, no lugar exato onde a superfície que
// falta é a primeira de que um adotante precisa.
//
// O gatilho concreto foi o incidente de 2026-08-20 → 26: o Claude Code migrou para `~/.local/bin`,
// saiu do PATH que o unit do systemd FIXA, e TODO spawn do motor virou `spawn claude ENOENT` — por
// SEIS DIAS, sem uma linha no journal, porque esse erro morre no console de um card. Nada media.
//
// ── O CONTRATO ────────────────────────────────────────────────────────────────────────────────
//
// Cada verificação devolve o que MEDIU (`observed`) mesmo quando passa — um relatório que só fala
// quando reprova não deixa provar que rodou, que é a lição que a auditoria de bind já aprendeu. E
// quando não passa, devolve `remedy`, que NOMEIA o conserto. Diagnóstico sem saída é fofoca.
//
// ── DUAS RESTRIÇÕES DE CONSTRUÇÃO, AS DUAS LOAD-BEARING ───────────────────────────────────────
//
// 1. NÃO IMPORTA `runner/config.ts`. `src/server/main.ts` chama este módulo no boot, e tudo que ele
//    alcança entra no bundle `dist/ah-server.mjs` (ver `bundle-guard.test.ts` — o único external é
//    `next`). `config.ts` arrasta o `yaml` e a árvore inteira de configuração de board. Por isso o
//    NOME do binário do Claude entra como SONDA (`claudeName`) em vez de leitura: quem tem a config
//    passa o valor, quem não tem recebe o default — e o `observed` DIZ que usou o default, para a
//    divergência ficar visível em vez de silenciosa.
//
// 2. NUNCA RECUSA O BOOT. É o grão do `main.ts`, escrito lá nas palavras dele: derrubar o serviço
//    por credencial fraca em loopback "custaria a capacidade inteira do agente sem fechar porta
//    nenhuma". Vale igual aqui — recusar por um `claude` ausente tiraria do ar o board, a leitura de
//    cards, a superfície MCP e a própria capacidade do operador de CONSERTAR, em troca de impedir
//    runs que já não rodariam. O fail-closed mora no sítio de spawn (`runner/claude-bin.ts`), onde
//    a consequência está.

import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { resolveClaudeBinVerdict } from "./runner/claude-bin";
import { HOST_TOOL_ENV, lookupOnPath, resolveHostTool } from "./runner/host-tools";
import { NAMESPACE_PROBE } from "./runner/autonomy-sandbox";
import {
  caminhosAusentes,
  classificarUnits,
  podeReiniciar,
  type UnitMedida,
  unidadesComExistenciaMedida,
} from "./cutover-checks";
import { CONTRATO_DE_ENV, chavesFaltantes } from "./env-contract";
import { ROOT_MARKERS } from "./paths";

export type CheckStatus = "ok" | "degraded" | "missing" | "unknown";

export interface PreflightCheck {
  /** estável, e é a chave que a skill de onboarding usa para casar item ↔ conserto. */
  id: string;
  /** o que ele mede, em uma linha. */
  title: string;
  status: CheckStatus;
  /** o VALOR visto — preenchido inclusive quando passa. */
  observed: string;
  /** presente sse `status !== "ok"`; NOMEIA o conserto. */
  remedy?: string;
}

export interface PreflightReport {
  checks: PreflightCheck[];
  /** o pior status do conjunto — é nisto que um chamador deve ramificar. */
  worst: CheckStatus;
}

export interface ProbeResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PreflightProbes {
  /** As units do systemd e os caminhos ABSOLUTOS que elas citam. Ausente ⇒ o check não opina (não é
   *  "passou": é "não medi"), porque nem todo host tem systemd e um verde por ausência mentiria. */
  unidades?: readonly UnitMedida[] | null;
  /** O prefixo do PACOTE da ferramenta dentro do alvo — o que deixa de existir quando ela muda de árvore. */
  pacoteDaFerramentaNoAlvo?: string | null;
  /** Estado do motor para o veredito de reinício. Ausente ⇒ o check não opina. */
  reinicio?: { runsAtivos: number; filaEsperando: number; boardsArmados: readonly string[] } | null;
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
  /** o modo (octal) de um caminho, ou null se não der para ler. */
  statMode?: (p: string) => number | null;
  /** roda um comando; null ⇒ a sonda não pôde rodar (vira `unknown`, nunca `ok`). */
  run?: (cmd: string, args: string[]) => ProbeResult | null;
  /** a raiz do repositório já resolvida — evita arrastar a resolução para o boot duas vezes. */
  repoRoot?: string | null;
  /** versões correntes; ausentes ⇒ `unknown`. */
  versions?: { node?: string; bun?: string };
  platform?: NodeJS.Platform;
  /** a porta está ocupada? null ⇒ não deu para medir (vira `unknown`, nunca `ok`). */
  portaOcupada?: (host: string, porta: number) => boolean | null;
  /** euid do processo — root MASCARA a restrição de userns do Ubuntu 23.10+. */
  euid?: number;
  /**
   * De ONDE veio o `env` medido. É a diferença entre um diagnóstico que teria pego o incidente de
   * 2026-08-20 e um que teria dito verde durante os seis dias: o PATH do SHELL do operador quase
   * sempre alcança o `claude`; o PATH que o unit do systemd FIXA quase sempre não. Medir o do
   * shell e reportar como se fosse o do serviço é a vacuidade mais cara possível aqui.
   */
  envSource?: { kind: "servico"; pid: number } | { kind: "processo" };
  /**
   * O env DESTE processo, quando `env` for o do SERVIÇO. Existe só para o relatório poder dizer
   * QUANDO os dois divergem: sem ele, uma instância que sobe em 3044 lê «3008» e não descobre que a
   * linha fala do vizinho. Ausente ⇒ nenhuma comparação é feita (e nada é afirmado).
   */
  envDesteProcesso?: Record<string, string | undefined>;
  /**
   * Os ids de board que existem na RAIZ resolvida. Serve a UMA pergunta: esta raiz tem produto, ou
   * é um checkout da ferramenta ainda sem alvo? Ausente ⇒ a pergunta não é feita (e nada afirmado).
   */
  boardsNaRaiz?: readonly string[];
  /**
   * O motor está declaradamente INERTE (`STORYMAP_ENGINE=off`)? Um motor inerte NÃO escreve
   * `service.lock` — por desenho —, e é o lock que a detecção de serviço vivo lê. Sem esta sonda o
   * relatório cobra um serviço que a própria postura segura proíbe existir.
   */
  motorInerte?: boolean;
  /**
   * `settings.autorun.claudeBin`. Ausente ⇒ o default `"claude"`, e o `observed` DIZ que foi o
   * default. Ver a restrição 1 no topo.
   */
  claudeName?: string;
}

/** O piso declarado em `package.json#engines`. Duplicar aqui é ruim; medir contra nada é pior. */
export const NODE_FLOOR_MAJOR = 20;

const PIOR: Record<CheckStatus, number> = { ok: 0, degraded: 1, unknown: 2, missing: 3 };

function pior(a: CheckStatus, b: CheckStatus): CheckStatus {
  return PIOR[b] > PIOR[a] ? b : a;
}

function daRegua(
  id: string,
  title: string,
  r: { ok: true; path: string; via: string } | { ok: false; refusal: string },
): PreflightCheck {
  return r.ok
    ? { id, title, status: "ok", observed: `${r.path} (via ${r.via})` }
    : { id, title, status: "missing", observed: "não resolve", remedy: r.refusal };
}

/**
 * A medição. PURA sobre as sondas injetadas — o teste exercita a árvore inteira sem tocar no disco
 * nem no PATH da máquina que roda a suíte.
 */
/**
 * Os boards que o ARTEFATO já traz — fixtures de demonstração, não produto de ninguém. A lista é
 * pequena e nominal de propósito: ela descreve o que ESTE repositório publica, e é justamente por
 * não ser derivada do alvo que ela serve para dizer «aqui não há produto nenhum».
 */
const BOARDS_DE_FIXTURE = new Set(["demo", "demo-legado", "_base"]);

export function runPreflight(probes: PreflightProbes = {}): PreflightReport {
  const env = probes.env ?? process.env;
  const exists = probes.exists ?? existsSync;
  const run = probes.run;
  const raiz = probes.repoRoot ?? null;
  const checks: PreflightCheck[] = [];
  const fonte = probes.envSource ?? { kind: "processo" as const };
  const rotuloDoEnv =
    fonte.kind === "servico"
      ? `o ambiente do SERVIÇO VIVO (pid ${fonte.pid})`
      : "o ambiente DESTE processo";

  // O primeiro item é O QUE FOI MEDIDO. Sem ele o relatório inteiro é ambíguo: um `claude` que
  // resolve no shell do operador e não no PATH que o unit FIXA produz exatamente o mesmo verde.
  //
  // TRÊS CATEGORIAS, e não duas. A terceira nasceu de uma armadilha CIRCULAR medida em 2026-08-28,
  // numa simulação de adoção: o item mandava «suba o serviço e meça de novo», o adotante subia — na
  // ÚNICA postura segura para uma instância nova, `STORYMAP_ENGINE=off` — e continuava `degraded`.
  // A causa é estrutural: a detecção de serviço vivo lê o `service.lock`, e o motor inerte declara
  // que NÃO o escreve. Pior: o próprio serviço de produção imprime a mesma queixa no boot dele,
  // porque o preflight roda antes de o motor armar. Um item que ninguém consegue satisfazer não é
  // rigor — é ruído, e ruído treina o leitor a ignorar o relatório inteiro.
  checks.push(
    fonte.kind === "servico"
      ? { id: "env.source", title: "de qual ambiente este relatório fala", status: "ok", observed: rotuloDoEnv }
      : probes.motorInerte === true
        ? {
            id: "env.source",
            title: "de qual ambiente este relatório fala",
            status: "ok",
            observed: `${rotuloDoEnv} — motor INERTE por declaração, e um motor inerte não escreve service.lock`,
            remedy:
              "não há serviço vivo para medir, e isso é o ESPERADO nesta postura (`STORYMAP_ENGINE=off`) — " +
              "não uma pendência. Quando você ARMAR o motor, meça de novo: aí o relatório passa a falar do " +
              "PATH que o unit fixa, que é o veredito que decide se os agentes sobem.",
          }
        : {
          id: "env.source",
          title: "de qual ambiente este relatório fala",
          status: "degraded",
          observed: rotuloDoEnv,
          remedy:
            "nenhum serviço vivo foi encontrado, então as ferramentas do host foram procuradas no PATH " +
            "DESTE processo. O PATH de um shell quase sempre alcança mais que o PATH que um unit do " +
            "systemd FIXA — foi assim que o `spawn claude ENOENT` sobreviveu seis dias com o binário " +
            "visível no terminal do dono. Suba o serviço e meça de novo para o veredito que vale.",
        },
  );

  // ── AS FERRAMENTAS DO HOST ────────────────────────────────────────────────────────────────────
  const nomeClaude = probes.claudeName?.trim();
  const vClaude = resolveClaudeBinVerdict({ name: nomeClaude, env, exists });
  const cClaude = daRegua("host.claude", "o CLI do Claude Code, que TODO agente deste motor usa", vClaude);
  if (cClaude.status === "ok" && !nomeClaude) {
    // A divergência fica VISÍVEL: se o settings.yaml declarasse outro nome, esta medição não o viu.
    cClaude.observed += " — nome pelo default, não pelo settings.yaml";
  }
  checks.push(cClaude);
  checks.push(daRegua("host.bun", "o `bun` do build do self-deploy", resolveHostTool("bun", { env, exists })));
  checks.push(daRegua("host.just", "o `just` das receitas do repositório", resolveHostTool("just", { env, exists })));

  // ── A CONTENÇÃO ───────────────────────────────────────────────────────────────────────────────
  const plataforma = probes.platform ?? process.platform;
  if (plataforma === "darwin") {
    const sb = lookupOnPath("sandbox-exec", env, exists);
    checks.push(
      sb
        ? { id: "sandbox.bins", title: "a contenção por run", status: "ok", observed: `Seatbelt nativo (${sb})` }
        : {
            id: "sandbox.bins",
            title: "a contenção por run",
            status: "missing",
            observed: "sandbox-exec ausente do PATH",
            remedy: "sem `sandbox-exec` o CLI não monta o Seatbelt — todo run de autonomia plena REBAIXA e perde o Bash.",
          },
    );
  } else {
    const faltando = ["bwrap", "socat"].filter((b) => !lookupOnPath(b, env, exists));
    checks.push(
      faltando.length === 0
        ? { id: "sandbox.bins", title: "as dependências da contenção", status: "ok", observed: "bwrap e socat no PATH" }
        : {
            id: "sandbox.bins",
            title: "as dependências da contenção",
            status: "missing",
            observed: `faltam: ${faltando.join(", ")}`,
            remedy:
              "instale-as (`sudo apt install bubblewrap socat`, ou o equivalente da sua distro). Sem elas todo run " +
              "de autonomia plena REBAIXA em silêncio e perde o Bash — e o sintoma que você nota primeiro é um passo " +
              "falhando por falta de shell, nunca 'instale bubblewrap'.",
          },
    );

    // A SONDA, e não a presença do binário. Um bwrap instalado num Ubuntu 23.10+ ainda não sobe se o
    // kernel restringe user namespace não-privilegiado — e nesse host o conselho "instale as
    // dependências" está ERRADO: elas já estão instaladas.
    if (faltando.length > 0) {
      checks.push({
        id: "sandbox.userns",
        title: "o bwrap SOBE de verdade neste host",
        status: "unknown",
        observed: "não sondado — as dependências faltam",
        remedy: "resolva `sandbox.bins` primeiro; a sonda só diz algo com os binários presentes.",
      });
    } else if (!run) {
      checks.push({
        id: "sandbox.userns",
        title: "o bwrap SOBE de verdade neste host",
        status: "unknown",
        observed: "sonda não executada",
        remedy: "sem executar a sonda não dá para afirmar que a contenção sobe. Presença de binário não é prova.",
      });
    } else {
      const r = run(NAMESPACE_PROBE[0], [...NAMESPACE_PROBE.slice(1)]);
      const euid = probes.euid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
      if (r == null) {
        checks.push({
          id: "sandbox.userns",
          title: "o bwrap SOBE de verdade neste host",
          status: "unknown",
          observed: "a sonda não respondeu",
          remedy: "não foi possível medir. Um relatório que não mediu não pode dizer que está saudável.",
        });
      } else if (r.code !== 0) {
        checks.push({
          id: "sandbox.userns",
          title: "o bwrap SOBE de verdade neste host",
          status: "missing",
          observed: `a sonda falhou: ${(r.stderr || "").slice(0, 120)}`,
          remedy:
            "os binários estão presentes e mesmo assim o kernel recusa criar user namespace — é o caso do Ubuntu " +
            "23.10+, que restringe userns NÃO-PRIVILEGIADO por AppArmor. AQUI 'instale as dependências' é o conselho " +
            "ERRADO. As saídas estão medidas em `packages/storymap-ui/SECURITY.md`: o perfil AppArmor que o próprio " +
            "Ubuntu publica, ou `kernel.apparmor_restrict_unprivileged_userns=0`, ou rodar o serviço como root.",
        });
      } else if (euid === 0) {
        // Um verde que só vale para root é a vacuidade que este repositório já pagou uma vez.
        checks.push({
          id: "sandbox.userns",
          title: "o bwrap SOBE de verdade neste host",
          status: "degraded",
          observed: "a sonda passa, mas este processo é root",
          remedy:
            "root MASCARA a restrição de userns do Ubuntu 23.10+: este verde não prevê um serviço rodando como " +
            "não-root. Se você pretende rodar sem ser root, meça de novo com o usuário do serviço.",
        });
      } else {
        checks.push({
          id: "sandbox.userns",
          title: "o bwrap SOBE de verdade neste host",
          status: "ok",
          observed: `a sonda sobe (euid ${euid ?? "?"})`,
        });
      }
    }
  }

  // ── O GIT ─────────────────────────────────────────────────────────────────────────────────────
  const gitBin = lookupOnPath("git", env, exists);
  checks.push(
    gitBin
      ? { id: "git.present", title: "o `git`", status: "ok", observed: gitBin }
      : {
          id: "git.present",
          title: "o `git`",
          status: "missing",
          observed: "ausente do PATH",
          remedy: "instale o git — o motor cria worktrees, commita e integra pelo merge train.",
        },
  );

  // O motor COMMITA (merge train, split de board-data, resgate de worktree). Sem identidade, o
  // `git commit` falha no ponto de não-retorno, com uma mensagem que não fala do AgileHarness.
  if (!run || !gitBin) {
    checks.push({
      id: "git.identity",
      title: "a identidade que assina os commits do motor",
      status: "unknown",
      observed: run ? "git ausente" : "sonda não executada",
      remedy: "não medido. O motor commita — sem `user.name` e `user.email` isso falha no meio de uma integração.",
    });
  } else {
    const nome = run("git", ["config", "--get", "user.name"]);
    const mail = run("git", ["config", "--get", "user.email"]);
    const temNome = !!nome && nome.code === 0 && nome.stdout.trim().length > 0;
    const temMail = !!mail && mail.code === 0 && mail.stdout.trim().length > 0;
    checks.push(
      temNome && temMail
        ? {
            id: "git.identity",
            title: "a identidade que assina os commits do motor",
            status: "ok",
            observed: `${nome!.stdout.trim()} <${mail!.stdout.trim()}>`,
          }
        : {
            id: "git.identity",
            title: "a identidade que assina os commits do motor",
            status: "missing",
            observed: `user.name=${temNome ? "ok" : "vazio"}, user.email=${temMail ? "ok" : "vazio"}`,
            remedy:
              'declare as duas: `git config --global user.name "<nome>"` e ' +
              '`git config --global user.email "<email>"`. O motor commita sozinho (merge train, split de ' +
              "board-data, resgate de worktree) e sem identidade isso falha no meio da integração.",
          },
    );
  }

  // ── O REPOSITÓRIO ALVO ────────────────────────────────────────────────────────────────────────
  //
  // A RAIZ VERDE NO CASO PERIGOSO — medido em 2026-08-28, num clone virgem do artefato: o relatório
  // dizia `ok repo.root /root/agileharness` e seguia satisfeito. O clone satisfaz os três marcadores
  // EM SI MESMO, então sem alvo declarado o `register_board` teria criado um board para a PRÓPRIA
  // FERRAMENTA — e todo passo seguinte teria sucedido contra a árvore errada, em silêncio.
  //
  // O `SKILL.md` avisa disso com todas as letras. A FERRAMENTA não avisava, e é ela que o adotante
  // executa. Uma checagem que decide QUAL ÁRVORE não pode ficar verde justamente quando a resposta
  // é quase certamente errada.
  //
  // O SINAL É DERIVADO, nunca um nome: a raiz não tem board de produto — só os que o artefato JÁ
  // TRAZ como fixture. Um monorepo que hospeda a ferramenta e tem os boards dele continua `ok`
  // (é o caso legítimo); um clone recém-baixado, não.
  const semAlvoDeclarado = !(env.STORYMAP_TARGET ?? "").trim();
  // ── O CONTRATO DE AMBIENTE ────────────────────────────────────────────────────────────────────────
  // As chaves load-bearing chegam pelo `.env.local` da WorkingDirectory. Trocá-la — o cutover da
  // inversão — deixa o arquivo para trás, e cada consumidor degrada SOZINHO e em silêncio: o settle do
  // self-deploy para de autenticar, o push morre sem caminho de volta, o autopush desliga. Nenhuma
  // dessas falhas emite erro. Por isso a resposta não é "lembre de copiar o arquivo": é medir, e NOMEAR
  // o que cada ausência apaga. `env-contract.ts` é a tabela; aqui é só a leitura.
  // ── AS UNITS CRAVADAS NUM CAMINHO LITERAL ─────────────────────────────────────────────────────────
  // O plano do cutover falava de UMA unit. Medindo, são cinco e três timers — e duas estavam quebradas
  // havia semanas sem ninguém ver, porque nada observa esta camada. Toda unit que aponta para o PACOTE
  // DA FERRAMENTA dentro do alvo resolve hoje por acidente de topologia, e deixa de resolver no
  // instante em que a ferramenta muda de árvore.
  if (probes.unidades != null && raiz && probes.pacoteDaFerramentaNoAlvo) {
    const classificadas = classificarUnits(probes.unidades, {
      raizDoAlvo: raiz,
      pacoteDaFerramentaNoAlvo: probes.pacoteDaFerramentaNoAlvo,
    });
    const perigosas = classificadas.filter((c) => c.coluna === "ferramenta-no-alvo");
    checks.push(
      // ZERO unidades NÃO é aprovação — é ausência de medição. Uma máquina que serve isto tem, no
      // mínimo, a unit do próprio serviço citando esta árvore; medir zero significa que a varredura
      // não alcançou (`/etc/systemd/system` inacessível), ou que esta raiz não é a que as units
      // apontam (um worktree, um checkout paralelo). Reportar `ok` aqui seria o verde por vacuidade
      // que este relatório inteiro existe para não emitir.
      classificadas.length === 0
        ? {
            id: "host.units",
            title: "as units que citam caminho desta árvore",
            status: "unknown",
            observed: `${probes.unidades.length} unit(s) lida(s), nenhuma citando ${raiz}`,
            remedy:
              "não é aprovação: é ausência de medição. Ou o host não usa systemd, ou esta raiz não é a " +
              "que as units apontam (um worktree, um checkout paralelo). Rode do checkout que o serviço " +
              "serve para o inventário valer.",
          }
        : perigosas.length === 0
        ? {
            id: "host.units",
            title: "as units que citam caminho desta árvore",
            status: "ok",
            observed: `${classificadas.length} caminho(s) em ${probes.unidades.length} unit(s); nenhum aponta para o pacote da ferramenta`,
          }
        : {
            id: "host.units",
            title: "as units que citam caminho desta árvore",
            status: "degraded",
            observed: perigosas.map((c) => `${c.unit} → ${c.caminho}`).join("; "),
            remedy:
              "cada uma acima aponta para o PACOTE DA FERRAMENTA dentro do repositório-alvo. Hoje resolve; " +
              "no dia em que a ferramenta rodar de outro checkout, essas units seguem apontando para a " +
              "cópia que ficou. Adjudique uma a uma: ou o caminho passa a ser o da ferramenta, ou a unit " +
              "é declarada como config do HOST e o arquivo dela deixa de ser da ferramenta.",
          },
    );
  }

  // ── AS UNITS AINDA APONTAM PARA ALGO QUE EXISTE? ──────────────────────────────────────────────────
  // Pergunta DIFERENTE da de cima, e sobre hoje: `host.units` pergunta "o que quebra no cutover";
  // esta pergunta "o que JÁ está quebrado". Duas units desta caixa ficaram assim por semanas — o
  // systemd só reclama de `ExecStart` inexistente na hora em que alguém a inicia, e um timer noturno
  // falha sozinho sem nenhum sinal. Honra o `-` do systemd: ausência declarada não é defeito.
  if (probes.unidades != null && probes.unidades.length > 0) {
    const medidas = unidadesComExistenciaMedida(probes.unidades);
    const ausentes = caminhosAusentes(probes.unidades);
    checks.push(
      medidas === 0
        ? {
            id: "host.unitPaths",
            title: "os caminhos que as units exigem existem",
            status: "unknown",
            observed: `${probes.unidades.length} unit(s) lida(s), nenhuma com existência medida`,
            remedy:
              "não é aprovação: é ausência de medição. A sonda desta versão não preencheu o campo — " +
              "verde aqui seria uma afirmação que ninguém fez.",
          }
        : ausentes.length === 0
          ? {
              id: "host.unitPaths",
              title: "os caminhos que as units exigem existem",
              status: "ok",
              observed: `${medidas} unit(s) medida(s); todo caminho exigido existe`,
            }
          : {
              id: "host.unitPaths",
              title: "os caminhos que as units exigem existem",
              status: "degraded",
              observed: ausentes.map((c) => `${c.unit} → ${c.caminho}`).join("; "),
              remedy:
                "cada caminho acima é EXIGIDO por uma unit e não existe. A unit falha na próxima vez " +
                "que alguém a iniciar — e se for um timer, ela já vem falhando sem ninguém ver. Ou o " +
                "arquivo volta, ou a diretiva aponta para onde ele está, ou o systemd é informado de " +
                "que a ausência é aceitável com o prefixo `-` (`EnvironmentFile=-/caminho`).",
            },
    );
  }

  // ── DÁ PARA REINICIAR AGORA? ──────────────────────────────────────────────────────────────────────
  // Não existia procedimento de dreno escrito em lugar nenhum, e ninguém tinha perguntado "e se houver
  // três cards rodando?". O restart mata os filhos headless — o motor CONTA com isso, e o sweep de boot
  // os retoma. O perigo não é o run morrer: é morrer no mesmo instante em que o ledger que saberia
  // recuperá-lo é trocado.
  if (probes.reinicio != null) {
    const v = podeReiniciar(probes.reinicio);
    checks.push(
      v.seguro
        ? {
            id: "host.restartSafe",
            title: "é seguro reiniciar o serviço agora",
            status: "ok",
            observed: "nenhum run em voo, fila de merge vazia, nenhum board armado",
          }
        : {
            id: "host.restartSafe",
            title: "é seguro reiniciar o serviço agora",
            status: "degraded",
            observed: v.impedimentos.join("; "),
            remedy: v.comoDrenar.join(" · "),
          },
    );
  }

  const faltantes = chavesFaltantes(env);
  checks.push(
    faltantes.length === 0
      ? {
          id: "env.contract",
          title: "as chaves que sustentam o serviço",
          status: "ok",
          observed: `as ${CONTRATO_DE_ENV.length} chaves load-bearing do contrato estão presentes`,
        }
      : {
          id: "env.contract",
          title: "as chaves que sustentam o serviço",
          status: "degraded",
          observed: faltantes.map((f) => `${f.chave} (${f.motivo}) → ${f.desliga}`).join("; "),
          remedy:
            "cada uma acima desliga algo SEM emitir erro. Elas moram no `.env.local` da WorkingDirectory " +
            "(gitignorado, corretamente — são segredos), então trocar a WorkingDirectory as deixa para " +
            "trás. Mova-as À MÃO para o novo diretório, ou — melhor, porque sobrevive à próxima troca — " +
            "declare-as na unit do systemd (`Environment=` ou `EnvironmentFile=`). ATENÇÃO às chaves " +
            "VAPID: reutilize as MESMAS; gerar um par novo invalida as inscrições existentes.",
        },
  );

  const boards = probes.boardsNaRaiz;
  const soFixtures =
    boards != null && boards.length > 0 && boards.every((b) => BOARDS_DE_FIXTURE.has(b));
  const raizProvavelmenteErrada = raiz != null && semAlvoDeclarado && soFixtures;
  checks.push(
    raiz && raizProvavelmenteErrada
      ? {
          id: "repo.root",
          title: "a raiz do repositório alvo",
          status: "degraded",
          observed: `${raiz} — e ela só tem os boards que o próprio AgileHarness traz (${[...(boards ?? [])].sort().join(", ")})`,
          remedy:
            "esta raiz parece ser o CHECKOUT DA FERRAMENTA, não o seu produto: nenhum board seu existe aqui, " +
            "e nenhum `STORYMAP_TARGET` foi declarado. Registrar agora criaria um board PARA O AGILEHARNESS, e " +
            "todo passo seguinte sucederia contra a árvore errada. Se o seu repositório é outro, declare-o: " +
            "`STORYMAP_TARGET=/caminho/absoluto/da/raiz` (a RAIZ, nunca um subdiretório). Se você está mesmo " +
            "construindo o AgileHarness, isto é o esperado e pode seguir.",
        }
      : raiz
      ? { id: "repo.root", title: "a raiz do repositório alvo", status: "ok", observed: raiz }
      : {
          id: "repo.root",
          title: "a raiz do repositório alvo",
          status: "missing",
          observed: "não resolvida",
          remedy:
            `nenhum marcador de raiz encontrado (${ROOT_MARKERS.join(", ")}). Rode a partir de um checkout, ` +
            "ou declare a raiz em `STORYMAP_TARGET` — e ela precisa ser a RAIZ, não um subdiretório.",
        },
  );

  // `register_board` recusa sem isto, e a recusa dele já é boa. Aqui a mesma verdade aparece ANTES,
  // que é a diferença entre um adotante descobrir no primeiro comando ou no terceiro.
  if (raiz) {
    const base = path.join(raiz, "storymap", "boards", "_base", "board.yaml");
    checks.push(
      exists(base)
        ? { id: "repo.basePipeline", title: "a pipeline herdável", status: "ok", observed: base }
        : {
            id: "repo.basePipeline",
            title: "a pipeline herdável",
            status: "missing",
            observed: `ausente: ${base}`,
            remedy:
              "copie o `storymap/boards/_base/board.yaml` do repositório do AgileHarness para esta árvore. Sem ele " +
              "`register_board` RECUSA — um board registrado nasceria com ZERO status, aparecendo na listagem como " +
              "se estivesse pronto.",
          },
    );

    // Os segredos do runtime nascem aqui. `0600` os defende de outro usuário da máquina; o ignore os
    // defende do REPOSITÓRIO. Um segredo que entrou num commit é um segredo vazado.
    const runnerDir = path.join(raiz, "storymap", ".runner");
    if (!run || !gitBin) {
      checks.push({
        id: "runner.notTracked",
        title: "os segredos do runtime fora do git",
        status: "unknown",
        observed: "sonda não executada",
        remedy: "não medido. `storymap/.runner/` versionado é vazamento de credencial.",
      });
    } else {
      const ls = run("git", ["-C", raiz, "ls-files", "--", "storymap/.runner"]);
      const rastreados = ls && ls.code === 0 ? ls.stdout.trim() : "";
      checks.push(
        rastreados === ""
          ? { id: "runner.notTracked", title: "os segredos do runtime fora do git", status: "ok", observed: "nada versionado sob storymap/.runner/" }
          : {
              id: "runner.notTracked",
              title: "os segredos do runtime fora do git",
              status: "missing",
              observed: `${rastreados.split("\n").length} arquivo(s) versionado(s)`,
              remedy:
                "`storymap/.runner/` JÁ ESTÁ VERSIONADO — os segredos deste board estão num commit. Ignorar agora " +
                "NÃO os remove do histórico. Faça as DUAS metades: `git rm -r --cached storymap/.runner` E " +
                "ROTACIONE os segredos. Só a primeira metade deixa o repositório com cara de limpo e as credenciais " +
                "ainda válidas, que é pior que o estado original.",
            },
      );
    }

    const statMode = probes.statMode ?? ((p: string) => {
      try {
        return statSync(p).mode & 0o777;
      } catch {
        return null;
      }
    });
    const frouxos: string[] = [];
    for (const nome of ["auth-token", "session-secret", "mcp-token"]) {
      const alvo = path.join(runnerDir, nome);
      if (!exists(alvo)) continue;
      const m = statMode(alvo);
      if (m != null && (m & 0o077) !== 0) frouxos.push(`${nome} (${m.toString(8)})`);
    }
    checks.push(
      frouxos.length === 0
        ? { id: "runner.perms", title: "a permissão dos segredos do runtime", status: "ok", observed: "0600 onde existem" }
        : {
            id: "runner.perms",
            title: "a permissão dos segredos do runtime",
            status: "degraded",
            observed: `legível por outros: ${frouxos.join(", ")}`,
            remedy: `restrinja: \`chmod 600 ${runnerDir}/*\`. Qualquer um destes arquivos OPERA este board, e o board spawna agentes com poder de execução.`,
          },
    );
  }

  // ── A SUPERFÍCIE MCP ──────────────────────────────────────────────────────────────────────────
  // FECHADA é uma postura VÁLIDA, não uma configuração faltando: sem token o endpoint responde 404
  // nu, e `token-bootstrap.ts` documenta que nada gera um no boot de propósito. Por isso `ok`.
  const temToken = Object.keys(env).some((k) => k.startsWith("STORYMAP_MCP_TOKEN") && (env[k] ?? "").trim());
  checks.push({
    id: "mcp.surface",
    title: "a superfície MCP",
    status: "ok",
    observed: temToken ? "ARMADA (há credencial declarada no env)" : "FECHADA — nenhuma credencial declarada",
  });

  // ── A ORIGEM PÚBLICA ──────────────────────────────────────────────────────────────────────────
  // `packages/storymap-ui/SECURITY.md` chama `AGILEHARNESS_PUBLIC_URL` de OBRIGATÓRIA em qualquer
  // deploy alcançável de fora — e NADA a checava. Sem ela o portão de login redireciona para
  // `http://localhost:3008/login`, e o resultado é o pior tipo de falha: o serviço sobe, responde,
  // e NINGUÉM CONSEGUE ENTRAR. Ela também decide o `Secure` do cookie de sessão.
  //
  // Só cobra quando o bind NÃO é loopback: em loopback o default está correto e exigir a variável
  // seria ruído. Mesma régua da auditoria de bind — medir sempre, cobrar quando há exposição.
  const bindHost = (env.AGILEHARNESS_HOST ?? "").trim() || "127.0.0.1";
  const ehLoopback = /^(127\.|::1$|0:0:0:0:0:0:0:1$|\[?::1\]?$|localhost$)/i.test(bindHost);
  const publicUrl = (env.AGILEHARNESS_PUBLIC_URL ?? "").trim();
  checks.push(
    ehLoopback
      ? {
          id: "net.publicUrl",
          title: "a origem pública (só exigida fora do loopback)",
          status: "ok",
          observed: `bind em ${bindHost} — loopback, o default resolve`,
        }
      : publicUrl
        ? { id: "net.publicUrl", title: "a origem pública", status: "ok", observed: publicUrl }
        : {
            id: "net.publicUrl",
            title: "a origem pública",
            status: "missing",
            observed: `bind em ${bindHost} (fora do loopback) e AGILEHARNESS_PUBLIC_URL vazia`,
            remedy:
              "declare `AGILEHARNESS_PUBLIC_URL=https://<seu-dominio>`. Sem ela o portão de login manda o " +
              "navegador para http://localhost:3008/login — o serviço sobe, responde, e ninguém consegue " +
              "entrar. Ela também decide o atributo Secure do cookie de sessão.",
          },
  );

  // ── A PORTA ───────────────────────────────────────────────────────────────────────────────────
  //
  // DE QUEM É ESTA PORTA. `env` é o do SERVIÇO quando existe um vivo — é isso que faz o relatório
  // falar do processo que de fato spawna agentes. Mas a porta é a única linha em que essa escolha
  // ENGANA quem está subindo uma instância AO LADO: medido em 2026-08-27, uma instância de paridade
  // com `AGILEHARNESS_PORT=3044` leu «127.0.0.1:3008» e não tinha como saber que a linha era sobre o
  // vizinho. Quando as duas divergem, o relatório DIZ — porque uma medição sobre outro processo,
  // apresentada sem etiqueta, é pior que nenhuma.
  const porta = Number(env.AGILEHARNESS_PORT || env.PORT) || 3008;
  const envProprio = probes.envDesteProcesso;
  const portaPropria = envProprio ? Number(envProprio.AGILEHARNESS_PORT || envProprio.PORT) || 3008 : null;
  const divergePorta = fonte.kind === "servico" && portaPropria != null && portaPropria !== porta;
  const deQuem = divergePorta ? ` — a porta do SERVIÇO VIVO (pid ${fonte.pid}), não a deste processo (${portaPropria})` : "";
  const conselhoDivergencia = divergePorta
    ? ` ESTA LINHA NÃO É SOBRE VOCÊ: você sobe em ${portaPropria}; o relatório mede ${porta} porque lê o ` +
      `ambiente do serviço vivo. Para medir a SUA porta, rode o preflight sem um serviço vivo no alvo.`
    : "";
  const ocupada = probes.portaOcupada?.(bindHost, porta) ?? null;
  checks.push(
    ocupada == null
      ? { id: "net.port", title: "a porta do serviço", status: "unknown", observed: `${bindHost}:${porta}${deQuem} — não sondada` }
      : ocupada
        ? {
            id: "net.port",
            title: "a porta do serviço",
            status: "degraded",
            observed: `${bindHost}:${porta}${deQuem} JÁ está ocupada`,
            remedy:
              "se for o próprio AgileHarness, isto é o esperado e não há o que fazer. Se for outro processo, " +
              "o boot vai morrer com EADDRINUSE — escolha outra porta em `AGILEHARNESS_PORT`." +
              conselhoDivergencia,
          }
        : { id: "net.port", title: "a porta do serviço", status: "ok", observed: `${bindHost}:${porta}${deQuem} livre` },
  );

  // ── O settings.yaml ───────────────────────────────────────────────────────────────────────────
  // AUSENTE é válido (o motor cai nos defaults). MALFORMADO é o problema, e ele é MUDO: o leitor
  // engole a exceção e devolve os defaults, então uma vírgula errada reverte silenciosamente TODOS
  // os botões — concorrência, timeouts, cotas de lane, merge gate, fila de publicação.
  //
  // A checagem roda o parser num SUBPROCESSO de propósito: importar o parser aqui o arrastaria para
  // dentro de `dist/ah-server.mjs` (medido: hoje ele NÃO está lá), e este módulo é chamado no boot.
  //
  // O MÓDULO É `js-yaml`, e por DOIS motivos medidos num clone limpo do artefato (2026-08-27):
  //   1. `yaml` NÃO é dependência declarada. Ele existe no monorepo de origem só por hoisting de um
  //      vizinho, então a sonda passava AQUI e falhava em TODA instalação limpa — isto é, na de todo
  //      usuário. E falhava mentindo na pior direção: `MODULE_NOT_FOUND` virava "YAML inválido",
  //      mandando o adotante consertar um arquivo que estava correto.
  //   2. O motor lê o settings.yaml com `js-yaml` (22 importes). Uma sonda que mede outro parser
  //      pode ficar verde com um arquivo que o motor recusa, e vermelha com um que ele aceita —
  //      medir o vizinho do que importa é pior que não medir.
  // A API difere: `js-yaml` é `load()`, o `yaml` era `parse()`.
  if (raiz) {
    const alvoSettings = path.join(raiz, "storymap", "settings.yaml");
    if (!exists(alvoSettings)) {
      checks.push({
        id: "config.settings",
        title: "o settings.yaml",
        status: "ok",
        observed: "ausente — o motor usa os defaults, que é uma postura válida",
      });
    } else if (!run) {
      checks.push({
        id: "config.settings",
        title: "o settings.yaml",
        status: "unknown",
        observed: "presente, mas não foi possível validá-lo",
        remedy: "não medido. Um settings.yaml malformado reverte TODOS os botões em silêncio.",
      });
    } else {
      const r = run(process.execPath, [
        "-e",
        "require('js-yaml').load(require('fs').readFileSync(process.argv[1],'utf8'))",
        alvoSettings,
      ]);
      checks.push(
        r == null
          ? { id: "config.settings", title: "o settings.yaml", status: "unknown", observed: "a sonda não respondeu" }
          : r.code === 0
            ? { id: "config.settings", title: "o settings.yaml", status: "ok", observed: `${alvoSettings} parseia` }
            : {
                id: "config.settings",
                title: "o settings.yaml",
                status: "missing",
                observed: `YAML inválido: ${(r.stderr || "").split("\n").find((l) => l.trim()) ?? "erro de parse"}`.slice(0, 200),
                remedy:
                  "conserte o YAML. Enquanto ele estiver torto o motor engole o erro e volta a TODOS os " +
                  "defaults — concorrência, timeouts, cotas de lane, merge gate e fila de publicação — sem " +
                  "nada aparecer no rosto. É indistinguível de não ter arquivo nenhum.",
              },
      );
    }
  }

  // ── AS VERSÕES ───────────────────────────────────────────────────────────────────────────────
  const nodeV = probes.versions?.node ?? process.versions.node;
  const major = Number.parseInt((nodeV ?? "").split(".")[0] ?? "", 10);
  checks.push(
    Number.isFinite(major) && major >= NODE_FLOOR_MAJOR
      ? { id: "runtime.node", title: "a versão do Node", status: "ok", observed: `v${nodeV}` }
      : {
          id: "runtime.node",
          title: "a versão do Node",
          status: Number.isFinite(major) ? "missing" : "unknown",
          observed: nodeV ? `v${nodeV}` : "não medida",
          remedy: `este pacote declara Node >= ${NODE_FLOOR_MAJOR} em package.json#engines.`,
        },
  );

  const bunV = probes.versions?.bun ?? (run ? (run("bun", ["--version"])?.stdout ?? "").trim() : "");
  checks.push(
    bunV
      ? { id: "runtime.bun", title: "a versão do Bun", status: "ok", observed: `v${bunV}` }
      : {
          id: "runtime.bun",
          title: "a versão do Bun",
          status: run ? "missing" : "unknown",
          observed: run ? "não respondeu" : "não medida",
          remedy: "o Bun constrói o servidor (`bun run build`). Instale-o, ou declare o caminho em `AGILEHARNESS_BUN`.",
        },
  );

  return { checks, worst: checks.reduce<CheckStatus>((acc, c) => pior(acc, c.status), "ok") };
}

const SINAL: Record<CheckStatus, string> = { ok: "OK  ", degraded: "~~  ", missing: "!!  ", unknown: "??  " };

/**
 * O bloco humano. Vazio quando está TUDO ok — quem chama imprime a linha afirmativa de PASS, pela
 * mesma razão que a auditoria de bind imprime a dela: uma auto-checagem que só fala quando reprova
 * não deixa provar que rodou.
 */
export function preflightMessage(r: PreflightReport): string {
  const ruins = r.checks.filter((c) => c.status !== "ok");
  if (ruins.length === 0) return "";
  const linhas = [
    `[ah-server] preflight: ${ruins.length} de ${r.checks.length} verificação(ões) de ambiente NÃO passaram.`,
  ];
  for (const c of ruins) {
    linhas.push(`  ${SINAL[c.status]}${c.id} — ${c.title}`);
    linhas.push(`        medido: ${c.observed}`);
    if (c.remedy) linhas.push(`        conserto: ${c.remedy}`);
  }
  linhas.push("  Isto NÃO impede o boot: o board segue servindo, e é dele que você conserta o resto.");
  return linhas.join("\n");
}
