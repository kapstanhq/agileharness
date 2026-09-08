// LINT DE PERÍMETRO — passar pelo chokepoint de env de spawn é OBRIGAÇÃO, não convenção (story-e3lj46).
//
// O AgileHarness spawna o binário `claude` de OITO lugares. Seis montavam o env do filho por
// `sanitizeSpawnEnv`/`buildAgentSpawnEnv`; DUAS entregavam o `process.env` do serviço cru — e a pior das duas
// era justamente a que ingere texto livre não confiável (`smart-capture/claude.ts`: captura, triagem de
// `report_issue`, turno de HITL, edição assistida). Ou seja: a régua existia, nada obrigava a passar por ela, e
// a superfície de MAIOR risco de prompt-injection nasceu fora. É o mesmo padrão de falha do chokepoint de
// frontmatter, que precisou de duas ondas exatamente por não ter lint.
//
// O que este lint IMPEDE: que uma superfície NOVA de spawn de Claude nasça montando o env do serviço à mão —
// com todo tier de credencial MCP (`STORYMAP_MCP_TOKEN*`) e o `__NEXT_PROCESSED_ENV` do next-server dentro —
// sem que ninguém veja na revisão. Ele NÃO julga se o env é seguro; julga que o filho nasce DO chokepoint, que
// é onde a régua por prefixo vive e onde um tier novo já nasce removido (spawn-env.ts).
//
// Como acha as superfícies, sem depender de lista: varre `src/**` não-teste, casa CHAMADAS de criação de
// processo e pergunta se o argv0 é o binário do Claude — literal `"claude"`, expressão que carrega
// `claudeBin`/`USM_AUTORUN_CLAUDE_BIN` (traçada por até 2 saltos de atribuição, que é como
// ``const cmd = `${bin} -p …` `` se resolve) ou um SEAM injetável de spawn de agente (`spawnProcess`/`doSpawn`,
// que existem só para isso). `spawn("tmux"|"git"|"bash"|"taskkill")` não casa — argv0 literal que não é claude.
//
// Duas condições por superfície, porque uma sozinha é teatro: (a) o arquivo CHAMA o chokepoint em CÓDIGO e
// (b) a chamada de spawn passa a opção `env` ao filho. Sem (b) um arquivo podia importar `sanitizeSpawnEnv`
// para outra coisa e ainda deixar o spawn herdar o env do serviço — que é literalmente o estado de `run_task`.
// A exigência "em CÓDIGO" não é preciosismo: a PRIMEIRA versão deste lint passou VERDE com o buraco reaberto,
// porque o comentário do call site MENCIONAVA `sanitizeSpawnEnv` — daí o `blankComments` e a contra-prova.
//
// LIMITE DECLARADO (não finge cobrir): a família mediada por TMUX — sessão de agente (`runner/session-spawn.ts`),
// terminal do Jido (`mcp/dev-tools.ts`) e adoção/abertura de terminal (`app/actions.ts`) entregam a linha de
// comando a `tmux new-session`, e ali o env do filho vem do SERVIDOR tmux, não deste processo: `sanitizeSpawnEnv`
// é inaplicável por construção. Fechar aquilo exige `-e` por variável no tmux (ou não subir o servidor a partir
// do serviço) e está fora deste recorte — fica dito em vez de fingido.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Chamadas de criação de processo relevantes + os seams injetáveis de spawn de agente. */
const SPAWN_CALL =
  /(?:^|[^\w.$])((?:this\.)?(?:spawn|spawnSync|execFile|execFileSync|execSync|pexec|doSpawn|spawnProcess))\s*\(\s*([^,\n)]+)/g;
