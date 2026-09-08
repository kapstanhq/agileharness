// Pure "what is this terminal doing" helpers — no IO, shared by the two layers that need to phrase a
// tmux session for a human: the /processes data layer (lib/vps/processes → the home Terminais cards)
// and the /terminal enrich layer (lib/terminal/enrich → the web-terminal picker). One implementation
// so both surfaces read a session the same way.

import os from "node:os";

const HOSTNAME = (() => {
  try {
    return os.hostname();
  } catch {
    return "";
  }
})();

/** Last two path segments (…/parent/dir) — a compact cwd for a one-line phrase. */
export function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}

/**
 * O QUADRO DE SPINNER que vem colado no título.
 *
 * Um CLI de agente escreve no `pane_title` do tmux o resumo da tarefa em curso — e escreve com o
 * spinner na frente: `⠂ Remover termo mascote e implementar notificações`, `✳ Refatorar popover`. Esse
 * primeiro caractere é um QUADRO DE ANIMAÇÃO congelado no instante da amostra: ele não diz nada, muda a
 * cada ciclo (fazendo o mesmo título parecer dois títulos diferentes) e vaza para dentro da interface —
 * a lista de Terminais e o seletor do /terminal mostravam o braille do spinner como se fosse parte do
 * nome da sessão. Os glifos cobertos são os do braille (⠁-⣿), os asteriscos/estrelas de status e os
 * pontos de bullet que alguns CLIs usam.
 */
const SPINNER_PREFIX = /^[⠀-⣿✳✻✽✶✢·∗*•●○◆◇◐◓◑◒⏳⌛]+\s*/u;

/** Tira o quadro de spinner do começo do título, quando há um. PURA. */
export function stripSpinner(title: string): string {
  return title.replace(SPINNER_PREFIX, "").trim();
}

/** Minúsculas, sem pontuação, espaços colapsados — para comparar título com comando sem tropeçar em
 *  maiúsculas, pontos ou dois-pontos (`Claude Code` ↔ `claude`, `Node.js` ↔ `node`). */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * O título é só a IDENTIDADE DO PROGRAMA, e não o que ele está fazendo?
 *
 * Um CLI que ainda não tem nada a anunciar escreve o próprio nome no `pane_title` — e esse nome não é
 * atividade nenhuma: é o mesmo ruído que `bash`, só que de marca. Foi assim que a lista de Terminais
 * anunciou "Claude Code" como o que dois terminais estavam fazendo enquanto os dois estavam parados.
 *
 * A régua é GENÉRICA (a ferramenta não conhece CLI nenhum — ver o princípio app-agnóstico): recusa
 * quando o título COMEÇA pelo nome do comando e não tem mais que uma palavra além dele. `Claude Code`
 * (2 palavras, a 1ª é o comando) sai; `claude: refatorando o popover do topnav` fica, porque um título
 * que diz algo tem mais que isso para dizer.
 */
function isProgramIdentity(title: string, command: string): boolean {
  const c = normalize(command);
  if (!c) return false;
  const words = normalize(title).split(" ").filter(Boolean);
  return words.length > 0 && words.length <= 2 && words[0] === c;
}

/** A pane title only carries signal when something INTENTIONALLY set it — the tmux default is the
 *  hostname or the running command, which is noise next to a derived label/activity. O spinner sai
 *  ANTES da comparação: `⠂ bash` é o mesmo ruído que `bash`, só que fantasiado. */
export function intentionalTitle(title: string, command: string, name: string): boolean {
  const t = stripSpinner(title);
  if (!t) return false;
  if (t === command || t === name || t === HOSTNAME) return false;
  if (t === "bash" || t === "-bash" || t === "zsh") return false;
  if (isProgramIdentity(t, command)) return false;
  return true;
}

/** A single, clean "what it is doing" line for a tmux session, from CHEAP fields only (no capture):
 *  an intentionally-set pane title → the live command + short cwd → the bare command → "". This is
 *  the honest fallback the home console shows in place of the useless "Claude vivo · <etime>". */
export function deriveActivity(paneTitle: string, command: string, cwd: string, name: string): string {
  if (intentionalTitle(paneTitle, command, name)) return stripSpinner(paneTitle);
  if (command) return cwd ? `${command} · ${shortPath(cwd)}` : command;
  return "";
}
