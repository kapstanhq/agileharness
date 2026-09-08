import { describe, expect, it } from "vitest";
import type { OrchestratorPolicy } from "@/lib/storymap/types";
import {
  AUTONOMO_DOCTRINE_VERSION,
  copilotTier,
  DEPLOY_AUTONOMY_ENABLED,
  resolutionDoctrineBlock,
  tierMatrix,
  tierMode,
  tierPersonaClause,
  tierStance,
  tierUnlocked,
  TIER_META,
  peerReviewAllowed,
  deleteAutonomyAllowed,
  liberdadeDoctrineBlock,
  PEER_REVIEW_ENABLED,
  DELETE_AUTONOMY_ENABLED,
  stewardPlaybooksBlock,
} from "./tier";

const pol = (p: Partial<OrchestratorPolicy>): OrchestratorPolicy => ({ mode: "off", ...p });

describe("copilotTier — projection over (mode, riskMatrix.deploy)", () => {
  it("chat when not autonomous (off/paired/absent)", () => {
    expect(copilotTier(null)).toBe("chat");
    expect(copilotTier(undefined)).toBe("chat");
    expect(copilotTier(pol({ mode: "off" }))).toBe("chat");
    expect(copilotTier(pol({ mode: "paired" }))).toBe("chat"); // legacy paired renders as Chat
  });

  it("copiloto when autonomous and deploy is not auto (ask, never, or silent→never)", () => {
    expect(copilotTier(pol({ mode: "autonomous" }))).toBe("copiloto"); // deploy silent ⇒ default never ⇒ copiloto
    expect(copilotTier(pol({ mode: "autonomous", riskMatrix: { deploy: "ask" } }))).toBe("copiloto");
    expect(copilotTier(pol({ mode: "autonomous", riskMatrix: { deploy: "never" } }))).toBe("copiloto");
  });

  it("autonomo only when autonomous and deploy resolves to auto", () => {
    expect(copilotTier(pol({ mode: "autonomous", riskMatrix: { deploy: "auto" } }))).toBe("autonomo");
  });

  it("acme's real matrix today derives to Jido", () => {
    const acme = pol({
      mode: "autonomous",
      riskMatrix: { read: "auto", "write-board": "auto", run: "auto", "merge-resolve": "auto", deploy: "ask", "run-free": "ask", destructive: "never" },
    });
    expect(copilotTier(acme)).toBe("copiloto");
  });
});

describe("tierMode", () => {
  it("chat→off, active tiers→autonomous", () => {
    expect(tierMode("chat")).toBe("off");
    expect(tierMode("copiloto")).toBe("autonomous");
    expect(tierMode("autonomo")).toBe("autonomous");
  });
});

describe("tierUnlocked — Autônomo gated by DEPLOY_AUTONOMY_ENABLED", () => {
  it("chat and copiloto are always selectable", () => {
    expect(tierUnlocked("chat")).toBe(true);
    expect(tierUnlocked("copiloto")).toBe(true);
  });
  it("autônomo follows the deploy-autonomy gate", () => {
    expect(tierUnlocked("autonomo")).toBe(DEPLOY_AUTONOMY_ENABLED);
  });
});

describe("tierMatrix — canonical writes + kernel invariants", () => {
  it("copiloto: board powers auto, deploy asks, shell/undo human-only", () => {
    const m = tierMatrix("copiloto");
    expect(m["write-board"]).toBe("auto");
    expect(m.run).toBe("auto");
    expect(m["merge-resolve"]).toBe("auto");
    expect(m.deploy).toBe("ask");
    expect(m["run-free"]).toBe("ask");
    expect(m.destructive).toBe("never");
  });

  it("autônomo: deploy tracks the gate (auto only when enabled), otherwise held to ask", () => {
    expect(tierMatrix("autonomo").deploy).toBe(DEPLOY_AUTONOMY_ENABLED ? "auto" : "ask");
  });

  it("NEVER_AUTO invariants hold in EVERY tier matrix (no shell, no undo-less)", () => {
    for (const tier of ["copiloto", "autonomo"] as const) {
      const m = tierMatrix(tier);
      expect(m["run-free"]).not.toBe("auto");
      expect(m.destructive).toBe("never");
    }
  });
});