/** `spawnProcess`/`doSpawn` só existem para injetar o spawn do AGENTE nos testes — argv0 opaco, mas é claude. */
const AGENT_SEAM = /^(?:this\.)?(?:spawnProcess|doSpawn)$/;
// `resolvedClaudeBin` entrou porque ele é, desde 2026-08-26, a forma CANÔNICA de nomear o binário
// (ver runner/claude-bin.ts). Sem ele o censo perdia a superfície do `run_task`: o capturador de
// argv0 acima para no primeiro `)`, que numa chamada aninhada cai DENTRO de `loadRunnerConfig()` —
// e o pedaço truncado não continha mais a palavra `claudeBin`.
const CLAUDE_BIN_TOKEN = /claudeBin|USM_AUTORUN_CLAUDE_BIN|resolvedClaudeBin/;
const CLAUDE_LITERAL = /^["'`]\s*claude\b/;
const STRING_LITERAL = /^["'`]/;
/** As duas portas legítimas, e CHAMADAS: a higiene pura e a higiene ⊕ headroom (que chama a primeira). */
const CHOKEPOINT_CALL = /(?:sanitizeSpawnEnv|buildAgentSpawnEnv)\s*\(/;
/** `env: x` ou o shorthand `env,` / `env }` — as duas formas que os call sites usam. */
const ENV_OPTION = /\benv\b\s*[,:}]/;

/**
 * Apaga COMENTÁRIOS (mantendo posições e linhas: cada byte comentado vira espaço) para que só CÓDIGO seja
 * medido. Prosa é onde este arquivo mais fala, e prosa não spawna nada nem sanea nada. Trata strings/templates
 * e literais de regex (`/…/`, detectada pelo caractere anterior) para não confundir `\/\/` com um comentário.
 */
export function blankComments(src: string): string {
  const out: string[] = [];
  let state: "code" | "line" | "block" | "sq" | "dq" | "tpl" | "re" = "code";
  let prev = ""; // último caractere de CÓDIGO significativo — desambigua divisão de literal de regex
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const d = src[i + 1] ?? "";
    if (state === "code") {
      if (c === "/" && d === "/") {
        state = "line";
        out.push("  ");
        i++;
        continue;
      }
      if (c === "/" && d === "*") {
        state = "block";
        out.push("  ");
        i++;
        continue;
      }
      if (c === "/" && /[(,=:[!&|?{;+\n]/.test(prev || "\n")) state = "re";
      else if (c === "'") state = "sq";
      else if (c === '"') state = "dq";
      else if (c === "`") state = "tpl";
      out.push(c);
      if (!/\s/.test(c)) prev = c;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out.push("\n");
      } else out.push(" ");
      continue;
    }
    if (state === "block") {
      if (c === "*" && d === "/") {
        state = "code";
        out.push("  ");
        i++;
      } else out.push(c === "\n" ? "\n" : " ");
      continue;
    }
    // dentro de string/template/regex: copia literalmente até fechar (escape consome o próximo)
    if (c === "\\") {
      out.push(c, d);
      i++;
      continue;
    }
    if ((state === "sq" && c === "'") || (state === "dq" && c === '"') || (state === "tpl" && c === "`") || (state === "re" && (c === "/" || c === "\n"))) {
      state = "code";
      prev = c;
    }
    out.push(c);
  }
  return out.join("");
}

const isSkipped = (p: string) => /\.test\.(ts|tsx)$|\.d\.ts$|__snapshots__|\.snap$/.test(p);

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(p) && !isSkipped(p)) acc.push(p);
  }
  return acc;
}

/** Toda atribuição `const|let|var <ident> = …` do arquivo (um identificador pode ser reatribuído em ramos). */
function assignmentsOf(code: string, ident: string): string[] {
  const re = new RegExp(`(?:const|let|var)\\s+${ident}\\s*(?::[^=]+)?=\\s*([\\s\\S]{0,400}?);\\n`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) out.push(m[1]);
  return out;
}

/**
 * A expressão do argv0 chega ao binário do Claude? Direto (`deps.claudeBin`, `"claude"`) ou por até 2 saltos de
 * atribuição no MESMO arquivo — o salto existe porque os call sites de shell montam a linha em etapas
 * (``const cmd = `${bin} -p …` `` ⊕ `const bin = process.env.USM_AUTORUN_CLAUDE_BIN || "claude"`).
 */
function tracesToClaudeBin(code: string, expr: string, depth = 0): boolean {
  if (CLAUDE_BIN_TOKEN.test(expr) || CLAUDE_LITERAL.test(expr.trim())) return true;
  if (depth >= 2) return false;
  for (const ident of new Set(expr.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
    for (const rhs of assignmentsOf(code, ident)) {
      if (tracesToClaudeBin(code, rhs, depth + 1)) return true;
    }
  }
  return false;
}

/** Texto dos argumentos da chamada que abre em `openIdx` (parênteses balanceados, com teto de segurança). */
function callArgs(code: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < code.length && i - openIdx < 4_000; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return code.slice(openIdx + 1, i);
  }
  return code.slice(openIdx, openIdx + 600); // chamada não fechada na janela — janela fixa, fail-closed
}

