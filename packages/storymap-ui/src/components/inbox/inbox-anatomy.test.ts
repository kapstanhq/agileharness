import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decideItem, HAPPENED_MAX, OPTION_LABEL_MAX, type DecisionOption, type ItemDecision } from "@/lib/storymap/inbox/decision";
import { bannedTermsIn, formatDecisionText, localTimeFormatter } from "@/lib/storymap/inbox/copy";
import { ctx, FIXTURES, KINDS, MODES } from "@/lib/storymap/inbox/items.fixture";
import type { SystemDecision } from "@/lib/storymap/system-decisions";
import { INBOX_EMPTY_TEXT, isUndoLike, kindNoun, needOf, RECEIPT_MS, withHeld } from "./inbox-ui";
import { REGISTRY_DAYS, systemRegistry } from "./registry";

// A ANATOMIA NOVA do Inbox (fase 3) — uma só, em toda superfície:
//   [board ▪] · Pergunta · há 12 min / O que aconteceu / O que eu preciso de você / [opções de um clique] / Mais detalhes
// Contrato sobre a FONTE onde o rig não renderiza React (node, sem DOM), e sobre as funções puras (inbox-ui.ts) e o
// texto que a tela mostra de TODO kind (as fixtures do modelo). Substitui inbox-item-card.test.ts (o cartão de cinco
// partes, a folha e o diálogo de confirmação saíram de propósito).

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const exists = (rel: string) => existsSync(fileURLToPath(new URL(rel, import.meta.url)));
const item = read("./InboxItem.tsx");
const options = read("./InboxOptions.tsx");
const home = read("./InboxHome.tsx");
const detailsBlock = item.slice(item.indexOf("const detailsView = "), item.indexOf("// ── a faixa do host"));

describe("a anatomia — sempre na mesma ordem", () => {
  it("contexto → o que aconteceu → o que eu preciso de você → as opções → «Mais detalhes» (fechado)", () => {
    const full = item.slice(item.indexOf("// ── a anatomia inteira"));
    const at = (needle: string) => {
      const i = full.indexOf(needle);
      expect(i, `presente: ${needle}`).toBeGreaterThan(-1);
      return i;
    };
    expect(at("<ContextLine")).toBeLessThan(at("O que aconteceu: "));
    expect(at("O que aconteceu: ")).toBeLessThan(at("O que eu preciso de você: "));
    expect(at("O que eu preciso de você: ")).toBeLessThan(at("<InboxOptions"));
    // «Mais detalhes» é UM bloco (`detailsView`), o mesmo na anatomia inteira e na linha curta da página do item
    expect(at("<InboxOptions")).toBeLessThan(at("{detailsView}"));
    // «Mais detalhes» nasce FECHADO — só a página do item o abre
    expect(detailsBlock).toMatch(/<details className="group" open=\{detailsOpen \|\| undefined\}>/);
  });

  it("a linha de contexto: o selo do board (no Inbox de todos), o tipo e a idade no fuso de quem lê", () => {
    const line = item.slice(item.indexOf("function ContextLine("), item.indexOf("export function InboxItemRow("));
    expect(line).toMatch(/<BoardChip name=\{entry\.boardName\} \/>/);
    expect(line).toMatch(/kindNoun\(entry\.kind\)/);
    expect(line).toMatch(/relativeWithClock\(entry\.decision\.since, now, tz\)/);
  });

  it("«Mais detalhes» guarda o resto: se ignorar, o que cada opção faz, o corpo, as facetas, «Mais» e os ids", () => {
    const details = detailsBlock.slice(detailsBlock.indexOf("Mais detalhes"));
    // as facetas saem por `facetLinks` (cada uma diz o que a distingue — inbox-ui.test.ts)
    for (const needle of ["Se você não fizer nada: ", "O que cada opção faz", "<InboxDetailsBody", "facets.map", 'aria-label="Mais"', "d.details.map"]) {
      expect(details, needle).toContain(needle);
    }
    // a consequência é TEXTO (em «Mais detalhes»), ligada ao botão por aria-describedby — nunca só um tooltip
    expect(details).toMatch(/id=\{`\$\{uid\}-\$\{o\.id\}`\}/);
    expect(options).toMatch(/aria-describedby=\{describe\(o\)\}/);
    expect(options).not.toMatch(/title=\{[^}]*consequence/);
  });

  it("o pedido exato de um agente e o comando de uma execução aprovada ficam À VISTA antes das opções (nada às cegas)", () => {
    const full = item.slice(item.indexOf("// ── a anatomia inteira"));
    expect(full.indexOf("<InboxPreview")).toBeLessThan(full.indexOf("<InboxOptions"));
    const bodies = read("./InboxBodies.tsx");
    const preview = bodies.slice(bodies.indexOf("export function InboxPreview("), bodies.indexOf("/** O corpo de «Mais detalhes». */"));
    expect(preview).toMatch(/item\?\.kind === "approval"/);
    expect(preview).toMatch(/item\?\.kind === "locked-exec"/);
  });
});

