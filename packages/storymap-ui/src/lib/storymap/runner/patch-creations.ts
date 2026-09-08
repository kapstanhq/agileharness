// patch-creations.ts — o que um patch CRIA, e a varredura do resíduo que impede de criá-lo.
//
// A CLASSE (medida em 2026-09-01, entrada d6d44f92 num alvo real): um patch de código que
// CRIA um arquivo num caminho que a branch-alvo ainda gitignora. O split aplica, algo falha depois, o
// `reset --hard HEAD` «deixa o stage limpo» — mas reset não remove arquivo NOVO (ignorado ou só
// não-rastreado), então o arquivo criado sobrevive. A tentativa seguinte morre no PRIMEIRO degrau do
// applyPatch (`git apply --check` → «already exists in working directory»), o `--3way` também
// («does not exist in index»), e o chamador carimba «split: código conflita com stage» — um veredito
// que mente: o mesmo patch aplica limpo num worktree fresco cortado de stage. Cinco submissões
// idênticas morreram assim; e o worktree do train carregava um `vendor/snapdom.mjs` de julho, resíduo
// de outra entrada, pela mesma porta. Vendorizar (versionar algo antes gerado no build) é raro — por
// isso a classe ficou meses sem aparecer.
//
// A RÉGUA: só se toca o que NÃO está rastreado no HEAD do worktree, e só nos caminhos que ESTE patch
// cria. Caminho rastreado que «já existe» é conflito de verdade, e o applyPatch tem de vê-lo. O stage
// é o worktree INTERNO do train — ninguém mais escreve nele —, então um arquivo não-rastreado num
// caminho que o patch cria não pode ser trabalho legítimo de ninguém.
import { quote, type GitRunner } from "./git";

/**
 * Caminhos que o patch CRIA — o `diff --git` cujo cabeçalho estendido traz `new file mode`. O train gera
 * o patch com `--no-renames`, então rename não existe aqui. Caminho com aspas (espaço/caractere especial)
 * é PULADO de propósito: melhor não varrer do que varrer o caminho errado.
 */
export function patchCreatedPaths(patchText: string): string[] {
  const out: string[] = [];
  const lines = patchText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(lines[i]);
    if (!m) continue;
    const target = m[2];
    if (target.startsWith('"') || target.includes(" ")) continue;
    // o cabeçalho estendido segue imediatamente o `diff --git`; `new file mode` é a marca de criação
    for (let j = i + 1; j < lines.length && j <= i + 6 && !lines[j].startsWith("diff --git "); j++) {
      if (lines[j].startsWith("new file mode ")) {
        out.push(target);
        break;
      }
    }
  }
  return out;
}

/**
 * Remove, no worktree, o que estiver NÃO-RASTREADO (ignorado incluso) exatamente nos caminhos que o
 * patch cria. Nunca toca caminho rastreado no HEAD do worktree. Devolve os caminhos que de fato varreu
 * (um caminho ausente não conta). Sobre o GitRunner injetado → testável com git real num diretório
 * temporário (patch-creations.test.ts) sem montar o train inteiro.
 */
export async function sweepPatchCreations(
  git: GitRunner,
  worktree: string,
  createdPaths: readonly string[],
): Promise<string[]> {
  const swept: string[] = [];
  for (const p of createdPaths) {
    const tracked = await git(`ls-files --error-unmatch -- ${quote(p)}`, worktree);
    if (tracked.ok) continue; // rastreado no HEAD: «already exists» seria conflito real — o applyPatch decide
    // `-x` alcança o IGNORADO (a classe do incidente); `-f` porque clean.requireForce; SEM `-d`, e com
    // pathspec de ARQUIVO: nada além deste caminho é tocado. `git clean` imprime «Removing <p>» por
    // arquivo removido — é o que distingue «varreu» de «não havia nada».
    const r = await git(`clean -f -x -- ${quote(p)}`, worktree);
    if (r.ok && /^Removing /m.test(r.stdout)) swept.push(p);
  }
  return swept;
}
