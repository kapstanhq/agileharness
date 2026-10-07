// O PERFIL DE AUTONOMIA de um board — o controle único «Autonomia» (Mínima / Máxima / Personalizada). PURO (zero IO).
//
// Antes, «o que os agentes fazem sozinhos» morava em cinco chaves espalhadas (`autonomy.mode`, `release.mode`,
// `orchestrator.mode` + `riskMatrix.deploy`, `autorun.budgetRaise.maxPct`) e em três telas. Agora há UM bloco explícito,
// `autonomy.agentDecides`, com uma caixa por decisão (types.ts AgentDecidesKey), e este módulo responde:
//   1. qual é o perfil EFETIVO de um board (`autonomyProfileOf`) — o bloco explícito, e para o que ele não diz, a
//      derivação das chaves de antes (LEGADO: um board sem o bloco lê exatamente como lia, nenhum muda na troca);
//   2. a que preset ele corresponde (`presetOf`): Mínima, Máxima ou Personalizada;
//   3. as dependências entre caixas (deploy exige publicar; publicar exige aprovar a entrega) e como uma mudança se
//      propaga por elas (`applyAutonomyChange`);
//   4. a escrita COERENTE (`withAutonomyProfile`): o bloco novo E as chaves que os leitores antigos consultam, numa só
//      configuração — o escritor único (`setBoardAutonomyAction`) grava o resultado numa só `writeBoardConfig`;
//   5. o que é SEMPRE do dono, em qualquer perfil (`alwaysOwnerPoints`) — a lista travada do painel e da tool MCP.
//
// O que NENHUMA caixa alcança (decision-class.ts não lê o perfil para isto): as classes do dono (dinheiro e preço —
// incluindo o código de cobrança —, falar pela marca, o PRD e as metas, dados de pessoas), a trava do núcleo (shell
// livre, ação irreversível), os comandos que a trava do servidor recusa («Aprovar e rodar») e a própria autonomia
// (só a sessão do operador a muda; nenhum agente).
//
// A exceção por card (`Card.autonomyMode`, `set_card_autonomy`) segue existindo e sobrepõe SÓ `spec`/`design`/
// `delivery` (`ultra` liga as três para aquele card; `human` desliga as três). Publicar, deploy, gasto, copiloto e
// Sentinela são do board.

import { dispositionFor } from "./runner/orchestrator-policy";
import { tierMatrix, tierMode, DEPLOY_AUTONOMY_ENABLED } from "./copilot/tier";
import { ownerClassesOf } from "./owner-classes";
import { AGENT_DECIDES_KEYS, ORCHESTRATOR_MODES } from "./types";
import type {
  AgentDecides,
  AgentDecidesKey,
  AutonomyMode,
  BoardConfig,
  Card,
  OrchestratorMode,
  QuestionCategory,
  ReleaseMode,
  RiskClass,
  RiskDisposition,
} from "./types";

export { AGENT_DECIDES_KEYS };
export type { AgentDecides, AgentDecidesKey };

/** O perfil efetivo de um board: uma caixa por decisão. */
export type AutonomyProfile = AgentDecides;

/** O preset a que um perfil corresponde. */
export type AutonomyPreset = "minima" | "maxima" | "personalizada";

/** Mínima: os agentes trabalham sozinhos e PARAM a cada decisão (plano, tela, entrega, publicar, deploy). */
export const MINIMA_PROFILE: Readonly<AutonomyProfile> = Object.freeze({
  spec: false,
  design: false,
  delivery: false,
  publish: false,
  deploy: false,
  spendRaise: false,
  copilot: false,
  sentinel: false,
});

/**
 * Máxima: os agentes decidem o técnico, aprovam, publicam e fazem deploy; o dono só decide o que é dele. A Sentinela
 * conserta a máquina sozinha (Bash sob a trava dura do host, cada comando registrado — runner/sentinel*.ts).
 */
export const MAXIMA_PROFILE: Readonly<AutonomyProfile> = Object.freeze({
  spec: true,
  design: true,
  delivery: true,
  publish: true,
  deploy: true,
  spendRaise: true,
  copilot: true,
  sentinel: true,
});

export const PRESET_PROFILES: Readonly<Record<Exclude<AutonomyPreset, "personalizada">, Readonly<AutonomyProfile>>> = {
  minima: MINIMA_PROFILE,
  maxima: MAXIMA_PROFILE,
};

/** O nome do preset, como o dono o lê. */
export const PRESET_LABEL: Readonly<Record<AutonomyPreset, string>> = { minima: "Mínima", maxima: "Máxima", personalizada: "Personalizada" };

