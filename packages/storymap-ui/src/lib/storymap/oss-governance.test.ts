// ATAQUE: o repositório publicado ANUNCIA governança que o GitHub não executa.
//
// Três formas, todas medidas nesta casa antes deste arquivo existir:
//
//   (1) A política de segurança estava só em `packages/storymap-ui/SECURITY.md`. O GitHub só
//       reconhece política de segurança na RAIZ, em `/docs` ou em `/.github` — enterrada dentro de
//       `packages/` ela não vira a aba *Security* nem liga o botão de reporte privado. Numa
//       ferramenta que spawna agentes com permissão desligada e serve um shell por WebSocket, quem
//       achar uma falha não tem canal declarado e abre issue PÚBLICO: a janela entre o relato e o
//       patch vira o ataque.
//   (2) O documento publicava, por escrito, um campo de contato POR PREENCHER — ou seja, anunciava
//       ao pesquisador que o projeto não decidiu quem responde. Um marcador de pendência é honesto
//       enquanto não viaja; publicado, ele é um canal que não existe com cara de canal.
//   (3) O `CODEOWNERS` apontava para um time inexistente e mandava, em comentário, "substituir na
//       extração". Dono que o GitHub não resolve não vira revisor obrigatório: a regra é IGNORADA em
//       silêncio, o PR entra sem leitura, e a tela de proteção de branch continua anunciando
//       "require review from Code Owners". Ilusão de revisão é pior que revisão ausente — ninguém
//       procura o que acha que já tem. Mesma classe: regra apontando para caminho que não existe no
//       artefato.
//
// O QUE ESTE ARQUIVO MEDE, então, é o conjunto que VIAJA — não a intenção de quem escreveu:
//   · os três documentos (SECURITY.md, CONTRIBUTING.md, .github/CODEOWNERS) CHEGAM à raiz do
//     artefato, pelo endereço que o GitHub lê;
//   · nenhum documento que viaja carrega marcador de preenchimento pendente;
//   · nenhuma regra do CODEOWNERS é morta (caminho sem sobrevivente) e nenhum dono é implausível;
//   · todo PROMPT-AS-CODE que viaja — instrução que um agente autônomo executa na máquina de quem
//     adotou — tem revisor obrigatório NOMEADO, e não só o `*` do piso.
//
// ── POR QUE ESTE GUARDA NÃO ACUSA A SI MESMO ─────────────────────────────────────────────────────
// A fase anterior levou essa mordida: um guarda que varre CONTEÚDO e escreve literalmente aquilo que
// proíbe se reprova sozinho (`oss-identity-hygiene.test.ts` acusou a si mesmo em 5 de 6 infrações, e
// a saída foi cortá-lo da régua). Aqui a saída é outra e é estrutural, não uma isenção: a varredura
// tem por sujeito DOCUMENTO — `.md` mais os arquivos de governança sem extensão —, e este arquivo é
// `.ts`. Ele não está no conjunto que varre, então pode escrever os literais que caça sem se
// auto-acusar, e continua viajando (o gate do repositório público precisa dele lá). Se algum dia a
// varredura passar a cobrir `.ts`, a escolha honesta é uma das duas do irmão — construir o literal
// em tempo de execução, ou tirar o guarda do conjunto —, nunca uma exceção com o próprio nome.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";


/** A raiz do repositório, resolvida pela LOCALIZAÇÃO DESTA FONTE (não por cwd nem por env). */
const RAIZ = path.resolve(fileURLToPath(new URL("../../../../../", import.meta.url)));

/** Este arquivo, relativo à raiz — a testemunha de que a varredura está na árvore certa. */
const ESTE_ARQUIVO = path
  .relative(RAIZ, fileURLToPath(import.meta.url))
  .split(path.sep)
  .join("/");

/**
 * Piso do conjunto rastreado. MEDIDO em 2026-08-19: 5939 arquivos no umbrella, 1216 no conjunto que
 * viaja. O piso é baixo de propósito — ele não existe para cravar o número de hoje, existe para
 * separar "varreu a árvore" de "varreu o vazio", que é o único jeito de uma asserção de AUSÊNCIA
 * ficar verde por não ter medido nada.
 */
const PISO_DE_ARQUIVOS = 200;

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: RAIZ, encoding: "utf8", maxBuffer: 1 << 28 });
}