describe("TIER_META", () => {
  it("has label + short + hint for all three tiers", () => {
    for (const tier of ["chat", "copiloto", "autonomo"] as const) {
      expect(TIER_META[tier].label).toBeTruthy();
      expect(TIER_META[tier].hint.length).toBeGreaterThan(10);
      // `short` é o que o seletor de modo MOSTRA em cada opção — sem ele a opção vira um rótulo mudo, e
      // com o `hint` inteiro vira uma parede. Curto de verdade: uma linha que cabe ao lado do rótulo.
      expect(TIER_META[tier].short.length).toBeGreaterThan(10);
      expect(TIER_META[tier].short.length).toBeLessThanOrEqual(70);
    }
  });
});

describe("tierStance / tierPersonaClause — behavioral stance (gated by DEPLOY_AUTONOMY_ENABLED)", () => {
  it("chat and copiloto always get the conservative (defer + propose) stance", () => {
    for (const t of ["chat", "copiloto"] as const) {
      const s = tierStance(t);
      expect(s).toMatch(/NÃO decida/i);
      expect(s).toMatch(/DECISÃO HUMANA/i);
    }
  });

  it("autônomo stance tracks the gate — decide+publish only when unlocked, else conservative", () => {
    const s = tierStance("autonomo");
    if (DEPLOY_AUTONOMY_ENABLED) {
      expect(s).toMatch(/PUBLICAR/i);
      expect(s).toMatch(/run-free|shell/i); // shell/undo stay human even in autônomo
    } else {
      expect(s).toMatch(/NÃO decida/i); // held ⇒ same conservative stance as copiloto
    }
  });

  it("persona clause names the operative mode and carries its stance", () => {
    const clause = tierPersonaClause("copiloto");
    expect(clause).toMatch(/## Modo atual: Copiloto/);
    expect(clause).toContain(tierStance("copiloto"));
  });
});

// ── A doutrina de RESOLUÇÃO (o conserto do incidente acme/story-novo-item) ────────────────────────────────
// A stance sozinha já autorizava decidir, e mesmo assim o tick Autônomo leu 2 perguntas com options+pros/cons,
// chamou-as de dúvida de negócio e deferiu ("both branches terminate in you"). O que falta a uma stance é a
// RÉGUA de quando o caminho é claro; é ela que estes testes fixam.
describe("resolutionDoctrineBlock — a régua de decidir por FORMA, não por intuição", () => {
  it("só o Autônomo recebe a doutrina — deferir no Copiloto/Chat é o comportamento CERTO, não uma omissão", () => {
    expect(resolutionDoctrineBlock("copiloto")).toBe("");
    expect(resolutionDoctrineBlock("chat")).toBe("");
    if (DEPLOY_AUTONOMY_ENABLED) expect(resolutionDoctrineBlock("autonomo")).not.toBe("");
  });

  it("nomeia a régua da FORMA (pergunta com options ⇒ decida) e fecha a válvula de escape do incidente", () => {
    if (!DEPLOY_AUTONOMY_ENABLED) return;
    const d = resolutionDoctrineBlock("autonomo");
    expect(d).toMatch(/options/i); // a FORMA é a régua — não "quando você achar claro"
    expect(d).toMatch(/answer_question/); // e o ato tem nome
    // a frase EXATA com que o tick real deferiu, agora explicitamente recusada como motivo
    expect(d).toMatch(/terminam no humano/i);
  });

  it("manda JULGAR a recomendada, nunca carimbá-la — em q1 o Operador contrariou a `recommended`", () => {
    if (!DEPLOY_AUTONOMY_ENABLED) return;
    const d = resolutionDoctrineBlock("autonomo");
    expect(d).toMatch(/recommended/);
    expect(d).toMatch(/default/i); // default rebatível…
    expect(d).toMatch(/contrarie|julgue/i); // …e o dever de contrariá-la quando o card a contradiz
  });

  it("dá desfecho aos AVISOS pelos 3 status, e proíbe as duas saídas falsas (card paralelo / fixed mentiroso)", () => {
    if (!DEPLOY_AUTONOMY_ENABLED) return;
    const d = resolutionDoctrineBlock("autonomo");
    for (const status of ["acknowledged", "wontfix", "desenvolver"]) expect(d).toContain(status);
    expect(d).toMatch(/triage_finding/);
    expect(d).toMatch(/NUNCA um card paralelo/i);
    expect(d).toMatch(/NUNCA `fixed`/i);
  });

  it("a persona do chat CARREGA a doutrina no Autônomo (as duas superfícies leem a mesma régua)", () => {
    if (!DEPLOY_AUTONOMY_ENABLED) return;
    expect(tierPersonaClause("autonomo")).toContain(resolutionDoctrineBlock("autonomo"));
    expect(tierPersonaClause("copiloto")).not.toMatch(/Resolver o que está aberto/);
  });
});

// autonomy-endgame WS-4.1 — A GUARDA DE DISCIPLINA da versão de doutrina.
//
// AUTONOMO_DOCTRINE_VERSION re-arma o backoff de TODO item deferido sob a versão anterior. Isso a torna uma
// DECISÃO DE PRODUTO sobre o comportamento do agente — não um número de build. Os dois erros que essa guarda
// existe para pegar, e que nada além dela pegaria:
//
//   1. BUMP SEM MUDANÇA DE DOUTRINA (um refactor que "arruma" a versão de passagem) ⇒ re-arma o board inteiro
//      de graça, e o cap vira ruído.
//   2. MUDANÇA DE DOUTRINA SEM BUMP ⇒ pior: a regra nova existe e os itens que ela foi escrita para decidir
//      seguem presos sob a regra velha. É EXATAMENTE o bug de 2026-07-17 que este WS conserta — o fix que não
//      alcança as próprias vítimas.
//
// O par (versão, digest da doutrina) é fixado JUNTO: mexer em um sem o outro fica vermelho, e o único jeito de
// ficar verde é um humano olhar os dois e decidir. Se você chegou aqui por um teste vermelho: mudou a
// DOUTRINA? então suba a versão E atualize o digest. Só reescreveu prosa sem mudar o que o tick DEVE fazer?
// então NÃO suba a versão — atualize só o digest.
describe("WS-4.1 — a versão da doutrina é uma decisão, não um número de build", () => {
  /** djb2 — estável, sem dependência, e só precisa detectar MUDANÇA (não é segurança). */
  const digest = (s: string): string => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(16);
  };

  it("o par (versão, doutrina) está sincronizado — bump sem mudança, ou mudança sem bump, fica VERMELHO", () => {
    const doctrine = resolutionDoctrineBlock("autonomo");
    // 2026-08-27.renomeacao-harness — bump de RENOMEAÇÃO, e o comentário diz isso porque a guarda não
    // sabe distinguir: as skills `usm-*` viraram `harness-*` e a doutrina as CITA pelo nome, então o
    // digest mudou sem que uma única regra de comportamento mudasse. Um bump destes é o caso em que a
    // catraca cobra a coisa certa (a doutrina mudou de bytes) pela razão errada — registrar isso aqui é
    // o que impede o próximo leitor de caçar uma mudança semântica que não existe.
    //
    // 2026-07-21.steward-stage-divergente — os playbooks do steward ganharam a receita de stage↔main
    // divergente (reconcile_stage sync + resolve_merge requeue É do agente; só `diverged` real escala) e a
    // do done-que-mente (confirmar aterrissagem por CONTEÚDO; recuperar por requeue). Bump LEGÍTIMO: muda o
    // que o tick DEVE fazer diante de entrega travada (classe que era defer-sempre) — e re-arma, por desenho
    // (WS-4), os itens deferidos sob a regra velha (o caso vivo: acme/story-tlz0dt, 3 implementações mortas
    // no muro do sync). A doutrina de RESOLUÇÃO não mudou (digest igual); a mudança está nos playbooks,
    // agora TAMBÉM fixados por digest abaixo.
    expect(AUTONOMO_DOCTRINE_VERSION).toBe("2026-08-27.renomeacao-harness");
    expect(digest(doctrine)).toBe("47a70ca2");
  });

  it("os playbooks do steward também são doutrina — mudá-los sem olhar a versão fica VERMELHO", () => {
    // Mesma disciplina do par acima, estendida ao bloco que a guarda original não cobria: os playbooks
    // mudam o que o tick FAZ (agir × escalar) tanto quanto a doutrina de resolução. Se este digest quebrou:
    // mudou o COMPORTAMENTO? suba AUTONOMO_DOCTRINE_VERSION junto. Só prosa? atualize só o digest.
    // 2026-07-25 — a superfície "Pilotagem" passou a se chamar INBOX (rename de UI, rota inclusa). O
    // playbook cita a superfície pelo nome, então o digest mudou SEM que o tick passe a fazer nada
    // diferente: prosa pura ⇒ digest novo, versão da doutrina INTOCADA (e nenhum item re-armado).
    expect(digest(stewardPlaybooksBlock("autonomo"))).toBe("ae4a128d");
  });

  it("é um LITERAL: não deriva de sha de build / data / deploy (a armadilha que anularia o WS)", () => {
    // Derivá-la de sha/deploy a torna "todo deploy re-arma tudo" — a proposta que noop-rearm.ts JÁ recusou (o
    // board deploya o dia inteiro ⇒ o streak nunca chega a 2 ⇒ o laço de 2026-07-15 volta), com aparência de
    // rigor. O fato tem de ser: não tocado pela tentativa, com dono, monotônico e RARO.
    expect(AUTONOMO_DOCTRINE_VERSION).not.toMatch(/^[0-9a-f]{7,40}$/); // não é um sha
    expect(AUTONOMO_DOCTRINE_VERSION).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // não é um timestamp de build
    expect(process.env.GIT_COMMIT ?? "").not.toContain(AUTONOMO_DOCTRINE_VERSION);
  });

  it("a doutrina de resolução só existe no Autônomo — versionar não a vazou para os outros tiers", () => {
    expect(resolutionDoctrineBlock("copiloto")).toBe("");
    expect(resolutionDoctrineBlock("chat")).toBe("");
    expect(resolutionDoctrineBlock("autonomo")).toContain("Resolver o que está aberto");
  });
});