/** Uma caixa do painel: o rótulo e o efeito em uma linha (a UI e a tool MCP leem daqui — a mesma verdade). */
export interface AutonomyBoxMeta {
  key: AgentDecidesKey;
  label: string;
  /** o nome CURTO da caixa — o que as frases de dependência e de conflito citam. */
  short: string;
  effect: string;
  /** a frase do recibo quando a caixa LIGA («agora os agentes …»). */
  on: string;
  /** a frase do recibo quando a caixa DESLIGA («agora você …»). */
  off: string;
  /**
   * «em breve»: a caixa existe no modelo mas NADA no código a lê ainda. O painel a mostra travada, os presets e o
   * recibo a ignoram — uma caixa que não muda nada nunca é oferecida como se mudasse.
   */
  soon?: boolean;
}

export const AUTONOMY_BOXES: readonly AutonomyBoxMeta[] = [
  {
    key: "spec",
    short: "Aprovar o plano",
    label: "Aprovar o plano e responder as dúvidas da especificação",
    effect: "O crítico dá o «vai» do plano; o procurador responde entrevista e dúvidas técnicas.",
    on: "agora o crítico aprova o plano e o procurador responde as dúvidas da especificação",
    off: "agora você aprova o plano e responde as dúvidas da especificação",
  },
  {
    key: "design",
    short: "Escolher a tela",
    label: "Escolher a tela entre as variantes desenhadas",
    effect: "O procurador escolhe pelo guia de estilo e registra as alternativas.",
    on: "agora os agentes escolhem a tela",
    off: "agora você escolhe a tela",
  },
  {
    key: "delivery",
    short: "Aprovar a entrega",
    label: "Aprovar a entrega (com a prova da entrega escrita)",
    effect: "Os agentes aprovam a entrega com a prova escrita; desligada, cada entrega espera você.",
    on: "agora os agentes aprovam a entrega com a prova escrita",
    off: "agora você aprova cada entrega",
  },
  {
    key: "publish",
    short: "Publicar",
    label: "Publicar o que foi aprovado (levar ao ramo principal)",
    effect: "O sistema pede a publicação sozinho quando há trabalho aprovado.",
    on: "agora os agentes publicam sozinhos",
    off: "agora você aperta «Publicar»",
  },
  {
    key: "deploy",
    short: "Fazer deploy",
    label: "Fazer deploy em produção",
    effect: "Um agente pode pedir o deploy pelo ritual de publicação.",
    on: "agora os agentes fazem deploy em produção",
    off: "agora o deploy em produção espera você",
  },
  {
    key: "spendRaise",
    short: "Passar do teto de gasto",
    label: "Passar do teto de gasto de um card, dentro do ritmo da cota",
    effect: "Um aumento por card, até o teto do tipo; acima disso, é seu.",
    on: "agora o sistema aprova um aumento de teto por card dentro do ritmo",
    off: "agora todo aumento de teto de gasto é seu",
  },
  {
    // A caixa governa `orchestrator.mode: autonomous`: o conserto $0 do serviço (zelador, recuperação, card de conserto)
    // só roda num board com ela ligada (runner/sentinel-run.ts `deterministicAllowed`). O CHAT do board não depende dela
    // desde a fase 6 — ele tem os poderes do dono em qualquer modo (copilot/chat-powers.ts) e age quando ele pede.
    key: "copilot",
    short: "O Jido agir no board",
    label: "O Jido agir no board (destravar cards sozinho)",
    effect: "O Jido destrava sozinho os cards parados deste board, sem custo; desligada, só diagnostica. No chat ele faz o que você pede, ligada ou não.",
    on: "agora o Jido destrava o board sozinho",
    off: "agora o Jido não destrava o board sozinho — no chat, segue fazendo o que você pede",
  },
  {
    // A Sentinela está SEMPRE ligada (acorda quando a máquina sai do trilho: execução ou condutor parado, falha
    // repetida, saúde vermelha, trava de cota, merge ou deploy que falhou, card esquecido). A caixa decide só o PODER
    // dela (runner/sentinel.ts sentinelModeOf): desligada, diagnostica e abre um item no Inbox com «Resolver no chat»;
    // ligada, conserta com o terminal sob a trava dura do host E dentro da contenção do sistema (sem uma das duas no
    // host, ela segue só diagnosticando e o Inbox diz por quê), com teto de gasto por dia e cada comando registrado.
    // O interruptor geral do autorun desligado também a deixa só no diagnóstico do sinal (nenhum LLM nasce).
    key: "sentinel",
    short: "A Sentinela consertar",
    label: "A Sentinela consertar a máquina sozinha",
    effect: "Ligada, ela conserta com o terminal, sob a trava do servidor e com cada comando registrado; desligada, só diagnostica e te avisa no Inbox.",
    on: "agora a Sentinela conserta a máquina sozinha, sob a trava do servidor",
    off: "agora a Sentinela só diagnostica e te avisa no Inbox",
  },
];

