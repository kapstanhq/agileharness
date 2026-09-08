import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { levelAllows, setServerLevel, riskClassForTool, annotatedToolNames } from "./register";
import { registerStorymapTools } from "./tools";
import { registerDevTools } from "./dev-tools";
import { RISK_CLASSES, type RiskClass } from "@/lib/storymap/types";

// 6.5 — a FAKE McpServer that just records the names registered on it (via defineTool → server.registerTool),
// so we can assert the tool SURFACE mounted at a given McpLevel without a real MCP transport. A Proxy no-ops any
// other method register* might touch; the object identity is the WeakMap key setServerLevel/defineTool use.
function captureServer() {
  const names: string[] = [];
  const server = new Proxy(
    {},
    {
      get: (_t, prop) => (prop === "registerTool" ? (name: string) => void names.push(name) : () => {}),
    },
  ) as unknown as McpServer;
  return { server, names };
}

function mountedAt(level: "ro" | "write" | "orch" | "full"): Set<string> {
  const { server, names } = captureServer();
  setServerLevel(server, level);
  registerStorymapTools(server);
  registerDevTools(server);
  return new Set(names);
}

// ── F8 — as SUPERFÍCIES, por classe de risco. O nível monta CLASSES (LEVEL_CLASSES), então estas listas são o
// contrato legível do que cada token pode ver. Uma tool nova cai num destes baldes ou o teste de no-drift quebra.

// `run-free` — recebe um PROMPT/COMANDO e spawna um filho com Bash pleno, ou alcança para fora do board. UMA
// chamada = execução arbitrária ⇒ contornaria todos os outros cadeados. NUNCA abaixo de `full`, nem no `orch`:
// é EXATAMENTE o que separa "um orquestrador" de "um shell remoto sem dono".
const RUN_FREE_SURFACE = [
  "run_task",
  "claude_new",
  "claude_recycle", // WS-6.3 — spawna o Claude substituto de um agente vivo: mesmo alcance de shell que claude_new
  "claude_send",
  // WS — `claude_keys` manda TECLAS NOMEADAS (vocabulário fechado) na mesma superfície do
  // `claude_send`: qualquer sessão tmux da caixa, inclusive um shell humano. É ESTRITAMENTE MENOS
  // poder (não digita texto, e C-c/C-d/C-z ficaram de fora), mas a superfície é a mesma e é ela que
  // decide a classe — um `Enter` na sessão errada responde um prompt que não é seu.
  "claude_keys",
  // M4 — `session_ask` COMPÕE claude_send + espera + leitura do transcript. A composição não dilui a
  // classe da parte mais perigosa: quem a tem, entrega texto arbitrário num pane (inclusive um shell).
  "session_ask",
  "term_new",
  "git_commit_push",
  "sync_repo",
  "generate_tasks_for_idea",
  "update_vps", // auto-cirurgia: reinicia o serviço em que o próprio Jido roda
];

// `destructive` — perda irreversível de dado ou de DECISÃO. Inclui (5.4b) as superfícies de decisão humana: sem
// isto, o tick propõe uma mudança de governança e APROVA a si mesmo.
// (autonomo-liberdade-humana 2026-07-18) SAÍRAM daqui: delete_card/persona/system (viraram `reversible-delete`,
// soft-delete com undo de 7d — ver REVERSIBLE_DELETE_SURFACE) e mark_tasks_done (APOSENTADA — M4). O que fica é o
// que é IRREVERSÍVEL de verdade: wipe de banco, kill de processo, e as aprovações (o cadeado proponente≠aprovador).
const DESTRUCTIVE_SURFACE = [
  "discontinue_card",
  "approve_data_deletion",
  "claude_kill",
  "approve_change",
  "reject_change",
  "approve_action",
  "reject_action",
];

// `reversible-delete` (M2) — soft-delete de board-data: move para `.trash/`, GC 7d, restore_deleted. Montável em
// `orch` (o Autônomo exclui sozinho), ABSENT em `write` (excluir é curadoria, fora do token de escrita simples).
const REVERSIBLE_DELETE_SURFACE = ["delete_card", "delete_persona", "delete_system"];

