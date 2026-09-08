// ATAQUE: o adotante lê o repositório, acredita nele, e instala numa VPS pública — com a porta
// aberta, sem TLS, sem token forte — uma máquina que spawna `claude --dangerously-skip-permissions`
// como root e serve um shell por WebSocket. Ele não foi imprudente: o repositório LHE DISSE que era
// uma "dev-only tool" que "Never deployed" (o `description` do `package.json`, lido antes de
// qualquer outra coisa por quem chega ao pacote). O ataque não precisa de exploit nenhum — a
// documentação falsa faz a vítima abrir a porta sozinha.
//
// A superfície que ele abre assim NÃO é hipótese: hoje o serviço roda como `storymap.service` no
// systemd, com entrypoint próprio (`dist/ah-server.mjs`, não `next start`), e o endpoint
// `/api/usm/<token>/mcp` está na internet pública POR DESENHO (é como o conector do Claude alcança
// as tools). Cada tool dessas spawna um agente com permissão desligada NA MÁQUINA.
//
// O QUE ESTE TESTE IMPEDE, então, é que o repositório volte a mentir — em qualquer das três
// superfícies onde a mentira é lida primeiro:
//   (1) `package.json` `description` — o manifesto;
//   (2) `README.md` — a primeira tela;
//   (3) `SECURITY.md` + `docs/threat-model.md` — a postura declarada, o que ela NÃO cobre, e o canal
//       para reportar uma falha.
//
// E impede também o modo de falha mais insidioso desse tipo de documento: apodrecer em silêncio. As
// afirmações do threat model que dependem do CÓDIGO ficam PINADAS ao código (bloco 5) — mudar o
// código sem mudar o doc reprova aqui, em vez de deixar um doc de segurança confiantemente errado.
//
// Cards: story-z6wynh (o manifesto mente), story-4ufvii (single-operator declarado, RBAC NÃO
// construído), story-8oy5q8 (SECURITY.md + threat model + política de divulgação).

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { soDoUmbrella } from "@/lib/storymap/oss-tree";
import { PUBLIC_ROUTES } from "@/lib/auth/public-routes";
import { signSession, verifySession } from "@/lib/auth/session";

/** vitest roda com cwd = packages/storymap-ui (mesma premissa de `oss-secret-hygiene.test.ts`). */
const PKG_ROOT = process.cwd();

/**
 * Lê um arquivo do pacote e LANÇA quando ele não existe ou está vazio.
 *
 * A explosão é o ponto: um teste de documentação que trate "arquivo ausente" como string vazia
 * passa VACUAMENTE em toda asserção de ausência (`not.toMatch`) — e o cenário que ele existe para
 * cobrir é exatamente o repositório publicado SEM o documento.
 */
function ler(rel: string): string {
  const p = path.join(PKG_ROOT, rel);
  if (!existsSync(p)) {
    throw new Error(
      `${rel} não existe. O repositório público precisa dele: é onde o adotante descobre que esta ` +
        `ferramenta spawna agentes com permissão desligada antes de expô-la na internet.`,
    );
  }
  const txt = readFileSync(p, "utf8");
  if (txt.trim().length === 0) throw new Error(`${rel} está vazio — documento vazio não avisa ninguém.`);
  return txt;
}

/** Um fato que o documento TEM de registrar, com o porquê que aparece quando ele desaparecer. */
interface FatoExigido {
  readonly oQue: string;
  readonly padrao: RegExp;
  readonly porque: string;
}

