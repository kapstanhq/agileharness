// Fase 5.2/5.3/5.4 — SERVER-ONLY assembly of the read models for the config cockpit's read-only tabs:
// Rotas & Especialistas (5.2), Toolkit por coluna (5.3), mcpTokens presence (5.4). It reads the board's own
// raw board.yaml + _base to compute ORIGIN (the merged BoardConfig can't tell inherited from board-defined),
// probes .claude/agents/<slug>.md for specialist presence, resolves each trigger step's toolkit, and pulls the
// last observed toolGap per column from telemetry. NO secret values are read (mcpTokens exposes only the env
// var NAME + level). Called from the force-dynamic config page; the resulting view models are plain data props.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { FrontmatterError, describeFrontmatterError, parseYamlMap } from "./frontmatter";
import { baseBoardConfigPath, boardConfigPath, findRepoRoot } from "./paths";
import { resolveToolkit, expandToolkitTemplate } from "./toolkit";
import { isDispensable, isLoadBearing } from "./skip-routing";
import { classifyOrigin, type ConfigOrigin } from "./board-origin";
import { readFileSettings } from "./runner/config";
import { diskTelemetryStore, lastToolGapByTrigger } from "./runner/telemetry";
import type { BoardConfig, McpLevel, StatusDef } from "./types";

export interface RouteProfileView {
  id: string;
  description?: string;
  skips: { id: string; name: string }[];
  modelCap?: string;
  effortCap?: string;
  origin: ConfigOrigin;
}
export interface SpecialistView {
  id: string;
  agent: string;
  when: string;
  agentFilePresent: boolean;
  usedByColumns: string[];
  origin: ConfigOrigin;
}
export interface DispensableStepView {
  id: string;
  name: string;
  dispensable: boolean;
  loadBearing: boolean;
}
export interface ColumnToolkitView {
  statusId: string;
  statusName: string;
  trigger: string;
  mounts: { path: string; legacy: boolean }[];
  allowedTools: string[];
  guidance?: string;
  specialists: { id: string; agent: string; when: string }[];
  expects: { tool: string; level: string }[];
  lastGap?: { tools: string[]; cardId: string; at: string };
}
export interface ConfigCockpitData {
  routeProfiles: RouteProfileView[];
  specialists: SpecialistView[];
  dispensableSteps: DispensableStepView[];
  columns: ColumnToolkitView[];
  mcpTokens: { tokenEnv: string; level: McpLevel }[] | null;
  /** any entry originates from _base → show the process-cache/restart note. */
  hasBaseOrigin: boolean;
}

/**
 * Parse a yaml file to a plain object; {} on any error (a missing own-raw is normal for a pristine board).
 *
 * SEGURANÇA — o parse passa pelo chokepoint (`parseYamlMap`), não por `yaml.load` direto. Os arquivos
 * lidos aqui são `storymap/boards/<board>/board.yaml` e `_base/board.yaml`: dado de BOARD, o corpus que
 * atravessa a fronteira do OSS (PR → `git pull` → releitura). Era um dos dois sítios que parseavam board
 * SEM teto de bytes/nós/profundidade e SEM guard de `__proto__` — invariante do chokepoint falso, e
 * invisível porque o lint da suíte só conhecia `gray-matter`. Fail-open PRESERVADO (origem é um selo
 * cosmético; recusar aqui não protegeria nada que o `readBoardConfig` do mesmo arquivo já não recuse),
 * mas a recusa vai para o log — um controle de segurança que falha calado não é auditável.
 *
 * Exportado para o teste de ATAQUE poder provar que os bytes hostis não chegam a virar chaves.
 */
export async function readRawKeys(file: string, section: string): Promise<Set<string>> {
  try {
    const doc = parseYamlMap(await readFile(file, "utf8"), file);
    const sec = (doc?.[section] ?? {}) as Record<string, unknown>;
    return new Set(Object.keys(sec));
  } catch (err) {
    if (err instanceof FrontmatterError) {
      console.error(`[storymap] cockpit: ${file} recusado:`, describeFrontmatterError(err));
    }
    return new Set();
  }
}

/**
 * Assemble the read-only cockpit data for a board. `config` is the already-resolved (merged) BoardConfig the
 * page loaded; we additionally read the raw sources for origin. Fail-open per source — a read error degrades
 * that facet, never throws.
 */
