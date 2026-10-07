// As CLASSES DE DECISÃO — quem decide cada ponto onde o AgileHarness pode parar para um humano. PURA (zero IO).
//
// O operador: "o sistema do AH deve travar somente em decisões de negócios, monetário etc.;
// todo o resto deve seguir o que melhor estiver alinhado às regras de negócio e ao objetivo principal do PRD." Quem
// usa o AH não é técnico: parar numa decisão técnica transfere ao humano algo que ele não sabe julgar.
//
// As classes do DONO são quatro, declaradas no `_base/board.yaml` (`autonomy.ownerClasses`) e espelhadas aqui como
// default — um alvo cujo `_base` é anterior a elas continua parando para dinheiro:
//   money          dinheiro e preço — compromisso de gasto — fornecedor, plano pago, créditos, preço, código de cobrança;
//   brand-voice    falar em nome da marca FORA do produto — redes sociais, e-mail ou push em massa;
//   prd            mudar o PRD e as metas — escopo, apostas, métricas, prazos;
//   personal-data  dados de pessoas — apagar, coletar um dado pessoal novo, mudar o que é público.
// Tudo o mais é TÉCNICO: o sistema decide, com prova, registro e "Desfazer" quando reversível.
//
// O PERFIL (fase 4 — autonomy-profile.ts). O `ultra` virou caixas: `whoDecides` lê, ponto a ponto, a caixa que o
// governa — a pergunta de entrevista/técnica pela `spec`, a escolha de tela pela `design`, «Aprovar entrega» pela
// `delivery` (a exceção do card sobrepõe as três). O resto da régua — as classes do dono, o código de cobrança, a trava
// do núcleo, a governança, os dados de pessoas, o comando travado — NÃO lê o perfil: fica igual com tudo ligado
// (autonomy-profile.test.ts fixa isso caixa por caixa).
//
// O MODO. Só-negócio é o `ultra` — não um modo novo. O dono definiu o que o ultra quer dizer; um segundo
// modo "ultra, mas que ainda pergunta o técnico" seria um botão que um dono leigo não sabe julgar. `human` segue
// byte-idêntico: todo ponto de parada é do dono (`whoDecides` devolve `owner` para qualquer ponto).
//
// Uma régua, `whoDecides`, e todo ponto de parada passa por ela: a pergunta, a revisão da triagem, o gate para
// avançar, a escolha de tela, o pedido de aprovação da matriz de risco, o rascunho de governança, a exclusão de
// dados, o dilema, a publicação que parou pedindo alguém — e, para o Inbox, cada kind de item (`cockpitItemDecision`,
// exaustivo por tipo, SEM atalho por kind: todo caso especial mora num ponto de decisão e passa pela régua).
//
// O INVARIANTE (ciclo de conserto): num board só-negócio, `owner` só sai daqui com uma classe do dono, ou num
// ponto ESTRUTURAL nomeado (a pergunta que o próprio autor declarou do dono, a trava do núcleo, a captura e as amostras
// do dono, a escolha de tela que ele pediu, a publicação cuja causa ainda não tem registro — fail-closed —, a entrega
// parada em «Aprovar entrega» que nenhum ator do sistema vai mover). E, em
// QUALQUER modo, uma falha cuja origem é a FERRAMENTA (runner/failure-origin.ts) ou o mesmo no-op de novo nunca é do
// dono: nenhuma resposta dele muda o desfecho.

import { effectiveAutonomy, effectiveQuestionCategory, isOwnerOnlyQuestion, ownerFloorClass } from "./autonomy";
import { AUTONOMY_BOXES, decisionKeyOfCategory, storyDecides, type StoryDecisionKey } from "./autonomy-profile";
import { MONEY_CLASS, ownerClassLabel, ownerClassesOf } from "./owner-classes";
import { failureOrigin, runDeathRepeats, type FailureOrigin } from "./runner/failure-origin";
import { nextQuestionId } from "./questions";
import type { BoardConfig, Card, CardQuestion, DeployCause, RiskClass } from "./types";

// As classes em si (a lista, o default, o rótulo) moram em owner-classes.ts — um módulo sem dependência que
// autonomy.ts também lê (sem ciclo). Re-exportadas aqui: este é o módulo que os leitores procuram.
export { DEFAULT_OWNER_CLASSES, MONEY_CLASS, ownerClassLabel, ownerClassesOf } from "./owner-classes";
import type { CockpitItem, CockpitItemKind } from "./demands";

/** O motivo da entrega parada em «Aprovar entrega» num board só-negócio (o ponto estrutural do `gate`). */
export const DELIVERY_PARKED =
  "a entrega parou esperando aprovação e ninguém do sistema vai seguir com ela — você aprova ou devolve";

/** Este card roda em só-negócio? (o `ultra` efetivo: a exceção do card, senão o board). PURA. */
export function isBusinessOnly(card: Pick<Card, "autonomyMode"> | null | undefined, config: Pick<BoardConfig, "autonomy"> | null | undefined): boolean {
  return effectiveAutonomy(card, config).mode === "ultra";
}