/** As caixas que valem hoje (as «em breve» ficam fora dos presets e do recibo). */
export const LIVE_AUTONOMY_KEYS: readonly AgentDecidesKey[] = AUTONOMY_BOXES.filter((b) => !b.soon).map((b) => b.key);

/**
 * As DEPENDÊNCIAS entre caixas: a chave só pode ficar ligada com as pré-requisito ligadas. Deploy exige publicar (não
 * há deploy de algo que não foi publicado); publicar exige aprovar a entrega (o sistema não publica o que ninguém
 * aprovou — o dono aprovando cada entrega e o sistema publicando a seguir é «publicar ligado, entrega desligada»,
 * que não é um estado do painel: publica-se à mão o que se aprova à mão).
 */
export const AUTONOMY_DEPENDENCIES: Readonly<Record<AgentDecidesKey, readonly AgentDecidesKey[]>> = {
  spec: [],
  design: [],
  delivery: [],
  publish: ["delivery"],
  deploy: ["publish"],
  spendRaise: [],
  copilot: [],
  sentinel: [],
};

const boxLabel = (k: AgentDecidesKey) => AUTONOMY_BOXES.find((b) => b.key === k)?.short ?? k;

/**
 * Por que esta caixa não pode ser ligada AGORA (uma pré-requisito está desligada) — a frase que a caixa desabilitada
 * mostra —, ou null. Lê o perfil como está. PURA.
 */
export function dependencyBlock(profile: AutonomyProfile, key: AgentDecidesKey): string | null {
  const missing = AUTONOMY_DEPENDENCIES[key].filter((d) => !profile[d]);
  if (!missing.length) return null;
  return `exige «${missing.map(boxLabel).join("» e «")}» ligada`;
}

/** As caixas que dependem (direta ou indiretamente) de `key`. PURA. */
function dependentsOf(key: AgentDecidesKey): AgentDecidesKey[] {
  const out: AgentDecidesKey[] = [];
  const walk = (k: AgentDecidesKey) => {
    for (const d of AGENT_DECIDES_KEYS) {
      if (AUTONOMY_DEPENDENCIES[d].includes(k) && !out.includes(d)) {
        out.push(d);
        walk(d);
      }
    }
  };
  walk(key);
  return out;
}

/** As pré-requisito (diretas ou indiretas) de `key`. PURA. */
function prerequisitesOf(key: AgentDecidesKey): AgentDecidesKey[] {
  const out: AgentDecidesKey[] = [];
  const walk = (k: AgentDecidesKey) => {
    for (const p of AUTONOMY_DEPENDENCIES[k]) {
      if (!out.includes(p)) {
        out.push(p);
        walk(p);
      }
    }
  };
  walk(key);
  return out;
}

/**
 * Aplica uma mudança do painel: um preset inteiro, ou caixas soltas. Ligar uma caixa liga as pré-requisito DELA (quem
 * marca «deploy» quer publicar); desligar uma caixa desliga as que dependem DELA. Só isso: as dependências valem para a
 * caixa mexida e a sua cadeia, NUNCA para o perfil inteiro — um board legado incoerente (ex.: publicar ligado com a
 * entrega desligada) não tem caixa nenhuma virada por um clique em outra (`profileConflicts` mostra o conflito ao dono,
 * que escolhe). PURA.
 */
export function applyAutonomyChange(current: AutonomyProfile, change: { preset?: Exclude<AutonomyPreset, "personalizada">; patch?: Partial<AgentDecides> }): AutonomyProfile {
  const next: AutonomyProfile = change.preset ? { ...PRESET_PROFILES[change.preset] } : { ...current };
  for (const [k, v] of Object.entries(change.patch ?? {}) as Array<[AgentDecidesKey, boolean | undefined]>) {
    if (!AGENT_DECIDES_KEYS.includes(k) || typeof v !== "boolean") continue;
    next[k] = v;
    if (v) for (const p of prerequisitesOf(k)) next[p] = true;
    else for (const d of dependentsOf(k)) next[d] = false;
  }
  return next;
}

