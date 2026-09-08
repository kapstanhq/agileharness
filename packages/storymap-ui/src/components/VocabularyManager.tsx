"use client";

// 🟩 Produto · Personas & Sistemas — a LISTA do vocabulário do board.
//
// Uma persona e um sistema são, os dois, um PROMPT que um agente ADOTA depois: a persona como um
// "Você é…" que o run encarna; o sistema como "o que este touchpoint detém + os limites a respeitar".
// Por isso a tela é uma LISTA que leva a DOCUMENTOS, e não um formulário: o conteúdo é texto longo, e
// texto longo se lê e se escreve numa página inteira (`/vocabulario/<kind>/<id>`), não numa caixinha.
//
// O QUE MUDOU, e por quê (o desenho anterior era uma bancada de edição inline):
//   · cada linha trazia um `<AssistedEditor>` de 12 linhas dobrado atrás de um chevron — a mesma
//     edição que o documento já faz melhor, mantida viva em duplicata. Saiu: editar à mão é no
//     documento, e pedir ao agente é na CONVERSA da tela (o Arquiteto), que enxerga o vocabulário
//     INTEIRO e por isso alcança o que a bancada por linha nunca alcançou — dizer que DUAS personas
//     são a mesma pessoa. O `sincronizar` (derivar o prompt do código real) virou uma TÉCNICA dessa
//     conversa, com o código de verdade na mão, em vez de um botão de uma linha só.
//   · não havia BUSCA nem AGRUPAMENTO: com 7 personas dava para varrer com o olho; a partir de ~15 a
//     lista vira um paredão indiferenciado. Agora agrupa por TIPO (o `kind`, que a persona também
//     passou a ter) e a busca varre nome, tipo, resumo, id e o prompt inteiro.
//   · a identidade (renomear, tipo, cor, excluir) saiu do corpo da linha para um menu ⋯ que só aparece
//     no hover: é manutenção ocasional, e ocupava justamente o espaço em que o CONTEÚDO devia estar.
//
// As derivações (grupo, subtítulo, busca, resumo) são puras e moram em `lib/storymap/vocab` — testáveis
// sem montar React, e compartilhadas com o documento, que mostra o mesmo tipo e o mesmo resumo.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Plus,
  Search,
  Server,
  Sparkles,
  Trash2,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { countChipCls, idChip } from "@/lib/ui";
import { slugify } from "@/lib/storymap/id";
import { vocabEntityHref } from "@/lib/storymap/deep-links";
import { PersonaAvatar } from "./PersonaAvatar";
import { ColorDot, Swatches, VOCAB_PALETTE } from "./Swatches";
import { BoardHeader } from "./BoardHeader";
import { ConfirmDialog } from "./ConfirmDialog";
import { ToastProvider, useToast } from "./Toast";
import { PageHeader, PageTabs, usePageTab, type PageTab } from "@/components/nav/PageTabs";
import { ViewChat } from "@/components/ViewChat";
import { ChatDock, ChatDockGhost, useChatRailVisible } from "@/components/chat/ChatDock";
import { chatDockFor, chatSurfaceFor } from "@/lib/storymap/copilot/chat-surfaces";
import { vocabChatContextAction } from "@/app/vocab-actions";
import {
  deletePersonaAction,
  deleteSystemAction,
  patchPersonaAction,
  patchSystemAction,
  savePersonaAction,
  saveSystemAction,
} from "@/app/actions";
import {
  groupVocab,
  matchesVocabQuery,
  PERSONA_KINDS,
  SYSTEM_KINDS,
  toVocabRow,
  vocabSummary,
  type VocabKind,
  type VocabRow,
} from "@/lib/storymap/vocab";
import type { Board, BoardConfig, BoardSummary, Persona, SystemDef } from "@/lib/storymap/types";

/** As duas metades do vocabulário — o nível 3 desta tela. */
type VocabTab = "personas" | "sistemas";

const KIND_OF: Record<VocabTab, VocabKind> = { personas: "persona", sistemas: "system" };

const inputCls =
  "w-full rounded-lg border border-line bg-inset px-3 py-2 text-sm text-fg outline-none transition focus:border-accent focus:ring-2 focus:ring-accent";