/** Um ponto onde o AH pode parar para um humano. */
export type DecisionPoint =
  /** uma pergunta de agente no card */
  | { kind: "question"; question: Pick<CardQuestion, "category" | "text" | "context" | "proxy" | "ownerClass" | "classified"> }
  /** um card na quarentena da Triagem: aceitar, descartar ou juntar */
  | { kind: "triage-review" }
  /**
   * o gate / a aprovação para avançar um passo manual ("Aprovar entrega", "Publicar"). `deliveryApproval` = o passo é a
   * aprovação da ENTREGA e o card está parado nele com trabalho pronto (demands.ts GateCockpitItem).
   */
  | { kind: "gate"; deliveryApproval?: boolean }
  /** escolher entre as variantes de tela */
  | { kind: "ui-choice" }
  /** um pedido de aprovação aberto pela matriz de risco */
  | { kind: "approval"; riskClass?: RiskClass }
  /** um rascunho de governança (PRD, metas, canvas, personas, releases) */
  | { kind: "governance" }
  /** a exclusão irreversível de dados de produção */
  | { kind: "data-deletion" }
  /** um comando que a trava dura do host recusa a agentes, proposto para o dono aprovar (execução aprovada) */
  | { kind: "locked-exec" }
  /** um dilema técnico que afeta o produto (ex.: cortar escopo para cumprir uma data) */
  | { kind: "dilemma"; ownerClass?: string | null }
  /**
   * um travamento: execução que morreu, conflito, publicação ou efeito que falhou. `failure` = o que se sabe da morte
   * de um run (a origem pela régua de failure-origin.ts; `repeatedNoOp` = o mesmo no-op — mesmo passo, mesmo tipo — pela 2ª vez seguida ou mais).
   */
  | { kind: "recovery"; failure?: { origin: FailureOrigin; label?: string | null; repeatedNoOp?: boolean } }
  /**
   * a publicação parou PEDINDO alguém (o deploy declarado saiu com «needs-human»). `cause` = a causa estruturada do
   * finding (types.ts DeployCause); null = um finding anterior a ela (legado, até o backfill) — fail-closed: do dono.
   */
  | { kind: "deploy-hold"; cause: Pick<DeployCause, "ownerClass" | "decider" | "rules" | "units"> | null }
  /** a proposta da captura inteligente — o texto do próprio dono virando cards */
  | { kind: "capture-proposal" }
  /** a amostra do que o sistema decidiu em nome do dono — é para um revisor independente, não para o dono (ainda sem revisor: fica à vista em «Os agentes estão cuidando») */
  | { kind: "audit" }
  /**
   * Fase 3 — uma ALAVANCA DO OPERADOR que nenhum ator do sistema tem: publicar por cima da guarda de concorrência, soltar a
   * trava da cota, parar o condutor de um card que ninguém assumiu. As server actions recusam qualquer outro chamador, então
   * o ponto é do dono em qualquer modo. `why` é o porquê em palavras de dono.
   */
  | { kind: "operator"; why: string }
  /**
   * uma MUDANÇA DE CÓDIGO prestes a seguir (o diff de uma entrega): `billing` = toca o código de cobrança ou pagamento
   * (sempre do dono, em qualquer modo); `existingTests` = altera ou apaga um teste que já existia (vai a um revisor de
   * diff independente — a categoria `guardrail` —, nunca ao procurador; até esse revisor existir, ao dono). Os
   * detectores puros estão abaixo ({@link codeChangePoint}); o merge train os aplica ao diff de cada card
   * ({@link withCodeChangeMarks}).
   */
  | { kind: "code-change"; billing?: boolean; existingTests?: boolean; agentConfig?: boolean };

export type DecisionPointKind = DecisionPoint["kind"];

/**
 * O veredito: quem decide e por quê. `ownerClass` nomeia a classe de negócio quando há uma; `null` com `owner` é o
 * dono por outra razão (modo human, trava do núcleo, o pedido explícito dele) — e com `system`, é técnico.
 */
export interface DecisionVerdict {
  decider: "owner" | "system";
  ownerClass: string | null;
  reason: string;
}

const owner = (ownerClass: string | null, reason: string): DecisionVerdict => ({ decider: "owner", ownerClass, reason });
const system = (reason: string): DecisionVerdict => ({ decider: "system", ownerClass: null, reason });

/** A classe de dono que o CARD toca (a marca de um juiz), ou null. PURA. */
export function cardOwnerClass(card: Pick<Card, "businessClasses"> | null | undefined): string | null {
  return card?.businessClasses?.ids.find((id) => id.trim()) ?? null;
}

/** O porquê de uma escolha de tela que o dono pediu para ver. */
const UI_ASKED = "você pediu para ver as opções de tela deste card";

