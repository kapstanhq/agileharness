// A RAIZ PRÓPRIA DE SCRATCH DO HARNESS — e o helper que garante que ela seja limpa.
//
// ═══ O QUE FOI MEDIDO, e o que ele decide ═════════════════════════════════════════════
//
// Num host real, o `/tmp` acumulava milhares de entradas de topo, e cerca de um terço era do harness,
// espalhado por VÁRIOS prefixos sem parentesco (`storymap-`, `harness-`, `ah-`, `orch-`, `sm-flow-`,
// `copilot-turn-`, `visual-sweep-`, …). Um terceiro que instale isto não tem NENHUM handle para responder
// "o que o AgileHarness deixou aqui?". Esse argumento vale sozinho, independente de vazamento.
//
// ⚠️ HONESTIDADE SOBRE A MAGNITUDE, porque a tarefa original a exagerava: em volume são poucos MB. O
// disco não era o problema — a maior parte do `/tmp` era scratch de OUTRA ferramenta. Isto é problema de
// INODE e de PALHEIRO, não de disco. E a política da distro JÁ CEIFA: `tmpfiles.d` limpa `/tmp` por idade
// (30 dias é o default comum), e funciona — nenhum diretório `orch-` passava da janela. A acumulação é
// LIMITADA, não infinita. O ganho aqui é "dias" → "1 dia" e um endereço único; quem vender isto como
// "gigabytes de lixo" está mentindo.
//
// ═══ A CORRELAÇÃO QUE DECIDE O DESENHO ═══════════════════════════════════════════════════════════
//
// Entre os sites de runtime que criam scratch:
//   • os que limpam em `finally` ou closure incondicional  →  **0 órfãos**
//   • os que limpam dentro de um handler ou de um ramo      →  **a maioria dos órfãos**
//
// Não é opinião nem estilo: é o mesmo código, dois idiomas, e a diferença aparece inteira no disco.
// O pior deles spawna `detached: true` + `unref()` e só remove dentro de `child.on("exit")` — se o
// serviço reinicia antes de o filho sair, o handler NUNCA roda; e o `catch` externo devolvia erro
// sem remover nada. Daí as duas peças abaixo, e por que são duas:
//
//   {@link withHarnessTempDir} — a garantia PORTÁTIL, para quem pode esperar o próprio trabalho.
//   {@link sweepHarnessTempRoot} — a rede para quem NÃO pode: um filho detached que sobrevive ao pai
//     não tem `finally` possível. Para ele, a única limpeza honesta é alguém varrer depois.
//
// ═══ POR QUE ESTA RAIZ E NÃO OUTRA ═══════════════════════════════════════════════════════════════
//
// ❌ `$XDG_RUNTIME_DIR`: OBSERVADO ausente no ambiente do serviço (ele roda como root, sem
//    `RuntimeDirectory=`), mas PRESENTE num shell interativo. Escritor e leitor resolveriam raízes
//    diferentes — o modo de falha que já mordeu este repositório em outro lugar.
// ❌ pendurar em `runnerStateDir()`: (a) o default dele mora DENTRO do repositório, e o scratch em
//    questão contém o token MCP — credencial dentro da árvore versionada é regressão, não
//    organização; (b) ciclo de vida OPOSTO — lá vive ledger durável lido entre reinícios, e um
//    ceifador por idade apontado para o mesmo diretório apagaria coisa viva; (c) o setup de teste
//    sempre redireciona aquela variável, então a garantia viraria inverificável.
// ✅ `os.tmpdir()/agileharness`: honra `$TMPDIR` (logo, respeita o `$TMPDIR` por sessão da jaula) e
//    dá um caminho sensato num host que não seja Linux, sem presumir nada.
//
// ⚠️ E O LIMITE, escrito para a peça não virar vácuo-verde: o drop-in `tmpfiles.d` que acompanha
// isto só vale onde `os.tmpdir()` É `/tmp` e existe systemd. **O helper é a garantia portátil; o
// drop-in é só o backstop de queda no Linux.** Dizer "temos ceifador" sem esta frase é alegar uma
// cobertura que não existe.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** O nome da raiz. Um diretório, um handle: `ls /tmp/agileharness` responde a pergunta inteira. */
export const HARNESS_TEMP_DIRNAME = "agileharness";

