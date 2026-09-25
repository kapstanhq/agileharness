// AS SKILLS QUE A FERRAMENTA DISTRIBUI × as que o ALVO carrega — medido, nunca presumido.
//
// O incidente (medido no alvo de referência, 2026-09-25): as sessões do alvo carregam as skills `harness-*` de
// CÓPIAS versionadas no repositório DELE (`<alvo>/.claude/skills/harness-*`), congeladas desde a inversão
// (2026-08-27). Depois dela a ferramenta criou `harness-conductor` e `harness-orchestrator` e mudou a
// `harness-qa` — e nada avisou: o condutor abria sessão no worktree do alvo SEM a própria skill. A ferramenta
// passou a despachar um papel cujas instruções não existiam onde o papel roda.
//
// Duas perguntas, e nenhuma escreve nada:
//   · FALTA — uma skill da ferramenta que o alvo não tem. É defeito: o motor pode despachar um papel sem
//     instrução. O preflight diz `degraded`, com a lista, e `sync_skills` a copia pelo merge train.
//   · DIFERE — as duas têm, com conteúdo diferente. Pode ser customização LEGÍTIMA do alvo, então é AVISO com a
//     lista, e nada é sobrescrito sem que alguém nomeie a skill (`sync_skills({overwrite: [...]})`).
// Skill que só o alvo tem é dele — não entra na conta.
//
// A comparação é por ÁRVORE (todo arquivo do diretório da skill, por conteúdo), não só pelo SKILL.md: uma skill
// que traz um script ou uma referência ao lado mudou se qualquer um deles mudou.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Onde as skills moram, relativo à raiz de um checkout (da ferramenta ou do alvo). */
export const SKILLS_DIR = path.join(".claude", "skills");

/** As skills que a ferramenta DISTRIBUI: as do próprio harness. As demais são do repositório onde estão. */
export const DISTRIBUTED_SKILL_PREFIX = "harness-";

/** Uma skill medida: o nome (o diretório) e o hash de cada arquivo, por caminho relativo (`/`). */
export interface SkillTree {
  name: string;
  files: Record<string, string>;
}

export interface SkillDrift {
  /** da ferramenta, ausentes no alvo — o motor pode despachar um papel sem instrução. */
  missing: string[];
  /** presentes nos dois, com conteúdo diferente — e QUAIS arquivos diferem. */
  differ: Array<{ name: string; files: string[] }>;
  /** presentes nos dois, idênticas. */
  same: string[];
}

/** Compara as skills da ferramenta com as do alvo. Ordenado por nome, para a lista ser estável. PURA. */
export function skillDrift(tool: readonly SkillTree[], target: readonly SkillTree[]): SkillDrift {
  const alvo = new Map(target.map((t) => [t.name, t]));
  const out: SkillDrift = { missing: [], differ: [], same: [] };
  for (const t of [...tool].sort((a, b) => a.name.localeCompare(b.name))) {
    const other = alvo.get(t.name);
    if (!other) {
      out.missing.push(t.name);
      continue;
    }
    const paths = [...new Set([...Object.keys(t.files), ...Object.keys(other.files)])].sort();
    const files = paths.filter((p) => t.files[p] !== other.files[p]);
    if (files.length) out.differ.push({ name: t.name, files });
    else out.same.push(t.name);
  }
  return out;
}

export interface SkillFs {
  readdir(dir: string): Array<{ name: string; isDirectory: boolean; isFile: boolean }>;
  read(file: string): Buffer;
}

const realFs: SkillFs = {
  readdir: (dir) =>
    readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() })),
  read: (file) => readFileSync(file),
};

/**
 * As skills `harness-*` de um checkout, medidas. Um diretório ausente é "nenhuma skill" (um alvo que nunca
 * recebeu as cópias). Links simbólicos não são seguidos (lstat): uma skill que aponta para fora da árvore não é
 * conteúdo desta árvore. Lança só se a raiz existir e não puder ser lida — quem chama decide o que isso é.
 */
export function readSkillTrees(root: string, fs: SkillFs = realFs): SkillTree[] {
  const dir = path.join(root, SKILLS_DIR);
  let entries: ReturnType<SkillFs["readdir"]>;
  try {
    entries = fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: SkillTree[] = [];
  for (const e of entries) {
    if (!e.isDirectory || !e.name.startsWith(DISTRIBUTED_SKILL_PREFIX)) continue;
    const files: Record<string, string> = {};
    const walk = (abs: string, rel: string) => {
      for (const f of fs.readdir(abs)) {
        const a = path.join(abs, f.name);
        const r = rel ? `${rel}/${f.name}` : f.name;
        if (f.isDirectory) walk(a, r);
        else if (f.isFile) files[r] = createHash("sha256").update(fs.read(a)).digest("hex");
      }
    };
    walk(path.join(dir, e.name), "");
    out.push({ name: e.name, files });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A sonda do preflight: as duas árvores medidas, ou null quando uma delas não pôde ser lida. */
export interface SkillsProbe {
  toolRoot: string;
  targetRoot: string;
  tool: SkillTree[];
  target: SkillTree[];
}

/** Mede as duas raízes para o preflight. Nunca lança: uma leitura que falha vira `null` (o check diz "não medi"). */
export function measureSkills(toolRoot: string | null, targetRoot: string | null, fs: SkillFs = realFs): SkillsProbe | null {
  if (!toolRoot || !targetRoot) return null;
  try {
    return { toolRoot, targetRoot, tool: readSkillTrees(toolRoot, fs), target: readSkillTrees(targetRoot, fs) };
  } catch {
    return null;
  }
}

