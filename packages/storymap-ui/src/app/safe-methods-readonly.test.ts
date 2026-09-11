// VARREDURA: nenhum handler de método SEGURO (GET/HEAD) muta estado (story-l9y3wh).
//
// Por que ESTE é o teste que fecha o CSRF, e não só um detalhe de higiene REST: o cookie de sessão é
// `SameSite=Lax`, e Lax **anexa** o cookie em navegação top-level cross-site — um `<a>`, um
// `window.open`, um redirect, um `<img src>` de outro site. Ou seja: o único vetor de CSRF que
// sobrevive às três camadas (Lax + content-type json + Sec-Fetch-Site nas rotas de feedback) é uma
// rota GET que MUTE algo. Hoje não existe nenhuma; sem esta varredura, a primeira que aparecer nasce
// explorável e ninguém percebe — o autor não estava pensando em CSRF, estava fazendo um atalho.
//
// A varredura é por CHOKEPOINT, no espírito do `gate-exhaustiveness.test.ts`: em vez de adivinhar
// "isto muta?" por semântica, ela nomeia as portas por onde este app muda estado (fs, o escritor de
// card, a fila de publish, o cookie) e exige que nenhuma apareça dentro de um handler seguro. Uma
// porta NOVA precisa entrar na lista — e é para isso que serve o controle negativo no fim: ele prova
// que o detector morde, então quebrá-lo quebra a suíte em vez de silenciar a varredura.
//
// LER A DECLARAÇÃO DO HANDLER É PARTE DO CONTROLE (onda 2). A primeira versão só sabia ler
// `export [async] function GET(…)` — e a ÚNICA rota do app na outra forma (`export { handle as GET,
// handle as POST, handle as DELETE }`, o MCP remoto) é justamente a de MAIOR privilégio: o GET dela
// alcança spawn/deploy/delete. Como a forma não era reconhecida, o arquivo era pulado tanto pela
// varredura quanto pelo caso anti-cegueira — o lint AFIRMAVA uma propriedade que nunca checava, na
// rota onde ela mais importaria. Hoje o varredor resolve o alias até a função local e lê o corpo
// dela; forma que ele NÃO sabe ler é FALHA, nunca `continue` (anti-cegueira que pula é cegueira).
//
// E quando um método seguro compartilha a MESMA implementação com um mutante, o corpo não distingue
// GET de POST: a leitura intra-arquivo não consegue estabelecer que o GET é read-only. Esse caso não
// é tolerado em silêncio — exige ISENÇÃO DECLARADA (arquivo + motivo + premissa verificável em
// `SHARED_IMPL_EXEMPTIONS`). Isenção implícita por falha de parsing é o defeito que esta onda fechou.
//
// CUSTO DE AUTONOMIA: ZERO. POST/PUT/PATCH/DELETE seguem podendo escrever, spawnar, deployar e
// deletar à vontade — a varredura é escopada ao CORPO dos métodos seguros (há um caso provando isso).

import { readdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const appDir = fileURLToPath(new URL(".", import.meta.url));

/** Métodos que a RFC 9110 chama de seguros: por contrato, só leem. */
const SAFE_METHODS = ["GET", "HEAD"] as const;

/** Métodos que podem (e devem) escrever — só existem aqui para escopar a varredura. */
const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * AS PORTAS por onde este app muda estado. Ver uma delas dentro de um handler GET/HEAD é o achado.
 *
 * A lista é deliberadamente de CHOKEPOINT e não de semântica: `spawn`/`execFile` ficam FORA porque
 * shell-out read-only é rotina aqui (`ps`, `tmux list-panes`, `ccusage` alimentam as telas de
 * processos/medidores), e um marcador que gritasse neles seria desligado no primeiro falso positivo
 * — um teste que ninguém acredita não protege nada.
 */
const MUTATION_MARKERS: readonly (readonly [RegExp, string])[] = [
  // Escrita em disco (node:fs, sync e promises).
  [/\bwriteFileSync\s*\(/, "writeFileSync"],
  [/\bwriteFile\s*\(/, "writeFile"],
  [/\bappendFile(?:Sync)?\s*\(/, "appendFile"],
  [/\bunlink(?:Sync)?\s*\(/, "unlink"],
  [/\brm(?:Sync)?\s*\(/, "rm"],
  [/\brmdir(?:Sync)?\s*\(/, "rmdir"],
  [/\bmkdir(?:Sync)?\s*\(/, "mkdir"],
  [/\brename(?:Sync)?\s*\(/, "rename"],
  [/\bcopyFile(?:Sync)?\s*\(/, "copyFile"],
  [/\bchmod(?:Sync)?\s*\(/, "chmod"],
  [/\btruncate(?:Sync)?\s*\(/, "truncate"],
  // O escritor de board-data (write.ts) — o único caminho legítimo até um card.
  [/\bupdateCardOnDisk\s*\(/, "updateCardOnDisk"],
  [/\bwriteCard\w*\s*\(/, "writeCard"],
  [/\bwriteBoardConfig\s*\(/, "writeBoardConfig"],
  [/\bdeleteCardFile\s*\(/, "deleteCardFile"],
  [/\bwriteSidecar\w*\s*\(/, "writeSidecar"],
  // Trabalho enfileirado: publicar/promover é a mutação mais caríssima do serviço.
  [/\benqueuePublish\s*\(/, "enqueuePublish"],
  [/\bfirePromoteAndDeploy\s*\(/, "firePromoteAndDeploy"],
  // Cookie: um GET que emite ou apaga cookie muda a sessão de quem foi induzido a visitá-lo.
  [/\.cookies\.(?:set|delete)\s*\(/, "cookies.set/delete"],
];

/** Módulos que só um handler mutante tem motivo para importar. */
const WRITE_ONLY_IMPORTS: readonly RegExp[] = [
  /from\s+["']@\/lib\/storymap\/write["']/,
  /from\s+["'][^"']*\/actions["']/,
];

/**
 * ISENÇÕES DECLARADAS da regra "método seguro não compartilha implementação com método mutante".
 *
 * Uma isenção aqui NÃO é "pule este arquivo": ela é uma afirmação de segurança com PREMISSA
 * verificada a cada rodada. Se a premissa cair (alguém passar a autenticar a rota por cookie, por
 * exemplo), a suíte fica VERMELHA e a isenção morre com ela — que é a diferença entre decidir e
 * esquecer. Isenção implícita (o varredor não entendeu, logo passou) é proibida por construção.
 */
const SHARED_IMPL_EXEMPTIONS: readonly {
  file: string;
  reason: string;
  /** `requires`: tem de continuar presente. `forbids`: presença QUEBRA a premissa. */
  premise: { requires: readonly RegExp[]; forbids: readonly RegExp[] };
}[] = [
  {
    file: "api/mcp/[secret]/[transport]/route.ts",
    reason:
      "MCP remoto: uma função só (`handle`) serve GET/POST/DELETE do Streamable HTTP, e alcança toda a " +
      "superfície de tools — spawn, deploy, delete. Fica FORA do modelo de ameaça de CSRF porque a " +
      "credencial é um token de capacidade NO PATH e nenhuma credencial de ambiente é lida: o navegador " +
      "da vítima não anexa nada que autentique, então SameSite/Lax é irrelevante e um site de terceiros " +
      "não tem como forjar a URL autenticada. Separar GET de POST aqui não compraria segurança nenhuma " +
      "(o protocolo MCP usa GET para retomar stream) e tiraria capacidade do agente.",
    premise: {
      // A auth continua sendo o token no path.
      requires: [/isMcpTokenValid\s*\(/],
      // Qualquer credencial AMBIENTE (cookie/sessão) reabriria o vetor: aí o GET volta a ser forjável
      // por navegação cross-site e a isenção deixa de valer.
      forbids: [
        /from\s+["']next\/headers["']/,
        /\bcookies\s*\(/,
        /\.cookies\b/,
        /\bSESSION_COOKIE\b/,
        /\bverifySession\s*\(/,
      ],
    },
  },
];

function collectRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectRouteFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out.sort();
}

/**
 * A FORMA como o método foi exportado — o que decide se o varredor consegue ler o corpo, e de QUEM.
 *
 * - `function`: `export [async] function GET(…)` — o corpo está ali, legível.
 * - `reexport`: `export { handle as GET }` — o corpo é da função LOCAL `handle`; legível via alias.
 * - `reexport-from`: `export { handle as GET } from "./x"` — o corpo está noutro módulo: ILEGÍVEL aqui.
 * - `binding`: `export const GET = …` — arrow/identificador: ILEGÍVEL pela contagem de chaves.
 */
type HandlerForm = "function" | "reexport" | "reexport-from" | "binding";

interface HandlerDecl {
  method: string;
  /** Nome da função que IMPLEMENTA o método (alias resolvido; igual ao método na forma canônica). */
  impl: string;
  form: HandlerForm;
}

/** Acha o método numa cláusula `export { … }` (com ou sem alias, agregada ou re-exportando de outro módulo). */
function findReexport(source: string, method: string): { impl: string; form: HandlerForm } | null {
  // Regex local (não de módulo) para não compartilhar `lastIndex` entre chamadas.
  const clauses = source.matchAll(/export\s*\{([^}]*)\}\s*(from\s*["'][^"']+["'])?/g);
  for (const clause of clauses) {
    for (const spec of clause[1].split(",")) {
      const [local, exported] = spec.trim().split(/\s+as\s+/);
      if (!local) continue;
      if ((exported ?? local).trim() !== method) continue;
      return { impl: local.trim(), form: clause[2] ? "reexport-from" : "reexport" };
    }
  }
  return null;
}

/** A declaração do método neste arquivo — em QUALQUER forma que saibamos nomear — ou `null`. */
function findHandlerDecl(source: string, method: string): HandlerDecl | null {
  if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`).test(source)) {
    return { method, impl: method, form: "function" };
  }
  const re = findReexport(source, method);
  if (re) return { method, impl: re.impl, form: re.form };
  if (new RegExp(`export\\s+(?:const|let|var)\\s+${method}\\b`).test(source)) {
    return { method, impl: method, form: "binding" };
  }
  return null;
}

/** O handler está DECLARADO no arquivo? (qualquer forma de export que o varredor saiba nomear) */
function declaresHandler(source: string, method: string): boolean {
  return findHandlerDecl(source, method) !== null;
}

/**
 * Detector GROSSEIRO de "este arquivo exporta algo chamado <METHOD>", usado só como rede
 * anti-cegueira: se ele acusa e `findHandlerDecl` não, apareceu uma forma NOVA de declarar handler e
 * o varredor tem de FALHAR ruidosamente em vez de reportar verde sobre código que não leu.
 */
function mentionsExportedMethod(source: string, method: string): boolean {
  return new RegExp(`export\\b[^\\n]*\\b${method}\\b`).test(source);
}

/** O corpo de uma função nomeada, por contagem de chaves (`null` se ela não existe nessa forma). */
function extractFunctionBody(source: string, name: string): string | null {
  const decl = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*(?:<[^>]*>)?\\s*\\(`).exec(source);
  if (!decl) return null;
  const open = source.indexOf("{", decl.index + decl[0].length);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * O CORPO do handler do método — resolvendo o alias quando ele foi exportado por re-export.
 *
 * `null` quando o handler existe mas o corpo não está legível AQUI (`binding`, `reexport-from`, ou um
 * alias que aponta para uma arrow). Isso NÃO é tolerado (`auditHandlerForms` reprova): um varredor que
 * devolve "nada encontrado" quando não entende o código é pior que nenhum varredor — ele reporta verde
 * justamente no caso novo.
 */
function extractHandlerBody(source: string, method: string): string | null {
  const decl = findHandlerDecl(source, method);
  if (!decl) return null;
  if (decl.form === "function" || decl.form === "reexport") return extractFunctionBody(source, decl.impl);
  return null;
}

interface Finding {
  file: string;
  method: string;
  marker: string;
}

/** Todo marcador de mutação encontrado dentro de um handler seguro, em toda a árvore de rotas. */
function scanForMutatingSafeHandlers(dir: string): Finding[] {
  const findings: Finding[] = [];
  for (const file of collectRouteFiles(dir)) {
    const source = readFileSync(file, "utf8");
    for (const method of SAFE_METHODS) {
      const body = extractHandlerBody(source, method);
      if (!body) continue;
      for (const [re, marker] of MUTATION_MARKERS) {
        if (re.test(body)) findings.push({ file: path.relative(dir, file), method, marker });
      }
    }
  }
  return findings;
}

interface FormProblem {
  file: string;
  method: string;
  problem: string;
}

/** Onde a varredura de CSRF está CEGA: método seguro cuja declaração o varredor não sabe ler. */
function auditHandlerForms(dir: string): FormProblem[] {
  const problems: FormProblem[] = [];
  for (const file of collectRouteFiles(dir)) {
    const source = readFileSync(file, "utf8");
    const rel = path.relative(dir, file);
    // `export * from "./impl"` exporta os handlers sem NOMEAR nenhum: nem o varredor nem a rede
    // anti-cegueira têm como saber quais métodos a rota expõe. Numa rota isso é proibido por
    // auditabilidade — a lista de métodos de uma rota tem de ser legível no próprio arquivo.
    if (/export\s*\*/.test(source)) {
      problems.push({ file: rel, method: "*", problem: "re-export estrela esconde quais métodos a rota expõe" });
    }
    for (const method of SAFE_METHODS) {
      const decl = findHandlerDecl(source, method);
      if (!decl) {
        // Nada declarado E nada mencionado = o arquivo simplesmente não tem esse método. Mencionado
        // sem forma reconhecida = forma NOVA, e aí o silêncio seria a falha.
        if (mentionsExportedMethod(source, method)) {
          problems.push({ file: rel, method, problem: "forma de export que o varredor não sabe ler" });
        }
        continue;
      }
      if (extractHandlerBody(source, method) === null) {
        problems.push({ file: rel, method, problem: `corpo ilegível (forma \`${decl.form}\` → \`${decl.impl}\`)` });
      }
    }
  }
  return problems;
}

interface SharedImpl {
  file: string;
  method: string;
  impl: string;
  alsoServes: string[];
}

/** Método seguro que roda a MESMA função de um método mutante — o corpo não distingue os dois. */
function auditSharedImplementations(dir: string): SharedImpl[] {
  const shared: SharedImpl[] = [];
  for (const file of collectRouteFiles(dir)) {
    const source = readFileSync(file, "utf8");
    for (const method of SAFE_METHODS) {
      const decl = findHandlerDecl(source, method);
      if (!decl) continue;
      const alsoServes = MUTATING_METHODS.filter((m) => findHandlerDecl(source, m)?.impl === decl.impl);
      if (alsoServes.length > 0) {
        shared.push({ file: path.relative(dir, file), method, impl: decl.impl, alsoServes: [...alsoServes] });
      }
    }
  }
  return shared;
}

const ROUTE_FILES = collectRouteFiles(appDir);
const SAFE_HANDLERS = ROUTE_FILES.flatMap((file) => {
  const source = readFileSync(file, "utf8");
  return SAFE_METHODS.filter((m) => declaresHandler(source, m)).map((m) => `${m} ${path.relative(appDir, file)}`);
});

/** Árvores plantadas por um caso — apagadas quando ele termina, para o gate não encher /tmp de órfãs. */
const arvoresDeMentira: string[] = [];
afterEach(() => {
  for (const dir of arvoresDeMentira.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Escreve uma árvore de rotas de mentira em tmp — nunca plantamos rota falsa na árvore servida por um serviço vivo. */
function fixtureTree(prefix: string, files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  arvoresDeMentira.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

describe("métodos seguros do App Router não mutam estado", () => {
  it("a varredura enxerga o App Router de verdade", () => {
    // Sem esta âncora, um glob quebrado deixaria a varredura VAZIA — e vazio passa em tudo. É o
    // padrão "capacidade declarada com zero produtores": parece proteção e não é nada.
    expect(ROUTE_FILES.length).toBeGreaterThan(20);
    expect(SAFE_HANDLERS.length).toBeGreaterThan(12);
    expect(SAFE_HANDLERS).toContain("GET api/health/route.ts");
    // E enxerga o GET declarado por RE-EXPORT — a rota de maior privilégio do app (MCP remoto), que
    // por 1 forma de export não lida ficava inteira fora da varredura.
    expect(SAFE_HANDLERS).toContain("GET api/mcp/[secret]/[transport]/route.ts");
    expect(MUTATION_MARKERS.length).toBeGreaterThan(10);
  });

  it("CSRF por navegação: NENHUM handler GET/HEAD muta estado", () => {
    // ATAQUE que isto impede: `<a href="https://board/api/algo?apagar=tudo">` num site qualquer (ou
    // um `<img src>`, que dispensa até o clique). O cookie Lax VAI junto nessa navegação — se o
    // handler mutar, o operador acabou de executar a ação sem nunca ter pedido.
    const findings = scanForMutatingSafeHandlers(appDir);
    expect(
      findings,
      `handler seguro mutando estado (mova a mutação para POST/PUT/PATCH/DELETE): ${findings
        .map((f) => `${f.method} ${f.file} → ${f.marker}`)
        .join("; ")}`,
    ).toEqual([]);
  });

  it("o varredor não pode ser CEGADO por outra forma de declarar o handler", () => {
    // `export const GET = handler` ou `export { GET } from "./impl"` compilam igual e o varredor por
    // chaves não os leria — o achado sumiria em silêncio, justamente no arquivo novo. Então a forma
    // legível é requisito, não estilo: aqui a lista de cegueiras tem de ser VAZIA.
    const problems = auditHandlerForms(appDir);
    expect(
      problems,
      `o varredor de CSRF não consegue ler o corpo destes handlers: ${problems
        .map((p) => `${p.method} ${p.file} → ${p.problem}`)
        .join("; ")}`,
    ).toEqual([]);
  });

  it("GET que roda a MESMA função de um POST/DELETE só passa por ISENÇÃO declarada", () => {
    // Quando um método seguro e um mutante compartilham a implementação, o corpo não diz qual dos
    // dois está rodando — a leitura intra-arquivo não estabelece nada sobre o GET. O único desfecho
    // aceitável é uma decisão HUMANA registrada com motivo; passar por falha de parsing, não.
    const exempt = new Set(SHARED_IMPL_EXEMPTIONS.map((e) => e.file));
    const undeclared = auditSharedImplementations(appDir).filter((s) => !exempt.has(s.file));
    expect(
      undeclared,
      `método seguro compartilhando implementação com mutante sem isenção declarada em ` +
        `SHARED_IMPL_EXEMPTIONS: ${undeclared
          .map((s) => `${s.method} ${s.file} → ${s.impl} (também serve ${s.alsoServes.join("/")})`)
          .join("; ")}`,
    ).toEqual([]);
  });

  it("a ISENÇÃO vale só enquanto a premissa dela vale (e só onde há o que isentar)", () => {
    // O que isto impede: a isenção virar carta branca eterna. Ela afirma "esta rota não usa
    // credencial de ambiente, logo CSRF não a alcança" — no dia em que alguém autenticar por cookie
    // ali, a premissa cai e a suíte fica vermelha ANTES do vetor existir.
    const shared = auditSharedImplementations(appDir);
    for (const entry of SHARED_IMPL_EXEMPTIONS) {
      expect(entry.reason.length, `a isenção de ${entry.file} precisa de motivo escrito`).toBeGreaterThan(80);
      expect(
        shared.some((s) => s.file === entry.file),
        `isenção MORTA: ${entry.file} não compartilha mais implementação entre método seguro e mutante — remova a entrada`,
      ).toBe(true);
      const source = readFileSync(path.join(appDir, entry.file), "utf8");
      for (const re of entry.premise.requires) {
        expect(re.test(source), `premissa da isenção de ${entry.file} caiu: ${re} deixou de existir`).toBe(true);
      }
      for (const re of entry.premise.forbids) {
        expect(
          re.test(source),
          `premissa da isenção de ${entry.file} caiu: ${re} apareceu — a rota passou a ler credencial de ` +
            `ambiente, então o GET dela voltou a ser forjável por navegação cross-site`,
        ).toBe(false);
      }
    }
  });

  it("rota SÓ de leitura não importa o escritor de board-data", () => {
    // Segunda lente, independente do nome da função: se o arquivo não expõe método mutante, ele não
    // tem por que enxergar `write.ts` nem as server actions. Pega o caso em que o chokepoint é
    // renomeado e o marcador acima envelhece.
    for (const file of ROUTE_FILES) {
      const source = readFileSync(file, "utf8");
      if (MUTATING_METHODS.some((m) => declaresHandler(source, m))) continue;
      for (const re of WRITE_ONLY_IMPORTS) {
        expect(re.test(source), `${path.relative(appDir, file)} só tem métodos seguros mas importa ${re}`).toBe(false);
      }
    }
  });

  it("CONTROLE NEGATIVO: o varredor acusa GET mutante (em QUALQUER forma de export) e ABSOLVE POST mutante", () => {
    // Este caso é a prova de que os anteriores têm dentes — inclusive na forma de re-export, que era
    // exatamente por onde um GET mutante passava batido.
    const fixture = fixtureTree("csrf-safe-methods-", {
      "api/atalho/route.ts": `import { writeFileSync } from "node:fs";
       export async function GET(): Promise<Response> {
         writeFileSync("/tmp/x", "1");
         return Response.json({ ok: true });
       }`,
      "api/card/route.ts": `import { updateCardOnDisk } from "@/lib/storymap/write";
       export async function GET(req: Request): Promise<Response> {
         await updateCardOnDisk("acme", "story-1", (c) => c);
         return Response.json({ ok: true });
       }`,
      // Re-export com alias: o corpo mora em `handle`, e é lá que o marcador tem de ser encontrado.
      "api/reexport/route.ts": `import { writeFileSync } from "node:fs";
       async function handle(): Promise<Response> {
         writeFileSync("/tmp/x", "1");
         return Response.json({ ok: true });
       }
       export { handle as GET };`,
      // Forma AGREGADA: um handler só servindo GET e POST. Compartilhar implementação com o POST não
      // pode lavar o marcador — para o GET, o corpo compartilhado conta.
      "api/agregada/route.ts": `import { enqueuePublish } from "@/lib/storymap/runner/publish-queue";
       async function handle(): Promise<Response> {
         await enqueuePublish({ board: "acme" });
         return Response.json({ ok: true });
       }
       export { handle as GET, handle as POST };`,
      // O caminho LEGÍTIMO: mutação em POST, leitura em GET, no mesmo arquivo. Se o varredor acusasse
      // este, ele estaria cobrando do app que pare de escrever — o oposto do objetivo.
      "api/legitima/route.ts": `import { writeFileSync, readFileSync } from "node:fs";
       export async function GET(): Promise<Response> {
         return Response.json({ conteudo: readFileSync("/tmp/x", "utf8") });
       }
       export async function POST(): Promise<Response> {
         writeFileSync("/tmp/x", "1");
         return Response.json({ ok: true });
       }`,
    });

    const findings = scanForMutatingSafeHandlers(fixture);
    expect(findings.map((f) => `${f.method} ${f.file} → ${f.marker}`).sort()).toEqual([
      "GET api/agregada/route.ts → enqueuePublish",
      "GET api/atalho/route.ts → writeFileSync",
      "GET api/card/route.ts → updateCardOnDisk",
      "GET api/reexport/route.ts → writeFileSync",
    ]);
  });

  it("CONTROLE NEGATIVO: forma que o varredor não lê é FALHA, não `continue`", () => {
    // A prova de que a anti-cegueira tem dentes. Antes desta onda ela fazia `continue` diante de
    // forma não reconhecida — ou seja, a única coisa que ela prometia checar era a única que passava.
    const fixture = fixtureTree("csrf-forms-", {
      // Corpo noutro módulo: nada a ler aqui.
      "api/de-outro-modulo/route.ts": `export { handle as GET } from "./impl";`,
      // Arrow atribuída a const: compila igual, contagem de chaves não acha.
      "api/arrow/route.ts": `export const GET = async () => Response.json({ ok: true });`,
      // Alias apontando para uma arrow local: reconhecemos a forma, mas o corpo segue ilegível.
      "api/alias-arrow/route.ts": `const handle = async () => Response.json({ ok: true });
       export { handle as GET };`,
      // Forma que NINGUÉM nomeou ainda: o detector grosseiro vê o nome exportado, o varredor não sabe
      // ler — e é exatamente aí que ele tem de gritar em vez de reportar verde.
      "api/forma-nova/route.ts": `class Rota { static GET() { return Response.json({ ok: true }); } }
       export default Rota;
       export /* forma exótica */ { Rota as unknownGET };
       export declare function GET(req: Request): Promise<Response>;`,
      // Estrela: nem os NOMES dos métodos aparecem — a rota deixa de ser auditável.
      "api/estrela/route.ts": `export * from "./impl";`,
      // Controle do controle: a forma canônica não pode aparecer como problema.
      "api/ok/route.ts": `export async function GET(): Promise<Response> {
         return Response.json({ ok: true });
       }`,
    });

    expect(auditHandlerForms(fixture).map((p) => `${p.file} → ${p.problem}`).sort()).toEqual([
      "api/alias-arrow/route.ts → corpo ilegível (forma `reexport` → `handle`)",
      "api/arrow/route.ts → corpo ilegível (forma `binding` → `GET`)",
      "api/de-outro-modulo/route.ts → corpo ilegível (forma `reexport-from` → `handle`)",
      "api/estrela/route.ts → re-export estrela esconde quais métodos a rota expõe",
      "api/forma-nova/route.ts → forma de export que o varredor não sabe ler",
    ]);
  });

  it("CONTROLE NEGATIVO: implementação compartilhada entre GET e mutante é DETECTADA", () => {
    // Sem este controle, a lista de isenções poderia ser respeitada por vacuidade (detector cego →
    // nenhuma compartilhada → nada a isentar → verde para sempre).
    const fixture = fixtureTree("csrf-shared-", {
      "api/mcp/route.ts": `async function handle(): Promise<Response> { return Response.json({ ok: true }); }
       export { handle as GET, handle as POST, handle as DELETE };`,
      // Mesmo arquivo, funções DIFERENTES: não é compartilhamento, não pode ser acusado.
      "api/separada/route.ts": `export async function GET(): Promise<Response> { return Response.json({ ok: true }); }
       export async function POST(): Promise<Response> { return Response.json({ ok: true }); }`,
    });

    expect(auditSharedImplementations(fixture)).toEqual([
      { file: "api/mcp/route.ts", method: "GET", impl: "handle", alsoServes: ["POST", "DELETE"] },
    ]);
  });
});