/**
 * O porquê de uma mudança em teste existente. A regra do dono: vai a um revisor de diff independente, nunca ao
 * procurador nem a quem perguntou. O revisor existe desde a fase 6 (runner/critics.ts `reviewGuardrailQuestion`): o
 * SERVIÇO o lança sobre a pergunta aberta e, aprovando, responde por ele. O PONTO segue marcado como do dono — é o
 * desfecho seguro enquanto o revisor não respondeu e o que vale quando ele reprova (ou em modo humano).
 */
const GUARDRAIL_REASON =
  "mudar um teste existente: em só-negócio o revisor de diff independente lê o diff primeiro; se ele reprovar (ou em modo humano), é seu — nunca do procurador nem de quem perguntou";

/** O porquê da configuração dos agentes: as regras que os PRÓXIMOS agentes leem e o que eles podem chamar. */
const AGENT_CONFIG_REASON =
  "muda as regras ou os poderes dos agentes (skills, instruções, agentes, comandos, hooks, MCP, permissões, a configuração do serviço, as receitas e as classes de deploy) — um agente não reescreve a regra que o próximo vai obedecer; é sempre seu, sem revisor no meio";

/** O porquê do código de cobrança: dinheiro, em qualquer modo. */
const BILLING_REASON = "mexe no código de cobrança ou de pagamento — sempre seu, em qualquer modo";

/** O porquê de uma caixa do perfil desligada: o dono deixou esta decisão com ele. */
function boxOffReason(key: StoryDecisionKey): string {
  const box = AUTONOMY_BOXES.find((b) => b.key === key)?.label ?? key;
  return `a autonomia do board deixa com você: «${box}»`;
}

/** O marcador que o condutor põe numa pergunta sempre-humana (o mesmo que autonomy.ts lê). */
const OWNER_MARKER = /^\s*\[humano\]/i;

/** As classes de risco que seguem humanas em TODO modo — a trava do núcleo (NEVER_AUTO), não uma classe de negócio. */
const KERNEL_HUMAN_RISK: ReadonlySet<RiskClass> = new Set<RiskClass>(["run-free", "destructive"]);

/**
 * A classe de uma PERGUNTA em só-negócio: do dono (com a classe) ou técnica. O piso vem primeiro e só empurra para
 * o dono — a categoria `money`, o marcador `[humano]`, as palavras de dinheiro, e a pergunta que o proxy devolveu ou
 * que o dono reabriu. Sem categoria = do dono até alguém classificá-la (fail-closed). PURA.
 */
export function questionVerdict(
  question: Pick<CardQuestion, "category" | "text" | "context" | "proxy" | "ownerClass" | "classified">,
  config?: Pick<BoardConfig, "autonomy"> | null,
): DecisionVerdict {
  if (question.proxy?.auditOutcome === "reopened") return owner(null, "você reabriu a resposta do proxy — a pergunta é sua agora");
  if (question.proxy?.declined) {
    // A classe que o PROXY apontou ao recusar; sem ela, a que a pergunta já carregava (de quem perguntou ou do
    // classificador). Antes saía sempre sem classe, e o Inbox não sabia dizer POR QUE a pergunta era do dono.
    const cls = question.proxy.ownerClass ?? question.ownerClass ?? question.classified?.ownerClass ?? null;
    return owner(cls, cls ? `o proxy devolveu esta pergunta a você: toca «${ownerClassLabel(cls, config)}»` : "o proxy devolveu esta pergunta a você");
  }
  if (question.category === "money") return owner(MONEY_CLASS, "toca em dinheiro — sempre sua");
  if (OWNER_MARKER.test(question.text ?? "") || OWNER_MARKER.test(question.context ?? "")) {
    return owner(null, "o agente marcou a pergunta como sua ([humano])");
  }
  // o que sobra do piso (autonomy.ts isOwnerOnlyQuestion) são as palavras de dinheiro no texto/contexto
  if (isOwnerOnlyQuestion(question)) return owner(MONEY_CLASS, "fala de gasto, fornecedor ou preço — sempre sua");
  // o piso da MARCA (autonomy.ts ownerFloorClass), quando o board declara a classe — vale mesmo com categoria declarada
  const floor = ownerFloorClass(question, config);
  if (floor) return owner(floor, `fala em nome da marca fora do produto («${ownerClassLabel(floor, config)}») — sempre sua`);
  // a categoria EFETIVA: a de quem perguntou, senão o veredito do classificador
  switch (effectiveQuestionCategory(question)) {
    case "owner": {
      const cls = question.ownerClass ?? question.classified?.ownerClass ?? null;
      const why = question.category ? "" : question.classified?.reason ? `: ${question.classified.reason}` : "";
      return owner(cls, `decisão de negócio${cls ? ` («${ownerClassLabel(cls, config)}»)` : ""} — sua${why}`);
    }
    case "technical":
      return system(
        question.category
          ? "pergunta técnica: o proxy decide pela meta principal do PRD e registra as premissas"
          : `classificada como técnica${question.classified?.reason ? ` (${question.classified.reason})` : ""}: o proxy decide pelo PRD`,
      );
    case "interview":
      return system("pergunta de produto: o proxy responde pelo PRD, pelas personas e pelas suas decisões passadas");
    case "ui-choice":
      return system("escolha de tela: o sistema escolhe pelo guia de estilo e registra as alternativas");
    case "delivery":
      return system("aprovação de entrega: o verificador decide pela prova, e uma amostra volta para você");
    case "guardrail":
      return owner(null, GUARDRAIL_REASON);
    default:
      return owner(null, "pergunta ainda sem classe — fica com você até ser classificada");
  }
}

