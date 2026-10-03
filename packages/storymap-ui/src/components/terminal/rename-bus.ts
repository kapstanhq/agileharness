"use client";

// rename-bus.ts — o aviso de que um terminal foi RENOMEADO.
//
// O PROBLEMA que ele resolve: o operador renomeia um terminal no bloco da home e o chip Terminal do
// topnav segue mostrando o nome antigo por até um minuto. Ele lê /api/terminal/sessions num poll de 60s,
// e esse intervalo NÃO é o que se deve encurtar: aquela rota é a cara (vários spawns de tmux/ps mais a
// leitura de todos os cards de todos os boards, ~350-600ms medidos). Triplicar a frequência dela para
// cobrir uma ação pontual seria pagar continuamente por algo que acontece num clique.
//
// Então quem ESCREVE avisa: o rename dispara o bus depois que o PATCH resolve, e toda superfície que
// mostra nome de terminal re-lê UMA vez, na hora. O poll continua lento; o rename fica instantâneo.
//
// POR QUE UM BUS E NÃO UM CONTEXT: os consumidores vivem em ÁRVORES DIFERENTES (o chip mora no
// BoardHeader; o bloco de terminais mora na home). Um provider comum teria de envolver a página inteira
// para carregar um sinal sem estado. Mesmo idioma do `copilot/meter-bus`.

type Listener = () => void;

const listeners = new Set<Listener>();

/** Avisa que o nome de exibição de algum terminal mudou. Chame DEPOIS que o PATCH resolver. */
export function notifyTerminalRenamed(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* um assinante quebrado nunca impede os outros de serem avisados */
    }
  }
}

/** Assina; devolve o unsubscribe para o cleanup do effect. */
export function onTerminalRenamed(handler: Listener): () => void {
  listeners.add(handler);
  return () => listeners.delete(handler);
}
