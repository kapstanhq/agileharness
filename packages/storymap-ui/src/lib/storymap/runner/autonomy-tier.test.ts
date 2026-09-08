import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  needsFullAutonomy,
  permissionArgs,
  resetAutonomyWarnings,
  resolveEgressDeclaration,
  resolveTierCap,
} from "./engine";
import { AGENTS, capTier, SPAWN_SURFACES, tierOf } from "./skill-registry";
import { resolveAutonomyPosture, unsandboxedFullAllowed } from "./autonomy-sandbox";
import type { AutonomyTier, TriggerId } from "@/lib/storymap/types";

// story-l9mac9 / story-u4qb3f / story-kqfkoi — TIERS NOMEADOS, e o que cada teste aqui protege é uma
// FALHA DE CONTENÇÃO diferente. Nenhuma delas é "o agente tem poder demais": o mandato do produto é ser
// autônomo, e `full` (o `Unrestricted` do claude-hermes) EXISTE de propósito. O que se protege é:
//
//   (1) NINGUÉM perde permissão sem alguém ter declarado. Um refactor que rebaixe um spawn em silêncio
//       para a suíte inteira do autorun é uma auto-negação de serviço — o pipeline para de produzir e
//       nenhum teste reclama. A tabela por trigger abaixo é essa trava.
//   (2) O TETO nunca vira ELEVADOR. Um "piso de segurança" que, mal digitado, PROMOVE uma skill de
//       `acceptEdits` para shell irrestrito seria o contrário do que o adotante pediu.
//   (3) O RÓTULO não mente. Declarar "o chat do Jido é write" porque ele nega Write/Edit, quando ele
//       tem Bash, é uma etiqueta que engana o auditor — pior que não ter etiqueta.
//   (4) IS_SANDBOX=1 não é contenção. É o bypass do guard de root do CLI; um spawn REBAIXADO recebendo
//       o bypass é a leitura ao contrário que a auditoria de perímetro mandou fechar.
//   (5) Um knob de isolamento inerte tem de DIZER que é inerte. Allowlist declarada e não aplicada, em
//       silêncio, produz um operador que acha que tem sandbox e não tem.

const TRIGGERS = Object.keys(AGENTS) as TriggerId[];

describe("(1) o DEFAULT de todo board é o comportamento de hoje — nomear tier não muda spawn nenhum", () => {
  it.each(TRIGGERS)("%s: as flags de permissão são as MESMAS de antes dos tiers", (trigger) => {
    // A fórmula LEGADA, escrita à mão de propósito (não derivada do código novo): fullAutonomy ⇒
    // skip-permissions, senão acceptEdits. Se um dia divergir, foi o comportamento que mudou.
    // F0/ADR-067: `full` deixou de comprar Bash headless DESLIGANDO a checagem e passou a comprá-lo com
    // ISOLAMENTO — a tabela de permissão convergiu para acceptEdits em ambos, e a diferença real (o
    // settings de sandbox) é emitida no spawn e coberta por autonomy-sandbox.test.ts.
    const legacy = ["--permission-mode", "acceptEdits"];
    expect(permissionArgs(trigger)).toEqual(legacy);
  });

  it("sem teto declarado, o tier efetivo é o da skill (nenhum board existente declara nada)", () => {
    expect(resolveTierCap({}, "storymap")).toBeNull();
    expect(resolveTierCap({}, "nest")).toBeNull();
    for (const t of TRIGGERS) expect(capTier(tierOf(t), resolveTierCap({}, "nest"))).toBe(tierOf(t));
  });

  it("`full` continua sendo o TOPO — foi nomeado e depois RE-IMPLEMENTADO, nunca removido", () => {
    expect(tierOf("harness-do")).toBe("full");
    // F0/ADR-067: o topo deixou de ser "desliga a checagem" e passou a ser "isola e auto-aprova o Bash".
    // A prova de que ele CONTINUA sendo o topo não está mais na flag — está na postura (sandboxed), que é
    // o único tier que ganha shell não-interativo. A tabela de permissão convergiu de propósito.
    expect(permissionArgs("harness-do")).toEqual(["--permission-mode", "acceptEdits"]);
    const support = {
    available: true, mechanism: "bubblewrap" as const, requiresWeakerNested: false,
    reason: "ok", missing: [], method: "sonda" as const,
  };
    const kindOf = (tier: AutonomyTier) =>
      resolveAutonomyPosture({ trigger: null,
        tier, support, env: {}, projectRoot: "/tmp/ah-fake-wt", writeRoot: "/tmp/ah-fake-wt", stateRoot: "/tmp/ah-fake-state",
        key: "k", writeSettings: () => "/tmp/ah-fake-state/sandbox-k.json",
      }).kind;
    expect(kindOf("full")).toBe("sandboxed");
    expect(kindOf("write")).not.toBe("sandboxed");
    // e o topo é exatamente o conjunto que já rodava com a flag
    for (const t of TRIGGERS) expect(tierOf(t) === "full").toBe(needsFullAutonomy(t));
  });

  it("uma skill desconhecida cai no piso (`ro`) — privilégio não se herda por omissão", () => {
    expect(tierOf("harness-inexistente" as TriggerId)).toBe("ro");
  });
});

