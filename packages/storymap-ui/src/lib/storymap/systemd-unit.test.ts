import { describe, it, expect } from "vitest";

import { HOST_TOOL_ENV } from "./runner/host-tools";
import { renderSystemdUnit, resolveWorkingDir, type UnitFacts } from "./systemd-unit";

// O gerador é PURO sobre os fatos. Ver o cabeçalho de systemd-unit.ts para o porquê de gerar em vez
// de enviar um template com lacunas.

const FATOS: UnitFacts = {
  repoRoot: "/srv/app",
  workingDir: "/srv/app/packages/storymap-ui",
  user: "agileharness",
  host: "127.0.0.1",
  port: 3008,
  nodePath: "/usr/bin/node",
  tools: {
    bun: { ok: true, path: "/usr/local/bin/bun", via: "PATH" },
    just: { ok: true, path: "/usr/local/bin/just", via: "PATH" },
    claude: { ok: true, path: "/home/ah/.local/bin/claude", via: "declarado" },
  },
  unitName: "agileharness",
};

const render = (over: Partial<UnitFacts> = {}) => renderSystemdUnit({ ...FATOS, ...over });

describe("renderSystemdUnit — o que o unit PRECISA carregar", () => {
  it("[O CONSERTO DO INCIDENTE] fixa o ENDEREÇO ABSOLUTO de cada ferramenta do host", () => {
    // Isto, e não a linha PATH, é o que impede 2026-08-20 de voltar. Um unit que só tem PATH
    // depende de o binário continuar onde estava — foi essa aposta que quebrou.
    const r = render();
    expect(r.ok).toBe(true);
    const u = r.ok ? r.unit : "";
    expect(u).toContain(`Environment=${HOST_TOOL_ENV.claude}=/home/ah/.local/bin/claude`);
    expect(u).toContain(`Environment=${HOST_TOOL_ENV.bun}=/usr/local/bin/bun`);
    expect(u).toContain(`Environment=${HOST_TOOL_ENV.just}=/usr/local/bin/just`);
  });

  it("o PATH derivado inclui o diretório do claude — cinto E suspensório", () => {
    const r = render();
    expect(r.ok && r.unit).toContain("/home/ah/.local/bin");
  });

  it("[PRECEDÊNCIA] EnvironmentFile aparece SOMENTE comentado", () => {
    // Ligado, o mesmo segredo chegaria por dois caminhos com precedências opostas.
    const u = render().ok ? (render() as { unit: string }).unit : "";
    for (const linha of u.split("\n")) {
      if (linha.includes("EnvironmentFile=")) expect(linha.trimStart().startsWith("#")).toBe(true);
    }
    expect(u).toContain("EnvironmentFile=");
  });

  it("[ENDURECIMENTO] as diretivas que quebram o produto saem comentadas, com o motivo", () => {
    const u = render().ok ? (render() as { unit: string }).unit : "";
    for (const d of ["ProtectSystem=strict", "NoNewPrivileges=yes"]) {
      const linha = u.split("\n").find((l) => l.includes(d));
      expect(linha, `${d} deveria aparecer no bloco comentado`).toBeTruthy();
      expect(linha!.trimStart().startsWith("#")).toBe(true);
    }
    expect(u).toContain("bubblewrap");
  });

  it("[SEM CAMINHO DO AUTOR] nenhum caminho literal vem do template — todos vêm dos fatos", () => {
    // O template não pode conter o endereço de ninguém. A saída legitimamente tem caminhos: os que
    // FORAM MEDIDOS. A prova é que trocar os fatos troca a saída inteira.
    const outro = render({
      repoRoot: "/opt/x",
      workingDir: "/opt/x",
      nodePath: "/opt/node/bin/node",
      user: "ninguem",
      tools: {
        bun: { ok: true, path: "/opt/b/bun", via: "PATH" },
        just: { ok: true, path: "/opt/b/just", via: "PATH" },
        claude: { ok: true, path: "/opt/b/claude", via: "PATH" },
      },
    });
    const u = outro.ok ? outro.unit : "";
    expect(u).not.toContain("/srv/app");
    expect(u).not.toContain("/home/ah");
    expect(u).not.toContain("/usr/local/bin/bun");
    expect(u).toContain("/opt/b/claude");
  });

  it("o bloco de instalação NÃO instala — ele mostra o que rodar", () => {
    const r = render();
    expect(r.ok && r.install).toContain("sudo tee /etc/systemd/system/agileharness.service");
    expect(r.ok && r.install).toContain("systemctl enable --now");
    expect(r.ok && r.install).toContain("contrib/tmpfiles-agileharness.conf");
  });
});

describe("[FAIL-CLOSED] o gerador RECUSA em vez de fixar um caminho que não existe", () => {
  it("uma ferramenta que não resolve aborta a geração, nomeando a variável", () => {
    // Um unit apontando para um binário ausente PARECE configuração e se comporta como bug — é o
    // incidente de chapéu novo.
    const r = render({
      tools: {
        bun: { ok: true, path: "/usr/local/bin/bun", via: "PATH" },
        just: { ok: true, path: "/usr/local/bin/just", via: "PATH" },
        claude: { ok: false, refusal: "`claude` não foi encontrado no PATH — declare AGILEHARNESS_CLAUDE" },
      },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.refusal).toContain("AGILEHARNESS_CLAUDE");
    expect(!r.ok && r.refusal).toContain("claude");
  });
});

describe("resolveWorkingDir — os dois layouts, medidos", () => {
  it("monorepo: aponta para o pacote", () => {
    expect(resolveWorkingDir("/srv/app", (p) => p === "/srv/app/packages/storymap-ui/package.json")).toBe(
      "/srv/app/packages/storymap-ui",
    );
  });

  it("layout PLANO: aponta para a própria raiz", () => {
    // `flat-repo-layout.test.ts` prova que a árvore do adotante pode não ter `packages/`.
    expect(resolveWorkingDir("/srv/app", () => false)).toBe("/srv/app");
  });
});
