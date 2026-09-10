// A CERCA DA ÁRVORE DO ALVO — a metade que faltava de uma proteção que a ferramenta já aplica.
//
// POR QUE ESTE MÓDULO EXISTE. `runnerStateDir()` (paths.ts) é `<findRepoRoot()>/storymap/.runner`, e
// `findRepoRoot()` honra `AGILEHARNESS_TARGET`. Ou seja: no modo que existe justamente para operar o
// repositório de OUTRA pessoa, estes cinco arquivos nascem DENTRO da árvore dela —
//
//   storymap/.runner/auth-token            login da interface (opera o board inteiro)
//   storymap/.runner/session-secret        assina o cookie de sessão
//   storymap/.runner/mcp-token             token MCP de nível `full`
//   storymap/.runner/mcp-handles.json      registro das credenciais MCP
//   storymap/.runner/sessions/*.mcp.json   com o token `orch` INLINADO
//
// — e as duas cercas que existiam eram ambas da árvore da FERRAMENTA: `packages/storymap-ui/.gitignore`
// (relativo ao pacote; no repo extraído o pacote é a raiz, então lá protege) e o `.gitignore` da raiz
// do umbrella. Nenhuma das duas viaja para o alvo. MEDIDO num repo adotante recém-criado: `git add
// storymap/` põe os cinco no índice, e `git check-ignore -v` responde `::` — nenhum padrão os cobre.
//
// A ferramenta já protege esses arquivos SEM PEDIR PERMISSÃO, com `writeFileSync(..., {mode: 0o600})`
// + `chmodSync` (auth/token.ts). Isso os defende de outro USUÁRIO da máquina. Não os defende do
// REPOSITÓRIO — e é o repositório que a documentação convida a versionar ("o board é dado versionado
// (…) o git log do seu produto e o do seu processo de produto passam a ser o mesmo log"). Semear uma
// linha de ignore em volta de um diretório que a própria ferramenta acabou de criar é exatamente a
// outra metade desse gesto: não concede nada, não gasta nada, não executa nada.
//
// A DISTINÇÃO COM `registerBoard`, que RECUSA semear `_base/board.yaml` na árvore alheia: aquele
// arquivo é POLÍTICA DE EXECUÇÃO (uma pipeline de passos com autorun que gastam token de quem
// hospeda). Materializá-lo sem pedir seria decidir pelo outro. Uma regra de ignore não decide nada.
//
// SONDA ANTES DE ESCREVER. A primeira coisa é perguntar ao git se o caminho JÁ está coberto. No
// umbrella e no repositório extraído ele está (a cerca da raiz alcança), então nesses dois — que são
// todos os repositórios que existem hoje — este módulo não encosta em disco nenhum. Só o adotante
// descoberto recebe escrita, e é esse o ponto.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { findRepoRoot } from "./paths";

/** Delimitadores do bloco que este módulo escreve. A idempotência é pela SENTINELA, não pela regra. */
export const FENCE_ABRE = "# >>> agileharness >>>";
export const FENCE_FECHA = "# <<< agileharness <<<";

/** O caminho-sonda: existir ou não é irrelevante para `check-ignore --no-index`, MEDIDO. */
const CAMINHO_SONDA = "storymap/.runner/auth-token";

/** O que o diretório guarda, para o bloco explicar-se a quem o ler daqui a um ano. */
const BLOCO = [
  FENCE_ABRE,
  "# Estado de RUNTIME do AgileHarness. Não versionar: aqui nascem `auth-token` (login da",
  "# interface), `session-secret` (assina o cookie), `mcp-token` (nível full), `mcp-handles.json` e",
  "# `sessions/*.mcp.json` (com o token orch inlinado). Qualquer um deles opera este board, e o",
  "# board spawna agentes com poder de execução. A ferramenta os cria a 0600 — isso os protege de",
  "# outro usuário da máquina; esta linha os protege do repositório.",
  ".runner/",
  FENCE_FECHA,
].join("\n");

export type VereditoCerca =
  /** O git já cobre o caminho — nada a fazer (o caso do umbrella e do repo extraído). */
  | { acao: "ja-coberto" }
  /** Não é repositório git (ZIP baixado, alvo sem `git init`): não há índice onde vazar. */
  | { acao: "sem-git" }
  /** Bloco já presente: respeitamos a árvore alheia, mesmo que o operador o tenha esvaziado. */
  | { acao: "sentinela-presente"; arquivo: string }
  /** Semeado agora. */
  | { acao: "semeado"; arquivo: string; criouArquivo: boolean }
  /** A sonda respondeu algo que não sabemos ler — não adivinhamos. */
  | { acao: "instrumento-quebrado"; status: number };

export interface SondaGit {
  /** roda git no alvo; devolve o status de saída. Injetável para teste. */
  status: (args: readonly string[]) => number;
  /** roda git no alvo e devolve a stdout; usada só para listar rastreados. */
  saida: (args: readonly string[]) => string;
}

