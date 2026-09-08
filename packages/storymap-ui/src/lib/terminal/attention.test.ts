import { describe, expect, it } from "vitest";
import {
  ATTENTION_SETTLE,
  byAttentionUrgency,
  cliFlagExpired,
  cliFlagIsStale,
  countAsking,
  describeAttention,
  detectPanePrompt,
  hashPane,
  initialAttention,
  planWatchCycle,
  shouldAlert,
  stepAttention,
  terminalRows,
  waitedFor,
  type AttentionSample,
  type AttentionState,
  type TerminalAttention,
  type TerminalSessionLike,
} from "./attention";

const AGENT: Omit<AttentionSample, "text"> = { busy: false, agent: true };

/** Roda uma sequência de (tela, agora) e devolve os vereditos + alertas na ordem. */
function run(steps: Array<[string, number, Partial<AttentionSample>?]>, start?: AttentionState) {
  let state = start ?? initialAttention(0);
  const seen = steps.map(([text, now, over]) => {
    const r = stepAttention(state, { ...AGENT, ...over, text }, now);
    state = r.next;
    return { kind: r.next.kind, alert: r.alert };
  });
  return { seen, state };
}

describe("stepAttention — quando um terminal está esperando o operador", () => {
  it("a primeira amostra só estabelece a linha de base (nunca é veredito)", () => {
    const { seen } = run([["parado", 1_000]]);
    expect(seen).toEqual([{ kind: null, alert: null }]);
  });

  it("NÃO declara `idle` numa sessão que já estava parada quando começamos a olhar", () => {
    // Sem `sawWork`, o primeiro ciclo do watcher anunciaria "acabou agora" para toda sessão
    // adormecida da máquina — um alarme por sessão, no boot do serviço.
    const { seen } = run([
      ["parado", 0],
      ["parado", 60_000],
      ["parado", 300_000],
    ]);
    expect(seen.map((s) => s.kind)).toEqual([null, null, null]);
  });

  it("declara `idle` (com alerta) quando um agente produziu saída e depois ficou quieto", () => {
    const { seen } = run([
      ["a", 0],
      ["b", 1_000], // mexeu → trabalhando
      ["b", 10_000], // quieto, ainda dentro do limiar
      ["b", 26_001], // além do limiar → idle
      ["b", 40_000], // segue idle, mas o alerta é BORDA: não repete
    ]);
    expect(seen.map((s) => s.kind)).toEqual([null, null, null, "idle", "idle"]);
    expect(seen.map((s) => s.alert)).toEqual([null, null, null, "idle", null]);
  });

  it("volta a alertar num NOVO ciclo de trabalho", () => {
    const { seen } = run([
      ["a", 0],
      ["b", 1_000],
      ["b", 30_000], // idle #1
      ["c", 31_000], // voltou a trabalhar
      ["c", 60_000], // idle #2
    ]);
    expect(seen.filter((s) => s.alert).map((s) => s.alert)).toEqual(["idle", "idle"]);
  });

  it("um shell puro que fica quieto NÃO vira `idle` (um shell ocioso é o estado normal dele)", () => {
    const shell: Partial<AttentionSample> = { agent: false, busy: null };
    const { seen } = run([
      ["$ ", 0, shell],
      ["$ ls", 1_000, shell],
      ["$ ls", 60_000, shell],
    ]);
    expect(seen.map((s) => s.kind)).toEqual([null, null, null]);

    // …mas um shell que DESENHA um prompt acende igual: a régua é a FORMA na tela, não quem roda ali.
    const asking = run([
      ["$ ", 0, shell],
      ["Continuar a instalação? [y/N]", 1_000, shell],
      ["Continuar a instalação? [y/N]", 30_000, shell],
    ]);
    expect(asking.seen.map((s) => s.kind)).toEqual([null, null, "asking"]);
  });

  it("`asking` VENCE o flag busy do CLI — uma permissão acontece no meio do turno", () => {
    // Esta é a regra que faz o caso mais importante funcionar: quando o CLI desenha o prompt de
    // permissão, o turno ainda está em voo (`busy`), e ler o flag como "não espera" perderia
    // exatamente o momento em que o operador é o gargalo.
    const pane = "Bash command\nrm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. No";
    const { seen } = run([
      ["trabalhando…", 0, { busy: true }],
      [pane, 1_000, { busy: true }],
      [pane, 1_000 + ATTENTION_SETTLE.askMs, { busy: true }],
    ]);
    expect(seen.map((s) => s.kind)).toEqual([null, null, "asking"]);
    expect(seen[2].alert).toBe("asking");
  });

  it("mas o veto do `busy` EXPIRA — um flag latchado deixava a sessão INVISÍVEL para este vigia", () => {
    // Medido em produção (2026-07-30): uma sessão parqueou num job de background e ficou com
    // `status:"busy"` gravado por 21,9h com a tela congelada. Enquanto o veto era eterno, ela nunca
    // chegava ao degrau `idle` — nem o Jido nem os alertas falavam dela, por mais horas que passassem.
    const { seen } = run([
      ["a", 0, { busy: true }],
      ["b", 1_000, { busy: true }], // mexeu → sawWork
      ["b", 61_000, { busy: true }], // parada 60s: o flag ainda corrobora e manda
      ["b", 1_000 + ATTENTION_SETTLE.staleFlagMs, { busy: true }], // parada 90s: o flag venceu
    ]);
    expect(seen.map((s) => s.kind)).toEqual([null, null, null, "idle"]);
    expect(seen[3].alert).toBe("idle");
  });

  it("REPAINT não é produção: quem ABRE o terminal não pode ser o que prova que ele está vivo", () => {
    // Medido no rosto vivo: anexar-se a um pane o redimensiona, o TUI recebe SIGWINCH e repinta —
    // o hash muda inteiro sem que nada tenha sido produzido. Enquanto isso zerava o relógio, abrir um
    // terminal dormente o devolvia a "vivo" por 90s, e o guarda de kill voltava a recusar encerrá-lo
    // JUSTAMENTE na tela onde o operador tinha ido encerrá-lo.
    const g1 = { geometry: "120x30", busy: true } as const;
    const g2 = { geometry: "80x24", busy: true } as const;
    const { seen, state } = run([
      ["a", 0, g1],
      ["b", 1_000, g1], // produção de verdade
      ["b", 1_000 + ATTENTION_SETTLE.staleFlagMs, g1], // congelou o bastante ⇒ o flag venceu
      ["c", 1_000 + ATTENTION_SETTLE.staleFlagMs + 6_000, g2], // ALGUÉM ABRIU: outra geometria, tela nova
      // A tela repintada precisa dos 25s de acomodação como qualquer outra antes de voltar a `idle` —
      // o que este teste fixa é o RELÓGIO DA PRODUÇÃO, que não pode ter voltado junto com a pintura.
      ["c", 1_000 + ATTENTION_SETTLE.staleFlagMs + 6_000 + ATTENTION_SETTLE.idleMs + 1_000, g2],
    ]);
    expect(seen.map((s) => s.kind)).toEqual([null, null, "idle", null, "idle"]);
    // É ESTE número que o guarda de kill lê (screenStillness): ele não andou com o repaint, então a
    // sessão continua dormente para quem decide se ela pode ser encerrada.
    expect(state.producingAt).toBe(1_000);
    expect(state.changedAt).toBe(1_000 + ATTENTION_SETTLE.staleFlagMs + 6_000);
  });

  it("mas uma mudança de tela SEM redimensionar continua sendo produção", () => {
    const g = { geometry: "120x30", busy: true } as const;
    const { state } = run([
      ["a", 0, g],
      ["b", 1_000, g],
      ["c", 7_000, g],
    ]);
    expect(state.producingAt).toBe(7_000);
  });

  it("e uma sessão que de fato trabalha nunca vence o prazo — a tela dela não para", () => {
    // A trava contra o erro espelhado: enquanto o pane muda, o relógio de imobilidade zera a cada
    // amostra, então nenhum turno longo é anunciado como "acabou".
    const { seen } = run([
      ["a", 0, { busy: true }],
      ["b", 1_000, { busy: true }],
      ["c", 200_000, { busy: true }],
      ["d", 400_000, { busy: true }],
    ]);
    expect(seen.map((s) => s.kind)).toEqual([null, null, null, null]);
  });

  it("escala de `idle` para `asking` com alerta novo (mas não alerta ao desescalar)", () => {
    const pane = "Deseja continuar?\n❯ 1. Sim\n  2. Não";
    const { seen } = run([
      ["a", 0],
      ["b", 1_000],
      ["b", 30_000], // idle
      [pane, 31_000], // mexeu (desenhou o prompt)
      [pane, 40_000], // asking (≥ askMs)
      ["b", 41_000], // mexeu de novo
      ["b", 70_000], // volta a idle — SEM alerta (desescalada não é notícia)
    ]);
    expect(seen.map((s) => s.kind)).toEqual([null, null, "idle", null, "asking", null, "idle"]);
    expect(seen.map((s) => s.alert)).toEqual([null, null, "idle", null, "asking", null, "idle"]);
  });

  it("o `since` é quando a TELA congelou, não quando o watcher percebeu", () => {
    const pane = "Deseja continuar?\n❯ 1. Sim";
    let state = initialAttention(0);
    for (const [text, now] of [["a", 0], [pane, 5_000], [pane, 60_000]] as Array<[string, number]>) {
      state = stepAttention(state, { ...AGENT, text }, now).next;
    }
    expect(state.kind).toBe("asking");
    expect(state.since).toBe(5_000); // o instante em que o prompt apareceu, não os 60s
  });

  it("não muta o estado recebido", () => {
    const base = initialAttention(0);
    const snapshot = { ...base };
    stepAttention(base, { ...AGENT, text: "x" }, 1_000);
    expect(base).toEqual(snapshot);
  });
});