/**
 * Os CONFLITOS de dependência do perfil — uma caixa ligada com uma pré-requisito desligada (só acontece num board legado,
 * que lê exatamente como lia). O painel os mostra em vez de corrigi-los em silêncio: «Publicar» ligado sem «Aprovar a
 * entrega» publica o que VOCÊ aprova — o dono escolhe qual das duas mexer. PURA.
 */
export function profileConflicts(profile: AutonomyProfile): string[] {
  return AGENT_DECIDES_KEYS.flatMap((k) => {
    const missing = profile[k] ? AUTONOMY_DEPENDENCIES[k].filter((d) => !profile[d]) : [];
    return missing.length ? [`«${boxLabel(k)}» está ligada sem «${missing.map(boxLabel).join("» e «")}»: ligue «${missing.map(boxLabel).join("» e «")}» ou desligue «${boxLabel(k)}».`] : [];
  });
}

/** O que o perfil precisa de `settings.yaml` (só o legado de `spendRaise`). */
export interface AutonomySettingsView {
  autorun?: { budgetRaise?: { maxPct?: number } } | null;
}

/** O `maxPct` padrão do aumento de teto (runner/config.ts — `autorun.budgetRaise.maxPct`). */
const DEFAULT_RAISE_PCT = 30;

/**
 * O perfil DERIVADO das chaves de antes — o legado de um board sem `agentDecides`. PURA:
 *   `autonomy.mode: ultra`                 ⇒ spec, design, delivery;
 *   `release.mode: auto`                   ⇒ publish;
 *   `orchestrator.riskMatrix.deploy: auto` ⇒ deploy (a disposição RESOLVIDA, a mesma que a guarda lê);
 *   `orchestrator.mode: autonomous`        ⇒ copilot;
 *   `autorun.budgetRaise.maxPct > 0`       ⇒ spendRaise (sem settings: o padrão, 30);
 *   a Sentinela não existia                ⇒ sentinel desligada.
 * As dependências NÃO são impostas aqui: um board legado lê exatamente como lia (ex.: `release.mode: auto` num board
 * `human` segue publicando sozinho). Elas valem a partir da primeira escrita pelo painel.
 */
export function legacyProfileOf(
  config: Pick<BoardConfig, "autonomy"> & Partial<Pick<BoardConfig, "release" | "orchestrator">>,
  settings?: AutonomySettingsView | null,
): AutonomyProfile {
  const ultra = config.autonomy?.mode === "ultra";
  const pct = settings?.autorun?.budgetRaise?.maxPct;
  return {
    spec: ultra,
    design: ultra,
    delivery: ultra,
    publish: config.release?.mode === "auto",
    deploy: dispositionFor(config.orchestrator ?? null, "deploy") === "auto",
    spendRaise: (typeof pct === "number" && Number.isFinite(pct) ? pct : DEFAULT_RAISE_PCT) > 0,
    copilot: config.orchestrator?.mode === "autonomous",
    sentinel: false,
  };
}

/** O board declara o bloco explícito? (o painel já gravou por ele). PURA. */
export function hasExplicitProfile(config: Pick<BoardConfig, "autonomy"> | null | undefined): boolean {
  const d = config?.autonomy?.agentDecides;
  return !!d && AGENT_DECIDES_KEYS.some((k) => typeof d[k] === "boolean");
}

/**
 * O PERFIL EFETIVO do board: cada caixa do bloco explícito, e para a caixa que ele não diz, a derivação do legado.
 * PURA — a leitura que o painel, a tool MCP e os leitores granulares (autonomy.ts, decision-class.ts, release-policy,
 * card-budget, a guarda do MCP) fazem.
 */
export function autonomyProfileOf(
  config: (Pick<BoardConfig, "autonomy"> & Partial<Pick<BoardConfig, "release" | "orchestrator">>) | null | undefined,
  settings?: AutonomySettingsView | null,
): AutonomyProfile {
  const legacy = legacyProfileOf(config ?? {}, settings);
  const explicit = config?.autonomy?.agentDecides;
  if (!explicit) return legacy;
  const out = { ...legacy };
  for (const k of AGENT_DECIDES_KEYS) if (typeof explicit[k] === "boolean") out[k] = explicit[k] as boolean;
  return out;
}

/**
 * O preset a que o perfil corresponde — Mínima, Máxima, ou Personalizada quando as caixas não batem com nenhum. Conta só
 * as caixas que valem hoje (a «em breve» não decide preset). `explicit = false` (o perfil ainda é o LEGADO): o teto de
 * gasto não conta — o legado dele vem do settings.yaml GLOBAL (ligado em todo board por padrão), não de uma escolha
 * deste board, e contá-lo deixava todo board existente «Personalizada». A Sentinela também não conta no legado: ela não
 * existia, e um board que já era Máxima não ganha o terminal dela sem o dono escolher pelo painel. PURA.
 */
