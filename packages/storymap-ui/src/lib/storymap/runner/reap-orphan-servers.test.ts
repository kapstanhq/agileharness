// CONTRATO DE UM "REAPER" DE PROCESSOS ABANDONADOS, medido com processos de verdade.
//
// Este arquivo não depende de nenhum script do repositório nem de serviço da máquina: o sujeito é um
// reaper MÍNIMO e inventado, escrito num diretório temporário pelo próprio teste (REAPER_FIXTURE). O que
// se mede é o contrato que qualquer reaper de sidecars precisa cumprir para ser seguro — e que um operador
// pode usar de régua contra o seu:
//
//   - quem é "gerenciado" se decide pelo CGROUP (`/proc/<pid>/cgroup`), nunca pelo PPID: o wrapper
//     abandonado não é quem segura a memória, o filho dele é, e o filho tem pai vivo;
//   - por default o reaper só RELATA; matar exige a flag `--reap-servers` E um alvo nomeado em
//     `REAP_ONLY_PIDS`, para que a prova da morte nunca alcance um processo que o teste não criou;
//   - a janela mínima de idade (`REAP_SERVER_GRACE_SECS`) e o filtro de argv têm de filtrar de verdade.
//
// Processos reais, e não um `ps` dublado, porque a decisão lê /proc: um dublê mediria o dublê. Cada sujeito
// leva um sufixo de argv único (senão a busca no `ps` pode achar o processo de um terceiro) e o
// `afterEach` mata o que nasceu aqui.
//
// O cgroup do sujeito é EXPLÍCITO em vez de herdado (`foraDoSystemd`). Um processo nasce no cgroup de quem
// roda a suíte; se a suíte roda sob uma unidade de serviço, o sujeito nasce "gerenciado" e é pulado —
// CORRETAMENTE —, e a prova reprovaria acusando o reaper de um defeito do instrumento.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** A argv que o reaper de fixture reconhece como "servidor". Qualquer outra é transeunte. */
const ARGV_SERVIDOR = "node dist/demo-server.mjs";

/**
 * Reaper mínimo no contrato acima. Imprime `SERVIDOR ABANDONADO (não matei): pid=N` por candidato,
 * `REAPED servidor abandonado: pid=N` quando mata, e fecha com `servers=K`.
 */
const REAPER_FIXTURE = String.raw`#!/usr/bin/env bash
set -u
grace="\${REAP_SERVER_GRACE_SECS:-21600}"
matar=0
[ "\${1:-}" = "--reap-servers" ] && matar=1
alvo=",\${REAP_ONLY_PIDS:-},"
achados=0
while read -r pid idade args; do
  [[ "$args" == *"dist/demo-server.mjs"* ]] || continue
  (( idade >= grace )) || continue
  cg=$(head -n1 "/proc/$pid/cgroup" 2>/dev/null) || continue
  [[ "$cg" =~ /system\.slice/[^/]+\.service ]] && continue
  achados=$((achados + 1))
  if [ "$matar" = 1 ] && [[ "$alvo" == *",$pid,"* ]]; then
    kill -9 "$pid" && echo "REAPED servidor abandonado: pid=$pid"
  else
    echo "SERVIDOR ABANDONADO (não matei): pid=$pid"
  fi
done < <(ps -eo pid=,etimes=,args=)
echo "servers=$achados"
`.replaceAll("\\${", "${");

let SCRIPT = "";
let dirFixture = "";

beforeAll(() => {
  dirFixture = mkdtempSync(path.join(os.tmpdir(), "ah-reaper-fixture-"));
  SCRIPT = path.join(dirFixture, "reaper.sh");
  writeFileSync(SCRIPT, REAPER_FIXTURE, { mode: 0o755 });
});

afterAll(() => {
  if (dirFixture) rmSync(dirFixture, { recursive: true, force: true });
});

const vivos: number[] = [];
const cgroupsCriados: string[] = [];