describe("cliFlagIsStale — o flag do CLI é uma afirmação; a tela é a evidência", () => {
  it("sem evidência de tela, NADA vence — ausência de dado não desmente ninguém", () => {
    expect(cliFlagIsStale(null)).toBe(false);
    expect(cliFlagIsStale(undefined)).toBe(false);
  });

  it("tela viva ⇒ o flag vale; tela congelada além do prazo ⇒ venceu", () => {
    expect(cliFlagIsStale(0)).toBe(false);
    expect(cliFlagIsStale(ATTENTION_SETTLE.staleFlagMs - 1)).toBe(false);
    expect(cliFlagIsStale(ATTENTION_SETTLE.staleFlagMs)).toBe(true);
    expect(cliFlagIsStale(21.9 * 3600_000)).toBe(true); // o caso medido em produção
  });
});

describe("cliFlagExpired — a tela sozinha é enganável; o transcript não", () => {
  const S = ATTENTION_SETTLE;

  it("O BUG DE 2026-07-31: tela VIVA, flag de 42,6h, transcript mudo há 31min ⇒ venceu", () => {
    // A sessão `meu-monorepo-c2` tinha um job em background dentro, e o rodapé dele ("Burrowing…
    // (9m 56s)") repinta a cada segundo. A tela nunca ficava parada 90s, então a régua antiga NUNCA
    // demovia — e a home anunciava "trabalhando" para um composer parado.
    expect(cliFlagIsStale(1_000)).toBe(false); // a testemunha antiga, sozinha, absolve
    expect(
      cliFlagExpired({ screenStillMs: 1_000, transcriptIdleMs: 31 * 60_000, flagAgeMs: 42.6 * 3600_000 }),
    ).toBe(true);
  });

  it("a tela parada ainda basta sozinha — o primeiro limbo continua valendo", () => {
    expect(cliFlagExpired({ screenStillMs: S.staleFlagMs })).toBe(true);
    expect(cliFlagExpired({ screenStillMs: S.staleFlagMs, transcriptIdleMs: 0, flagAgeMs: 0 })).toBe(true);
  });

  it("turno longo e SILENCIOSO não é demovido: o flag dele é novo", () => {
    // Um build de 15 min não escreve no transcript enquanto roda. Se `transcriptIdleMs` bastasse
    // sozinho, a sessão que mais trabalha seria a primeira a ser chamada de ociosa.
    expect(cliFlagExpired({ screenStillMs: 1_000, transcriptIdleMs: 15 * 60_000, flagAgeMs: 15 * 60_000 })).toBe(
      false,
    );
  });

  it("flag antigo com transcript VIVO também não é demovido — ele está escrevendo agora", () => {
    expect(cliFlagExpired({ screenStillMs: 1_000, transcriptIdleMs: 5_000, flagAgeMs: 42 * 3600_000 })).toBe(false);
  });

  it("sem evidência não há demoção — em nenhuma combinação de ausências", () => {
    expect(cliFlagExpired({})).toBe(false);
    expect(cliFlagExpired({ screenStillMs: null, transcriptIdleMs: null, flagAgeMs: null })).toBe(false);
    // uma testemunha só do segundo limbo não decide nada: as duas andam juntas
    expect(cliFlagExpired({ transcriptIdleMs: 10 * 3600_000 })).toBe(false);
    expect(cliFlagExpired({ flagAgeMs: 10 * 3600_000 })).toBe(false);
  });

  it("os limiares do segundo limbo são de igualdade inclusiva, como o primeiro", () => {
    const onTheLine = { screenStillMs: 0, transcriptIdleMs: S.transcriptIdleMs, flagAgeMs: S.flagBusyAgeMs };
    expect(cliFlagExpired(onTheLine)).toBe(true);
    expect(cliFlagExpired({ ...onTheLine, transcriptIdleMs: S.transcriptIdleMs - 1 })).toBe(false);
    expect(cliFlagExpired({ ...onTheLine, flagAgeMs: S.flagBusyAgeMs - 1 })).toBe(false);
  });
});

