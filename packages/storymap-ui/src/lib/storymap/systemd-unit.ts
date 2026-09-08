// O UNIT DO SYSTEMD, GERADO PARA ESTA MÁQUINA — e não um template para o adotante preencher.
//
// POR QUE ELE EXISTE. O README anuncia que a ferramenta "roda como serviço numa VPS e continua com o
// notebook fechado". Medido em 2026-08-26: NENHUM unit viaja para o artefato publicado, não existe
// config de proxy nenhuma no repositório, e a palavra `systemd` aparece ZERO vezes nos quatro
// documentos de raiz. Quem quisesse a topologia anunciada escrevia tudo do zero, adivinhando.
//
// POR QUE GERAR, E NÃO ENVIAR UM TEMPLATE. O valor inteiro deste arquivo é emitir FATOS RESOLVIDOS
// desta caixa: a raiz do repositório, o usuário, a porta, e — o item que importa — o CAMINHO ABSOLUTO
// de cada ferramenta de host. Um template com `<caminho>` para preencher devolve ao adotante
// exatamente a decisão que produziu o incidente de 2026-08-20: o Claude Code migrou para
// `~/.local/bin`, o PATH do unit não o alcançava, e todo spawn virou ENOENT por seis dias. Um unit
// que DECLARA o endereço absoluto é fail-closed — se o caminho sumir, a recusa nomeia a variável.
//
// ELE IMPRIME, NUNCA INSTALA. Escrever em `/etc/systemd/system/` é mais privilegiado que
// `--generate-mcp-token`, que já só imprime e deixa o humano colocar. A fronteira de confirmação é o
// shell de quem lê.

import path from "node:path";

import { HOST_TOOL_ENV, type HostTool, type HostToolResolution } from "./runner/host-tools";

export interface UnitFacts {
  repoRoot: string;
  /** MEDIDO: `packages/storymap-ui` existe ⇒ monorepo; senão a própria raiz (layout plano). */
  workingDir: string;
  user: string;
  host: string;
  port: number;
  /** absoluto — `process.execPath`, não o nome `node`. */
  nodePath: string;
  tools: Record<HostTool, HostToolResolution>;
  unitName: string;
}

export type UnitRender = { ok: true; unit: string; install: string } | { ok: false; refusal: string };

/** Onde o entrypoint mora, medido em vez de presumido — `flat-repo-layout` prova que há as duas formas. */
export function resolveWorkingDir(repoRoot: string, exists: (p: string) => boolean): string {
  const noMonorepo = path.join(repoRoot, "packages", "storymap-ui", "package.json");
  return exists(noMonorepo) ? path.join(repoRoot, "packages", "storymap-ui") : repoRoot;
}

/**
 * O unit, ou a recusa. PURO sobre os fatos — o teste exercita as duas formas de layout e a recusa
 * sem tocar em disco.
 */