/**
 * QUEM DECIDE este ponto de parada, para este card neste board. PURA — a régua única.
 *
 * Modo `human` (o legado, e todo board sem o bloco): o dono, em todo ponto.
 * Só-negócio (`ultra`): o dono só quando o ponto É de uma classe dele (governança = PRD; exclusão de dados = dados
 * de pessoas), quando o card TOCA uma classe dele (a marca de um juiz), quando a trava do núcleo o exige (shell,
 * irreversível) ou quando ele pediu (a captura dele, as amostras). Todo o resto: o sistema, com prova e registro.
 */
export function whoDecides(
  point: DecisionPoint,
  card: Pick<Card, "autonomyMode" | "businessClasses" | "ownerReviewsUi"> | null | undefined,
  config: Pick<BoardConfig, "autonomy"> | null | undefined,
): DecisionVerdict {
  // ANTES do modo, e por isso em QUALQUER modo: a falha da ferramenta e o no-op repetido não têm resposta do dono que
  // mude o desfecho. Num caso real, um board em modo humano com o sandbox recusando todo Bash —
  // o dono apertou «Tentar de novo» várias vezes e o run morreu sempre igual. O conserto mora no host, não no card.
  // `tool` = uma ASSINATURA conhecida do defeito (failure-origin.ts); o ambiente que falhou sem assinatura (OOM, API
  // sobrecarregada, teto de max-turns) segue a régua do modo. Os motivos dizem o FATO e não prometem um ator: num board
  // humano ninguém tenta de novo sozinho, e o Inbox diz isso (inbox/decision.ts).
  if (point.kind === "recovery" && point.failure?.origin === "tool") {
    return system(
      `falha da ferramenta${point.failure.label ? ` — ${point.failure.label}` : ""}. O conserto é no host, não neste card: ` +
        "tentar de novo dá o mesmo desfecho enquanto ele não for feito",
    );
  }
  if (point.kind === "recovery" && point.failure?.repeatedNoOp) {
    return system("o run deste passo concluiu «não há trabalho» de novo, seguidas vezes: tentar de novo do mesmo jeito não muda o desfecho");
  }
  // O código de cobrança é DINHEIRO em qualquer modo e com qualquer caixa ligada: antes do modo, de propósito. A
  // mudança em teste existente também (o revisor de diff que a julgaria ainda não existe — GUARDRAIL_REASON).
  if (point.kind === "code-change" && point.billing) return owner(MONEY_CLASS, BILLING_REASON);
  if (point.kind === "code-change" && point.existingTests) return owner(null, GUARDRAIL_REASON);
  if (point.kind === "code-change" && point.agentConfig) return owner(null, AGENT_CONFIG_REASON);
  if (!isBusinessOnly(card, config)) return owner(null, "board em modo humano — você decide cada passo");
  // As caixas NÃO vazam: «só-negócio» é derivado de QUALQUER caixa de story ligada, mas cada ponto é julgado pela caixa
  // que o governa. O que nenhuma caixa nomeia (a triagem, a aprovação técnica, o dilema, o travamento, a publicação
  // parada por lacuna, o passo técnico e o «vai» do plano) é do «técnico» — a caixa `spec` (o crítico aprova o plano).
  // Desligada, esses pontos voltam ao veredito humano: um board só com «escolher a tela» não deixa agente nenhum passar
  // pela parada do plano.
  const technicalOff = !storyDecides(card, config, "spec");
  const touched = cardOwnerClass(card);
  const touchedReason = touched ? `o card toca «${ownerClassLabel(touched, config)}»${card?.businessClasses?.reason ? `: ${card.businessClasses.reason}` : ""}` : "";
  // «Quero ver as opções de tela» (card-opt-ins.ts): a escolha de tela deste card é do dono — pedida por ele.
  const uiAsked = card?.ownerReviewsUi === true;
  switch (point.kind) {
    case "question": {
      const category = effectiveQuestionCategory(point.question);
      if (uiAsked && category === "ui-choice") return owner(null, UI_ASKED);
      const verdict = questionVerdict(point.question, config);
      if (verdict.decider === "owner") return verdict;
      // O card TOCA uma classe do dono: o procurador não decide nele (autonomy.ts proxyRefusal) — a mesma régua aqui,
      // senão a pergunta ficaria «do sistema» sem ninguém do sistema para respondê-la.
      if (touched && category !== "guardrail") return owner(touched, touchedReason);
      // O ESCOPO do perfil: a caixa que governa a categoria desligada ⇒ do dono.
      const key = decisionKeyOfCategory(category);
      if (key && !storyDecides(card, config, key)) return owner(null, boxOffReason(key));
      return verdict;
    }
    case "triage-review":
      if (touched) return owner(touched, touchedReason);
      if (technicalOff) return owner(null, boxOffReason("spec"));
      return system("o juiz da triagem aceita, descarta ou junta pelo PRD");
    case "gate":
      if (touched) return owner(touched, touchedReason);
      // Ponto ESTRUTURAL: em só-negócio o condutor atravessa «Aprovar entrega» sozinho, com a prova. Um card PARADO
      // ali, com trabalho pronto, é uma entrega que nenhum ator do sistema vai mover — deixá-la em «o sistema decide»
      // a esconderia do dono para sempre. Fica com o dono: aprovar ou devolver.
      // Com a caixa «aprovar a entrega» desligada, ninguém do sistema atravessa (travado em código: owner-waiting.ts).
      if (point.deliveryApproval) return owner(null, storyDecides(card, config, "delivery") ? DELIVERY_PARKED : boxOffReason("delivery"));
      // o «vai» do plano e todo passo técnico: a caixa `spec` (o crítico aprova o plano × você aprova o plano)
      if (technicalOff) return owner(null, boxOffReason("spec"));
      return system("passo técnico: o pipeline, o verificador e o condutor avançam com prova");
    case "ui-choice":
      if (uiAsked) return owner(null, UI_ASKED);
      if (!storyDecides(card, config, "design")) return owner(null, boxOffReason("design"));
      return system("escolha de tela: o especialista de UX ou o orquestrador escolhe e registra as alternativas");
    case "approval":
      if (point.riskClass && KERNEL_HUMAN_RISK.has(point.riskClass)) {
        return owner(null, "shell livre ou ação irreversível — trava do núcleo, humana em qualquer modo");
      }
      if (touched) return owner(touched, touchedReason);
      if (technicalOff) return owner(null, boxOffReason("spec"));
      return system("ação técnica: um revisor independente aprova, com registro");
    case "governance":
      return owner("prd", "mudar o PRD, as metas ou a estratégia do board é decisão sua");
    case "data-deletion":
      return owner("personal-data", "apagar dados de pessoas é decisão sua");
    case "locked-exec":
      return owner(null, "um comando que a trava do servidor proíbe a agentes — só roda com o seu clique, em qualquer modo");
    case "dilemma":
      if (point.ownerClass) return owner(point.ownerClass, `o dilema toca «${ownerClassLabel(point.ownerClass, config)}»`);
      if (technicalOff) return owner(null, boxOffReason("spec"));
      return system("dilema técnico: o responsável decide pela meta principal do PRD e registra como desfazer");
    case "recovery":
      if (technicalOff) return owner(null, boxOffReason("spec"));
      return system("travamento técnico: o Jido tenta de novo com limite e, se repetir, abre um card de conserto");
    case "deploy-hold": {
      const verdict = deployHoldVerdict(point.cause, config);
      return verdict.decider === "system" && technicalOff ? owner(null, boxOffReason("spec")) : verdict;
    }
    case "capture-proposal":
      return owner(null, "a captura é o seu texto — você confirma o que ele vira");
    case "audit":
      // decisão do dono (06/10): a amostra é para revisores independentes (IA), nunca para o dono. Esse revisor ainda não
      // roda — o texto não o promete (a amostra fica à vista no Inbox, marcada «ninguém está revisando»).
      return system("amostra do que o sistema decidiu em seu nome: é para um revisor independente, não para você — e ele ainda não roda");
    case "operator":
      return owner(null, point.why);
    case "code-change":
      if (touched) return owner(touched, touchedReason);
      if (technicalOff) return owner(null, boxOffReason("spec"));
      return system("mudança de código: o revisor e a suíte decidem, com prova");
  }
}