describe("detectPanePrompt — as FORMAS de prompt (agnóstico de programa)", () => {
  it("reconhece a lista de opções com cursor e extrai a pergunta acima dela", () => {
    const pane = [
      "╭──────────────────────────────╮",
      "│ Bash command                 │",
      "│ rm -rf dist                  │",
      "│ Deseja executar este comando?│",
      "│ ❯ 1. Sim                     │",
      "│   2. Não, e me diga o porquê │",
      "╰──────────────────────────────╯",
    ].join("\n");
    expect(detectPanePrompt(pane)).toEqual({ shape: "options", question: "Deseja executar este comando?" });
  });

  it("a lista de opções vence o marcador de trabalho (o prompt é desenho, não coincidência)", () => {
    const pane = "esc to interrupt\nEscolha uma opção\n❯ 1. Seguir";
    expect(detectPanePrompt(pane)?.shape).toBe("options");
  });

  it("reconhece sim/não, senha e 'pressione enter'", () => {
    expect(detectPanePrompt("Continuar a instalação? [y/N] ")?.shape).toBe("yesno");
    expect(detectPanePrompt("[sudo] senha para root:")?.shape).toBe("secret");
    expect(detectPanePrompt("Enter passphrase for key '/root/.ssh/id_ed25519':")?.shape).toBe("secret");
    expect(detectPanePrompt("Pressione ENTER para continuar")?.shape).toBe("enter");
  });

  it("reconhece a confirmação em prosa", () => {
    expect(detectPanePrompt("Do you want to proceed with the deploy")?.shape).toBe("confirm");
    expect(detectPanePrompt("Tem certeza que quer apagar tudo")?.shape).toBe("confirm");
  });

  it("NÃO acende com saída rolando que só MENCIONA um prompt", () => {
    // Falso-positivo aqui é notificação no celular de madrugada — o veto pelo marcador de trabalho
    // existe para isto.
    const pane = "✻ Pensando… (12s · esc to interrupt)\n  o teste pergunta 'deseja continuar?' e segue";
    expect(detectPanePrompt(pane)).toBeNull();
  });

  it("NÃO confunde uma lista numerada de saída com um prompt (falta o cursor)", () => {
    expect(detectPanePrompt("Resultado:\n1. primeiro\n2. segundo\n3. terceiro")).toBeNull();
  });

  it("NÃO confunde o campo de digitação do CLI com um prompt — ele usa o MESMO glifo `❯`", () => {
    // Medido nesta máquina: o composer ocioso do Claude Code é a linha `❯ `, e com texto meio digitado
    // vira `❯ escreve isso pra mim`. Sem exigir o NÚMERO, toda sessão com uma frase pela metade seria
    // anunciada como "parado esperando você".
    expect(detectPanePrompt("bypass permissions on\n❯ ")).toBeNull();
    expect(detectPanePrompt("bypass permissions on\n❯ escreve isso pra mim")).toBeNull();
  });

  it("só olha o RODAPÉ da tela — um prompt já respondido lá em cima não conta", () => {
    const old = "Deseja continuar? [y/N]";
    const scroll = [old, ...Array.from({ length: 40 }, (_, i) => `linha ${i}`)].join("\n");
    expect(detectPanePrompt(scroll)).toBeNull();
  });

  it("ENXERGA o prompt quando o pane está quase todo VAZIO abaixo dele", () => {
    // O `capture-pane` devolve a ALTURA INTEIRA do pane: um `read -p "… [y/N] "` imprime na 1ª linha e
    // deixa ~40 em branco. Cortando as N últimas linhas CRUAS, a janela caía toda no vazio — medido num
    // pane real, que voltava "nada" com o `[y/N]` na tela. Só as linhas COM CONTEÚDO entram no corte.
    const pane = ["Continuar a instalacao? [y/N]", ...Array(45).fill("")].join("\n");
    expect(detectPanePrompt(pane)?.shape).toBe("yesno");
  });

  it("as bordas de caixa não gastam a janela do rodapé (elas viram vazio e caem fora)", () => {
    const pane = [
      "Escolha uma opção",
      ...Array.from({ length: 30 }, () => "╭──────────────────────────────╮"),
      "❯ 1. Seguir",
      ...Array(20).fill(""),
    ].join("\n");
    expect(detectPanePrompt(pane)?.shape).toBe("options");
  });

  it("tolera entrada vazia", () => {
    expect(detectPanePrompt("")).toBeNull();
  });

  it("NÃO levanta um pedaço de texto qualquer acima do cursor como se fosse a pergunta", () => {
    // A REGRESSÃO, medida em produção: a notificação do sistema anunciou `“Mascote e no” · parado há
    // 4min`. O diálogo era real, mas a linha logo acima dele era um trecho de código na tela — e a
    // única régua era "a linha mais próxima que não é uma opção". Um aviso que interrompe o operador
    // com um fragmento sem sentido gasta a credibilidade de todos os outros avisos.
    const pane = ["const xs = 38; // o Mascote e no", "❯ 1. Sim", "  2. Não"].join("\n");
    const prompt = detectPanePrompt(pane);
    expect(prompt?.shape).toBe("options"); // o prompt continua sendo detectado…
    expect(prompt?.question).toBe(""); // …mas sem pergunta: describeAttention usa a frase honesta
  });

  it("RECOSTURA a pergunta que o TUI quebrou em duas linhas (antes sobrava só o rabo)", () => {
    const pane = [
      "╭────────────────────────────────────────╮",
      "│ Quer que eu aplique esta mudança em     │",
      "│ CopilotFace.tsx?                        │",
      "│ ❯ 1. Sim                                │",
      "╰────────────────────────────────────────╯",
    ].join("\n");
    expect(detectPanePrompt(pane)?.question).toBe("Quer que eu aplique esta mudança em CopilotFace.tsx?");
  });

  it("a guarda anti-código vale também para as formas de LINHA, não só para a lista", () => {
    // Um `[y/N]` dentro de um trecho de fonte na tela casa o padrão sem ser prompt nenhum. A FORMA
    // continua valendo (o terminal pode mesmo estar esperando) — o que se recusa é publicar o texto.
    const p = detectPanePrompt('const ask = () => confirm("[y/N]");');
    expect(p?.shape).toBe("yesno");
    expect(p?.question).toBe("");
    // e uma linha de prompt de verdade segue passando inteira
    expect(detectPanePrompt("Continuar a instalação? [y/N]")?.question).toBe("Continuar a instalação? [y/N]");
  });

  it("a FORMA do prompt sobrevive no estado (é ela que descreve o aviso sem pergunta)", () => {
    const pane = "[sudo] senha para root:";
    let state = initialAttention(0);
    for (const [text, now] of [["a", 0], [pane, 1_000], [pane, 30_000]] as Array<[string, number]>) {
      state = stepAttention(state, { ...AGENT, text }, now).next;
    }
    expect(state.kind).toBe("asking");
    expect(state.shape).toBe("secret");
  });

  it("NÃO adota como pergunta uma linha que está FORA do bloco do diálogo", () => {
    // Uma linha em branco (ou uma borda de caixa, que vira branco ao limpar) entre a frase e as opções
    // significa que aquilo é scrollback que por acaso ficou ali em cima — não o enunciado do diálogo.
    const pane = ["Mascote e no", "", "❯ 1. Sim", "  2. Não"].join("\n");
    expect(detectPanePrompt(pane)?.question).toBe("");
  });

  it("o corte no teto respeita a palavra — a notificação não termina no meio de uma", () => {
    const longa = `Deseja aplicar ${"a mudança proposta ".repeat(10)}agora?`;
    const q = detectPanePrompt(`${longa}\n❯ 1. Sim`)?.question ?? "";
    const cut = q.slice(0, -1); // sem as reticências
    expect(q.length).toBeLessThanOrEqual(120);
    expect(q.endsWith("…")).toBe(true);
    expect(cut).toBe(cut.trimEnd()); // sem espaço pendurado antes das reticências
    expect(longa.startsWith(cut)).toBe(true); // o que sobrou é um prefixo íntegro do original
    // A prova da fronteira: no ORIGINAL, o caractere logo depois do corte é um espaço — ou seja, a
    // última palavra que sobrou está inteira. (Um corte cego pararia no meio dela.)
    expect(longa[cut.length]).toBe(" ");
  });

  it("a costura para na opção acima — nunca engole a lista inteira", () => {
    const pane = ["Escolha:", "1. primeira opção", "e continuar assim?", "❯ 2. segunda"].join("\n");
    expect(detectPanePrompt(pane)?.question).toBe("e continuar assim?");
  });
});