export function presetOf(profile: AutonomyProfile, explicit = true): AutonomyPreset {
  const keys = LIVE_AUTONOMY_KEYS.filter((k) => explicit || (k !== "spendRaise" && k !== "sentinel"));
  const same = (p: Readonly<AutonomyProfile>) => keys.every((k) => !!profile[k] === p[k]);
  if (same(MINIMA_PROFILE)) return "minima";
  if (same(MAXIMA_PROFILE)) return "maxima";
  return "personalizada";
}

/**
 * O nível que a TELA mostra — a pílula, a engrenagem e o painel. Diferente de `presetOf` (que no legado ignora o teto
 * de gasto e a Sentinela para ACHAR o modo mais perto), aqui conta TODA caixa que vale hoje: um board com «Máxima» e a
 * Sentinela desligada não é «Máxima» (o dono leria «tudo ligado») — é «Personalizada», e `presetGapWords` diz o quanto
 * ela difere do modo mais perto. Escolher «Máxima» liga o que falta, então o modo pronto não aparece marcado. PURA.
 */
export function shownPresetOf(profile: AutonomyProfile): AutonomyPreset {
  return presetOf(profile, true);
}

/** O que falta / sobra numa caixa, como o rótulo do nível o diz («sem a Sentinela», «com o aumento de teto»). */
const GAP_WORDS: Partial<Readonly<Record<AgentDecidesKey, string>>> = {
  sentinel: "a Sentinela",
  spendRaise: "o aumento de teto",
};
const gapWord = (k: AgentDecidesKey) => GAP_WORDS[k] ?? `«${boxLabel(k)}»`;

/**
 * Quando o perfil é «Personalizada», a distância ao modo pronto mais perto em palavras: «Máxima, sem a Sentinela»,
 * «Mínima, com o aumento de teto». Só quando a diferença é de até 2 caixas (mais que isso, o «perto» não ajuda); null
 * quando o perfil É um modo pronto ou fica longe dos dois. Caixas «em breve» não contam. PURA.
 */
export function presetGapWords(profile: AutonomyProfile): string | null {
  if (shownPresetOf(profile) !== "personalizada") return null;
  const diff = (p: Readonly<AutonomyProfile>) => LIVE_AUTONOMY_KEYS.filter((k) => !!profile[k] !== p[k]);
  const toMax = diff(MAXIMA_PROFILE);
  const toMin = diff(MINIMA_PROFILE);
  const [preset, keys, word] = toMax.length <= toMin.length ? (["maxima", toMax, "sem"] as const) : (["minima", toMin, "com"] as const);
  if (!keys.length || keys.length > 2) return null;
  return `${PRESET_LABEL[preset]}, ${word} ${keys.map(gapWord).join(" e ")}`;
}

// ── as três caixas que a exceção por card sobrepõe ──────────────────────────────────────────────────────────────────

/** As caixas que valem por STORY (a exceção do card as sobrepõe). */
export type StoryDecisionKey = "spec" | "design" | "delivery";

/**
 * O modo «só-negócio» do BOARD (o `ultra` de antes), derivado do perfil quando o bloco é explícito: alguma das caixas
 * de story ligada ⇒ `ultra`. Sem o bloco, o `autonomy.mode` declarado. PURA.
 */
export function boardAutonomyMode(config: Pick<BoardConfig, "autonomy"> | null | undefined): AutonomyMode {
  if (hasExplicitProfile(config)) {
    const p = autonomyProfileOf(config);
    return p.spec || p.design || p.delivery ? "ultra" : "human";
  }
  return config?.autonomy?.mode === "ultra" ? "ultra" : "human";
}

/**
 * Esta caixa de story vale para ESTE card? A exceção do card primeiro (`ultra` ⇒ sim, `human` ⇒ não), senão o perfil do
 * board. PURA.
 */
export function storyDecides(
  card: Pick<Card, "autonomyMode"> | null | undefined,
  config: Pick<BoardConfig, "autonomy"> | null | undefined,
  key: StoryDecisionKey,
): boolean {
  if (card?.autonomyMode) return card.autonomyMode === "ultra";
  return autonomyProfileOf(config)[key];
}

