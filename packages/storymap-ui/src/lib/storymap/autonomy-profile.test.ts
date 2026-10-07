// O PERFIL DE AUTONOMIA (autonomy-profile.ts) e os leitores que passam a consultá-lo caixa a caixa. Fixa:
//   • o LEGADO: um board sem `agentDecides` lê exatamente como lia (cada chave de antes ⇒ a caixa dela);
//   • o preset (Mínima / Máxima / Personalizada), as dependências e como uma mudança se propaga por elas;
//   • a escrita coerente (o bloco + as chaves antigas, com a matriz que passa no lint);
//   • o procurador com ESCOPO e o `whoDecides` granular;
//   • e o invariante do dono: TUDO ligado não libera nenhum ponto que é sempre dele.
// Fixtures inventadas, no vocabulário da livraria de demonstração.

import { describe, expect, it } from "vitest";
import {
  AGENT_DECIDES_KEYS,
  AUTONOMY_BOXES,
  MAXIMA_PROFILE,
  MINIMA_PROFILE,
  alwaysOwnerPoints,
  applyAutonomyChange,
  autonomyKeysFingerprint,
  autonomyProfileOf,
  autonomyReceipt,
  boardAutonomyMode,
  clampByProfile,
  dependencyBlock,
  autonomySnapshotOf,
  hasExplicitProfile,
  legacyProfileOf,
  presetGapWords,
  presetOf,
  profileConflicts,
  shownPresetOf,
  storyDecides,
  withAutonomyProfile,
  withAutonomySnapshot,
  type AutonomyProfile,
} from "./autonomy-profile";
import { agentAnswerRefusal, agentMayTakeQuestion, effectiveAutonomy, isOwnerDecisionQuestion, ownerFloorClass, proxyRefusal } from "./autonomy";
import { changesAgentConfig, changesExistingTests, codeChangePoint, parseNameStatus, touchesBillingCode, whoDecides, withCodeChangeMarks, type DecisionPoint } from "./decision-class";
import { releaseModeOf } from "./release-policy";
import { dispositionFor, lintRiskMatrix } from "./runner/orchestrator-policy";
import { restoreCardGovernance, restoreGovernanceKeys, stripAgentAutonomy } from "./runner/governance-keys";
import { ownerPublishHold } from "./owner-waiting";
import { DEFAULT_BUDGET_RAISE, cardCapUSD, cardSpendCeilingUSD, judgeBudgetRequest } from "./runner/card-budget";
import { coerceAutonomy, coerceCard } from "./repo";
import type { AgentDecides, BoardConfig, Card, CardQuestion } from "./types";
import { parseYamlMap } from "./frontmatter";

const parseYaml = (text: string) => parseYamlMap(text) as unknown as Cfg;

type Cfg = Pick<BoardConfig, "autonomy"> & Partial<Pick<BoardConfig, "release" | "orchestrator">>;

const explicit = (d: Partial<AgentDecides>): Cfg => ({ autonomy: { agentDecides: d } });
const allOn: Cfg = explicit({ ...MAXIMA_PROFILE });
const allOff: Cfg = explicit({ ...MINIMA_PROFILE });
const card = (over: Partial<Card> = {}): Card => ({ ...coerceCard("story-ex9101", { type: "story", storyType: "user", title: "Vitrine de lançamentos", status: "construir" }, ""), ...over });
const q = (over: Partial<CardQuestion>): CardQuestion => ({ id: "q1", text: "Qual estante destacar na vitrine?", status: "open", ...over });

describe("o LEGADO — board sem `agentDecides` lê como lia", () => {
  it("cada chave de antes vira a caixa dela", () => {
    expect(legacyProfileOf({ autonomy: { mode: "ultra" } })).toMatchObject({ spec: true, design: true, delivery: true, publish: false, deploy: false, copilot: false, sentinel: false });
    expect(legacyProfileOf({ autonomy: { mode: "human" } })).toMatchObject({ spec: false, design: false, delivery: false });
    expect(legacyProfileOf({ autonomy: undefined, release: { mode: "auto" } }).publish).toBe(true);
    expect(legacyProfileOf({ autonomy: undefined, orchestrator: { mode: "autonomous", riskMatrix: { deploy: "auto" } } })).toMatchObject({ copilot: true, deploy: true });
    expect(legacyProfileOf({ autonomy: undefined, orchestrator: { mode: "autonomous", riskMatrix: { deploy: "never" } } })).toMatchObject({ copilot: true, deploy: false });
    // o aumento de teto: o padrão do settings (30%) liga; `maxPct: 0` desliga
    expect(legacyProfileOf({ autonomy: undefined }).spendRaise).toBe(true);
    expect(legacyProfileOf({ autonomy: undefined }, { autorun: { budgetRaise: { maxPct: 0 } } }).spendRaise).toBe(false);
  });

  it("as dependências NÃO são impostas ao legado: publicar sozinho num board humano segue publicando", () => {
    const p = autonomyProfileOf({ autonomy: { mode: "human" }, release: { mode: "auto" } });
    expect(p).toMatchObject({ delivery: false, publish: true });
    expect(releaseModeOf({ autonomy: { mode: "human" }, release: { mode: "auto" } })).toBe("auto");
  });

  it("o bloco explícito vence caixa a caixa; a caixa que ele não diz cai no legado", () => {
    const cfg: Cfg = { autonomy: { mode: "ultra", agentDecides: { design: false } }, release: { mode: "auto" } };
    expect(autonomyProfileOf(cfg)).toMatchObject({ spec: true, design: false, delivery: true, publish: true });
    expect(hasExplicitProfile(cfg)).toBe(true);
    expect(hasExplicitProfile({ autonomy: { mode: "ultra" } })).toBe(false);
  });

  it("o coerce aceita só booleanos de caixas conhecidas (uma grafia torta nunca liga uma caixa)", () => {
    expect(coerceAutonomy({ agentDecides: { deploy: "yes", publish: true, voar: true } })?.agentDecides).toEqual({ publish: true });
    expect(coerceAutonomy({ agentDecides: "tudo" })).toBeUndefined();
  });
});

