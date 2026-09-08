// tier.ts — os 3 ESTADOS do JIDO (Chat / Copiloto / Autônomo) as a PURE PROJECTION over the EXISTING
// (mode, riskMatrix.deploy) fields — NO new schema. The riskMatrix the guard already re-reads per call stays the
// single source of truth; the toggle WRITES a tier's canonical (mode, matrix) and everything else DERIVES the
// tier back with copilotTier(). Chosen over a new enum value or an `autonomyProfile` field precisely to avoid a
// SECOND source of truth for "may it deploy" that could desync from the matrix the enforcement reads.
//
//   Chat      = mode off                     — só conversa, sem tick. Lê, diagnostica e PROPÕE; não mexe no
//                                              board (token MCP `ro` + Write/Edit negados — agent-session.ts).
//   Copiloto  = mode autonomous + deploy:ask — resolves stuck steps/columns/merges/runs and answers FATOS; a
//                                              DECISÃO de produto/UX SEMPRE pausa e pergunta; nunca faz deploy.
//   Autônomo  = mode autonomous + deploy:auto — decide produto/UX E PUBLICA em produção sozinho, até o card no ar.
//
// Autônomo's defining bit (deploy:auto) is the operator-reviewed "§4" change. Until it is signed off, the flag
// {@link DEPLOY_AUTONOMY_ENABLED} holds it OFF: the tier is representable in the model but the UI keeps its button
// LOCKED (there is no way to store "autônomo intent" as deploy:ask — that derives back to `copiloto` — so a button
// that silently wrote deploy:ask would over-promise; the truth-chip ethos of this package forbids that).
//
// O NOME. O agente se chama **Jido** — de *jidoka* (自働化), a "autonomação" do Sistema Toyota de Produção: a
// máquina que trabalha sozinha E PARA sozinha para chamar um humano quando detecta uma anomalia. É a descrição
// literal destes 3 estados, e por isso o nome não é decorativo — ele nomeia o princípio que o Copiloto encarna
// ao deferir uma decisão de produto em vez de chutar. NÃO confundir com um assistente de chat de algum app do
// repositório-alvo, nem com "Copiloto", que aqui é um ESTADO do Jido, não o agente.

import type { OrchestratorMode, OrchestratorPolicy, RiskClass, RiskDisposition } from "@/lib/storymap/types";
import { dispositionFor } from "@/lib/storymap/runner/orchestrator-policy";

export type CopilotTier = "chat" | "copiloto" | "autonomo";

/**
 * FEATURE GATE — autonomous production deploy (the reviewed "§4": "Autônomo publishes itself"). **ON.**
 *
 * DECISÃO REGISTRADA DO OPERADOR (2026-07-16 — não é inferência do agente): perguntado explicitamente "o deploy
 * final também deve ser disparado sozinho, sem perguntar?", o Operador respondeu "Sim — autônomo também publica
 * sozinho, sem perguntar". Este flag materializa essa decisão: o estado Autônomo (autonomous + `deploy: auto`)
 * fica selecionável no toggle, {@link tierMatrix} emite `deploy: auto`, e as stances de chat/tick autorizam
 * publicar SEGUINDO O RITUAL de publicação (deploy_plan dry-run → risco escopado → deploy pela esteira).
 *
 * O que NÃO muda: `run-free` (shell) e `destructive` (deleção/undo) seguem SEMPRE humanos, em QUALQUER estado
 * (invariante do kernel — NEVER_AUTO). E a contenção REAL de deploy continua sendo a matriz + o guard por chamada
 * + o ritual da skill; este flag só decide se o estado Autônomo é OFERECIDO ao Operador.
 */
export const DEPLOY_AUTONOMY_ENABLED = true;

