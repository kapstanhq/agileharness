// Pure display label for a captured ProposedItem's type. Lives APART from SmartCaptureModal (a
// "use client" component that pulls the server actions) so it's unit-testable in isolation.
//
// THE bug this guards: a type:"idea" item (a DOR / problem-space card, born off-pipeline with
// storyType:null) used to fall through to STORY_TYPE_BY_ID[storyType ?? "user"] → it rendered as
// "USER STORY" in the capture preview, masking the dor→ideia classification (the model
// classified right; the chip lied). Handle every CardType explicitly.
import { STORY_TYPE_BY_ID } from "../frameworks";
import type { ProposedItem } from "./types";

export function proposedTypeLabelText(item: Pick<ProposedItem, "type" | "storyType">): string {
  switch (item.type) {
    case "activity":
      return "Atividade";
    case "step":
      return "Step";
    case "idea":
      return "Ideia";
    default:
      return STORY_TYPE_BY_ID[item.storyType ?? "user"].name;
  }
}