describe("o nível que a tela mostra é honesto", () => {
  it("Máxima com a Sentinela desligada é «Personalizada», e diz o quanto difere («Máxima, sem a Sentinela»)", () => {
    const full: Cfg = { autonomy: { mode: "ultra" }, release: { mode: "auto" }, orchestrator: { mode: "autonomous", riskMatrix: { deploy: "auto" } } };
    const legacy = autonomyProfileOf(full);
    // o modo mais perto (para os leitores) segue Máxima; a TELA não diz Máxima com uma caixa dela desligada
    expect(presetOf(legacy, false)).toBe("maxima");
    expect(shownPresetOf(legacy)).toBe("personalizada");
    expect(presetGapWords(legacy)).toBe("Máxima, sem a Sentinela");
    expect(presetGapWords({ ...MAXIMA_PROFILE, sentinel: false, spendRaise: false })).toBe("Máxima, sem o aumento de teto e a Sentinela");
    expect(presetGapWords({ ...MAXIMA_PROFILE, deploy: false })).toBe("Máxima, sem «Fazer deploy»");
    expect(presetGapWords({ ...MINIMA_PROFILE, spendRaise: true })).toBe("Mínima, com o aumento de teto");
  });
  it("um modo pronto exato não tem diferença; longe dos dois, não há «perto»", () => {
    expect(shownPresetOf({ ...MAXIMA_PROFILE })).toBe("maxima");
    expect(presetGapWords({ ...MAXIMA_PROFILE })).toBeNull();
    expect(presetGapWords({ ...MINIMA_PROFILE })).toBeNull();
    expect(presetGapWords({ ...MINIMA_PROFILE, spec: true, design: true, delivery: true, copilot: true })).toBeNull();
  });
  it("o recibo diz o nível da tela", () => {
    expect(autonomyReceipt({ ...MAXIMA_PROFILE }, { ...MAXIMA_PROFILE, sentinel: false })).toMatch(/^Autonomia: Personalizada — /);
  });
});