// `peer-review` (M1) — DISPARA um revisor independente para a própria proposta. Montável em `orch`, ABSENT em
// `write`. NÃO aprova por si só — a aprovação é executada pela infra, atribuída peer:<runId>, fail-closed.
const PEER_REVIEW_SURFACE = ["request_peer_review"];

// As classes que o nível `orch` (o orquestrador autônomo) PODE montar: os verbos que o humano clica para tocar o
// board. Todos recebem (board, cardId) ou um runId — nenhum recebe texto livre.
// classes `run` + `session` — acionam o pipeline com uma assinatura FECHADA (board/cardId/sessionId), nunca
// texto livre. Esta lista é o contrato de MONTAGEM (ambas as classes estão em LEVEL_CLASSES.orch), não de
// classe: as 4 de worktree são `session` desde o ADR-065, e as outras seguem `run`.
// WS-1: as 4 tools de worktree de sessão entram aqui, e não em RUN_FREE_SURFACE, porque a distinção que
// este arquivo protege é "recebe um alvo do board e roda plumbing fixo" × "recebe um prompt/comando e abre
// um shell". worktree_open/submit/refresh/discard rodam git plumbing fixo sobre a árvore da PRÓPRIA sessão;
// nada nelas executa código do agente (o agente já tem o Bash dele — a tool só provisiona e integra).
// ADR-065: elas ganharam a classe PRÓPRIA `session` porque `run` é definida como "(board, cardId) → a skill
// da coluna" — e uma tool sem board batia no `ask` sem board e era RECUSADA, deixando a frota sem integrar.
// `set_board_autorun` entra AQUI (revisão exigida por este teste, 2026-08-12). Ela grava UMA linha de
// YAML, então o preset ingênuo seria `write-board` — e seria mentira. O que ela põe no mundo é STANDING:
// depois de armada, todo card que entrar numa coluna com trigger spawna um `claude` headless sem mais
// nenhuma chamada. É o mesmo raciocínio que trouxe `publish_when_idle` para DEPLOY_SURFACE: classifica-se
// pelo EFEITO, nunca pelo tamanho da escrita nem pelo atraso dela. Consequência assumida: sai de `write`
// (quem só edita board não arma pipeline) e é montada em `orch`, que já dispara runs por `enqueue` — armar
// AUTOMATIZA uma capacidade que esse token tem, não concede uma que ele não tinha. A direção perigosa
// ainda pede `confirm` com o id do board; desarmar (o kill-switch) não pede nada, de propósito.
const PIPELINE_SURFACE = [
  "set_board_autorun",
  "enqueue",
  "enqueue_batch",
  "run_skill",
  "cancel_run",
  "worktree_open",
  "worktree_submit",
  "worktree_refresh",
  "worktree_discard",
];
const MERGE_SURFACE = ["resolve_merge", "reconcile_stage"]; // classe `merge-resolve`
// classe `deploy` — publica o app DO BOARD (≠ update_vps, que é o serviço). O guia de estilo NÃO
// mora mais aqui: o subsistema de APROVAÇÃO de estilo foi desmontado (o guia virou doc fonte-da-
// verdade, autorado por humano e consumido por agentes), então não há mais o que "publicar" nem
// direções a escolher — sobraram só as leituras get_styleguide/styleguide_drift, classe `read`.
// `publish_when_idle` entra AQUI (revisão exigida por este teste, 2026-07-22): ela enfileira um
// promote+restart. O efeito ser DIFERIDO até a janela de ociosidade não o torna menos real — classificamos
// pelo efeito, nunca pelo atraso, senão "agenda um deploy" seria um jeito de contornar o gate de deploy.
// Consequência assumida: o nível `orch` a monta, como já monta `deploy` — quem pode publicar um card pode
// enfileirar a publicação de uma sessão. Quem decide se ela AGE segue sendo a matriz de risco + o toggle
// `autorun.publishQueue`, que nasce desligado.
const DEPLOY_SURFACE = ["deploy", "publish_when_idle"];

