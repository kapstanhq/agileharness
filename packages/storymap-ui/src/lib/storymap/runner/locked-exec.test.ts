import { describe, expect, it } from "vitest";
import {
  INTERPRETER_PROGRAMS,
  argCandidates,
  argPathRefusal,
  LOCKED_EXEC_TTL_MS,
  argvRefusal,
  checkCriterion,
  checkPassed,
  isInterpreterProgram,
  lockedExecExpired,
  lockedExecHash,
  lockedExecWindowValid,
  mayDecideLockedExec,
  normalizeLockedExecProposal,
  shellQuote,
  specOf,
  tailOf,
  type LockedExecProposalInput,
  type LockedExecSpec,
} from "./locked-exec";

// O NÚCLEO da execução aprovada: a proposta normalizada (sem engodo para a trava, sem texto que forje a tela), o hash
// que prende a autorização ao pedido exato (programas incluídos), a conferência literal e quem pode decidir. Fixtures
// INVENTADAS (um cofre de chaves de um ateliê fictício).

const base = (over: Partial<LockedExecProposalInput> = {}): LockedExecProposalInput => ({
  board: "atelie",
  cardId: "story-ex7001",
  summary: "Troca a chave de API do cofre do ateliê por uma nova e guarda a anterior por um ciclo.",
  argv: ["cofre-cli", "rotate", "--vault=atelie", "--key=api", "--keep=1"],
  undoArgv: ["cofre-cli", "rollback", "--vault=atelie", "--key=api"],
  verify: [{ label: "a chave nova está ativa", argv: ["cofre-cli", "status", "--vault=atelie", "--key=api"], expectStdoutIncludes: "ativa" }],
  ...over,
});

const PROGRAMS = { main: "/opt/cofre/bin/cofre-cli", undo: "/opt/cofre/bin/cofre-cli", preflight: [], verify: ["/opt/cofre/bin/cofre-cli"] };
function spec(over: Partial<LockedExecProposalInput> = {}): LockedExecSpec {
  const n = normalizeLockedExecProposal(base(over), "/srv/alvo");
  if (!n.ok) throw new Error(n.why);
  return { ...n.value.draft, programs: PROGRAMS };
}