describe("preset, dependências e mudanças", () => {
  it("Mínima, Máxima e Personalizada", () => {
    expect(presetOf({ ...MINIMA_PROFILE })).toBe("minima");
    expect(presetOf({ ...MAXIMA_PROFILE })).toBe("maxima");
    expect(presetOf({ ...MINIMA_PROFILE, design: true })).toBe("personalizada");
    // o legado de um board só-negócio sem o resto é Personalizada
    expect(presetOf(autonomyProfileOf({ autonomy: { mode: "ultra" } }), false)).toBe("personalizada");
  });

  it("um board legado lê como Mínima ou Máxima (o teto de gasto do settings GLOBAL e a Sentinela «em breve» não decidem)", () => {
    const human: Cfg = { autonomy: { mode: "human" } };
    expect(autonomyProfileOf(human).spendRaise).toBe(true); // o padrão global liga o aumento de teto em todo board…
    expect(presetOf(autonomyProfileOf(human), hasExplicitProfile(human))).toBe("minima"); // …e mesmo assim é Mínima
    const full: Cfg = { autonomy: { mode: "ultra" }, release: { mode: "auto" }, orchestrator: { mode: "autonomous", riskMatrix: { deploy: "auto" } } };
    expect(presetOf(autonomyProfileOf(full), hasExplicitProfile(full))).toBe("maxima");
    expect(presetOf(autonomyProfileOf(full, { autorun: { budgetRaise: { maxPct: 0 } } }), false)).toBe("maxima");
    // explícito, o teto de gasto conta (é escolha do board)
    expect(presetOf({ ...MAXIMA_PROFILE, spendRaise: false })).toBe("personalizada");
    // fase 6: a Sentinela é REAL — a Máxima a liga (conserto sob a trava dura), a Mínima não; no LEGADO ela não conta
    // (um board que já era Máxima não ganha o terminal dela sem o dono escolher pelo painel)
    expect(MAXIMA_PROFILE.sentinel).toBe(true);
    expect(MINIMA_PROFILE.sentinel).toBe(false);
    expect(presetOf({ ...MAXIMA_PROFILE, sentinel: false })).toBe("personalizada");
    expect(autonomyProfileOf(full).sentinel).toBe(false);
    const box = AUTONOMY_BOXES.find((b) => b.key === "sentinel");
    expect(box?.soon).toBeUndefined();
    expect(box?.effect).not.toMatch(/em breve/i);
    expect(box?.effect).toMatch(/trava/);
  });

  it("deploy exige publicar; publicar exige aprovar a entrega — a caixa diz o motivo", () => {
    expect(dependencyBlock({ ...MINIMA_PROFILE }, "deploy")).toMatch(/Publicar/);
    expect(dependencyBlock({ ...MINIMA_PROFILE }, "publish")).toMatch(/Aprovar a entrega/);
    expect(dependencyBlock({ ...MINIMA_PROFILE, delivery: true }, "publish")).toBeNull();
    expect(dependencyBlock({ ...MINIMA_PROFILE }, "spec")).toBeNull();
    // o conflito de um board legado é MOSTRADO (o dono escolhe), nunca corrigido em silêncio
    expect(profileConflicts({ ...MINIMA_PROFILE, publish: true })).toEqual([expect.stringMatching(/Publicar.*Aprovar a entrega/)]);
    expect(profileConflicts({ ...MAXIMA_PROFILE })).toEqual([]);
  });

  it("uma caixa num perfil legado INCOERENTE muda só ela (e a cadeia dela) — nenhuma outra vira", () => {
    const legacy: AutonomyProfile = { ...MINIMA_PROFILE, publish: true, spendRaise: true }; // publicar sem aprovar a entrega
    expect(applyAutonomyChange(legacy, { patch: { copilot: true } })).toEqual({ ...legacy, copilot: true });
    expect(applyAutonomyChange(legacy, { patch: { design: true } })).toEqual({ ...legacy, design: true });
    // a cadeia da caixa mexida, sim: ligar deploy liga as pré-requisito dele
    expect(applyAutonomyChange(legacy, { patch: { deploy: true } })).toEqual({ ...legacy, delivery: true, deploy: true });
  });

  it("ligar puxa as pré-requisito; desligar derruba as dependentes; o preset é inteiro", () => {
    expect(applyAutonomyChange({ ...MINIMA_PROFILE }, { patch: { deploy: true } })).toMatchObject({ delivery: true, publish: true, deploy: true, spec: false });
    expect(applyAutonomyChange({ ...MAXIMA_PROFILE }, { patch: { delivery: false } })).toMatchObject({ delivery: false, publish: false, deploy: false, spec: true });
    expect(applyAutonomyChange({ ...MINIMA_PROFILE, design: true }, { preset: "maxima" })).toEqual({ ...MAXIMA_PROFILE });
    expect(applyAutonomyChange({ ...MAXIMA_PROFILE }, { preset: "minima", patch: { design: true } })).toEqual({ ...MINIMA_PROFILE, design: true });
    // uma chave desconhecida é ignorada
    expect(applyAutonomyChange({ ...MINIMA_PROFILE }, { patch: { voar: true } as unknown as Partial<AgentDecides> })).toEqual({ ...MINIMA_PROFILE });
  });

  it("o recibo diz o que mudou, em palavras do dono", () => {
    expect(autonomyReceipt({ ...MINIMA_PROFILE, delivery: true }, { ...MINIMA_PROFILE, delivery: true, publish: true })).toBe("Autonomia: Personalizada — agora os agentes publicam sozinhos");
    expect(autonomyReceipt({ ...MAXIMA_PROFILE }, { ...MAXIMA_PROFILE })).toBe("Autonomia: Máxima — nada mudou");
  });

  it("cada caixa tem rótulo e efeito; a lista travada nomeia dinheiro (com o código de cobrança), marca, PRD, dados de pessoas e a trava", () => {
    expect(AUTONOMY_BOXES.map((b) => b.key)).toEqual([...AGENT_DECIDES_KEYS]);
    const ids = alwaysOwnerPoints(null).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["money", "brand-voice", "prd", "personal-data", "locked-exec", "kernel", "autonomy"]));
    expect(alwaysOwnerPoints(null).find((p) => p.id === "money")?.detail).toMatch(/código de cobrança/);
  });
});