/**
 * Testemunhas FORA da árvore-ferramenta. Uma varredura amputada em `packages/storymap-ui` satisfaz o
 * piso por construção (o piso é derivado da mesma árvore) e não seria pega por ele; estas três
 * moram fora dela e somem juntas quando a varredura está apontada para o lugar errado.
 */
const TESTEMUNHAS_EXTERNAS = ["LICENSE", ".github/CODEOWNERS", "storymap/boards/_base/board.yaml"] as const;

/**
 * O conjunto que CHEGA ao repositório publicado: o rastreado inteiro — a árvore é uma só desde a issue
 * #1. Nunca uma segunda lista de arquivos: duas listas são duas verdades, e a que apodrece falha calada.
 *
 * A ÚNICA EXTENSÃO, estreita e declarada: um documento da tabela `GOVERNANCA` que já existe em disco
 * mas ainda não foi commitado conta como viajante. Um guarda que fica vermelho enquanto o autor escreve
 * o arquivo é desligado no primeiro dia; quem cobra o commit é o portão de publicação.
 */
function conjuntoQueViaja(): { viajam: string[]; rastreados: string[] } {
  const rastreados = git(["ls-files"]).split("\n").filter(Boolean);
  if (rastreados.length < PISO_DE_ARQUIVOS) {
    throw new Error(
      `git ls-files leu ${rastreados.length} arquivos em ${RAIZ}, abaixo do piso de ${PISO_DE_ARQUIVOS}. ` +
        "Instrumento quebrado — toda asserção de ausência abaixo ficaria verde por vacuidade.",
    );
  }
  // Testemunha nº 1: a raiz resolvida é MESMO a árvore deste arquivo. (Não dá para exigi-lo entre os
  // RASTREADOS: enquanto este guarda está sendo escrito ele é, ele próprio, um arquivo não commitado.)
  if (!existsSync(path.join(RAIZ, ESTE_ARQUIVO))) {
    throw new Error(
      `${RAIZ} não contém ${ESTE_ARQUIVO}, que é ESTE arquivo — a raiz resolvida é outra árvore.`,
    );
  }
  // Testemunha nº 2: o git leu uma árvore que tem o que está FORA da ferramenta.
  if (!TESTEMUNHAS_EXTERNAS.some((p) => rastreados.includes(p))) {
    throw new Error(
      `os ${rastreados.length} caminhos rastreados não incluem NENHUMA de ${TESTEMUNHAS_EXTERNAS.join(", ")}. ` +
        "Uma varredura que enxerga só a árvore-ferramenta satisfaz o piso por construção — é o caso que " +
        "o piso sozinho não pega.",
    );
  }

  const naoCommitados = GOVERNANCA.map((d) => d.destino).filter(
    (rel) => !rastreados.includes(rel) && existsSync(path.join(RAIZ, rel)),
  );
  for (const p of naoCommitados) {
    console.warn(
      `⚠ [oss-governance] "${p}" ainda não está commitado; é medido como viajante. O commit é cobrado ` +
        "pelo portão de publicação, não aqui.",
    );
  }
  return { viajam: [...rastreados, ...naoCommitados], rastreados };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// OS TRÊS DOCUMENTOS que o GitHub lê
// ─────────────────────────────────────────────────────────────────────────────────────────────────
interface DocDeGovernanca {
  /** Onde ele FICA no repositório publicado — o caminho que o GitHub lê. */
  readonly destino: string;
  /** O que se perde quando ele não chega. Aparece na mensagem de falha. */
  readonly porque: string;
}

const GOVERNANCA: readonly DocDeGovernanca[] = [
  {
    destino: "SECURITY.md",
    porque:
      "sem ela na RAIZ o GitHub não abre a aba Security nem o botão de reporte privado, e quem achar " +
      "uma falha nesta ferramenta abre issue PÚBLICO por falta de canal declarado",
  },
  {
    destino: "CONTRIBUTING.md",
    porque:
      "é o que o GitHub linka no formulário de PR e de issue; sem ele o primeiro contribuidor descobre " +
      "sozinho, e errando, que a verificação de tela desta base só vale em build de produção",
  },
  {
    destino: ".github/CODEOWNERS",
    porque:
      "é o que transforma 'require review from Code Owners' em revisor de verdade; fora de `.github/` " +
      "ele é um arquivo de texto que ninguém executa",
  },
];

/** O caminho deste documento na árvore. */
function caminhoAqui(doc: DocDeGovernanca): string {
  return doc.destino;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// MARCADORES DE PENDÊNCIA — o que um documento publicado não pode carregar
// ─────────────────────────────────────────────────────────────────────────────────────────────────
interface Marcador {
  readonly nome: string;
  readonly re: RegExp;
  readonly porque: string;
}

const MARCADORES: readonly Marcador[] = [
  {
    // ⚠ MAIÚSCULA É O DISCRIMINADOR, e ele foi comprado com um falso-positivo REAL: a primeira versão
    // desta régua era `/i` e acusou `.claude/skills/harness-qa/SKILL.md:360`, que escreve
    // `127.0.0.1:<your port>` num exemplo de comando. Aquilo não é pendência de quem escreveu — é um
    // PARÂMETRO que o leitor substitui na hora de rodar, e prosa correta acusada é como um guarda vira
    // barulho e é desligado. A convenção que separa os dois é a caixa: `<PREENCHER>`, `<FILL_ME>`,
    // `<YOUR_TOKEN>` são o autor dizendo "não decidi"; `<your port>` é a documentação falando com o
    // leitor. Por isso este marcador — e só este — é sensível à caixa.
    nome: "campo por preencher",
    re: /<\s*(PREENCHER|FILL[ _-]?ME|INSERT|YOUR[ _-]|TODO|TBD)/,
    porque:
      "publicado, um campo marcado como pendente é a afirmação de que ninguém decidiu — no contato de " +
      "segurança isso é um canal inexistente com cara de canal",
  },
  {
    // ⚠ O `:` (ou o parêntese) NÃO é decoração — é o discriminador que separa o marcador de trabalho
    // pendente da palavra portuguesa "todo/toda". MEDIDO: `.claude/skills/harness-do/SKILL.md:244` diz
    // "TODO commit carrega o id do card", e uma varredura por `TODO` cru acusa essa linha. Um guarda
    // que dá falso-positivo em prosa correta é desligado na segunda semana — e desligado ele não pega
    // o verdadeiro. O caso sintético logo abaixo prova a distinção nos dois sentidos.
    nome: "marcador de trabalho pendente",
    re: /\b(TODO|FIXME|HACK)\s*[:(]/,
    porque: "trabalho por fazer anotado no documento publicado — o leitor não sabe se é rascunho ou política",
  },
  {
    nome: "marcador XXX",
    re: /\bXXX\b/,
    porque: "a forma sem dois-pontos do marcador de rascunho; não tem outro uso em prosa desta base",
  },
  {
    nome: "handle de exemplo",
    re: /@(handle|your[-_]?[a-z]+|seu[-_]?[a-z]+|example|org)\b/i,
    porque:
      "dono/contato de exemplo é a mesma ilusão do time inexistente: o GitHub não resolve e a regra vira " +
      "sugestão silenciosa",
  },
  {
    nome: "e-mail de exemplo",
    re: /[A-Za-z0-9._%+-]+@(example|exemplo|test|dominio|domain|yourdomain|yourcompany|email|acme)\.[a-z]{2,}/i,
    porque: "um relato de falha enviado a uma caixa inventada é pior que a ausência de canal: o pesquisador acha que avisou",
  },
];

/** Documento para efeito desta varredura: prosa publicada, não código nem dado de board. */
function ehDocumento(rel: string): boolean {
  const base = rel.split("/").pop() ?? "";
  return /\.md$/i.test(base) || ["LICENSE", "NOTICE", "CODEOWNERS"].includes(base);
}

interface Infracao {
  readonly arquivo: string;
  readonly linha: number;
  readonly marcador: string;
  readonly texto: string;
}

/** Varre o texto e devolve TODA ocorrência. Pura, para o caso sintético poder exercitá-la. */
export function varrerMarcadores(arquivo: string, conteudo: string): Infracao[] {
  const achados: Infracao[] = [];
  const linhas = conteudo.split("\n");
  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i] ?? "";
    for (const m of MARCADORES) {
      if (m.re.test(linha)) {
        achados.push({ arquivo, linha: i + 1, marcador: m.nome, texto: linha.trim().slice(0, 120) });
      }
    }
  }
  return achados;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CODEOWNERS — leitura, casamento e a lista de donos que este repositório reconhece
// ─────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Os donos que o CODEOWNERS pode nomear. Curta de propósito: a pergunta "este time existe no
 * GitHub?" não tem resposta que um teste possa medir sozinho (exigiria rede e um token), então o que
 * se mede é o que dá para medir — que nenhum dono entre no arquivo sem alguém ter EDITADO esta lista,
 * que é o lugar onde a pergunta é feita. É por isso que "criar o time" é item do checklist de push:
 * sem ele, a regra existe, o guarda passa, e o GitHub ignora.
 */
const DONOS_DECLARADOS: readonly string[] = ["@kapstanhq/maintainers"];

/** Handle de pessoa (`@nome`) ou time de organização (`@org/time`). */
const FORMA_DE_DONO = /^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9._-]+)?$/;

