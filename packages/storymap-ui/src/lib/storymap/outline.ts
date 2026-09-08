// outline.ts — a DERIVAÇÃO do User Story Map como ÁRVORE (outline), pura e testável.
//
// Por que existe: o mapa era uma GRADE 2D (passos × releases) montada dentro do componente. Ler o
// backbone exigia rolar nos dois eixos ao mesmo tempo, e toda a lógica de agrupamento/filtro/ordem
// morava misturada com JSX e dnd-kit — impossível de testar sem montar React. Aqui a pergunta "o que
// aparece na tela, nesta ordem, com que resumo" vira uma FUNÇÃO: `buildOutline(cards, config, query)
// → OutlineRow[]`. O componente só desenha o que esta função decidiu.
//
// O modelo (Jeff Patton, lido de cima para baixo em vez de da esquerda para a direita):
//
//     Ação            (activity)   ── a espinha dorsal: o que o usuário faz
//       Passo         (step)       ── como a ação se desdobra
//         Story       (story user) ── a fatia de valor
//           Entrega   (story ≠user)── o trabalho técnico que a realiza (dual-track)
//
// A árvore só CRESCE onde se olha (progressive disclosure): cada nível abre pelo clique, e a mesma
// função sabe montar a abertura "até o nível N" (`expansionForLevel`) para o controle "Abrir até".
//
// Regras que esta função herda do modelo — e NÃO reinventa:
//   • backbone = só `storyType: "user"` (isBackboneStory) — o resto é ENTREGA, pendurada no nó que
//     serve (servesTarget = serves ?? parent, groupDeliveryByNode). A mesma atribuição dual-track
//     que a grade fazia nas "prateleiras", agora como FILHO na árvore.
//   • story sem lugar (unplaced/órfã) não some: cai num grupo próprio no fim (nunca inventamos um pai).
//   • ordem = `byOrder` (o campo `order`), a mesma que o arrasto escrevia.

import { byOrder, midpoint } from "./order";
import {
  groupDeliveryByNode,
  isBackboneStory,
  isContainerCard,
  isDeliveryStory,
  isLegacyOrphan,
  isUnplacedStory,
} from "./unplaced";
import { deliveredStatusIds } from "./delivered";
import { entryStatusId, terminalStatusIds } from "./views";
import { STORY_TYPE_BY_ID } from "./frameworks";
import { NO_RELEASE, type BoardConfig, type Card, type CardType } from "./types";

/** Como as stories são organizadas: pelo FLUXO da jornada (backbone) ou por RELEASE (as fatias). */
export type OutlineGrouping = "fluxo" | "release";

/**
 * O estado de uma story na régua da ENTREGA — o que o pontinho à esquerda da linha diz:
 *   • `done`     — está no ar (status `delivered` do board);
 *   • `doing`    — andando (tem status, não é terminal nem a coluna de entrada);
 *   • `open`     — ainda não começou (sem status, ou parada na entrada/triagem);
 *   • `archived` — terminal SEM ter entregue (cancelada/duplicada/arquivada) — sai da conta de progresso.
 */
export type OutlineState = "done" | "doing" | "open" | "archived";

/** A contagem por estado de um ramo — vira o medidor de 3 segmentos ao lado de uma ação/release. */
export interface OutlineProgress {
  done: number;
  doing: number;
  open: number;
  archived: number;
  /** done + doing + open (o arquivado NÃO entra: ele não é trabalho pendente nem entregue) */
  total: number;
}

/** Os filtros transversais do board (os mesmos do header: status · persona · sistema). */
export interface OutlineFilters {
  status: string;
  persona: string;
  system: string;
}

export const EMPTY_OUTLINE_FILTERS: OutlineFilters = { status: "", persona: "", system: "" };

export interface OutlineQuery {
  grouping: OutlineGrouping;
  /** texto livre — casa com título OU id (de qualquer nível) */
  search: string;
  /** id da release, `NO_RELEASE` para "sem release", "" para todas */
  release: string;
  filters: OutlineFilters;
  /** quais chaves estão abertas (`OutlineRow.key`) */
  open: Record<string, boolean>;
}