describe("(2) o teto por board é TETO — nunca promove", () => {
  it("um teto `write` rebaixa a skill de código para editar-sem-shell", () => {
    expect(permissionArgs("harness-do", "write")).toEqual(["--permission-mode", "acceptEdits"]);
  });

  it("um teto `ro` deixa o run sem escrever nada", () => {
    expect(permissionArgs("harness-do", "ro")).toEqual(["--permission-mode", "plan"]);
  });

  it("ATAQUE (typo do operador): declarar `full` num board NÃO dá shell a quem hoje só edita o card", () => {
    // harness-plan roda em acceptEdits hoje. Se o teto promovesse, um `USM_AUTORUN_TIER_CAP=full` teria
    // acabado de conceder Bash irrestrito a 4 skills que nunca o tiveram — em nome de um "piso".
    expect(tierOf("harness-plan")).toBe("write");
    expect(permissionArgs("harness-plan", "full")).toEqual(["--permission-mode", "acceptEdits"]);
    expect(permissionArgs("harness-plan", "orch")).toEqual(["--permission-mode", "default"]);
  });

  it("o teto POR BOARD vence o global; o global vale para os outros boards", () => {
    const env = { USM_AUTORUN_TIER_CAP: "write", USM_AUTORUN_TIER_CAP_NEST: "full" };
    expect(resolveTierCap(env, "nest")).toBe("full");
    expect(resolveTierCap(env, "storymap")).toBe("write");
    expect(resolveTierCap(env, "borough-ai")).toBe("write"); // slug com `-` → chave com `_`
    expect(resolveTierCap({ "USM_AUTORUN_TIER_CAP_BOROUGH_AI": "ro" }, "borough-ai")).toBe("ro");
  });

  it("um board fora do charset de slug não consulta chave nenhuma (nada de env montada por nome sujo)", () => {
    expect(resolveTierCap({ "USM_AUTORUN_TIER_CAP_../../ETC": "ro" }, "../../etc")).toBeNull();
  });

  it("ATAQUE ao contrário — um teto ESCRITO ERRADO não congela o pipeline em read-only, mas GRITA", () => {
    resetAutonomyWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveTierCap({ USM_AUTORUN_TIER_CAP: "writ" }, "nest")).toBeNull();
      // Teto inválido ⇒ NENHUM teto ⇒ o tier declarado da skill (`full`), cujas flags são acceptEdits
      // desde F0. O que este teste protege é o fail-OPEN deliberado do teto: um typo não congela o
      // pipeline em read-only. Isso continua valendo, e a postura de `full` segue sendo a de topo.
      expect(permissionArgs("harness-do", resolveTierCap({ USM_AUTORUN_TIER_CAP: "writ" }, "nest"))).toEqual([
        "--permission-mode",
        "acceptEdits",
      ]);
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0])).toContain("NENHUM teto aplicado");
      // e grita UMA vez por valor, não uma por run (um typo não vira enxurrada de journal)
      const before = warn.mock.calls.length;
      resolveTierCap({ USM_AUTORUN_TIER_CAP: "writ" }, "nest");
      expect(warn.mock.calls.length).toBe(before);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("(4) a POSTURA segue o tier EFETIVO — um spawn rebaixado não ganha contenção de topo", () => {
  // Re-mira do antigo bloco de IS_SANDBOX: a pergunta continua sendo "um run rebaixado por teto de board
  // recebe o poder do tier de topo?", só que agora o poder é o sandbox com Bash auto-aprovado, e não o
  // bypass de permissão. A resposta tem de continuar sendo NÃO.
  const support = {
    available: true, mechanism: "bubblewrap" as const, requiresWeakerNested: false,
    reason: "ok", missing: [], method: "sonda" as const,
  };
  // ⚠ `writeSettings` INJETADO. Sem isto o escritor REAL roda e cria `/wt/sandbox-k.json` na RAIZ do
  // filesystem — como root, numa suíte. Foi o que aconteceu, e uma revisão independente reproduziu.
  // A propriedade de não-intrusão que esta fase declara vale para os TESTES também: uma suíte que suja
  // a máquina é a mesma classe de defeito que um harness que suja o repositório alheio.
  const posture = (tier: AutonomyTier) =>
    resolveAutonomyPosture({ trigger: null,
      tier, support, env: {}, projectRoot: "/tmp/ah-fake-wt", writeRoot: "/tmp/ah-fake-wt", stateRoot: "/tmp/ah-fake-state",
      key: "k", writeSettings: () => "/tmp/ah-fake-state/sandbox-k.json",
    }).kind;

  it("no tier `full`, a postura é sandboxed (é o que faz o autorun nascer com shell)", () => {
    expect(tierOf("harness-do")).toBe("full");
    expect(posture("full")).toBe("sandboxed");
  });

  it("ATAQUE: com teto `write` ou `ro`, o run NÃO recebe a postura de topo", () => {
    expect(posture(capTier(tierOf("harness-do"), "write"))).not.toBe("sandboxed");
    expect(posture(capTier(tierOf("harness-do"), "ro"))).not.toBe("sandboxed");
  });

  it("REGRESSÃO: nenhuma superfície de spawn pode reintroduzir o bypass como default", () => {
    // `IS_SANDBOX=1` só é legítimo dentro da válvula explícita. Um default que o reintroduza é a mentira
    // que F0 removeu — e a lente de deriva abaixo cobra isso na FONTE de cada superfície.
    expect(unsandboxedFullAllowed({})).toBe(false);
  });
});

