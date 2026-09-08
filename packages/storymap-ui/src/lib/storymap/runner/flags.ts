// Runner flags — turn a column's automation POLICY (StatusDef.model/effort/
// maxTurns, falling back to the global columnDefaults) into the CLI flags the
// headless `claude` process is spawned with. Pure + isomorphic-safe (types only),
// so it's trivially unit-testable.

import type { RunnerColumnDefaults, StatusDef } from "@/lib/storymap/types";

/**
 * Resolve the per-column CLI flags for a spawn: `--model`, `--effort`, `--max-turns`. A StatusDef field
 * wins over the global default; an unset value on both sides emits no flag (so the CLI applies its own
 * default).
 *
 * WS3 (F2): the MCP mount flags (`--strict-mcp-config --mcp-config <path>`) are NO LONGER emitted here —
 * they moved to {@link toolkitFlags}, fed by the RESOLVED toolkit (resolveToolkit), which absorbs the
 * legacy `mcpConfig` as sugar AND existence-filters the paths in the engine (the only spot that knows the
 * spawn cwd + can `existsSync`). So a legacy-only column still mounts its config, byte-identical, but via
 * the toolkit seam. `mcpConfig` stays in the Pick only because callers pass a whole StatusDef.
 */
export function columnFlags(
  def: Pick<StatusDef, "model" | "effort" | "maxTurns" | "mcpConfig">,
  defaults: RunnerColumnDefaults,
): string[] {
  const model = def.model ?? defaults.model;
  const effort = def.effort ?? defaults.effort;
  const maxTurns = def.maxTurns ?? defaults.maxTurns;
  const out: string[] = [];
  if (model) out.push("--model", model);
  if (effort) out.push("--effort", effort);
  if (typeof maxTurns === "number" && Number.isFinite(maxTurns) && maxTurns > 0) {
    out.push("--max-turns", String(Math.floor(maxTurns)));
  }
  return out;
}

/**
 * A spawn's MCP surface is EXACTLY what it declares — the UNCONDITIONAL containment flags. Emits
 * `--strict-mcp-config` ALWAYS, plus one `--mcp-config <path>` per declared mount. Declaring nothing
 * therefore means "no MCP servers at all", not "whatever the host happens to be logged into".
 *
 * WHY UNCONDITIONAL (2026-07-18 — the defect this replaces). This used to emit the flag only when a
 * mount survived, on a doc-comment's claim that headless `claude -p` "does NOT auto-load the project
 * .mcp.json — no TTY to trust project servers, verified by spike". **That claim is false**, and a spawn
 * with the exact flags of a light run proves it: the CLI's own `system.init` event reported
 *   [firebase, observability, claude.ai AgileHarness, claude.ai Google Drive,
 *    claude.ai Google Calendar, claude.ai Gmail]
 * — the project `.mcp.json` AND every account-level connector of whoever the host is authenticated as.
 * Two consequences, both observed:
 *   (1) CORRECTNESS — a `harness-grill` run on acme/story-tlz0dt saw `mcp__…AgileHarness__get_card`, judged
 *       (reasonably) that it should write the card through it, called it, was DENIED by `acceptEdits`,
 *       and spent its remaining turns asking a human for approval that no one can grant in a headless
 *       run. The card never moved. A tool you can SEE but cannot USE is worse than an absent one.
 *   (2) CONTAINMENT — the same inheritance reaches the `--dangerously-skip-permissions` spawns, where
 *       those connectors are AUTO-APPROVED. The peer reviewer's own comment reads "The reviewer needs
 *       ZERO MCP" and strips MCP tokens from its env, yet it silently inherited Gmail/Drive/Calendar:
 *       the mitigation closed the narrow `curl` path while the direct tool path stayed open.
 * The lesson is structural, not local: containment that each spawn site must REMEMBER to opt into is
 * containment that the next spawn site will forget. Every site routes through here so that the default —
 * declare nothing — is the SAFE one. Pure; the caller existence-filters paths against the spawn cwd.
 */
export function mcpContainmentFlags(mcpConfigPaths: readonly string[] = []): string[] {
  const out: string[] = ["--strict-mcp-config"];
  for (const p of mcpConfigPaths) out.push("--mcp-config", p);
  return out;
}

/**
 * WS3 (F2) — the MCP + ACI flags for a spawn, from a step's RESOLVED toolkit (resolveToolkit): the
 * unconditional {@link mcpContainmentFlags} for the declared mounts, then `--allowedTools <csv>` when the
 * step declares a hard allow-list. Pure: the caller (engine) existence-filters `mcpConfigPaths` against
 * the spawn cwd BEFORE calling — so a mount that doesn't exist (a fresh consumer install) is dropped and
 * the spawn NEVER breaks on a missing config (it just gets a smaller, still-explicit surface).
 */
export function toolkitFlags(mcpConfigPaths: readonly string[], allowedTools: readonly string[]): string[] {
  const out: string[] = [...mcpContainmentFlags(mcpConfigPaths)];
  if (allowedTools.length) out.push("--allowedTools", allowedTools.join(","));
  return out;
}

/**
 * As flags que fazem as SKILLS DA FERRAMENTA chegarem ao filho quando ela não mora na árvore em que o
 * filho roda.
 *
 * O PROBLEMA, medido: o CLI descobre skills e comandos subindo do `cwd` (mais os diretórios de usuário
 * e de organização). O motor spawna o filho com `cwd` no repositório do USUÁRIO — que é o certo, é lá
 * que ele edita. Enquanto a ferramenta viveu DENTRO desse repositório, as skills `/usm-*` e
 * `/harness-*` eram encontradas por acidente de topologia. Quando a ferramenta passa a morar num
 * checkout próprio, elas somem — e o filho é despachado com um comando de skill que não existe.
 *
 * `--add-dir` é a saída DOCUMENTADA: além de conceder acesso a arquivos, ele carrega `.claude/skills/`
 * e `.claude/commands/` do diretório acrescentado. É exceção declarada na documentação do CLI, não um
 * efeito colateral em que estamos apostando.
 *
 * ⚠️ ELE VEM COM ACESSO A ARQUIVO JUNTO — não existe flag que carregue só as skills. Por isso a
 * emissão é CONDICIONAL e mínima: só quando as duas árvores realmente divergem, e só a raiz da
 * ferramenta. Quando elas coincidem (o caso de hoje) a função devolve vazio e o comando fica
 * byte-idêntico ao de sempre. Quem precisa impedir a ESCRITA na árvore da ferramenta é o envelope de
 * contenção, que já sabe negar caminho — esta função só resolve a descoberta.
 *
 * Pura: recebe as duas raízes em vez de resolvê-las, para a suíte poder exercitar a divergência sem
 * depender da árvore em que ela roda — que é justamente a cegueira que deixou o defeito C1 passar.
 */
export function toolTreeFlags(toolRoot: string | null | undefined, spawnCwd: string | null | undefined): string[] {
  const ferramenta = (toolRoot ?? "").trim();
  const cwd = (spawnCwd ?? "").trim();
  if (!ferramenta || !cwd) return [];
  const norm = (p: string) => p.replace(/[/\\]+$/, "");
  const f = norm(ferramenta);
  const c = norm(cwd);
  // Dentro da árvore do spawn ⇒ o CLI já acha subindo; acrescentar seria ruído e acesso a mais.
  if (f === c || f.startsWith(`${c}/`)) return [];
  return ["--add-dir", f];
}