export function renderSystemdUnit(f: UnitFacts): UnitRender {
  // RECUSA quando qualquer ferramenta não resolve. Um unit que fixa um caminho inexistente é o
  // incidente de chapéu novo: ele parece configuração e se comporta como bug.
  const naoResolvem = (Object.keys(f.tools) as HostTool[]).filter((t) => !f.tools[t].ok);
  if (naoResolvem.length > 0) {
    const motivos = naoResolvem
      .map((t) => {
        const r = f.tools[t];
        return `  · ${t}: ${r.ok ? "" : r.refusal}`;
      })
      .join("\n");
    return {
      ok: false,
      refusal:
        `não dá para gerar o unit: ${naoResolvem.length} ferramenta(s) do host não resolvem nesta máquina.\n` +
        `${motivos}\n\n` +
        `Um unit que fixasse um caminho inexistente pareceria configuração e se comportaria como bug — ` +
        `é exatamente a forma do incidente que este gerador existe para impedir. Instale o que falta, ` +
        `ou declare o endereço, e gere de novo.`,
    };
  }

  const enderecos = (Object.keys(f.tools) as HostTool[])
    .map((t) => `Environment=${HOST_TOOL_ENV[t]}=${(f.tools[t] as { path: string }).path}`)
    .join("\n");

  // O PATH sai dos dirnames dos endereços ⊕ o piso do sistema. É CONVENIÊNCIA para o que as
  // declarações não cobrem (git, tmux, bwrap) — nunca a garantia.
  const dirs = [
    ...new Set((Object.keys(f.tools) as HostTool[]).map((t) => path.dirname((f.tools[t] as { path: string }).path))),
  ];
  const pathLine = [...dirs, "/usr/local/bin", "/usr/bin", "/bin"].filter((d, i, a) => a.indexOf(d) === i).join(":");

  const unit = `[Unit]
Description=AgileHarness (board + autorun + MCP)
After=network.target

[Service]
Type=simple
User=${f.user}
WorkingDirectory=${f.workingDir}
ExecStart=${f.nodePath} dist/ah-server.mjs

# ── AS FERRAMENTAS DO HOST, POR ENDEREÇO ABSOLUTO ─────────────────────────────────────────────
# ISTO — e não a linha PATH abaixo — é o que impede o incidente de 2026-08-20 de se repetir: o
# Claude Code migrou de /usr/local/bin para ~/.local/bin, o PATH deste unit não o alcançava, e TODO
# spawn do motor virou "spawn claude ENOENT" por seis dias, sem uma linha no journal. Uma declaração
# absoluta é fail-closed: se o caminho sumir, a recusa NOMEIA a variável a corrigir.
${enderecos}

Environment=AGILEHARNESS_HOST=${f.host}
Environment=AGILEHARNESS_PORT=${f.port}
Environment=AGILEHARNESS_SERVICE_UNIT=${f.unitName}.service
Environment=NODE_ENV=production

# CONVENIÊNCIA, não garantia — cobre o que as declarações acima não cobrem (git, tmux, bwrap).
Environment=PATH=${pathLine}

# EnvironmentFile= DELIBERADAMENTE COMENTADO. O token MCP primário chega pelo ".env.local" do pacote,
# que este processo já carrega no topo. Ligar a linha abaixo faria o MESMO segredo chegar por dois
# caminhos com precedências OPOSTAS — o systemd vence, e o carregador de .env não sobrescreve o que já
# está posto. Use um OU o outro, nunca os dois.
# EnvironmentFile=-${f.workingDir}/.env.local

# Sem default, de propósito: sem esta declaração a tool de auto-atualização RECUSA e nada roda como
# root. Escreva o script que ESTA máquina usa e descomente.
# Environment=AGILEHARNESS_UPDATE_SCRIPT=/caminho/para/update.sh

Restart=always
RestartSec=5

# ── ENDURECIMENTO: COMENTADO, COM O MOTIVO MEDIDO ─────────────────────────────────────────────
# Nenhuma destas está ligada, e não é esquecimento:
#   ProtectSystem=strict  quebra as escritas que o PRÓPRIO motor faz no repositório (worktree, commit,
#                         merge train). Um serviço que não consegue escrever no repo não faz nada aqui.
#   NoNewPrivileges=yes   quebra o bubblewrap, que é a contenção por run. Endurecer o serviço
#                         DESLIGANDO a jaula dos agentes é uma troca ruim.
# Ligue-as só depois de medir o que cada uma custa NESTA instalação.

[Install]
WantedBy=multi-user.target
`;

  const install = `sudo tee /etc/systemd/system/${f.unitName}.service > /dev/null <<'UNIT'
${unit}UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now ${f.unitName}
systemctl status ${f.unitName} --no-pager

# Opcional — a limpeza do scratch. É um BACKSTOP, não a garantia: o motor já limpa o
# diretório temporário dele por conta. Só vale onde o temp do sistema é /tmp e há systemd.
# sudo cp ${f.repoRoot}/contrib/tmpfiles-agileharness.conf /etc/tmpfiles.d/
# sudo systemd-tmpfiles --create
`;

  return { ok: true, unit, install };
}
