// O REAPER ENXERGA UM SERVIDOR DO HARNESS ABANDONADO — e NÃO o mata sem ser mandado.
//
// O DEFEITO MEDIDO (2026-08-12): instâncias do servidor sobreviviam por DIAS, a até ~1,4 GB cada, e o
// reaper rodava a cada disparo do timer reportando `candidates=0`. Não era falso negativo de matching:
// a classe inteira estava FORA do radar — a argv `node dist/ah-server.mjs` não casava o allow-list de
// caça nem a lista de nunca-tocar. Proteção por acidente, que é a que some quando alguém mexe.
//
// POR QUE A PROVA USA PROCESSO DE VERDADE: o script decide lendo `/proc/<pid>/cgroup` e
// `/proc/<pid>/status`. Um `ps` dublado enganaria a primeira metade da decisão e deixaria a segunda
// sem sujeito — a prova mediria o dublê, não o script. Aqui nascem processos reais, com a argv real,
// e o `afterEach` mata o que criou (a disciplina de órfãos desta casa vale para os testes dela).
//
// O DISCRIMINADOR É O CGROUP, E ISSO CUSTOU UMA VERSÃO ERRADA — vale registrar por quê. A primeira
// regra exigia PPID==1, e ela procurava o processo errado: quem fica órfão é o WRAPPER (`bun run
// dev`), mas a memória está no FILHO, que TEM pai vivo. Numa máquina com o problema exato que o
// passe existe para achar, ela reportava zero. Só apareceu porque a medição foi feita contra um caso
// real em vez de contra a ideia dele.
//
// O PAR QUE TORNA ISTO DISCRIMINANTE está em quatro eixos, e nenhum é opcional:
//   1. um servidor FORA do systemd é reportado × o de PRODUÇÃO (system.slice) NÃO é — e o controle
//      aqui é o processo de produção DE VERDADE, não uma imitação dele;
//   2. por default ele CONTINUA VIVO depois do reaper × com `--reap-servers` ele morre;
//   3. argv de outra coisa não é reportada (senão o filtro estaria pegando tudo);
//   4. mais novo que a janela não é reportado (senão a janela seria decorativa).
//
// O SEGUNDO DEFEITO, MEDIDO EM 2026-08-25, é do TESTE e não do script: o sujeito da prova tinha o
// cgroup HERDADO de quem roda a suíte. Um processo nascido aqui fica onde o runner estiver — e o
// discriminador do reaper é exatamente o cgroup. Rodando de um tmux (`/user.slice/…/tmux-spawn-*.scope`)
// o falso servidor é reportado e as provas passam; rodando pelo GATE DO MERGE TRAIN, que é filho de
// `storymap.service`, ele nasce em `/system.slice/storymap.service` — e o reaper, CORRETAMENTE, pula um
// processo por quem o systemd responde. Duas provas ficavam vermelhas com a mensagem "o reaper não
// enxergou o servidor órfão", que acusa o script por um defeito do instrumento.
//
// Isso lia como flake — falhava no train, passava em isolamento — e não era: era DETERMINÍSTICO por
// POSTURA. Reproduzido nos dois sentidos: um `systemd-run --unit=…` com a argv do servidor não aparece
// no relatório; movido para um cgroup fora de `system.slice`, aparece na hora. Um teste que só passa
// no ambiente onde ele foi escrito não mediu a propriedade, mediu o ambiente — é a mesma lição do CI do
// artefato, que rodava num host que violava o pré-requisito que o próprio artefato publica.
//
// O conserto é tornar o cgroup do sujeito EXPLÍCITO em vez de herdado (`foraDoSystemd`), e falhar com o
// diagnóstico certo quando não for possível.

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(process.cwd(), "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "ops", "reap-orphan-toolings.sh");

/**
 * O reaper é infra do DONO (`scripts/ops/` não viaja na extração), então no repositório extraído
 * este arquivo não tem sujeito. "Pular" seria vácuo-verde se pudesse acontecer aqui por acidente —
 * por isso o piso: sem o script, a árvore tem de ser comprovadamente uma que NÃO TEM `scripts/ops/`.
 * No umbrella, onde a pasta existe, um script ausente REPROVA em vez de pular.
 */
const TEM_SUJEITO = existsSync(SCRIPT);
const TEM_PASTA_OPS = existsSync(path.join(REPO_ROOT, "scripts", "ops"));

const vivos: number[] = [];
const cgroupsCriados: string[] = [];

/** A mesma pergunta que o script faz: o systemd responde por este processo? */
const CGROUP_GERENCIADO = /\/system\.slice\/[^/]+\.service/;
const cgroupDe = (pid: number): string => readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n")[0] ?? "";

/**
 * Põe o sujeito num cgroup que comprovadamente NÃO é `/system.slice/<unidade>.service`.
 *
 * O cgroup é HERDADO, e é ele que o reaper lê. Enquanto a suíte roda de um tmux isso acontecia por
 * ACIDENTE; sob o gate do merge train, que é filho de `storymap.service`, o sujeito nascia gerenciado e
 * o reaper o pulava — certo sobre o processo, e fatal para a prova. Controlar o cgroup é o que torna
 * esta prova independente de onde ela roda.
 *
 * NÃO é no-op onde já estava certo: quando o cgroup herdado não é de serviço, nada é criado nem movido
 * (o comportamento local segue idêntico). O cgroup criado é raso, some no `afterEach`, e existe pelos
 * segundos do teste — o preço de não mexer no cgroup de um serviço vivo para provar uma coisa sobre ele.
 */
function foraDoSystemd(pid: number): string {
  const herdado = cgroupDe(pid);
  if (!CGROUP_GERENCIADO.test(herdado)) return herdado;

  const dir = `/sys/fs/cgroup/ah-teste-reaper-${process.pid}-${pid}`;
  try {
    mkdirSync(dir, { recursive: true });
    cgroupsCriados.push(dir);
    writeFileSync(`${dir}/cgroup.procs`, String(pid));
  } catch (e) {
    throw new Error(
      `não consegui tirar o sujeito do cgroup de serviço (${herdado}): ${(e as Error).message}. ` +
        "Sem isso o reaper pula o processo — CORRETAMENTE, porque o systemd responde por ele — e a " +
        "prova reprovaria acusando o script de um defeito do instrumento.",
    );
  }
  const agora = cgroupDe(pid);
  if (CGROUP_GERENCIADO.test(agora)) {
    throw new Error(`o sujeito continua num cgroup gerenciado (${agora}) — a premissa da prova não vale aqui`);
  }
  return agora;
}

/**
 * Um processo com a argv de um servidor do harness. `orfao` decide se ele perde o pai.
 *
 * A argv leva um SUFIXO ÚNICO por chamada, e isso não é estética: a primeira versão procurava a argv
 * genérica no `ps` e encontrou um servidor REAL da máquina — o teste passou a falar de um processo
 * que não era dele. Um instrumento que pode confundir o próprio sujeito com um transeunte não mede o
 * que diz medir.
 */
let seq = 0;
function nasceServidorFalso(base: string, orfao: boolean): Promise<number> {
  const argv0 = `${base} --sonda-reaper-${process.pid}-${++seq}`;
  // `exec -a` reescreve o argv[0] — é assim que o processo fica indistinguível, no `ps`, de um
  // servidor de verdade, que é exatamente o que o script tem de reconhecer.
  const corpo = `exec -a ${JSON.stringify(argv0)} sleep 120`;
  const filho = orfao
    // setsid + o pai saindo na hora ⇒ o neto é reparentado ao init (PPID 1), que é a condição real.
    ? spawn("setsid", ["bash", "-c", corpo], { detached: true, stdio: "ignore" })
    : spawn("bash", ["-c", corpo], { stdio: "ignore" });
  filho.unref();
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const saida = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
      const linha = saida.split("\n").find((l) => l.includes(argv0) && !l.includes("bash -c"));
      const pid = Number(linha?.trim().split(/\s+/)[0] ?? 0);
      if (pid > 0) {
        vivos.push(pid);
        // O cgroup entra na prova como sujeito controlado, não como herança de quem rodou a suíte.
        // O `reject` não é cerimônia: lançar DENTRO do timer viraria exceção não tratada — o processo
        // do worker cai e a mensagem de diagnóstico, que é o valor inteiro deste conserto, se perde.
        try {
          foraDoSystemd(pid);
        } catch (e) {
          reject(e);
          return;
        }
      }
      resolve(pid);
    }, 700);
  });
}

