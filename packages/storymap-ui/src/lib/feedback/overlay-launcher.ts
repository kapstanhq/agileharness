// A PORTA do modo «Marcar ajuste» quando quem a oferece é o APP, e não o botão flutuante do overlay.
//
// O overlay (`public/ah-overlay.js`) é vanilla e viaja para qualquer app; o padrão dele é a pílula no canto de baixo à
// esquerda. No AgileHarness essa pílula pousava em cima da 1ª raia do Kanban (num notebook de ~600px de altura, em cima
// do card da Triagem). O layout passa `launcher: "host"` na config: em repouso a pílula some, e a entrada vira um item
// do menu da engrenagem (shell/SettingsMenu → nav/BoardMenu). Durante a marcação a pílula volta — é o «Parar».
//
// O contrato entre os dois lados é um EVENTO na window, não um objeto global com métodos: o script carrega `async`, e
// um evento disparado antes de ele existir é só um no-op, nunca um `undefined is not a function`. O nome mora aqui e
// no overlay; o teste confere que é o mesmo texto nas duas pontas.

/** O evento que liga/desliga a marcação (o overlay escuta na window). */
export const FEEDBACK_TOGGLE_EVENT = "ah-feedback:toggle";

/** O valor de `launcher` que o layout passa ao overlay: a porta é do app (o item do menu), não a pílula do canto. */
export const HOST_LAUNCHER = "host";

/** O overlay está montado nesta página? (Ele não monta em rota pública nem sem board próprio — overlay-mount.ts.) */
export function feedbackOverlayReady(): boolean {
  return typeof window !== "undefined" && Boolean((window as Window & { __AH_OVERLAY_MOUNTED__?: boolean }).__AH_OVERLAY_MOUNTED__);
}

/** Liga a marcação (ou a desliga, se já estiver ligada) — o mesmo efeito do clique na pílula do overlay. */
export function toggleFeedbackMarking(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FEEDBACK_TOGGLE_EVENT));
}
