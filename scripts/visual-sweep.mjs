#!/usr/bin/env node
// visual-sweep.mjs — capture a URL at N breakpoints as PNGs, deterministically.
//
// WHY IT EXISTS. The QA step needs ONE capability: "render this screen and let me look at it". That was
// wired directly to an interactive MCP server, so when the server could not drive a browser on this host
// the capability had no second route and the step became unrunnable — two runs, 89 turns and US$5.98
// later, the card was still parked. This is the second route: the same capability over the Playwright
// browsers the repo already installs and already uses for its E2E suite.
//
// It does NOT replace the agent's judgement. It navigates and captures; the agent READS the PNGs and
// judges them (screenshots are multimodal input). The interactive MCP remains the better tool for open
// exploration ("does anything here look off?"); this covers a closed rubric — fixed screens, fixed
// breakpoints, fixed states — which is what the QA sweep actually is.
//
// APP-AGNOSTIC by construction: every target (url, breakpoints, output, readiness, init script) is an
// argument. It hardcodes no route, package or product. Board config decides what to point it at.
//
// Output: a JSON manifest on stdout so a caller can find the files — and, critically, judge whether each
// capture is TRUSTWORTHY (see READINESS below). Diagnostics go to stderr. Exit code is the verdict.
//
// READINESS — why this script reports more than a file path. Its first real run captured a page that was
// still all skeleton placeholders and reported success: the PNG existed, so the sweep "worked", while the
// screen it was supposed to prove had never rendered. A capture with no readiness evidence is not visual
// proof, and saying so is this script's job — not the caller's guess. Every shot therefore carries
// `readiness: { asserted, how, domStable, ariaBusy }`, an unasserted one WARNS loudly on stderr, and
// `--require-ready` turns it into a non-zero exit for callers that must not accept a maybe.

import { mkdir, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_BREAKPOINTS = "375x812,1440x900";
const DEFAULT_OUT = ".artifacts/screenshots";
// `domcontentloaded`, NOT `networkidle`. Against a Next.js DEV server the HMR websocket keeps a
// connection open forever, so `networkidle` NEVER fires and every capture dies on timeout — observed on
// the first real sweep, where the desktop breakpoint was simply lost. Readiness is established below by
// DOM stability + an optional selector, which are signals about the PAGE rather than about the socket.
const DEFAULT_WAIT_UNTIL = "domcontentloaded";
const WAIT_UNTIL_VALUES = ["commit", "domcontentloaded", "load", "networkidle"];
// How long the DOM must stop mutating before the page counts as settled.
const DEFAULT_STABLE_MS = 400;

const USAGE = `visual-sweep — captura uma URL em N breakpoints como PNGs, deterministicamente.

  node scripts/visual-sweep.mjs --url <url> --label <slug> [opções]
  node scripts/visual-sweep.mjs --probe

Opções:
  --breakpoints 375x812,1440x900  viewports a capturar (default: esses dois — mobile + desktop)
  --out .artifacts/screenshots    diretório de saída (criado se ausente)
  --wait-selector "[data-ready]"  espera este seletor ANTES de capturar; é a evidência FORTE de
                                  prontidão. Se ele não aparecer, o script FALHA (exit 1) em vez de
                                  capturar um esqueleto silenciosamente.
  --wait-until <estado>           ${WAIT_UNTIL_VALUES.join("|")} (default: ${DEFAULT_WAIT_UNTIL}).
                                  NÃO use networkidle contra dev server (o websocket do HMR nunca ocioso).
  --stable-ms 400                 quanto tempo o DOM precisa ficar sem mutar para contar como assentado
  --wait-ms 250                   atraso extra após a prontidão
  --init-script path.js           script avaliado ANTES dos scripts da página (injeção de test-auth)
  --full-page                     captura a página rolável inteira em vez do viewport
  --timeout-ms 30000              teto por navegação/espera
  --require-ready                 exit != 0 se QUALQUER captura ficar sem prontidão comprovada
  --probe                         auto-teste offline: renderiza e captura. Exit 0 = este host produz
                                  screenshots. É o probe de capacidade declarado no board.yaml. PROVA
                                  propriedades do HOST — playwright resolvível, Chromium lançável (como
                                  root, o modo que já matou o outro provedor), PNG gravável. NÃO prova
                                  que a varredura vai passar: ele não navega (usa setContent sobre
                                  about:blank; o page.goto só existe no caminho da varredura). Alcançar
                                  a URL não é propriedade do host — é da CHAMADA (sob contenção, cada
                                  chamada Bash tem netns próprio), e por isso nenhum probe pode medi-la.
`;

function parseArgs(argv) {
  const out = {
    breakpoints: DEFAULT_BREAKPOINTS,
    out: DEFAULT_OUT,
    waitMs: 250,
    timeoutMs: 30_000,
    waitUntil: DEFAULT_WAIT_UNTIL,
    stableMs: DEFAULT_STABLE_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--probe") out.probe = true;
    else if (a === "--full-page") out.fullPage = true;
    else if (a === "--require-ready") out.requireReady = true;
    else if (a === "--url") out.url = next();
    else if (a === "--label") out.label = next();
    else if (a === "--out") out.out = next();
    else if (a === "--breakpoints") out.breakpoints = next();
    else if (a === "--wait-selector") out.waitSelector = next();
    else if (a === "--wait-until") out.waitUntil = next();
    else if (a === "--stable-ms") out.stableMs = Number(next());
    else if (a === "--wait-ms") out.waitMs = Number(next());
    else if (a === "--init-script") out.initScript = next();
    else if (a === "--timeout-ms") out.timeoutMs = Number(next());
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`argumento desconhecido: ${a}`);
  }
  if (!WAIT_UNTIL_VALUES.includes(out.waitUntil)) {
    throw new Error(`--wait-until inválido "${out.waitUntil}" — use ${WAIT_UNTIL_VALUES.join("|")}`);
  }
  return out;
}