function cobre(texto: string, fatos: readonly FatoExigido[]): void {
  const ausentes = fatos.filter((f) => !f.padrao.test(texto));
  expect(
    ausentes.map((f) => `• ${f.oQue} — ${f.porque} (padrão: ${f.padrao})`).join("\n"),
    "fato(s) MEDIDO(s) que o documento deixou de registrar",
  ).toBe("");
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("(1) o manifesto do pacote não pode dizer que isto nunca vai para produção", () => {
  // Leitura DENTRO de cada `it`, nunca no corpo do `describe`: um documento ausente lançaria na
  // COLETA e derrubaria o arquivo inteiro, escondendo os outros blocos atrás do primeiro que faltou.
  const descriptionDoPacote = (): string =>
    ((JSON.parse(ler("package.json")) as { description?: string }).description ?? "");

  it("não afirma ser dev-only nem 'never deployed' — as duas afirmações são falsas hoje", () => {
    const description = descriptionDoPacote();
    // Cada padrão abaixo é uma frase que o `package.json` de fato carregava (story-z6wynh) e que
    // autoriza o adotante a tratar como brinquedo local um serviço que precisa de postura de
    // produção. Não é imprecisão de redação: é a premissa errada da qual sai toda decisão dele.
    const mentiras: readonly RegExp[] = [
      /dev[- ]only/i,
      /never deployed/i,
      /nunca (é |e )?deployad/i,
      /no deploy\.services\.yaml/i,
    ];
    const encontradas = mentiras.filter((r) => r.test(description));
    expect(encontradas.map(String).join(", "), `description atual: ${JSON.stringify(description)}`).toBe("");
  });

  it("nomeia a postura REAL: serviço de produção, superfície MCP alcançável, e aponta o SECURITY.md", () => {
    cobre(descriptionDoPacote(), [
      {
        oQue: "roda como serviço de produção (systemd)",
        padrao: /systemd/i,
        porque: "é o fato que muda a postura do adotante de 'brinquedo local' para 'serviço exposto'",
      },
      {
        oQue: "a palavra produção/production",
        padrao: /produç[ãa]o|production/i,
        porque: "o manifesto é o primeiro lugar lido; 'dev-only' saiu, mas o oposto precisa estar escrito",
      },
      {
        oQue: "a superfície MCP",
        padrao: /MCP/,
        porque: "é o endpoint que fica na internet pública por desenho e cujas tools spawnam agentes",
      },
      {
        oQue: "ponteiro para o SECURITY.md",
        padrao: /SECURITY\.md/,
        porque: "uma linha de manifesto não cabe o threat model — mas cabe dizer onde ele está",
      },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("(2) o README avisa na PRIMEIRA TELA, não num anexo", () => {
  it("as três capacidades perigosas aparecem antes de qualquer instrução de instalação", () => {
    const readme = ler("README.md");
    /** ~40 linhas = uma tela de terminal/celular: o que o adotante lê ANTES de decidir instalar. */
    const primeiraTela = readme.split("\n").slice(0, 40).join("\n");
    cobre(primeiraTela, [
      {
        oQue: "spawna `claude --dangerously-skip-permissions`",
        padrao: /--dangerously-skip-permissions/,
        porque: "é a flag literal; parafrasear deixa o leitor achar que existe algum prompt de confirmação",
      },
      // F0: o autorun deixou de usar a flag e passou a comprar autonomia com ISOLAMENTO. O pino cresce
      // junto — descrever só o perigo antigo passaria a ser tão desonesto quanto omiti-lo, e um adotante
      // precisa saber QUAL superfície está contida e qual não está.
      {
        oQue: "a contenção do autorun é imposta pelo SISTEMA OPERACIONAL",
        padrao: /sandbox imposto pelo sistema operacional|bubblewrap/i,
        porque: "'sandbox' sem dizer quem aplica é a palavra que todo produto usa; o adotante precisa do mecanismo",
      },
      {
        oQue: "as superfícies que NÃO estão contidas",
        padrao: /ainda usam .{0,4}claude --dangerously-skip-permissions|sem sandbox nenhum/i,
        porque:
          "descrever a contenção sem nomear o que ficou de fora é a meia-verdade mais perigosa: " +
          "o leitor generaliza a proteção para o sistema inteiro",
      },
      {
        oQue: "a degradação é fail-closed",
        padrao: /NEGADA, não concedida|recusado ou rebaixado/i,
        porque: "sem isto o leitor supõe que a ferramenta 'roda de qualquer jeito' quando falta dependência",
      },
      {
        oQue: "os processos rodam como root",
        padrao: /root/,
        porque: "define o que um comprometimento alcança: a máquina inteira, não um usuário de app",
      },
      {
        oQue: "expõe um shell por WebSocket",
        padrao: /WebSocket/i,
        porque: "é um shell interativo no navegador — a superfície que o adotante menos espera num board",
      },
      {
        oQue: "ponteiro para SECURITY.md",
        padrao: /SECURITY\.md/,
        porque: "o aviso curto tem de levar ao documento longo, senão vira slogan",
      },
    ]);
    // A ordem importa: o aviso PRECEDE o quickstart. Um aviso depois do `git clone` é um aviso que
    // o leitor encontra quando o serviço já está no ar.
    const idxAviso = readme.search(/--dangerously-skip-permissions/);
    const idxInstalar = readme.search(/```bash/);
    if (idxInstalar >= 0) {
      expect(idxAviso, "o aviso de perímetro tem de vir ANTES do primeiro bloco de comandos").toBeLessThan(
        idxInstalar,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("(3) SECURITY.md — canal de divulgação que EXISTE, e o modelo single-operator declarado", () => {
  const security = (): string => ler("SECURITY.md");

  it("usa um mecanismo real (GitHub Security Advisories) e NÃO inventa um e-mail de contato", () => {
    const sec = security();
    cobre(sec, [
      {
        oQue: "GitHub Security Advisories como canal privado",
        padrao: /Security Advisor/i,
        porque: "é o único canal que já existe no dia do primeiro push; 'mande um e-mail' sem caixa é becos sem saída",
      },
      // ── A DECISÃO FOI TOMADA (2026-08-19), e esta exigência INVERTEU ────────────────────────────
      // Ela cobrava aqui um marcador de preenchimento pendente, LITERAL, no lugar do contato — e
      // estava certa enquanto o canal era pergunta em aberto: campo marcado é mais honesto que
      // endereço inventado. Só que o documento VIAJA com ele. Um repositório público que anuncia por
      // escrito que ainda não decidiu quem responde por uma falha não tem canal; tem um lembrete.
      //
      // O dono decidiu: reporte privado do GitHub, e nenhum e-mail publicado. A propriedade a
      // defender inverteu — de "está marcado como pendente" para "NÃO há pendência marcada" —, e ela
      // é maior que este arquivo: vale para todo documento de governança que viaja, e quem a cobra é
      // `oss-governance.test.ts`. Aqui fica só o que é deste documento: que a ausência do e-mail
      // esteja escrita como DECISÃO. Sem essa frase o leitor conclui esquecimento e vai procurar
      // outro canal — que é o mesmo dano do placeholder, com outra cara.
      {
        oQue: "a ausência de e-mail declarada como DECISÃO, não como esquecimento",
        padrao: /aus[êe]ncia [ée] a decis[ãa]o|n[ãa]o h[áa] e-?mail de contato/i,
        porque: "sem ela o leitor lê a falta de contato como campo esquecido e procura um canal que não existe",
      },
    ]);
    // Um endereço de e-mail com TLD reconhecível = alguém inventou uma caixa. O relato de uma falha
    // indo para um endereço que não existe é pior que não ter canal: o pesquisador acha que avisou.
    const emailInventado = sec.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|org|net|dev|io|ai|com\.br|br)\b/i);
    expect(emailInventado?.[0] ?? "", "e-mail de contato inventado no SECURITY.md").toBe("");
  });

  it("declara single-operator e diz explicitamente que RBAC NÃO existe", () => {
    cobre(security(), [
      {
        oQue: "o termo single-operator",
        padrao: /single[- ]operator/i,
        porque: "é a decisão de arquitetura; sem ela um adotante em equipe conclui coisas erradas sobre os controles",
      },
      {
        oQue: "a ausência de RBAC, dita com essa palavra",
        padrao: /RBAC/,
        porque: "quem procura papéis procura por 'RBAC'; o silêncio é lido como 'ainda não achei onde configura'",
      },
      {
        oQue: "quem autentica alcança spawn, deploy e shell",
        padrao: /qualquer pessoa autenticada|quem tem a credencial/i,
        porque: "é a consequência prática do modelo — a credencial não é 'login', é a máquina",
      },
    ]);
  });

  it("documenta a revogação que o produto JÁ tem: rotacionar o token derruba toda sessão viva", () => {
    cobre(security(), [
      {
        oQue: "rotação do token do operador como revogação",
        padrao: /rotacion/i,
        porque: "é o único botão de pânico que existe, e não estava documentado em lugar nenhum",
      },
      {
        oQue: "o efeito: TODA sessão em circulação cai",
        padrao: /toda sess[ãa]o|todas as sess[õo]es/i,
        porque: "sem o efeito declarado, o operador rotaciona e continua achando que há cookie vivo por aí",
      },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("(4) o threat model registra o que foi MEDIDO — inclusive o que joga contra o produto", () => {
  const threatModel = (): string => ler("docs/threat-model.md");

  it("a superfície MCP na internet e o skip-permissions estão na primeira página, não escondidos", () => {
    const primeiraPagina = threatModel().split("\n").slice(0, 60).join("\n");
    cobre(primeiraPagina, [
      {
        oQue: "MCP na internet pública POR DESENHO",
        padrao: /internet p[úu]blica/i,
        porque: "é o produto, não um bug — esconder isso no rodapé é o que faz o adotante se surpreender depois",
      },
      {
        oQue: "as tools spawnam claude com skip-permissions",
        padrao: /--dangerously-skip-permissions/,
        porque: "é o que a credencial do MCP realmente vale: execução arbitrária na máquina",
      },
      {
        oQue: "single-operator: a credencial É a máquina",
        padrao: /single[- ]operator/i,
        porque: "toda garantia declarada abaixo pressupõe um operador; sem isso as garantias são lidas errado",
      },
    ]);
  });

  it("registra os advisories do next@14.2.35 com as DUAS refutações e o que derruba a proteção", () => {
    cobre(threatModel(), [
      {
        oQue: "next@14.2.35 com 21 advisories sem correção em 14.x",
        padrao: /14\.2\.35/,
        porque: "é a decisão do dono de ficar em 14; um número medido é auditável, 'estamos atrás' não é",
      },
      {
        oQue: "a menor versão que fecha tudo (15.5.21)",
        padrao: /15\.5\.21/,
        porque: "sem a saída nomeada, 'aceito' vira 'ignorado'",
      },
      {
        oQue: "GHSA-c4j6 refutado: o servidor próprio é dono do evento upgrade",
        padrao: /GHSA-c4j6[\s\S]{0,900}?upgrade/,
        porque: "é o de maior EPSS do lote — sem a refutação escrita, alguém 'conserta' o que já está fechado",
      },
      {
        oQue: "AGILEHARNESS_DEV=1 derruba essa proteção",
        padrao: /AGILEHARNESS_DEV/,
        porque: "a refutação é CONDICIONAL; omitir a condição transforma uma mitigação em falsa garantia",
      },
      {
        oQue: "GHSA-89xv refutado pelo middleware antes do dispatch",
        padrao: /GHSA-89xv/,
        porque: "a defesa é o portão fail-closed, e ela cai no dia em que a rota entrar em PUBLIC_ROUTES",
      },
      {
        oQue: "GHSA-52cp no js-yaml 3.14.2 interno do gray-matter",
        padrao: /GHSA-52cp[\s\S]{0,600}?gray-matter/,
        porque: "não sai por bump da nossa dependência declarada — é aceito COM mitigação, e isso precisa estar escrito",
      },
      {
        oQue: "a mitigação do GHSA-52cp: o teto do chokepoint LIMITA, não elimina",
        padrao: /limita|n[ãa]o elimina/i,
        porque: "declarar 'mitigado' sem dizer o que sobra é o mesmo que declarar 'resolvido'",
      },
    ]);
  });

  it("registra o vazamento medido do token MCP nos logs do sistema, com a contagem", () => {
    cobre(threatModel(), [
      {
        oQue: "a contagem medida (174 = 168 no journal do Caddy + 6 no syslog)",
        padrao: /174/,
        porque: "número medido é o que impede a leitura 'em teoria pode vazar' — já vazou, e está no disco",
      },
      {
        oQue: "a causa: o logger de ERRO padrão do proxy, sem misconfiguração",
        padrao: /http\.log\.error|logger de erro/i,
        porque: "sem a causa, o operador conclui que foi descuido dele e não muda nada no desenho",
      },
      {
        oQue: "credencial no PATH vaza em toda camada",
        padrao: /no path|no caminho da URL/i,
        porque: "é a lição transferível: proxy, journal, histórico de shell, referer",
      },
      {
        oQue: "o handle revogável como mitigação",
        padrao: /handle/i,
        porque: "é o que existe hoje; sem nomear, o leitor não sabe que há uma saída sem restart",
      },
      {
        oQue: "redação no proxy — FEITA nesta instalação, e o bloco de config que a implementa",
        padrao: /redaç[ãa]o|redact/i,
        porque: "continua sendo recomendação para quem instala (o app não controla o proxy de ninguém), mas aqui já foi aplicada em 2026-08-06 e o documento não pode pedir de novo",
      },
      {
        oQue: "que o filtro vive no bloco GLOBAL, não num `log` de site",
        padrao: /bloco \*\*global\*\*|bloco global/i,
        porque: "um `log` de site configura o log de ACESSO e não toca no de erro, que é justamente quem vazava — foi o primeiro conserto tentado, e ele era vácuo-verde",
      },
      {
        oQue: "que a rotação SEGUE pendente: a redação não apaga o que já está no disco",
        padrao: /rotacione|rotação/i,
        porque: "sem isto o leitor conclui que o incidente fechou; o journal é persistente e legível por root, o que numa casa operada por agentes inclui as sessões de agente",
      },
    ]);
  });

  it("registra as camadas fracas por escolha: CSP report-only, sandbox OFF, PUBLIC_URL obrigatória", () => {
    cobre(threatModel(), [
      {
        oQue: "CSP em report-only ⇒ XSS no painel fica com UMA camada",
        padrao: /report-only/i,
        porque: "report-only não impede nada; declarar 'temos CSP' sem isso é inflar a postura",
      },
      {
        oQue: "a única camada restante é o escape default do React",
        padrao: /React/,
        porque: "nomear a camada única diz onde uma regressão de `dangerouslySetInnerHTML` custa caro",
      },
      {
        oQue: "sandbox nasce DESLIGADO por escolha",
        padrao: /sandbox[\s\S]{0,200}?(desligad|OFF|off)/,
        porque: "é a mesma postura que o OpenClaw ships; escolha declarada não é omissão",
      },
      {
        oQue: "AGILEHARNESS_PUBLIC_URL obrigatória em deploy não-loopback",
        padrao: /AGILEHARNESS_PUBLIC_URL/,
        porque: "sem ela o portão bounceia para localhost e ninguém loga pelo domínio",
      },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// (5) OS PINOS doc↔código. Um documento de segurança errado é pior que documento nenhum: ele
// autoriza decisões. Cada asserção abaixo amarra uma AFIRMAÇÃO do threat model ao código que a
// sustenta — mexer no código sem mexer no doc reprova aqui.
describe("(5) o threat model não pode apodrecer em silêncio", () => {
  it("`/api/usm` continua FORA do portão por self-auth — é a premissa do capítulo do MCP", () => {
    const usm = PUBLIC_ROUTES.find((r) => r.prefix === "/api/usm");
    expect(usm, "o doc afirma que o MCP se autentica pelo token no path, fora do portão de sessão").toBeDefined();
    expect(usm?.reason).toBe("self-auth");
  });

  it("`/api/feedback` continua ATRÁS do portão — é o que torna a lane de ingest inerte", () => {
    // O threat model declara a lane INGEST inerte por fail-closed. Se um dia `/api/feedback` entrar
    // na lista de rotas públicas, a declaração vira falsa NO MESMO COMMIT — e é aqui que se percebe.
    const publicos = PUBLIC_ROUTES.filter((r) => r.prefix.startsWith("/api/feedback"));
    expect(publicos.map((r) => r.prefix).join(", ")).toBe("");
  });

  it("a CSP continua em report-only (se virar enforce, o capítulo de XSS está desatualizado)", () => {
    const cfg = ler("next.config.js");
    expect(cfg).toContain("Content-Security-Policy-Report-Only");
  });

  // ── DUAS COISAS CHAMADAS "SANDBOX" (correção vinda de revisão independente) ────────────────────────
  // Esta sentinela se chamava "o sandbox continua nascendo desligado" e aferia o flag do sandbox
  // ESTRUTURAL em config.ts. Quando F0 ligou a contenção do SO por default, a propriedade que o TÍTULO
  // nomeia deixou de ser verdadeira — e o teste seguiu verde, porque media outro mecanismo. Ou seja: o
  // guarda anti-apodrecimento apodreceu junto, que é o pior desfecho possível para um guarda.
  // Agora são dois testes, cada um pinando o default do SEU mecanismo, com o nome certo.

  // ── PROVA INVERTIDA (2026-08-05): o mecanismo que ela pinava foi REMOVIDO ────────────────────────
  // Ela exigia que `config.ts` continuasse nascendo com `sandbox: { enabled: false }` — o default do
  // sandbox ESTRUTURAL (ADR-063), a camada fail-open. Mantida como estava, ela obrigaria a main a
  // carregar para sempre o default de um mecanismo apagado, e a documentá-lo. É a mesma classe do
  // "teste que cimenta a vulnerabilidade": uma prova que afirma o estado atual não distingue "está
  // certo" de "está assim".
  //
  // A propriedade a defender inverteu: o mecanismo NÃO pode voltar por descuido, e a documentação não
  // pode voltar a citá-lo. Se alguém reintroduzir a camada fail-open ao lado da fail-closed, é aqui
  // que aparece — e o motivo de as duas não poderem coexistir está escrito em engine.ts, onde ela saiu.
  it("a camada fail-open (ADR-063) NÃO VOLTA — nem no código, nem na documentação", () => {
    const cfg = ler("src/lib/storymap/runner/config.ts");
    expect(cfg).not.toMatch(/sandbox:\s*\{\s*enabled:/);
    for (const doc of ["SECURITY.md", "docs/threat-model.md"]) {
      expect(ler(doc), `${doc} ainda cita um mecanismo que não existe`).not.toContain("USM_AUTORUN_SANDBOX");
    }
  });

  it("a CONTENÇÃO DO SO (ADR-067) continua nascendo LIGADA e fail-closed — o doc afirma default ON", () => {
    const src = ler("src/lib/storymap/runner/autonomy-sandbox.ts");
    // `preferred` = tenta conter; sem sandbox, rebaixa com aviso (nunca roda sem fronteira em silêncio).
    expect(src).toMatch(/DEFAULT_SANDBOX_MODE:\s*SandboxMode\s*=\s*"preferred"/);
    // Sem sandbox o run NÃO roda — é o que inverte o sinal da degradação, e o que o threat-model promete.
    expect(src).toMatch(/failIfUnavailable:\s*true/);
    // A saída existe e é explícita: o doc a nomeia como A alavanca de reversão.
    expect(src).toMatch(/AGILEHARNESS_ALLOW_UNSANDBOXED_FULL/);
  });

  it("os dois documentos de segurança SEPARAM os dois mecanismos pelo nome", () => {
    // A reprovação foi literal: o adotante lia "não há contenção salvo opt-in" e ia ligar
    // `USM_AUTORUN_SANDBOX=1` achando que estava ligando a proteção — a alavanca errada.
    const sec = ler("SECURITY.md");
    const tm = ler("docs/threat-model.md");
    for (const [nome, doc] of [
      ["SECURITY.md", sec],
      ["threat-model.md", tm],
    ] as const) {
      expect(doc, `${nome} precisa nomear a contenção do SO`).toMatch(/AGILEHARNESS_SANDBOX_MODE|Conten[çc][ãa]o do SO/);
      // ── AS DUAS OUTRAS ASSERÇÕES SAÍRAM (2026-08-05) ───────────────────────────────────────────
      // Elas exigiam que os documentos NOMEASSEM `USM_AUTORUN_SANDBOX` e dissessem que os defaults
      // eram "opostos". Faziam sentido quando havia dois mecanismos e o adotante podia ligar a
      // alavanca errada. Com a camada fail-open removida, manter as duas obrigaria a main a
      // documentar para sempre um mecanismo apagado — um guarda anti-apodrecimento que ele mesmo
      // apodreceu. O par desta asserção agora é a prova acima, que exige o CONTRÁRIO: que a env
      // removida não apareça mais em documento nenhum.
    }
  });

  it("rotacionar o token do operador REALMENTE derruba a sessão assinada antes — a revogação documentada", async () => {
    // O pino mais importante do bloco, e o único BEHAVIORAL: o SECURITY.md promete ao operador um
    // botão de pânico sem estado no servidor. Se o material de chave deixar de incluir o token, a
    // promessa continua escrita e para de ser verdade — e nada mais no pacote perceberia.
    const sessionSecret = "s".repeat(48);
    const tokenAntigo = `token-do-operador-antigo-${"a".repeat(20)}`;
    const tokenNovo = `token-do-operador-novo-${"b".repeat(20)}`;
    const cookie = await signSession({ sessionSecret, operatorToken: tokenAntigo });
    expect(
      await verifySession({ token: cookie, sessionSecret, operatorToken: tokenAntigo }),
      "o cookie recém-assinado tem de valer — sem isto o teste passaria por não medir nada",
    ).toBe(true);
    expect(
      await verifySession({ token: cookie, sessionSecret, operatorToken: tokenNovo }),
      "cookie emitido sob o token ANTIGO continuou válido depois da rotação — a revogação documentada não existe",
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("(6) o .env.example é o CATÁLOGO que o README promete — e a promessa é medida", () => {
  // O README afirma que o `.env.example` "documenta todos os knobs de operador (AGILEHARNESS_*,
  // STORYMAP_*, USM_*) com o porquê de cada default". Uma revisão independente mediu e a promessa era
  // falsa para 25 chaves LIDAS do ambiente — incluindo o freio dos reapers, que o próprio README manda
  // ligar ao apontar o motor para um repositório novo. Um interruptor que só existe no código é um
  // interruptor que ninguém aciona na hora em que precisa.
  //
  // A DISTINÇÃO QUE ESTE LINT FAZ, e que é a razão de ele medir a coisa certa: uma chave LIDA do
  // ambiente (`env.X`) é um knob de operador e precisa estar documentada; uma chave ESCRITA no ambiente
  // de um filho (`env.X = ...`) é protocolo interno do harness e não é knob de ninguém. Casar as duas
  // juntas produziria uma lista inflada, e uma lista inflada é abandonada.
  const SRC = path.resolve(PKG_ROOT, "src");
  const GRUPO_CHAVES = "AGILEHARNESS_[A-Z0-9_]+|STORYMAP_[A-Z0-9_]+|USM_[A-Z0-9_]+";

  const semComentarios = (src: string): string =>
    src
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");

  /** Chaves LIDAS do ambiente em todo o `src/` (exclui atribuição, que é escrita para o filho). */
  const chavesLidas = (): string[] => {
    const achadas = new Set<string>();
    const varrer = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const full = path.join(dir, e);
        if (statSync(full).isDirectory()) varrer(full);
        else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) {
          const src = semComentarios(readFileSync(full, "utf8"));
          const re = new RegExp(`(?:process\\.)?env(?:Like)?[\\.\\[]"?(${GRUPO_CHAVES})"?\\]?`, "g");
          for (const m of src.matchAll(re)) {
            const depois = src.slice(m.index + m[0].length, m.index + m[0].length + 4);
            if (/^\s*=[^=]/.test(depois)) continue; // `env.X = ...` é ESCRITA para o filho, não knob
            achadas.add(m[1]);
          }
        }
      }
    };
    varrer(SRC);
    return [...achadas].sort();
  };

  it("o PRÉ-REQUISITO DE HOST está no caminho de instalação, não só no ADR", () => {
    // Debian/Ubuntu de fábrica não trazem bubblewrap nem socat. Sem eles a contenção não sobe e TODO
    // run de autonomia plena é rebaixado — o recurso de manchete para de funcionar, e o sintoma que o
    // adotante vê é "falta shell", não "instale bubblewrap". A declaração vivia só no ADR da fase: o
    // mesmo erro de PLACEMENT que este arquivo já cobrou para os knobs de env.
    const readme = ler("README.md");
    const quickstart = readme.indexOf("```bash");
    expect(quickstart).toBeGreaterThan(0);
    const antesDoPrimeiroComando = readme.slice(0, quickstart + 400);
    expect(
      antesDoPrimeiroComando,
      "o README precisa mandar instalar bubblewrap + socat no bloco de instalação",
    ).toMatch(/bubblewrap[\s\S]{0,40}socat|socat[\s\S]{0,40}bubblewrap/i);
  });

  it("toda chave lida do ambiente aparece no .env.example", () => {
    const exemplo = ler(".env.example");
    const ausentes = chavesLidas().filter((k) => !exemplo.includes(k));
    expect(
      ausentes.join("\n"),
      "knob de operador que o código LÊ e o catálogo não documenta — o README promete o contrário",
    ).toBe("");
  });

  it("NÃO-VACUIDADE: a varredura encontrou chaves de verdade", () => {
    // Sem esta guarda, um erro no regex ou no caminho tornaria o teste acima verde medindo ZERO — o
    // modo de falha que este repositório já nomeou e pagou mais de uma vez.
    const chaves = chavesLidas();
    expect(chaves.length).toBeGreaterThan(50);
    expect(chaves).toContain("AGILEHARNESS_REAPER_MODE"); // a que a revisão pegou faltando
    expect(chaves).toContain("AGILEHARNESS_SANDBOX_MODE");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * (7) O PLANO E A ÁRVORE NÃO PODEM DIVERGIR SOBRE A CONTENÇÃO.
 *
 * Motivo de existir, medido em 2026-08-06: o plano declarava F0 "congelado" com um aceite escrito
 * que a árvore contradizia ("a injeção de IS_SANDBOX=1 é removida" — ela não foi, e não podia ser),
 * e o F0 que de fato foi CONSTRUÍDO — netns, egresso, denyRead, managed-settings — não aparecia em
 * nenhuma das 1690 linhas do documento. Seis fases declaravam `dep: F0` sobre esse pressuposto.
 *
 * Uma fase cujo escopo não está escrito não pode ser TERMINADA, só abandonada. Este bloco existe
 * para que a próxima divergência REPROVE em vez de virar semanas de estimativa sobre areia.
 */
describe("(7) o plano de extração e a árvore não podem divergir sobre a contenção (F0)", () => {
  const PLANO_DOC = "docs/plans/agileharness-oss/09-plano-multirepo-e-extracao.md";

  /**
   * O plano NÃO viaja (docs/ inteiro fica: cita a VPS do dono). Este bloco tem duas metades e só
   * UMA depende dele:
   *   · ler o documento (o F0 executado está descrito? as exceções estão NOMEADAS?) — umbrella
   *   · varrer a ÁRVORE (quem emite a flag, cada injeção de IS_SANDBOX tem gate?) — VIAJA, e segue
   *     incondicional no artefato, porque é ela que pega um emissor NOVO.
   *
   * `soDoUmbrella` é a porta honesta: no umbrella a ausência LANÇA (a regressão que o guarda existe
   * para pegar), no extraído devolve null e grita no console dizendo o que deixou de ser medido.
   * Não é `if (!existe) return` — esse não distingue "não devia estar aqui" de "sumiu".
   */
  function plano(): string | null {
    const abs = soDoUmbrella(PLANO_DOC);
    if (!abs) return null;
    const txt = readFileSync(abs, "utf8");
    if (txt.trim().length === 0) throw new Error(`${PLANO_DOC} está vazio.`);
    return txt;
  }

  /** Todo .ts de PRODUÇÃO sob src/ (o que viaja e o que roda; testes ficam de fora). */
  function fontesDeProducao(): string[] {
    const achados: string[] = [];
    const anda = (dir: string): void => {
      for (const entrada of readdirSync(dir)) {
        const p = path.join(dir, entrada);
        if (statSync(p).isDirectory()) {
          anda(p);
        } else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
          achados.push(p);
        }
      }
    };
    anda(path.join(PKG_ROOT, "src"));
    return achados;
  }

  /** Uma linha que MENCIONA a string em comentário não emite nada — só código conta. */
  function linhaEhCodigo(linha: string): boolean {
    const t = linha.trim();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
  }

  /**
   * Nem toda linha de código que contém a flag a EMITE. `server/main.ts:330` a imprime dentro de um
   * aviso ao operador, entre crases ESCAPADAS (`` \`claude --dangerously-skip-permissions\` ``) —
   * texto para humano ler, não argv.
   *
   * A distinção é semântica e um regex amplo erraria, então o corte é estreito de propósito: só
   * remove a ocorrência quando ela vem colada numa crase escapada. Um `push(...)`, um elemento de
   * array ou uma interpolação de comando continuam contando como emissão — que é o que importa.
   */
  function semMencoesEmProsa(linha: string): string {
    return linha.replace(/\\`[^`]*--dangerously-skip-permissions[^`]*\\`/g, "");
  }

  function arquivosComCodigoCasando(padrao: RegExp): string[] {
    return fontesDeProducao()
      .filter((p) =>
        readFileSync(p, "utf8")
          .split("\n")
          .some((l) => linhaEhCodigo(l) && padrao.test(semMencoesEmProsa(l))),
      )
      .map((p) => path.relative(path.join(PKG_ROOT, "src"), p))
      .sort();
  }

  /**
   * O módulo que GOVERNA a flag (emite a escotilha declarada e a detecta no portão) não é exceção —
   * é o dono da regra. Os três abaixo são as exceções ASSINADAS pelo dono em 2026-08-06.
   */
  const GOVERNA = "lib/storymap/runner/autonomy-sandbox.ts";
  const EXCECOES_ASSINADAS = [
    "app/actions.ts", // resumeRunInTerminalAction — tmux que o operador assiste em /terminal
    "lib/storymap/copilot/protocol.ts",
    "lib/storymap/runner/deploy-agent-spawn.ts",
    "lib/storymap/smart-capture/claude.ts",
  ] as const;

  // `skipIf` NO LUGAR DO `return`: o plano é doc do umbrella e não viaja. Na árvore extraída o corpo
  // saía sem asserção, e verde-por-omissão é indistinguível de verde-por-conferência.
  it.skipIf(!plano())("o documento descreve o F0 que foi EXECUTADO, não um que ninguém construiu", () => {
    const doc = plano()!;
    cobre(doc, [
      {
        oQue: "a contenção por namespace do SO, que é o F0 real",
        padrao: /netns|namespace de PID|bwrap|sandbox-runtime/i,
        porque: "sem isto o documento descreve uma fase que não foi feita e omite a que foi",
      },
      {
        oQue: "o egresso por allowlist com casamento por host EXATO",
        padrao: /host exato/i,
        porque: "quem escreve a lista precisa saber que example.com não concede www.example.com",
      },
      {
        oQue: "a quinta chave obrigatória neste host",
        padrao: /enableWeakerNestedSandbox/,
        porque: "omiti-la faz a jaula não subir E toda chamada Bash morrer — é a pegadinha da postura",
      },
      {
        oQue: "que IS_SANDBOX=1 NÃO é sandbox, e sim o bypass da trava de root do CLI",
        padrao: /IS_SANDBOX=1\*\*? ?\*\*?não é um sandbox|não é um sandbox/i,
        porque: "foi a leitura invertida que produziu um aceite pedindo a remoção de algo que mata todo run",
      },
    ]);
  });

  it("os três caminhos fora da jaula estão NOMEADOS no plano — e são exatamente os que a árvore tem", () => {
    const doc = plano();
    // METADE 1 — o documento. Só no umbrella; no artefato o plano não viaja.
    if (doc) {
      for (const caminho of EXCECOES_ASSINADAS) {
        const base = path.basename(caminho);
        expect(doc, `o plano não nomeia a exceção ${base} — exceção não escrita é pendência esquecida`).toContain(base);
      }
    }

    // METADE 2 — a ÁRVORE. INCONDICIONAL nas duas: é ela que pega um emissor novo, e o artefato
    // precisa dela mais que o umbrella (lá o revisor tem o plano; aqui só tem esta asserção).
    const emitem = arquivosComCodigoCasando(/--dangerously-skip-permissions/);
    expect(
      emitem.sort(),
      "o conjunto de arquivos que emitem --dangerously-skip-permissions mudou; se for um caminho " +
        "novo, ele precisa entrar no plano como exceção ASSINADA (ou entrar na jaula) antes de passar",
    ).toEqual([GOVERNA, ...EXCECOES_ASSINADAS].sort());
  });

  it("nenhuma injeção de IS_SANDBOX é INCONDICIONAL — cada uma vive sob um gate", () => {
    const arquivos = fontesDeProducao().filter((p) => readFileSync(p, "utf8").includes('IS_SANDBOX'));
    const semGate: string[] = [];

    for (const p of arquivos) {
      const linhas = readFileSync(p, "utf8").split("\n");
      linhas.forEach((linha, i) => {
        if (!linhaEhCodigo(linha) || !/IS_SANDBOX\s*[:=]\s*"1"/.test(linha)) return;
        // O gate pode estar na própria linha (`if (...) env.IS_SANDBOX = "1"`) ou nas 6 acima
        // (ternário multi-linha, bloco `if`). Fora dessa janela, é injeção cega.
        const janela = linhas.slice(Math.max(0, i - 6), i + 1).join("\n");
        const temGate = /needsRootBypass|escapeHatchNeedsRootBypass|getuid\s*\(?\)?\s*(\?\.\(\))?\s*===\s*0|getuid\?\.\(\)\s*===\s*0/.test(janela);
        if (!temGate) semGate.push(`${path.relative(path.join(PKG_ROOT, "src"), p)}:${i + 1}`);
      });
    }

    expect(
      semGate.join("\n"),
      "injeção de IS_SANDBOX=1 sem gate: ela permite --dangerously-skip-permissions como root, " +
        "então injetá-la cegamente afirma ao CLI, em TODO spawn, algo que só vale na escotilha",
    ).toBe("");
  });

  it("NÃO-VACUIDADE: a varredura leu código de verdade, não uma árvore vazia", () => {
    // Sem esta guarda, um erro no caminho ou no regex tornaria os três casos acima verdes medindo
    // ZERO — que é exatamente como esta casa já se enganou antes.
    const fontes = fontesDeProducao();
    expect(fontes.length).toBeGreaterThan(300);

    // O emissor governante TEM de ser encontrado: se a varredura não o acha, ela não acha nada.
    const emitem = arquivosComCodigoCasando(/--dangerously-skip-permissions/);
    expect(emitem).toContain(GOVERNA);

    // E o filtro de comentário precisa MORDER: types.ts só MENCIONA a flag em prosa e não pode
    // aparecer como emissor. Sem esta linha, `linhaEhCodigo` poderia estar sempre-verdadeiro.
    expect(emitem).not.toContain("lib/storymap/types.ts");

    // O mesmo para o filtro de prosa: server/main.ts imprime a flag num aviso ao operador, entre
    // crases escapadas. Sem `semMencoesEmProsa` ele entraria na lista como se spawnasse algo.
    expect(emitem).not.toContain("server/main.ts");

    // ...e o filtro não pode ser largo demais: ele remove SÓ a menção entre crases escapadas, nunca
    // uma emissão de verdade. As duas metades, vistas na mesma asserção.
    expect(semMencoesEmProsa('`rode \\`claude --dangerously-skip-permissions\\` aqui`')).not.toMatch(
      /--dangerously-skip-permissions/,
    );
    expect(semMencoesEmProsa('args.push("--dangerously-skip-permissions");')).toMatch(
      /--dangerously-skip-permissions/,
    );
  });
});
