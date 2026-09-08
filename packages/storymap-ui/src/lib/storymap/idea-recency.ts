// QUANDO uma ideia chegou — a régua de tempo da bancada. PURO (sem React/IO).
//
// O card só guarda `created` com granularidade de DIA; `updatedMs` (mtime do arquivo) é o único sinal
// com hora/minuto — e, para um card recém-criado e não editado, mtime == criação ("chegou primeiro").
// Por isso ele é a chave de ORDENAÇÃO (dentro de um grupo) e de EXIBIÇÃO (DD/MM HH:MM) de cada linha.
//
// O AGRUPAMENTO por data (esta semana / este mês / antigas) foi REMOVIDO: a lista passou a agrupar por
// estado de exploração (`groupIdeasByStatus` em `idea.ts`), que é a pergunta que a tela faz — "o que
// eu ainda não decidi", não "no que eu mexi". Com ele foram os três helpers de fronteira de data e o
// caminho `now === null` (lista plana no SSR): agrupar por status não depende de fuso, então não há
// mais mismatch de hidratação para contornar. `git log -S startOfWeekMs` tem a versão antiga.

import type { Card } from "./types";

export function ideaTs(c: Card): number {
  if (typeof c.updatedMs === "number") return c.updatedMs;
  if (c.created) {
    const ms = Date.parse(c.created);
    if (!Number.isNaN(ms)) return ms;
  }
  return 0;
}

export function formatIdeaTs(ms: number, now: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date =
    new Date(now).getFullYear() === d.getFullYear()
      ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
      : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