export const EMPTY_OUTLINE_QUERY: OutlineQuery = {
  grouping: "fluxo",
  search: "",
  release: "",
  filters: EMPTY_OUTLINE_FILTERS,
  open: {},
};

export type OutlineRowKind =
  /** um grupo de release (só no agrupamento `release`) */
  | "release"
  | "activity"
  | "step"
  | "story"
  | "delivery"
  /** o grupo terminal das stories sem lugar no mapa */
  | "orphans"
  /** a linha-convite "+ story em <passo>" (nunca aparece sob filtro) */
  | "add";

/** Onde um "+" nasce — o contexto que viaja para a página de criação. */
export interface OutlineAdd {
  type: CardType;
  parent: string | null;
  release: string | null;
}

export interface OutlineRow {
  kind: OutlineRowKind;
  /** chave ESTÁVEL de expansão (o caminho na árvore) — é o que `open` indexa */
  key: string;
  /** 0 = raiz (ação/release), 1 = passo, 2 = story, 3 = entrega de story */
  depth: number;
  title: string;
  /** o card por trás da linha; null nas linhas sintéticas (grupo de release, órfãs, "+") */
  card: Card | null;
  /** a etiqueta discreta à esquerda ("ação 2 de 6", "passo 3", "Técnica") */
  eyebrow: string | null;
  /**
   * Como a etiqueta se lê — e por isso como se desenha:
   *   • `coord`   uma COORDENADA na árvore ("ação 2 de 6", "passo 3") → monoespaçada, como um número;
   *   • `context` o NOME do ramo de cima ("Conversar com o assistente", quando o agrupamento é por release e
   *               a ação deixou de ser a raiz) → texto normal, porque é prosa;
   *   • `type`    o TIPO do card de entrega ("Técnica", "Bug") → etiqueta em caixa.
   */
  eyebrowKind: "coord" | "context" | "type" | null;
  /** o resumo à direita ("4 passos · 12 stories") */
  summary: string | null;
  expandable: boolean;
  expanded: boolean;
  childCount: number;
  state: OutlineState | null;
  /** nome da release da story (null quando a linha não é uma story, ou não tem release) */
  releaseName: string | null;
  releaseId: string | null;
  /** o medidor do ramo (ação/release/passo); null quando não há o que medir */
  progress: OutlineProgress | null;
  /**
   * O CONTAINER de irmãos desta linha — a chave que agrupa os cards que disputam a mesma ordem.
   * Quem reordena (↑/↓) pergunta por ele: `outlineSiblings(cards, row)`. null = não reordenável
   * (linhas sintéticas, e a entrega, cuja ordem não é narrativa).
   */
  container: string | null;
  /** o contexto de criação quando `kind: "add"` */
  add: OutlineAdd | null;
}

export interface OutlineTotals {
  activities: number;
  steps: number;
  stories: number;
  delivery: number;
  /** stories de backbone já entregues (status `delivered`) */
  done: number;
  /** quantas stories passam pelo filtro/busca corrente */
  matched: number;
}

export interface OutlineReleaseOption {
  id: string;
  name: string;
  count: number;
}

export interface OutlineResult {
  rows: OutlineRow[];
  totals: OutlineTotals;
  /** as releases do board + "sem release", já com a contagem de stories de cada uma */
  releases: OutlineReleaseOption[];
  /** alguma restrição está ativa (busca, release ou filtros)? */
  filtering: boolean;
  /** quantas stories de backbone ficaram sem lugar no mapa */
  orphanCount: number;
}

/** Os ids de status que decidem o `OutlineState` — derivados UMA vez por render. */
interface StateIndex {
  terminal: ReadonlySet<string>;
  delivered: ReadonlySet<string>;
  entry: string | null;
}

function stateIndex(config: BoardConfig): StateIndex {
  return {
    terminal: terminalStatusIds(config),
    delivered: deliveredStatusIds(config),
    entry: entryStatusId(config),
  };
}

