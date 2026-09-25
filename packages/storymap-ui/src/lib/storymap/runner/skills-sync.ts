// sync_skills — leva ao ALVO as skills `harness-*` que a ferramenta distribui e ele não tem. DI (sem IO próprio).
//
// O que ela faz, e o que ela se recusa a fazer (skills-drift.ts conta o porquê de cada lado):
//   • COPIA as que FALTAM no alvo — sempre;
//   • NUNCA sobrescreve uma que DIFERE, a menos que o chamador a NOMEIE em `overwrite` (o alvo pode ter
//     customizado a instrução do agente dele; trocar isso é uma decisão, não uma sincronização);
//   • NUNCA escreve no checkout de runtime: com o serviço vivo, o escritor único é o serviço (regra D4), e um
//     arquivo solto ali ficaria fora do git e fora do que o train integra. O caminho é o MESMO de qualquer
//     trabalho de sessão (ADR-065): um worktree de sessão cortado da base de integração, um commit, e o merge
//     train — que roda o gate (`.claude/**` é caminho de controle) e leva o resultado à main pela metade de
//     dados do split. Quem chamou acompanha o veredito como qualquer sessão (`wait_for_submit`) e descarta o
//     worktree no fim (`worktree_discard`).

import path from "node:path";
import { SKILLS_DIR, skillDrift, type SkillDrift, type SkillTree } from "@/lib/storymap/skills-drift";

export interface SkillsSyncPlan {
  drift: SkillDrift;
  /** o que será copiado porque falta no alvo. */
  copy: string[];
  /** o que será SOBRESCRITO porque difere E o chamador o nomeou. */
  overwrite: string[];
  /** o que difere e fica como está — ninguém pediu para sobrescrever. */
  keptDiffering: string[];
  /** nomes pedidos em `overwrite` que não diferem (iguais, faltantes ou desconhecidos) — ignorados, e ditos. */
  ignoredOverwrite: Array<{ name: string; why: string }>;
}

/** O plano, puro: o que copia, o que sobrescreve (só o nomeado), o que fica. */
export function planSkillsSync(tool: readonly SkillTree[], target: readonly SkillTree[], overwrite: readonly string[] = []): SkillsSyncPlan {
  const drift = skillDrift(tool, target);
  const differing = new Set(drift.differ.map((d) => d.name));
  const asked = [...new Set(overwrite.map((n) => n.trim()).filter(Boolean))];
  const ignoredOverwrite: SkillsSyncPlan["ignoredOverwrite"] = [];
  for (const name of asked) {
    if (differing.has(name)) continue;
    if (drift.missing.includes(name)) ignoredOverwrite.push({ name, why: "falta no alvo — já é copiada sem precisar de overwrite" });
    else if (drift.same.includes(name)) ignoredOverwrite.push({ name, why: "idêntica à da ferramenta — nada a sobrescrever" });
    else ignoredOverwrite.push({ name, why: "a ferramenta não distribui uma skill com este nome" });
  }
  const over = drift.differ.map((d) => d.name).filter((n) => asked.includes(n));
  return {
    drift,
    copy: [...drift.missing],
    overwrite: over,
    keptDiffering: drift.differ.map((d) => d.name).filter((n) => !over.includes(n)),
    ignoredOverwrite,
  };
}

export interface SkillsSyncDeps {
  toolRoot: string;
  /** o checkout de RUNTIME do alvo — só LIDO, para o plano; nunca escrito. */
  targetRoot: string;
  readTrees(root: string): SkillTree[];
  openWorktree(task: string): Promise<{ ok: true; sessionId: string; path: string } | { ok: false; reason: string }>;
  /** a skill já existe NESTE caminho (a base de integração pode diferir do checkout de runtime)? */
  exists(p: string): boolean;
  /** copia a árvore `from` para `to`, SUBSTITUINDO o que houver em `to`. */
  copyTree(from: string, to: string): Promise<void>;
  submit(sessionId: string, message: string): Promise<{ ok: true; pinnedSha: string } | { ok: false; reason: string }>;
  discard(sessionId: string): Promise<void>;
}

export type SkillsSyncResult =
  | { ok: true; plan: SkillsSyncPlan; submitted: false; reason: string }
  | {
      ok: true;
      plan: SkillsSyncPlan;
      submitted: true;
      sessionId: string;
      pinnedSha: string;
      copied: string[];
      overwritten: string[];
      /** faltavam no runtime mas JÁ existiam na base de integração — não copiadas (nada é sobrescrito sem pedido). */
      skippedPresentInBase: string[];
      next: string;
    }
  | { ok: false; plan: SkillsSyncPlan; reason: string };