/**
 * FEATURE GATE — autonomous PEER REVIEW (autonomo-liberdade-humana M1). **ON.**
 *
 * DECISÃO DE DIREÇÃO DO OPERADOR (2026-07-17, "quero que o agente autônomo seja praticamente um humano"): a
 * proposta do Autônomo que hoje espera um humano passa a poder ser aprovada por um AGENTE INDEPENDENTE. O
 * proponente segue NUNCA se aprovando — `request_peer_review` só DISPARA um revisor cegado (runner/
 * peer-review-spawn.ts) cujo veredito `approve`, executado pela INFRA e atribuído `peer:<runId>`, aplica a
 * proposta. `approve_change`/`approve_action` seguem `destructive`/never, INTOCADOS: a contenção não é "o
 * agente ganhou approve", é "existe um caminho independente e fail-closed para a aprovação".
 *
 * POR QUE UM SEGUNDO CADEADO DE CÓDIGO (além da matriz): igual a {@link DEPLOY_AUTONOMY_ENABLED} — uma matriz
 * `peer-review: auto` editada à mão NÃO alcança este flag. Com ele OFF, `request_peer_review` recusa em runtime
 * (o handler checa o gate), a doutrina não descreve o par, e a tierMatrix não emite `peer-review: auto`.
 */
export const PEER_REVIEW_ENABLED = true;

/** Pode o AGENTE pedir revisão por par (e ter a aprovação executada por um par) sozinho neste tier? Só
 *  Autônomo, e só sob {@link PEER_REVIEW_ENABLED}. O humano (token `full`/UI) aprova direto, sem par. PURE. */
export function peerReviewAllowed(tier: CopilotTier): boolean {
  return tier === "autonomo" && PEER_REVIEW_ENABLED;
}

/**
 * FEATURE GATE — autonomous REVERSIBLE DELETE (autonomo-liberdade-humana M2). **ON.**
 *
 * DECISÃO DE DIREÇÃO DO OPERADOR (2026-07-17): eliminada a irreversibilidade (soft-delete → `.trash/`, GC 7d,
 * `restore_deleted`), o Autônomo pode excluir board-data sozinho. Copiloto DEFERE (excluir um card é curadoria =
 * decisão de produto, e a stance do Copiloto é deferir produto). Wipe de DADOS DE PRODUÇÃO (Firestore,
 * `approve_data_deletion`) continua `destructive`/humano — a lixeira cobre board-data em git, nunca um banco.
 *
 * O flag é o kill-switch: OFF ⇒ a tierMatrix não emite `reversible-delete: auto` (o Autônomo volta a escalar a
 * exclusão). A reversibilidade (lixeira 7d) é o backstop real; o flag é o controle do Operador sobre a política.
 */
export const DELETE_AUTONOMY_ENABLED = true;

/** Pode o AGENTE excluir board-data (soft-delete reversível) sozinho neste tier? Só Autônomo, e só sob
 *  {@link DELETE_AUTONOMY_ENABLED}. PURE. */
export function deleteAutonomyAllowed(tier: CopilotTier): boolean {
  return tier === "autonomo" && DELETE_AUTONOMY_ENABLED;
}

/**
 * The tier a policy is IN — derived from mode + the RESOLVED `deploy` disposition (dispositionFor: the very value
 * the per-call guard reads, so the projection can never disagree with enforcement). PURE.
 *  - mode !== autonomous            → chat
 *  - autonomous & deploy === auto   → autonomo
 *  - autonomous & deploy !== auto   → copiloto   (deploy defaults to `never` when the matrix is silent — safe)
 */
export function copilotTier(policy: OrchestratorPolicy | null | undefined): CopilotTier {
  if (policy?.mode !== "autonomous") return "chat";
  return dispositionFor(policy, "deploy") === "auto" ? "autonomo" : "copiloto";
}

/** Is `tier` selectable right now? Autônomo is locked until the deploy-autonomy gate is signed off. PURE. */
export function tierUnlocked(tier: CopilotTier): boolean {
  return tier === "autonomo" ? DEPLOY_AUTONOMY_ENABLED : true;
}

/** The `mode` a tier WRITES to board.yaml. Chat → off; the two active tiers → autonomous (the tick axis). PURE. */
export function tierMode(tier: CopilotTier): OrchestratorMode {
  return tier === "chat" ? "off" : "autonomous";
}

