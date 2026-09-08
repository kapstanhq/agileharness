import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mcpContainmentFlags, toolkitFlags } from "./flags";
import { resolveToolkit } from "../toolkit";
import type { BoardConfig, StatusDef } from "../types";

// WS3 (F2) — toolkitFlags emits the MCP mounts + hard ACI allow-list from a step's RESOLVED toolkit.
// The engine existence-filters the paths (against the spawn cwd) BEFORE calling, so an omitted path is
// modeled here as an empty/short list.

describe("toolkitFlags — MCP mounts + allowedTools", () => {
  it("emits --strict-mcp-config + one --mcp-config per surviving mount", () => {
    expect(toolkitFlags(["storymap/graphify/nimbus.json"], [])).toEqual([
      "--strict-mcp-config",
      "--mcp-config",
      "storymap/graphify/nimbus.json",
    ]);
    expect(toolkitFlags(["a.json", "b.json"], [])).toEqual([
      "--strict-mcp-config",
      "--mcp-config",
      "a.json",
      "--mcp-config",
      "b.json",
    ]);
  });

  // BEHAVIOR CHANGE (2026-07-18) — these two used to assert that NO mounts ⇒ NO flags at all. That was the
  // defect, not the contract: a spawn that declares nothing was inheriting the host's ambient MCP servers
  // (project .mcp.json + the account connectors). Measured from the CLI's own `system.init` with the exact
  // flags of a light run: [firebase, observability, claude.ai AgileHarness, Google Drive, Google Calendar,
  // Gmail]. Declaring nothing must MEAN nothing — see mcpContainmentFlags for the full incident.
  it("declaring NO mounts still contains the spawn — the empty declaration is enforced, not skipped", () => {
    expect(toolkitFlags([], [])).toEqual(["--strict-mcp-config"]);
  });

  it("every mount existence-filtered away ⇒ contained with ZERO servers (never a fallback to ambient)", () => {
    // the engine passes [] when the config file is missing on disk. The spawn still must not inherit.
    expect(toolkitFlags([], ["Read"])).toEqual(["--strict-mcp-config", "--allowedTools", "Read"]);
  });

  it("emits --allowedTools as a comma-joined list only when declared (test #5)", () => {
    expect(toolkitFlags([], ["Read", "mcp__graphify__query_graph"])).toEqual([
      "--strict-mcp-config",
      "--allowedTools",
      "Read,mcp__graphify__query_graph",
    ]);
    expect(toolkitFlags(["a.json"], [])).not.toContain("--allowedTools");
  });
});