/** "375x812,1440x900" → [{w,h,label}]. Throws on a malformed entry rather than silently capturing junk. */
function parseBreakpoints(spec) {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(\d+)x(\d+)$/.exec(s);
      if (!m) throw new Error(`breakpoint inválido "${s}" — use LARGURAxALTURA (ex.: 375x812)`);
      return { w: Number(m[1]), h: Number(m[2]), label: s };
    });
}

/** Filesystem-safe slug for a label that ends up in a filename. */
function slug(s) {
  return String(s || "sweep")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Chromium launch options for THIS host. The sandbox flags are added only when running as root, where
 * Chrome refuses to start without them — the failure mode that made the MCP provider unusable here
 * ("Target closed") and which no amount of card-level work could have fixed.
 */
function launchOptions() {
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  return {
    headless: true,
    args: asRoot ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] : [],
  };
}

/**
 * Wait until the DOM stops mutating for `stableMs`. Generic by construction — a MutationObserver knows
 * nothing about this app's skeletons, spinners or class names, so the signal travels to any consumer
 * repo (an app-specific heuristic would be exactly the product constant that must never live in tooling).
 * Returns true when it settled, false when `timeoutMs` elapsed first — a value, never a throw: "the page
 * never settled" is a FINDING about the capture, not a crash.
 */
async function waitForDomStable(page, stableMs, timeoutMs) {
  return page.evaluate(
    ({ stableMs, timeoutMs }) =>
      new Promise((resolve) => {
        let lastMutation = Date.now();
        const started = Date.now();
        const observer = new MutationObserver(() => {
          lastMutation = Date.now();
        });
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        const tick = () => {
          if (Date.now() - lastMutation >= stableMs) {
            observer.disconnect();
            resolve(true);
          } else if (Date.now() - started >= timeoutMs) {
            observer.disconnect();
            resolve(false);
          } else {
            setTimeout(tick, 50);
          }
        };
        tick();
      }),
    { stableMs, timeoutMs },
  );
}

/** Count elements the PAGE ITSELF declares as still loading. `aria-busy` is a web standard, so this is a
 *  first-party claim from the app rather than a guess about its markup. */
async function countAriaBusy(page) {
  return page.evaluate(() => document.querySelectorAll('[aria-busy="true"]').length);
}