/**
 * SOBRESCREVER uma skill que o alvo customizou é decisão do OPERADOR — um token escopado (o copiloto, a frota) pode
 * trazer as que faltam, nunca trocar a instrução que ele próprio segue. Null quando pode. PURA.
 */
export function overwriteRefusal(overwrite: readonly string[] | undefined, scoped: boolean): string | null {
  if (!scoped || !overwrite?.some((n) => n.trim())) return null;
  return (
    "sobrescrever uma skill que o alvo customizou é decisão do operador: `overwrite` só com o token full. Sem ele, " +
    "esta tool copia apenas as que FALTAM."
  );
}

/** Executa o plano pelo worktree de sessão + merge train. `dryRun` só devolve o plano. Nunca lança. */
export async function syncSkills(
  deps: SkillsSyncDeps,
  opts: { overwrite?: readonly string[]; dryRun?: boolean; scoped?: boolean } = {},
): Promise<SkillsSyncResult> {
  const plan = planSkillsSync(deps.readTrees(deps.toolRoot), deps.readTrees(deps.targetRoot), opts.overwrite);
  const refused = overwriteRefusal(opts.overwrite, opts.scoped === true);
  if (refused) return { ok: false, plan, reason: refused };
  if (plan.copy.length === 0 && plan.overwrite.length === 0) {
    return { ok: true, plan, submitted: false, reason: "nada a copiar: nenhuma skill da ferramenta falta no alvo (e nenhuma sobrescrita foi pedida)" };
  }
  if (opts.dryRun) return { ok: true, plan, submitted: false, reason: "dryRun — nada foi escrito" };

  const names = [...plan.copy, ...plan.overwrite];
  const opened = await deps.openWorktree(`sync_skills: ${names.join(", ")}`.slice(0, 200));
  if (!opened.ok) return { ok: false, plan, reason: `não abri o worktree de sessão: ${opened.reason}` };

  const copied: string[] = [];
  const skippedPresentInBase: string[] = [];
  try {
    for (const name of plan.copy) {
      const dest = path.join(opened.path, SKILLS_DIR, name);
      // O plano mediu o RUNTIME; o worktree nasce da base de integração. Se a skill já está lá, ela é de
      // alguém — sem `overwrite` nomeando-a, não é nossa para trocar.
      if (deps.exists(dest)) {
        skippedPresentInBase.push(name);
        continue;
      }
      await deps.copyTree(path.join(deps.toolRoot, SKILLS_DIR, name), dest);
      copied.push(name);
    }
    for (const name of plan.overwrite) {
      await deps.copyTree(path.join(deps.toolRoot, SKILLS_DIR, name), path.join(opened.path, SKILLS_DIR, name));
    }
  } catch (err) {
    await deps.discard(opened.sessionId).catch(() => {});
    return { ok: false, plan, reason: `cópia falhou (worktree descartado): ${err instanceof Error ? err.message : String(err)}` };
  }

  if (copied.length === 0 && plan.overwrite.length === 0) {
    await deps.discard(opened.sessionId).catch(() => {});
    return {
      ok: true,
      plan,
      submitted: false,
      reason: `nada a submeter: ${skippedPresentInBase.join(", ")} já existe(m) na base de integração — o checkout de runtime ainda não a(s) recebeu`,
    };
  }

  const message =
    `chore(skills): sincroniza ${copied.length + plan.overwrite.length} skill(s) da ferramenta` +
    (copied.length ? ` — faltavam: ${copied.join(", ")}` : "") +
    (plan.overwrite.length ? ` — sobrescritas a pedido: ${plan.overwrite.join(", ")}` : "");
  const sub = await deps.submit(opened.sessionId, message);
  if (!sub.ok) {
    await deps.discard(opened.sessionId).catch(() => {});
    return { ok: false, plan, reason: `submissão ao merge train falhou (worktree descartado): ${sub.reason}` };
  }
  return {
    ok: true,
    plan,
    submitted: true,
    sessionId: opened.sessionId,
    pinnedSha: sub.pinnedSha,
    copied,
    overwritten: plan.overwrite,
    skippedPresentInBase,
    next:
      `o train integra ${sub.pinnedSha.slice(0, 8)} (roda o gate; .claude/** é caminho de controle). Aguarde o veredito com ` +
      `wait_for_submit({sessionId:"${opened.sessionId}"}) e depois worktree_discard({sessionId:"${opened.sessionId}"}).`,
  };
}