// The REGRESSION CLASS this guards, stated plainly: containment that each spawn site must remember to opt
// into is containment the next spawn site will forget. Three of the four existing sites had — the deploy
// agent, the peer reviewer and the conflict judge all ran `--dangerously-skip-permissions` while silently
// inheriting the host's project `.mcp.json` AND every account-level connector (Gmail/Drive/Calendar),
// auto-approved. The peer reviewer is the tell: its own comment reads "The reviewer needs ZERO MCP" and it
// strips MCP tokens from the child env, so the author had the right intent and still missed the mounts —
// because nothing FAILED when they did. This test is that failure.
//
// It is a source scan, and I want its limits on the record: it proves the containment CALL is present in
// each spawning module, not that the returned flags reach the exact `spawn()` of that module. The behavioral
// half is covered above (mcpContainmentFlags/toolkitFlags are pure and asserted directly). Comments are
// STRIPPED before matching — a previous exhaustiveness guard in this repo passed for weeks by matching the
// producer's own doc-comment, and a guard satisfied by prose guards nothing.
describe("MCP containment is STRUCTURAL — no spawn site may inherit the host's ambient servers", () => {
  const runnerDir = path.join(process.cwd(), "src/lib/storymap/runner");
  // Drop whole COMMENT LINES, line-by-line. Deliberately NOT a regex block-comment stripper: the first
  // version of this helper was one, and `/\/\*[\s\S]*?\*\//` mispaired against the regex literals in
  // engine.ts and deleted 75% of the file (211K → 52K) — which here surfaced as a false FAILURE, but the
  // same fragility produces a false PASS just as easily. A line filter cannot mispair, and it still removes
  // the only thing that ever faked a match in this repo: JSDoc prose (every line of which starts with `*`).
  const stripComments = (s: string): string =>
    s
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");

  // Every module that spawns the CLI with a permission flag. Kept EXPLICIT (not globbed) so adding a spawn
  // site is a deliberate act that must name itself here — and the exhaustiveness check below proves the
  // list didn't go stale.
  const SPAWN_MODULES = [
    "engine.ts",
    "deploy-agent-spawn.ts",
    "peer-review-spawn.ts",
    "resolution-judge-spawn.ts",
    "orchestrator-spawn.ts",
  ];

  // F0: módulos que EMITEM flag de permissão sem SPAWNAR nada. A distinção importa: a checagem acima
  // cobra contenção de superfície MCP, e cobrá-la de quem não abre processo seria uma afirmação falsa —
  // exigir `--strict-mcp-config` de um tradutor puro é cerimônia, não guarda. Eles entram AQUI para a
  // exaustividade continuar exaustiva, que é o que impede um spawn novo de se esconder.
  const FLAG_EMITTERS_NOT_SPAWNERS = [
    // traduz postura → flags (buildSpawnFlags); quem spawna com o resultado é engine.ts, já na lista.
    "autonomy-sandbox.ts",
  ];

  it.each(SPAWN_MODULES)("%s declares its MCP surface instead of inheriting one", (file) => {
    const src = stripComments(readFileSync(path.join(runnerDir, file), "utf8"));
    // Either it routes through the shared helpers, or (orchestrator-spawn) it emits the flag inline.
    const contained =
      /mcpContainmentFlags\s*\(/.test(src) || /toolkitFlags\s*\(/.test(src) || /"--strict-mcp-config"/.test(src);
    expect(contained, `${file} spawns the CLI but never constrains its MCP surface`).toBe(true);
  });

  it.each(FLAG_EMITTERS_NOT_SPAWNERS)("%s emits permission flags but never spawns the CLI", (file) => {
    // A guarda que impede a lista de virar esconderijo. CORRIGIDA após revisão: a primeira versão usava
    // /spawn\s*\(/ e por isso NÃO casava `spawnSync(` — era um guard vácuo, e a afirmação que ele fazia
    // ("não abre processo") era simplesmente falsa: este módulo spawna `bwrap` para sondar o host.
    // O que importa não é "abre processo", é "abre o CLI com flag de permissão" — que é o que faria dele
    // uma superfície de spawn de verdade, sujeita à contenção de MCP.
    const src = stripComments(readFileSync(path.join(runnerDir, file), "utf8"));
    const spawnaAlgo = /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(/.test(src);
    const spawnaOCli = /["'`]claude["'`]|claudeBin|buildClaudeCommand/.test(src);
    expect(spawnaOCli, `${file} spawna o CLI — mova para SPAWN_MODULES`).toBe(false);
    // Documenta o que ele REALMENTE faz, para o leitor não concluir "não executa nada".
    if (spawnaAlgo) expect(/bwrap|PROBE/.test(src), `${file} spawna algo que não é sonda`).toBe(true);
  });

  it("the SPAWN_MODULES list is exhaustive — a NEW spawn site cannot hide from this guard", () => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const suspects = readdirSync(runnerDir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => {
        const src = stripComments(readFileSync(path.join(runnerDir, f), "utf8"));
        return /"--dangerously-skip-permissions"|"--permission-mode"/.test(src);
      });
    expect(suspects.sort()).toEqual([...SPAWN_MODULES, ...FLAG_EMITTERS_NOT_SPAWNERS].sort());
  });
});

describe("legacy mcpConfig — byte-identical mount through the toolkit seam (test #2)", () => {
  const step = (over: Partial<StatusDef>): Pick<StatusDef, "mcpConfig" | "toolkit"> => over;
  const cfg: Pick<BoardConfig, "toolConfigs"> = { toolConfigs: undefined };

  it("a legacy-only mcpConfig resolves + emits the SAME flags the old columnFlags did", () => {
    const r = resolveToolkit(step({ mcpConfig: "storymap/qa-mcp.json" }), cfg, "storymap", "/repo");
    expect(toolkitFlags(r.mcpConfigPaths, r.allowedTools)).toEqual([
      "--strict-mcp-config",
      "--mcp-config",
      "storymap/qa-mcp.json",
    ]);
  });

  it("a missing legacy path → the engine filters it to [] → mcp flags omitted (fail-open on fresh install)", () => {
    const r = resolveToolkit(step({ mcpConfig: "storymap/does-not-exist.json" }), cfg, "storymap", "/repo");
    // resolveToolkit is pure (it doesn't stat) → the path is present; the ENGINE's existsSync filter
    // drops it. Modeled here: an empty surviving set emits nothing.
    expect(r.mcpConfigPaths).toEqual(["storymap/does-not-exist.json"]);
    expect(toolkitFlags([], r.allowedTools)).toEqual(["--strict-mcp-config"]);
  });
});
