import { describe, expect, it } from "vitest";
import { LIST_FORMAT, parseSessionList, SEP } from "./tmux";

// Usa o SEP do MÓDULO — um separador próprio aqui faria o teste passar com o código errado
// (foi exatamente assim que o bug do 0x1f atravessou a suíte).
const line = (...fields: string[]) => fields.join(SEP);

describe("parseSessionList — saída do `tmux list-sessions -F`", () => {
  it("lê os campos de uma sessão e converte created de segundos para ms", () => {
    const out = parseSessionList(
      line("claude", "2", "1770000000", "1", "/root/meu-monorepo", "claude", "revisando story-x"),
    );
    expect(out).toEqual([
      {
        name: "claude",
        windows: 2,
        createdAt: 1770000000_000,
        attached: true,
        path: "/root/meu-monorepo",
        command: "claude",
        paneTitle: "revisando story-x",
      },
    ]);
  });

  it("lê o pane_title (o último campo) e default vazio quando ausente", () => {
    const [withTitle] = parseSessionList(line("a", "1", "10", "0", "/", "bash", "meu título"));
    expect(withTitle.paneTitle).toBe("meu título");
    const [without] = parseSessionList(line("b", "1", "10", "0", "/", "bash"));
    expect(without.paneTitle).toBe("");
  });

  it("trata session_attached '0' como não-anexada", () => {
    const [s] = parseSessionList(line("shell", "1", "1770000000", "0", "/root", "bash"));
    expect(s.attached).toBe(false);
  });

  it("lê várias sessões e ignora linhas em branco", () => {
    const out = parseSessionList(
      [line("a", "1", "10", "0", "/", "bash"), "", line("b", "1", "20", "1", "/tmp", "claude"), ""].join("\n"),
    );
    expect(out.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("pula linha sem nome em vez de lançar — lista parcial é mais útil que erro", () => {
    const out = parseSessionList(
      [line("", "1", "10", "0", "/", "bash"), line("ok", "1", "10", "0", "/", "bash")].join("\n"),
    );
    expect(out.map((s) => s.name)).toEqual(["ok"]);
  });

  it("tolera campos ausentes/não-numéricos com defaults sãos", () => {
    const [s] = parseSessionList(line("x", "", "", "", "", ""));
    expect(s).toMatchObject({ name: "x", windows: 1, createdAt: 0, attached: false, path: "", command: "" });
  });

  it("devolve [] quando não há servidor tmux (stdout vazio)", () => {
    expect(parseSessionList("")).toEqual([]);
  });

  it("preserva path com espaços — o separador é 0x1f, não espaço", () => {
    const [s] = parseSessionList(line("x", "1", "10", "0", "/root/my dir/sub", "bash"));
    expect(s.path).toBe("/root/my dir/sub");
  });
});

describe("o separador precisa SOBREVIVER ao tmux (regressão do 0x1f)", () => {
  // O bug: pedimos 0x1f como separador e o tmux devolveu os quatro caracteres literais `\037`
  // (ele reescreve não-imprimíveis como escape octal, em TEXTO). O split nunca casava, então todo
  // o registro caía em `name` — path/command vinham vazios e `attached` era sempre false.
  // Estes testes falham se alguém "melhorar" o separador de volta para um byte de controle.
  it("não usa byte de controle que o tmux reescreveria (TAB é a exceção que passa)", () => {
    expect(SEP).toBe("\t");
    expect(LIST_FORMAT).not.toMatch(/[\x00-\x08\x0b-\x1f]/);
  });

  it("parseia a saída REAL do tmux 3.4 (capturada na VPS)", () => {
    // $ tmux list-sessions -F "#{session_name}<TAB>#{session_windows}<TAB>…"
    const real =
      "claude-jonatas\t1\t1784666990\t1\t/root/meu-monorepo\tclaude\n" +
      "shell\t1\t1784666192\t0\t/root/meu-monorepo\tbash\n";
    const out = parseSessionList(real);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      name: "claude-jonatas",
      windows: 1,
      attached: true,
      path: "/root/meu-monorepo",
      command: "claude",
    });
    expect(out[1]).toMatchObject({ name: "shell", attached: false, command: "bash" });
  });

  it("a saída ESCAPADA (o sintoma do bug) não vira uma sessão plausível", () => {
    // Se o separador voltar a ser reescrito, é ISTO que chega — e o parser não pode fingir
    // que entendeu: sobra um registro só, com o lixo todo dentro do nome.
    const escaped = "claude-jonatas\\0371\\037/root/meu-monorepo\n";
    const [only] = parseSessionList(escaped);
    expect(only.name).toContain("\\037");
    expect(only.path).toBe("");
  });
});