// ── (3) A LENTE DE DERIVA: o rótulo × as flags REAIS de cada superfície (story-kqfkoi) ────────────────
// Escaneia a FONTE de cada superfície declarada em SPAWN_SURFACES. Comentários são REMOVIDOS antes de
// casar — um guard satisfeito por prosa não guarda nada (a lição do flags.test.ts, cujo stripper por LINHA
// é reusado aqui de propósito: um stripper de bloco por regex já apagou 75% do engine.ts nesta base).
const SRC = path.join(process.cwd(), "src");
const stripComments = (s: string): string =>
  s
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
const srcOf = (mod: string): string => stripComments(readFileSync(path.join(SRC, mod), "utf8"));
const SKIP_FLAG = "--dangerously-skip-permissions";
const MODE_FLAG = "--permission-mode";
// O valor que o tier `orch` emite — LIDO DA FUNÇÃO, não redigitado: é o que amarra o rótulo do tick à
// flag que o tick realmente passa. Se um dia o CLI trocar o nome do modo, os dois se movem juntos.
const modeValueFor = (tier: AutonomyTier): string => {
  const args = permissionArgs("harness-do", tier);
  return args[1] ?? "";
};

describe("(3) o rótulo de tier de cada superfície casa com as flags que ela realmente passa", () => {
  it.each(Object.entries(SPAWN_SURFACES))("%s", (id, def) => {
    // A postura de uma superfície pode viver em mais de um módulo (o autorun: engine + autonomy-sandbox).
    // A lente lê TODOS os declarados — afrouxar a asserção seria trocar o guarda por prosa.
    const src = [def.module, def.postureModule].filter(Boolean).map((m) => srcOf(m as string)).join("\n");
    if (def.declaration === "inherited") {
      // Não declara postura NENHUMA → herda o settings do host. Se um dia passar a declarar, o rótulo
      // (`inherited`) virou mentira e este caso reprova.
      expect(src.includes(SKIP_FLAG), `${id} está rotulada "inherited" mas passa ${SKIP_FLAG}`).toBe(false);
      expect(src.includes(MODE_FLAG), `${id} está rotulada "inherited" mas declara ${MODE_FLAG}`).toBe(false);
      return;
    }
    if (def.declaration === "opt-in") {
      // O topo é ALCANÇÁVEL mas só a pedido do chamador — a flag existe no módulo E há um parâmetro
      // que a liga (senão "opt-in" seria só uma palavra bonita para "sempre ligado").
      expect(src.includes(SKIP_FLAG), `${id} é "opt-in" para o topo mas não tem a flag`).toBe(true);
      expect(/dangerouslySkipPermissions|skipPermissions/.test(src), `${id} não tem knob de opt-in`).toBe(true);
      return;
    }
    if (def.tier === "per-trigger") {
      // O autorun: as duas posturas convivem no mesmo módulo (por skill).
      expect(src.includes(SKIP_FLAG)).toBe(true);
      expect(src.includes(MODE_FLAG)).toBe(true);
      return;
    }
    // ── SUPERFÍCIE MIGRADA (F0 · ADR-067) ──────────────────────────────────────────────────────────
    // Um `full` que declara `postureModule` não compra o topo com a flag perigosa: ele resolve uma
    // POSTURA e a contenção vira `--settings <sandbox>`. Antes de F0 essa combinação não existia, e por
    // isso a lente só conhecia "full ⇒ carrega a flag". Afrouxar o ramo `full` para acomodá-la teria
    // apagado a asserção justamente para as superfícies que ainda NÃO migraram — então a migração ganha
    // ramo próprio, com a propriedade que de fato importa: o módulo da superfície não emite mais o
    // bypass, e existe um módulo de postura respondendo por ela.
    if (def.tier === "full" && def.postureModule) {
      const proprio = srcOf(def.module);
      expect(
        proprio.includes(SKIP_FLAG),
        `${id} declara postura (migrada) mas o próprio módulo ainda emite ${SKIP_FLAG}`,
      ).toBe(false);
      const postura = srcOf(def.postureModule);
      expect(postura.includes("resolveAutonomyPosture"), `${id}: o postureModule não resolve postura`).toBe(true);
      return;
    }
    if (def.tier === "full") {
      expect(src.includes(SKIP_FLAG), `${id} está rotulada "full" mas não passa ${SKIP_FLAG}`).toBe(true);
      expect(
        src.includes(MODE_FLAG),
        `${id} está rotulada "full" e ainda declara ${MODE_FLAG} — o rótulo precisa ser revisto`,
      ).toBe(false);
      return;
    }
    // Abaixo do topo: declara o modo, com o valor do tier rotulado, e NÃO carrega a flag do topo.
    expect(src.includes(SKIP_FLAG), `${id} está rotulada "${def.tier}" mas passa ${SKIP_FLAG}`).toBe(false);
    expect(src.includes(MODE_FLAG), `${id} está rotulada "${def.tier}" e não declara ${MODE_FLAG}`).toBe(true);
    expect(
      src.includes(`"${modeValueFor(def.tier)}"`),
      `${id} está rotulada "${def.tier}", cujo modo é "${modeValueFor(def.tier)}" — a fonte passa outro`,
    ).toBe(true);
  });

  it("o chat do Jido herda o TOPO — o deny-list de Write/Edit não é fronteira de tier (Bash alcança tudo)", () => {
    // story-kqfkoi é ETIQUETA: nada aqui restringe o chat. Mas a etiqueta certa é `full`, porque
    // CHAT_DENIED_TOOLS nega Write/Edit/NotebookEdit e MANTÉM Bash — `sed`/`git commit` seguem alcançáveis.
    expect(SPAWN_SURFACES.copilotChat.tier).toBe("full");
    const src = srcOf(SPAWN_SURFACES.copilotChat.module);
    expect(src.includes(SKIP_FLAG)).toBe(true);
    expect(/CHAT_DENIED_TOOLS\s*=\s*"Write,Edit,NotebookEdit"/.test(src)).toBe(true);
    expect(/CHAT_DENIED_TOOLS\s*=\s*"[^"]*Bash/.test(src), "Bash entrou no deny-list: reveja o rótulo").toBe(false);
  });

  it("a tabela é EXAUSTIVA — uma superfície de spawn nova não se esconde da lente", () => {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const p = path.join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
          const src = stripComments(readFileSync(p, "utf8"));
          if (src.includes(SKIP_FLAG) || src.includes(MODE_FLAG)) found.push(path.relative(SRC, p).replace(/\\/g, "/"));
        }
      }
    };
    walk(SRC);
    // `server/main.ts` cita a flag no BANNER/ajuda do operador (o boot que explica o que a porta expõe) —
    // não spawna nada. Explícito para que "não é spawn" seja uma afirmação revisável, não um silêncio.
    const DOC_ONLY = ["server/main.ts"];
    const declared = Object.values(SPAWN_SURFACES)
      .filter((s) => s.declaration !== "inherited")
      .flatMap((s) => [s.module, s.postureModule].filter(Boolean) as string[]);
    // ── A DIREÇÃO QUE IMPORTA (revisto em F0) ──────────────────────────────────────────────────────
    // A asserção era de IGUALDADE, o que embutia uma premissa que deixou de valer: "todo módulo
    // declarado contém uma das flags". Uma superfície MIGRADA (`postureModule`) legitimamente não
    // contém nenhuma — a contenção dela é `--settings`, emitido pelo módulo de postura. Com igualdade,
    // migrar uma superfície REPROVAVA a lente, o que empurraria para desfazer a migração ou afrouxar o
    // guarda.
    //
    // A propriedade que a lente existe para garantir é a INCLUSÃO: nenhum arquivo que emita as flags
    // pode estar fora da tabela. Um módulo declarado sem flag nenhuma não é um furo — é o objetivo.
    const permitidos = new Set([...declared, ...DOC_ONLY]);
    const naoDeclarados = found.filter((f) => !permitidos.has(f)).sort();
    expect(
      naoDeclarados,
      "superfície de spawn fora da tabela SPAWN_SURFACES — declare-a, ou a lente para de ver o que ela faz",
    ).toEqual([]);
    // NÃO-VACUIDADE: uma varredura que não achasse nada passaria a inclusão trivialmente.
    expect(found.length, "a varredura não encontrou NENHUM emissor — o scan quebrou").toBeGreaterThan(5);
  });
});