// The autonomous baseline both active tiers share: everything the copiloto may do sozinho on the BOARD, plus the
// two kernel invariants that NEVER change tier — `run-free` (a shell) and `destructive` (no undo) stay human-only
// in EVERY tier. The only bit that moves between Copiloto and Autônomo is `deploy`.
const BASE_AUTONOMOUS: Record<RiskClass, RiskDisposition> = {
  read: "auto",
  // ADR-066 — escrever num documento de Ideia é `auto` pelo mesmo motivo que ler é: a Ideia vive FORA do
  // pipeline (sem status, sem trigger, sem coluna), então a escrita não move entrega nenhuma, só soma texto a
  // um rascunho — e a tool nunca apaga o que o humano escreveu.
  "idea-write": "auto",
  // Escrever numa SEÇÃO de um documento de board (Lean Canvas e os próximos) é `auto` pela mesma razão
  // que `idea-write`: um documento não tem status, trigger nem coluna — a escrita não move entrega, não
  // cruza gate e não dispara autorun. E a tool é estruturalmente estreita: a seção precisa existir no
  // schema, o rótulo travado é revalidado na gravação, e o frontmatter (o que a máquina lê) fica fora
  // do alcance dela.
  "doc-write": "auto",
  "write-board": "auto",
  "reversible-delete": "ask", // Copiloto DEFERE (excluir card = curadoria = produto). Autônomo sobe p/ `auto` só sob DELETE_AUTONOMY_ENABLED.
  run: "auto",
  session: "auto", // ADR-065 — ciclo de vida do worktree da própria sessão; o gate do train é o controle.
  "merge-resolve": "auto",
  "peer-review": "ask", // Copiloto DEFERE (aprovar governança = produto). Autônomo sobe p/ `auto` só sob PEER_REVIEW_ENABLED.
  deploy: "ask", // Copiloto: deploy sempre pede humano. Autônomo sobe p/ `auto` só sob DEPLOY_AUTONOMY_ENABLED.
  "run-free": "ask", // NEVER_AUTO (kernel clamp) — a shell é sempre humana.
  destructive: "never", // NEVER_AUTO — deleção/undo-less é sempre humana.
};

/**
 * The canonical riskMatrix a tier WRITES. Chat has none (the caller keeps mode off; the matrix is dormant while
 * the tick is off). Autônomo raises three classes to `auto`, each behind its OWN feature gate: `deploy`
 * ({@link DEPLOY_AUTONOMY_ENABLED}), `peer-review` ({@link PEER_REVIEW_ENABLED}) and `reversible-delete`
 * ({@link DELETE_AUTONOMY_ENABLED}). A gate that is off degrades that class to the Copiloto baseline (`ask`), so
 * the label can never promise an autonomy the gate hasn't unlocked. Copiloto NEVER raises them — it defers
 * governance-approval and curation to the human, exactly as it defers deploy. PURE.
 */
export function tierMatrix(tier: Exclude<CopilotTier, "chat">): Partial<Record<RiskClass, RiskDisposition>> {
  const m: Record<RiskClass, RiskDisposition> = { ...BASE_AUTONOMOUS };
  if (tier === "autonomo") {
    if (DEPLOY_AUTONOMY_ENABLED) m.deploy = "auto";
    if (PEER_REVIEW_ENABLED) m["peer-review"] = "auto";
    if (DELETE_AUTONOMY_ENABLED) m["reversible-delete"] = "auto";
  }
  return m;
}

/** UI copy for the segmented toggle (label + the honest "o que ele faz sem você" hint). The single source both the
 *  chat header and the full config page read — they must never diverge on what a state means. */