describe("a escrita coerente", () => {
  const base: Cfg = { autonomy: { proxyModel: "sonnet" }, orchestrator: { mode: "paired", riskMatrix: { "write-board": "ask" } } };

  it("Máxima grava o bloco e as chaves de antes, e a matriz passa no lint", () => {
    const out = withAutonomyProfile(base, { ...MAXIMA_PROFILE });
    expect(out.autonomy).toMatchObject({ mode: "ultra", proxyModel: "sonnet", agentDecides: { ...MAXIMA_PROFILE } });
    expect(out.release?.mode).toBe("auto");
    expect(out.orchestrator?.mode).toBe("autonomous");
    expect(out.orchestrator?.riskMatrix?.deploy).toBe("auto");
    expect(lintRiskMatrix(out.orchestrator)).toEqual([]);
    // as chaves derivam de volta ao mesmo perfil (sem segunda verdade)
    expect(legacyProfileOf(out)).toMatchObject({ spec: true, publish: true, deploy: true, copilot: true });
  });

  it("Mínima grava tudo desligado; um `paired` existente fica; deploy nunca resolve auto", () => {
    const out = withAutonomyProfile(base, { ...MINIMA_PROFILE });
    expect(out.autonomy?.mode).toBe("human");
    expect(releaseModeOf(out)).toBe("manual");
    expect(out.release).toBeUndefined(); // o padrão já é manual: nada a escrever
    expect(out.orchestrator?.mode).toBe("paired");
    expect(out.orchestrator?.riskMatrix).toEqual({ "write-board": "ask" }); // nada mudou na matriz
    expect(dispositionFor(out.orchestrator, "deploy")).not.toBe("auto");
    expect(boardAutonomyMode(out)).toBe("human");
    expect(effectiveAutonomy(null, out).mode).toBe("human");
  });

  it("a matriz do board é DO BOARD: só `deploy` muda, e só a base do Copiloto entra num board sem matriz", () => {
    const strict: Cfg = { autonomy: undefined, orchestrator: { mode: "autonomous", riskMatrix: { "write-board": "ask", run: "never", deploy: "ask" } } };
    const raise = withAutonomyProfile(strict, { ...legacyProfileOf(strict), spendRaise: false });
    expect(raise.orchestrator?.riskMatrix).toEqual(strict.orchestrator?.riskMatrix); // uma caixa alheia não afrouxa nada
    const dep = withAutonomyProfile(strict, { ...legacyProfileOf(strict), delivery: true, publish: true, deploy: true });
    expect(dep.orchestrator?.riskMatrix).toEqual({ "write-board": "ask", run: "never", deploy: "auto" });
    // ligar deploy não liga exclusão nem aprovação de governança por tabela
    expect(dispositionFor(dep.orchestrator, "reversible-delete")).not.toBe("auto");
    expect(dispositionFor(dep.orchestrator, "peer-review")).not.toBe("auto");
    // board sem matriz que liga o copiloto: a base do Copiloto (o que o Jido pode no board)
    const bare: Cfg = { autonomy: undefined };
    const seeded = withAutonomyProfile(bare, { ...MINIMA_PROFILE, copilot: true });
    expect(seeded.orchestrator).toMatchObject({ mode: "autonomous", riskMatrix: { "write-board": "auto", "reversible-delete": "ask", "peer-review": "ask" } });
    expect(lintRiskMatrix(seeded.orchestrator)).toEqual([]);
    // uma caixa que não toca o copiloto não cria bloco de orquestração nenhum
    expect(withAutonomyProfile(bare, { ...MINIMA_PROFILE, design: true }).orchestrator).toBeUndefined();
  });

  it("a foto do «Desfazer» devolve as chaves EXATAMENTE como estavam — sem propagar, sem normalizar", () => {
    const legacy: Cfg = { autonomy: { proxyModel: "sonnet" }, release: { mode: "auto" } }; // publicar sem aprovar a entrega
    const snap = autonomySnapshotOf(legacy);
    const after = withAutonomyProfile(legacy, applyAutonomyChange(autonomyProfileOf(legacy), { patch: { copilot: true } }));
    expect(after.autonomy?.agentDecides).toMatchObject({ publish: true, delivery: false, copilot: true });
    const back = withAutonomySnapshot(after, JSON.parse(JSON.stringify(snap)));
    expect(back).toEqual(legacy);
    expect(autonomyProfileOf(back)).toMatchObject({ publish: true, delivery: false, copilot: false });
    // uma grafia torta na foto (ela vem do cliente) é descartada, nunca gravada
    const forged = withAutonomySnapshot(legacy, { ...snap, hasOrchestrator: true, orchestratorMode: "voar" as never, riskMatrix: { deploy: "sempre" as never } });
    expect(forged.orchestrator).toEqual({ mode: "off" });
  });

  it("o copiloto desligado tira o `autonomous`; o perfil explícito vence um `mode` escrito à mão", () => {
    expect(withAutonomyProfile({ autonomy: undefined, orchestrator: { mode: "autonomous" } }, { ...MINIMA_PROFILE }).orchestrator?.mode).toBe("off");
    expect(boardAutonomyMode({ autonomy: { mode: "human", agentDecides: { design: true } } })).toBe("ultra");
  });

  it("a guarda do perfil só aperta: deploy desligado no bloco explícito nunca resolve auto", () => {
    expect(clampByProfile(explicit({ deploy: false }), "deploy", "auto")).toBe("ask");
    expect(clampByProfile(explicit({ deploy: true }), "deploy", "auto")).toBe("auto");
    expect(clampByProfile({ autonomy: undefined }, "deploy", "auto")).toBe("auto"); // legado: a matriz manda
    expect(clampByProfile(explicit({ deploy: false }), "write-board", "auto")).toBe("auto");
  });

  it("publicar: com o bloco explícito, a caixa vence um `release.mode` editado à mão", () => {
    expect(releaseModeOf({ autonomy: { agentDecides: { publish: false } }, release: { mode: "auto" } })).toBe("manual");
    expect(releaseModeOf({ autonomy: { agentDecides: { publish: true } }, release: { mode: "manual" } })).toBe("auto");
  });

  it("a impressão digital muda quando a autonomia muda (a porta genérica recusa isso de um agente)", () => {
    const a = withAutonomyProfile(base, { ...MINIMA_PROFILE });
    expect(autonomyKeysFingerprint(a)).toBe(autonomyKeysFingerprint({ ...a }));
    expect(autonomyKeysFingerprint(a)).not.toBe(autonomyKeysFingerprint(withAutonomyProfile(base, { ...MINIMA_PROFILE, design: true })));
  });

  it("o merge train devolve a autonomia de main quando um worktree a muda no board.yaml", () => {
    const live = "id: demo\nautonomy:\n  agentDecides:\n    publish: false\n";
    const landed = "id: demo\nname: Livraria\nautonomy:\n  agentDecides:\n    publish: true\n";
    expect(restoreGovernanceKeys(landed, live)).toBe(live);
    expect(restoreGovernanceKeys("id: demo\nname: Livraria\nautonomy:\n  agentDecides:\n    publish: false\n", live)).toBeNull();
  });

  it("um board.yaml NOVO vindo de um worktree nasce sem autonomia de agente", () => {
    const created = "id: vitrine\nname: Vitrine\nautonomy:\n  mode: ultra\n  agentDecides:\n    deploy: true\nrelease:\n  mode: auto\norchestrator:\n  mode: autonomous\n  riskMatrix:\n    deploy: auto\n";
    const fixed = restoreGovernanceKeys(created, null);
    expect(fixed).not.toBeNull();
    expect(autonomyProfileOf(parseYaml(fixed!))).toEqual({ ...autonomyProfileOf({ autonomy: undefined }) });
    expect(presetOf(autonomyProfileOf(parseYaml(fixed!)), false)).toBe("minima");
    expect(fixed).toContain("name: Vitrine");
    // nada de autonomia ⇒ o texto fica byte a byte
    expect(stripAgentAutonomy("id: vitrine\nname: Vitrine\nrelease:\n  mode: manual\n")).toBeNull();
    expect(restoreGovernanceKeys("id: vitrine\nname: Vitrine\n", null)).toBeNull();
  });

  it("a exceção de autonomia do CARD volta à de main; card novo nasce sem exceção", () => {
    expect(restoreCardGovernance(card({ autonomyMode: "ultra" }), { autonomyMode: null, ownerReviewsUi: false })?.autonomyMode).toBeUndefined();
    expect(restoreCardGovernance(card({ autonomyMode: "ultra" }), { autonomyMode: "human", ownerReviewsUi: false })?.autonomyMode).toBe("human");
    expect(restoreCardGovernance(card({ ownerReviewsUi: false }), { autonomyMode: null, ownerReviewsUi: true })?.ownerReviewsUi).toBe(true);
    expect(restoreCardGovernance(card({ autonomyMode: "ultra" }), null)?.autonomyMode).toBeUndefined();
    expect(restoreCardGovernance(card({ ownerReviewsUi: true }), null)).toBeNull(); // pedir para ver as telas só aperta
    expect(restoreCardGovernance(card({ autonomyMode: "human" }), { autonomyMode: "human", ownerReviewsUi: false })).toBeNull();
  });
});