describe("(5) isolamento de rede: capacidade OPT-IN nascendo DESLIGADA e ADMITINDO que não aplica nada", () => {
  afterEach(() => resetAutonomyWarnings());

  it("DEFAULT OFF: sem o knob não há declaração — nem uma chave a mais no env do filho", () => {
    expect(resolveEgressDeclaration({})).toBeNull();
    expect(resolveEgressDeclaration({ USM_AUTORUN_EGRESS_ALLOW: "   " })).toBeNull();
  });

  it("declarada, a allowlist é parseada e o processo AVISA que ninguém a aplica", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const d = resolveEgressDeclaration({ USM_AUTORUN_EGRESS_ALLOW: "api.anthropic.com, *.github.com" });
      expect(d).toEqual({ allow: ["api.anthropic.com", "*.github.com"], enforced: false });
      expect(String(warn.mock.calls[0]?.[0])).toContain("NÃO APLICADA");
    } finally {
      warn.mockRestore();
    }
  });

  it("ATAQUE: uma entrada fora do charset de hostname não viaja para o env de um filho com shell", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const d = resolveEgressDeclaration({
        USM_AUTORUN_EGRESS_ALLOW: "ok.example.com,evil.com/;curl$(id),\"quoted\"",
      });
      expect(d?.allow).toEqual(["ok.example.com"]);
    } finally {
      warn.mockRestore();
    }
  });
});
