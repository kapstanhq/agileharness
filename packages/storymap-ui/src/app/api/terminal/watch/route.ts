// Arma/desarma a CAMPAINHA de "este terminal ficou quieto" para UMA sessão tmux.
//
// A página do terminal chama isto quando o operador liga o sininho, e RENOVA enquanto a aba vive: a
// preferência carrega um TTL, então fechar a aba a desliga sozinha — não há unsubscribe para vazar.
//
// O QUE MUDOU (e por que a rota continua igual): a amostragem de tela deixou de ser deste endpoint.
// Quem observa os panes agora é o vigia ÚNICO e always-on (lib/terminal/attention-watch), que já
// classifica cada terminal em "esperando você" / "ficou quieto" para os alertas, para o Jido e para o
// contexto do chat. O sininho virou o que ele sempre foi de fato: uma PREFERÊNCIA de push por sessão
// (o degrau `quiet`; um terminal parado num PROMPT empurra sempre, porque trava trabalho).

import { armQuietPush, armedQuietPush, disarmQuietPush } from "@/lib/terminal/attention-watch";
import { ATTENTION_SETTLE } from "@/lib/terminal/attention";
// The ≤80 slug (lib/vps/tmux) that attach-session.sh agrees with — the ≤64 dev-tools variant would
// silently reject long `card-<board>__<cardId>` names on this path.
import { isSafeSessionName } from "@/lib/vps/tmux";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let body: { session?: unknown; enabled?: unknown; idleMs?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "expected JSON body" }, { status: 400 });
  }

  const session = typeof body.session === "string" ? body.session : "";
  // The same slug the shell router enforces. The name reaches `tmux -t`, so it must never be able
  // to read as a flag — execFile already runs shell:false; this is the second layer.
  if (!isSafeSessionName(session)) {
    return Response.json({ ok: false, error: "invalid session name" }, { status: 400 });
  }

  if (body.enabled === false) {
    disarmQuietPush(session);
    return Response.json({ ok: true, watching: false, idleMs: ATTENTION_SETTLE.idleMs });
  }

  armQuietPush(session);
  // O SERVIDOR é dono do limiar, e a resposta o DEVOLVE. O cliente mandava um `idleMs` que esta rota
  // passou a ignorar (o mesmo estado alimenta o balão do Jido e o contexto do chat, então uma sessão
  // não pode ter uma noção própria de "quieto") — e um parâmetro aceito e jogado fora é pior que um
  // recusado: o cliente segue acreditando que configurou algo. Devolvendo o valor efetivo, o detector
  // LOCAL da página (que também mede silêncio, para a aba aberta) se alinha ao do servidor em vez de
  // carregar uma constante paralela que envelhece sozinha.
  return Response.json({
    ok: true,
    watching: true,
    sessions: armedQuietPush(),
    idleMs: ATTENTION_SETTLE.idleMs,
  });
}
