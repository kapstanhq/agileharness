// O SINAL DE BOOT — "o motor terminou de armar", legível de fora do bundle do Next.
//
// ── O buraco que isto fecha ────────────────────────────────────────────────────────────────────
// `instrumentation.ts` NÃO é totalmente aguardado por `next.prepare()`. Medido no primeiro boot do
// servidor próprio (2026-07-27), o log saiu nesta ordem:
//     [auth] …            ← passo 0 do register()
//     [ah-server] escutando…
//     [harness-boot] MOTOR …  ← ainda dentro do register()
// Ou seja: o servidor começa a aceitar conexões com o `register()` correndo. Nessa janela não
// existem ainda `service.lock`, recuperação de runs, merge train, fila de publicação nem watcher —
// e nada disso aparecia em lugar nenhum. Uma janela invisível é indistinguível de janela nenhuma.
//
// ── Por que SINALIZAR e não BLOQUEAR ───────────────────────────────────────────────────────────
// A tentação é segurar o `listen` até o motor armar. Seria trocar um problema pequeno por um maior:
// a recuperação faz subprocessos git e pode respawnar runs — numa caixa carregada isso leva dezenas
// de segundos, e o board ficaria com "connection refused" o tempo todo. Pior ainda quando algo trava:
// um serviço que nunca escuta é um serviço em que nem dá para entrar para diagnosticar.
//
// O que REALMENTE precisava de ordem — os segredos que o portão fail-closed exige — já é garantido
// de outro jeito: `src/server/main.ts` chama `ensureAuthSecrets()` de forma síncrona ANTES do
// `prepare()`. O resto não corrompe nada por chegar cedo; só precisava deixar de ser invisível.
//
// ── Por que `globalThis` ───────────────────────────────────────────────────────────────────────
// Os dois lados vivem em GRAFOS DE MÓDULO diferentes no mesmo processo: `instrumentation.ts` é
// empacotado pelo webpack do Next, `src/server/main.ts` pelo `bun build`. Um `import` compartilhado
// daria DUAS cópias do módulo e dois estados. `Symbol.for` é o único registro que ambos enxergam.

const KEY = Symbol.for("agileharness.engineBoot");

interface BootState {
  /** epoch ms em que o processo começou a armar (primeiro toque neste módulo). */
  startedAt: number;
  /** epoch ms em que o `register()` terminou — null enquanto corre. */
  bootedAt: number | null;
  /** quem espera pelo fim do boot. */
  waiters: Array<() => void>;
}

function state(): BootState {
  const g = globalThis as unknown as Record<symbol, BootState | undefined>;
  const existing = g[KEY];
  if (existing) return existing;
  const fresh: BootState = { startedAt: Date.now(), bootedAt: null, waiters: [] };
  g[KEY] = fresh;
  return fresh;
}

/**
 * Declara que o boot do motor acabou. Chamado por `instrumentation.ts` num `finally`, para valer
 * TAMBÉM quando o motor sai cedo por estar inerte (worktree) ou quando o boot lança — um sinal que
 * só dispara no caminho feliz mente exatamente quando mais importa.
 *
 * Idempotente: a primeira chamada fixa o instante; as demais são no-op.
 */
export function markEngineBooted(): void {
  const s = state();
  if (s.bootedAt !== null) return;
  s.bootedAt = Date.now();
  const pending = s.waiters.splice(0);
  for (const resolve of pending) resolve();
}

/**
 * O boot do motor já terminou? — e note que isto NÃO é "o motor está armado". O sinal é posto num
 * `finally` (ver acima), então ele vale igualmente para o motor que armou e para o que saiu cedo por
 * estar inerte. Quem quer saber sobre armar pergunta a `engineArmedDecision`.
 */
export function engineBooted(): boolean {
  return state().bootedAt !== null;
}

/** Quanto durou o boot (ms), ou null se ainda corre. */
export function engineBootDurationMs(): number | null {
  const s = state();
  return s.bootedAt === null ? null : s.bootedAt - s.startedAt;
}

/**
 * Resolve quando o boot terminar. `timeoutMs` devolve `false` em vez de esperar para sempre — quem
 * observa um boot travado precisa poder DIZER isso, não ficar pendurado junto.
 */
export function whenEngineBooted(timeoutMs: number): Promise<boolean> {
  const s = state();
  if (s.bootedAt !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    s.waiters.push(() => finish(true));
    const timer = setTimeout(() => finish(false), timeoutMs);
    // Nunca segurar o event loop por causa de um observador.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

/** SÓ PARA TESTE: esquece o estado global entre casos. */
export function __resetBootSignalForTest(): void {
  const g = globalThis as unknown as Record<symbol, BootState | undefined>;
  g[KEY] = undefined;
}
