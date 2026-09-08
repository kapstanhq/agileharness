// AS FERRAMENTAS DO HOST — os executáveis que o motor invoca FORA deste processo (`bun`, `just`), e
// como eles deixam de ser um endereço da máquina do AUTOR para virar uma DECLARAÇÃO do operador.
//
// POR QUE ESTE MÓDULO EXISTE. Até 2026-08 o motor chamava essas ferramentas de duas formas, e as duas
// eram a mesma aposta: `/root/.bun/bin/bun run build:staged` (o caminho absoluto da caixa do autor) e
// `spawn("just", …)` (o nome nu, contando com um PATH que só existe aqui). Numa instalação de terceiro
// isso não falha como configuração errada — falha como ENOENT no MEIO de um self-deploy, depois de o
// serviço já ter parado; ou, pior, executa o que quer que exista naquele caminho na máquina do outro.
// Nenhuma das duas falhas diz ao operador o que declarar.
//
// A RÉGUA, em ordem, e o que cada degrau significa:
//   1. **Declarado** (`AGILEHARNESS_BUN` / `AGILEHARNESS_JUST` no env do SERVIÇO) — o canal do operador,
//      o mesmo que já arma porta, host e lançadores de deploy. Absoluto e existente, ou recusa.
//   2. **PATH** do processo — o que a máquina resolveria para o mesmo nome. É o degrau que mantém esta
//      caixa byte-idêntica: o PATH do systemd aqui começa em `/root/.bun/bin`, então `bun` resolve para
//      exatamente o caminho que estava cravado.
//   3. **Nada.** Não há terceiro degrau. Um fallback adivinhado ("tenta ~/.bun/bin") é justamente o
//      defeito que este módulo remove: ele transforma "não configurado" em "configurado com a sorte de
//      outra pessoa". A ausência vira uma RECUSA que nomeia a variável a declarar.
//
// FAIL-CLOSED NA DECLARAÇÃO: declarado-mas-inexistente NÃO cai para o PATH. Cair seria esconder um erro
// de digitação na declaração atrás de um binário que por acaso funciona — o operador leria "deployou" e
// nunca saberia que a sua escolha foi ignorada.
//
// PURO sobre `env` e `exists` (injetáveis) — dá para testar a árvore de decisão inteira sem tocar no
// disco nem no PATH da máquina de teste.

import { existsSync } from "node:fs";
import path from "node:path";

/** As ferramentas do host que o motor invoca, e a variável que DECLARA cada uma. */
export const HOST_TOOL_ENV = {
  bun: "AGILEHARNESS_BUN",
  just: "AGILEHARNESS_JUST",
  claude: "AGILEHARNESS_CLAUDE",
} as const;

export type HostTool = keyof typeof HOST_TOOL_ENV;

/** Para que serve cada ferramenta — entra na recusa, para o operador saber o que perde se não declarar. */
const HOST_TOOL_PURPOSE: Record<HostTool, string> = {
  bun: "o build do self-deploy (`bun run build:staged`)",
  just: "as receitas do repositório (checks, planos e deploys de produto)",
  // Nomeia o que PARA, e não o que a ferramenta é — porque foi exatamente esta lista que ficou
  // seis dias parada sem ninguém saber (2026-08-20 → 26): o Claude Code migrou para
  // `~/.local/bin`, saiu do PATH que o unit do systemd FIXA, e todo spawn virou
  // `spawn claude ENOENT` — um erro que morre no console de um card e nunca chega ao journal.
  claude:
    "TODO agente que este motor dispara — a cascata do autorun, o Jido/orquestrador, o juiz de " +
    "conflito do merge train, a revisão por par, o agente de deploy e a captura inteligente",
};

export type HostToolResolution =
  | { ok: true; path: string; via: "declarado" | "PATH" }
  | { ok: false; refusal: string };

export interface HostToolProbe {
  env?: Record<string, string | undefined>;
  /** injetável só para teste; em produção é o `existsSync` do fs. */
  exists?: (p: string) => boolean;
  /**
   * O NOME do executável a procurar no PATH quando NÃO há declaração. Ausente ⇒ a própria chave
   * da ferramenta, que é o caso de `bun` e `just`.
   *
   * Existe porque o `claude` tinha DOIS canais dizendo a mesma coisa. Agora dizem coisas
   * DIFERENTES, e é essa separação que torna a armadilha impossível em vez de apenas evitada:
   *   · o NOME (`autorun.claudeBin`) é PORTÁTIL — "claude" é correto em toda máquina do
   *     mundo, e por isso pode viajar verbatim no `settings.yaml` publicado;
   *   · o ENDEREÇO (`AGILEHARNESS_CLAUDE`) é DESTA máquina — env do serviço, absoluto, e
   *     por construção nunca aparece num artefato publicado.
   *
   * Um canal só, carregando os dois sentidos, é exatamente como o caminho absoluto do autor
   * acabaria no arquivo que viaja — o defeito que este módulo existe para remover.
   */
  name?: string;
}