describe("o procurador com ESCOPO e o `whoDecides` granular", () => {
  it("cada categoria pela sua caixa: entrevista/técnica ⇒ spec; tela ⇒ design; entrega ⇒ delivery", () => {
    const onlySpec = explicit({ spec: true });
    expect(proxyRefusal(q({ category: "technical" }), card(), onlySpec)).toBeNull();
    expect(proxyRefusal(q({ category: "interview" }), card(), onlySpec)).toBeNull();
    expect(proxyRefusal(q({ category: "ui-choice" }), card(), onlySpec)).toMatch(/Escolher a tela/);
    expect(proxyRefusal(q({ category: "delivery" }), card(), onlySpec)).toMatch(/Aprovar a entrega/);
    expect(whoDecides({ kind: "question", question: q({ category: "technical" }) }, card(), onlySpec).decider).toBe("system");
    expect(whoDecides({ kind: "question", question: q({ category: "ui-choice" }) }, card(), onlySpec).decider).toBe("owner");
    expect(whoDecides({ kind: "ui-choice" }, card(), onlySpec).decider).toBe("owner");
    expect(whoDecides({ kind: "ui-choice" }, card(), explicit({ design: true })).decider).toBe("system");
  });

  it("Mínima: nada vai ao procurador e todo ponto é do dono", () => {
    expect(proxyRefusal(q({ category: "technical" }), card(), allOff)).toBe("story em modo human");
    for (const point of [{ kind: "question", question: q({ category: "technical" }) }, { kind: "ui-choice" }, { kind: "gate", deliveryApproval: true }, { kind: "triage-review" }] as DecisionPoint[]) {
      expect(whoDecides(point, card(), allOff).decider).toBe("owner");
    }
  });

  it("a exceção do card sobrepõe as três caixas de story", () => {
    expect(storyDecides(card({ autonomyMode: "ultra" }), allOff, "delivery")).toBe(true);
    expect(storyDecides(card({ autonomyMode: "human" }), allOn, "spec")).toBe(false);
    expect(proxyRefusal(q({ category: "technical" }), card({ autonomyMode: "human" }), allOn)).toBe("story em modo human");
  });

  it("o piso vale com categoria declarada: dinheiro e marca nunca vão ao procurador", () => {
    expect(proxyRefusal(q({ category: "technical", text: "Qual fornecedor de busca contratamos?" }), card(), allOn)).toMatch(/dinheiro/);
    expect(proxyRefusal(q({ category: "interview", text: "Anunciamos a vitrine nas redes sociais?" }), card(), allOn)).toMatch(/marca/);
    expect(ownerFloorClass(q({ category: "interview", text: "Mandamos newsletter para toda a base?" }))).toBe("brand-voice");
    // o board que não declara a classe de marca não ganha o piso dela
    const noBrand: Cfg = { autonomy: { ...allOn.autonomy, ownerClasses: [{ id: "money", label: "Dinheiro", description: "" }] } };
    expect(ownerFloorClass(q({ text: "Postamos nas redes sociais?" }), noBrand)).toBeNull();
  });

  it("o card que toca uma classe do dono: nenhuma pergunta dele vai ao procurador", () => {
    const touched = card({ businessClasses: { ids: ["personal-data"], reason: "guarda o e-mail do leitor", by: "harness-conductor", at: "2026-10-06" } });
    expect(proxyRefusal(q({ category: "technical" }), touched, allOn)).toMatch(/Dados de pessoas/);
    expect(whoDecides({ kind: "question", question: q({ category: "technical" }) }, touched, allOn)).toMatchObject({ decider: "owner", ownerClass: "personal-data" });
  });

  it("reaberta ou devolvida é do dono para sempre; `guardrail` é do dono até existir o revisor de diff — nunca do procurador", () => {
    expect(proxyRefusal(q({ category: "technical", proxy: { assumptions: "x", confidence: 0.9, auditOutcome: "reopened" } }), card(), allOn)).toMatch(/reabriu/);
    expect(proxyRefusal(q({ category: "technical", proxy: { assumptions: "x", confidence: 0, declined: true } }), card(), allOn)).toMatch(/devolveu/);
    expect(proxyRefusal(q({ category: "guardrail" }), card(), allOn)).toMatch(/revisor de diff/);
    expect(whoDecides({ kind: "question", question: q({ category: "guardrail" }) }, card(), allOn)).toMatchObject({ decider: "owner" });
    // nenhum agente a responde pelo MCP — nem quem perguntou
    expect(agentAnswerRefusal(q({ category: "guardrail" }), allOn, card())).toMatch(/revisor de diff/);
    expect(agentAnswerRefusal(q({ category: "guardrail" }), allOn)).toMatch(/revisor de diff/);
  });

  it("as caixas NÃO vazam: só «escolher a tela» ligada deixa o «vai» do plano e o técnico com o dono", () => {
    const designOnly = explicit({ ...MINIMA_PROFILE, design: true });
    expect(whoDecides({ kind: "ui-choice" }, card(), designOnly).decider).toBe("system");
    for (const point of [{ kind: "gate" }, { kind: "triage-review" }, { kind: "approval", riskClass: "run" }, { kind: "dilemma" }, { kind: "recovery" }, { kind: "code-change" }] as DecisionPoint[]) {
      expect(whoDecides(point, card(), designOnly), point.kind).toMatchObject({ decider: "owner", reason: expect.stringMatching(/Aprovar o plano/) });
    }
    // com `spec`, o passo técnico volta ao sistema
    expect(whoDecides({ kind: "gate" }, card(), explicit({ spec: true })).decider).toBe("system");
    // o legado `ultra` (as três ligadas) segue igual
    expect(whoDecides({ kind: "gate" }, card(), { autonomy: { mode: "ultra" } }).decider).toBe("system");
  });

  it("o MCP respeita o perfil: um agente escopado não responde a decisão cuja caixa está desligada", () => {
    expect(agentAnswerRefusal(q({ category: "technical" }), allOff, card())).toMatch(/autonomia deste board/);
    expect(agentAnswerRefusal(q({ category: "ui-choice" }), explicit({ spec: true }), card())).toMatch(/Escolher a tela/);
    expect(agentAnswerRefusal(q({ category: "technical" }), explicit({ spec: true }), card())).toBeNull();
    expect(agentAnswerRefusal(q({ category: "technical" }), allOff, card({ autonomyMode: "ultra" }))).toBeNull(); // a exceção do card
    expect(agentAnswerRefusal(q({ category: "technical" }), allOff)).toBeNull(); // o token do operador (sem card) responde por ele
    // a mesma régua para o Inbox e o tick: o Jido não «pega» o que a tool recusaria
    expect(agentMayTakeQuestion("technical", card(), allOff)).toBe(false);
    expect(agentMayTakeQuestion("guardrail", card(), allOn)).toBe(false);
    expect(agentMayTakeQuestion("technical", card(), allOn)).toBe(true);
    expect(agentMayTakeQuestion(undefined, card(), allOff)).toBe(true); // sem caixa: a régua do kind decide
  });

  it("um agente nunca sobrescreve a resposta do dono", () => {
    expect(agentAnswerRefusal(q({ status: "answered", answer: "A estante de clássicos" }))).toMatch(/já respondeu/);
    expect(agentAnswerRefusal(q({ status: "answered", answer: "x", answeredBy: "operator" }))).toMatch(/já respondeu/);
    expect(agentAnswerRefusal(q({ status: "answered", answer: "x", answeredBy: "proxy" }))).toBeNull();
    expect(agentAnswerRefusal(q({ category: "technical" }))).toBeNull();
    expect(agentAnswerRefusal(q({ category: "money" }))).toMatch(/só do dono/);
    expect(isOwnerDecisionQuestion(q({ category: "technical", text: "Validamos o formato do e-mail no cadastro?" }))).toBe(false);
    expect(isOwnerDecisionQuestion(q({ category: "technical", text: "Mandamos e-mail em massa sobre a vitrine?" }))).toBe(true);
  });

  it("código de cobrança é do dono em qualquer modo; mudar teste existente vai ao revisor de diff", () => {
    const files = [
      { path: "src/billing/charge.ts", status: "M" },
      { path: "src/catalog/shelf.test.ts", status: "M" },
    ];
    expect(touchesBillingCode(files)).toBe(true);
    expect(touchesBillingCode([{ path: "src/catalog/shelf.ts" }])).toBe(false);
    expect(changesExistingTests(files)).toBe(true);
    expect(changesExistingTests([{ path: "src/catalog/new-shelf.test.ts", status: "A" }])).toBe(false);
    expect(whoDecides(codeChangePoint(files), card(), allOn)).toMatchObject({ decider: "owner", ownerClass: "money" });
    expect(whoDecides(codeChangePoint([{ path: "src/catalog/shelf.test.ts", status: "D" }]), card(), allOn)).toMatchObject({ decider: "owner" });
    expect(whoDecides(codeChangePoint([{ path: "src/catalog/shelf.test.ts", status: "D" }]), card(), allOn).reason).toMatch(/revisor de diff/);
    expect(parseNameStatus("M\tsrc/billing/charge.ts\nA\tsrc/catalog/new.test.ts\n")).toEqual([
      { path: "src/billing/charge.ts", status: "M" },
      { path: "src/catalog/new.test.ts", status: "A" },
    ]);
  });

  it("configuração dos AGENTES (skills, agentes, comandos, hooks, MCP, permissões) no diff ⇒ do dono, com pergunta própria", () => {
    const skill = [{ path: ".claude/skills/harness-conductor/ref/ultra-autonomy.md", status: "M" }];
    expect(changesAgentConfig(skill)).toBe(true);
    for (const p of [".claude/agents/revisor.md", ".claude/commands/x.md", "packages/app/.claude/hooks/pre.js", ".mcp.json", ".claude/settings.local.json"]) {
      expect(changesAgentConfig([{ path: p }]), p).toBe(true);
    }
    // e as REGRAS que os agentes leem e o que o serviço executa ou obedece em nome deles
    for (const p of [
      "CLAUDE.md",
      "packages/app/.claude/CLAUDE.md",
      "packages/app/CLAUDE.md",
      ".claude/rules/seguranca.md",
      "storymap/settings.yaml",
      "justfile",
      "scripts/deploy/classes/app.yaml",
      "scripts/git-hooks/scan-secrets.mjs",
    ]) {
      expect(changesAgentConfig([{ path: p }]), p).toBe(true);
    }
    expect(changesAgentConfig([{ path: "docs/claude-skills.md" }, { path: "src/catalog/.claude-cache.json" }])).toBe(false);
    expect(changesAgentConfig([{ path: "docs/CLAUDE-notes.txt" }, { path: "storymap/boards/demo/board.yaml" }])).toBe(false);
    // em qualquer modo, com tudo ligado: um agente não reescreve a regra que o próximo vai obedecer
    expect(whoDecides(codeChangePoint(skill), card(), allOn)).toMatchObject({ decider: "owner" });
    // e o motivo não promete um revisor que, por desenho, nunca responde estas perguntas
    expect(whoDecides(codeChangePoint(skill), card(), allOn).reason).not.toMatch(/até existir/);
    const marked = withCodeChangeMarks(card(), [...skill, { path: "src/catalog/shelf.test.ts", status: "M" }], "run-ex9103", "2026-10-07T10:00:00.000Z");
    // DUAS perguntas guardrail (testes e agentes), cada uma idempotente pelo seu rótulo
    expect(marked?.questions?.filter((q) => q.category === "guardrail")).toHaveLength(2);
    expect(marked?.questions?.some((q) => q.context?.includes("ultra-autonomy.md"))).toBe(true);
    expect(withCodeChangeMarks(marked!, skill, "run-ex9103", "2026-10-07T11:00:00.000Z")).toBeNull();
  });

  it("o train marca o card pelo diff: cobrança ⇒ toca «dinheiro» (a publicação espera o dono); teste existente ⇒ pergunta ao dono", () => {
    const files = [
      { path: "src/billing/charge.ts", status: "M" },
      { path: "src/catalog/shelf.test.ts", status: "M" },
    ];
    const marked = withCodeChangeMarks(card(), files, "run-ex9101", "2026-10-07T10:00:00.000Z");
    expect(marked?.businessClasses).toMatchObject({ ids: ["money"], by: "merge-train" });
    expect(marked?.questions).toEqual([expect.objectContaining({ category: "guardrail", status: "open", context: expect.stringContaining("shelf.test.ts") })]);
    expect(withCodeChangeMarks(marked!, files, "run-ex9101", "2026-10-07T11:00:00.000Z")).toBeNull(); // idempotente por run
    expect(withCodeChangeMarks(card(), [{ path: "src/catalog/shelf.ts", status: "M" }], "run-ex9102", "2026-10-07T10:00:00.000Z")).toBeNull();
    // com tudo ligado, a trava rumo ao ar segura o card marcado (agente nenhum o leva a Publicar)
    const statuses = [
      { id: "construir", label: "Construir" },
      { id: "aprovar-entrega", label: "Aprovar entrega", gate: "hasQaPassed" },
      { id: "publicar", label: "Publicar", onEnter: "promote-and-deploy" },
    ] as unknown as BoardConfig["statuses"];
    const cfg = { ...allOn, statuses };
    expect(ownerPublishHold(card(), statuses[1], statuses[2], cfg)).toBeNull();
    expect(ownerPublishHold(withCodeChangeMarks(card(), [files[0]], "run-ex9101", "2026-10-07T10:00:00.000Z")!, statuses[1], statuses[2], cfg)).toMatch(/Dinheiro/);
    expect(ownerPublishHold(withCodeChangeMarks(card(), [files[1]], "run-ex9101", "2026-10-07T10:00:00.000Z")!, statuses[1], statuses[2], cfg)).toMatch(/mudou testes/);
  });
});