describe("um clique — nada de diálogo, nada de formulário antes do botão", () => {
  it("nenhuma superfície do Inbox abre diálogo de confirmação", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".tsx"))) {
      const src = read(`./${f}`);
      expect(src, f).not.toMatch(/ConfirmDialog|window\.confirm\(/);
    }
  });

  // revisão da fase 3: o «Desfazer» do registro e de «Resolvido hoje» ainda pedia o motivo escrito antes (dois passos),
  // enquanto o mesmo desfazer no item vivo rodava num clique com o motivo padrão
  it("o «Desfazer» é UM clique em todo lugar: reabrir roda com o motivo padrão, sem caixa de texto antes", () => {
    const undo = read("./UndoControl.tsx");
    expect(undo).not.toMatch(/<textarea|requiresNote/);
    expect(undo).toMatch(/note: undo\.reopens \? REOPEN_DEFAULT_NOTE : null/);
    expect(read("./registry.ts")).not.toMatch(/requiresNote/);
  });

  it("no máximo UM botão cheio — a principal do modelo", () => {
    expect(item).toMatch(/const primary = primaryOption\(d\)/);
    expect(item).toMatch(/primaryId=\{primary\?\.id \?\? null\}/);
    expect(options).toMatch(/optionCls\(o, o\.id === primaryId\)/);
  });

  it("a resposta escrita é uma linha com o botão ao lado (Enter envia); a escolha múltipla, chips + o envio", () => {
    expect(options).toMatch(/<form[\s\S]*?onSubmit=/);
    expect(options).toMatch(/<input[\s\S]*?aria-label="A sua resposta"/);
    expect(options).not.toMatch(/<textarea/);
    expect(options).toMatch(/aria-pressed=\{on\}/);
    expect(options).toMatch(/onRun\(selection, \{ selectedOptionIds: picked, answer: "" \}\)/);
  });

  it("a opção bloqueada diz o motivo numa linha, com o link que a destrava", () => {
    expect(options).toMatch(/o\.disabled!\.reason/);
    expect(options).toMatch(/o\.disabled!\.unblock\.href/);
  });
});