// ── os detectores da mudança de código (puros — o chamador passa a lista de arquivos do diff) ─────────────────────

/** Caminhos de código de cobrança/pagamento — genéricos, sem fornecedor nem produto (o alvo é de quem o usa). */
const BILLING_PATH =
  /(^|[/._-])(billing|payments?|pagamentos?|cobrancas?|cobranças?|checkout|invoices?|faturas?|faturamento|subscriptions?|assinaturas?|pricing|precos?|preços?)([/._-]|$)/i;

/** Um arquivo de teste (vitest/jest/playwright/pytest/go…). */
const TEST_PATH = /(^|\/)(tests?|__tests__|e2e|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/i;

/**
 * A configuração dos AGENTES no repositório-alvo: as skills (as regras do condutor moram em
 * `.claude/skills/harness-conductor/ref/`, lidas do worktree), as definições de agente e de comando, os hooks, o MCP do
 * projeto e as permissões — e as REGRAS que eles leem a cada sessão: todo `CLAUDE.md` (o da raiz e os de pacote) e as
 * regras importadas de `.claude/rules/`. Mais o que o SERVIÇO executa ou obedece em nome deles: `storymap/settings.yaml`
 * (os comandos das fontes de sinal, a matriz de risco do escopo repo, os níveis dos tokens), as receitas do `justfile`
 * que a trava do host deixa passar, as classes de deploy e os hooks de git. Um diff que mexe aqui reescreve o que os
 * próximos agentes obedecem — e o worktree deles é cortado de `stage`, onde o código já aterrissou.
 */
const AGENT_CONFIG_PATH =
  /(^|\/)\.claude\/(skills|agents|commands|hooks|rules)\/|(^|\/)\.claude\/settings[^/]*\.json$|(^|\/)\.mcp\.json$|(^|\/)CLAUDE\.md$|(^|\/)AGENTS\.md$|^storymap\/settings\.ya?ml$|(^|\/)[Jj]ustfile$|(^|\/)\.justfile$|^scripts\/deploy\/classes\/|^scripts\/git-hooks\/|(^|\/)\.githooks\//;

/** Uma linha do diff: o caminho e o status do git (A adicionado, M alterado, D apagado, R renomeado). */
export interface DiffFile {
  path: string;
  status: "A" | "M" | "D" | "R" | string;
}

/** O diff toca o código de cobrança ou pagamento? PURA. */
export function touchesBillingCode(files: ReadonlyArray<Pick<DiffFile, "path">>): boolean {
  return files.some((f) => BILLING_PATH.test(f.path));
}

/** O diff ALTERA, APAGA ou RENOMEIA um teste que já existia (adicionar teste novo não conta)? PURA. */
export function changesExistingTests(files: ReadonlyArray<DiffFile>): boolean {
  return files.some((f) => f.status !== "A" && TEST_PATH.test(f.path));
}

/** O diff cria, altera ou apaga a configuração dos agentes (skills, agentes, comandos, hooks, MCP, permissões)? PURA. */
export function changesAgentConfig(files: ReadonlyArray<Pick<DiffFile, "path">>): boolean {
  return files.some((f) => AGENT_CONFIG_PATH.test(f.path));
}

/** O ponto de decisão de um diff. PURA. */
export function codeChangePoint(files: ReadonlyArray<DiffFile>): Extract<DecisionPoint, { kind: "code-change" }> {
  return {
    kind: "code-change",
    billing: touchesBillingCode(files),
    existingTests: changesExistingTests(files),
    agentConfig: changesAgentConfig(files),
  };
}

/** O `git diff --name-status --no-renames` em linhas do diff (status de uma letra, caminho). PURA. */
export function parseNameStatus(stdout: string): DiffFile[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [status, ...rest] = line.split("\t");
      const p = rest[rest.length - 1]?.trim();
      return status && p ? [{ path: p, status: status.trim().charAt(0) }] : [];
    });
}