export const TIER_META: Record<CopilotTier, { label: string; short: string; hint: string }> = {
  chat: {
    label: "Chat",
    // `short` × `hint`: a MESMA verdade em duas granularidades, num lugar só. O seletor de modo é um popover e
    // mostra a descrição junto de cada opção — com o `hint` inteiro (3-5 linhas cada) as três opções viravam
    // uma parede de texto que ninguém lê antes de clicar. O `short` é a frase que decide; o `hint` completo
    // continua sendo o tooltip da opção e o que alimenta a config page e o prompt do agente.
    short: "Só responde quando você fala. Não move nada no board.",
    // A frase ANTERIOR era a confissão de um furo: "o chat continua com poder total — o modo governa só o que
    // ele faz SEM você". Ou seja, o estado mais conservador do toggle abria a superfície MAIS poderosa do
    // sistema, e o único guardrail era a persona pedindo bom comportamento. Agora o Chat monta o token MCP `ro`
    // (agent-session.ts) e nega Write/Edit: as tools de escrita do board nem existem na superfície dele. O texto
    // diz o que o enforcement faz — e é honesto sobre o limite: o Bash nativo FICA (é o que dá poder de
    // diagnóstico), então a garantia é sobre o BOARD, não sobre o repositório.
    hint: "Só conversa, e só quando você fala com ele. Nenhum tick autônomo. Lê o código e o board, investiga e propõe — mas não move, não edita e não publica nada no board: as ferramentas de escrita não são montadas neste estado.",
  },
  copiloto: {
    label: "Copiloto",
    short: "Age sozinho no que é fato. Produto e deploy param em você.",
    hint: "Age sozinho no que é FATO: destrava steps e colunas, move cards pelos gates técnicos, resolve merge preso, responde o que é apurável no código/dados. Decisão de produto/UX e deploy sempre param em você.",
  },
  autonomo: {
    label: "Autônomo",
    short: "Decide produto e publica em produção sozinho.",
    hint: "Orquestra ponta a ponta: decide também produto/UX e PUBLICA em produção sozinho, até o card entrar no ar.",
  },
};

// ── Behavioral stance per tier — the block injected into BOTH agent surfaces (the chat persona and the tick
// wake prompt). Two axes the riskMatrix alone can't express live here: (1) whether a DECISÃO de produto/UX is
// answered or deferred, and (2) the deploy stance. Chat and Copiloto share the conservative stance; Autônomo
// flips both — but ONLY once DEPLOY_AUTONOMY_ENABLED opens the gate (§4). Until then EVERY tier gets the
// conservative stance, so a hand-edited `deploy: auto` matrix can't make the agent decide/publish on prompt
// guidance alone (defense in depth over the per-call guard, which stays the real gate).

const DEFER_STANCE = [
  "Para PERGUNTAS EM ABERTO: se a resposta é um FATO apurável (código/dados/print), apure com evidência e",
  "responda; se é uma DECISÃO de produto/UX (trade-off sem resposta única), NÃO decida — apresente as opções e",
  "deixe para o humano. Deploy e ações irreversíveis (deploy, deleção de card/dados, git push, merge p/ main) =",
  "DECISÃO HUMANA: proponha, explique o efeito e AGUARDE o ok — nunca as dispare por conta própria.",
].join("\n");

const AUTONOMO_STANCE = [
  "Este board está em AUTÔNOMO: você atua como orquestrador completo. Você PODE decidir produto/UX quando o",
  "caminho é claro e PUBLICAR em produção sozinho — SEMPRE pelo ritual de publicação (deploy_plan dry-run →",
  "risco escopado por pacote → deploy pela esteira, nunca a tool crua). run-free (shell) e destructive (deleção/",
  "undo) seguem SEMPRE humanos — nem em Autônomo. Numa dúvida genuína de NEGÓCIO (intenção/estratégia), pergunte",
  "— mas leia o bloco de RESOLUÇÃO abaixo antes de chamar de negócio o que é decisão de produto/UX.",
].join("\n");