// ── autonomo-liberdade-humana M1/M2 — peer-review + reversible-delete autonomy (gated, autonomo-only) ─────────
describe("peerReviewAllowed / deleteAutonomyAllowed — só Autônomo, sob os gates próprios (M1/M2)", () => {
  it("peerReviewAllowed: autonomo == PEER_REVIEW_ENABLED; copiloto/chat sempre false", () => {
    expect(peerReviewAllowed("autonomo")).toBe(PEER_REVIEW_ENABLED);
    expect(peerReviewAllowed("copiloto")).toBe(false);
    expect(peerReviewAllowed("chat")).toBe(false);
  });
  it("deleteAutonomyAllowed: autonomo == DELETE_AUTONOMY_ENABLED; copiloto/chat sempre false", () => {
    expect(deleteAutonomyAllowed("autonomo")).toBe(DELETE_AUTONOMY_ENABLED);
    expect(deleteAutonomyAllowed("copiloto")).toBe(false);
    expect(deleteAutonomyAllowed("chat")).toBe(false);
  });
});

describe("tierMatrix — as classes novas: Autônomo sobe sob gate, Copiloto DEFERE (M1/M2)", () => {
  it("Copiloto: peer-review e reversible-delete são `ask` (defere governança/curadoria ao humano)", () => {
    expect(tierMatrix("copiloto")["peer-review"]).toBe("ask");
    expect(tierMatrix("copiloto")["reversible-delete"]).toBe("ask");
  });
  it("Autônomo: peer-review/reversible-delete = `auto` sob o gate (senão `ask`)", () => {
    expect(tierMatrix("autonomo")["peer-review"]).toBe(PEER_REVIEW_ENABLED ? "auto" : "ask");
    expect(tierMatrix("autonomo")["reversible-delete"]).toBe(DELETE_AUTONOMY_ENABLED ? "auto" : "ask");
  });
  it("destructive segue `never` em TODO tier — o cadeado do kernel não afrouxa", () => {
    expect(tierMatrix("copiloto").destructive).toBe("never");
    expect(tierMatrix("autonomo").destructive).toBe("never");
  });
});

describe("liberdadeDoctrineBlock — bloco IRMÃO, só no Autônomo sob os gates (M1/M2)", () => {
  it("Autônomo (gates on): ensina a pedir par e que a exclusão é reversível", () => {
    const block = liberdadeDoctrineBlock("autonomo");
    if (PEER_REVIEW_ENABLED) {
      expect(block).toMatch(/request_peer_review/);
      expect(block).toMatch(/NUNCA aprova a si mesmo|nunca se aprova|nunca aprova a si/i);
    }
    if (DELETE_AUTONOMY_ENABLED) {
      expect(block).toMatch(/restore_deleted/);
      expect(block).toMatch(/approve_data_deletion/); // não confundir com wipe de produção
    }
  });
  it("Copiloto/Chat: bloco vazio (defere — o comportamento certo lá)", () => {
    expect(liberdadeDoctrineBlock("copiloto")).toBe("");
    expect(liberdadeDoctrineBlock("chat")).toBe("");
  });
});
