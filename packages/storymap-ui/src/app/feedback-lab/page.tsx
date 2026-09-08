// A controlled sample "product" surface for exercising the feedback overlay. The overlay itself is
// mounted GLOBALLY in the root layout (dogfood — it runs on the whole AgileHarness UI), so there is
// no per-page loader here. Styled with the app's own design tokens (bg-surface/text-fg/border-line/
// text-accent + Hanken Grotesk) so it matches AgileHarness in light AND dark. Server Component — no
// event handlers (an onSubmit here would 500 at production SSR).
export const dynamic = "force-dynamic";

export default function FeedbackLabPage() {
  return (
    <div className="min-h-screen bg-canvas text-fg">
      <main className="mx-auto max-w-3xl px-6 py-10">
        <header className="pb-6">
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-accent">AgileHarness · Lab</span>
          <h1 className="mt-2 mb-2 text-[28px] font-semibold leading-tight">Feedback visual clicando na interface</h1>
          <p className="max-w-xl text-[15px] text-fg-muted">
            Superfície de demonstração. Ative o botão <b className="text-fg">🎯 Feedback</b> no canto inferior
            esquerdo, clique em qualquer elemento, escreva o ajuste e envie — cada lote vira um card na Triagem
            do board <b className="text-fg">storymap</b>.
          </p>
          <button type="button" className="mt-4 rounded-lg bg-fg px-4 py-2 text-[13px] font-semibold text-surface">
            Começar agora
          </button>
        </header>

        <section className="my-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <article className="rounded-[10px] border border-line bg-surface p-4 shadow-[0_1px_1px_rgba(15,15,15,0.025)]">
            <h3 className="mb-1 text-sm font-semibold">Captura por clique</h3>
            <p className="text-[13px] text-fg-muted">
              O overlay destaca o elemento sob o cursor e captura seu seletor CSS.
            </p>
          </article>
          <article className="rounded-[10px] border border-line bg-surface p-4 shadow-[0_1px_1px_rgba(15,15,15,0.025)]">
            <h3 className="mb-1 text-sm font-semibold">Seletor grep-friendly</h3>
            <p className="text-[13px] text-fg-muted">
              O agente localiza o código pelo seletor + texto, sem source-map por framework.
            </p>
          </article>
        </section>

        <form className="mt-3 rounded-[10px] border border-line bg-surface p-4">
          <h3 className="mb-3 text-sm font-semibold">Assine a newsletter</h3>
          <label className="mb-1.5 block text-[12px] font-medium text-fg-muted">Seu email</label>
          <input
            className="mb-3 w-full rounded-lg border border-line bg-inset px-3 py-2 text-[13px] text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
            type="email"
            placeholder="voce@exemplo.com"
          />
          <button type="button" className="rounded-lg bg-fg px-4 py-2 text-[13px] font-semibold text-surface">
            Inscrever
          </button>
        </form>

        <p className="mt-6 text-[12px] leading-relaxed text-fg-subtle">
          Dica: o envio dispara o triador (report_issue) — leva alguns segundos e cria UM card por lote. “Copiar
          handoff” cola o markdown num terminal qualquer. Para o REFINO abra{" "}
          <b className="text-fg-muted">/feedback-lab?ah-card=ID_DO_CARD</b>; para o round-trip ao TERMINAL,{" "}
          <b className="text-fg-muted">/feedback-lab?ah-session=SUA_SESSAO</b>.
        </p>
      </main>
    </div>
  );
}