/**
 * O estado de UMA story na régua da entrega. `delivered` vence `terminal` de propósito: os dois
 * conjuntos se sobrepõem (delivered ⊂ terminal) e só o primeiro significa "está no ar".
 */
export function cardState(card: Card, idx: StateIndex): OutlineState {
  const st = card.status;
  if (st == null) return "open";
  if (idx.delivered.has(st)) return "done";
  if (idx.terminal.has(st)) return "archived";
  if (st === idx.entry) return "open";
  return "doing";
}

function emptyProgress(): OutlineProgress {
  return { done: 0, doing: 0, open: 0, archived: 0, total: 0 };
}

function addToProgress(p: OutlineProgress, state: OutlineState): void {
  p[state] += 1;
  if (state !== "archived") p.total += 1;
}

function sumProgress(parts: OutlineProgress[]): OutlineProgress {
  const out = emptyProgress();
  for (const p of parts) {
    out.done += p.done;
    out.doing += p.doing;
    out.open += p.open;
    out.archived += p.archived;
    out.total += p.total;
  }
  return out;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** normaliza para busca: minúsculas SEM acento — "conteudo" acha "conteúdo". */
function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// ── Containers de irmãos (a régua da reordenação) ───────────────────────────────────────────────
// O arrasto morreu com a grade; a ordem NÃO. Ela é narrativa (a espinha se lê na ordem de uso), então
// continua editável — por ↑/↓, que funciona no celular e diz exatamente o que vai acontecer. Cada
// linha declara o container dos seus irmãos e `outlineSiblings` devolve a lista COMPLETA (sem filtro:
// reordenar sob busca não pode reescrever a ordem contra os cards escondidos).

export const ROOT_CONTAINER = "root";
export const stepsOf = (activityId: string) => `steps:${activityId}`;
export const storiesOf = (stepId: string) => `stories:${stepId}`;

/** Os irmãos (ordenados) do card de uma linha — a lista COMPLETA, sem filtro nem busca. */
export function outlineSiblings(cards: Card[], container: string): Card[] {
  if (container === ROOT_CONTAINER) {
    return cards.filter((c) => c.type === "activity").sort(byOrder);
  }
  if (container.startsWith("steps:")) {
    const activityId = container.slice("steps:".length);
    return cards.filter((c) => c.type === "step" && c.parent === activityId).sort(byOrder);
  }
  if (container.startsWith("stories:")) {
    const stepId = container.slice("stories:".length);
    return cards.filter((c) => isBackboneStory(c) && c.parent === stepId).sort(byOrder);
  }
  return [];
}

/**
 * O `order` que leva `cardId` UMA posição na direção pedida dentro do container — ou null quando o
 * card já é o primeiro/último (o botão fica desabilitado). Pura: quem chama grava com `moveCardAction`.
 */
export function reorderTarget(
  cards: Card[],
  container: string,
  cardId: string,
  dir: -1 | 1,
): number | null {
  const siblings = outlineSiblings(cards, container);
  const i = siblings.findIndex((c) => c.id === cardId);
  if (i < 0) return null;
  const j = i + dir;
  if (j < 0 || j >= siblings.length) return null;
  // Trocar de lugar com o vizinho = cair entre ele e o vizinho SEGUINTE naquela direção.
  return dir === -1
    ? midpoint(siblings[j - 1]?.order, siblings[j].order)
    : midpoint(siblings[j].order, siblings[j + 1]?.order);
}

// ── A construção ────────────────────────────────────────────────────────────────────────────────

/**
 * Monta as linhas visíveis do outline.
 *
 * Contrato de FILTRO (o que some e o que fica):
 *   • busca/filtros ATIVOS ⇒ um ramo sem nenhuma story que passe DESAPARECE (não faz sentido rolar
 *     por ações vazias procurando a que casou) e tudo que sobrou abre sozinho — a busca não pode
 *     exigir cliques para revelar o que ela mesma achou;
 *   • sem restrição ⇒ o mapa inteiro aparece, inclusive passo sem story (é ali que se convida a criar).
 */
export function buildOutline(cards: Card[], config: BoardConfig, query: OutlineQuery): OutlineResult {
  const idx = stateIndex(config);
  const q = fold(query.search.trim());
  const searching = q.length > 0;
  const hasFieldFilter = !!(query.filters.status || query.filters.persona || query.filters.system);
  const releaseFilter = query.release;
  const filtering = searching || hasFieldFilter || !!releaseFilter;

  const matchesFields = (c: Card) => {
    if (query.filters.status && c.status !== query.filters.status) return false;
    if (query.filters.persona && !c.personas.includes(query.filters.persona)) return false;
    if (query.filters.system && !c.systems.includes(query.filters.system)) return false;
    if (releaseFilter) {
      const rel = c.release ?? NO_RELEASE;
      if (rel !== releaseFilter) return false;
    }
    return true;
  };
  const matchesText = (c: Card) => !searching || fold(c.title).includes(q) || fold(c.id).includes(q);
  const keepStory = (c: Card) => matchesFields(c) && matchesText(c);

  const activities = cards.filter((c) => c.type === "activity").sort(byOrder);
  const stepsByActivity = new Map<string, Card[]>();
  for (const c of cards) {
    if (c.type !== "step" || !c.parent) continue;
    const list = stepsByActivity.get(c.parent);
    if (list) list.push(c);
    else stepsByActivity.set(c.parent, [c]);
  }
  for (const list of stepsByActivity.values()) list.sort(byOrder);

  const storiesByStep = new Map<string, Card[]>();
  for (const c of cards) {
    if (!isBackboneStory(c) || !c.parent) continue;
    const list = storiesByStep.get(c.parent);
    if (list) list.push(c);
    else storiesByStep.set(c.parent, [c]);
  }
  for (const list of storiesByStep.values()) list.sort(byOrder);

  // Entregas (dual-track): agrupadas pelo nó que SERVEM. Passam pelos filtros de campo, mas a busca
  // textual de uma entrega é herdada do pai que casou — senão abrir uma story achada mostraria uma
  // lista de filhos misteriosamente vazia.
  const deliveryByNode = groupDeliveryByNode(cards, matchesFields);
  for (const list of deliveryByNode.values()) list.sort(byOrder);

  const totals: OutlineTotals = {
    activities: activities.length,
    steps: 0,
    stories: 0,
    delivery: 0,
    done: 0,
    matched: 0,
  };
  for (const c of cards) {
    if (c.type === "step") totals.steps += 1;
    else if (isBackboneStory(c)) {
      totals.stories += 1;
      if (cardState(c, idx) === "done") totals.done += 1;
      if (keepStory(c)) totals.matched += 1;
    } else if (isDeliveryStory(c)) totals.delivery += 1;
  }

  const rows: OutlineRow[] = [];
  // Sob QUALQUER restrição ativa a árvore vem aberta: o filtro já escolheu o que sobra, e obrigar a
  // clicar para revelar o que ele mesmo achou é o pior dos dois mundos (poda E esconde).
  const isOpen = (key: string) => (filtering ? true : !!query.open[key]);

  /** As linhas de UMA story (a story + as entregas dela quando aberta). */
  const pushStory = (story: Card, parentKey: string, depth: number, storyMatched: boolean) => {
    const key = `${parentKey}/y:${story.id}`;
    const children = (deliveryByNode.get(story.id) ?? []).filter(
      (d) => storyMatched || matchesText(d),
    );
    const expanded = children.length > 0 && isOpen(key);
    rows.push({
      kind: "story",
      key,
      depth,
      title: story.title,
      card: story,
      eyebrow: null,
      eyebrowKind: null,
      summary: children.length ? plural(children.length, "entrega", "entregas") : null,
      expandable: children.length > 0,
      expanded,
      childCount: children.length,
      state: cardState(story, idx),
      releaseId: story.release ?? null,
      releaseName: releaseNameOf(config, story.release ?? null),
      progress: null,
      container: story.parent ? storiesOf(story.parent) : null,
      add: null,
    });
    if (!expanded) return;
    for (const d of children) pushDelivery(d, key, depth + 1);
  };

  const pushDelivery = (card: Card, parentKey: string, depth: number) => {
    rows.push({
      kind: "delivery",
      key: `${parentKey}/d:${card.id}`,
      depth,
      title: card.title,
      card,
      eyebrow: card.storyType ? STORY_TYPE_BY_ID[card.storyType]?.name ?? null : null,
      eyebrowKind: "type",
      summary: null,
      expandable: false,
      expanded: false,
      childCount: 0,
      state: cardState(card, idx),
      releaseId: card.release ?? null,
      releaseName: releaseNameOf(config, card.release ?? null),
      progress: null,
      container: null,
      add: null,
    });
  };

  if (query.grouping === "fluxo") {
    activities.forEach((activity, ai) => {
      const key = `a:${activity.id}`;
      const steps = stepsByActivity.get(activity.id) ?? [];
      const visibleSteps = steps.map((step) => {
        const stories = (storiesByStep.get(step.id) ?? []).filter(keepStory);
        const stepDelivery = (deliveryByNode.get(step.id) ?? []).filter(
          (d) => !searching || matchesText(d) || fold(step.title).includes(q),
        );
        return { step, stories, stepDelivery };
      });
      const nStories = visibleSteps.reduce((n, v) => n + v.stories.length, 0);
      const nDelivery = visibleSteps.reduce((n, v) => n + v.stepDelivery.length, 0);
      const activityMatched = searching && fold(activity.title).includes(q);
      if (filtering && nStories === 0 && nDelivery === 0 && !activityMatched) return;

      // O medidor mede o que a linha CONTA. Sem filtro os dois são o board inteiro; sob filtro,
      // resumo ("1 story") e medidor precisam falar da MESMA população — senão a linha diz dois
      // números sobre conjuntos diferentes e o verde vira mentira.
      const progress = emptyProgress();
      for (const v of visibleSteps) for (const s of v.stories) addToProgress(progress, cardState(s, idx));
      const expanded = steps.length > 0 && isOpen(key);
      rows.push({
        kind: "activity",
        key,
        depth: 0,
        title: activity.title,
        card: activity,
        eyebrow: `ação ${ai + 1} de ${activities.length}`,
        eyebrowKind: "coord",
        summary:
          steps.length === 0
            ? "sem passos"
            : `${plural(steps.length, "passo", "passos")} · ${plural(nStories, "story", "stories")}`,
        expandable: steps.length > 0,
        expanded,
        childCount: steps.length,
        state: null,
        releaseId: null,
        releaseName: null,
        progress,
        container: ROOT_CONTAINER,
        add: null,
      });
      if (!expanded) return;

      visibleSteps.forEach(({ step, stories, stepDelivery }, si) => {
        const stepMatched = searching && fold(step.title).includes(q);
        if (filtering && stories.length === 0 && stepDelivery.length === 0 && !stepMatched && !activityMatched) {
          return;
        }
        const stepKey = `${key}/s:${step.id}`;
        const childCount = stories.length + stepDelivery.length;
        const stepExpanded = childCount > 0 && isOpen(stepKey);
        const stepProgress = emptyProgress();
        for (const s of stories) addToProgress(stepProgress, cardState(s, idx));
        rows.push({
          kind: "step",
          key: stepKey,
          depth: 1,
          title: step.title,
          card: step,
          eyebrow: `passo ${si + 1}`,
          eyebrowKind: "coord",
          summary: childCount
            ? [
                stories.length ? plural(stories.length, "story", "stories") : null,
                stepDelivery.length ? plural(stepDelivery.length, "entrega", "entregas") : null,
              ]
                .filter(Boolean)
                .join(" · ")
            : "sem stories",
          expandable: childCount > 0,
          expanded: stepExpanded,
          childCount,
          state: null,
          releaseId: null,
          releaseName: null,
          progress: stepProgress.total > 0 ? stepProgress : null,
          container: stepsOf(activity.id),
          add: null,
        });
        if (!stepExpanded) return;

        for (const story of stories) pushStory(story, stepKey, 2, !searching || matchesText(story));
        // As entregas que servem o PASSO (e não uma story) — o dual-track que a grade escondia numa
        // prateleira lateral. Aqui elas são filhas do passo, no mesmo nível das stories.
        for (const d of stepDelivery) pushDelivery(d, stepKey, 2);
        if (!filtering) {
          rows.push({
            kind: "add",
            key: `${stepKey}/+`,
            depth: 2,
            title: `story em ${step.title.toLowerCase()}`,
            card: null,
            eyebrow: null,
            eyebrowKind: null,
            summary: null,
            expandable: false,
            expanded: false,
            childCount: 0,
            state: null,
            releaseId: null,
            releaseName: null,
            progress: null,
            container: null,
            add: { type: "story", parent: step.id, release: null },
          });
        }
      });
    });
  } else {
    // ── Agrupamento por RELEASE ────────────────────────────────────────────────────────────────
    // A MESMA árvore, cortada por fatia de entrega: release → (ação › passo) → story. Serve à
    // pergunta oposta à do fluxo — "o que entra no MVP?" em vez de "como o usuário caminha?".
    for (const rel of releaseOptions(config)) {
      const relKey = `r:${rel.id}`;
      const groups: { activity: Card; step: Card; stories: Card[] }[] = [];
      for (const activity of activities) {
        for (const step of stepsByActivity.get(activity.id) ?? []) {
          const stories = (storiesByStep.get(step.id) ?? []).filter(
            (s) => keepStory(s) && (s.release ?? NO_RELEASE) === rel.id,
          );
          if (stories.length) groups.push({ activity, step, stories });
        }
      }
      const n = groups.reduce((acc, g) => acc + g.stories.length, 0);
      if (!n) continue;

      const progress = emptyProgress();
      for (const g of groups) for (const s of g.stories) addToProgress(progress, cardState(s, idx));
      const expanded = isOpen(relKey);
      rows.push({
        kind: "release",
        key: relKey,
        depth: 0,
        title: rel.name,
        card: null,
        eyebrow: "release",
        eyebrowKind: "coord",
        summary: `${plural(n, "story", "stories")} · ${plural(groups.length, "passo", "passos")}`,
        expandable: true,
        expanded,
        childCount: groups.length,
        state: null,
        releaseId: rel.id === NO_RELEASE ? null : rel.id,
        releaseName: rel.name,
        progress,
        container: null,
        add: null,
      });
      if (!expanded) continue;

      for (const g of groups) {
        const stepKey = `${relKey}/s:${g.step.id}`;
        const stepExpanded = isOpen(stepKey);
        rows.push({
          kind: "step",
          key: stepKey,
          depth: 1,
          title: g.step.title,
          card: g.step,
          eyebrow: g.activity.title,
          eyebrowKind: "context",
          summary: plural(g.stories.length, "story", "stories"),
          expandable: true,
          expanded: stepExpanded,
          childCount: g.stories.length,
          state: null,
          releaseId: null,
          releaseName: null,
          progress: null,
          container: null,
          add: null,
        });
        if (!stepExpanded) continue;
        for (const story of g.stories) pushStory(story, stepKey, 2, !searching || matchesText(story));
      }
    }
  }

  // ── Sem lugar no mapa ─────────────────────────────────────────────────────────────────────────
  // Story sem lugar (unplaced/legado) não tem ramo onde morar — e sumir com ela seria perder
  // trabalho de vista. Ela vira um grupo no FIM, com o convite implícito: abra o card e escolha o
  // passo.
  //
  // Só o que AINDA DEVE um lugar: card TERMINAL (concluído, cancelado, arquivado) sai — um órfão já
  // encerrado é história, não dívida, e é a MAIORIA num board maduro (74 dos 111 no board do próprio
  // AgileHarness). Um grupo que soma o passado transforma um convite acionável num montante que
  // ninguém vai atacar. Mesma régua do lint de placement-debt (unplaced.ts), sem a isenção de
  // triagem: um card na Triagem SEM lugar é justamente o que o operador precisa ver aqui.
  const orphans = cards
    .filter(
      (c) =>
        (isUnplacedStory(c) || isLegacyOrphan(c)) &&
        !isContainerCard(c) &&
        !(c.status != null && idx.terminal.has(c.status)) &&
        keepStory(c),
    )
    .sort(byOrder);
  if (orphans.length) {
    const key = "orphans";
    const expanded = isOpen(key);
    const progress = emptyProgress();
    for (const c of orphans) addToProgress(progress, cardState(c, idx));
    rows.push({
      kind: "orphans",
      key,
      depth: 0,
      title: "Sem lugar no mapa",
      card: null,
      eyebrow: "pendente",
      eyebrowKind: "coord",
      summary: plural(orphans.length, "story", "stories"),
      expandable: true,
      expanded,
      childCount: orphans.length,
      state: null,
      releaseId: null,
      releaseName: null,
      progress,
      container: null,
      add: null,
    });
    if (expanded) {
      for (const c of orphans) {
        rows.push({
          kind: isBackboneStory(c) ? "story" : "delivery",
          key: `orphans/y:${c.id}`,
          depth: 1,
          title: c.title,
          card: c,
          eyebrow: !isBackboneStory(c) && c.storyType ? STORY_TYPE_BY_ID[c.storyType]?.name ?? null : null,
          eyebrowKind: isBackboneStory(c) ? null : "type",
          summary: null,
          expandable: false,
          expanded: false,
          childCount: 0,
          state: cardState(c, idx),
          releaseId: c.release ?? null,
          releaseName: releaseNameOf(config, c.release ?? null),
          progress: null,
          container: null,
          add: null,
        });
      }
    }
  }

  return {
    rows,
    totals,
    releases: releaseOptions(config, cards),
    filtering,
    orphanCount: orphans.length,
  };
}

function releaseNameOf(config: BoardConfig, releaseId: string | null): string | null {
  if (!releaseId) return null;
  return config.releases.find((r) => r.id === releaseId)?.name ?? releaseId;
}

/**
 * As releases do board na ordem declarada + a fatia "Sem release" no fim (`NO_RELEASE`). Com `cards`,
 * cada uma vem com a contagem de stories de backbone — o número que o seletor de release mostra.
 */
export function releaseOptions(config: BoardConfig, cards?: Card[]): OutlineReleaseOption[] {
  const count = (id: string) =>
    cards ? cards.filter((c) => isBackboneStory(c) && (c.release ?? NO_RELEASE) === id).length : 0;
  const out = [...config.releases]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((r) => ({ id: r.id, name: r.name, count: count(r.id) }));
  out.push({ id: NO_RELEASE, name: "Sem release", count: count(NO_RELEASE) });
  return out;
}

/**
 * A abertura "até o nível N" — o que o controle `Abrir até (1) Ações (2) Passos (3) Stories` grava.
 * Nível 1 fecha tudo (só as raízes aparecem); 2 abre as raízes; 3 abre também os passos. As chaves
 * seguem EXATAMENTE o formato que `buildOutline` produz — daí ela viver aqui, ao lado da construção.
 */
export function expansionForLevel(
  cards: Card[],
  config: BoardConfig,
  grouping: OutlineGrouping,
  level: number,
): Record<string, boolean> {
  const open: Record<string, boolean> = {};
  if (level <= 1) return open;

  const activities = cards.filter((c) => c.type === "activity").sort(byOrder);
  if (grouping === "fluxo") {
    for (const a of activities) {
      open[`a:${a.id}`] = true;
      if (level < 3) continue;
      for (const s of cards.filter((c) => c.type === "step" && c.parent === a.id)) {
        open[`a:${a.id}/s:${s.id}`] = true;
      }
    }
  } else {
    for (const rel of releaseOptions(config)) {
      open[`r:${rel.id}`] = true;
      if (level < 3) continue;
      for (const s of cards.filter((c) => c.type === "step")) {
        open[`r:${rel.id}/s:${s.id}`] = true;
      }
    }
  }
  open.orphans = level >= 3;
  return open;
}