// ── A doutrina de RESOLUÇÃO do Autônomo — por que ela existe, e por que é prosa e não código ─────────────
//
// O INCIDENTE que a escreveu (acme/story-novo-item, 2026-07-17, medido no estado do board): o harness-review deixou
// 2 perguntas `mode: single` com options+pros/cons+`recommended` e 6 avisos. O board estava em Autônomo há
// horas. O tick acordou, LEU as perguntas, e decidiu não decidir — com estas palavras, no resumo do ciclo:
// "I'm not deciding them … both branches terminate in you." Duas passagens depois o anti-noop cumpriu o seu
// papel (2 spawns sem mutação = desisto) e o board passou a dizer "nada acionável" com as perguntas abertas.
// Custo: $5.62 e uma noite; desfecho: o Operador respondeu as duas na mão.
//
// Nada estava quebrado no mecanismo: `question` já era acionável nos dois tiers, a stance já autorizava decidir,
// a skill já dizia "em Autônomo decida quando o caminho for claro", e `answer_question` já estava montada no
// token do tick. O que faltava era a régua de QUANDO o caminho é claro. Sem ela, "dúvida genuína de NEGÓCIO"
// vira uma válvula de escape auto-julgada de largura infinita — e um LLM prudente sempre a acha, porque toda
// decisão de produto "termina no humano" em algum sentido. O bloco abaixo fecha a válvula pela FORMA do item
// (uma skill perguntou com opções analisadas ⇒ é decisão de produto/UX, e é sua), que é um fato observável, e
// não pela intuição do agente sobre o que o Operador iria querer.
//
// POR QUE PROSA E NÃO CÓDIGO: escolher entre `o1` e `o2` é um ato SEMÂNTICO — o steward é determinístico e a $0,
// e não tem como julgar um trade-off de UX. E a alternativa mecânica óbvia (o steward marca a opção
// `recommended`) é PROIBIDA de propósito, com evidência desta mesma noite: em q1 a recomendada era "registre o
// override do guia" e o Operador respondeu "o novo deve ser verde" — a opção que a review NÃO recomendou. Uma
// régua que carimbasse a recomendada teria decidido errado com toda a confiança. Por isso a doutrina manda
// JULGAR contra o card/guia/brief e usar a recomendada só como default rebatível.
/**
 * autonomy-endgame WS-4.1 — A VERSÃO DA DOUTRINA de resolução do Autônomo.
 *
 * SUBA SÓ quando o que o tick DEVE fazer mudar: regra nova, válvula fechada, kind novo virando acionável.
 * NUNCA por refactor, NUNCA por deploy, NUNCA por reescrever a prosa sem mudar a decisão. Subir RE-ARMA o
 * backoff de TODO item deferido sob a versão anterior: cada item ganha outras `PER_ITEM_NOOP_MAX` tentativas,
 * UMA vez, sob a regra nova.
 *
 * POR QUE ESTA CONSTANTE EXISTE. O backoff por item tinha 3 saídas (noop-rearm.ts) e nenhuma cobria o caso
 * que aconteceu: A RAZÃO DA DESISTÊNCIA FOI REVOGADA. O tick deferiu perguntas sob a doutrina VELHA (sem
 * AUTONOMO_RESOLUTION); a doutrina nova shipou; os itens deferidos continuaram presos — e a régua escrita
 * exatamente para decidi-los NUNCA seria lida contra eles, porque eles não estão mais no set. O fix não
 * alcançava as vítimas do bug que ele conserta. Estado medido em 2026-07-17
 * (`storymap/.runner/orchestrator/acme.json`): board `autonomous`, `lastTick: skipped-no-work`, US$ 27,16 em
 * 7 ticks — e `noopByItem: {"story-novo-item:b:style-1-ee43c019": 2}`. Trabalho à vista, tick parado.
 *
 * POR QUE É UM LITERAL, EDITADO À MÃO — e a armadilha que anula o WS inteiro: derivá-la de sha de build /
 * commit / data de deploy a transforma em "todo deploy", que é a proposta que noop-rearm.ts JÁ RECUSOU (o
 * board deploya o dia inteiro ⇒ todo deploy re-armaria todo item ⇒ o streak nunca chegaria a 2 ⇒ o laço de
 * 2026-07-15 volta), só que com aparência de rigor. O fato que passa no crivo tem de ser (a) não tocado pela
 * tentativa, (b) com dono, (c) monotônico, (d) raro. Uma constante que um humano decide mudar é exatamente
 * isso; um número de build não é nenhum dos quatro.
 *
 * É uma DECISÃO DE PRODUTO sobre o comportamento do agente — o code review deve tratá-la como tal. Um teste
 * de guarda (tier.test.ts) exige que um bump venha acompanhado de mudança na doutrina.
 */