/**
 * A caixa que governa uma CATEGORIA de pergunta: entrevista e técnica ⇒ `spec`; escolha de tela ⇒ `design`; entrega
 * ⇒ `delivery`. As do dono (`owner`, `money`) e a `guardrail` (revisor de diff) não têm caixa: nenhum perfil as dá ao
 * procurador. PURA.
 */
export function decisionKeyOfCategory(category: QuestionCategory | undefined): StoryDecisionKey | null {
  switch (category) {
    case "interview":
    case "technical":
      return "spec";
    case "ui-choice":
      return "design";
    case "delivery":
      return "delivery";
    default:
      return null;
  }
}

// ── a escrita coerente ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * A configuração do board com o perfil gravado — o bloco explícito E as chaves que os leitores de antes consultam,
 * coerentes entre si (o escritor único grava o resultado numa só escrita). PURA, e MÍNIMA: uma chave só é escrita quando
 * o valor que os leitores resolvem muda — um clique numa caixa não reescreve o que ela não governa.
 *   autonomy.agentDecides  o perfil inteiro (como veio: as dependências são da mudança, `applyAutonomyChange`);
 *   autonomy.mode          `ultra` quando alguma caixa de story está ligada, senão `human`;
 *   release.mode           `auto` ⇔ publish;
 *   orchestrator.mode      `autonomous` ⇔ copilot (um `paired` existente fica quando o copiloto desliga);
 *   orchestrator.riskMatrix SÓ a classe `deploy` (`auto` ⇔ deploy e o portão DEPLOY_AUTONOMY_ENABLED; desligada, um
 *                           `auto` vira `ask` e um `never` fica). Toda outra classe é do board e fica como está — uma
 *                           matriz mais estrita sobrevive a qualquer clique. Só um board SEM matriz que liga o copiloto
 *                           recebe a base do Copiloto (o que o Jido pode fazer sozinho no board; exclusão e aprovação de
 *                           governança seguem `ask`).
 * `spendRaise` e `sentinel` vivem só no bloco (card-budget e a Sentinela leem o perfil).
 */
export function withAutonomyProfile<T extends Pick<BoardConfig, "autonomy"> & Partial<Pick<BoardConfig, "release" | "orchestrator">>>(
  config: T,
  profile: AutonomyProfile,
): T {
  const p = { ...profile };
  const out: T = {
    ...config,
    autonomy: {
      ...(config.autonomy ?? {}),
      mode: p.spec || p.design || p.delivery ? "ultra" : "human",
      agentDecides: { ...p },
    },
  };
  const release: ReleaseMode = p.publish ? "auto" : "manual";
  if ((config.release?.mode === "auto" ? "auto" : "manual") !== release) out.release = { ...(config.release ?? {}), mode: release };

  const prevOrch = config.orchestrator;
  const prevMode: OrchestratorMode = prevOrch?.mode ?? "off";
  // o modo que o tier grava (tier.ts tierMode): ligado ⇒ o do Copiloto; desligado ⇒ o do Chat — um `paired` fica
  const orchMode: OrchestratorMode = p.copilot ? tierMode("copiloto") : prevMode === "autonomous" ? tierMode("chat") : prevMode;
  const prevDeploy = dispositionFor(prevOrch ?? null, "deploy");
  const deployDisp: RiskDisposition = p.deploy && DEPLOY_AUTONOMY_ENABLED ? "auto" : prevDeploy === "auto" ? "ask" : prevDeploy;
  const hasMatrix = !!prevOrch?.riskMatrix && Object.keys(prevOrch.riskMatrix).length > 0;
  let matrix = prevOrch?.riskMatrix;
  if (p.copilot && !hasMatrix) matrix = { ...tierMatrix("copiloto"), deploy: deployDisp };
  else if (deployDisp !== prevDeploy) matrix = { ...(prevOrch?.riskMatrix ?? {}), deploy: deployDisp };
  if (orchMode !== prevMode || matrix !== prevOrch?.riskMatrix) {
    out.orchestrator = { ...(prevOrch ?? {}), mode: orchMode, ...(matrix ? { riskMatrix: matrix } : {}) };
  }
  return out;
}

// ── o «Desfazer»: o estado EXATO de antes ──────────────────────────────────────────────────────────────────────────

/**
 * As chaves de autonomia de um board como estavam — o que o «Desfazer» devolve, sem propagar dependência nem
 * normalizar nada. Só as chaves que o escritor único toca (o resto dos blocos não é dele). Serializável (vai ao cliente
 * e volta). `has*` = o bloco existia (um bloco que a mudança criou some no desfazer).
 */