interface Regra {
  readonly linha: number;
  readonly padrao: string;
  readonly donos: readonly string[];
}

function lerRegras(conteudo: string): Regra[] {
  const regras: Regra[] = [];
  const linhas = conteudo.split("\n");
  for (let i = 0; i < linhas.length; i++) {
    const bruta = (linhas[i] ?? "").trim();
    if (bruta === "" || bruta.startsWith("#")) continue;
    const campos = bruta.split(/\s+/);
    const padrao = campos[0];
    if (padrao == null) continue;
    regras.push({ linha: i + 1, padrao, donos: campos.slice(1) });
  }
  return regras;
}

/**
 * Casamento para o subconjunto de sintaxe que este arquivo usa: `*` (o piso), `/dir/` e `/arquivo`.
 * Qualquer outra forma LANÇA em vez de devolver `false` — um glob que este casador não implementa
 * seria lido como "não cobre nada" e reprovaria a regra certa, ou pior, passaria por cobrir tudo. A
 * ignorância aqui é ruidosa de propósito.
 */
function casa(padrao: string, caminho: string): boolean {
  if (padrao === "*") return true;
  if (!padrao.startsWith("/")) {
    throw new Error(
      `padrão de CODEOWNERS não ancorado: ${JSON.stringify(padrao)}. Este guarda só implementa \`*\`, ` +
        "`/dir/` e `/arquivo` — ancore o padrão ou ensine o casador antes de usar outra forma.",
    );
  }
  const alvo = padrao.slice(1);
  if (/[*?[\]]/.test(alvo)) {
    throw new Error(
      `glob em padrão de CODEOWNERS: ${JSON.stringify(padrao)}. Não implementado — veja o comentário do casador.`,
    );
  }
  if (alvo.endsWith("/")) return caminho.startsWith(alvo);
  return caminho === alvo || caminho.startsWith(`${alvo}/`);
}