export const AUTONOMO_DOCTRINE_VERSION = "2026-08-27.renomeacao-harness";

const AUTONOMO_RESOLUTION = [
  "## Resolver o que está aberto (Autônomo)",
  "Item aberto que você PODE resolver e não resolve NÃO fica esperando: o tick desiste dele em 2 ciclos sem",
  "progresso e ele morre no board como seu. Então aqui \"deixar aberto\" não é desfecho — decida ou converta.",
  "",
  "- PERGUNTA COM OPÇÕES (`mode: single`/`multi` com `options[]` — a forma que uma skill como a harness-review usa):",
  "  quem perguntou JÁ investigou e publicou o trade-off com pros/cons. Isso É a decisão de produto/UX que a sua",
  "  stance manda decidir — o caminho estar claro é o que as opções significam. DECIDA e grave com",
  "  `answer_question`, registrando o PORQUÊ em uma linha. A opção `recommended` é o DEFAULT, não a resposta:",
  "  julgue-a contra o card (acceptance/brief), o guia de estilo e a última intenção do Operador, e contrarie-a",
  "  quando eles a contradisserem — decidir pela marca sozinha é o erro que a regra \"nunca decida produto pela",
  "  mera recomendação do card\" nomeia. \"As duas pontas terminam no humano\" NÃO é motivo para deferir: quando",
  "  as duas são aceitáveis, escolher UMA é exatamente o seu trabalho.",
  "- PERGUNTA SEM OPÇÕES (texto livre, sem recomendação, sobre o que o Operador QUER do produto): aí sim é",
  "  dúvida de NEGÓCIO/estratégia — deixe aberta, é dele.",
  "- OVERRIDE/EXCEÇÃO DE GUIA DE ESTILO JÁ DECIDIDO (regra de 2026-07-17, aprovada pelo Operador): quando a",
  "  exceção que uma proposta de guia codifica já foi decidida numa pergunta RESPONDIDA citável deste board e o",
  "  AA recomputado passa, o REGISTRO é trabalho seu — aprove citando a pergunta (a doutrina de estilo detalha).",
  "  Prosa antiga em card/finding dizendo \"o carimbo é do Operador\" descreve a regra ANTERIOR e não revoga esta.",
  "- AVISO (`finding` non-blocker aberto): ele não trava gate, e é por isso que apodrece. Todo aviso aberto",
  "  termina o ciclo com um `triage_finding`, nunca com silêncio:",
  "  · fronteira conhecida / opinião / custo maior que o ganho ⇒ `acknowledged` (ou `wontfix` quando é decisão",
  "    de NÃO fazer) — a dívida fica registrada e visível em vez de invisível;",
  "  · defeito real que vale consertar AGORA e cabe no escopo DESTE card ⇒ devolva o PRÓPRIO card para",
  "    `desenvolver` (o fix anda com o card, com teste). Você não tem shell: quem edita código é o run da coluna.",
  "  · NUNCA um card paralelo a partir de finding de review de outro card, e NUNCA `fixed` sem que o conserto",
  "    tenha de fato acontecido — carimbar `fixed` no que ninguém consertou é mentir para o gate.",
  "  Um aviso `low` custa uma triagem e some para sempre; um aviso aberto custa uma pergunta por ciclo, para sempre.",
].join("\n");

