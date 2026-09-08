import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  SKILL_NAME_RE,
  skillMdPath,
  assistantPromptPath,
  buildAssistedEditPrompt,
  buildStyleGuideAssistPrompt,
  stripAgentPreamble,
} from "./assisted-edit";

describe("skillMdPath — guard de path", () => {
  it("resolve um SKILL.md válido dentro de .claude/skills/", () => {
    const p = skillMdPath("harness-enrich");
    expect(p).not.toBeNull();
    // Normaliza separadores para a asserção ser cross-platform.
    const norm = p!.split(path.sep).join("/");
    expect(norm.endsWith(".claude/skills/harness-enrich/SKILL.md")).toBe(true);
  });

  it("aceita os nomes canônicos de skill", () => {
    for (const s of ["harness-do", "harness-plan", "harness-sync-card", "harness-qa"]) {
      expect(skillMdPath(s)).not.toBeNull();
      expect(SKILL_NAME_RE.test(s)).toBe(true);
    }
  });

  it("rejeita traversal e nomes fora do padrão (retorna null)", () => {
    for (const bad of [
      "../../etc/passwd",
      "harness-../../../secret",
      "harness-do/../../../../etc/passwd",
      "USM-ENRICH", // maiúsculas
      "enrich", // sem prefixo harness-
      "harness-", // vazio depois do prefixo
      "harness-do; rm -rf /", // injeção
      "",
    ]) {
      expect(skillMdPath(bad)).toBeNull();
    }
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
    const prompt = buildAssistedEditPrompt({ ...base, kind: "canvas", mode: "editar" });
    expect(prompt).toContain("VOCÊ É O ASSISTENTE DO LEAN CANVAS."); // persona passada (não mais hardcoded)
    expect(prompt).toContain("valor atual do bloco");
    expect(prompt).toContain("deixe mais mensurável");
    expect(prompt).toContain("APENAS o novo conteúdo");
    expect(prompt).toContain("A PRIMEIRA palavra da sua resposta já é a primeira palavra do valor"); // contrato anti-preâmbulo reforçado
    expect(prompt).toContain("rolê"); // marketing → nota de voz de marca
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

  it("omite a nota de marca em kinds não-marketing (skill)", () => {
    const prompt = buildAssistedEditPrompt({ ...base, kind: "skill", mode: "editar", label: "harness-x / SKILL.md" });
    expect(prompt).not.toContain("rolê");
  });

  it("injeta o guia de estilo COESO em todos os kinds de painel/canvas (canvas, idea, persona, system)", () => {
    for (const kind of ["canvas", "idea", "persona", "system"] as const) {
      const prompt = buildAssistedEditPrompt({ ...base, kind, mode: "editar" });
      expect(prompt).toContain("Boas práticas de escrita (estilo coeso de todo o board)");
      expect(prompt).toContain("linguagem de quem vai LER o artefato");
    }
  });

  it("NÃO injeta o guia de estilo no editor de skill (SKILL.md tem contrato estrutural próprio)", () => {
    const prompt = buildAssistedEditPrompt({ ...base, kind: "skill", mode: "editar", label: "harness-x / SKILL.md" });
    expect(prompt).not.toContain("Boas práticas de escrita (estilo coeso de todo o board)");
  });

  it("persona: injeta a persona do assistente + contrato de valor cru, sem nota de marca", () => {
    const prompt = buildAssistedEditPrompt({
      systemPrompt: "VOCÊ É O ARQUITETO DE PERSONAS.",
      label: "Bruno, PM interno",
      current: "Você é o Bruno…",
      instruction: "deixe mais específico sobre o gatilho de compra",
      kind: "persona",
      mode: "editar",
    });
    expect(prompt).toContain("VOCÊ É O ARQUITETO DE PERSONAS.");
    expect(prompt).toContain("APENAS o novo conteúdo");
    expect(prompt).not.toContain("rolê"); // persona não é marketing → sem nota de marca
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
    expect(prompt).not.toContain("rolê"); // system não é marketing
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
    const v = "PMs internos não conseguem provar uma hipótese de produto sem fila de eng.";
    expect(stripAgentPreamble(v)).toBe(v);
  });

  it("NÃO remove a 1ª linha se NÃO houver linha em branco depois (não come o corpo)", () => {
    // Sem a assinatura "preâmbulo + linha em branco", a 1ª linha é conteúdo legítimo.
    const v = "Problema:\nO time não consegue validar.\nA fila mata o timing.";
    expect(stripAgentPreamble(v)).toBe(v);
  });

  it("NÃO confunde um valor multilinha que começa com frase normal", () => {
    const v = "Bruno valida MVPs sem fila de eng.\n\nMarina constrói à noite virando founder.";
    expect(stripAgentPreamble(v)).toBe(v);
  });

  it("apara espaços nas bordas", () => {
    expect(stripAgentPreamble("  \n Valor real \n ")).toBe("Valor real");
  });
});

describe("buildStyleGuideAssistPrompt — modos estruturados (editar/sincronizar) do assistente de estilo", () => {
  const sections = [
    { key: "color", label: "Cor", hint: "papéis semânticos com par de contraste" },
    { key: "voice", label: "Voz", hint: "léxico de UI" },
  ];

  it("editar: injeta persona, catálogo de seções, guia atual, pedido e contrato JSON — sem instrução de investigar código", () => {
    const prompt = buildStyleGuideAssistPrompt({
      systemPrompt: "VOCÊ É O DIRETOR DE DESIGN.",
      mode: "editar",
      current: "Guia v3...",
      sections,
      instruction: "escurece o muted",
    });
    expect(prompt).toContain("VOCÊ É O DIRETOR DE DESIGN.");
    expect(prompt).toContain("`color` (Cor): papéis semânticos com par de contraste");
    expect(prompt).toContain("`voice` (Voz): léxico de UI");
    expect(prompt).toContain("Guia v3...");
    expect(prompt).toContain("escurece o muted");
    expect(prompt).toContain("UM único objeto JSON");
    expect(prompt).not.toContain("INVESTIGAR o código");
  });

  it("sincronizar: manda investigar o código real, preservar seções não reveladas, e não modificar arquivos", () => {
    const prompt = buildStyleGuideAssistPrompt({
      systemPrompt: "VOCÊ É O DIRETOR DE DESIGN.",
      mode: "sincronizar",
      current: "",
      sections,
      instruction: "",
      context: "Pacote do produto: packages/acme.",
    });
    expect(prompt).toContain("SINCRONIZAR");
    expect(prompt).toContain("Use suas ferramentas de");
    expect(prompt).toContain("NÃO MODIFIQUE");
    expect(prompt).toContain("Pacote do produto: packages/acme.");
    expect(prompt).toContain("nenhum guia publicado ainda");
  });

  it("exige TODAS as seções na resposta — uma seção omitida vira vazia, não preservada", () => {
    const prompt = buildStyleGuideAssistPrompt({
      systemPrompt: "p",
      mode: "editar",
      current: "guia",
      sections,
      instruction: "x",
    });
    expect(prompt).toContain("reenvie TODAS as seções");
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
