// A TELA DE LOGIN — a primeira coisa que alguém vê ao abrir uma instância do AgileHarness.
//
// Antes disto, "login" era o diálogo nativo do navegador disparado pelo `basic_auth` do Caddy:
// zero HTML, zero CSS, e a única string sob nosso controle era o realm ("restricted"). Como o
// AgileHarness é instalado na VPS de quem baixa o open-source, essa era literalmente a primeira
// impressão do produto — e não dava para melhorá-la sem trazer a autenticação para dentro do app.
//
// O desenho segue a identidade do resto do board (globals.css): papel quente, tinta grafite,
// hierarquia por espaço e peso, UM acento (âmbar) e o laranja da marca só no ponto do lockup.
// Nada de cartão sombreado sobre gradiente — o plano é o mesmo papel branco do board.
//
// A página tem DOIS estados, e o segundo não é enfeite: chegar aqui JÁ CONECTADO mostrava o
// formulário como se a sessão não existisse — o operador redigitava o token à toa, e não havia
// lugar NENHUM no app para encerrar a sessão. Agora `/login` é a superfície da SESSÃO: deslogado,
// pede o token; logado, diz que você já está dentro e oferece a saída.

import type { Metadata } from "next";
import { cookies } from "next/headers";

import { AgileHarnessLogo } from "@/components/AgileHarnessLogo";
import { JidoResting } from "@/components/copilot/CopilotFace";
import { LoggedInPanel, LoginForm, TokenHelp } from "@/components/auth/LoginForm";
import { authSecretsFromEnv } from "@/lib/auth/env";
import { safeNextPath } from "@/lib/auth/next-path";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";


export const metadata: Metadata = {
  title: "Entrar — AgileHarness",
  // Uma tela de login não tem por que ser indexada nem seguida.
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function LoginPage(props: {
  // Next 15: `searchParams` é uma PROMISE. O acesso síncrono ainda funciona por uma camada de
  // compatibilidade (medido no serviço vivo: `?next=` chega ao componente), mas o tipo GERADO em
  // `.next/types/app/login/page.ts` já o recusa, e a compat sai num major. Esta foi a única página que
  // o codemod da migração não pegou — ela destrutura no parâmetro, e o codemod casava `props.<campo>`.
  searchParams?: Promise<{ next?: string }>;
}) {
  const searchParams = await props.searchParams;
  // Saneamento do destino no SERVIDOR (o cliente repete por defesa em profundidade). Sem isto,
  // `/login?next=https://evil.example` faria da tela um trampolim de phishing. A régua vive em
  // lib/auth/next-path.ts — UMA só para os dois lados.
  const next = safeNextPath(searchParams?.next) ?? undefined;

  const authenticated = await verifySession({
    token: (await cookies()).get(SESSION_COOKIE)?.value,
    ...authSecretsFromEnv(),
  });

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-canvas px-6 py-12">
      {/* A coluna. 360px é largura de leitura confortável e cabe inteira num celular pequeno. */}
      <div className="w-full max-w-[360px]">
        <header className="mb-9 flex flex-col items-center text-center">
          {/* `md` = 100px. A escada mudou de valores quando a arte passou para a grade do design
              (50 células), e o degrau que vale 100px aqui passou a se chamar `md` — o `lg` (150)
              existe para um painel inteiro de espera, não para o cabeçalho de uma coluna de 360. */}
          <JidoResting size="md" />
          <AgileHarnessLogo size={20} className="mt-5 text-fg" />
          <p className="mt-3 text-[13px] leading-relaxed text-fg-muted">
            {authenticated
              ? "Você já está conectado nesta instância."
              : "Entre com o token do operador desta instância."}
          </p>
        </header>

        {authenticated ? (
          <LoggedInPanel next={next} />
        ) : (
          <>
            <LoginForm next={next} />
            <div className="mt-8">
              <TokenHelp />
            </div>
          </>
        )}
      </div>
    </main>
  );
}
