// O Trajeto do card em palavras: o código que o motor grava como motivo de cada salto («merge:approved») vira frase. PURA.

/** O motivo gravado no histórico («merge:approved», «triage-judge:accept») em palavras; desconhecido fica como está. PURA. */
export function hopNoteWords(note: string): string {
  const at = note.indexOf(":");
  const kind = at > 0 ? note.slice(0, at) : note;
  const rest = at > 0 ? note.slice(at + 1) : "";
  const KIND: Record<string, string> = {
    merge: "integração",
    deploy: "publicação",
    "triage-judge": "triagem",
    reconcile: "acerto automático",
    undo: "desfeito",
    reopen: "reaberto",
    resolve: "resolvido",
    transfer: "mudou de board",
  };
  const DETAIL: Record<string, string> = {
    approved: "aprovada",
    reproved: "reprovada",
    reverted: "revertida",
    "already-live": "já estava no ar",
    accept: "aceito",
    discard: "descartado",
    duplicate: "duplicado",
    route: "mandado a outro board",
    hold: "segurado para o dono",
    "merge-back": "voltou da integração",
    inbox: "pelo Inbox",
    "return-to-triage": "voltou à triagem",
    "security-review": "pela revisão de segurança",
  };
  if (!KIND[kind]) return note;
  const d = rest.trim();
  return d ? `${KIND[kind]} ${DETAIL[d] ?? d}` : KIND[kind];
}

/** As palavras de QUEM moveu, na linha do tempo do card (CardStageHistory): o papel gravado em português. PURA. */
export function hopActorWords(actor: string): string {
  const fixed: Record<string, string> = {
    human: "você",
    cascade: "automático",
    system: "sistema",
    merge: "integração",
    sentinel: "Sentinela",
    chat: "chat",
    proxy: "procurador",
    critic: "revisor independente",
  };
  if (fixed[actor]) return fixed[actor];
  if (actor.startsWith("conductor:")) return "condutor";
  if (actor.startsWith("external:")) return "agente de fora";
  if (actor.startsWith("session:")) return "sessão de agente";
  if (actor.startsWith("run:")) return "agente";
  return actor;
}