describe("hashPane", () => {
  it("é estável e distingue mudança de 1 caractere", () => {
    expect(hashPane("abc")).toBe(hashPane("abc"));
    expect(hashPane("abc")).not.toBe(hashPane("abd"));
  });

  it("distingue conteúdo que só cresce (log rolando)", () => {
    expect(hashPane("linha 1\n")).not.toBe(hashPane("linha 1\nlinha 2\n"));
  });
});

describe("shouldAlert — saber ≠ interromper", () => {
  it("o que TRAVA interrompe em qualquer sessão, com ou sem campainha", () => {
    expect(shouldAlert("asking", false)).toBe(true);
    expect(shouldAlert("asking", true)).toBe(true);
  });

  it("'ficou quieto' só interrompe na sessão em que o operador armou a campainha", () => {
    // A regressão que isto conserta: ao passar a VIGIAR todas as sessões (o antecessor só via as
    // armadas), o AVISO iria junto de carona — com som ligado, cada fim de turno de cada agente da
    // máquina viraria um bipe. Ampliar a visão era o pedido; ampliar a interrupção não era.
    expect(shouldAlert("idle", false)).toBe(false);
    expect(shouldAlert("idle", true)).toBe(true);
  });
});

describe("planWatchCycle — o teto de sessões vigiadas", () => {
  const s = (name: string, activityAt: number | null) => ({ name, activityAt });

  it("fica com as de atividade mais RECENTE e conta as que ficaram de fora", () => {
    const r = planWatchCycle([s("velha", 10), s("nova", 300), s("media", 100)], 2);
    expect(r.watched.map((x) => x.name)).toEqual(["nova", "media"]);
    expect(r.dropped).toBe(1);
  });

  it("cabendo todas, não descarta ninguém", () => {
    expect(planWatchCycle([s("a", 1), s("b", 2)], 12).dropped).toBe(0);
  });

  it("sessão sem carimbo de atividade não empurra as outras para fora", () => {
    const r = planWatchCycle([s("sem", null), s("com", 5)], 1);
    expect(r.watched.map((x) => x.name)).toEqual(["com"]);
  });

  it("um teto inválido ainda vigia ao menos uma (nunca zero)", () => {
    expect(planWatchCycle([s("a", 1), s("b", 2)], 0).watched).toHaveLength(1);
  });
});