// ── autonomo-liberdade-humana (2026-07-18) — blocos IRMÃOS de peer-review (M1) e soft-delete (M2) ─────────
//
// MESMO padrão do bloco de ESTILO: cada capacidade nova tem doutrina PRÓPRIA, com gate PRÓPRIO, FORA da string
// versionada por AUTONOMO_DOCTRINE_VERSION — para não re-armar o backoff de itens de estilo/pergunta já tratados
// nem tocar o par (versão, digest) que a endgame WS-4.1 fixou. Sem estes blocos no wake prompt, o mecanismo
// existiria (a matriz autoriza) mas o tick não SABERIA usá-lo: não pediria par para a própria proposta, e não
// saberia que a exclusão virou reversível. A contenção real segue na matriz + guard por chamada + o wrapper do
// spawn do par; esta prosa só ensina QUANDO agir.
const AUTONOMO_PEER_REVIEW = [
  "## Aprovar a SUA proposta de governança (Autônomo) — pelo par, nunca por você",
  "Proposta SUA (`propose_change`, um GovernanceDraft pendente) NÃO fica esperando o humano: é um item aberto que",
  "você PODE resolver. Você NUNCA aprova a si mesmo — mas peça REVISÃO POR PAR com `request_peer_review`",
  "(board + draftId). A infra spawna um revisor INDEPENDENTE, cegado ao seu raciocínio, que julga o diff sozinho;",
  "se ele aprovar, a mudança entra atribuída `peer:<runId>`; se vetar (ou o par falhar/estourar tempo), a proposta",
  "segue PENDENTE para o humano — fail-closed. NUNCA tente `approve_change`/`approve_action` na sua própria",
  "proposta: elas seguem humano-only por desenho, e o par é justamente o caminho independente que as substitui.",
].join("\n");

const AUTONOMO_DELETE = [
  "## Excluir board-data (Autônomo) — agora é reversível",
  "Excluir card/persona/system é SOFT-DELETE: vai para a lixeira do board (`.trash/`), some da lista e é",
  "restaurável por 7 dias com `restore_deleted`. Eliminada a irreversibilidade, você PODE excluir sozinho o que",
  "claramente não pertence mais ao board (duplicata, stub órfão, ruído) — registrando o PORQUÊ. Na dúvida entre",
  "excluir e DESCONTINUAR, descontinue (é o gesto reversível de produto). E NÃO confunda com wipe de DADOS DE",
  "PRODUÇÃO (`approve_data_deletion`, um banco Firestore): esse é irreversível e SEMPRE humano — a lixeira cobre",
  "board-data em git, jamais um banco.",
].join("\n");

/** Os blocos IRMÃOS de M1 (peer-review) e M2 (soft-delete), cada um sob o SEU gate ({@link peerReviewAllowed} /
 *  {@link deleteAutonomyAllowed}). "" quando ambos fechados. Compostos ao lado da resolução nas mesmas
 *  superfícies, pelo padrão modular do {@link stewardPlaybooksBlock}. PURE. */
export function liberdadeDoctrineBlock(tier: CopilotTier): string {
  return [peerReviewAllowed(tier) ? AUTONOMO_PEER_REVIEW : "", deleteAutonomyAllowed(tier) ? AUTONOMO_DELETE : ""]
    .filter(Boolean)
    .join("\n\n");
}

/** A doutrina de resolução (perguntas com opções + avisos), ou "" fora do Autônomo. Copiloto/Chat seguem a
 *  {@link DEFER_STANCE} — deferir lá é o comportamento CERTO, não uma omissão. Injetada nas duas superfícies
 *  (persona do chat + wake prompt do tick), como a stance e os playbooks do steward. PURE. */
export function resolutionDoctrineBlock(tier: CopilotTier): string {
  return tier === "autonomo" && DEPLOY_AUTONOMY_ENABLED ? AUTONOMO_RESOLUTION : "";
}

/** The behavioral stance a tier imposes — the operative block for the current mode. The autônomo stance is
 *  emitted ONLY when the deploy-autonomy gate is open (§4); otherwise every tier is conservative. PURE. */
export function tierStance(tier: CopilotTier): string {
  return tier === "autonomo" && DEPLOY_AUTONOMY_ENABLED ? AUTONOMO_STANCE : DEFER_STANCE;
}