/**
 * Onde o PATH resolveria `name` — a MESMA busca que o shell faz, sem shell: cada diretório do PATH,
 * na ordem, o primeiro que contém o arquivo vence. Entradas vazias são puladas (um `PATH=a::b` tem
 * uma entrada vazia que o POSIX manda ler como "o diretório atual" — um cwd desconhecido não é lugar
 * de achar o binário que vai rodar como root, então aqui ela simplesmente não conta).
 */
export function lookupOnPath(
  name: string,
  env: Record<string, string | undefined> = process.env,
  exists: (p: string) => boolean = existsSync,
): string | null {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * O caminho ABSOLUTO da ferramenta, ou a recusa que diz o que declarar. Ver a régua no topo do arquivo.
 */
export function resolveHostTool(tool: HostTool, probe: HostToolProbe = {}): HostToolResolution {
  const env = probe.env ?? process.env;
  const exists = probe.exists ?? existsSync;
  const varName = HOST_TOOL_ENV[tool];
  const nome = probe.name?.trim() || tool;
  const declared = (env[varName] ?? "").trim();

  if (declared) {
    // Relativo é recusado porque ele se resolveria contra um cwd que este módulo não escolhe (o do
    // serviço, o do worktree, o do unit transiente — três lugares diferentes no mesmo dia).
    if (!path.isAbsolute(declared)) {
      return {
        ok: false,
        refusal: `${varName}="${declared}" não é um caminho absoluto — declare o caminho completo do executável \`${nome}\` (ex.: \`${varName}=/usr/local/bin/${nome}\`).`,
      };
    }
    if (!exists(declared)) {
      return {
        ok: false,
        refusal: `${varName}="${declared}" foi declarado mas não existe nesta máquina — corrija a declaração (a busca pelo PATH NÃO é tentada quando há declaração, para que um engano não fique escondido atrás de outro binário).`,
      };
    }
    return { ok: true, path: declared, via: "declarado" };
  }

  const found = lookupOnPath(nome, env, exists);
  if (found) return { ok: true, path: found, via: "PATH" };

  return {
    ok: false,
    refusal: `\`${nome}\` não foi encontrado no PATH deste serviço e não há declaração — ${HOST_TOOL_PURPOSE[tool]} depende dele. Instale-o, ou declare o caminho no env do serviço: \`${varName}=/caminho/para/${nome}\`.`,
  };
}

/**
 * O caminho pronto para ser EMBUTIDO num script de shell. Um caminho comum sai NU (é o que mantém o
 * script do self-deploy legível e byte-idêntico ao de antes); qualquer coisa fora do alfabeto seguro —
 * espaço, aspa, cifrão — sai em aspas simples POSIX, porque um caminho com espaço embutido cru vira
 * dois argumentos e o build "não encontrado" nunca explicaria o porquê.
 */
export function quotePathForShell(p: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

// ─── O SCRIPT DE AUTO-ATUALIZAÇÃO DA MÁQUINA ────────────────────────────────────────────────────
//
// A tool MCP `update_vps` dispara, como root e num unit transiente, o script que atualiza a caixa
// (pull + install + build + restart). Até 2026-08 esse script era `/root/update.sh` — CRAVADO. Numa
// caixa de terceiro esse caminho ou não existe (a tool falha sem dizer o que fazer) ou EXISTE E É
// OUTRA COISA — e aí uma tool que um agente autônomo pode chamar sozinho executa um script alheio
// como root. É a diferença entre "não funciona" e "funciona contra você".
//
// Por isso NÃO há default: sem declaração a tool RECUSA. Um caminho default aqui seria, literalmente,
// a aposta de que o arquivo na máquina do outro faz o que o nome sugere.

export const UPDATE_SCRIPT_ENV = "AGILEHARNESS_UPDATE_SCRIPT";
export const UPDATE_LOG_ENV = "AGILEHARNESS_UPDATE_LOG";

export type UpdateScriptResolution =
  | { ok: true; script: string; argv: string[] }
  | { ok: false; refusal: string };

/**
 * O script de auto-atualização DECLARADO, ou a recusa. Absoluto e existente — as duas exigências pelo
 * mesmo motivo do {@link resolveHostTool}: isto vira argv de um processo root, e um caminho relativo
 * se resolveria contra um cwd que ninguém aqui escolheu.
 */
export function resolveUpdateScript(probe: HostToolProbe = {}): UpdateScriptResolution {
  const env = probe.env ?? process.env;
  const exists = probe.exists ?? existsSync;
  const declared = (env[UPDATE_SCRIPT_ENV] ?? "").trim();

  if (!declared) {
    return {
      ok: false,
      refusal:
        `esta instalação não declarou um script de atualização, e não existe default: ` +
        `\`${UPDATE_SCRIPT_ENV}\` está vazia. Escreva o script que ESTA máquina usa para se atualizar ` +
        `(tipicamente \`git pull --ff-only\` + instalar dependências + build + \`systemctl restart\`) e ` +
        `declare o caminho absoluto dele no env do serviço: \`${UPDATE_SCRIPT_ENV}=/caminho/update.sh\`. ` +
        `Sem declaração nada é executado — uma tool que roda como root não adivinha qual arquivo desta ` +
        `máquina é o script de atualização.`,
    };
  }
  if (!path.isAbsolute(declared)) {
    return {
      ok: false,
      refusal: `${UPDATE_SCRIPT_ENV}="${declared}" não é um caminho absoluto — o script roda num unit transiente, cujo cwd não é o seu.`,
    };
  }
  if (!exists(declared)) {
    return { ok: false, refusal: `${UPDATE_SCRIPT_ENV}="${declared}" foi declarado mas não existe nesta máquina.` };
  }
  return { ok: true, script: declared, argv: ["bash", declared] };
}

/** O log que `update_status` mostra — declarado, ou nenhum (e nesse caso a resposta DIZ que não há). */
export function resolveUpdateLog(env: Record<string, string | undefined> = process.env): string | null {
  const declared = (env[UPDATE_LOG_ENV] ?? "").trim();
  return declared && path.isAbsolute(declared) ? declared : null;
}

// ── OPS: o script de relatório de erros e a unidade de serviço ────────────────────────────────────
//
// Mesma régua do `resolveUpdateScript`, aplicada às tools de ops. O que estava errado antes: três
// tools PUBLICADAS na lista de ferramentas do adotante chamavam bens da máquina de origem —
// `query_errors`/`ops_health` rodavam `scripts/ops/error-report.js` (um caminho relativo a um cwd que
// ninguém aqui escolheu, e um arquivo que a extração NÃO leva), e `service_health` perguntava ao
// systemd por uma unidade de nome fixo. Uma tool anunciada que não pode funcionar é pior que a
// ausência dela: o agente do outro lado a chama, recebe um erro de execução opaco, e gasta um ciclo
// descobrindo que o problema não é dele.

export const OPS_REPORT_SCRIPT_ENV = "AGILEHARNESS_OPS_REPORT_SCRIPT";
export const SERVICE_UNIT_ENV = "AGILEHARNESS_SERVICE_UNIT";

export type OpsReportResolution =
  | { ok: true; script: string }
  | { ok: false; refusal: string };

/**
 * O script de relatório de erros DECLARADO, ou a recusa. Absoluto e existente pelo mesmo motivo do
 * {@link resolveUpdateScript}: vira argv de um processo, e um caminho relativo se resolveria contra
 * um cwd que não é o do operador. Sem declaração as tools que dependem dele NÃO SÃO REGISTRADAS.
 */
export function resolveOpsReportScript(probe: HostToolProbe = {}): OpsReportResolution {
  const env = probe.env ?? process.env;
  const exists = probe.exists ?? existsSync;
  const declared = (env[OPS_REPORT_SCRIPT_ENV] ?? "").trim();

  if (!declared) {
    return {
      ok: false,
      refusal:
        `esta instalação não declarou um script de relatório de erros, e não existe default: ` +
        `\`${OPS_REPORT_SCRIPT_ENV}\` está vazia. As tools de ops (\`query_errors\`, \`ops_health\`) ` +
        `ficam FORA da lista publicada até você declarar o caminho absoluto do script que ESTA ` +
        `instalação usa para consultar os erros de produção dela: ` +
        `\`${OPS_REPORT_SCRIPT_ENV}=/caminho/error-report.js\`. O contrato esperado é o de um script ` +
        `Node que aceita \`--json\`, \`--health\`, \`--service <nome>\` e \`--last <janela>\`.`,
    };
  }
  if (!path.isAbsolute(declared)) {
    return { ok: false, refusal: `${OPS_REPORT_SCRIPT_ENV}="${declared}" não é um caminho absoluto — o cwd do serviço não é o seu.` };
  }
  if (!exists(declared)) {
    return { ok: false, refusal: `${OPS_REPORT_SCRIPT_ENV}="${declared}" foi declarado mas não existe nesta máquina.` };
  }
  return { ok: true, script: declared };
}

/**
 * A unidade de serviço DECLARADA, ou `null`. Diferente dos dois acima isto é um NOME, não um caminho —
 * e por isso a validação é de forma: o que vai virar argv de `systemctl` não pode carregar espaço,
 * barra nem cifrão. Sem declaração, `service_health` continua existindo (a metade HTTP é portátil e
 * útil em qualquer instalação) e RESPONDE que não há unidade declarada, em vez de inventar uma.
 */
export function resolveServiceUnit(env: Record<string, string | undefined> = process.env): string | null {
  const declared = (env[SERVICE_UNIT_ENV] ?? "").trim();
  if (!declared) return null;
  return /^[A-Za-z0-9@._-]+$/.test(declared) ? declared : null;
}

/**
 * A porta que uma sonda de saúde local deve bater. Deriva do MESMO par de variáveis que o servidor lê
 * em `src/server/main.ts` — repetir o literal aqui é como o 3000 sobreviveu no README.
 */
export function resolveServiceProbePort(env: Record<string, string | undefined> = process.env): number {
  return Number(env.AGILEHARNESS_PORT || env.PORT) || 3008;
}
