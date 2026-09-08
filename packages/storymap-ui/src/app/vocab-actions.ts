"use server";

// Server actions da tela de Personas & Sistemas — o CONTEXTO que a conversa recebe e a ESCRITA que o
// agente faz no prompt de uma persona/sistema.
//
// Por que existe um caminho de escrita PRÓPRIO, em vez de dar o token `write` inteiro à conversa: uma
// persona e um sistema vivem FORA do pipeline (não têm status, não casam trigger, não movem coluna,
// não disparam autorun) — escrever neles não move entrega nenhuma. É o mesmo argumento do `write_idea`
// e do `write_doc`, e é o que deixa o Arquiteto (token `ro`) redigir sem receber, junto, o poder de
// mover card, triar e publicar. A contenção é ESTRUTURAL, não uma gentileza da persona:
//   · a linha tem de EXISTIR no board (id resolvido contra o `board.yaml`, nunca criado aqui);
//   · o alcance é o PROMPT (+ o tipo e o resumo de uma linha) — nome, cor, id e a exclusão ficam fora;
//   · o default é ACRESCENTAR: `replace` existe porque "reescreva esta persona" é pedido legítimo do
//     operador, mas o agente tem de NOMEAR a intenção, e o humano a vê no transcript;
//   · campo vazio nunca limpa nada — string em branco é ignorada, não é um apagamento silencioso.
//
// Anti-clobber: toda escrita RELÊ o board.yaml fresco e funde o patch (a mesma disciplina do
// patchPersonaAction), para que o operador editando a cor no mesmo segundo não perca a edição.

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth/action-guard";
import { readBoardConfig, readCards } from "@/lib/storymap/repo";
import { updateBoardConfigOnDisk } from "@/lib/storymap/write";
import { firstLine, vocabSubtitle, type VocabKind } from "@/lib/storymap/vocab";
import { composeVocabBody } from "@/lib/storymap/doc/vocab-doc";
import type { BoardConfig, Persona, SystemDef } from "@/lib/storymap/types";

type Result<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

