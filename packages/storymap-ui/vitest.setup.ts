// TEST ISOLATION of the runner state dir. Loaded by vitest `setupFiles` — uma vez POR ARQUIVO DE PROVA
// (não por worker: o worker é reaproveitado entre arquivos), BEFORE any suite runs.
//
// The runner's durable state (run journal, orchestrator budget/lease, the agent-action audit ledger and the
// copiloto activity journal) lives in `storymap/.runner/` — the SAME directory the live systemd service reads
// and writes. Any suite that exercised a module touching it wrote into production state: `guard.test.ts`
// fixtures (board "acme", card "c1") ended up in the real activity journal, so the operator's audit trail
// carried invented "acted move_card" / "refused deploy" entries. An audit ledger that tests can write to is
// not an audit ledger.
//
// Redirecting the dir at the SOURCE (paths.runnerStateDir reads this env per call) kills the whole class:
// no suite can reach production state, whether or not it remembered to mock the right module. UNCONDITIONAL
// on purpose — honouring an inherited value would re-open the footgun for anyone who exported the real path
// while debugging the service.
//
// ⚠ E O QUE CRIA, REMOVE. `setupFiles` roda uma vez POR ARQUIVO DE PROVA, então cada `mkdtempSync` sem
// par deixava um diretório em `/tmp` para sempre: medidos 317.968 `storymap-runner-state-*` acumulados
// neste host, o suficiente para tornar `ls /tmp` inutilizável (e para fazer um glob de shell estourar
// "Argument list too long", que foi como o vazamento passou despercebido — o `ls -d` do diagnóstico
// devolvia ZERO justamente porque havia demais). O teardown abaixo fecha o par.
import { afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ── O ALVO — mesma classe, mesmo argumento, e agora com um vetor MEDIDO ─────────────────────────
//
// `findRepoRoot()` (paths.ts) honra `STORYMAP_TARGET`, e o env ATRAVESSA para o worker do vitest —
// medido em 2026-08-27: com `STORYMAP_TARGET=<outro repo> bunx vitest run`, `process.env` dentro da
// prova traz o valor. Isso significa que `board-base-pipeline` fotografaria os boards DAQUELE repo,
// e um `vitest -u` gravaria o retrato deles num `.snap` deste.
//
// Já aconteceu, sem env: em 2026-08-19 o golden viajou para o artefato público com 133K e seis
// retratos, quatro deles de boards privados — com o pacote que cada um declara, o domínio de
// produção e os caminhos de brandbook DENTRO — e a suíte estava VERDE. (Os identificadores não são
// citados aqui de propósito: este arquivo VIAJA, e a guarda de higiene de identidade reprova quem os
// nomeia — ela reprovou este comentário na primeira escrita dele.) Na época a extração era a rede que
// aparava isso. Com o repositório da ferramenta virando a fonte, essa rede deixa de existir: o
// commit vai direto para o repositório público.
//
// INCONDICIONAL, e sem escotilha de env de propósito — a mesma postura do diretório de estado logo
// abaixo. Uma variável de escape («deixe passar quando eu declarar que sei o que faço») seria
// exatamente o footgun que ela deveria fechar: quem exportou o alvo real para depurar o serviço é
// justamente quem não lembra de tirá-lo. As provas que PRECISAM de um alvo o declaram em CÓDIGO,
// com save/restore (flat-repo-layout, product-deploy, target-secret-fence e outras já fazem assim),
// e continuam funcionando: o `setupFiles` roda ANTES do módulo de prova.
delete process.env.STORYMAP_TARGET;

const PREFIXO = "storymap-runner-state-";
// O caminho é capturado AQUI e é ele que o teardown remove — nunca o valor do env na hora da limpeza.
// Não é preciosismo: várias provas (agent-actions, token-bootstrap, prefs-store, split-integration…)
// reapontam `STORYMAP_RUNNER_STATE_DIR` para temporários próprios, e uma que não restaurasse o valor
// faria a limpeza apagar o diretório DE OUTREM. O setup só responde pelo que o setup criou.
const MEU_DIRETORIO = mkdtempSync(path.join(tmpdir(), PREFIXO));
process.env.STORYMAP_RUNNER_STATE_DIR = MEU_DIRETORIO;

// BEST-EFFORT, e literalmente: esta limpeza NUNCA pode reprovar uma prova. Um `rmSync` que lançasse
// dentro do `afterAll` viraria falha de suíte — e uma suíte vermelha aqui reprova todo merge-back
// (o gate é fail-closed). Por isso o corpo inteiro é engolido: no pior caso o diretório fica, e a
// varredura periódica (`find /tmp -maxdepth 1 -name 'storymap-runner-state-*' -mmin +60`) o pega.
afterAll(() => {
  try {
    // As duas guardas que delimitam "o que o próprio setup criou": o nome tem o prefixo que ELE
    // escolheu, e o pai é o temp do sistema. Sem elas, um caminho adulterado viraria um rm arbitrário.
    if (path.basename(MEU_DIRETORIO).startsWith(PREFIXO) && path.dirname(MEU_DIRETORIO) === path.resolve(tmpdir())) {
      rmSync(MEU_DIRETORIO, { recursive: true, force: true });
    }
  } catch {
    /* nada a fazer: limpar é higiene, não asserção */
  }
});

// HEADROOM DESLIGADO na suíte, pelo MESMO princípio (2026-07-28). Desde que o roteamento pelo proxy
// passou a ser LIGADO POR DEFAULT (runner/headroom.ts), qualquer spawn exercitado em teste resolveria
// uma URL e SONDARIA o proxy do host — o resultado (e o tempo: até 250ms de timeout) passaria a
// depender de o `headroom-proxy.service` estar de pé na máquina que roda a suíte. Um teste unitário
// não pode ter opinião sobre isso. Usa o kill switch documentado, não um guard de "estou em teste"
// dentro do código de produção; quem quer provar o default o remove localmente (autorun-eval.test.ts).
process.env.STORYMAP_HEADROOM_URL = "off";

// O BINÁRIO DO CLAUDE, DECLARADO NA SUÍTE — mesmo princípio da linha acima (2026-08-26).
//
// Desde que `runner/claude-bin.ts` passou a resolver o CLI pela régua das ferramentas do host, o
// código de PRODUÇÃO que os testes exercitam RECUSA quando ele não resolve — e recusar é o
// comportamento certo: era um `spawn claude ENOENT` mudo que escondeu uma pane de seis dias.
//
// Só que os testes que passam por ali INJETAM o spawn (`spawnProcess`/`doSpawn`): para eles a
// IDENTIDADE do binário é irrelevante, porque medem argumentos, env e contabilidade, nunca o
// processo. Sem isto a suíte passa a exigir o Claude Code instalado na máquina que a roda — e o
// `ci.yml` que este repositório PUBLICA instala `bubblewrap` e `socat`, não o CLI. MEDIDO: 35 testes
// verdes aqui reprovaram lá, exatamente por isso.
//
// ⚠️ O ARQUIVO PRECISA SE CHAMAR `claude`, e isso não é estética. `recorteDaInvocacao`
// (runner/autonomy-sandbox.ts) acha o início da invocação procurando o ÚLTIMO token cujo basename
// casa /(^|\/)claude(\.exe|\.cmd)?$/ — é assim que o portão de contenção separa o comando do
// agente do embrulho do `systemd-run`. Um fixture apontando para `process.execPath` não casa, o
// corte sai errado e 12 testes do governor reprovam com "CONTENÇÃO PROMETIDA E AUSENTE DO COMANDO".
// Medido nesta sessão. O fixture tem a forma de produção porque o produto depende dessa forma.
const dirDoFixture = mkdtempSync(path.join(tmpdir(), "ah-claude-bin-"));
const claudeDeMentira = path.join(dirDoFixture, "claude");
writeFileSync(claudeDeMentira, "", { mode: 0o755 });
// `||=` para não calar quem estiver medindo a resolução de propósito.
process.env.AGILEHARNESS_CLAUDE ||= claudeDeMentira;