describe("apresentação", () => {
  const asking: TerminalAttention = {
    session: "cop-x",
    label: "Melhorias de UI",
    kind: "asking",
    since: 0,
    agent: true,
    question: "Deseja executar este comando?",
  };
  const idle: TerminalAttention = { ...asking, kind: "idle", question: undefined, since: 0 };

  it("ordena o que TRAVA antes do que só está quieto, e o mais antigo primeiro", () => {
    const novo: TerminalAttention = { ...asking, session: "b", since: 10_000 };
    expect([novo, asking].sort(byAttentionUrgency).map((t) => t.session)).toEqual(["cop-x", "b"]);
    expect([idle, asking].sort(byAttentionUrgency).map((t) => t.kind)).toEqual(["asking", "idle"]);
  });

  it("o texto do alerta nomeia o terminal, a pergunta e há quanto tempo", () => {
    const d = describeAttention(asking, 240_000);
    expect(d.title).toContain("Melhorias de UI");
    expect(d.body).toContain("Deseja executar este comando?");
    expect(d.body).toContain("4min");
  });

  it("sem pergunta legível, diz o que ele está PEDINDO — pela forma do prompt", () => {
    // A frase única de antes ("parou num prompt") tratava um menu e uma SENHA como a mesma coisa, e
    // desde que a leitura da pergunta ficou mais exigente esse caso deixou de ser raro. A forma vem
    // da ESTRUTURA reconhecida pelo detector, então nunca é lixo de tela.
    const senha = describeAttention({ ...asking, question: undefined, shape: "secret" }, 60_000);
    expect(senha.body).toContain("senha");
    const lista = describeAttention({ ...asking, question: undefined, shape: "options" }, 60_000);
    expect(lista.body).toContain("escolher uma opção");
    expect(senha.body).not.toBe(lista.body);
  });

  it("sem pergunta E sem forma, ainda diz a verdade mínima (nunca inventa e nunca fica mudo)", () => {
    const d = describeAttention({ ...asking, question: undefined, shape: undefined }, 60_000);
    expect(d.body).toContain("prompt");
    expect(d.body).not.toContain("undefined");
  });

  it("waitedFor cobre segundos, minutos e horas", () => {
    expect(waitedFor(0, 12_000)).toBe("12s");
    expect(waitedFor(0, 4 * 60_000)).toBe("4min");
    expect(waitedFor(0, 63 * 60_000)).toBe("1h03");
  });
});

