import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Minimal vitest setup for the dev-only AgileHarness UI. Resolves the `@/` alias the
// same way next/tsconfig does, so unit tests can import from "@/lib/...".
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Boa parte desta suíte NÃO é unitária: `session-worktree`, `split-integration`, `concurrent-work` e
    // vizinhos rodam git DE VERDADE (criam worktrees, drenam a fila de merge, rebasam, re-submetem). O
    // default do vitest é 5s — orçamento de teste unitário —, e o mais pesado deles passa em ~4s ISOLADO.
    // Sob a suíte inteira em paralelo ele encosta no teto e estoura: medido, 1 em 4 rodadas completas
    // (`AC3/G6 — submit conflitante volta à sessão`, "Test timed out in 5000ms"), enquanto o mesmo teste
    // passa 33/33 rodando sozinho. Isso NÃO é um teste frouxo esperando o app: é o relógio da bancada
    // apertado demais para o trabalho declarado.
    //
    // Por que isso é grave o bastante para virar config: o gate de integração é FAIL-CLOSED — uma suíte
    // vermelha reprova TODO merge-back e CONGELA o train inteiro até alguém investigar à mão. Um flake por
    // carga vira, na prática, uma parada do pipeline com causa invisível (o teste passa quando você vai
    // conferir). Um hang de verdade continua falhando, só que em 30s em vez de 5s — nenhuma asserção foi
    // tocada, só o orçamento.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // O default do vitest 4 é `allowOnly: !process.env.CI`. O gate de integração roda a suíte pelo
    // serviço systemd, cujo Environment é só NODE_ENV/PATH/AGILEHARNESS_HOST — SEM `CI`. Logo o default
    // aqui é TRUE, e um `it.only` esquecido faz o train integrar VERDE com teste vermelho pulado.
    //
    // Medido com o par discriminante (2026-08-06), mesmo arquivo, um `it.only` mascarando
    // `expect(1).toBe(2)`:
    //   default            → RC=0, "1 passed | 1 skipped"   ← o vermelho some
    //   --allowOnly=false  → RC=1, "1 failed | 1 skipped"   ← o vermelho aparece
    // Hoje há 0 `.only` no repo: esta é a janela para fechar de graça, antes de morder.
    allowOnly: false,
    // A GÊMEA DO `allowOnly` — e ela pega uma falha mais silenciosa que o `.only` esquecido: um teste
    // que nunca chama `expect()` PASSA, e passa medindo ZERO. Nada no relatório distingue "conferiu e
    // estava certo" de "não conferiu nada".
    //
    // MEDIDO com a própria flag (2026-08-12), não estimado: 6812 blocos `it()`, e os que reprovavam
    // eram 66, em 2 arquivos. O par discriminante, mesmos arquivos: sem a flag `2310 passed` RC=0;
    // com a flag `66 failed | 2244 passed` RC=1.
    //
    // E o achado que muda a leitura: NENHUM dos 66 era teste esquecido. Eram duas famílias de vácuo
    // vivo — um `it` que só faz `console.warn`, e cinco laços que ficam VAZIOS para parte do corpus
    // (o `expect` existe, mas nunca é alcançado para 4 a 13 dos sujeitos). O pior deles era vácuo
    // exatamente nos gates cujo campo NÃO é settable, que é onde o invariante importa. Uma trava que
    // só encontra descuido não teria achado nada disso.
    //
    // Semântica medida no runtime do vitest 4.1.7: o contador sobe só dentro de `expect(...)`;
    // `assert.*` e `expectTypeOf` não contam. Irrelevante aqui — o repo usa um dialeto só (409/409
    // arquivos importam `expect`; zero `expectTypeOf`/`assert.`).
    expect: { requireAssertions: true },
    // Redirects storymap/.runner → a temp dir for EVERY suite, so no test can write into the live service's
    // journal/budget/audit state (see vitest.setup.ts). Guarded by paths.test.ts, which fails if it regresses.
    setupFiles: ["./vitest.setup.ts"],
  },
});