describe("6.5 — levelAllows (pure)", () => {
  const DEPLOY = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
  const WRITE = { readOnlyHint: false, destructiveHint: false };
  const RO = { readOnlyHint: true };

  it("full mounts everything; write excludes destructive/deploy; ro is read-only + the HITL pair", () => {
    expect(levelAllows("full", "deploy", DEPLOY)).toBe(true);
    expect(levelAllows("write", "deploy", DEPLOY)).toBe(false);
    expect(levelAllows("write", "move_card", WRITE)).toBe(true);
    expect(levelAllows("ro", "move_card", WRITE)).toBe(false);
    expect(levelAllows("ro", "get_card", RO)).toBe(true);
    expect(levelAllows("ro", "ask_question", WRITE)).toBe(true); // escalation stays available at ro
    expect(levelAllows("ro", "answer_question", WRITE)).toBe(true);
  });

  it("DEFAULT-DENY: an unannotated tool is excluded below full (an unclassified surface never slips through)", () => {
    expect(levelAllows("write", "mystery_tool", undefined)).toBe(false);
    expect(levelAllows("ro", "mystery_tool", undefined)).toBe(false);
    expect(levelAllows("full", "mystery_tool", undefined)).toBe(true);
  });
});

describe("6.5 — the register-time McpLevel filter (the containment for the autonomous token)", () => {
  it("a WRITE server mounts ONLY the pure board surface — no exec, no merge, no deploy, no destructive", () => {
    const write = mountedAt("write");
    for (const t of [...RUN_FREE_SURFACE, ...DESTRUCTIVE_SURFACE, ...REVERSIBLE_DELETE_SURFACE, ...PEER_REVIEW_SURFACE, ...PIPELINE_SURFACE, ...MERGE_SURFACE, ...DEPLOY_SURFACE])
      expect(write.has(t), `${t} must be ABSENT at write`).toBe(false);
    for (const w of ["move_card", "create_card", "update_card", "set_card_route", "ask_question", "answer_question", "list_cards", "get_card", "triage_finding"])
      expect(write.has(w), `${w} must be PRESENT at write`).toBe(true);
  });

  it("a FULL server DOES mount deploy/delete/run_task — proving it is the LEVEL that gates, not a code removal", () => {
    const full = mountedAt("full");
    expect(full.has("deploy")).toBe(true);
    expect(full.has("delete_card")).toBe(true);
    expect(full.has("run_task")).toBe(true);
  });

  it("no drift: full∖write == exactly everything above write-board (a new such tool must be reviewed)", () => {
    const full = mountedAt("full");
    const write = mountedAt("write");
    const excluded = [...full].filter((n) => !write.has(n)).sort();
    expect(excluded).toEqual(
      [...RUN_FREE_SURFACE, ...DESTRUCTIVE_SURFACE, ...REVERSIBLE_DELETE_SURFACE, ...PEER_REVIEW_SURFACE, ...PIPELINE_SURFACE, ...MERGE_SURFACE, ...DEPLOY_SURFACE].sort(),
    );
  });
});