/** A mesma pergunta que o reaper faz: o systemd responde por este processo? */
const CGROUP_GERENCIADO = /\/system\.slice\/[^/]+\.service/;
const cgroupDe = (pid: number): string => readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n")[0] ?? "";

/**
 * Põe o sujeito num cgroup que comprovadamente NÃO é `/system.slice/<unidade>.service`.
 *
 * Quando o cgroup herdado já não é de serviço, nada é criado nem movido. Caso contrário nasce um cgroup
 * raso, que dura os segundos do teste e é removido no `afterEach`.
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
        "Sem isso o reaper pula o processo — corretamente — e a prova reprovaria por defeito do instrumento.",
    );
  }
  const agora = cgroupDe(pid);
  if (CGROUP_GERENCIADO.test(agora)) {
    throw new Error(`o sujeito continua num cgroup gerenciado (${agora}) — a premissa da prova não vale aqui`);
  }
  return agora;
}

/**
 * Um processo desacoplado cuja argv[0] é `base` + um sufixo único por chamada. `exec -a` reescreve o
 * argv[0], que é como ele fica indistinguível, no `ps`, de um servidor de verdade.
 */
let seq = 0;
function nasceProcesso(base: string): Promise<number> {
  const argv0 = `${base} --sonda-${process.pid}-${++seq}`;
  const filho = spawn("setsid", ["bash", "-c", `exec -a ${JSON.stringify(argv0)} sleep 120`], {
    detached: true,
    stdio: "ignore",
  });
  filho.unref();
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const saida = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
      const linha = saida.split("\n").find((l) => l.includes(argv0) && !l.includes("bash -c"));
      const pid = Number(linha?.trim().split(/\s+/)[0] ?? 0);
      if (pid > 0) {
        vivos.push(pid);
        // `reject` e não `throw`: lançar dentro do timer derrubaria o worker e perderia o diagnóstico.
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

function rodaReaper(args: string[] = [], opts: { alvo?: number[]; graca?: string } = {}): string {
  return execFileSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      // Sem zerar a janela o teste esperaria horas; o default do reaper segue sendo o dele.
      REAP_SERVER_GRACE_SECS: opts.graca ?? "0",
      ...(opts.alvo && opts.alvo.length > 0 ? { REAP_ONLY_PIDS: opts.alvo.join(",") } : {}),
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
    try {
      process.kill(vivos.pop() as number, "SIGKILL");
    } catch {
      /* já morreu — é o desfecho esperado de parte dos testes */
    }
  }
  // O kernel só remove cgroup VAZIO, e o processo morto ainda leva um instante para sair dele.
  if (cgroupsCriados.length > 0) await new Promise((r) => setTimeout(r, 150));
  while (cgroupsCriados.length > 0) {
    try {
      rmdirSync(cgroupsCriados.pop() as string);
    } catch {
      /* cgroup vazio é inerte; o nome carrega o pid da suíte para quem for varrer */
    }
  }
});