export function VocabularyManager({ board, boards }: { board: Board; boards: BoardSummary[] }) {
  return (
    <ToastProvider>
      <VocabularyInner board={board} boards={boards} />
    </ToastProvider>
  );
}

function VocabularyInner({ board, boards }: { board: Board; boards: BoardSummary[] }) {
  const router = useRouter();
  const toast = useToast();
  const [config, setConfig] = useState<BoardConfig>(board.config);
  const boardId = config.id;

  // Quantos cards adotam cada linha. Vem dos CARDS (é do board, não da entidade) e por isso fica fora
  // do estado local: criar uma persona não muda a contagem de ninguém, e excluir uma tira a linha
  // toda. O `router.refresh()` de cada mutação é quem traz a contagem nova quando ela de fato muda.
  const usage = useMemo(() => {
    const personas = new Map<string, number>();
    const systems = new Map<string, number>();
    for (const card of board.cards) {
      for (const id of card.personas) personas.set(id, (personas.get(id) ?? 0) + 1);
      for (const id of card.systems) systems.set(id, (systems.get(id) ?? 0) + 1);
    }
    return { persona: personas, system: systems };
  }, [board.cards]);

  const TABS: readonly PageTab<VocabTab>[] = [
    { id: "personas", label: "Personas", icon: UserRound, count: config.personas.length, hint: "Quem vai usar o produto" },
    { id: "sistemas", label: "Sistemas", icon: Server, count: config.systems.length, hint: "O que o produto toca" },
  ];
  const [tab, setTab] = usePageTab(TABS);
  const kind = KIND_OF[tab];

  // A busca é por ABA: trocar de metade zera o termo. Procurar "canal" nas personas e continuar
  // procurando "canal" nos sistemas é coincidência, não intenção — e uma lista vazia logo depois de
  // um clique de aba se lê como "não há sistemas", que é falso.
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    setQuery("");
    setCreating(false);
  }, [tab]);

  const entities: (Persona | SystemDef)[] = kind === "persona" ? config.personas : config.systems;
  const promptOf = useMemo(() => new Map(entities.map((e) => [e.id, e.prompt ?? ""] as const)), [entities]);
  const rows = useMemo(
    () => entities.map((e) => toVocabRow(e, kind, usage[kind].get(e.id) ?? 0)),
    [entities, kind, usage],
  );
  const filtered = useMemo(
    () => rows.filter((r) => matchesVocabQuery(r, promptOf.get(r.id), query)),
    [rows, promptOf, query],
  );
  const groups = useMemo(() => groupVocab(filtered, kind), [filtered, kind]);

  // ── O Arquiteto (a conversa DESTA TELA) ───────────────────────────────────────────────────────
  // Ancorado no desktop (é tela de trabalho COM o agente, como Ideias e o Canvas), folha no celular.
  // O contexto abre no mount; a cada turno o painel o re-resolve fresco — o vocabulário se move
  // enquanto se conversa, inclusive por escrita do próprio agente.
  const railVisible = useChatRailVisible();
  const [sheetOpen, setSheetOpen] = useState(false);
  const chatOpen = railVisible || sheetOpen;
  const [chatContext, setChatContext] = useState<string | null>(null);
  useEffect(() => {
    if (!chatOpen || chatContext !== null) return;
    let alive = true;
    void vocabChatContextAction(boardId)
      .then((c) => alive && setChatContext(c))
      .catch(() => alive && setChatContext("Não consegui ler o vocabulário deste board."));
    return () => {
      alive = false;
    };
  }, [chatOpen, chatContext, boardId]);

  // As duas recebem o `k` de QUEM chamou (a linha sabe o que ela é), em vez de ler o `kind` da aba
  // ativa. Não é preciosismo: a gravação é assíncrona, e se o operador trocar de aba enquanto ela
  // corre, a resposta voltaria e cairia na lista da aba NOVA — uma persona aparecendo entre os
  // sistemas. O estado local só pode ser corrigido por quem sabe a que metade o dado pertence.
  const upsert = (saved: Persona | SystemDef, k: VocabKind) =>
    setConfig((c) => {
      const list: (Persona | SystemDef)[] = k === "persona" ? c.personas : c.systems;
      const exists = list.some((e) => e.id === saved.id);
      const next = exists ? list.map((e) => (e.id === saved.id ? saved : e)) : [...list, saved];
      return k === "persona" ? { ...c, personas: next as Persona[] } : { ...c, systems: next as SystemDef[] };
    });

  const drop = (id: string, k: VocabKind) =>
    setConfig((c) =>
      k === "persona"
        ? { ...c, personas: c.personas.filter((p) => p.id !== id) }
        : { ...c, systems: c.systems.filter((s) => s.id !== id) },
    );

  const noun = kind === "persona" ? "persona" : "sistema";

  return (
    // Com o rail ancorado, a PÁGINA é dona do viewport e o CONTEÚDO é que rola — assim o composer do
    // chat fica parado no rodapé em vez de subir com a lista. Layout por CSS (`lg:`), montagem por JS
    // (`railVisible`): as duas réguas são a MESMA largura, mas `railVisible` só fica verdadeiro DEPOIS
    // do mount, e até lá o contêiner ficaria com altura indefinida.
    <div className="flex min-h-screen flex-col bg-canvas lg:h-screen lg:overflow-hidden">
      <BoardHeader boards={boards} config={config} view="vocabulario" subnav dockedChat={railVisible} />
      <div className="flex min-h-0 flex-1">
        {/* PRODUTO_MAX_W — a MESMA largura das irmãs do bloco (ver o doc-comment do `PageHeader`): a
            barra de abas do nível 2 troca justamente entre elas, e largura diferente faz a página
            deslocar de lado a cada troca. O `pb-24` é a folga da nav inferior do celular — esta tela
            não usa `.board-scroll`, que é quem a daria de graça. */}
        <main className="quiet-scroll mx-auto w-full max-w-4xl flex-1 px-4 py-6 pb-24 md:px-6 md:pb-8 lg:overflow-y-auto">
          <PageHeader
            title="Personas & Sistemas"
            icon={Users}
            description={
              kind === "persona"
                ? "Quem vai usar — cada persona é um system-prompt que o agente adota ao escrever e construir. Abra o documento para editar à mão, ou peça ao Arquiteto: ele enxerga o vocabulário inteiro e aponta o que se sobrepõe."
                : "Os touchpoints e serviços envolvidos — cada um é um prompt com o que aquele sistema detém e os limites a respeitar. Abra o documento para editar à mão, ou peça ao Arquiteto para sincronizá-lo com o código real."
            }
            actions={
              <div className="flex shrink-0 items-center gap-2">
                {/* Com o rail ancorado este botão SOME: ele abriria o que já está na tela, e um botão
                    que não muda nada é pior que nenhum. Volta a existir no celular, onde é folha. */}
                {!railVisible && (
                  <button
                    type="button"
                    onClick={() => setSheetOpen((s) => !s)}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-medium transition",
                      sheetOpen
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-line bg-surface text-fg-muted hover:bg-surface-hover hover:text-fg",
                    )}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Arquiteto
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setCreating((c) => !c)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-sm font-medium text-primary-fg transition hover:bg-primary-hover"
                >
                  <Plus className="h-4 w-4" /> {noun}
                </button>
              </div>
            }
            tabs={<PageTabs label="Seções de Personas & Sistemas" tabs={TABS} value={tab} onChange={setTab} />}
          />

          {/* A BARRA: busca à esquerda, resumo à direita. O segmentado das abas fica no CABEÇALHO (é
              navegação, nível 3) e não aqui — as duas coisas na mesma faixa fariam duas gramáticas
              disputando a mesma linha. */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <label className="flex h-8 min-w-[180px] max-w-[320px] flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 transition focus-within:border-accent">
              <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar no nome ou no prompt…"
                aria-label={`Buscar ${tab}`}
                className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-fg-subtle"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Limpar a busca"
                  className="shrink-0 rounded p-0.5 text-fg-subtle transition hover:text-fg"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </label>
            <span className="ml-auto whitespace-nowrap text-[12px] text-fg-subtle">
              {vocabSummary(filtered.length, kind, query.trim().length > 0)}
            </span>
          </div>

          {creating && (
            <CreateRow
              kind={kind}
              boardId={boardId}
              takenIds={entities.map((e) => e.id)}
              colorSeed={entities.length}
              onCancel={() => setCreating(false)}
              onCreated={(saved, k) => {
                upsert(saved, k);
                setCreating(false);
                router.refresh();
              }}
            />
          )}

          {entities.length === 0 ? (
            <Empty>
              {kind === "persona"
                ? "Nenhuma persona ainda. Comece pelo segmento que o produto quer conquistar — quem decide, com que informação na mão, e o que faz essa pessoa desistir."
                : "Nenhum sistema ainda. Comece pelos touchpoints por onde a pessoa fala com o produto, e pelos serviços de que ele depende por dentro."}
            </Empty>
          ) : filtered.length === 0 ? (
            <Empty>Nada encontrado para “{query.trim()}”. A busca varre nome, tipo, resumo e o prompt inteiro.</Empty>
          ) : (
            <div className="space-y-6">
              {groups.map((g) => (
                <section key={g.key || "sem-tipo"}>
                  <div className="mb-1.5 flex items-center gap-2 px-1">
                    <h2 className="text-[10.5px] font-bold uppercase tracking-[0.085em] text-fg-subtle">{g.label}</h2>
                    <span className={countChipCls}>{g.rows.length}</span>
                    <span aria-hidden className="h-px flex-1 bg-line-muted" />
                    {g.note && <span className="hidden text-[11px] text-fg-subtle sm:inline">{g.note}</span>}
                  </div>
                  {/* Sem `overflow-hidden`, de propósito: o cartão precisa dos cantos arredondados, mas
                      quem clipa o conteúdo clipa TAMBÉM o menu ⋯ de cada linha (ele é `absolute` e
                      descendente daqui) — o popover apareceria decapitado no rodapé do grupo. Então o
                      raio vai nas PONTAS das linhas, e o cartão fica livre para deixar o menu sair. */}
                  <ul className="divide-y divide-line rounded-[10px] border border-line bg-surface shadow-[0_1px_1px_rgba(15,15,15,0.025)] [&>li:first-child>div]:rounded-t-[9px] [&>li:last-child>div]:rounded-b-[9px]">
                    {g.rows.map((row) => (
                      <li key={row.id}>
                        <VocabListRow
                          boardId={boardId}
                          row={row}
                          onPatched={(saved) => upsert(saved, row.kind)}
                          onDeleted={(id) => {
                            drop(id, row.kind);
                            router.refresh();
                          }}
                          onError={(msg) => toast(msg, "error")}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}

          <p className="mt-7 px-1 text-[12px] leading-relaxed text-fg-subtle">
            Cada linha é um documento em Markdown — o prompt que o agente adota ao escrever e construir.
          </p>
        </main>

        {/* Antes de o rail existir, o LUGAR dele — reservado por CSS para a página não "assentar" na visita. */}
        {!railVisible && <ChatDockGhost />}

        <ChatDock
          mode={chatDockFor("vocabulario")}
          open={chatOpen}
          onClose={() => setSheetOpen(false)}
          label={chatSurfaceFor("vocabulario")?.label ?? "Arquiteto"}
        >
          <ViewChat
            boardId={boardId}
            view="vocabulario"
            context={chatContext ?? "Carregando o vocabulário do board…"}
            getContext={() => vocabChatContextAction(boardId)}
            greeting={
              "Estou vendo as personas e os sistemas deste board. Posso encarnar uma persona para mostrar onde " +
              "ela está genérica, apontar duas que se sobrepõem, ou ler o código e sincronizar o prompt de um " +
              "sistema com o que ele de fato faz. Por onde começamos?"
            }
            onClose={railVisible ? undefined : () => setSheetOpen(false)}
          />
        </ChatDock>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * UMA linha da lista. O corpo inteiro é um link para o DOCUMENTO (o alvo do clique é a linha toda, e
 * não um botão de 24px), e a manutenção de identidade fica num menu ⋯ ao lado — FORA do link, porque
 * um botão dentro de uma âncora é um alvo dentro de outro, e no toque o dedo sempre pega o de fora.
 */
function VocabListRow({
  boardId,
  row,
  onPatched,
  onDeleted,
  onError,
}: {
  boardId: string;
  row: VocabRow;
  onPatched: (saved: Persona | SystemDef) => void;
  onDeleted: (id: string) => void;
  onError: (message: string) => void;
}) {
  const href = vocabEntityHref(boardId, row.kind === "persona" ? "persona" : "sistema", row.id);

  return (
    <div className="group flex items-center gap-2 pr-2 transition hover:bg-surface-hover">
      <Link href={href} title="Abrir o documento" className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-3">
        <VocabToken row={row} />
        {/* Nome e resumo LADO A LADO no desktop (a densidade que faz varrer a lista com o olho) e
            EMPILHADOS no celular. Não é preferência: com 375px de largura, um nome de 40 caracteres
            comia a linha inteira e o resumo saía da tela — a lista virava sete nomes truncados sem
            nada que os distinguisse, que é exatamente o que o resumo existe para evitar. */}
        <span className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-2.5">
          <span className="block truncate text-[14px] font-semibold text-fg sm:max-w-[220px] sm:shrink-0">
            {row.name}
          </span>
          <span className="block min-w-0 truncate text-[13px] text-fg-subtle sm:flex-1">
            {row.subtitle || (
              <span className="text-fg-subtle/70">
                {row.hasPrompt ? "sem resumo" : "documento em branco — nada para o agente adotar"}
              </span>
            )}
          </span>
        </span>
      </Link>
      <RowMenu boardId={boardId} row={row} onPatched={onPatched} onDeleted={onDeleted} onError={onError} />
      {/* A contagem de adoção. Zero é INFORMAÇÃO (ou falta usá-la nas stories, ou ela sobra), então
          não some — só se recolhe no celular, onde não há largura para ela e o nome ao mesmo tempo. */}
      <span
        title={`${row.usage} card(s) adotam este prompt`}
        className={cn(idChip, "hidden shrink-0 tabular-nums sm:inline-flex")}
      >
        {row.usage} {row.usage === 1 ? "card" : "cards"}
      </span>
      <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-fg-subtle/60" />
    </div>
  );
}

/** O token da linha: a persona pode ter avatar; o sistema é sempre o quadrado da cor com as iniciais. */
function VocabToken({ row }: { row: VocabRow }) {
  if (row.kind === "persona") {
    return (
      <PersonaAvatar
        persona={{ name: row.name, color: row.color, avatar: row.avatar }}
        size={26}
        shape="square"
        solid
      />
    );
  }
  const initials =
    (row.name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";
  return (
    <span
      aria-hidden
      title={row.name}
      className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-[10.5px] font-bold text-white"
      style={{ backgroundColor: row.color ?? "#9B9A93" }}
    >
      {initials}
    </span>
  );
}

/**
 * O menu ⋯ — renomear, tipo, cor, excluir. Toda a manutenção de IDENTIDADE de uma linha, e nada de
 * conteúdo: o conteúdo é o documento. Ele só aparece no hover/foco porque é uso ocasional e, visível o
 * tempo todo, competia com o nome pela atenção em cada uma das linhas.
 */
function RowMenu({
  boardId,
  row,
  onPatched,
  onDeleted,
  onError,
}: {
  boardId: string;
  row: VocabRow;
  onPatched: (saved: Persona | SystemDef) => void;
  onDeleted: (id: string) => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(row.name);
  const [type, setType] = useState(row.type ?? "");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Os campos seguem a linha: quando o agente (ou outra aba) renomeia, o menu fechado não pode voltar
  // a abrir com o valor velho e regravá-lo no primeiro blur.
  useEffect(() => {
    setName(row.name);
    setType(row.type ?? "");
  }, [row.name, row.type]);

  const patch = async (patchBody: Partial<Persona> & Partial<SystemDef>) => {
    setBusy(true);
    const res =
      row.kind === "persona"
        ? await patchPersonaAction({ boardId, personaId: row.id, patch: patchBody })
        : await patchSystemAction({ boardId, systemId: row.id, patch: patchBody });
    setBusy(false);
    if (!res.ok) {
      onError(res.error);
      return;
    }
    const fresh = res.data?.config;
    const saved = fresh
      ? ((row.kind === "persona" ? fresh.personas : fresh.systems) as (Persona | SystemDef)[]).find(
          (e) => e.id === row.id,
        )
      : undefined;
    if (saved) onPatched(saved);
  };

  const remove = async () => {
    setBusy(true);
    const res =
      row.kind === "persona"
        ? await deletePersonaAction({ boardId, personaId: row.id })
        : await deleteSystemAction({ boardId, systemId: row.id });
    setBusy(false);
    setConfirming(false);
    setOpen(false);
    if (res.ok) onDeleted(row.id);
    else onError(res.error);
  };

  const kinds: readonly string[] = row.kind === "persona" ? PERSONA_KINDS : SYSTEM_KINDS;
  const listId = `vocab-kinds-${row.kind}`;

  return (
    <>
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={`Opções de ${row.name}`}
          aria-expanded={open}
          title="Renomear, tipo, cor, excluir"
          className={cn(
            "rounded-md p-1.5 text-fg-subtle transition hover:bg-fg/[0.07] hover:text-fg focus-visible:opacity-100",
            open ? "bg-fg/[0.07] text-fg opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
            <div className="absolute right-0 top-full z-[70] mt-1 w-64 rounded-xl border border-line bg-surface p-2 shadow-lg">
              <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Nome</p>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => {
                  const nm = name.trim();
                  if (!nm || nm === row.name) return setName(row.name);
                  void patch({ name: nm });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setName(row.name);
                }}
                className="w-full rounded-md border border-line bg-inset px-2 py-1 text-[12.5px] text-fg outline-none focus:border-accent"
              />

              <p className="px-1 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                Tipo <span className="font-normal normal-case tracking-normal">— agrupa a lista</span>
              </p>
              <input
                value={type}
                list={listId}
                onChange={(e) => setType(e.target.value)}
                onBlur={() => {
                  const t = type.trim();
                  if (t === (row.type ?? "")) return;
                  void patch({ kind: t });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setType(row.type ?? "");
                }}
                placeholder={kinds[0]}
                className="w-full rounded-md border border-line bg-inset px-2 py-1 text-[12.5px] text-fg outline-none focus:border-accent"
              />
              <datalist id={listId}>
                {kinds.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>

              <p className="px-1 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Cor</p>
              <Swatches color={row.color} onColor={(c) => void patch({ color: c })} />

              {/* O AVATAR é identidade, como a cor — e é por isso que ele mora aqui e não no documento:
                  a mesma gaveta que renomeia e recolora. Só a persona o tem: é ela que vira o token
                  redondo do ator no mapa de stories; um sistema é sempre o quadrado da sua cor. */}
              {row.kind === "persona" && (
                <AvatarField
                  boardId={boardId}
                  row={row}
                  onAvatar={(avatar) => void patch({ avatar })}
                  onError={onError}
                />
              )}

              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(true)}
                className="mt-2 flex w-full items-center gap-2 rounded-md border-t border-line-muted px-2 py-1.5 pt-2 text-left text-[12px] font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50 dark:text-red-300 dark:hover:bg-red-500/20"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5 shrink-0" />
                )}
                Excluir {row.kind === "persona" ? "persona" : "sistema"}
              </button>
            </div>
          </>
        )}
      </div>

      {confirming && (
        <ConfirmDialog
          title={`Excluir "${row.name}"?`}
          description={
            (row.usage > 0
              ? `${row.usage} card(s) perderão a referência a ${row.kind === "persona" ? "esta persona" : "este sistema"}. `
              : "") + "Vai para a lixeira do board — recuperável por 7 dias."
          }
          confirmLabel={busy ? "Excluindo…" : "Excluir"}
          confirmDisabled={busy}
          tone="danger"
          onConfirm={remove}
          onCancel={() => {
            if (!busy) setConfirming(false);
          }}
        />
      )}
    </>
  );
}

/**
 * O AVATAR da persona — a imagem do token redondo do ator no mapa de stories. Enviar um arquivo, colar
 * uma URL, ou remover (voltando às iniciais coloridas, que é o fallback e nunca um buraco vazio).
 * Sem imagem nenhuma a persona continua renderizando; a imagem é acabamento, não requisito.
 */
function AvatarField({
  boardId,
  row,
  onAvatar,
  onError,
}: {
  boardId: string;
  row: VocabRow;
  onAvatar: (avatar: string) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("boardId", boardId);
    fd.append("personaId", row.id);
    try {
      const res = await fetch("/api/avatar", { method: "POST", body: fd });
      const data = (await res.json()) as { path?: string; error?: string };
      if (!res.ok || !data.path) throw new Error(data.error ?? "Falha ao enviar a imagem.");
      onAvatar(data.path);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Falha ao enviar a imagem.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="px-1 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Avatar</p>
      <div className="flex items-center gap-1.5">
        <PersonaAvatar persona={{ name: row.name, color: row.color, avatar: row.avatar }} size={26} />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="rounded-md px-2 py-1 text-[11.5px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg disabled:opacity-50"
        >
          {busy ? "Enviando…" : "Enviar"}
        </button>
        {row.avatar && (
          <button
            type="button"
            onClick={() => onAvatar("")}
            className="rounded-md px-2 py-1 text-[11.5px] font-medium text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
          >
            Remover
          </button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = "";
        }}
      />
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const u = url.trim();
          if (!u) return;
          onAvatar(u);
          setUrl("");
        }}
        placeholder="…ou cole uma URL e tecle Enter"
        className="mt-1 w-full rounded-md border border-line bg-inset px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
      />
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * CRIAR = nomear e entrar. Só nome, tipo e cor: o conteúdo — o prompt inteiro — se escreve no
 * DOCUMENTO, e pedi-lo aqui era o que fazia a linha nova nascer com um campo de 12 linhas aberto no
 * meio da lista.
 */
function CreateRow({
  kind,
  boardId,
  takenIds,
  colorSeed,
  onCancel,
  onCreated,
}: {
  kind: VocabKind;
  boardId: string;
  takenIds: string[];
  colorSeed: number;
  onCancel: () => void;
  onCreated: (saved: Persona | SystemDef, kind: VocabKind) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [color, setColor] = useState(VOCAB_PALETTE[colorSeed % VOCAB_PALETTE.length]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kinds: readonly string[] = kind === "persona" ? PERSONA_KINDS : SYSTEM_KINDS;
  const noun = kind === "persona" ? "persona" : "sistema";

  const create = async () => {
    const nm = name.trim();
    if (!nm || busy) return;
    const id = slugify(nm);
    if (!id) return setError("Esse nome não gera um identificador válido — use letras ou números.");
    if (takenIds.includes(id)) {
      return setError(`Já existe ${kind === "persona" ? "uma persona" : "um sistema"} com o id "${id}".`);
    }
    setBusy(true);
    setError(null);
    const entity = { id, name: nm, color, ...(type.trim() ? { kind: type.trim() } : {}) };
    const res =
      kind === "persona"
        ? await savePersonaAction({ boardId, persona: entity })
        : await saveSystemAction({ boardId, system: entity });
    setBusy(false);
    if (res.ok) onCreated(entity, kind);
    else setError(res.error);
  };

  return (
    <div className="mb-4 space-y-3 rounded-[10px] border border-dashed border-line bg-surface p-3.5">
      <div className="flex items-center gap-2">
        <ColorDot color={color} />
        <span className="rounded bg-surface-hover px-1.5 py-0.5 font-mono text-[11px] text-fg-muted">
          {kind === "persona" ? "nova persona" : "novo sistema"}
        </span>
        <div className="ml-auto">
          <Swatches color={color} onColor={setColor} />
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          autoFocus
          value={name}
          onChange={(e) => {
            setError(null);
            setName(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void create();
            }
            if (e.key === "Escape") onCancel();
          }}
          placeholder={kind === "persona" ? "Nome — ex.: Curioso Cultural" : "Nome — ex.: Canal WhatsApp"}
          className={cn(inputCls, "text-[15px] font-semibold")}
        />
        <input
          value={type}
          list={`create-kinds-${kind}`}
          onChange={(e) => setType(e.target.value)}
          placeholder="Tipo"
          className={cn(inputCls, "sm:w-48 sm:shrink-0")}
        />
        <datalist id={`create-kinds-${kind}`}>
          {kinds.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
      </div>
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 leading-snug">{error}</span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={create}
          disabled={busy || !name.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-[12px] font-semibold text-primary-fg transition hover:bg-primary-hover disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          {busy ? "Criando…" : `Criar ${noun}`}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-fg-subtle transition hover:bg-surface-hover disabled:opacity-50"
        >
          Cancelar
        </button>
        <span className="ml-auto hidden text-[11px] text-fg-subtle sm:inline">
          O prompt você escreve no documento, em seguida.
        </span>
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[10px] border border-dashed border-line bg-surface px-4 py-10 text-center text-[13px] leading-relaxed text-fg-subtle">
      <p className="mx-auto max-w-prose">{children}</p>
    </div>
  );
}