describe("TUDO LIGADO não libera nada do dono", () => {
  const owned: Array<[string, DecisionPoint, Partial<Card>?]> = [
    ["pergunta de dinheiro", { kind: "question", question: q({ category: "money", text: "Assinamos o plano pago do catálogo?" }) }],
    ["palavra de dinheiro com categoria técnica", { kind: "question", question: q({ category: "technical", text: "Qual o preço do frete?" }) }],
    ["marca fora do produto", { kind: "question", question: q({ category: "interview", text: "Postamos o lançamento no instagram?" }) }],
    ["decisão de negócio declarada", { kind: "question", question: q({ category: "owner", ownerClass: "prd" }) }],
    ["marcador [humano]", { kind: "question", question: q({ category: "technical", text: "[humano] Seguimos?" }) }],
    ["pergunta sem categoria", { kind: "question", question: q({}) }],
    ["reaberta numa auditoria", { kind: "question", question: q({ category: "technical", proxy: { assumptions: "x", confidence: 0.9, auditOutcome: "reopened" } }) }],
    ["devolvida pelo procurador", { kind: "question", question: q({ category: "technical", proxy: { assumptions: "x", confidence: 0, declined: true } }) }],
    ["governança (PRD e metas)", { kind: "governance" }],
    ["apagar dados de pessoas", { kind: "data-deletion" }],
    ["comando travado («Aprovar e rodar»)", { kind: "locked-exec" }],
    ["shell livre", { kind: "approval", riskClass: "run-free" }],
    ["ação irreversível", { kind: "approval", riskClass: "destructive" }],
    ["dilema que toca dinheiro", { kind: "dilemma", ownerClass: "money" }],
    ["publicação que toca dinheiro", { kind: "deploy-hold", cause: { ownerClass: "money", decider: "owner", rules: ["paid-api"], units: ["api"] } }],
    ["publicação sem causa registrada", { kind: "deploy-hold", cause: null }],
    ["código de cobrança", { kind: "code-change", billing: true }],
    ["a captura do dono", { kind: "capture-proposal" }],
    ["entrega parada em «Aprovar entrega»", { kind: "gate", deliveryApproval: true }],
    ["mudar um teste existente (pergunta)", { kind: "question", question: q({ category: "guardrail" }) }],
    ["mudar um teste existente (diff)", { kind: "code-change", existingTests: true }],
    ["card que toca dados de pessoas (gate)", { kind: "gate" }, { businessClasses: { ids: ["personal-data"], reason: "x", by: "j", at: "2026-10-06" } }],
    ["escolha de tela que o dono pediu", { kind: "ui-choice" }, { ownerReviewsUi: true }],
  ];

  for (const [label, point, over] of owned) {
    it(`${label}: segue do dono com Máxima`, () => {
      expect(whoDecides(point, card(over ?? {}), allOn).decider).toBe("owner");
    });
  }

  it("e o procurador não pega nenhuma pergunta do dono com Máxima", () => {
    for (const [, point, over] of owned) {
      if (point.kind !== "question") continue;
      expect(proxyRefusal({ ...q({}), ...point.question, status: "open" } as CardQuestion, card(over ?? {}), allOn)).not.toBeNull();
    }
  });
});