function sondaReal(alvo: string): SondaGit {
  const opc = { cwd: alvo, stdio: "pipe" as const, encoding: "utf8" as const };
  return {
    status: (args) => {
      try {
        execFileSync("git", [...args], opc);
        return 0;
      } catch (e) {
        // `status` ausente = o binário não existe / não executou. Isso NÃO é "não casou": é
        // instrumento quebrado, e a diferença entre os dois já custou uma medição inteira nesta
        // casa (ler 12 erros como 12 respostas). Devolvemos um código impossível para o chamador
        // recusar em vez de concluir.
        const s = (e as { status?: number }).status;
        return typeof s === "number" ? s : -1;
      }
    },
    saida: (args) => {
      try {
        return execFileSync("git", [...args], opc).toString();
      } catch {
        return "";
      }
    },
  };
}

/** Memoização por processo: o boot chama isto uma vez, mas há dois entrypoints e eles se cruzam. */
let jaRodou: VereditoCerca | null = null;

export function resetTargetFenceCache(): void {
  jaRodou = null;
}

/**
 * Garante que o estado de runtime do AgileHarness esteja fora do versionamento DO ALVO.
 *
 * Não lança: uma cerca é defesa em profundidade, e derrubar o boot porque o git respondeu torto
 * trocaria um risco por uma indisponibilidade. O veredito volta para quem quiser registrá-lo.
 */
export function ensureTargetFence(
  opts: { alvo?: string; sonda?: SondaGit; avisar?: (msg: string) => void } = {},
): VereditoCerca {
  if (jaRodou && !opts.sonda) return jaRodou;

  // `findRepoRoot` lê a env por CHAMADA (não no load), então isto é o alvo do momento.
  const alvo = opts.alvo ?? findRepoRoot();
  const sonda = opts.sonda ?? sondaReal(alvo);
  const avisar = opts.avisar ?? ((m: string) => console.warn(m));

  const veredito = decidir(alvo, sonda, avisar);
  if (!opts.sonda) jaRodou = veredito;
  return veredito;
}

function decidir(alvo: string, sonda: SondaGit, avisar: (m: string) => void): VereditoCerca {
  // `--no-index` é o que permite sondar um caminho que ainda NÃO existe: a decisão precisa ser
  // tomada ANTES de o primeiro segredo ser escrito, senão a cerca chega tarde por um instante.
  const st = sonda.status(["check-ignore", "--no-index", "-q", "--", CAMINHO_SONDA]);

  if (st === 0) return { acao: "ja-coberto" };
  if (st === 128) return { acao: "sem-git" };
  if (st !== 1) return { acao: "instrumento-quebrado", status: st };

  // DESCOBERTO. Antes de semear, o aviso que o semeador sozinho não daria: se o adotante já
  // commitou o diretório, acrescentar a regra agora NÃO destrata o que está no índice — e ele
  // ficaria com a falsa sensação de estar protegido. Aí o remédio não é ignorar, é ROTACIONAR.
  const rastreados = sonda.saida(["ls-files", "--", "storymap/.runner"]).trim();
  if (rastreados) {
    avisar(
      "[cerca] ⚠️ ALTO: `storymap/.runner/` JÁ ESTÁ VERSIONADO neste repositório — os segredos do " +
        "AgileHarness estão num commit.\n" +
        "        Ignorar agora NÃO os remove do histórico. Faça, nesta ordem:\n" +
        "          1. git rm -r --cached storymap/.runner\n" +
        "          2. ROTACIONE os segredos (apague `storymap/.runner/` e deixe o próximo boot recriá-los;\n" +
        "             revogue os handles MCP com --list-mcp-handles / --revoke-mcp-handle)\n" +
        "        Um segredo que entrou num commit é um segredo vazado, mesmo em repositório privado.",
    );
  }

  const arquivo = path.join(alvo, "storymap", ".gitignore");
  const existia = existsSync(arquivo);
  const atual = existia ? readFileSync(arquivo, "utf8") : "";

  // IDEMPOTÊNCIA PELA SENTINELA, não pela regra. Se o bloco está lá em qualquer forma — inclusive
  // esvaziado de propósito pelo operador — não tocamos mais. Reinserir a regra que ele apagou
  // seria sobrescrever uma escolha alheia, que é justamente o que este módulo não faz.
  if (atual.includes(FENCE_ABRE)) return { acao: "sentinela-presente", arquivo };

  // APPEND, nunca reescrita: o arquivo pode ser do adotante, com regras dele.
  // Ressalva honesta: se ele tiver uma NEGAÇÃO (`!.runner/algo`) antes, o nosso append vence. A
  // direção do erro é fail-SAFE (mais ignorado, não menos), e é a que preferimos aqui.
  const corpo = atual && !atual.endsWith("\n") ? `${atual}\n\n${BLOCO}\n` : `${atual}${atual ? "\n" : ""}${BLOCO}\n`;
  mkdirSync(path.dirname(arquivo), { recursive: true });
  writeFileSync(arquivo, corpo);
  return { acao: "semeado", arquivo, criouArquivo: !existia };
}