export interface SpawnSite {
  line: number;
  callee: string;
  argv0: string;
  /** a chamada passa `env` ao filho? sem isso o filho herda o env do serviço, sanitizado ou não */
  passesEnv: boolean;
}

export interface SourceAnalysis {
  sites: SpawnSite[];
  /** o arquivo CHAMA o chokepoint em código (comentário que o cita não conta) */
  atChokepoint: boolean;
}

/** O detector, PURO sobre o texto de um arquivo — é ele que o lint aplica, e é ele que os contra-testes provam. */
export function analyzeSource(text: string): SourceAnalysis {
  const code = blankComments(text);
  const sites: SpawnSite[] = [];
  SPAWN_CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SPAWN_CALL.exec(code))) {
    const callee = m[1];
    const argv0 = m[2].trim();
    const isClaude = STRING_LITERAL.test(argv0)
      ? CLAUDE_LITERAL.test(argv0) // literal explícito: "claude" sim, "tmux"/"git"/"taskkill" não
      : CLAUDE_BIN_TOKEN.test(argv0) || AGENT_SEAM.test(callee) || tracesToClaudeBin(code, argv0);
    if (!isClaude) continue;
    const openIdx = code.indexOf("(", m.index + m[0].indexOf(callee));
    sites.push({
      line: code.slice(0, m.index).split("\n").length,
      callee,
      argv0,
      passesEnv: ENV_OPTION.test(callArgs(code, openIdx)),
    });
  }
  return { sites, atChokepoint: CHOKEPOINT_CALL.test(code) };
}

/** Toda superfície de spawn do binário Claude em `src/**` (não-teste), por arquivo. */
export function discoverClaudeSpawnSites(root = "src"): Map<string, SourceAnalysis> {
  const found = new Map<string, SourceAnalysis>();
  for (const file of walk(root)) {
    const analysis = analyzeSource(readFileSync(file, "utf8"));
    if (analysis.sites.length) found.set(file.replace(/\\/g, "/"), analysis);
  }
  return found;
}

/**
 * O CENSO das superfícies que spawnam Claude. Existe para que uma superfície NOVA não entre calada: mesmo
 * sanitizada, ela reprova este lint até ser registrada aqui — e o registro é o momento em que um humano decide
 * se aquele agente devia nascer. Some uma superfície? A entrada tem de sair (censo que mente é pior que nenhum).
 */
const CLAUDE_SPAWN_SURFACES: Record<string, string> = {
  "src/lib/storymap/runner/engine.ts": "run de autorun — `claude -p` por card; o coração do sistema",
  "src/lib/storymap/runner/orchestrator-spawn.ts": "tick do copiloto/orquestrador por board",
  "src/lib/storymap/runner/peer-review-spawn.ts": "revisor par — chokepoint MENOS todo tier MCP (ele não usa MCP)",
  "src/lib/storymap/runner/resolution-judge-spawn.ts": "juiz LLM de conflito do merge train",
  "src/lib/storymap/runner/deploy-agent-spawn.ts": "agente de deploy (recuperação da face)",
  "src/lib/storymap/copilot/agent-session.ts": "sessão de chat do copiloto (Jido) — o dono conversa por aqui",
  "src/lib/storymap/smart-capture/claude.ts":
    "runClaudeJson — TEXTO LIVRE não confiável (captura, triagem de report_issue, HITL, edição assistida)",
  "src/lib/storymap/mcp/dev-tools.ts": "run_task — `claude -p` headless disparado por MCP",
};

/**
 * DÍVIDA registrada: superfície que ainda entrega o env do serviço cru. Só ENCOLHE — um arquivo listado aqui
 * que já esteja no chokepoint reprova o lint (para a lista não virar cemitério). Não é permissão: é o registro
 * explícito de um buraco conhecido, com o preço do fecho ao lado.
 */