// /proc e cgroups são Linux; fora dele não há sujeito, e dizer isso é diferente de passar em branco.
describe.skipIf(process.platform !== "linux")("contrato do reaper de servidores abandonados", () => {
  it("relata um candidato mas NÃO o mata por default", async () => {
    const pid = await nasceProcesso(ARGV_SERVIDOR);
    expect(pid, "o processo de teste não subiu — a prova não teria sujeito").toBeGreaterThan(0);

    const saida = rodaReaper();
    expect(saida, "o reaper não enxergou o candidato").toContain(`pid=${pid}`);
    expect(saida).toMatch(/SERVIDOR ABANDONADO \(não matei\)/);
    expect(saida).toMatch(/servers=[1-9]/);
    expect(estaVivo(pid), "o reaper matou sem ser mandado").toBe(true);
  });

  it("com --reap-servers e o alvo nomeado, mata só esse processo", async () => {
    const alvo = await nasceProcesso(ARGV_SERVIDOR);
    const vizinho = await nasceProcesso(ARGV_SERVIDOR);
    expect(alvo).toBeGreaterThan(0);
    expect(vizinho).toBeGreaterThan(0);

    const saida = rodaReaper(["--reap-servers"], { alvo: [alvo] });
    expect(saida).toContain(`REAPED servidor abandonado: pid=${alvo}`);
    await new Promise((r) => setTimeout(r, 400));
    expect(estaVivo(alvo), "pediram para matar e ele sobreviveu").toBe(false);
    expect(estaVivo(vizinho), "matou um processo que não foi nomeado").toBe(true);
  });

  it("o cgroup decide, nos dois sentidos: sob uma unidade de serviço não aparece; fora dela, aparece", async () => {
    let temSystemd = true;
    try {
      execFileSync("systemd-run", ["--version"], { stdio: "ignore" });
    } catch {
      temSystemd = false;
    }
    if (!temSystemd) {
      // Sem `systemd-run` só vale se também não há systemd rodando; do contrário o plantio falhou.
      expect(existsSync("/run/systemd/system"), "há systemd rodando mas não há `systemd-run`").toBe(false);
      return;
    }

    const unidade = `ah-teste-reaper-${process.pid}-${++seq}`;
    const argv0 = `${ARGV_SERVIDOR} --sonda-cgroup-${process.pid}-${seq}`;
    execFileSync("systemd-run", ["--unit", unidade, "--quiet", "--collect", "bash", "-c", `exec -a ${JSON.stringify(argv0)} sleep 60`]);
    try {
      await new Promise((r) => setTimeout(r, 900));
      const linha = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" })
        .split("\n")
        .find((l) => l.includes(argv0) && !l.includes("bash -c"));
      const pid = Number(linha?.trim().split(/\s+/)[0] ?? 0);
      expect(pid, "a unidade transitória não subiu — o caso ficaria sem sujeito").toBeGreaterThan(0);
      vivos.push(pid);

      // Dentro de uma unidade de serviço REAL (a do processo que o systemd responde por), o reaper pula.
      expect(cgroupDe(pid)).toMatch(CGROUP_GERENCIADO);
      expect(rodaReaper(), "relatou um processo gerenciado — o discriminador de cgroup caiu").not.toContain(`pid=${pid}`);

      // Mesma argv, mesma idade, só o cgroup muda: agora aparece.
      foraDoSystemd(pid);
      expect(cgroupDe(pid)).not.toMatch(CGROUP_GERENCIADO);
      expect(rodaReaper(), "fora de system.slice o candidato tem de ser relatado").toContain(`pid=${pid}`);
    } finally {
      try {
        execFileSync("systemctl", ["stop", unidade], { stdio: "ignore" });
      } catch {
        /* --collect já a recolheu quando o processo saiu do cgroup dela */
      }
    }
  });

  it("mais novo que a janela não é relatado", async () => {
    const pid = await nasceProcesso(ARGV_SERVIDOR);
    expect(pid).toBeGreaterThan(0);
    const saida = rodaReaper([], { graca: "86400" }); // 24h: o processo tem segundos
    expect(saida, "relatou um processo recém-nascido").not.toContain(`pid=${pid}`);
  });

  it("uma argv que não é de servidor não entra — o filtro filtra", async () => {
    const pid = await nasceProcesso("node dist/qualquer-outro-binario.mjs");
    expect(pid).toBeGreaterThan(0);
    expect(rodaReaper(), "o filtro de argv está pegando qualquer processo").not.toContain(`pid=${pid}`);
  });

  it("--reap-servers sem alvo nomeado relata e NÃO mata (a morte nunca é por varredura)", async () => {
    const pid = await nasceProcesso(ARGV_SERVIDOR);
    expect(pid).toBeGreaterThan(0);
    const saida = rodaReaper(["--reap-servers"]);
    expect(saida).toContain(`pid=${pid}`);
    expect(saida).not.toContain("REAPED");
    expect(estaVivo(pid)).toBe(true);
  });
});