// ── WS-8.4 — the STEWARD OF INTEGRATION playbooks (D11), as prose next to the stance ─────────────────────
// DATA, not power: `copilot/steward.ts` already runs 8.1–8.3 deterministically in-process each tick, and the
// riskMatrix + the per-call guard are what actually contain any of it. This block exists so the AGENT reaches
// the same three verdicts the code does when it meets one of these situations through the MCP surface —
// without it, the LLM re-invents a worse playbook (it re-implements a card whose fix is on a preserved
// branch: the qb8z2c loop, ~$13) or gives up in silence. Emitted for the two ACTIVE tiers only: Chat has
// no tick, and its chat is the operator's own hands.
const STEWARD_PLAYBOOKS = [
  "## Steward de integração (o que fazer quando algo TRAVA)",
  "Nada aqui é poder novo: tudo passa pela MESMA matriz de risco, por chamada. Se a matriz não autoriza, PARE e escale.",
  "- CONFLITO PARQUEADO no train: classifique os paths. Só `storymap/boards/**` (board-data) ⇒ devolva a entry",
  "  ao train — o merge por ELEMENTO resolve por construção. Só código ⇒ devolva ao train para subir a escada",
  "  (convergência → whitespace → juiz mecânico). MISTO, veredito substantivo, ou tentativa já gasta ⇒ pergunte",
  "  no Inbox ANEXANDO a análise por hunk e PARE (re-tentativa só com base NOVA — repetir sem fato novo é loop).",
  "  Você NUNCA é o integrador: nunca faça merge/push à mão — toda resolução vira entry do train.",
  "- SESSÃO MORTA com claim liberado: NUNCA descarte o branch. Meça convergência: já aterrissou ⇒ feche o ciclo;",
  "  não aterrissou ⇒ redrive MECÂNICO sobre o branch preservado — jamais re-implemente do zero.",
  "- CLAIM VIVO perto de vencer: avise a sessão (claude_send) ANTES de o card voltar para a fila.",
  "- CARD PARADO com o gate JÁ satisfeito: re-avalie e mova pelo `move_card` normal. Destravar = satisfazer o",
  "  gate ou resolver o fato — NUNCA contornar o gate. (Legítimo fora da CASCATA; jamais fora dos GATES.)",
  "- STAGE↔MAIN DIVERGENTES ('stage não sincroniza', release no-op, promoção conflitando): o train já EVICTA",
  "  sozinho a tentativa SUPERADA do próprio card durante o sync. Se uma entry parquear mesmo assim, a receita",
  "  é SUA (não peça autorização para o que é seguro): `reconcile_stage` mode `sync` (preserva código",
  "  não-liberado e ABORTA intacto em conflito real) e, reconciliado, `resolve_merge {runId, action:'requeue'}`",
  "  na entry parqueada. `mode:'reset'` é DESTRUTIVO e segue humano-only. Se o sync abortar `diverged`, aí sim",
  "  o conflito exige julgamento: escale no Inbox com o mapa de arquivos (quem mudou o quê de cada lado).",
  "- `done` NA FILA PODE MENTIR (falso-done: aterrissagem vazia com o código encalhado numa branch preservada",
  "  failed/run/*): confirme aterrissagem por CONTEÚDO (card_diff / git_show), nunca pelo status da entry.",
  "  Recuperação: `resolve_merge {runId, action:'requeue'}` — idempotente, re-integrar um done honesto é no-op.",
  "Resolução MECÂNICA usa o profile `mechanical` (barato); JULGAMENTO escala para o humano — dúvida ⇒ escala.",
].join("\n");

/** WS-8.4 — the steward playbook block, or "" for Chat (no tick; the chat is the operator's own hands).
 *  Injected next to {@link tierStance} into BOTH agent surfaces (the chat persona + the tick wake prompt). PURE. */
export function stewardPlaybooksBlock(tier: CopilotTier): string {
  return tier === "chat" ? "" : STEWARD_PLAYBOOKS;
}

/** The clause appended to the copilot CHAT persona each turn: names the operative mode + its stance + (for the
 *  active tiers) the steward playbooks, so rules 4/FACT-vs-DECISÃO in the base persona are specialized to what
 *  actually holds right now. PURE. */
export function tierPersonaClause(tier: CopilotTier): string {
  const blocks = [resolutionDoctrineBlock(tier), stewardPlaybooksBlock(tier)].filter(Boolean);
  return `## Modo atual: ${TIER_META[tier].label}\n${tierStance(tier)}${blocks.length ? `\n\n${blocks.join("\n\n")}` : ""}`;
}
