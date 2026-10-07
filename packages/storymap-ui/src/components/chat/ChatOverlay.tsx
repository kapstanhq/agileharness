"use client";

// A CONVERSA POR CIMA DA TELA — o que o compositor do Jido abre quando a pessoa o toca ou começa a escrever.
//
// Um véu claro (radial, com um borrão leve) cobre a tela inteira, "Fechar Esc" no canto (com as ferramentas da
// conversa logo à esquerda dele — o anexo, o anel de contexto rotulado, o histórico e a nova conversa; nada mais
// flutua no topo, e a caixa de escrever fica só com `/` e enviar), e a conversa numa coluna
// central (até 760px) que termina logo ACIMA do compositor — o compositor não é desta peça: ele fica fixo no rodapé,
// por cima do véu, e é a única caixa de texto (ver JidoComposer, que também é o DIÁLOGO modal: papel, nome, `inert`
// no resto da página e o foco de volta a quem abriu). No celular a conversa ocupa a tela inteira acima
// dele.
//
// Numa página de documento (`surface`), a coluna é a conversa DO DOCUMENTO — o mesmo núcleo (ChatPanel) na raia da
// superfície, com os atalhos e as técnicas dela —, em vez do Jido do board.
//
// O motor é o de sempre (CopilotChatPanel → ChatPanel): sessão com lease, rota de turno, sementes de escalação,
// aprovações e perguntas inline, histórico, nova conversa, o medidor. Esta peça só dá a MOLDURA. "Montado = aberto":
// fechar DESMONTA o painel, e é o desmonte que solta o lease de pareamento (o tick volta na hora).
//
// Carregada sob demanda (o JidoComposer a importa por next/dynamic): o chunk da conversa só baixa quando ela abre.

import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { CopilotChatPanel } from "@/components/CopilotChat";
import { ViewChat } from "@/components/ViewChat";
import { CardLinksProvider } from "@/components/chat/card-links";
import type { ExternalComposer } from "@/components/chat/ChatPanel";
import type { CopilotSeed } from "@/lib/storymap/copilot/escalation-seed";
import type { JidoDocSurface } from "@/components/chat/JidoComposer";

/**
 * O véu — branco no centro, translúcido nas bordas, em TOKENS (a superfície e o fundo da página), para o tema
 * escuro ganhar o mesmo véu na cor dele em vez de um clarão branco.
 */
const VEIL_BG =
  "radial-gradient(ellipse 60% 75% at 50% 58%, rgb(var(--surface)) 0%, rgb(var(--surface) / 0.97) 45%, rgb(var(--surface) / 0.78) 75%, rgb(var(--canvas) / 0.55) 100%)";

export function ChatOverlay({
  boardId,
  boardName,
  seed,
  surface,
  externalComposer,
  headerTools,
  onClose,
}: {
  boardId: string;
  boardName: string;
  seed?: CopilotSeed;
  /** a conversa do documento da tela; ausente ⇒ o Jido do board. */
  surface?: JidoDocSurface;
  externalComposer: ExternalComposer;
  /** o que o compositor põe no topo, antes das ferramentas do painel (o anexo de imagem, o «abrindo…»). */
  headerTools?: ReactNode;
  onClose: () => void;
}) {
  // O canto onde o painel desenha (por portal) o histórico e a nova conversa — a mesma fileira do "Fechar".
  const [actionsSlot, setActionsSlot] = useState<HTMLSpanElement | null>(null);
  return (
    <>
      {/* O VÉU — clicar fora da conversa fecha. É um botão (alcançável e com nome), sem foco visível próprio:
          o "Fechar" logo acima é a saída de teclado. No celular o véu é a superfície OPACA: a conversa ocupa a tela
          inteira (o texto do quadro não vaza por trás das mensagens); do md para cima, o véu radial do desenho. */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Fechar a conversa"
        onClick={onClose}
        className="fixed inset-0 z-[55] cursor-default bg-surface md:bg-transparent md:backdrop-blur-[2px] md:[background:var(--ah-veil)]"
        style={{ "--ah-veil": VEIL_BG } as React.CSSProperties}
      />
      <div className="fixed right-3 top-3 z-[57] flex items-center gap-0.5 md:right-4 md:top-4">
        {headerTools}
        {/* no celular os ícones do painel ganham o alvo de toque de 40px (o `BTN_ICON` do painel é de 28px) */}
        <span ref={setActionsSlot} className="flex items-center gap-0.5 text-fg-muted max-md:[&_button]:h-10 max-md:[&_button]:w-10" />
        <button
          type="button"
          onClick={onClose}
          title="Fechar (Esc)"
          className="flex h-10 items-center gap-2 rounded-lg px-2.5 text-[13px] text-fg-muted transition hover:bg-surface-hover hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-fg md:h-8"
        >
          <X className="h-4 w-4 md:hidden" aria-hidden />
          <span className="hidden md:inline">Fechar</span>
          <kbd className="hidden h-5 items-center rounded-[5px] border border-line-muted px-[5px] font-sans text-[11px] text-fg-subtle md:flex">
            Esc
          </kbd>
        </button>
      </div>
      {/* A COLUNA da conversa: de logo abaixo da fileira do topo até o topo do compositor, que publica a própria altura
          em `--jido-composer-h`. Sem a variável (o compositor ainda medindo), 190px — a altura do desenho.
          O TOPO some num degradê de 40px (a máscara), e o transcript reserva esses 40px no alto (`pt-10` no rolador):
          parada, a 1ª mensagem nasce inteira abaixo do degradê; rolando, a linha que sobe se APAGA aos poucos — nunca
          uma linha cortada ao meio logo abaixo dos ícones (com 16px de degradê, uma linha de 20px ficava meio visível). */}
      <div
        className="pointer-events-none fixed inset-x-0 top-[60px] z-[56] flex justify-center [mask-image:linear-gradient(to_bottom,transparent,#000_40px)] md:top-16"
        style={{ bottom: "var(--jido-composer-h, 190px)" }}
      >
        <div className="pointer-events-auto flex h-full w-full max-w-[760px] flex-col px-0 md:px-4 [&_.chat-scroll]:pt-10">
          {/* os ids de card na resposta do Jido aparecem como o TÍTULO do card (link) — chat/card-links */}
          <CardLinksProvider boardId={boardId}>
            {surface ? (
              <ViewChat
                boardId={boardId}
                view={surface.view}
                context="Lendo o documento…"
                getContext={surface.getContext}
                empty={surface.empty}
                externalComposer={{ ...externalComposer, actionsSlot }}
                className="bg-transparent"
              />
            ) : (
              <CopilotChatPanel
                boardId={boardId}
                boardName={boardName}
                seed={seed}
                externalComposer={{ ...externalComposer, actionsSlot }}
                // transparente: o véu já é o fundo — uma coluna de superfície opaca desenharia um retângulo sobre ele.
                className="bg-transparent"
              />
            )}
          </CardLinksProvider>
        </div>
      </div>
    </>
  );
}
