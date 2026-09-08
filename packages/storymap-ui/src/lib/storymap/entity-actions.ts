// Catálogo DECLARATIVO de ações por entidade — descreve QUAIS ações se aplicam a um Card (rótulo,
// ícone, se é destrutiva, **se precisa de confirmação**, se entra no lote). A EXECUÇÃO (server action) é
// injetada pelo container: a modal de captura usa o caminho SÍNCRONO inline de gerar stories; a bancada
// usa o ASSÍNCRONO → Inbox. Mesmo descritor, executores diferentes por superfície — assim os blocos ficam
// puros e reutilizáveis nas 3 superfícies sem arrastar server action/router.refresh junto.
//
// O que MUDOU aqui em 2026-07-31, e por quê: "precisa confirmar" era decisão de cada CONTAINER, e por isso
// as superfícies divergiam — a bancada perguntava antes de excluir e disparava a captura no primeiro
// clique. Confirmar é propriedade da AÇÃO, não do lugar de onde ela sai; agora mora neste arquivo e as
// superfícies só obedecem (`confirmFor`). Ver entity-actions.test.ts, que guarda as três.
//
// PURO em runtime (sem IO); importa só ícones lucide (componentes) — usado apenas por client components.

import type { LucideIcon } from "lucide-react";
import { Sparkles, Trash2 } from "lucide-react";
import type { Card } from "./types";

export type EntityActionId = "generate-stories" | "delete";

/**
 * A CONFIRMAÇÃO de uma ação — o gate, e a cópia que ele mostra.
 *
 * Por que ela mora no CATÁLOGO e não em cada container: "precisa confirmar" é propriedade da AÇÃO, não do
 * lugar de onde ela é disparada. Enquanto era do container, cada superfície decidia de novo — e uma delas
 * decidiu errado: a bancada confirmava `delete` e disparava `generate-stories` no primeiro clique, sem
 * pergunta. Um toque de raspão numa linha (o alvo tem 24px e vive ao lado do «Excluir») gastava um agente,
 * minutos e tokens, e deixava um contêiner + uma proposta para o operador limpar à mão.
 *
 * `destructive` continua governando o PESO VISUAL (vermelho, ícone de alerta); `confirm` governa o GATE.
 * As duas coisas não são a mesma: gerar tarefas não destrói nada — e mesmo assim tem consequência que o
 * operador precisa querer.
 *
 * As funções recebem QUANTOS cards a ação vai atingir (1 na linha, N no lote) para a pergunta ser sobre o
 * que vai acontecer de fato, e não uma frase genérica com um número colado.
 */
export interface EntityActionConfirm {
  title: (n: number) => string;
  /** a CONSEQUÊNCIA — o que acontece ao confirmar. Nunca a repetição do rótulo do botão. */
  description: (n: number) => string;
  confirmLabel: string;
  tone?: "default" | "danger";
}

export interface EntityActionDescriptor {
  id: EntityActionId;
  label: string;
  icon: LucideIcon;
  /** este descritor se aplica a este card? */
  appliesTo: (card: Card) => boolean;
  /** ações destrutivas: peso visual (vermelho + alerta). Ver `confirm` para o GATE. */
  destructive?: boolean;
  /**
   * Presente ⇒ o container TEM de perguntar antes de rodar. Ausente ⇒ a ação é barata e reversível e sai
   * no primeiro clique. Um container que ignore isto está com defeito — `confirmFor` existe para que
   * perguntar seja mais fácil do que esquecer.
   */
  confirm?: EntityActionConfirm;
  /** pode aparecer na barra de ações em lote? */
  batchable?: boolean;
  /** peso visual sugerido (o bloco pode sobrepor). */
  tone?: "primary" | "ghost" | "danger";
}

export const ENTITY_ACTIONS: EntityActionDescriptor[] = [
  {
    id: "generate-stories",
    label: "Gerar tarefas",
    icon: Sparkles,
    appliesTo: (c) => c.type === "idea",
    batchable: true,
    tone: "primary",
    confirm: {
      title: (n) => (n === 1 ? "Gerar tarefas desta ideia?" : `Gerar tarefas de ${n} ideias?`),
      description: (n) =>
        n === 1
          ? "Dispara um agente que lê a ideia e PROPÕE as tarefas — leva alguns minutos e consome tokens. " +
            "A proposta espera por você no Inbox: nenhum card é criado até você aceitar lá."
          : `Dispara ${n} agentes, um por ideia — leva alguns minutos e consome tokens. As propostas esperam ` +
            "por você no Inbox: nenhum card é criado até você aceitar.",
      confirmLabel: "Gerar",
    },
  },
  {
    id: "delete",
    label: "Excluir",
    icon: Trash2,
    appliesTo: (c) => c.type === "idea",
    destructive: true,
    batchable: true,
    tone: "danger",
    confirm: {
      title: (n) => (n === 1 ? "Excluir ideia?" : `Excluir ${n} ideias?`),
      description: () => "Vai para a lixeira do board — recuperável por 7 dias.",
      confirmLabel: "Excluir",
      tone: "danger",
    },
  },
];

/** Os descritores aplicáveis a UM card. */
export function actionsFor(card: Card): EntityActionDescriptor[] {
  return ENTITY_ACTIONS.filter((a) => a.appliesTo(card));
}

/**
 * A confirmação de uma ação, já resolvida para `n` cards — ou `null` quando ela não precisa de nenhuma.
 *
 * É o atalho que torna PERGUNTAR o caminho mais curto: o container faz `const c = confirmFor(id, n)` e,
 * se vier algo, abre o diálogo com essa cópia. Sem ele, cada superfície reescreveria os títulos e as
 * consequências — e a terceira reescrita é onde a cópia começa a divergir do que a ação faz.
 */
export function confirmFor(id: EntityActionId, n: number): { title: string; description: string; confirmLabel: string; tone: "default" | "danger" } | null {
  const c = ENTITY_ACTIONS.find((a) => a.id === id)?.confirm;
  if (!c) return null;
  return { title: c.title(n), description: c.description(n), confirmLabel: c.confirmLabel, tone: c.tone ?? "default" };
}

/** Ações de LOTE válidas para uma SELEÇÃO: batchable E aplicável a TODOS os cards selecionados. */
export function batchActionsFor(cards: Card[]): EntityActionDescriptor[] {
  if (!cards.length) return [];
  return ENTITY_ACTIONS.filter((a) => a.batchable && cards.every((c) => a.appliesTo(c)));
}
