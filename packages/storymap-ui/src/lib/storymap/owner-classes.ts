// As CLASSES DO DONO — a lista declarada (`autonomy.ownerClasses`), o default no código e o rótulo. PURA e SEM
// dependência de propósito: autonomy.ts e decision-class.ts leem daqui sem formar ciclo. O porquê das classes está
// em decision-class.ts.

import type { BoardConfig, OwnerClassDef } from "./types";

/** A classe que o piso de dinheiro aponta — nunca sai da lista de um board. */
export const MONEY_CLASS = "money";

/** As quatro classes do dono — o MESMO texto que o `_base/board.yaml` declara (um teste fixa a paridade). */
export const DEFAULT_OWNER_CLASSES: readonly OwnerClassDef[] = [
  {
    id: "money",
    label: "Dinheiro e preço",
    description:
      "Qualquer compromisso de gasto: contratar fornecedor, assinar plano pago, comprar créditos, definir ou mudar preço, mexer no código de cobrança, ultrapassar os tetos mensais de custo, ou trocar o modelo de IA usado nas respostas ao usuário (muda o custo por chamada e a qualidade).",
  },
  {
    id: "brand-voice",
    label: "Falar em nome da marca",
    description:
      "Comunicação FORA do produto: posts em redes sociais, e-mail ou push para muitos usuários. O texto de dentro do produto (telas, botões, mensagens do app) não entra: segue o guia de marca do board, e o dono o confere na amostra do que o usuário vê.",
  },
  {
    id: "prd",
    label: "PRD e metas",
    description: "Mudar o escopo, as apostas, as métricas, as metas ou os prazos do PRD.",
  },
  {
    id: "personal-data",
    label: "Dados de pessoas",
    description:
      "Coleta de telefone, e-mail, localização ou nome de uma pessoa; envio de dados a um fornecedor NOVO; apagar dados de usuários; tornar público algo que era privado. Medição anônima já coberta pela política de privacidade vigente fica de fora (é técnica).",
  },
];

/** As classes do dono DESTE board: as declaradas (o `_base` herdado ou a lista do board), senão o default — com
 *  `money` sempre presente (o piso de dinheiro não se desliga por config). PURA. */
export function ownerClassesOf(config: Pick<BoardConfig, "autonomy"> | null | undefined): OwnerClassDef[] {
  const declared = config?.autonomy?.ownerClasses?.filter((c) => c && c.id);
  const list = declared?.length ? declared : [...DEFAULT_OWNER_CLASSES];
  if (list.some((c) => c.id === MONEY_CLASS)) return list;
  return [DEFAULT_OWNER_CLASSES[0], ...list];
}

/** O rótulo humano de uma classe do dono (o id quando o board não a declara). PURA. */
export function ownerClassLabel(id: string, config: Pick<BoardConfig, "autonomy"> | null | undefined): string {
  return ownerClassesOf(config).find((c) => c.id === id)?.label ?? id;
}