export async function assembleConfigCockpit(boardId: string, config: BoardConfig): Promise<ConfigCockpitData> {
  const repoRoot = findRepoRoot();
  const ownPath = boardConfigPath(boardId);
  const basePath = baseBoardConfigPath();

  // origin key sets, per section (routeProfiles/specialists).
  const [ownRouteKeys, baseRouteKeys, ownSpecKeys, baseSpecKeys] = await Promise.all([
    readRawKeys(ownPath, "routeProfiles"),
    readRawKeys(basePath, "routeProfiles"),
    readRawKeys(ownPath, "specialists"),
    readRawKeys(basePath, "specialists"),
  ]);

  const statusById = new Map(config.statuses.map((s) => [s.id, s]));
  const nameOf = (id: string) => statusById.get(id)?.name ?? id;

  // 5.2 — route profiles.
  const routeProfiles: RouteProfileView[] = Object.entries(config.routeProfiles ?? {}).map(([id, p]) => ({
    id,
    description: p.description,
    skips: (p.skips ?? []).map((sid) => ({ id: sid, name: nameOf(sid) })),
    modelCap: p.modelCap,
    effortCap: p.effortCap,
    origin: classifyOrigin(id, ownRouteKeys, baseRouteKeys),
  }));

  // reverse index: which trigger columns reference each specialist id (via step toolkit.specialists).
  const specialistColumns = new Map<string, string[]>();
  for (const s of config.statuses) {
    for (const specId of s.toolkit?.specialists ?? []) {
      const arr = specialistColumns.get(specId) ?? [];
      arr.push(s.name);
      specialistColumns.set(specId, arr);
    }
  }

  // 5.2 — specialists (with .claude/agents/<slug>.md presence probe).
  const specialists: SpecialistView[] = Object.entries(config.specialists ?? {}).map(([id, sp]) => ({
    id,
    agent: sp.agent,
    when: sp.when,
    agentFilePresent: existsSync(path.join(repoRoot, ".claude", "agents", `${sp.agent}.md`)),
    usedByColumns: specialistColumns.get(id) ?? [],
    origin: classifyOrigin(id, ownSpecKeys, baseSpecKeys),
  }));

  // 5.2 — the dispensable ruler (load-bearing steps shown locked).
  const dispensableSteps: DispensableStepView[] = config.statuses.map((s) => ({
    id: s.id,
    name: s.name,
    dispensable: isDispensable(s),
    loadBearing: isLoadBearing(s.id),
  }));

  // 5.3 — toolkit resolved per trigger step + last toolGap.
  const records = await diskTelemetryStore().load().catch(() => []);
  const legacyPathOf = (def: Pick<StatusDef, "mcpConfig">) =>
    def.mcpConfig ? expandToolkitTemplate(def.mcpConfig, boardId, repoRoot) : null;
  const columns: ColumnToolkitView[] = config.statuses
    .filter((s) => s.trigger || s.toolkit || s.mcpConfig)
    .map((s) => {
      const resolved = resolveToolkit(s, config, boardId, repoRoot);
      const legacy = legacyPathOf(s);
      const gapRec = s.trigger ? lastToolGapByTrigger(records, s.trigger) : undefined;
      return {
        statusId: s.id,
        statusName: s.name,
        trigger: s.trigger ?? "",
        mounts: resolved.mcpConfigPaths.map((p) => ({ path: p, legacy: p === legacy })),
        allowedTools: resolved.allowedTools,
        guidance: resolved.guidance,
        specialists: resolved.specialists,
        expects: resolved.expects.map((e) => ({ tool: e.tool, level: e.level })),
        lastGap:
          gapRec && gapRec.toolGap?.length
            ? { tools: gapRec.toolGap, cardId: gapRec.cardId, at: new Date(gapRec.startedAt).toISOString().slice(0, 10) }
            : undefined,
      };
    });

  // 5.4 — mcpTokens presence (NAME + level only; never the token value).
  const mcpTokens = readFileSettings().mcpTokens ?? null;

  const hasBaseOrigin =
    routeProfiles.some((r) => r.origin !== "board") || specialists.some((sp) => sp.origin !== "board");

  return { routeProfiles, specialists, dispensableSteps, columns, mcpTokens, hasBaseOrigin };
}