// ── F8 — A ACEITAÇÃO ADVERSARIAL DO NÍVEL `orch` ────────────────────────────────────────────────────────────
// O token do orquestrador autônomo. A tese inteira da F8 cabe em dois testes: ele MONTA tudo que é preciso para
// entregar um card de ponta a ponta, e NÃO MONTA nada com que se possa abrir um shell ou destruir algo.
describe("F8 — o nível `orch`: entrega o pipeline, não entrega um shell", () => {
  it("MONTA os verbos de entrega: rodar a skill da coluna, destravar run, desparquear a train, PUBLICAR", () => {
    const orch = mountedAt("orch");
    for (const t of [...PIPELINE_SURFACE, ...MERGE_SURFACE, ...DEPLOY_SURFACE, ...REVERSIBLE_DELETE_SURFACE, ...PEER_REVIEW_SURFACE])
      expect(orch.has(t), `${t} must be PRESENT at orch (sem isto o Jido não entrega, só cobra)`).toBe(true);
    // …e segue com o board + as leituras (mover card, responder pergunta, ver o console de um run).
    for (const t of ["move_card", "update_card", "answer_question", "ask_question", "get_card", "runner_status", "card_console", "wait_for_run", "wait_for_approval"])
      expect(orch.has(t), `${t} must be PRESENT at orch`).toBe(true);
  });

  it("NUNCA monta `run-free` — a única chamada que escaparia de TODOS os outros cadeados (RCE em 1 call)", () => {
    const orch = mountedAt("orch");
    for (const t of RUN_FREE_SURFACE)
      expect(orch.has(t), `${t} (prompt/comando com Bash pleno) must be ABSENT at orch`).toBe(false);
  });

  it("NUNCA monta `destructive` — inclusive as APROVAÇÕES (senão o tick propõe e aprova a si mesmo)", () => {
    const orch = mountedAt("orch");
    for (const t of DESTRUCTIVE_SURFACE)
      expect(orch.has(t), `${t} must be ABSENT at orch`).toBe(false);
  });

  it("no drift: full∖orch == exatamente run-free ∪ destructive — uma tool nova cai num balde ou este teste quebra", () => {
    const full = mountedAt("full");
    const orch = mountedAt("orch");
    const excluded = [...full].filter((n) => !orch.has(n)).sort();
    expect(excluded).toEqual([...RUN_FREE_SURFACE, ...DESTRUCTIVE_SURFACE].sort());
  });

  // autonomy-endgame WS-5.2 — LEVEL_CLASSES.orch provado por IGUALDADE, não por inclusão. Uma classe de risco
  // nova entrando de carona no `orch` é precisamente o que ninguém percebe no review — então o teste enumera
  // TODAS as classes (RISK_CLASSES é exaustivo) e fixa, para cada uma, se o `orch` a monta. `run-free` e
  // `destructive` FORA é o cadeado inteiro; um `true` a mais aqui é um shell ou um self-approve concedido.
  it("WS-5.2 — o conjunto EXATO de classes que `orch` monta é {read, idea-write, doc-write, write-board, reversible-delete, run, session, merge-resolve, peer-review, deploy}", () => {
    // um representante ANOTADO por classe (levelAllows precisa das hints; a classe sai de riskClassForTool).
    // salvage (endgame WS-5.2): Record<RiskClass, …> — uma classe NOVA em RISK_CLASSES vira ERRO DE
    // COMPILAÇÃO aqui até alguém decidir se o `orch` a monta (antes de rodar, não só ao rodar).
    const repByClass: Record<RiskClass, { name: string; ann: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } }> = {
      read: { name: "get_card", ann: { readOnlyHint: true } },
      // ADR-066 — escrever DENTRO de um documento de Ideia. Montável até no `ro` (a Ideia vive fora do
      // pipeline: sem status, sem trigger, sem coluna), então obviamente montável no `orch`.
      "idea-write": { name: "write_idea", ann: { readOnlyHint: false, destructiveHint: false } },
      // Escrever numa SEÇÃO de um documento de board (Lean Canvas e os próximos). Montável até no `ro`
      // pelo mesmo argumento da Ideia — um documento não tem status, trigger nem coluna, então a escrita
      // não move entrega —, logo montável no `orch`.
      "doc-write": { name: "write_doc", ann: { readOnlyHint: false, destructiveHint: false } },
      "write-board": { name: "move_card", ann: { readOnlyHint: false, destructiveHint: false } },
      // autonomo-liberdade-humana M2 — soft-delete reversível (`.trash/` + 7d + restore): montável em orch, mas
      // NÃO é self-approve nem shell — a undo de 7d é a rede, e o wipe de banco (approve_data_deletion) fica FORA.
      "reversible-delete": { name: "delete_card", ann: { readOnlyHint: false, destructiveHint: true } },
      run: { name: "run_skill", ann: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
      session: { name: "worktree_open", ann: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
      "merge-resolve": { name: "resolve_merge", ann: { readOnlyHint: false, destructiveHint: true } },
      // autonomo-liberdade-humana M1 — DISPARA um revisor independente para a própria proposta. Montável em orch,
      // mas NÃO aprova nada por si só (a infra executa a aprovação após o par cegado; fail-closed). approve_change
      // segue `destructive`, FORA — o cadeado proponente≠aprovador é o teste logo abaixo.
      "peer-review": { name: "request_peer_review", ann: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
      deploy: { name: "deploy", ann: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
      "run-free": { name: "run_task", ann: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
      destructive: { name: "approve_change", ann: { readOnlyHint: false, destructiveHint: true } },
    };
    const mountedClasses = RISK_CLASSES.filter((cls) => {
      const rep = repByClass[cls];
      // sanity: the representative really has this class (else the equality below proves nothing)
      expect(riskClassForTool(rep.name), `${rep.name} deveria ter classe ${cls}`).toBe(cls);
      return levelAllows("orch", rep.name, rep.ann);
    });
    expect([...mountedClasses].sort()).toEqual(
      ["deploy", "doc-write", "idea-write", "merge-resolve", "peer-review", "read", "reversible-delete", "run", "session", "write-board"].sort(),
    );
  });

  // WS-5.3 — o teste que a PRÓXIMA investigação encontra por grep antes de reabrir "o tick pode consertar o
  // código?". O valor não é técnico — é de CONTEXTO: transforma 40 minutos de re-descoberta num nome de teste.
  // Prova as duas metades juntas: o tick NÃO escreve (Bash/Write/Edit fora — provado no spawn) e DESPACHA quem
  // escreve (enqueue/run_skill/move_card montadas no `orch`).
  it("WS-5.3 — o tick DESPACHA quem escreve o código, mas não escreve ele mesmo", () => {
    const orch = mountedAt("orch");
    // DESPACHA: as tools que disparam a skill headless da coluna (que TEM shell) estão montadas. É o botão
    // "Rodar agora" que o humano aperta o dia inteiro — recebe (board, cardId), sem texto livre para injetar.
    for (const dispatch of ["enqueue", "enqueue_batch", "run_skill", "move_card"])
      expect(orch.has(dispatch), `${dispatch}: o tick precisa poder DESPACHAR quem escreve`).toBe(true);
    // NÃO ESCREVE ELE MESMO: run_task/claude_new — o "vetor canônico" (prompt de texto livre + Bash pleno) —
    // ficam fora. A diferença não é "o filho tem shell" (tem, nos dois) — é QUEM escolhe o prompt.
    for (const write of ["run_task", "claude_new", "claude_send", "term_new"])
      expect(orch.has(write), `${write}: texto livre + Bash é a fronteira que o tick não cruza`).toBe(false);
    // O teto do argv (Bash/Write/Edit no --disallowedTools do spawn) é provado em orchestrator-spawn.test.ts;
    // aqui provamos a outra metade — que ele não FICA travado, porque despacha.
  });

  it("orch ⊋ write ⊋ ro — os níveis são monotônicos (nenhum nível vê algo que o de cima não veja)", () => {
    const [ro, write, orch, full] = [mountedAt("ro"), mountedAt("write"), mountedAt("orch"), mountedAt("full")];
    for (const t of ro) expect(write.has(t), `${t}: ro ⊄ write`).toBe(true);
    for (const t of write) expect(orch.has(t), `${t}: write ⊄ orch`).toBe(true);
    for (const t of orch) expect(full.has(t), `${t}: orch ⊄ full`).toBe(true);
    expect(orch.size).toBeGreaterThan(write.size);
  });
});

// O subsistema de APROVAÇÃO de estilo foi DESMONTADO: o guia virou um doc fonte-da-verdade —
// autorado por humano (prompt + imagens) e CONSUMIDO por agentes/steps ao construir os cards.
// Não há mais direções a escolher, nem publicação a aprovar, nem trava de estilo no pipeline
// (estilo nunca foi gate de card e agora também não é superfície de decisão). Sobrou só leitura.
describe("WS-4 — style guide tools (só LEITURA: get_styleguide/styleguide_drift)", () => {
  it("get_styleguide e styleguide_drift MONTAM em ro (preset READ-ONLY)", () => {
    const ro = mountedAt("ro");
    expect(ro.has("get_styleguide"), "get_styleguide deve estar em ro").toBe(true);
    expect(ro.has("styleguide_drift"), "styleguide_drift deve estar em ro").toBe(true);
  });

  it("riskClassForTool deriva 'read' das duas — sem exceção nominal de estilo", () => {
    expect(riskClassForTool("get_styleguide")).toBe("read");
    expect(riskClassForTool("styleguide_drift")).toBe("read");
  });

  // GUARDA DE REGRESSÃO: nenhuma das tools de aprovação pode voltar a montar em nível nenhum sem
  // que alguém reveja a decisão de desmontar. `full` monta tudo que EXISTE — ausência lá prova
  // remoção de verdade, não apenas filtro de nível.
  it("propose_styleguide e approve_styleguide não existem em nível NENHUM (subsistema removido)", () => {
    for (const level of ["ro", "write", "orch", "full"] as const) {
      const mounted = mountedAt(level);
      expect(mounted.has("propose_styleguide"), `propose_styleguide não pode montar em ${level}`).toBe(false);
      expect(mounted.has("approve_styleguide"), `approve_styleguide não pode montar em ${level}`).toBe(false);
    }
  });
});

describe("F5.2 — riskClassForTool (a classe de risco por chamada)", () => {
  it("exceções nominais", () => {
    expect(riskClassForTool("move_card")).toBe("write-board"); // escalação do ALVO vive no moveCardAction
    expect(riskClassForTool("resolve_merge")).toBe("merge-resolve");
    // F8 — as aprovações são `destructive` (não mais `write-board` cosmético): é a classe que as mantém FORA do
    // nível `orch`, agora que o filtro de montagem deriva da CLASSE. Sem isto, o tick propõe e auto-aprova.
    expect(riskClassForTool("approve_change")).toBe("destructive");
    expect(riskClassForTool("reject_change")).toBe("destructive");
    expect(riskClassForTool("approve_action")).toBe("destructive");
    expect(riskClassForTool("reject_action")).toBe("destructive");
  });
  it("F8 — a fronteira: verbo de PIPELINE (recebe cardId) vs verbo LIVRE (recebe prompt/comando)", () => {
    // PIPELINE (`run`): roda a skill que o BOARD registrou p/ a coluna ATUAL do card. Sem texto livre.
    expect(riskClassForTool("enqueue")).toBe("run");
    expect(riskClassForTool("run_skill")).toBe("run");
    expect(riskClassForTool("enqueue_batch")).toBe("run");
    expect(riskClassForTool("cancel_run")).toBe("run"); // destrava um card — o oposto de irreversível
    // MERGE: desparqueia a train (abort preserva o branch como failed/run/<id>).
    expect(riskClassForTool("reconcile_stage")).toBe("merge-resolve");
    // LIVRE (`run-free`): prompt/comando ⇒ `claude --dangerously-skip-permissions` com Bash pleno. É O vetor.
    expect(riskClassForTool("run_task")).toBe("run-free");
    expect(riskClassForTool("claude_new")).toBe("run-free");
    expect(riskClassForTool("claude_send")).toBe("run-free");
    expect(riskClassForTool("term_new")).toBe("run-free");
    expect(riskClassForTool("git_commit_push")).toBe("run-free");
    expect(riskClassForTool("update_vps")).toBe("run-free"); // auto-cirurgia: reinicia o próprio serviço
  });
  it("derivação dos presets", () => {
    expect(riskClassForTool("get_card")).toBe("read"); // RO
    expect(riskClassForTool("query_errors")).toBe("read"); // RO_EXT (read-only)
    expect(riskClassForTool("create_card")).toBe("write-board"); // WRITE
    expect(riskClassForTool("update_card")).toBe("write-board"); // WRITE_IDEM
    expect(riskClassForTool("deploy")).toBe("deploy"); // DEPLOY
    // autonomo-liberdade-humana M2 — delete_card tem HINT destructive mas CLASSE reversible-delete (exceção nominal).
    expect(riskClassForTool("delete_card")).toBe("reversible-delete"); // DESTRUCTIVE hint → RISK_CLASS_EXCEPTIONS
    expect(riskClassForTool("request_peer_review")).toBe("peer-review"); // M1 — EXEC_EXT hint → exceção peer-review
    expect(riskClassForTool("restore_deleted")).toBe("write-board"); // M2 — WRITE preset (desfaz o soft-delete)
  });
  it("completude: TODA tool anotada tem uma classe de risco válida", () => {
    const valid = new Set<string>(RISK_CLASSES);
    for (const name of annotatedToolNames()) {
      expect(valid.has(riskClassForTool(name)), `${name} deve ter classe válida`).toBe(true);
    }
  });
});