/** Quem marca o card a partir do diff (o merge train) — a autoria da marca e da pergunta. */
const CODE_CHANGE_MARKER = "merge-train";

/**
 * O card com as marcas que o DIFF do código dele pede (o ponto `code-change`), ou null quando já está marcado ou o
 * diff não pede nada. PURA — o merge train a chama depois de o código aterrissar em `stage`:
 *   • toca cobrança/pagamento ⇒ o card passa a tocar a classe «dinheiro» (`businessClasses`): toda parada dele vira do
 *     dono, e a publicação espera o dono (owner-waiting.ts ownerPublishHold);
 *   • altera/apaga um teste que já existia ⇒ uma pergunta ABERTA `guardrail` ao dono (até existir o revisor de diff),
 *     uma por run (idempotente pelo contexto);
 *   • mexe na configuração dos agentes (skills, agentes, comandos, hooks, MCP, permissões) ⇒ outra pergunta `guardrail`,
 *     também uma por run.
 */
export function withCodeChangeMarks<T extends Pick<Card, "businessClasses" | "questions">>(card: T, files: ReadonlyArray<DiffFile>, runId: string, at: string): T | null {
  const point = codeChangePoint(files);
  let next: T = card;
  const list = (paths: string[]) => `${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ` e mais ${paths.length - 3}` : ""}`;
  if (point.billing && !card.businessClasses?.ids.includes(MONEY_CLASS)) {
    const reason = `o código deste card mexe em cobrança ou pagamento (${list(files.filter((f) => BILLING_PATH.test(f.path)).map((f) => f.path))})`;
    next = {
      ...next,
      businessClasses: {
        ids: [...(card.businessClasses?.ids ?? []), MONEY_CLASS],
        reason: card.businessClasses?.reason ? `${card.businessClasses.reason}; ${reason}` : reason,
        by: CODE_CHANGE_MARKER,
        at,
      },
    };
  }
  const tag = `(run ${runId})`;
  if (point.existingTests && !(card.questions ?? []).some((q) => q.category === "guardrail" && q.context?.includes(tag))) {
    const tests = files.filter((f) => f.status !== "A" && TEST_PATH.test(f.path)).map((f) => f.path);
    const questions = card.questions ?? [];
    next = {
      ...next,
      questions: [
        ...questions,
        {
          id: nextQuestionId(questions),
          text: "Este card mudou testes que já existiam. Aprova a mudança?",
          status: "open" as const,
          askedBy: CODE_CHANGE_MARKER,
          askedAt: at.slice(0, 10),
          category: "guardrail" as const,
          context: `Testes alterados ou apagados: ${list(tests)} ${tag}. Em só-negócio o revisor de diff independente lê o diff primeiro; reprovado (ou em modo humano), é seu.`,
        },
      ],
    };
  }
  const agentTag = `(run ${runId} · agentes)`;
  if (point.agentConfig && !(next.questions ?? []).some((q) => q.category === "guardrail" && q.context?.includes(agentTag))) {
    const paths = files.filter((f) => AGENT_CONFIG_PATH.test(f.path)).map((f) => f.path);
    const questions = next.questions ?? [];
    next = {
      ...next,
      questions: [
        ...questions,
        {
          id: nextQuestionId(questions),
          text: "Este card mudou a configuração dos agentes (skills, agentes, comandos, hooks, MCP ou permissões). Aprova a mudança?",
          status: "open" as const,
          askedBy: CODE_CHANGE_MARKER,
          askedAt: at.slice(0, 10),
          category: "guardrail" as const,
          context: `Arquivos: ${list(paths)} ${agentTag}. Um agente não reescreve a regra que o próximo agente vai obedecer: é sempre seu — nenhum revisor responde por você aqui.`,
        },
      ],
    };
  }
  return next === card ? null : next;
}