/** A raiz de scratch efêmero do harness. Ver o cabeçalho para por que não é `runnerStateDir()`. */
export function harnessTempRoot(): string {
  return path.join(os.tmpdir(), HARNESS_TEMP_DIRNAME);
}

/** Cria um diretório de scratch sob a raiz. `prefix` é só um rótulo legível no `ls`. */
export async function makeHarnessTempDir(prefix: string): Promise<string> {
  const raiz = harnessTempRoot();
  await fs.mkdir(raiz, { recursive: true, mode: 0o700 });
  // O prefixo é sanitizado porque ele vira NOME DE CAMINHO: um chamador que passasse `../x` escaparia
  // da raiz e o ceifador nunca encontraria o que criou.
  const rotulo = prefix.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "scratch";
  return fs.mkdtemp(path.join(raiz, `${rotulo}-`));
}

/**
 * O IDIOMA QUE NÃO VAZA: cria, entrega, e remove no `finally` — aconteça o que acontecer no corpo.
 *
 * É a forma dos 6 sites que hoje têm zero órfãos, virada em helper para deixar de ser uma coisa que
 * cada chamador precisa LEMBRAR de fazer. A remoção é `force`+`recursive` e engole o próprio erro:
 * falhar ao limpar não pode transformar um trabalho bem-sucedido em exceção.
 */
export async function withHarnessTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await makeHarnessTempDir(prefix);
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A rede para o scratch que NÃO tem `finally` possível — o de um filho detached que sobrevive ao pai.
 *
 * `maxAgeMs` tem um PISO deliberado, e ele é o que separa esta função de um `rm -rf` agendado: o teto
 * duro de um run é 1h, e a maior duração já observada passou um pouco disso. Varrer com uma janela menor
 * que isso apagaria o scratch de um processo VIVO — trocar órfão por corrupção. O default de 24h é
 * muito acima do máximo observado; o piso impede que uma chamada desatenta desça abaixo do teto.
 *
 * Devolve o que removeu, para quem chama poder REPORTAR em vez de limpar em silêncio: uma limpeza que
 * ninguém vê é indistinguível de não ter tido o que limpar.
 */
export const VARREDURA_IDADE_MINIMA_MS = 2 * 60 * 60_000; // 2h — o dobro do teto duro de um run
export const VARREDURA_IDADE_PADRAO_MS = 24 * 60 * 60_000;

export async function sweepHarnessTempRoot(
  maxAgeMs: number = VARREDURA_IDADE_PADRAO_MS,
  agora: number = Date.now(),
): Promise<{ removidos: string[]; erros: number }> {
  const janela = Math.max(maxAgeMs, VARREDURA_IDADE_MINIMA_MS);
  const raiz = harnessTempRoot();
  const removidos: string[] = [];
  let erros = 0;
  const entradas = await fs.readdir(raiz, { withFileTypes: true }).catch(() => null);
  if (!entradas) return { removidos, erros }; // raiz ainda não existe — nada a varrer, e isso é normal
  for (const e of entradas) {
    const alvo = path.join(raiz, e.name);
    try {
      const st = await fs.stat(alvo);
      // `mtime`, e não `birthtime`: um scratch que ainda está sendo ESCRITO tem mtime recente mesmo
      // que tenha nascido há dias. É a diferença entre "velho" e "abandonado".
      if (agora - st.mtimeMs < janela) continue;
      await fs.rm(alvo, { recursive: true, force: true });
      removidos.push(e.name);
    } catch {
      erros++; // sumiu no caminho, ou é de outro usuário — nenhum dos dois é motivo para parar
    }
  }
  return { removidos, erros };
}
