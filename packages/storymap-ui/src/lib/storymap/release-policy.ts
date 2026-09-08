// A POLÍTICA DE RELEASE de um board: quem aperta o botão, e se ele se aperta sozinho.
//
// UMA declaração (`board.yaml release.mode`) responde as duas perguntas que antes moravam em três
// lugares que podiam discordar:
//
//   1. `autorun.publishQueue.boards` (settings)      → caminho da SESSÃO (trabalho sem card)
//   2. o `autorun` do passo `deploy` (board.yaml)     → caminho do CARD
//   3. `orchestrator.riskMatrix.deploy` (board.yaml)  → caminho AUTÔNOMO
//
// O defeito não era ter três caminhos — é legítimo publicar por sessão, por card ou por agente. Era
// (1) responder DUAS perguntas com UMA flag e (2) as três poderem se contradizer sobre o mesmo ato.
//
// A flag antiga `publishQueue.boards` conflatava:
//   • "este board PODE ser publicado?" (existe alavanca para o humano)
//   • "ele publica SOZINHO?" (o sistema enfileira por conta própria)
// Desligar tirava as duas. Era por isso que o trabalho de sessão do `acme` não tinha saída nenhuma:
// não porque um humano precisava decidir, mas porque a flag que daria o botão ao humano era a mesma
// que tirava o humano do caminho. 7 commits ficaram 6 dias parados sem que nada os pudesse mover.
//
// Agora:
//   `manual` → acumula integrado e sem conflito; QUEM PEDE é um humano (botão da Esteira) ou um agente
//              autorizado (`riskMatrix.deploy: auto` no modo autônomo). Uma publicação leva TODO o lote.
//   `auto`   → idem, mais um produtor que pede sozinho quando há trabalho staged (o comportamento
//              contínuo do board `storymap` hoje).
//
// Em AMBOS os modos o pedido percorre a mesma máquina — fila, embargo de concorrência, janela de
// ociosidade, `firePromoteAndDeploy`. `mode` decide só QUEM origina o pedido, nunca como ele é servido.
// Isso é deliberado: um segundo caminho de deploy seria uma segunda verdade sobre o ato mais perigoso
// do sistema.
//
// PURO: sem IO, sem git, sem config global. Quem chama passa o que leu.

import type { BoardConfig, ReleaseMode, StatusDef } from "./types";

/**
 * O default é `manual` — e é uma escolha de segurança, não de gosto: um board que ainda não declarou
 * política NÃO deve começar publicando em produção sozinho. `_base` declara `manual`; quem quer o
 * contínuo opta por dentro (hoje só `storymap`, cujo "deploy" é reiniciar um serviço interno).
 */
export const DEFAULT_RELEASE_MODE: ReleaseMode = "manual";

/** O modo declarado por este board, com o default seguro quando ele não declarou. */
export function releaseModeOf(config: Pick<BoardConfig, "release"> | null | undefined): ReleaseMode {
  const mode = config?.release?.mode;
  return mode === "auto" || mode === "manual" ? mode : DEFAULT_RELEASE_MODE;
}

/**
 * O sistema enfileira publicação por conta própria para este board?
 *
 * É a metade "publica sozinho". A outra metade — "pode publicar" — NÃO depende do modo: nos dois
 * um humano ou um agente autorizado pode pedir. Essa separação é o coração desta mudança.
 */
export function publishesItself(mode: ReleaseMode): boolean {
  return mode === "auto";
}

/**
 * O passo `Publicar` do pipeline avança sozinho quando um card entra nele?
 *
 * DERIVADO do mesmo modo, nunca declarado por board — é isto que impede o caminho do CARD de
 * discordar do caminho da SESSÃO sobre o mesmo ato. Um board que autora `autorun` no passo `deploy`
 * está criando a segunda verdade que esta função existe para eliminar (o lint `board-integrity`
 * reprova).
 */
export function deployStepAutorun(mode: ReleaseMode): boolean {
  return publishesItself(mode);
}

/** O id do passo cujo `onEnter` promove+publica — o passo cujo `autorun` esta política governa. */
export const DEPLOY_STEP_ID = "deploy";

/**
 * Aplica {@link deployStepAutorun} ao passo `deploy` da lista JÁ resolvida (`_base` ⊕ board).
 *
 * É aqui que "uma declaração só" deixa de ser intenção e vira invariante: qualquer `autorun` que um
 * board tenha autorado nesse passo é SOBRESCRITO pelo derivado. O lint `board-integrity` reprova a
 * autoria para que a sobrescrita nunca seja uma surpresa silenciosa — mas mesmo que alguém escape do
 * lint, o runtime continua com uma verdade só.
 *
 * Puro e total: devolve uma lista nova, não muta a recebida.
 */
export function withDerivedDeployAutorun(statuses: readonly StatusDef[], mode: ReleaseMode): StatusDef[] {
  const autorun = deployStepAutorun(mode);
  return statuses.map((s) => (s.id === DEPLOY_STEP_ID && s.autorun !== autorun ? { ...s, autorun } : s));
}

/**
 * A publicação pode ser PEDIDA para este board agora?
 *
 * Independe do modo — depende só de a máquina existir: o master switch do Operador
 * (`autorun.publishQueue.enabled`, que é kill-switch global, não política por board) e o staging
 * ligado (sem `stage` não há o que promover). É o gate que a action da Esteira e a tool MCP passam a
 * usar, no lugar da lista de boards.
 */
export function mayRequestPublish(o: { queueEnabled: boolean; stagingEnabled: boolean }): boolean {
  return o.queueEnabled && o.stagingEnabled;
}

/**
 * O produtor do modo `auto` deve abrir um pedido para este board AGORA?
 *
 * Nível, não borda — de propósito. A ação é IDEMPOTENTE por (board, sha) e o efeito é auto-cicatrizante:
 * um serviço que reinicia entre a integração e o pedido volta e reavalia, em vez de perder o gatilho.
 * (A armadilha borda×nível que já custou caro aqui é a dos ALERTAS, onde nível vira spam; aqui não há
 * spam possível — sem trabalho staged ou com pedido aberto, isto devolve `false`.)
 *
 * `hasOpenRequest` evita empilhar pedidos quando o stage anda enquanto um já espera a janela ociosa:
 * o pedido aberto já leva o lote inteiro, e um segundo só supersederia o primeiro.
 */
export function shouldAutoEnqueue(o: { mode: ReleaseMode; stagedTotal: number; hasOpenRequest: boolean }): boolean {
  return publishesItself(o.mode) && o.stagedTotal > 0 && !o.hasOpenRequest;
}

/** O motivo, em uma frase, de `mayRequestPublish` ter dito não — para a mensagem de erro não ser muda. */
export function publishRefusalReason(o: { queueEnabled: boolean; stagingEnabled: boolean }): string | null {
  if (!o.stagingEnabled)
    return "O staging está desligado (autorun.staging.enabled) — não há branch de stage para promover.";
  if (!o.queueEnabled)
    return (
      "A fila de publicação está desligada no settings.yaml (autorun.publishQueue.enabled). " +
      "É o kill-switch GLOBAL do mecanismo, não a política deste board — a política é `release.mode` no board.yaml."
    );
  return null;
}
