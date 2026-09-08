// ONDE MORA O `claude` — a ferramenta de host mais carregada do produto, e a última a ganhar régua.
//
// POR QUE ESTE MÓDULO EXISTE. `runner/host-tools.ts` foi escrito para matar exatamente uma classe de
// bug: o motor chamar um executável por NOME NU e apostar num PATH que só existe na caixa do autor.
// Ele cobria `bun` e `just` — e deixava de fora o binário do qual TODO agente depende. Em 2026-08-20
// o Claude Code migrou para o instalador nativo, saiu de `/usr/local/bin` e passou a viver em
// `~/.local/bin`, fora do PATH que o unit do systemd FIXA. Todo spawn do motor virou
// `spawn claude ENOENT` — e ficou assim por SEIS DIAS, porque o erro morre no console de um card e
// nunca chega ao journal. Ninguém percebeu até alguém precisar do Jido.
//
// ── A DECISÃO DE PRECEDÊNCIA, E POR QUE ELA NÃO É "UM TERCEIRO CANAL" ──────────────────────────
//
// Antes disto existiam dois canais — `settings.yaml` `autorun.claudeBin` e a env
// `USM_AUTORUN_CLAUDE_BIN` — e eles diziam A MESMA COISA: "esta string é o argv0". `config.ts` já
// colapsa o segundo no primeiro, então no ponto de leitura sempre houve um valor só. Acrescentar uma
// terceira forma de dizer o mesmo seria defeito, não conserto.
//
// O conserto é fazer os canais dizerem coisas DIFERENTES, que é o que eles já queriam dizer:
//
//   · `autorun.claudeBin` (⊕ `USM_AUTORUN_CLAUDE_BIN`) = **o NOME**. QUAL executável procurar.
//     É PORTÁTIL: `claude` é o valor correto em toda máquina do mundo, e é exatamente por isso que
//     ele pode continuar viajando verbatim no `settings.yaml` publicado.
//
//   · `AGILEHARNESS_CLAUDE` = **o ENDEREÇO**. ONDE ele mora NESTA máquina. Env do serviço, absoluto,
//     fail-closed quando declarado-e-inexistente, e por construção jamais num artefato publicado.
//
// A consequência é o ponto todo: a armadilha do `settings.yaml` deixa de ser EVITADA POR CONVENÇÃO e
// passa a ser ESTRUTURALMENTE IMPOSSÍVEL. O campo que viaja é validado como um NOME; o único canal
// que carrega caminho absoluto é uma env que não existe do lado de lá.
//
// ── COMPATIBILIDADE, MEDIDA E PRESERVADA ──────────────────────────────────────────────────────
//
// Hoje `USM_AUTORUN_CLAUDE_BIN=/opt/claude-canary` FUNCIONA, porque `spawn` aceita argv0 absoluto.
// Quebrar isso seria remover capacidade de quem já configurou certo. Então um NOME que chega absoluto
// é tratado como ENDEREÇO — e passa a valer para ele a mesma checagem de existência fail-closed.
// Preserva toda configuração que funciona hoje, e para de aceitar em silêncio uma que não funciona.

import { existsSync } from "node:fs";
import path from "node:path";

import { HOST_TOOL_ENV, type HostToolResolution, resolveHostTool } from "./host-tools";

export interface ClaudeBinInput {
  /**
   * `settings.autorun.claudeBin` — que já É o colapso de `settings.yaml` ⊕ `USM_AUTORUN_CLAUDE_BIN`
   * feito por `config.ts`. Ausente ⇒ `"claude"`.
   *
   * Este módulo NÃO lê `loadRunnerConfig()` sozinho, de propósito: `preflight.ts` precisa chamá-lo
   * sem arrastar o `yaml` e a árvore de config para dentro de `dist/ah-server.mjs` (ver o
   * `bundle-guard`). Quem tem a config passa o valor; quem não tem recebe o default e o veredito
   * DIZ que usou o default.
   */
  name?: string;
  env?: Record<string, string | undefined>;
  /** injetável só para teste; em produção é o `existsSync` do fs. */
  exists?: (p: string) => boolean;
}

