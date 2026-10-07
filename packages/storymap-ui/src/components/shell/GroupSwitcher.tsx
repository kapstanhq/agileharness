"use client";

// O 2º degrau da árvore: QUAL grupo — Negócio · Produto · Design · Software, com ✓ no atual. Escolher um grupo
// abre a ferramenta default dele (`groupRadicalHref`). Numa tela do Sistema o gatilho diz "Sistema" (sem ✓ na
// lista: o Sistema não é etapa do produto, a porta dele é a engrenagem). Numa tela sem grupo (a página de um
// card, o Inbox do board) o gatilho diz «Grupos», apagado, e a lista abre sem ✓ — nunca o nome da tela no lugar
// de um grupo.
//
// Em 390px quem tem a largura é o NOME DO PROJETO (o «em que board estou»): o grupo é o PRIMEIRO a ceder. O invólucro
// encolhe com peso 10000 (`shrink-[10000]`) contra o peso 1 do projeto — a falta de espaço sai do nome do grupo,
// que trunca («Softw…») até a 1ª letra («S…»; abaixo de 360px, só o chevron); só então o nome do board começa a
// encolher. O peso é alto de propósito: o flex divide a falta na proporção peso × largura, e com peso 100 o projeto
// ainda cedia uns centésimos de pixel — o bastante para o navegador pôr «…» num nome que cabia («Livraria» virava
// «Livrari…» em 390px com o grupo em «Softw…»). Com 10000 a fatia do projeto fica abaixo da unidade mínima de
// layout e o nome curto fica inteiro (medido no build de produção). O nome do grupo segue inteiro no
// `title` e no `aria-label`. A lista abre
// ancorada pela DIREITA no celular e nunca passa da largura da tela (antes vazava 5–12px e cortava o ✓ e a borda).

import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { useHoverPopover } from "@/components/nav/NavShell";
import { groupForView, groupLabelForView, groupRadicalHref, NAV_GROUPS, type BoardView } from "@/components/nav/nav-groups";
import { appBarCrumb, appBarPopover } from "@/components/shell/app-bar-shell";

export function GroupSwitcher({ boardId, view }: { boardId: string; view: BoardView }) {
  const { open, setOpen, ref } = useHoverPopover();
  const group = groupForView(view);
  const current = group?.id ?? null;
  const label = groupLabelForView(view);

  return (
    // O grupo cede a largura ANTES do projeto (peso 10000), mas nunca some: o piso é a 1ª letra e «…» («S…») — um piso
    // só do chevron deixava um pedaço de letra cortada ao lado dele. Abaixo de 360px o piso é o chevron, sem o nome.
    <div ref={ref} className="relative flex min-w-[1.375rem] shrink-[10000] min-[360px]:min-w-[2.75rem]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={group ? `${label} — trocar de grupo` : "Escolher um grupo"}
        aria-label={group ? `Grupo ${label} — trocar de grupo` : "Escolher um grupo"}
        className={cn(appBarCrumb, open && "bg-inset", !group && "font-medium text-fg-muted")}
      >
        <span className="min-w-0 max-w-[76px] truncate max-[359px]:hidden sm:max-w-none">{label}</span>
        <ChevronDown className={cn("h-[11px] w-[11px] shrink-0 text-fg-subtle transition", open && "rotate-180")} strokeWidth={2.4} />
      </button>
      {open && (
        <div role="menu" aria-label="Grupos" className={cn(appBarPopover, "absolute right-[-6px] top-[calc(100%+6px)] flex w-[200px] max-w-[calc(100vw-32px)] flex-col p-1 sm:left-[-6px] sm:right-auto")}>
          {NAV_GROUPS.map((g) => {
            const active = g.id === current;
            return (
              <Link
                key={g.id}
                href={groupRadicalHref(g, boardId)}
                role="menuitemradio"
                aria-checked={active}
                onClick={() => setOpen(false)}
                className={cn(
                  "flex h-10 items-center gap-2 rounded-md px-2 text-[13px] text-fg transition hover:bg-inset focus-visible:bg-inset focus-visible:outline-none md:h-[30px]",
                  active ? "bg-inset font-semibold" : "font-medium",
                )}
              >
                <span className="flex-1">{g.label}</span>
                <span aria-hidden className="text-[12px] text-fg">
                  {active ? "✓" : ""}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