// ⚠ A entrada de `mcp/dev-tools.ts` SAIU: o `run_task` passou a chamar `sanitizeSpawnEnv(process.env)`
// e a acrescentar `IS_SANDBOX` só dentro da válvula explícita.
//
// Vale registrar POR QUE ela sobreviveu tanto tempo, porque a lição não é sobre este arquivo: a
// descrição da dívida dizia que o run_task chamava `pexec` **SEM `env`** — e em algum momento o código
// passou a chamar COM `env: process.env`, que tem o mesmo efeito por outro mecanismo. O lint seguia
// verde porque a ISENÇÃO era por nome de arquivo, e o texto que a justificava apodreceu sem que nada
// reclamasse. Um registro de dívida que mente sobre o mecanismo é a mesma classe de "declarado e
// inerte" que este lint existe para caçar, uma camada acima dele.
const UNSANITIZED_DEBT: Record<string, string> = {};

describe("chokepoint de env de spawn — toda superfície de Claude passa por sanitizeSpawnEnv (story-e3lj46)", () => {
  it("nenhuma superfície monta o env do filho à mão (chokepoint em código + `env` na chamada)", () => {
    const offenders: string[] = [];
    for (const [rel, { sites, atChokepoint }] of discoverClaudeSpawnSites()) {
      if (rel in UNSANITIZED_DEBT) continue; // buraco conhecido e registrado (ver a asserção da dívida)
      if (!atChokepoint) {
        offenders.push(`${rel}:${sites[0].line} → spawna Claude sem chamar sanitizeSpawnEnv/buildAgentSpawnEnv`);
        continue;
      }
      for (const s of sites.filter((x) => !x.passesEnv)) {
        offenders.push(`${rel}:${s.line} → ${s.callee}(${s.argv0}) não passa \`env\` — o filho herda o do serviço`);
      }
    }
    expect(
      offenders,
      "Spawn de Claude fora do chokepoint: monte o env com `sanitizeSpawnEnv(process.env)` (ou " +
        "`buildAgentSpawnEnv` quando quiser o proxy headroom) e PASSE-o na chamada. Sem isso o filho nasce com " +
        "todo tier de credencial MCP e o runtime interno do next-server no ambiente.",
    ).toEqual([]);
  });

  it("o censo lista exatamente as superfícies que existem (uma nova não entra calada)", () => {
    const discovered = [...discoverClaudeSpawnSites().keys()].sort();
    const registered = Object.keys(CLAUDE_SPAWN_SURFACES).sort();
    expect(
      discovered.filter((f) => !registered.includes(f)),
      "Superfície NOVA de spawn de Claude: registre-a em CLAUDE_SPAWN_SURFACES dizendo o que ela spawna e por quê.",
    ).toEqual([]);
    expect(
      registered.filter((f) => !discovered.includes(f)),
      "Superfície registrada que não spawna mais Claude: remova a entrada do censo (censo que mente é pior que nenhum).",
    ).toEqual([]);
  });

  it("[CLASSE] nenhum sítio spawna o Claude por NOME NU — o argv0 vem da régua", () => {
    // O incidente de 2026-08-20 → 26 foi exatamente isto: `pexec("claude", …)` apostando no PATH do
    // processo. O binário migrou para `~/.local/bin`, saiu do PATH que o unit FIXA, e todo spawn
    // virou ENOENT por seis dias — sem uma linha no journal. Um literal nu aqui é aquele bug de novo.
    const nus: string[] = [];
    for (const [rel, analysis] of discoverClaudeSpawnSites()) {
      for (const site of analysis.sites) {
        if (STRING_LITERAL.test(site.argv0) && CLAUDE_LITERAL.test(site.argv0)) {
          nus.push(`${rel}:${site.line} → ${site.callee}(${site.argv0})`);
        }
      }
    }
    expect(
      nus,
      "argv0 com o nome NU do claude num spawn: resolva pela régua (resolvedClaudeBin) ou receba o " +
        "binário já resolvido como dependência. Um nome nu aposta no PATH do processo, e foi assim que \n" +
        "o motor ficou seis dias sem conseguir spawnar agente nenhum.",
    ).toEqual([]);
  });

  it("a dívida registrada é real e só encolhe", () => {
    const discovered = discoverClaudeSpawnSites();
    const stale: string[] = [];
    for (const rel of Object.keys(UNSANITIZED_DEBT)) {
      const analysis = discovered.get(rel);
      if (!analysis) {
        stale.push(`${rel} → não spawna mais Claude; tire da dívida`);
        continue;
      }
      if (analysis.atChokepoint && analysis.sites.every((s) => s.passesEnv)) {
        stale.push(`${rel} → já está no chokepoint; tire da dívida (ela encolheu)`);
      }
    }
    expect(stale, "UNSANITIZED_DEBT desatualizada — a lista só encolhe, e mentir nela desarma o lint.").toEqual([]);
  });
});

