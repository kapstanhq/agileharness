"use client";

// A configuração de ARRASTO dos dois boards (Kanban e Story Map), em UM lugar.
//
// Por que existe: os dois usavam `PointerSensor` com `activationConstraint: { distance: 5 }`. O
// PointerSensor unifica mouse e toque, então essa regra dizia "5px de movimento = arraste" TAMBÉM
// para o dedo — e 5px é menos que o tremor de um scroll. Resultado: rolar o board no touch (ou um
// micro-arrasto no trackpad) movia card sem querer. No Kanban isso não é cosmético: o drop muda o
// STATUS, que passa pelo gate, dispara `ENTRY_EFFECTS` e pode spawnar um run headless.
//
// O padrão documentado do dnd-kit para isso é separar os sensores (docs "Sensors"):
//   • MOUSE — distância. O ponteiro é preciso, então basta exigir deslocamento antes de ativar.
//   • TOQUE — press-and-hold (`delay`) + `tolerance`. Com delay, um swipe rápido é SCROLL e nunca
//     vira arraste; só o toque que fica parado vira arraste. A doc observa que "some tolerance
//     should be accounted for when using a delay constraint, as touch input is less precise than
//     mouse input" — daí os 8px de folga durante a espera.
// Os valores abaixo são os dos exemplos da própria doc (mouse 10px; toque 250ms), com a tolerância
// um pouco mais generosa que os 5px do exemplo porque o board é rolável nos DOIS eixos.
//
// ⚠️ Junto com isso, todo elemento arrastável precisa de `touch-action: manipulation` (classe
// `touch-manipulation`) — a doc marca como "highly recommended" para o Touch sensor. Sem isso o
// navegador pode sequestrar o gesto antes do dnd-kit vê-lo.

import { KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";

/** Deslocamento do MOUSE (px) antes de virar arraste — filtra o clique com tremor. */
const MOUSE_ACTIVATION_DISTANCE = 10;
/** Tempo (ms) com o dedo parado antes de virar arraste — abaixo disso o gesto é scroll. */
const TOUCH_ACTIVATION_DELAY = 250;
/** Folga (px) tolerada durante a espera do toque; passou disso, é scroll e o arraste é abortado. */
const TOUCH_ACTIVATION_TOLERANCE = 8;

/**
 * Os sensores compartilhados pelos boards arrastáveis. Um único hook para que Kanban e Story Map
 * não possam divergir — uma segunda cópia desta regra é a garantia de que um dos dois volta a mover
 * card sozinho no toque.
 */
export function useBoardDragSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: MOUSE_ACTIVATION_DISTANCE } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: TOUCH_ACTIVATION_DELAY, tolerance: TOUCH_ACTIVATION_TOLERANCE },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}