export interface AutonomySnapshot {
  agentDecides?: Partial<AgentDecides>;
  mode?: AutonomyMode;
  releaseMode?: ReleaseMode;
  orchestratorMode?: OrchestratorMode;
  riskMatrix?: Partial<Record<RiskClass, RiskDisposition>>;
  hasRelease: boolean;
  hasOrchestrator: boolean;
}

/** A foto das chaves de autonomia de uma config. PURA. */
export function autonomySnapshotOf(config: Pick<BoardConfig, "autonomy"> & Partial<Pick<BoardConfig, "release" | "orchestrator">>): AutonomySnapshot {
  const a = config.autonomy;
  return {
    ...(a?.agentDecides ? { agentDecides: { ...a.agentDecides } } : {}),
    ...(a?.mode ? { mode: a.mode } : {}),
    ...(config.release?.mode ? { releaseMode: config.release.mode } : {}),
    ...(config.orchestrator?.mode ? { orchestratorMode: config.orchestrator.mode } : {}),
    ...(config.orchestrator?.riskMatrix ? { riskMatrix: { ...config.orchestrator.riskMatrix } } : {}),
    hasRelease: !!config.release,
    hasOrchestrator: !!config.orchestrator,
  };
}

const RISK_DISPOSITIONS: readonly RiskDisposition[] = ["auto", "ask", "never"];

/**
 * A config com as chaves de autonomia de volta EXATAMENTE como a foto diz (o «Desfazer»): o bloco explícito, o modo, a
 * publicação, o modo do copiloto e a matriz — nada propagado, nada normalizado; o resto de cada bloco fica como está.
 * A foto vem do cliente, então só valores do vocabulário entram (uma grafia torta é descartada, nunca gravada); a matriz
 * ainda passa pelo lint de quem grava. PURA.
 */
export function withAutonomySnapshot<T extends Pick<BoardConfig, "autonomy"> & Partial<Pick<BoardConfig, "release" | "orchestrator">>>(
  config: T,
  snap: AutonomySnapshot,
): T {
  const decides: Partial<AgentDecides> = {};
  for (const k of AGENT_DECIDES_KEYS) if (typeof snap.agentDecides?.[k] === "boolean") decides[k] = snap.agentDecides[k];
  const { agentDecides: _d, mode: _m, ...autonomyRest } = config.autonomy ?? {};
  const autonomy = {
    ...autonomyRest,
    ...(snap.mode === "ultra" || snap.mode === "human" ? { mode: snap.mode } : {}),
    ...(Object.keys(decides).length ? { agentDecides: decides } : {}),
  };
  const out: T = { ...config, autonomy: Object.keys(autonomy).length ? autonomy : undefined };
  if (!out.autonomy) delete (out as Partial<T>).autonomy;

  const releaseMode = snap.releaseMode === "auto" || snap.releaseMode === "manual" ? snap.releaseMode : undefined;
  if (snap.hasRelease && releaseMode) out.release = { ...(config.release ?? {}), mode: releaseMode };
  else if (!snap.hasRelease) delete (out as Partial<T>).release;

  if (!snap.hasOrchestrator) delete (out as Partial<T>).orchestrator;
  else {
    const matrix: Partial<Record<RiskClass, RiskDisposition>> = {};
    for (const [cls, disp] of Object.entries(snap.riskMatrix ?? {})) {
      if (RISK_DISPOSITIONS.includes(disp as RiskDisposition)) matrix[cls as RiskClass] = disp as RiskDisposition;
    }
    const { riskMatrix: _r, ...orchRest } = config.orchestrator ?? { mode: "off" as OrchestratorMode };
    const mode = ORCHESTRATOR_MODES.includes(snap.orchestratorMode as OrchestratorMode) ? (snap.orchestratorMode as OrchestratorMode) : "off";
    out.orchestrator = { ...orchRest, mode, ...(Object.keys(matrix).length ? { riskMatrix: matrix } : {}) };
  }
  return out;
}

/**
 * A impressão digital das chaves de AUTONOMIA de uma config — o perfil explícito e as chaves que ele mantém coerentes
 * (`autonomy.mode`, `release.mode`, `orchestrator`). Dois valores diferentes ⇒ a autonomia mudou: a porta genérica de
 * salvar a config recusa isso de um agente (só o painel do operador muda a autonomia). PURA.
 */
export function autonomyKeysFingerprint(config: Pick<BoardConfig, "autonomy"> & Partial<Pick<BoardConfig, "release" | "orchestrator">>): string {
  return JSON.stringify([
    config.autonomy?.agentDecides ?? null,
    config.autonomy?.mode ?? null,
    config.release?.mode ?? null,
    config.orchestrator?.mode ?? null,
    config.orchestrator?.riskMatrix ?? null,
  ]);
}