/**
 * A publicação que parou pedindo alguém, em só-negócio. Só é do dono quando a CAUSA carrega uma classe dele (a regra
 * do plano mapeada em `autonomy.deployRuleClasses` — pagamento, gasto de API…). Sem classe é uma lacuna de
 * ferramenta/config (ex.: a unidade fora de toda classe de deploy, «human-only by construction»): o conserto é dar uma
 * classe a ela — o motivo diz isso e não promete quem o faz (o retry/card de conserto é da recuperação, WP2). Num caso real, boa parte dos «Precisa de você» de um board
 * vinha de uma regra estrutural («unidade sem classe») — nenhuma decisão de negócio, e as opções eram só «como publicar»
 * e «pedir ao Jido». Sem a causa registrada (finding anterior a ela) ou com a causa que o plano declarou do dono sem
 * classe nomeada ⇒ do dono: fail-closed até o sistema classificá-la. PURA.
 */
function deployHoldVerdict(cause: Pick<DeployCause, "ownerClass" | "decider" | "rules" | "units"> | null, config: Pick<BoardConfig, "autonomy"> | null | undefined): DecisionVerdict {
  if (!cause) return owner(null, "a publicação parou pedindo você e a causa ainda não está registrada — fica com você até o sistema classificá-la");
  const cls = cause.ownerClass;
  if (cls && ownerClassesOf(config).some((c) => c.id === cls)) {
    return owner(cls, `a publicação toca «${ownerClassLabel(cls, config)}»${cause.rules.length ? ` (${cause.rules.join(", ")})` : ""} — só você autoriza`);
  }
  if (cause.decider === "owner") return owner(null, "o plano de publicação pediu você e a causa não tem classe nomeada — fica com você até o sistema classificá-la");
  return system(
    `lacuna de ferramenta/config: ${cause.units.length ? `«${cause.units.join("», «")}» não tem` : "a parte parada não tem"} classe de publicação — ` +
      "não é decisão de negócio; o conserto é dar uma classe a essa parte na configuração de publicação do alvo",
  );
}

/** O que se sabe da morte de um run num item travado: a origem (pela evidência carimbada) e se é o mesmo no-op de novo.
 *  A evidência é a que o item carrega (foldRunDiagnostics), senão o diagnóstico aberto do próprio card. Exportada: o
 *  Inbox bloqueia o «Tentar de novo» que não muda nada pela MESMA leitura que tira o item do dono. PURA. */
export function stuckFailure(item: CockpitItem, card: Card | undefined): Extract<DecisionPoint, { kind: "recovery" }>["failure"] {
  if (item.kind !== "stuck") return undefined;
  const death = card?.findings?.find((f) => f.id === "run-death" && f.status === "open");
  const evidence = item.evidence ?? (death ? { title: death.title, detail: death.detail, failureClass: death.failureClass } : undefined);
  const origin = failureOrigin({
    text: [evidence?.detail, item.outcome].filter(Boolean).join("\n"),
    // a classe que o carimbo atribuiu vence a releitura do texto; sem carimbo, ninguém julgou
    ...(evidence ? { failureClass: evidence.failureClass ?? null } : {}),
  });
  const repeatedNoOp = (item.reason ?? item.outcome) === "no-op" && runDeathRepeats(evidence?.title) >= 2;
  return { origin: origin.origin, label: origin.label, repeatedNoOp };
}