describe("o detector do lint (contra-provas — um lint que não pega nada passa também)", () => {
  it("[CONTRA-PROVA] um argv0 literal `claude` É detectado como nome nu", () => {
    const a = analyzeSource('const x = await pexec("claude", args, { env });');
    expect(a.sites.length).toBe(1);
    expect(STRING_LITERAL.test(a.sites[0].argv0) && CLAUDE_LITERAL.test(a.sites[0].argv0)).toBe(true);
  });

  it("[CONTRA-PROVA] `resolvedClaudeBin(...)` é reconhecido como spawn de Claude, e NÃO é nome nu", () => {
    const a = analyzeSource("const x = await pexec(resolvedClaudeBin({ name: loadRunnerConfig().autorun.claudeBin }), args, { env });");
    expect(a.sites.length).toBe(1);
    expect(STRING_LITERAL.test(a.sites[0].argv0)).toBe(false);
  });

  it("um COMENTÁRIO que menciona o chokepoint NÃO satisfaz o lint", () => {
    // Este caso não é hipotético: a primeira versão deste lint passou verde com a 8ª superfície reaberta,
    // porque o comentário do call site citava `sanitizeSpawnEnv(process.env)`.
    const src = [
      "// o env do filho passa por sanitizeSpawnEnv(process.env) — prosa, não código",
      "const env = { ...process.env };",
      "spawn(claudeBin, args, { env });",
    ].join("\n");
    const a = analyzeSource(src);
    expect(a.sites).toHaveLength(1);
    expect(a.atChokepoint).toBe(false);
  });

  it("pega o spawn de Claude que não passa `env` (o filho herdaria o do serviço)", () => {
    const src = ['const env = sanitizeSpawnEnv(process.env);', 'pexec("claude", args, { cwd, timeout: 1000 });'].join("\n");
    const a = analyzeSource(src);
    expect(a.atChokepoint).toBe(true);
    expect(a.sites.map((s) => s.passesEnv)).toEqual([false]);
  });

  it("reconhece o comando montado em 2 saltos (`const cmd = `${bin} -p …``)", () => {
    const src = [
      'const bin = process.env.USM_AUTORUN_CLAUDE_BIN || "claude";',
      "const cmd = `${bin} -p --output-format json`;",
      "const env = sanitizeSpawnEnv(process.env);",
      "spawn(cmd, { shell: true, env });",
    ].join("\n");
    expect(analyzeSource(src).sites.map((s) => s.passesEnv)).toEqual([true]);
  });

  it("não confunde binário de sistema com agente (tmux/git/bash/taskkill)", () => {
    const src = [
      'pexec("tmux", ["new-session", "-d"]);',
      'spawn("git", ["status"]);',
      'spawn("bash", ["-lc", cmd]);',
      'spawn("taskkill", ["/pid", "1"]);',
    ].join("\n");
    expect(analyzeSource(src).sites).toEqual([]);
    const files = [...discoverClaudeSpawnSites().keys()];
    expect(files).not.toContain("src/lib/vps/tmux.ts"); // pexec("tmux", …), e o arquivo até cita `claude --resume`
    expect(files).not.toContain("src/lib/terminal/git.ts"); // pexec("git", …)
    expect(files).not.toContain("src/lib/storymap/runner/product-deploy.ts"); // spawn("bash"|"just", …)
  });

  it("a superfície de TEXTO LIVRE está entre as cobertas (era ela que faltava)", () => {
    const a = discoverClaudeSpawnSites().get("src/lib/storymap/smart-capture/claude.ts");
    expect(a?.sites.length).toBeGreaterThan(0);
    expect(a?.atChokepoint).toBe(true);
    expect(a?.sites.every((s) => s.passesEnv)).toBe(true);
  });
});