function rodaReaper(args: string[] = [], soEstesPids: number[] = []): string {
  return execFileSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    // Sem esta janela zerada o teste teria de esperar 6 HORAS. O default de produção continua sendo
    // o do script; aqui a variável é o que torna a prova possível em segundos.
    // O ALVO É NOMEADO. Sem isto, provar "a morte funciona" numa máquina viva mata todo abandonado
    // que existir nela — foi o que aconteceu na primeira versão deste arquivo, e levou junto um
    // servidor que estava em uso. A prova continua sendo da MESMA capacidade; o que mudou é que ela
    // não alcança mais nada além do processo que este teste criou.
    env: {
      ...process.env,
      REAP_SERVER_GRACE_SECS: "0",
      ...(soEstesPids.length > 0 ? { REAP_ONLY_PIDS: soEstesPids.join(",") } : {}),
    },
  });
}

const estaVivo = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(async () => {
  while (vivos.length > 0) {
    const pid = vivos.pop() as number;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* já morreu — é o desfecho esperado de metade dos testes */
    }
  }
  // O kernel só remove cgroup VAZIO, e o processo morto ainda leva um instante para sair dele.
  if (cgroupsCriados.length > 0) await new Promise((r) => setTimeout(r, 150));
  while (cgroupsCriados.length > 0) {
    try {
      rmdirSync(cgroupsCriados.pop() as string);
    } catch {
      /* diretório de cgroup vazio é inerte; o nome carrega o pid da suíte para quem for varrer */
    }
  }
});