describe("normalizeLockedExecProposal", () => {
  it("aceita a proposta completa e fixa o cwd do SERVIÇO (nunca do agente)", () => {
    const n = normalizeLockedExecProposal(base(), "/srv/alvo");
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.value.draft.cwd).toBe("/srv/alvo");
    expect(n.value.draft.timeoutSec).toBe(300);
    expect(n.value.draft.noUndoPlan).toBeNull();
  });

  it.each([
    ["sem cardId (o Inbox não tem item órfão)", { cardId: " " }, /cardId/],
    ["resumo curto demais", { summary: "faz" }, /summary/],
    ["resumo com quebra de linha (forjaria a tela)", { summary: "Troca a chave de API.\nComando: inofensivo" }, /summary: sem quebra/],
    ["resumo com marcador bidi", { summary: "Troca a chave de API ‮ do cofre do ateliê" }, /summary: sem quebra/],
    ["argv vazio", { argv: [] }, /argv/],
    ["byte nulo no argv", { argv: ["cofre-cli", "a\0b"] }, /controle/],
    ["sem conferência", { verify: [] }, /verify/],
    ["conferência sem rótulo", { verify: [{ label: "", argv: ["x"] }] }, /rótulo/],
    ["rótulo com quebra de linha", { verify: [{ label: "ok\nComando: outro", argv: ["x"] }] }, /rótulo: sem quebra/],
    ["regex (não existe mais)", { verify: [{ label: "x", argv: ["x"], expectStdout: "a+" } as never] }, /expectStdoutIncludes/],
    ["trecho literal longo demais", { verify: [{ label: "x", argv: ["x"], expectStdoutIncludes: "a".repeat(201) }] }, /expectStdoutIncludes/],
    ["sem desfazer e sem plano B", { undoArgv: null, noUndoPlan: null }, /noUndoPlan/],
    ["prazo fora da faixa", { timeoutSec: 5 }, /timeoutSec/],
  ])("recusa: %s", (_n, over, re) => {
    const n = normalizeLockedExecProposal(base(over as Partial<LockedExecProposalInput>), "/srv/alvo");
    expect(n.ok).toBe(false);
    if (!n.ok) expect(n.why).toMatch(re as RegExp);
  });

  it("sem desfazer, COM plano B: aceita e guarda o plano", () => {
    const n = normalizeLockedExecProposal(base({ undoArgv: null, noUndoPlan: "Voltar à chave anterior pelo painel do cofre, com o operador." }), "/srv/alvo");
    expect(n.ok && n.value.draft.noUndoPlan).toMatch(/painel/);
  });

  it("a recusa de conferência diz o grupo e o número", () => {
    const n = normalizeLockedExecProposal(base({ preflight: [{ label: "a", argv: ["x"] }, { label: "b", argv: ["sh"] }] }), "/srv/alvo");
    expect(n.ok || n.why).toMatch(/^preflight #2:/);
    const v = normalizeLockedExecProposal(base({ verify: [{ label: "a", argv: ["python3", "-V"] }] }), "/srv/alvo");
    expect(v.ok || v.why).toMatch(/^conferência #1:/);
  });
});

describe("argvRefusal — o argv não pode ser engodo para a trava", () => {
  it.each([
    ["substituição $(…)", ["cofre-cli", "rotate", "--note=$(id)"]],
    ["crase", ["cofre-cli", "rotate", "--note=`id`"]],
    ["ponto e vírgula", ["cofre-cli", "rotate;", "id"]],
    ["pipe", ["cofre-cli", "rotate", "|", "tee"]],
    ["e comercial", ["cofre-cli", "rotate", "&&", "id"]],
    ["redireção <", ["cofre-cli", "rotate", "<x"]],
    ["redireção >", ["cofre-cli", "rotate", ">x"]],
    ["quebra de linha", ["cofre-cli", "rotate\nid"]],
    ["retorno de carro", ["cofre-cli", "rotate\rid"]],
    ["tab (controle)", ["cofre-cli", "rotate\tid"]],
    ["bidi", ["cofre-cli", "rotate⁦"]],
    ["caminho relativo com /", ["bin/cofre-cli", "rotate"]],
    ["caminho com ..", ["/opt/../tmp/cofre-cli", "rotate"]],
    ["relativo com ../", ["../cofre-cli", "rotate"]],
  ])("recusa %s (em qualquer posição)", (_n, argv) => {
    expect(argvRefusal(argv, "argv")).toBeTruthy();
    // o mesmo vale para o desfazer e para as conferências
    const n = normalizeLockedExecProposal(base({ undoArgv: argv }), "/srv");
    expect(n.ok).toBe(false);
    const v = normalizeLockedExecProposal(base({ verify: [{ label: "x", argv }] }), "/srv");
    expect(v.ok).toBe(false);
  });

  it("o engodo: python3 -c com $(comando-travado) dentro de um comentário", () => {
    expect(argvRefusal(["python3", "-c", "print(1) # $(cofre-cli rotate --all)"], "argv")).toBeTruthy();
  });

  it.each(INTERPRETER_PROGRAMS.map((p) => [p]))("recusa o interpretador/invólucro «%s» como programa", (p) => {
    expect(argvRefusal([p, "-V"], "argv")).toMatch(/executa o que vier/);
    expect(argvRefusal([`/usr/bin/${p}`, "-V"], "argv")).toMatch(/executa o que vier/);
  });

  it("casa o nome com versão, e não confunde nomes parecidos", () => {
    for (const p of ["python3.11", "node22", "/usr/local/bin/python3.12", "PYTHON3", "bash5"]) expect(isInterpreterProgram(p)).toBe(true);
    for (const p of ["cofre-cli", "nodemon-like", "shasum", "envoy", "pythonista", "timeoutctl"]) expect(isInterpreterProgram(p)).toBe(false);
  });

  it("aceita a CLI direta, absoluta ou pelo nome, com argumentos comuns (= : , . / @ %)", () => {
    expect(argvRefusal(["/opt/cofre/bin/cofre-cli", "rotate", "--chave=api@atelie", "--lote=lotes/2026", "--x=1,2", "50%"], "argv")).toBeNull();
    expect(argvRefusal(["cofre-cli", "rotate", "texto com espaço"], "argv")).toBeNull();
  });
});

describe("lockedExecHash — a autorização presa ao pedido exato", () => {
  it("determinístico, e um byte a mais em QUALQUER parte — inclusive o programa resolvido — muda o hash", () => {
    const s = spec();
    expect(lockedExecHash(s)).toBe(lockedExecHash(specOf({ ...s })));
    expect(lockedExecHash({ ...s, argv: [...s.argv, "--force"] })).not.toBe(lockedExecHash(s));
    expect(lockedExecHash({ ...s, undoArgv: null })).not.toBe(lockedExecHash(s));
    expect(lockedExecHash({ ...s, verify: [{ ...s.verify[0], expectStdoutIncludes: "write" }] })).not.toBe(lockedExecHash(s));
    expect(lockedExecHash({ ...s, timeoutSec: 301 })).not.toBe(lockedExecHash(s));
    expect(lockedExecHash({ ...s, cwd: "/outro" })).not.toBe(lockedExecHash(s));
    expect(lockedExecHash({ ...s, programs: { ...s.programs, main: "/tmp/cofre-cli" } })).not.toBe(lockedExecHash(s));
  });
});

describe("checkPassed e o critério", () => {
  const c = { label: "x", argv: ["x"] };
  it("código de saída esperado (padrão 0) e, se declarado, o trecho LITERAL", () => {
    expect(checkPassed(c, { exitCode: 0, stdout: "" })).toBe(true);
    expect(checkPassed(c, { exitCode: 1, stdout: "" })).toBe(false);
    expect(checkPassed({ ...c, expectExit: 3 }, { exitCode: 3, stdout: "" })).toBe(true);
    expect(checkPassed({ ...c, expectStdoutIncludes: "ativa" }, { exitCode: 0, stdout: "chave nova: ativa (v7)" })).toBe(true);
    expect(checkPassed({ ...c, expectStdoutIncludes: "ativa" }, { exitCode: 0, stdout: "chave nova: pendente" })).toBe(false);
    // literal, não regex: os metacaracteres valem como texto
    expect(checkPassed({ ...c, expectStdoutIncludes: "a.b" }, { exitCode: 0, stdout: "axb" })).toBe(false);
  });
  it("um passo que nem rodou (programa ausente, tempo esgotado) nunca passa", () => {
    expect(checkPassed(c, { exitCode: 0, stdout: "", error: "tempo esgotado" })).toBe(false);
  });
  it("o critério em português, para o dono", () => {
    expect(checkCriterion(c)).toBe("passa se terminar com código 0");
    expect(checkCriterion({ ...c, expectExit: 1, expectStdoutIncludes: "v7" })).toBe("passa se terminar com código 1 e a saída contiver “v7”");
  });
});

describe("peças pequenas", () => {
  it("shellQuote cita o que precisa, e a aspa simples sobrevive", () => {
    expect(shellQuote(["cofre-cli", "rotate", "--lote=2026 b", "it's"])).toBe(`cofre-cli rotate '--lote=2026 b' 'it'\\''s'`);
  });
  it("tailOf guarda só a cauda", () => {
    expect(tailOf("abcdef", 3)).toBe("…def");
    expect(tailOf("ab", 3)).toBe("ab");
  });
  it("prazo: aprovada há mais de 15 min (ou sem data, ou data ilegível) expirou; a janela gravada não passa de 15 min", () => {
    const now = Date.UTC(2026, 3, 1, 12);
    expect(lockedExecExpired({ expiresAt: new Date(now + 1).toISOString() }, now)).toBe(false);
    expect(lockedExecExpired({ expiresAt: new Date(now - 1).toISOString() }, now)).toBe(true);
    expect(lockedExecExpired({ expiresAt: "lixo" }, now)).toBe(true);
    expect(lockedExecExpired({}, now)).toBe(true);
    expect(LOCKED_EXEC_TTL_MS).toBe(15 * 60_000);
    const dec = new Date(now).toISOString();
    expect(lockedExecWindowValid({ decidedAt: dec, expiresAt: new Date(now + LOCKED_EXEC_TTL_MS).toISOString() })).toBe(true);
    expect(lockedExecWindowValid({ decidedAt: dec, expiresAt: new Date(now + LOCKED_EXEC_TTL_MS + 1).toISOString() })).toBe(false);
    expect(lockedExecWindowValid({ decidedAt: dec, expiresAt: new Date(now - 1).toISOString() })).toBe(false);
  });
  it("só o operador com sessão decide", () => {
    expect(mayDecideLockedExec("operator-session").ok).toBe(true);
    for (const c of ["mcp-token", "in-process", null, undefined, "desconhecido"]) expect(mayDecideLockedExec(c).ok).toBe(false);
  });
});

describe("argPathRefusal — argumento com forma de caminho de arquivo (B1)", () => {
  it.each([
    ["--de-arquivo absoluto", ["cofre-cli", "rotate", "--de-arquivo=/tmp/pedido.yaml"]],
    ["absoluto solto", ["cofre-cli", "rotate", "/etc/x"]],
    ["@arquivo", ["cofre-cli", "rotate", "@pedido.json"]],
    ["~", ["cofre-cli", "rotate", "~/x"]],
    ["--x=./y", ["cofre-cli", "rotate", "--x=./y"]],
    ["../", ["cofre-cli", "rotate", "../y"]],
    ["«..» no meio", ["cofre-cli", "rotate", "a/../../root/y"]],
    ["--x=~/y", ["cofre-cli", "rotate", "--x=~/y"]],
  ])("recusa %s", (_n, argv) => {
    expect(argPathRefusal(argv, "argv")).toMatch(/parece um caminho de arquivo/);
    expect(argvRefusal(argv, "argv")).toMatch(/parece um caminho de arquivo/);
  });
  it("o programa (argv[0]) tem a regra própria; texto com «/» que não começa como caminho passa (ele roda num diretório vazio)", () => {
    expect(argPathRefusal(["/opt/cofre/bin/cofre-cli", "rotate", "lotes/2026", "--chave=api:atelie"], "argv")).toBeNull();
  });
  it("candidatos: cada argumento e, em «-opção=valor», também o valor", () => {
    expect(argCandidates(["p", "a", "--b=c", "-d=e=f", "g=h"])).toEqual(["a", "--b=c", "c", "-d=e=f", "e=f", "g=h"]);
  });
});