/** Os caminhos DESTA árvore que uma regra do artefato cobre. */
function alcanceNestaArvore(padrao: string, viajam: readonly string[]): string[] {
  const alvo = padrao === "*" ? "" : padrao.slice(1);
  const comoPadrao = alvo === "" ? "*" : `/${alvo}`;
  return viajam.filter((p) => casa(comoPadrao, p));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PROMPT-AS-CODE — instrução que um agente autônomo EXECUTA na máquina de quem adotou
// ─────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * A fronteira desta lista é uma só, e é o que a torna defensável: aqui entra o que viaja como DADO e
 * é entregue a um agente (ou decide QUAL agente roda, com que autonomia). Prompt embutido em `.ts` é
 * código e cai nas regras de fonte — não nesta.
 */
interface FamiliaDePrompt {
  readonly nome: string;
  readonly prefixo: string;
  readonly porque: string;
}

const PROMPT_AS_CODE: readonly FamiliaDePrompt[] = [
  {
    nome: "skills do pipeline",
    prefixo: ".claude/skills/",
    porque:
      "cada uma é o programa que o agente headless roda com a permissão do CLI desligada; um PR aqui muda " +
      "comportamento executável e passa parecendo edição de prosa",
  },
  {
    nome: "comando do pipeline",
    prefixo: ".claude/commands/",
    porque: "o roteador que escolhe qual skill roda",
  },
  {
    nome: "guia dos assistentes",
    prefixo: ".claude/storymap-assistants/",
    porque: "o texto que os assistentes do painel recebem antes de agir",
  },
  {
    nome: "pipeline canônico",
    prefixo: "storymap/boards/_base/",
    porque:
      "declara QUAIS colunas disparam agente, com qual gate, modelo e teto de turnos — todo board herda dele",
  },
  {
    nome: "interruptores do autorun",
    prefixo: "storymap/settings.yaml",
    porque: "o mestre do autorun, as lanes do scheduler e o gate do merge: a mudança de privilégio com o menor diff possível",
  },
];

function censoDePromptAsCode(viajam: readonly string[]): Map<string, string[]> {
  const censo = new Map<string, string[]>();
  for (const familia of PROMPT_AS_CODE) {
    censo.set(
      familia.nome,
      viajam.filter((p) => p === familia.prefixo || p.startsWith(familia.prefixo)),
    );
  }
  return censo;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("governança que o GitHub realmente lê — os três documentos CHEGAM ao artefato", () => {
  it("SECURITY.md, CONTRIBUTING.md e .github/CODEOWNERS estão no conjunto que viaja", () => {
    const { viajam } = conjuntoQueViaja();
    const conjunto = new Set(viajam);
    const faltando = GOVERNANCA.filter((d) => !conjunto.has(caminhoAqui(d))).map(
      (d) => `• ${d.destino} — ausente do repositório publicado. ${d.porque}`,
    );
    expect(faltando.join("\n"), "documento de governança que não chega ao repositório publicado").toBe("");
  });

  it("a varredura não é vácuo: ela enxerga os documentos, e são muitos", () => {
    const { viajam } = conjuntoQueViaja();
    const documentos = viajam.filter(ehDocumento);
    // MEDIDO em 2026-08-19: 151 `.md` viajam, mais LICENSE, NOTICE e o CODEOWNERS.
    expect(
      documentos.length,
      "o conjunto de documentos que viaja ficou pequeno demais para a varredura significar algo",
    ).toBeGreaterThanOrEqual(20);
    // Testemunhas de FAMÍLIAS diferentes: uma varredura amputada num diretório satisfaz a contagem
    // acima por construção, e é o caso que a contagem sozinha não pega.
    for (const agulha of [".claude/skills/", "packages/storymap-ui/"]) {
      expect(
        documentos.some((d) => d.startsWith(agulha)),
        `nenhum documento de ${agulha} no conjunto varrido — a varredura está amputada`,
      ).toBe(true);
    }
  });

  it("[ATAQUE] nenhum documento que viaja carrega marcador de preenchimento pendente", () => {
    const { viajam } = conjuntoQueViaja();
    const infracoes: Infracao[] = [];
    for (const rel of viajam.filter(ehDocumento)) {
      const abs = path.join(RAIZ, rel);
      if (!existsSync(abs)) continue;
      infracoes.push(...varrerMarcadores(rel, readFileSync(abs, "utf8")));
    }
    expect(
      infracoes.map((i) => `• ${i.arquivo}:${i.linha} [${i.marcador}] ${i.texto}`).join("\n"),
      `marcador de pendência em documento publicado. O conserto é DECIDIR e escrever a ` +
        "decisão — nunca afrouxar a régua nem isentar o arquivo",
    ).toBe("");
  });

  it("o discriminador do marcador funciona nos DOIS sentidos — 'TODO' português passa, marcador reprova", () => {
    // Este par é o que separa um guarda útil de um que é desligado por barulho. A primeira linha é
    // real (`.claude/skills/harness-do/SKILL.md`), a segunda é o que ele tem de pegar.
    expect(varrerMarcadores("p.md", "**Convenção — TODO commit carrega o id do card**")).toEqual([]);
    expect(varrerMarcadores("p.md", "TODO: decidir o canal de reporte").length).toBe(1);
    expect(varrerMarcadores("p.md", "contato: <PREENCHER: handle do mantenedor>").length).toBe(1);
    // O par do falso-positivo medido no artefato: parâmetro em minúscula (o leitor substitui) passa;
    // o mesmo campo em MAIÚSCULA (o autor não decidiu) reprova. Sem este par, apertar a régua para
    // calar o barulho teria calado também o marcador de verdade.
    expect(varrerMarcadores("p.md", "abra `127.0.0.1:<your port>` no navegador")).toEqual([]);
    expect(varrerMarcadores("p.md", "Authorization: Bearer <YOUR_TOKEN>").length).toBe(1);
    expect(varrerMarcadores("p.md", "escreva para seguranca@example.com").length).toBeGreaterThanOrEqual(1);
    // E o inverso do inverso: prosa que só CITA a palavra em maiúsculas segue passando.
    expect(varrerMarcadores("p.md", "TODA a árvore e TODO o histórico")).toEqual([]);
  });

  it("a política não publica endereço de e-mail nenhum — a ausência é a decisão", () => {
    const doc = GOVERNANCA.find((d) => d.destino === "SECURITY.md");
    if (doc == null) throw new Error("a política saiu da tabela de governança");
    const texto = readFileSync(path.join(RAIZ, caminhoAqui(doc)), "utf8");
    const email = texto.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|org|net|dev|io|ai|br)\b/i);
    expect(
      email?.[0] ?? "",
      "e-mail publicado na política. O canal decidido é o reporte privado do GitHub; um endereço a mais " +
        "é uma caixa a mais para alguém esquecer de ler",
    ).toBe("");
  });

  it("todo ponteiro relativo dos documentos de governança existe NO ARTEFATO", () => {
    const { viajam } = conjuntoQueViaja();
    const quebrados: string[] = [];
    let conferidos = 0;
    for (const doc of GOVERNANCA) {
      const abs = path.join(RAIZ, caminhoAqui(doc));
      if (!existsSync(abs)) continue;
      const texto = readFileSync(abs, "utf8");
      for (const m of texto.matchAll(/\]\(([^)#\s]+)\)/g)) {
        const alvo = m[1];
        if (alvo == null || /^[a-z]+:/i.test(alvo)) continue; // http(s), mailto: não são caminho
        conferidos++;
        const noArtefato = alvo.replace(/^\.\//, "");
        const existe = viajam.includes(noArtefato) || viajam.some((p) => p.startsWith(`${noArtefato}/`));
        if (!existe) quebrados.push(`• ${doc.destino} → ${alvo} (não chega ao artefato)`);
      }
    }
    expect(conferidos, "nenhum link relativo conferido — a varredura de ponteiros mediu zero").toBeGreaterThan(0);
    expect(quebrados.join("\n"), "ponteiro para documento que não existe no repositório publicado").toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("CODEOWNERS — dono que existe, regra que casa, e nada de ilusão de revisão", () => {
  function codeowners(): { texto: string; regras: Regra[]; viajam: string[] } {
    const { viajam } = conjuntoQueViaja();
    const doc = GOVERNANCA.find((d) => d.destino === ".github/CODEOWNERS");
    if (doc == null) throw new Error("o CODEOWNERS saiu da tabela de governança");
    const abs = path.join(RAIZ, caminhoAqui(doc));
    if (!existsSync(abs)) {
      throw new Error(
        `${caminhoAqui(doc)} não existe. Sem o arquivo, toda asserção abaixo passaria por não ter ` +
          "o que medir — que é exatamente o estado que ele existe para impedir.",
      );
    }
    const texto = readFileSync(abs, "utf8");
    return { texto, regras: lerRegras(texto), viajam };
  }

  it("[ATAQUE] todo dono citado no arquivo — inclusive em comentário — está na lista declarada", () => {
    const { texto } = codeowners();
    // Comentário incluído de propósito: o defeito medido era um comentário mandando "substituir
    // @<time> na extração". Enquanto o handle antigo estiver escrito em qualquer lugar, alguém o
    // copia para uma regra.
    const citados = [...texto.matchAll(/@[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9._-]+)?/g)].map((m) => m[0]);
    expect(citados.length, "nenhum dono citado no CODEOWNERS — o arquivo não atribui revisor a ninguém").toBeGreaterThan(0);
    const desconhecidos = [...new Set(citados)].filter((d) => !DONOS_DECLARADOS.includes(d));
    expect(
      desconhecidos.join(", "),
      "dono fora da lista declarada em DONOS_DECLARADOS. Se ele é real, declare-o aqui — este é o lugar " +
        "onde alguém pergunta se o time EXISTE no GitHub, e criar o time é gesto do dono no dia do push",
    ).toBe("");
  });

  it("todo dono tem forma de handle ou de time `@org/time` — e a lista declarada também", () => {
    const { regras } = codeowners();
    const malFormados = regras.flatMap((r) =>
      r.donos.filter((d) => !FORMA_DE_DONO.test(d)).map((d) => `linha ${r.linha}: ${d}`),
    );
    expect(malFormados.join(", "), "dono com forma que o GitHub não resolve").toBe("");
    const semDono = regras.filter((r) => r.donos.length === 0).map((r) => `linha ${r.linha}: ${r.padrao}`);
    expect(semDono.join(", "), "regra sem dono nenhum — ela REMOVE a cobertura das regras anteriores").toBe("");
    expect(DONOS_DECLARADOS.every((d) => FORMA_DE_DONO.test(d))).toBe(true);
  });

  it("[ATAQUE] nenhuma regra é morta: todo caminho tem sobrevivente no artefato", () => {
    const { regras, viajam } = codeowners();
    expect(regras.length, "CODEOWNERS sem regra nenhuma").toBeGreaterThan(1);
    const mortas = regras
      .filter((r) => r.padrao !== "*" && alcanceNestaArvore(r.padrao, viajam).length === 0)
      .map((r) => `• linha ${r.linha}: ${r.padrao}`);
    expect(
      mortas.join("\n"),
      "regra apontando para caminho sem nenhum arquivo no repositório publicado. O GitHub ignora a regra e " +
        "a tela de proteção de branch continua prometendo revisão — ilusão de revisão, a mesma classe do " +
        "time inexistente",
    ).toBe("");
  });

  it("o medidor de regra morta sabe reprovar — um caminho sabidamente ausente mede ZERO", () => {
    const { viajam } = codeowners();
    // Controle: sem isto, "nenhuma regra morta" poderia significar que o casador aprova qualquer coisa.
    expect(alcanceNestaArvore("/nao-existe-neste-repositorio/", viajam)).toEqual([]);
    expect(alcanceNestaArvore("/packages/", viajam).length).toBeGreaterThan(0);
  });

  it("[ATAQUE] todo prompt-as-code que viaja tem revisor NOMEADO, não só o `*` do piso", () => {
    const { regras, viajam } = codeowners();
    const censo = censoDePromptAsCode(viajam);

    // (a) o censo não é ficção: família declarada sem sobrevivente é declaração morta, e faria a
    //     cobertura abaixo passar por não ter o que cobrir.
    const familiasVazias = PROMPT_AS_CODE.filter((f) => (censo.get(f.nome) ?? []).length === 0).map(
      (f) => `• ${f.nome} (${f.prefixo}) — ${f.porque}`,
    );
    expect(familiasVazias.join("\n"), "família de prompt-as-code declarada com ZERO arquivos no conjunto que viaja").toBe("");

    const todos = [...censo.values()].flat();
    expect(todos.length, "o censo de prompt-as-code mediu quase nada").toBeGreaterThanOrEqual(20);

    // (b) o censo de skills, dito em voz alta: 23 diretórios medidos em 2026-08-19 (21 `harness-*`,
    //     `harness-triage-shared` e `storymap-orchestrator`). A régua é do DIRETÓRIO, então a skill nº 24
    //     nasce coberta — o número aqui é piso de sanidade, não a lista.
    const dirsDeSkill = new Set(
      (censo.get("skills do pipeline") ?? [])
        .map((p) => p.split("/").slice(0, 3).join("/"))
        .filter((p) => p.startsWith(".claude/skills/")),
    );
    expect(dirsDeSkill.size, "nenhum diretório de skill no censo").toBeGreaterThanOrEqual(10);

    // (c) a cobertura: cada arquivo precisa de uma regra que NÃO seja o `*`.
    const explicitas = regras.filter((r) => r.padrao !== "*");
    const descobertos = todos
      .filter((p) => !explicitas.some((r) => alcanceNestaArvore(r.padrao, [p]).length > 0))
      .slice(0, 20);
    expect(
      descobertos.join("\n"),
      "prompt-as-code coberto só pelo `*`: um PR aqui muda o que um agente autônomo EXECUTA na máquina de " +
        "quem adotou, e o revisor não tem como saber disso pelo diff. Nomeie o diretório no CODEOWNERS",
    ).toBe("");
  });
});