/**
 * A guarda do perfil sobre uma disposição da matriz: com o bloco EXPLÍCITO e a caixa de deploy desligada, `deploy`
 * nunca resolve `auto` — mesmo que a matriz tenha sido editada à mão depois. Só aperta, nunca afrouxa. PURA.
 */
export function clampByProfile(config: Pick<BoardConfig, "autonomy"> | null | undefined, cls: RiskClass, disp: RiskDisposition): RiskDisposition {
  if (cls === "deploy" && disp === "auto" && config?.autonomy?.agentDecides?.deploy === false) return "ask";
  return disp;
}

/**
 * O recibo de uma mudança, como o dono o lê: «Autonomia: Personalizada — agora os agentes publicam sozinhos». Conta só
 * as caixas que valem hoje (uma «em breve» nunca aparece como efeito). PURA.
 */
export function autonomyReceipt(prev: AutonomyProfile, next: AutonomyProfile): string {
  // o nível que a TELA mostra (shownPresetOf): o recibo nunca diz «Máxima» com uma caixa da Máxima desligada.
  const head = `Autonomia: ${PRESET_LABEL[shownPresetOf(next)]}`;
  const changed = AUTONOMY_BOXES.filter((b) => !b.soon && !!prev[b.key] !== !!next[b.key]);
  if (!changed.length) return `${head} — nada mudou`;
  if (changed.length > 2) return `${head} — ${changed.length} mudanças`;
  return `${head} — ${changed.map((b) => (next[b.key] ? b.on : b.off)).join("; ")}`;
}

// ── o que é sempre do dono ─────────────────────────────────────────────────────────────────────────────────────

/** Um ponto que nenhuma caixa alcança — a lista travada do painel e da tool `board_autonomy`. */
export interface AlwaysOwnerPoint {
  id: string;
  label: string;
  /** UMA linha curta (≤ 60 caracteres) — o painel mostra uma linha por item. */
  detail: string;
  /** a explicação inteira (a descrição da classe), para o `title` e para a tool MCP. */
  long?: string;
}

/** A linha curta de cada classe do dono padrão (uma classe que o board declara a mais usa só o rótulo). */
const OWNER_CLASS_SHORT: Readonly<Record<string, string>> = {
  money: "Gasto, preço, fornecedor e código de cobrança.",
  "brand-voice": "Redes, e-mail e push em massa, fora do produto.",
  prd: "Escopo, apostas, métricas e prazos.",
  "personal-data": "Apagar, coletar ou expor dado de alguém.",
};

/**
 * O que é SEMPRE do dono, em qualquer perfil: as classes do dono que o board declara (dinheiro sempre — com o código de
 * cobrança e pagamento —, marca, PRD e metas, dados de pessoas), mais os pontos estruturais: os comandos que a trava do
 * servidor recusa («Aprovar e rodar»), o irreversível e o shell fora da trava (a trava do núcleo) e a própria autonomia.
 * PURA.
 */
export function alwaysOwnerPoints(config: Pick<BoardConfig, "autonomy"> | null | undefined): AlwaysOwnerPoint[] {
  const classes = ownerClassesOf(config).map((c) => ({
    id: c.id,
    label: c.label,
    detail: OWNER_CLASS_SHORT[c.id] ?? "",
    long: c.id === "money" ? `${c.description} Inclui qualquer mudança no código de cobrança ou de pagamento.`.trim() : c.description,
  }));
  return [
    ...classes,
    {
      id: "locked-exec",
      label: "Comandos que a trava do servidor proíbe",
      detail: "Só rodam com o seu «Aprovar e rodar».",
      long: "Um agente só propõe; o comando roda uma vez, com o seu clique em «Aprovar e rodar».",
    },
    {
      id: "kernel",
      label: "Ações irreversíveis e comandos fora da trava",
      detail: "Apagar dados, encerrar sessões, shell sem trava.",
      long: "Apagar dados de produção, encerrar sessões, aprovar a própria proposta, um shell fora da trava dura — humanos em qualquer modo. Nenhum agente (nem a Sentinela) age fora da trava.",
    },
    {
      id: "autonomy",
      label: "Mudar a autonomia do board",
      detail: "Só você, pela tela.",
      long: "Só você, pela tela. Nenhum agente muda estas caixas.",
    },
  ];
}

/** A frase que explica a lista travada. */
export const ALWAYS_OWNER_NOTE = "Isto não se desliga: nenhum modo, caixa ou agente decide estes pontos por você.";