/** O nome procurado quando nada declara outro. */
export const CLAUDE_DEFAULT_NAME = "claude";

/**
 * O veredito NÃO-LANÇANTE — é o que o preflight consome, porque um relatório de prontidão que
 * levanta exceção no primeiro item não relata os outros catorze.
 */
export function resolveClaudeBinVerdict(input: ClaudeBinInput = {}): HostToolResolution {
  const env = input.env ?? process.env;
  const exists = input.exists ?? existsSync;
  const nome = (input.name ?? "").trim() || CLAUDE_DEFAULT_NAME;
  const varName = HOST_TOOL_ENV.claude;
  const endereco = (env[varName] ?? "").trim();

  // O ENDEREÇO vence sempre; delega para a régua, que já é fail-closed nesse degrau.
  if (endereco) return resolveHostTool("claude", { env, exists, name: nome });

  // Sem endereço declarado, e o NOME chegou absoluto: quem declarou foi o canal do NOME. A recusa
  // TEM de nomear esse canal — dizer "AGILEHARNESS_CLAUDE foi declarado mas não existe" mandaria o
  // operador corrigir uma variável que ele nunca escreveu, e é assim que um diagnóstico vira uma
  // caça ao ganso.
  if (path.isAbsolute(nome)) {
    if (!exists(nome)) {
      return {
        ok: false,
        refusal:
          `o binário do Claude Code foi declarado como "${nome}" (por \`autorun.claudeBin\` no ` +
          `\`storymap/settings.yaml\`, ou pela env \`USM_AUTORUN_CLAUDE_BIN\`) mas não existe nesta ` +
          `máquina. Corrija a declaração, ou apague-a e deixe o nome nu \`claude\` ser procurado no ` +
          `PATH — e, se o PATH do serviço não o alcança, declare o endereço em \`${varName}\`.`,
      };
    }
    return { ok: true, path: nome, via: "declarado" };
  }

  // Um nome que não é absoluto mas carrega separador (`./claude`, `bin/claude`) se resolveria contra
  // um cwd que este módulo não escolhe — o mesmo motivo pelo qual a régua recusa declaração relativa.
  if (nome.includes("/") || nome.includes("\\")) {
    return {
      ok: false,
      refusal:
        `"${nome}" não é nem um nome de executável nem um caminho absoluto. Use o nome nu ` +
        `(\`claude\`), que é procurado no PATH do serviço, ou declare o caminho completo em ` +
        `\`${varName}\`. Um caminho relativo se resolveria contra um diretório de trabalho que ` +
        `muda entre o serviço, o worktree de um run e o unit transiente do self-deploy.`,
    };
  }

  return resolveHostTool("claude", { env, exists, name: nome });
}

/** A recusa, transportada — para o sítio de spawn poder falhar NOMEANDO o conserto. */
export class ClaudeBinUnavailable extends Error {
  readonly refusal: string;
  constructor(refusal: string) {
    super(refusal);
    this.name = "ClaudeBinUnavailable";
    this.refusal = refusal;
  }
}

/**
 * O caminho ABSOLUTO pronto para virar argv0, ou lança. É o que os sítios de spawn chamam.
 *
 * LANÇA de propósito, ao contrário do veredito acima: no sítio de spawn a alternativa é passar um
 * nome que o SO não resolve, e aí a falha chega como um exit 127 anônimo — que foi precisamente o
 * que escondeu o incidente por seis dias. Falhar aqui, com a recusa que nomeia a variável, troca um
 * erro mudo por um erro que se conserta.
 */
export function resolvedClaudeBin(input: ClaudeBinInput = {}): string {
  const r = resolveClaudeBinVerdict(input);
  if (!r.ok) throw new ClaudeBinUnavailable(r.refusal);
  return r.path;
}
