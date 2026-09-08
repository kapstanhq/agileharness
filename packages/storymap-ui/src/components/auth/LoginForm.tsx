"use client";

// O FORMULÁRIO da tela de login.
//
// Desenho: NÃO existe cartão flutuando sobre um gradiente. A identidade do AgileHarness é papel e
// tinta (globals.css: "hierarquia por tamanho/peso/espaço, não por cor"), então o login é uma
// coluna centrada direto sobre o papel — o mesmo plano branco do board. O único pixel saturado da
// tela é o ponto laranja do lockup, que é exatamente o que a regra da marca manda
// (AgileHarnessLogo: "só o ponto foge para o laranja da marca").
//
// O campo é MONO e fica num poço `bg-inset` porque o que se digita ali é um segredo de MÁQUINA, e
// não um nome de usuário — a tipografia diz a verdade sobre o que a coisa é.

import { useEffect, useRef, useState } from "react";

import { safeNextPath } from "@/lib/auth/next-path";

/**
 * O destino, saneado no cliente TAMBÉM (o servidor já saneou).
 *
 * A primeira versão tinha a régua duplicada aqui na mão (`startsWith("/") && !startsWith("//")`)
 * e ela deixava passar `/\evil.example` — o parser de URL lê a barra invertida como barra e o
 * navegador sai do site. Agora as duas pontas chamam a MESMA função.
 */