describe("depois do clique — o recibo no lugar, com «Desfazer», e o próximo item", () => {
  const run = item.slice(item.indexOf("const run = useCallback("), item.indexOf("const holdProps"));

  it("o recibo é DURÁVEL e gravado ANTES da recarga; o «Desfazer» só quando a ação volta atrás", () => {
    expect(run).toMatch(/await recordInboxReceiptAction\(/);
    expect(run.indexOf("recordInboxReceiptAction(")).toBeLessThan(run.indexOf("router.refresh()"));
    expect(run).toMatch(/undo: option\.undo \?\? null/);
    expect(run).toMatch(/receiptId && option\.undo/);
    expect(item).toMatch(/Feito<\/b> — \{text\(receipt\.text\)\}/);
    expect(item).toMatch(/<UndoControl boardId=\{entry\.boardId\} undo=\{\{ source: "receipt"/);
  });

  it("a recusa do servidor aparece no lugar do recibo, com o motivo", () => {
    expect(run).toMatch(/outcome\?\.status === "refused"/);
    expect(run).toMatch(/setRefusal\(outcome\.message\)/);
    expect(item).toMatch(/role="alert"[\s\S]{0,120}Não deu: /);
  });

  it("a opção que rodou com o texto padrão oferece «Adicionar um motivo» no recibo", () => {
    expect(run).toMatch(/option\.addNote \? \{ addNote: option\.addNote \}/);
    expect(item).toMatch(/runServerInvoke\(addNote\.invoke, \{ note: note\.trim\(\) \}\)/);
  });

  it("o recibo some sozinho em ~6 s (o ponteiro ou o foco nele seguram o tempo) e a lista leva o foco ao próximo", () => {
    expect(RECEIPT_MS).toBe(6000);
    expect(item).toMatch(/if \(!receipt \|\| !onExpired \|\| holding\) return;/);
    const list = home.slice(home.indexOf("function DecideList("));
    expect(list).toMatch(/const next = cur\[index \+ 1\] \?\? cur\[index - 1\]/);
    expect(list).toMatch(/el\?\.focus\(/);
  });

  it("a lista SEGURA o item resolvido no lugar enquanto o recibo está na tela (a recarga já o tirou)", () => {
    const a = { key: "a" };
    const b = { key: "b" };
    const c = { key: "c" };
    // b saiu da lista do servidor: volta na posição dele
    expect(withHeld([a, c], [{ entry: b, index: 1 }]).map((e) => e.key)).toEqual(["a", "b", "c"]);
    // ainda vivo: não duplica
    expect(withHeld([a, b, c], [{ entry: b, index: 1 }]).map((e) => e.key)).toEqual(["a", "b", "c"]);
    // a lista encolheu: vai para o fim, nunca some
    expect(withHeld([], [{ entry: c, index: 2 }]).map((e) => e.key)).toEqual(["c"]);
  });
});

describe("toda superfície desenha o item pelo mesmo componente", () => {
  it.each([
    ["a lista (decidir)", "./InboxHome.tsx", /<InboxItem entry=\{e\} now=\{now\} board=/],
    ["a faixa do host", "./InboxHome.tsx", /<InboxItem [^>]*variant="banner"/],
    ["«Os agentes estão cuidando»", "./AgentsCaring.tsx", /<InboxItem [^>]*variant="short"/],
    ["a página do item, com «Mais detalhes» aberto", "./InboxItemScreen.tsx", /<InboxItem [^>]*detailsOpen/],
    ["o painel do Inbox da barra", "../shell/InboxIconLink.tsx", /<InboxItemRow\b/],
  ])("%s", (_name, rel, re) => {
    expect(read(rel)).toMatch(re);
  });

  it("o Inbox do board e o de todos são a MESMA tela; o do board leva ao de todos", () => {
    expect(read("../CockpitView.tsx")).toMatch(/<InboxHome snapshot=\{snapshot\} scope=\{\{ board: config\.id \}\}/);
    expect(read("../../app/inbox/page.tsx")).toMatch(/<InboxHome snapshot=\{snapshot\} scope="all"/);
    expect(home).toMatch(/Ver de todos os boards/);
  });

  // revisão da fase 3: o /inbox ainda usava a barra velha («← logo / Inbox», sem seletor nem engrenagem) e não tinha o
  // compositor do Jido nem a reserva dele — a casca da fase 1 vale para as DUAS páginas do Inbox.
  it("o Inbox de todos os boards tem a barra da fase 1 e o compositor do Jido, com a reserva de rodapé", () => {
    const page = read("../../app/inbox/page.tsx");
    expect(page).toMatch(/<BoardHeader boards=\{boards\} config=\{home\} view="inbox" inboxScope="all" \/>/);
    expect(page).toMatch(/composerGutter/);
  });

  it("a anatomia velha saiu: o cartão de cinco partes, a folha, a lista de linhas e a barra presa", () => {
    for (const f of ["./InboxItemCard.tsx", "./InboxSheet.tsx", "./InboxList.tsx", "./InboxSections.tsx", "./useOverlayReserve.ts", "../AcompanharView.tsx"]) {
      expect(exists(f), f).toBe(false);
    }
  });
});

describe("a página", () => {
  it("o título curto com o número, o vazio do dono e os chips só com mais de um board com itens", () => {
    expect(home).toMatch(/Precisa de você <span[^>]*>\{decidir\.length\}<\/span>/);
    expect(INBOX_EMPTY_TEXT).toBe("Nada precisa de você agora. Os agentes seguem sozinhos.");
    expect(home).toMatch(/const chips = !boardScope && \(withItems\.length > 1/);
  });

  it("«Os agentes estão cuidando (N)» é uma linha recolhida no fim, com o registro do que eles decidiram", () => {
    const caring = read("./AgentsCaring.tsx");
    expect(caring).toMatch(/const \[open, setOpen\] = useState\(defaultOpen\)/);
    expect(caring).toMatch(/Os agentes estão cuidando <span[^>]*>\(\{entries\.length\}\)<\/span>/);
    expect(caring).toMatch(/O que os agentes decidiram por você nos últimos dias/);
    expect(home.indexOf("<StaleArchive")).toBeLessThan(home.indexOf("<AgentsCaring"));
    // a página antiga do registro redireciona para a seção aberta
    // (no next.config, antes de qualquer render: um redirect() dentro do layout do board estourava o React #310)
    expect(exists("../../app/board/[boardId]/acompanhar/page.tsx")).toBe(false);
    expect(read("../../../next.config.js")).toMatch(/source: "\/board\/:boardId\/acompanhar", destination: "\/board\/:boardId\/inbox\?cuidando=1"/);
  });

  it("o registro guarda os dias ANTERIORES a «Resolvido hoje», até REGISTRY_DAYS, só do board pedido", () => {
    const now = Date.parse("2026-09-28T20:00:00Z");
    const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const d = (id: string, at: string, board = "livraria"): SystemDecision =>
      ({ v: 1, id, at, board, agent: "triage-judge", kind: "triage-accept", what: "Aceitou na triagem", why: "o PRD pede a vitrine" }) as SystemDecision;
    const rows = systemRegistry([d("hoje", ago(10)), d("anteontem", ago(48)), d("velha", ago(24 * (REGISTRY_DAYS + 1))), d("outro", ago(48), "cafe")], [{ id: "livraria", name: "Livraria" }], now);
    expect(rows.map((r) => r.key)).toEqual(["s:anteontem"]);
    expect(rows[0]).toMatchObject({ who: "sistema", whoLabel: "Juiz da triagem", boardName: "Livraria", what: "Aceitou na triagem — por quê: o PRD pede a vitrine" });
  });

  it("a linha curta mostra só o que volta atrás", () => {
    const opt = (label: string, kind: string): Pick<DecisionOption, "label" | "invoke"> => ({ label, invoke: { kind } as DecisionOption["invoke"] });
    expect(isUndoLike(opt("Desfazer: voltar à Triagem", "undo-system-decision"))).toBe(true);
    expect(isUndoLike(opt("Reabrir para mim", "resolve-proxy-audit"))).toBe(true);
    expect(isUndoLike(opt("Publicar em produção", "move-card"))).toBe(false);
  });

  it("ao vivo: `inbox.changed` relê a tela", () => {
    expect(home).toMatch(/useInboxChanged\(\(\) => router\.refresh\(\), \{ boards: filter \? \[filter\] : null \}\)/);
  });
});

describe("o texto que o item mostra, de TODO kind, é simples e curto", () => {
  const fmt = localTimeFormatter(Date.parse("2026-09-28T20:00:00Z"), "America/Sao_Paulo");
  const shown = (d: ItemDecision) => ({
    need: formatDecisionText(needOf(d), fmt),
    happened: formatDecisionText(d.happened, fmt),
    labels: d.options.map((o) => o.label),
  });

  it.each(MODES)("%s: «o que aconteceu», «o que eu preciso de você» e os rótulos sem termo proibido e no tamanho", (_mode, config) => {
    for (const kind of KINDS) {
      const f = FIXTURES[kind];
      const d = decideItem(f.item, ctx(config, f.card));
      const s = shown(d);
      for (const t of [s.need, s.happened, ...s.labels]) expect(bannedTermsIn(t).map((h) => h.id), `${kind}: «${t}»`).toEqual([]);
      expect(s.need.trim().length, `${kind}: a pergunta vazia`).toBeGreaterThan(0);
      expect(s.need.length, `${kind}: «${s.need}»`).toBeLessThanOrEqual(200);
      expect(s.happened.length, `${kind}: «${s.happened}»`).toBeLessThanOrEqual(HAPPENED_MAX);
      for (const l of s.labels) expect(l.length, `${kind}: «${l}»`).toBeLessThanOrEqual(OPTION_LABEL_MAX);
    }
  });

  it("todo kind tem o seu nome na linha de contexto", () => {
    for (const kind of KINDS) expect(kindNoun(kind), kind).not.toBe("");
    expect(kindNoun("system-decision")).toBe("Decisão de um agente");
  });

  // o modelo não tem um campo `need` à parte: a pergunta (`ask`) já é escrita inteira para se sustentar sozinha
  it("«o que eu preciso de você» é a pergunta do modelo", () => {
    const d = decideItem(FIXTURES.question.item, ctx(MODES[0][1], FIXTURES.question.card));
    expect(needOf(d)).toBe(d.ask);
  });
});