describe.skipIf(!TEM_SUJEITO)("o reaper e os servidores do harness abandonados", () => {
  it("REPORTA um servidor órfão — e NÃO o mata (matar um detached em uso é remoção de capacidade)", async () => {
    const pid = await nasceServidorFalso("node dist/ah-server.mjs", true);
    expect(pid, "o servidor falso não subiu — a prova não teria sujeito").toBeGreaterThan(0);

    const saida = rodaReaper();
    expect(saida, "o reaper não enxergou o servidor órfão").toContain(`pid=${pid}`);
    expect(saida).toMatch(/SERVIDOR ABANDONADO \(não matei\)/);
    expect(saida).toMatch(/servers=[1-9]/);

    // O PAR que carrega o argumento inteiro deste conserto: reportar não é matar.
    expect(estaVivo(pid), "o reaper MATOU um servidor detached sem ser mandado").toBe(true);
  });

  it("com --reap-servers ele mata — a capacidade existe, só não é o default", async () => {
    const pid = await nasceServidorFalso("node dist/ah-server.mjs", true);
    expect(pid).toBeGreaterThan(0);

    const saida = rodaReaper(["--reap-servers"], [pid]);
    expect(saida).toContain(`REAPED servidor abandonado: pid=${pid}`);
    await new Promise((r) => setTimeout(r, 400));
    expect(estaVivo(pid), "pediram para matar e ele sobreviveu").toBe(false);
  });

  it("o cgroup é o que decide, e a prova controla o dela — o defeito de 2026-08-25, nos dois sentidos", async () => {
    // A REGRESSÃO desta data em uma prova: durante meses estes casos passaram de um tmux e reprovaram
    // pelo gate do merge train, porque o sujeito HERDAVA o cgroup de quem rodava a suíte. Aqui o cgroup
    // de serviço é PLANTADO de propósito e depois desfeito, então o defeito fica medido em vez de
    // depender de onde a suíte roda. Sem systemd não há `.service` — e aí a classe de bug não existe.
    let temSystemd = true;
    try {
      execFileSync("systemd-run", ["--version"], { stdio: "ignore" });
    } catch {
      temSystemd = false;
    }
    if (!temSystemd) {
      expect(
        existsSync("/run/systemd/system"),
        "sem `systemd-run` mas COM systemd rodando: o plantio falhou e o caso ficaria sem sujeito",
      ).toBe(false);
      return;
    }

    const unidade = `ah-teste-reaper-${process.pid}-${++seq}`;
    const argv0 = `node dist/ah-server.mjs --sonda-cgroup-${process.pid}-${seq}`;
    execFileSync("systemd-run", ["--unit", unidade, "--quiet", "--collect", "bash", "-c", `exec -a ${JSON.stringify(argv0)} sleep 60`]);
    try {
      await new Promise((r) => setTimeout(r, 900));
      const linha = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" })
        .split("\n")
        .find((l) => l.includes(argv0) && !l.includes("bash -c"));
      const pid = Number(linha?.trim().split(/\s+/)[0] ?? 0);
      expect(pid, "a unidade transitória não subiu — o caso ficaria sem sujeito").toBeGreaterThan(0);
      vivos.push(pid);

      // SENTIDO 1 — num cgroup de serviço, o reaper NÃO o vê. É o comportamento certo do script, e era
      // a causa real da mensagem "o reaper não enxergou o servidor órfão".
      expect(cgroupDe(pid)).toMatch(CGROUP_GERENCIADO);
      expect(
        rodaReaper(),
        "o reaper reportou um processo por quem o systemd responde — o discriminador de cgroup caiu",
      ).not.toContain(`pid=${pid}`);

      // SENTIDO 2 — a MESMA argv, a MESMA idade, fora de `system.slice`: ele aparece. Só o cgroup mudou.
      foraDoSystemd(pid);
      expect(cgroupDe(pid)).not.toMatch(CGROUP_GERENCIADO);
      expect(
        rodaReaper(),
        "fora de system.slice o servidor abandonado tem de ser reportado — é a capacidade inteira",
      ).toContain(`pid=${pid}`);
    } finally {
      try {
        execFileSync("systemctl", ["stop", unidade], { stdio: "ignore" });
      } catch {
        /* --collect já a recolheu quando o processo saiu do cgroup dela */
      }
    }
  });

  it("o servidor de PRODUÇÃO (system.slice) NÃO é reportado — e o controle é o processo real", () => {
    // Este é o teste que carrega a segurança do conserto inteiro. Sem ele, tudo acima passaria com um
    // script que reportasse (e, com --reap-servers, MATASSE) o servidor que atende o dono.
    let prodPid = 0;
    try {
      const main = execFileSync("systemctl", ["show", "-p", "MainPID", "--value", "storymap.service"], {
        encoding: "utf8",
      }).trim();
      if (main && main !== "0") {
        const filhos = execFileSync("pgrep", ["-P", main], { encoding: "utf8" }).trim().split("\n");
        prodPid = Number(filhos[0] ?? 0);
      }
    } catch {
      prodPid = 0; // serviço não existe nesta máquina
    }
    if (prodPid === 0) {
      // Sem sujeito não há prova — e "pulou" NÃO pode virar verde silencioso. A asserção abaixo falha
      // se alguém rodar isto numa máquina onde o serviço existe mas a detecção quebrou.
      expect(
        existsSync("/etc/systemd/system/storymap.service") || existsSync("/lib/systemd/system/storymap.service"),
        "a unidade do serviço EXISTE mas não consegui achar o processo dela — o controle ficaria sem sujeito",
      ).toBe(false);
      return;
    }
    const cgroup = execFileSync("cat", [`/proc/${prodPid}/cgroup`], { encoding: "utf8" });
    expect(cgroup, "o processo de produção não está numa unidade do systemd — a premissa do teste caiu").toContain(
      ".service",
    );
    // Janela ZERO: mesmo com a peneira de idade totalmente aberta, produção não pode aparecer.
    expect(rodaReaper(), "o reaper reportou o servidor de PRODUÇÃO").not.toContain(`pid=${prodPid}`);
  });

  it("mais novo que a janela não é reportado — senão a janela seria decorativa", async () => {
    const pid = await nasceServidorFalso("node dist/ah-server.mjs", true);
    expect(pid).toBeGreaterThan(0);
    const saida = execFileSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, REAP_SERVER_GRACE_SECS: "86400" }, // 24h: o processo tem segundos
    });
    expect(saida, "reportou um servidor recém-nascido").not.toContain(`pid=${pid}`);
  });

  it("uma argv que não é servidor do harness não entra — o filtro filtra", async () => {
    const pid = await nasceServidorFalso("node dist/outra-coisa-qualquer.mjs", true);
    expect(pid).toBeGreaterThan(0);
    expect(rodaReaper(), "o filtro de argv está pegando qualquer processo").not.toContain(`pid=${pid}`);
  });

  it("o servidor do harness está na lista de NUNCA-TOCAR do passe de caça (proteção declarada, não acidental)", () => {
    const fonte = execFileSync("cat", [SCRIPT], { encoding: "utf8" });
    const keep = fonte.split("\n").find((l) => l.startsWith("KEEP_RE="));
    expect(keep, "KEEP_RE sumiu do script").toBeDefined();
    // Ele sobrevivia ao passe 1 só porque o REAP_RE não o alcançava. Uma proteção que depende de OUTRA
    // lista não ser alargada não é proteção.
    expect(keep, "`ah-server` não está protegido no passe de caça").toContain("ah-server");
  });
});

describe.skipIf(TEM_SUJEITO)("piso: pular só é legítimo na árvore que não tem o reaper", () => {
  it("sem o script, esta árvore também não tem `scripts/ops/` (senão o pulo esconderia um sumiço)", () => {
    expect(
      TEM_PASTA_OPS,
      `o reaper não está em ${SCRIPT}, mas scripts/ops/ existe — isto não é a árvore extraída, é um ` +
        "script que sumiu. Pular aqui transformaria o desaparecimento dele em silêncio verde.",
    ).toBe(false);
  });
});
