import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assistantPromptPath,
  assistedEditRunOptions,
  SINCRONIZAR_ALLOWED_TOOLS,
  SINCRONIZAR_DENIED_TOOLS,
  buildAssistedEditPrompt,
  stripAgentPreamble,
} from "./assisted-edit";

/** A voz que um board declararia no Guia de Estilo dele (`brandVoiceNote`). */
const VOZ = 'Voz de marca do board: NUNCA use "jargão".';

// quick-fix skill-writes: o gravador de SKILL.md (e o guard de path dele, `skillMdPath`) saiu junto com a tela que o
// usava — a garantia que sobra é a AUSÊNCIA: nada da bancada grava em disco, e o `sincronizar` roda só leitura.
describe("bancada — nada grava skill/prompt; sincronizar é só leitura", () => {
  it("as server actions da bancada não escrevem arquivo nenhum (o checkout de runtime é compartilhado)", () => {
    const src = readFileSync(path.join(__dirname, "../../app/assisted-edit-actions.ts"), "utf8");
    expect(src).not.toMatch(/\b(writeFile|appendFile|mkdir|rename|rm|unlink)\s*\(/);
    expect(src).not.toMatch(/dangerouslySkipPermissions/);
    expect(src).not.toMatch(/export async function (write|read)(Skill|AssistantPrompt)Action/);
  });

  it("sincronizar: sem skip-permissions, com as tools de escrita NEGADAS; os outros modos sem opção extra", () => {
    const sync = assistedEditRunOptions("sincronizar");
    expect(sync).not.toHaveProperty("dangerouslySkipPermissions");
    expect(sync.disallowedTools).toEqual(SINCRONIZAR_DENIED_TOOLS);
    // modo default explícito (não plan: em -p o plan devolve um plano, não o valor) + só leitura pré-aprovada
    expect(sync.permissionMode).toBe("default");
    expect(sync.allowedTools).toEqual(["Read", "Grep", "Glob"]);
    expect(SINCRONIZAR_ALLOWED_TOOLS).toEqual(["Read", "Grep", "Glob"]);
    for (const t of ["Edit", "Write", "NotebookEdit", "Bash"]) expect(SINCRONIZAR_DENIED_TOOLS).toContain(t);
    for (const t of ["Read", "Grep", "Glob"]) expect(SINCRONIZAR_DENIED_TOOLS).not.toContain(t);
    expect(assistedEditRunOptions("editar")).toEqual({});
    expect(assistedEditRunOptions("aprender")).toEqual({});
  });
});

describe("buildAssistedEditPrompt — persona (systemPrompt) + modo", () => {
  // O `desired-outcome` saiu (virou seção do PRD). O canvas ocupa o lugar dele nestes testes por ser
  // o kind que restou com as MESMAS duas propriedades medidas aqui: é de marketing (recebe a nota de
  // voz de marca) e é de painel (recebe o guia de estilo coeso).
  const base = {
    systemPrompt: "VOCÊ É O ASSISTENTE DO LEAN CANVAS.",
    label: "Lean Canvas",
    current: "valor atual do bloco",
    instruction: "deixe mais mensurável",
  };

  it("editar: injeta persona, valor, pedido, contrato de saída crua + nota de marca p/ marketing", () => {
    const prompt = buildAssistedEditPrompt({ ...base, kind: "canvas", mode: "editar", brandVoice: VOZ });
    expect(prompt).toContain("VOCÊ É O ASSISTENTE DO LEAN CANVAS."); // persona passada (não mais hardcoded)
    expect(prompt).toContain("valor atual do bloco");
    expect(prompt).toContain("deixe mais mensurável");
    expect(prompt).toContain("APENAS o novo conteúdo");
    expect(prompt).toContain("A PRIMEIRA palavra da sua resposta já é a primeira palavra do valor"); // contrato anti-preâmbulo reforçado
    expect(prompt).toContain(VOZ); // marketing → a voz de marca que o BOARD declarou
  });

  it("sem voz declarada pelo board, o prompt de marketing não impõe voz nenhuma (a ferramenta não tem marca própria)", () => {
    const prompt = buildAssistedEditPrompt({ ...base, kind: "canvas", mode: "editar" });
    expect(prompt).not.toMatch(/voz de marca/i);
  });

  it("aprender: pede PROSA explicativa (ENTENDER), NÃO o contrato de valor cru", () => {
    const prompt = buildAssistedEditPrompt({ ...base, kind: "canvas", mode: "aprender" });
    expect(prompt).toContain("ENTENDER");
    expect(prompt).toContain("PROSA");
    expect(prompt).not.toContain("APENAS o novo conteúdo");
  });

  it("sincronizar: manda investigar o código real, não modificar, e devolver só o valor", () => {
    const prompt = buildAssistedEditPrompt({ ...base, kind: "canvas", mode: "sincronizar" });
    expect(prompt).toContain("SINCRONIZAR");
    expect(prompt).toContain("INVESTIGAR o código");
    expect(prompt).toContain("NÃO MODIFIQUE");
    expect(prompt).toContain("APENAS o novo conteúdo");
  });

  it("omite a nota de marca em kinds não-marketing (system)", () => {
    const prompt = buildAssistedEditPrompt({ ...base, kind: "system", mode: "editar", label: "Sistema · API", brandVoice: VOZ });
    expect(prompt).not.toContain(VOZ);
  });

  it("injeta o guia de estilo COESO em todos os kinds de painel/canvas (canvas, idea, persona, system)", () => {
    for (const kind of ["canvas", "idea", "persona", "system"] as const) {
      const prompt = buildAssistedEditPrompt({ ...base, kind, mode: "editar" });
      expect(prompt).toContain("Boas práticas de escrita (estilo coeso de todo o board)");
      expect(prompt).toContain("linguagem de quem vai LER o artefato");
    }
  });

  it("NÃO injeta o guia de estilo fora dos kinds de painel (generic)", () => {
    const prompt = buildAssistedEditPrompt({ ...base, kind: "generic", mode: "editar", label: "Texto solto" });
    expect(prompt).not.toContain("Boas práticas de escrita (estilo coeso de todo o board)");
  });

  it("persona: injeta a persona do assistente + contrato de valor cru, sem nota de marca", () => {
    const prompt = buildAssistedEditPrompt({
      systemPrompt: "VOCÊ É O ARQUITETO DE PERSONAS.",
      label: "Dora, gerente de oficina",
      current: "Você é a Dora…",
      instruction: "deixe mais específico sobre o gatilho de compra",
      kind: "persona",
      mode: "editar",
    });
    expect(prompt).toContain("VOCÊ É O ARQUITETO DE PERSONAS.");
    expect(prompt).toContain("APENAS o novo conteúdo");
    expect(prompt).not.toMatch(/voz de marca/i); // persona não é marketing → sem nota de marca
  });

  it("system + sincronizar: manda investigar o código e devolver só o valor, sem nota de marca", () => {
    const prompt = buildAssistedEditPrompt({
      systemPrompt: "VOCÊ É O ARQUITETO DE SISTEMAS.",
      label: "Runner Engine",
      current: "",
      instruction: "",
      kind: "system",
      mode: "sincronizar",
    });
    expect(prompt).toContain("VOCÊ É O ARQUITETO DE SISTEMAS.");
    expect(prompt).toContain("INVESTIGAR o código");
    expect(prompt).toContain("APENAS o novo conteúdo");
    expect(prompt).not.toMatch(/voz de marca/i); // system não é marketing
  });

  it("trata valor atual vazio como 'proponha do zero'", () => {
    const prompt = buildAssistedEditPrompt({ ...base, kind: "canvas", mode: "editar", current: "" });
    expect(prompt).toContain("proponha do zero");
  });
});

describe("stripAgentPreamble — devolve só o valor final (rede de segurança do contrato)", () => {
  it("desembrulha uma cerca ``` que envolve a resposta inteira", () => {
    expect(stripAgentPreamble("```\nMeu valor real\n```")).toBe("Meu valor real");
    expect(stripAgentPreamble("```md\nMeu valor real\n```")).toBe("Meu valor real");
  });

  it("remove um preâmbulo conversacional seguido de linha em branco", () => {
    expect(stripAgentPreamble("Aqui está a proposta:\n\nValor real do bloco.")).toBe("Valor real do bloco.");
    expect(stripAgentPreamble("Claro! Segue:\n\nValor real do bloco.")).toBe("Valor real do bloco.");
    expect(stripAgentPreamble("Proposta:\n\nValor real do bloco.")).toBe("Valor real do bloco.");
  });

  it("desembrulha a cerca E remove o preâmbulo, se ambos presentes", () => {
    expect(stripAgentPreamble("```\nAqui está:\n\nValor real.\n```")).toBe("Valor real.");
  });

  it("NÃO mexe quando não há preâmbulo (preserva o corpo intacto)", () => {
    const v = "Gerentes de oficina não conseguem agendar um reparo urgente sem ligar para o balcão.";
    expect(stripAgentPreamble(v)).toBe(v);
  });

  it("NÃO remove a 1ª linha se NÃO houver linha em branco depois (não come o corpo)", () => {
    // Sem a assinatura "preâmbulo + linha em branco", a 1ª linha é conteúdo legítimo.
    const v = "Problema:\nO balcão não consegue confirmar a vaga.\nA ligação ocupa a linha.";
    expect(stripAgentPreamble(v)).toBe(v);
  });

  it("NÃO confunde um valor multilinha que começa com frase normal", () => {
    const v = "Dora agenda reparos pelo celular.\n\nOtávio confere as peças no fim do expediente.";
    expect(stripAgentPreamble(v)).toBe(v);
  });

  it("apara espaços nas bordas", () => {
    expect(stripAgentPreamble("  \n Valor real \n ")).toBe("Valor real");
  });
});

describe("assistantPromptPath — guard de path do override de assistente", () => {
  it("resolve um override válido dentro de .claude/storymap-assistants/", () => {
    const p = assistantPromptPath("lean-canvas");
    expect(p).not.toBeNull();
    const norm = p!.split(path.sep).join("/");
    expect(norm.endsWith(".claude/storymap-assistants/lean-canvas.md")).toBe(true);
  });

  it("rejeita traversal e ids fora do padrão (retorna null)", () => {
    for (const bad of ["../../etc/passwd", "lean/../../x", "Lean-Canvas", "north_star", "a b", "", ".hidden"]) {
      expect(assistantPromptPath(bad)).toBeNull();
    }
  });
});