async function withBrowser(fn) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (err) {
    throw new Error(`playwright não instalado/resolvível: ${err.message}`);
  }
  const browser = await chromium.launch(launchOptions());
  try {
    return await fn(browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

/** The capability self-test: render offline and capture. No network, no dev server, no fixtures — it
 *  answers exactly one question ("can this host turn a page into a PNG?") and answers it in ~2s. */
async function probe() {
  const file = path.join(tmpdir(), `visual-sweep-probe-${process.pid}.png`);
  await withBrowser(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
    await page.setContent("<!doctype html><title>probe</title><h1>probe</h1>");
    await page.screenshot({ path: file });
  });
  const { size } = await stat(file);
  if (!size) throw new Error("screenshot vazio");
  process.stdout.write(JSON.stringify({ ok: true, probe: true, bytes: size }) + "\n");
}

async function sweep(opts) {
  if (!opts.url) throw new Error("--url é obrigatório (ou use --probe)");
  const breakpoints = parseBreakpoints(opts.breakpoints);
  const outDir = path.resolve(opts.out);
  await mkdir(outDir, { recursive: true });
  const initScript = opts.initScript ? await readFile(path.resolve(opts.initScript), "utf8") : null;
  const name = slug(opts.label);

  const shots = await withBrowser(async (browser) => {
    const written = [];
    for (const bp of breakpoints) {
      const context = await browser.newContext({ viewport: { width: bp.w, height: bp.h } });
      try {
        // BEFORE any page script — this is the seam the auth injection needs (a token set after the app
        // boots is a token the app already decided it did not have).
        if (initScript) await context.addInitScript({ content: initScript });
        const page = await context.newPage();
        await page.goto(opts.url, { waitUntil: opts.waitUntil, timeout: opts.timeoutMs });

        // READINESS, strongest evidence first.
        let how = "none";
        if (opts.waitSelector) {
          // A selector that never appears is a FAILED capture, not a capture of whatever was on screen.
          // Silently shooting the skeleton is the exact defect this branch exists to prevent.
          try {
            await page.waitForSelector(opts.waitSelector, { timeout: opts.timeoutMs });
            how = "selector";
          } catch {
            throw new Error(
              `prontidão não confirmada em ${bp.label}: o seletor "${opts.waitSelector}" não apareceu em ${opts.timeoutMs}ms — ` +
                `a página provavelmente não carregou os dados (esqueleto). Nenhum PNG desta captura vale como prova visual.`,
            );
          }
        }
        const domStable = await waitForDomStable(page, opts.stableMs, opts.timeoutMs);
        if (how === "none" && domStable) how = "dom-stable";
        if (opts.waitMs > 0) await page.waitForTimeout(opts.waitMs);
        const ariaBusy = await countAriaBusy(page);

        const file = path.join(outDir, `${name}-${bp.label}.png`);
        await page.screenshot({ path: file, fullPage: Boolean(opts.fullPage) });
        // `asserted` is deliberately strict: DOM stability alone proves the page STOPPED changing, which a
        // stuck skeleton also satisfies. Only an explicit selector — or the page declaring itself not busy
        // while settled — counts as evidence that what is on screen is the real thing.
        const asserted = how === "selector" || (domStable && ariaBusy === 0);
        written.push({
          breakpoint: bp.label,
          path: file,
          bytes: (await stat(file)).size,
          readiness: { asserted, how, domStable, ariaBusy },
        });
        process.stderr.write(
          `capturado ${bp.label} → ${file} (prontidão: ${how}${domStable ? "" : ", DOM NÃO assentou"}${ariaBusy ? `, ${ariaBusy} elemento(s) aria-busy` : ""})\n`,
        );
        if (!asserted) {
          process.stderr.write(
            `⚠ ${bp.label}: prontidão NÃO comprovada — este PNG pode ser um estado de carregamento e NÃO vale como prova visual. ` +
              `Passe --wait-selector com um seletor que só existe depois dos dados carregarem.\n`,
          );
        }
      } finally {
        await context.close().catch(() => {});
      }
    }
    return written;
  });

  // `readyAll` is the single field a caller should gate on: it answers "may I treat these PNGs as proof?"
  // in one read, instead of making every consumer re-derive it from the per-shot flags (and some forget).
  const readyAll = shots.every((s) => s.readiness.asserted);
  process.stdout.write(JSON.stringify({ ok: true, readyAll, url: opts.url, shots }, null, 2) + "\n");
  if (!readyAll && opts.requireReady) {
    throw new Error("--require-ready: ao menos uma captura ficou sem prontidão comprovada");
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    // A literal USAGE constant, not a slice of this file's own comment block: the old version broke the
    // moment a line was added above it, and help that silently rots is worse than no help.
    process.stdout.write(USAGE);
    return;
  }
  if (opts.probe) return probe();
  return sweep(opts);
}

main().catch((err) => {
  process.stderr.write(`visual-sweep FALHOU: ${err?.message ?? err}\n`);
  process.stdout.write(JSON.stringify({ ok: false, error: String(err?.message ?? err) }) + "\n");
  process.exit(1);
});