function safeNext(raw: string | undefined): string {
  return safeNextPath(raw) ?? "/";
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}min ${String(s).padStart(2, "0")}s` : `${s}s`;
}

export function LoginForm({ next }: { next?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [token, setToken] = useState("");
  const [reveal, setReveal] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // Relógio de 1s vivo SÓ enquanto há bloqueio — sem timer perpétuo numa tela ociosa.
  useEffect(() => {
    if (lockedUntil <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [lockedUntil]);

  const locked = lockedUntil > now;
  const disabled = busy || locked || token.trim().length === 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token.trim(), remember }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        remaining?: number;
        locked?: boolean;
        retryAfterMs?: number;
      };

      if (res.ok && data.ok) {
        setToken("");
        // NAVEGAÇÃO DURA, não `router.replace`. Entrar muda o estado de TODA a árvore, inclusive
        // do root layout — e o App Router NÃO re-renderiza um layout compartilhado entre origem e
        // destino numa navegação de cliente. Com `replace()`, o root layout continuava sendo o que
        // foi renderizado em `/login` (rota pública), e o overlay de feedback não montava em
        // NENHUMA página até um reload manual. Um `location.assign` custa um carregamento a mais
        // uma vez por sessão e elimina a classe inteira de estado obsoleto pós-login.
        window.location.assign(safeNext(next));
        return;
      }

      if (data.locked && typeof data.retryAfterMs === "number") {
        setLockedUntil(Date.now() + data.retryAfterMs);
        setNow(Date.now());
        setError("Muitas tentativas. O acesso ficou bloqueado por um intervalo.");
      } else if (typeof data.remaining === "number" && data.remaining <= 3) {
        // Só avisamos do orçamento quando ele fica APERTADO — mostrar "8 restantes" na primeira
        // falha é ruído; mostrar "2 restantes" é o aviso que evita o operador se trancar sozinho.
        setError(`Token inválido. Restam ${data.remaining} tentativas antes do bloqueio.`);
      } else {
        setError("Token inválido.");
      }
      inputRef.current?.focus();
      inputRef.current?.select();
    } catch {
      setError("Não foi possível falar com o serviço. Ele está no ar?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full space-y-6" noValidate>
      <div className="space-y-1.5">
        <label htmlFor="operator-token" className="block text-[13px] font-medium text-fg">
          Token do operador
        </label>
        <div className="relative">
          <input
            ref={inputRef}
            id="operator-token"
            name="token"
            type={reveal ? "text" : "password"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={busy || locked}
            // `current-password` faz o gerenciador de senhas (1Password, Chaves do iOS) guardar e
            // preencher — o que importa muito para um segredo de 43 caracteres que ninguém decora.
            autoComplete="current-password"
            // O campo é o ÚNICO da tela e a única ação possível: focá-lo poupa um clique no
            // desktop e, no celular, abre o teclado já pronto para o colar.
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={!!error}
            aria-describedby={error ? "login-error" : undefined}
            // 16px é o piso que impede o iOS de dar zoom ao focar o campo — abaixo disso a tela
            // "pula" no celular, que é de onde o operador costuma entrar.
            className="w-full rounded-lg border border-line bg-inset px-3 py-2.5 pr-11 font-mono text-[16px] leading-normal text-fg outline-none transition placeholder:text-fg-subtle focus:border-accent focus:ring-2 focus:ring-accent/40 disabled:opacity-60"
            placeholder="cole aqui"
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            // Um token colado precisa ser CONFERÍVEL — o olho não é enfeite, é como se descobre
            // que veio truncado do copiar-e-colar.
            aria-label={reveal ? "Ocultar token" : "Mostrar token"}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-fg-subtle transition hover:text-fg focus:outline-none focus-visible:text-fg"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M1.5 8S3.8 3.5 8 3.5 14.5 8 14.5 8 12.2 12.5 8 12.5 1.5 8 1.5 8Z"
                stroke="currentColor"
                strokeWidth="1.3"
              />
              <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
              {!reveal && <path d="M3 13 13 3" stroke="currentColor" strokeWidth="1.3" />}
            </svg>
          </button>
        </div>

        {/* Altura reservada mesmo VAZIA: sem isto o formulário inteiro pula para baixo quando o
            erro aparece, e o botão foge de debaixo do dedo entre a tentativa e o retry. */}
        <div className="min-h-[18px]">
          {error && (
            <p id="login-error" role="alert" aria-live="polite" className="text-[12px] text-danger">
              {error}
              {locked && <> Tente de novo em {formatCountdown(lockedUntil - now)}.</>}
            </p>
          )}
        </div>
      </div>

      <label className="flex cursor-pointer select-none items-center gap-2.5 text-[13px] text-fg-muted">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          className="h-4 w-4 shrink-0 cursor-pointer rounded border-line accent-[rgb(var(--accent))]"
        />
        Manter conectado neste dispositivo
      </label>

      <button
        type="submit"
        disabled={disabled}
        className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-fg transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Entrando…" : locked ? `Bloqueado — ${formatCountdown(lockedUntil - now)}` : "Entrar"}
      </button>
    </form>
  );
}

/**
 * O estado "você JÁ está conectado" — e a única saída de sessão que o app tem.
 *
 * Duas coisas que estavam quebradas antes dele: (1) abrir `/login` com sessão viva mostrava o
 * formulário, então o operador redigitava o token sem precisar; (2) não havia lugar NENHUM para
 * encerrar a sessão — o endpoint existia, a UI não. `/login` é o endereço óbvio para as duas
 * coisas, e resolvê-las aqui evita inventar um menu de conta no topnav só para caber um botão.
 */
export function LoggedInPanel({ next }: { next?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = safeNext(next);

  async function logout() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error(String(res.status));
      // Navegação DURA pelo mesmo motivo do login (ver acima), invertido: o cookie sumiu e tudo o
      // que foi renderizado sob a sessão — inclusive o overlay pendurado no root layout — precisa
      // ir embora junto. Um `router.replace` deixaria a casca da sessão anterior na tela.
      window.location.assign("/login");
    } catch {
      setError("Não foi possível encerrar a sessão. Tente de novo.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <a
        href={target}
        className="block w-full rounded-lg bg-primary px-4 py-2.5 text-center text-sm font-semibold text-primary-fg transition hover:bg-primary-hover"
      >
        {target === "/" ? "Ir para o board" : "Continuar de onde parei"}
      </a>

      <button
        type="button"
        onClick={logout}
        disabled={busy}
        className="w-full rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg disabled:opacity-50"
      >
        {busy ? "Saindo…" : "Sair deste dispositivo"}
      </button>

      <div className="min-h-[18px]">
        {error && (
          <p role="alert" aria-live="polite" className="text-[12px] text-danger">
            {error}
          </p>
        )}
      </div>

      <p className="border-t border-line-muted pt-4 text-[12px] leading-relaxed text-fg-muted">
        Sair encerra a sessão <strong className="font-medium text-fg">deste</strong> dispositivo. Para
        derrubar todas de uma vez, troque o token do operador e reinicie o serviço.
      </p>
    </div>
  );
}

/**
 * A saída para quem acabou de instalar e não sabe onde está o token. Fechada por default: quem já
 * opera a instância não precisa ver o comando toda vez, e quem está no primeiro boot acha na hora.
 */
export function TokenHelp() {
  const [copied, setCopied] = useState(false);
  const command = "cat storymap/.runner/auth-token";

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard bloqueado (http sem localhost, permissão negada): o comando segue visível e
      // selecionável — o caminho manual nunca deixa de existir.
    }
  }

  return (
    <details className="group border-t border-line-muted pt-4 text-[13px]">
      <summary className="cursor-pointer list-none text-fg-muted transition hover:text-fg focus-visible:text-fg">
        <span className="underline decoration-line-emphasis underline-offset-4">
          Onde encontro o token?
        </span>
      </summary>
      <div className="mt-3 space-y-3 text-[12px] leading-relaxed text-fg-muted">
        <p>
          Ele foi gerado no primeiro boot do serviço, na máquina onde o AgileHarness está instalado.
          Na raiz do repositório:
        </p>
        <div className="flex items-stretch gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-md border border-line bg-inset px-2.5 py-2 font-mono text-[12px] text-fg">
            {command}
          </code>
          <button
            type="button"
            onClick={copy}
            className="shrink-0 rounded-md border border-line px-2.5 text-[11px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
          >
            {copied ? "copiado" : "copiar"}
          </button>
        </div>
        <p>
          Também dá para fixá-lo por variável de ambiente (<code className="font-mono">AGILEHARNESS_AUTH_TOKEN</code>
          ), que tem precedência sobre o arquivo. Perdeu o token? Apague o arquivo e reinicie o
          serviço — um novo nasce no boot.
        </p>
      </div>
    </details>
  );
}