/** A causa estruturada do finding de publicação do item, ou null (finding anterior a ela, ou card ausente). PURA. */
function deployCauseOf(item: CockpitItem, card: Card | undefined): DeployCause | null {
  if (item.kind !== "deploy-failed") return null;
  return card?.findings?.find((f) => f.id === item.findingId)?.deployCause ?? null;
}

/**
 * O ponto de decisão de cada KIND de item do Inbox — exaustivo por tipo (`Record<CockpitItemKind, …>`): um kind novo
 * não compila até alguém dizer quem o decide. A pergunta é julgada pela pergunta do card; o pedido de aprovação,
 * pela classe de risco dele; o travado, pela origem da morte; a publicação que pediu alguém, pela causa dela.
 */
const KIND_POINT: Record<CockpitItemKind, (item: CockpitItem, card: Card | undefined) => DecisionPoint> = {
  question: (item, card) => {
    const qid = item.kind === "question" ? item.questionId : "";
    const question = card?.questions?.find((x) => x.id === qid);
    return { kind: "question", question: question ?? { category: item.kind === "question" ? item.category : undefined, text: item.kind === "question" ? item.prompt : "" } };
  },
  review: () => ({ kind: "triage-review" }),
  gate: (item) => ({ kind: "gate", ...(item.kind === "gate" && item.deliveryApproval ? { deliveryApproval: true } : {}) }),
  blocker: () => ({ kind: "gate" }),
  finding: () => ({ kind: "gate" }),
  design: () => ({ kind: "ui-choice" }),
  approval: (item) => ({ kind: "approval", riskClass: item.kind === "approval" ? item.riskClass : undefined }),
  governance: () => ({ kind: "governance" }),
  "data-deletion": () => ({ kind: "data-deletion" }),
  "locked-exec": () => ({ kind: "locked-exec" }),
  // o pedido de autorização que o plano listou sem card: a mesma régua da publicação que pediu alguém — a causa dele é do
  // dono (o plano pediu o sim dele), com a classe quando o board a nomeia
  "publish-approval": (item) =>
    item.kind === "publish-approval"
      ? {
          kind: "deploy-hold",
          cause: {
            ownerClass: item.ownerClass,
            decider: "owner",
            rules: [...new Set(item.approvals.flatMap((a) => a.rules))],
            units: [...new Set(item.approvals.flatMap((a) => a.units))],
          },
        }
      : { kind: "recovery" },
  stuck: (item, card) => ({ kind: "recovery", failure: stuckFailure(item, card) }),
  conflict: () => ({ kind: "recovery" }),
  "merge-failed": () => ({ kind: "recovery" }),
  "deploy-failed": (item, card) => (item.kind === "deploy-failed" && item.needsHuman ? { kind: "deploy-hold", cause: deployCauseOf(item, card) } : { kind: "recovery" }),
  "deploy-unsettled": () => ({ kind: "recovery" }),
  "release-aging": () => ({ kind: "recovery" }),
  "effect-failed": () => ({ kind: "recovery" }),
  // o card CONDUZIDO parado (o condutor encerrou e ninguém assumiu): parar o condutor ou devolver o card às colunas é do
  // operador — nenhum ator do sistema reabre em laço quem morreu (runner/conductor.ts)
  stalled: (item, card) =>
    item.kind === "stalled" && (item.conducted || card?.routing?.driver === "conductor") ? { kind: "operator", why: "o condutor deste card encerrou e ninguém assumiu: parar ou devolver às colunas é do operador" } : { kind: "recovery" },
  "meter-stalled": () => ({ kind: "recovery" }),
  proposal: () => ({ kind: "capture-proposal" }),
  "proxy-audit": () => ({ kind: "audit" }),
  "delivery-audit": () => ({ kind: "audit" }),
  "publish-held": () => ({ kind: "operator", why: "publicar por cima da guarda de trabalho concorrente, ou cancelar o pedido, é decisão do operador" }),
  "stage-idle": () => ({ kind: "operator", why: "este board só publica quando alguém pede" }),
  "capacity-latch": () => ({ kind: "operator", why: "só o operador solta a trava da cota" }),
  "host-health": () => ({ kind: "recovery" }),
  sentinel: () => ({ kind: "recovery" }),
  "push-off": () => ({ kind: "operator", why: "só você liga o aviso no seu celular" }),
};

/**
 * Quem decide um item do Inbox — a régua única, sem atalho por kind. (Antes havia um: todo `deploy-failed` que
 * pediu alguém ia ao dono sem olhar a classe da causa; agora é o ponto `deploy-hold`, julgado pela causa.) PURA.
 */
export function cockpitItemDecision(item: CockpitItem, card: Card | undefined, config: Pick<BoardConfig, "autonomy">): DecisionVerdict {
  return whoDecides(KIND_POINT[item.kind](item, card), card, config);
}