describe("terminalRows — a lista da barra (sessões ⋈ quem espera você)", () => {
  const sessao = (name: string, extra: Partial<TerminalSessionLike> = {}): TerminalSessionLike => ({
    name,
    label: name,
    attached: false,
    ...extra,
  });
  const espera = (session: string, kind: TerminalAttention["kind"], since: number): TerminalAttention => ({
    session,
    label: session,
    kind,
    since,
    agent: true,
  });

  it("põe quem TRAVA na frente de quem só está quieto, de quem está aberto e do resto", () => {
    const rows = terminalRows(
      [sessao("resto"), sessao("aberta", { attached: true }), sessao("quieta"), sessao("travada")],
      [espera("travada", "asking", 1_000), espera("quieta", "idle", 500)],
    );
    expect(rows.map((r) => r.session)).toEqual(["travada", "quieta", "aberta", "resto"]);
  });

  it("entre dois travados, o que espera há MAIS tempo vem primeiro", () => {
    const rows = terminalRows(
      [sessao("novo"), sessao("velho")],
      [espera("novo", "asking", 9_000), espera("velho", "asking", 1_000)],
    );
    expect(rows.map((r) => r.session)).toEqual(["velho", "novo"]);
  });

  it("um alerta SEM sessão correspondente não vira linha (ela não abriria nada)", () => {
    const rows = terminalRows([sessao("viva")], [espera("fantasma", "asking", 0)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session).toBe("viva");
    expect(rows[0]!.waiting).toBeNull();
  });

  it("a frase cai de `phrase` para o comando e daí para o cwd — nunca para `undefined`", () => {
    const [comFrase, comComando, comCwd, semNada] = terminalRows(
      [
        sessao("a", { phrase: "rodando os testes", command: "bash", cwd: "/repo" }),
        sessao("b", { command: "bash", cwd: "/repo" }),
        sessao("c", { cwd: "/repo" }),
        sessao("d"),
      ],
      [],
    );
    expect(comFrase!.phrase).toBe("rodando os testes");
    expect(comComando!.phrase).toBe("bash");
    expect(comCwd!.phrase).toBe("/repo");
    expect(semNada!.phrase).toBe("");
  });

  it("sem label, a linha cai para o nome cru da sessão (nunca fica em branco)", () => {
    const [row] = terminalRows([{ name: "cop-x" }], []);
    expect(row!.label).toBe("cop-x");
  });

  it("countAsking conta só o que TRAVA — quem ficou quieto não acende o âmbar do medidor", () => {
    const rows = terminalRows(
      [sessao("a"), sessao("b"), sessao("c")],
      [espera("a", "asking", 0), espera("b", "idle", 0)],
    );
    expect(countAsking(rows)).toBe(1);
  });
});