describe("o teto de gasto: a caixa e o teto por tipo de card", () => {
  const pace = { onPace: true, detail: "no ritmo" };
  it("com a caixa desligada todo aumento é do dono; ligada, a régua de sempre", () => {
    const c = card();
    expect(judgeBudgetRequest({ capUSD: 20, card: c, toUSD: 24, pace, settings: DEFAULT_BUDGET_RAISE, spendRaise: false })).toMatchObject({ kind: "owner", why: expect.stringMatching(/autonomia/) });
    expect(judgeBudgetRequest({ capUSD: 20, card: c, toUSD: 24, pace, settings: DEFAULT_BUDGET_RAISE, spendRaise: true }).kind).toBe("approved");
    expect(judgeBudgetRequest({ capUSD: 20, card: c, toUSD: 24, pace, settings: DEFAULT_BUDGET_RAISE }).kind).toBe("approved"); // legado
  });

  it("o teto do card é o menor entre o do settings e o do tipo: US$ 30 história, US$ 10 conserto", () => {
    expect(cardSpendCeilingUSD(card())).toBe(30);
    expect(cardSpendCeilingUSD(card({ storyType: "bug" }))).toBe(10);
    expect(cardSpendCeilingUSD(card({ mode: "fix" }))).toBe(10);
    expect(cardCapUSD(55, card())).toBe(30);
    expect(cardCapUSD(55, card({ storyType: "bug" }))).toBe(10);
    expect(cardCapUSD(8, card({ storyType: "bug" }))).toBe(8);
    expect(cardCapUSD(undefined, card())).toBeNull(); // sem teto no alvo, nenhum (opt-in)
  });
});

// O perfil é um tipo só: o compilador garante que Mínima e Máxima nomeiam toda caixa.
const _exhaustive: AutonomyProfile[] = [MINIMA_PROFILE, MAXIMA_PROFILE];
void _exhaustive;