function fail<T = unknown>(e: unknown): Result<T> {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function truncate(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** A entidade e o índice dela na lista certa do board — `null` quando o id não existe. */
function locate(
  config: BoardConfig,
  kind: VocabKind,
  id: string,
): { list: (Persona | SystemDef)[]; index: number } | null {
  const list: (Persona | SystemDef)[] = kind === "persona" ? [...config.personas] : [...config.systems];
  const index = list.findIndex((e) => e.id === id);
  return index < 0 ? null : { list, index };
}

export interface AppendToVocabInput {
  boardId: string;
  kind: VocabKind;
  /** o id da persona/sistema — tem de já existir; esta ação nunca cria. */
  id: string;
  /** markdown a ACRESCENTAR ao prompt, assinado e datado. */
  note?: string;
  /** o prompt inteiro (com `mode:"replace"`) ou um trecho a acrescentar (o default). */
  prompt?: string;
  /** o TIPO ("Segmento de mercado" / "Interna" / "Canal" / "Serviço"…) — o que agrupa a listagem. */
  type?: string;
  /** a linha de resumo que a listagem mostra (o `role` da persona / a `description` do sistema). */
  summary?: string;
  mode?: "append" | "replace";
  /** quem escreveu — vira a assinatura do bloco acrescentado. */
  actor?: string;
}

/**
 * A escrita do ARQUITETO no prompt de UMA persona/sistema. Devolve o texto resultante para o
 * transcript poder mostrar o que ficou gravado (o agente não precisa reler para saber).
 */
export async function appendToVocabAction(
  input: AppendToVocabInput,
): Promise<Result<{ id: string; kind: VocabKind; prompt: string; replaced: boolean }>> {
  await requireSession("appendToVocabAction");
  try {
    if (input.kind !== "persona" && input.kind !== "system") {
      return { ok: false, error: `Tipo desconhecido: "${input.kind}". Use "persona" ou "system".` };
    }
    const mode = input.mode ?? "append";
    const note = input.note?.trim();
    const text = input.prompt?.trim();
    const type = input.type?.trim();
    const summary = input.summary?.trim();

    if (!note && !text && !type && !summary) {
      return { ok: false, error: "Nada a escrever: mande `note`, `prompt`, `type` ou `summary`." };
    }

    // Estes escapam do `mutate` porque ele é SÍNCRONO (roda dentro do lock) e o resultado precisa
    // sair daqui para a resposta da tool.
    let notFound: string | null = null;
    let writtenPrompt = "";
    let replaced = false;

    // ATÔMICO: a leitura acontece DENTRO do lock. É o que faz N chamadas concorrentes se
    // acumularem em vez de se sobrescreverem — e elas SÃO concorrentes, porque o modelo emite
    // vários `tool_use` numa mensagem só e o cliente MCP os despacha em paralelo (foi assim que
    // 7 classificações de persona viraram 1, todas com `ok: true`).
    await updateBoardConfigOnDisk(input.boardId, (config) => {
      const found = locate(config, input.kind, input.id);
      if (!found) {
        const known = (input.kind === "persona" ? config.personas : config.systems).map((e) => e.id);
        const noun = input.kind === "persona" ? "Persona" : "Sistema";
        notFound = `${noun} não encontrado(a): "${input.id}". Os deste board: ${known.join(", ") || "(nenhum)"}.`;
        return null;
      }

      const { list, index } = found;
      const prev = list[index];

      // O prompt base: o que já está gravado, ou a COMPOSIÇÃO dos campos legados quando a linha ainda
      // não migrou. Partir do vazio aqui seria um apagamento silencioso: o `prompt` gravado passa a
      // vencer os campos legados em toda a UI, então um acréscimo do agente numa linha antiga faria o
      // papel/jobs/dores que a tela mostrava simplesmente sumirem. É a MESMA migração preguiçosa que o
      // documento faz no primeiro save — e por isso vem da MESMA função, não de uma segunda cópia.
      let prompt = (prev.prompt?.trim() ? prev.prompt : composeVocabBody(prev, input.kind)).trimEnd();

      if (text && mode === "replace") {
        prompt = text;
        replaced = true;
      } else if (text) {
        prompt = prompt ? `${prompt}\n\n${text}` : text;
      }

      if (note) {
        const who = input.actor?.trim() || "arquiteto";
        // A assinatura importa: sem ela, daqui a uma semana ninguém distingue o que o agente APUROU do
        // que o humano DECIDIU — e num prompt que todo run adota, essa diferença é a única defesa.
        const signed = `> _${who} · ${today()}_\n\n${note}`;
        prompt = prompt ? `${prompt}\n\n${signed}` : signed;
      }

      const patched: Persona | SystemDef = { ...prev };
      if (prompt !== (prev.prompt ?? "")) patched.prompt = prompt;
      if (type) patched.kind = type;
      if (summary) {
        if (input.kind === "persona") (patched as Persona).role = summary;
        else (patched as SystemDef).description = summary;
      }
      writtenPrompt = patched.prompt ?? "";

      list[index] = patched;
      return input.kind === "persona"
        ? { ...config, personas: list as Persona[] }
        : { ...config, systems: list as SystemDef[] };
    });

    if (notFound) return { ok: false, error: notFound };

    revalidatePath(`/board/${input.boardId}/vocabulario`, "layout");
    return { ok: true, data: { id: input.id, kind: input.kind, prompt: writtenPrompt, replaced } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * O CONTEXTO da tela de Personas & Sistemas para o Arquiteto.
 *
 * A conversa é da TELA (uma raia por tela — ver copilot/chat-surfaces): ele enxerga o vocabulário
 * INTEIRO, que é o que deixa manter cada persona distinta e apontar a que se sobrepõe a outra. O
 * prompt de cada linha vai TRUNCADO (o vocabulário inteiro não cabe num turno); o da linha em FOCO
 * vai completo, porque é sobre ela que o operador está falando.
 *
 * Read-only e à prova de falha: um erro devolve um bloco dizendo isso, nunca derruba a abertura do
 * chat. O bloco é DADO, não instrução — a persona já manda ignorar comandos vindos daqui.
 */
export async function vocabChatContextAction(
  boardId: string,
  focus?: { kind: VocabKind; id: string },
): Promise<string> {
  await requireSession("vocabChatContextAction");
  try {
    const [config, cards] = await Promise.all([readBoardConfig(boardId), readCards(boardId)]);
    const usage = (kind: VocabKind, id: string): number =>
      cards.filter((c) => (kind === "persona" ? c.personas : c.systems).includes(id)).length;

    const describe = (e: Persona | SystemDef, kind: VocabKind, limit: number): string => {
      const bits = [
        `- \`${e.id}\` «${e.name}»${e.kind?.trim() ? ` — tipo: ${e.kind.trim()}` : " — SEM TIPO declarado"}` +
          ` · adotada por ${usage(kind, e.id)} card(s)`,
      ];
      const sub = vocabSubtitle(e, kind);
      if (sub) bits.push(`  resumo: ${truncate(sub, 160)}`);
      const prompt = e.prompt?.trim();
      if (prompt) bits.push(`  prompt (${prompt.length} caracteres): ${truncate(prompt, limit)}`);
      else bits.push(`  prompt: VAZIO — este documento ainda não foi escrito`);
      return bits.join("\n");
    };

    const focused =
      focus && (focus.kind === "persona" ? config.personas : config.systems).find((e) => e.id === focus.id);
    const focusBlock = focused
      ? [
          `## ${focus!.kind === "persona" ? "Persona" : "Sistema"} em foco: \`${focused.id}\` «${focused.name}»`,
          'O operador está com ESTE documento aberto. Quando ele disser "esta persona"/"este sistema", é este.',
          "O prompt INTEIRO vai abaixo — não precisa relê-lo por tool para responder sobre ele.",
          "",
          `tipo: ${focused.kind?.trim() || "(sem tipo declarado)"}`,
          `adotado por: ${usage(focus!.kind, focused.id)} card(s)`,
          "",
          "prompt:",
          focused.prompt?.trim() || "(ainda vazio)",
          "",
          "---",
          "",
        ].join("\n")
      : "";

    const personas = config.personas.length
      ? config.personas.map((p) => describe(p, "persona", 320)).join("\n")
      : "(nenhuma persona ainda)";
    const systems = config.systems.length
      ? config.systems.map((s) => describe(s, "system", 320)).join("\n")
      : "(nenhum sistema ainda)";

    return [
      focusBlock,
      `# Vocabulário do board "${config.name}"`,
      config.desiredOutcome ? `Resultado-alvo do produto: ${firstLine(config.desiredOutcome)}` : "",
      config.package ? `Pacote de código (o alvo de "sincronizar"): ${config.package}` : "",
      "",
      `## Personas (${config.personas.length})`,
      "Cada uma é um SYSTEM-PROMPT que um run adota ao escrever e construir.",
      personas,
      "",
      `## Sistemas (${config.systems.length})`,
      "Cada um é um prompt com o que aquele touchpoint DETÉM e os LIMITES a respeitar.",
      systems,
    ]
      .filter((l) => l !== "")
      .join("\n");
  } catch (e) {
    return `Não consegui ler o vocabulário do board "${boardId}": ${
      e instanceof Error ? e.message : String(e)
    }`;
  }
}
