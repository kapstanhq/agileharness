#!/usr/bin/env node
// browser-mcp.mjs — capability probe for the chrome-devtools MCP provider.
//
// THE POINT OF THIS FILE. A handshake is not proof. The incident that motivated the capability contract
// had an MCP server that connected perfectly and answered `tools/list` — while EVERY tool call failed,
// because the host had no Chrome binary ("Could not find Google Chrome executable for channel 'stable'
// at /opt/google/chrome/chrome"). A probe that stopped at the handshake would have reported green and
// changed nothing. So this one drives the server the way the sweep will: it calls a real tool and
// requires a real success.
//
// It navigates to a `data:` URL — no network, no dev server, no fixtures. The question is only "can this
// MCP actually drive a browser on this host?", and the answer must not depend on anything else being up.
//
// Reads the SAME mount the run will mount (storymap/qa-mcp.json by default, --config to override), so the
// probe can never disagree with the spawn about which server/flags it is testing. Exit 0 = available.

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const DEFAULT_CONFIG = "storymap/qa-mcp.json";
const DEFAULT_SERVER = "chrome-devtools";
const DEFAULT_TIMEOUT_MS = 75_000;

function parseArgs(argv) {
  const out = { config: DEFAULT_CONFIG, server: DEFAULT_SERVER, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") out.config = argv[++i];
    else if (a === "--server") out.server = argv[++i];
    else if (a === "--timeout-ms") out.timeoutMs = Number(argv[++i]);
    else throw new Error(`argumento desconhecido: ${a}`);
  }
  return out;
}

/** Read the server's command/args out of an MCP config JSON — the same file the engine mounts. */
async function readServerSpec(configPath, serverName) {
  const raw = JSON.parse(await readFile(path.resolve(configPath), "utf8"));
  const spec = raw?.mcpServers?.[serverName];
  if (!spec?.command) throw new Error(`servidor "${serverName}" ausente ou sem "command" em ${configPath}`);
  return { command: spec.command, args: Array.isArray(spec.args) ? spec.args : [], env: spec.env ?? {} };
}

/**
 * O texto de um resultado de tool, TOTAL — nunca lança, qualquer que seja a forma do `content`.
 *
 * Isto é total de propósito, e o motivo é uma cicatriz: a versão anterior fazia
 * `(msg.result?.content ?? []).map((c) => c.text)` DENTRO do ramo `isError`, e ao mover essa mesma
 * expressão para o caminho de SUCESSO — onde ela nunca havia rodado — o probe passou a estourar por
 * timeout. Uma exceção lançada aqui morre dentro do handler de `stdout`, não rejeita promessa nenhuma, e
 * o único sintoma é o probe ficar mudo até o teto. Ou seja: um throw neste ponto vira "INDISPONÍVEL"
 * silencioso, o pior desfecho possível para uma peça cujo trabalho é dizer a verdade sobre disponibilidade.
 */
function textoDoResultado(result) {
  try {
    const c = result?.content;
    if (!Array.isArray(c)) return "";
    return c.map((x) => (x && typeof x.text === "string" ? x.text : "")).filter(Boolean).join(" ").trim();
  } catch {
    return "";
  }
}

/**
 * Minimal stdio MCP client: initialize → initialized → tools/call(navigate_page). Enough to answer the
 * question, and deliberately not a dependency on an MCP SDK (a probe that needs an install to run is a
 * probe that fails for the wrong reason).
 */
function driveServer(spec, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group → the timeout kill reaps npx→node→chrome, not just the shell
      env: { ...process.env, ...spec.env },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      resolve({ ok, detail });
    };
    const timer = setTimeout(() => finish(false, `timeout após ${timeoutMs}ms`), timeoutMs);
    const send = (msg) => {
      try {
        child.stdin.write(JSON.stringify(msg) + "\n");
      } catch (err) {
        finish(false, `stdin fechado: ${err.message}`);
      }
    };

    child.stderr.on("data", (d) => {
      stderr = (stderr + String(d)).slice(-4000);
    });
    child.on("error", (err) => finish(false, `spawn falhou: ${err.message}`));
    child.on("close", (code) => finish(false, `servidor encerrou (exit ${code})${stderr.trim() ? ` — ${stderr.trim().split("\n").pop()}` : ""}`));

    child.stdout.on("data", (d) => {
      stdout += String(d);
      // Line-delimited JSON-RPC: process whole lines, keep the remainder buffered.
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // banner/log noise on stdout — not our protocol
        }
        if (msg.id === 1 && msg.result) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          // The real test: a tool call that must actually launch a browser.
          send({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "navigate_page", arguments: { url: "data:text/html,<title>probe</title>" } },
          });
        } else if (msg.id === 2) {
          if (msg.error) return finish(false, `navigate_page: ${msg.error.message ?? JSON.stringify(msg.error)}`);
          // chrome-devtools reports tool failures as a RESULT with isError — a bare `result` check would
          // read "Could not find Chrome" as success, which is the exact blindness this probe exists to fix.
          const text = textoDoResultado(msg.result);
          if (msg.result?.isError) {
            return finish(false, `navigate_page falhou: ${text.split("\n")[0] || "isError"}`);
          }
          // …E A SEGUNDA CAMADA, medida em 2026-08-05: o `isError` NÃO é confiável. Numa navegação para um
          // servidor inalcançável o chrome-devtools devolve `isError: false` e põe a falha SÓ no texto
          // ("Unable to navigate in the selected page: net::ERR_CONNECTION_REFUSED at …"). Um probe que
          // parasse no flag reportaria VERDE com o navegador não alcançando absolutamente nada — a mesma
          // doença, uma camada abaixo. Hoje isto não dispara, porque a URL é `data:` e não depende de rede;
          // fica como guarda para quem um dia apontar este probe para outro lugar, que é justamente quando
          // o flag mentiria. O padrão é ESTREITO de propósito: casar "erro" solto no texto reprovaria uma
          // navegação bem-sucedida para uma página que por acaso fale de erros.
          if (/net::ERR_|Unable to navigate/i.test(text)) {
            return finish(false, `navigate_page falhou (isError=false, falha só no texto): ${text.split("\n")[0]}`);
          }
          return finish(true, "navigate_page ok");
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "capability-probe", version: "1" } },
    });
  });
}

const opts = parseArgs(process.argv.slice(2));
try {
  const spec = await readServerSpec(opts.config, opts.server);
  const { ok, detail } = await driveServer(spec, opts.timeoutMs);
  process.stderr.write(`${opts.server}: ${ok ? "OK" : "INDISPONÍVEL"} — ${detail}\n`);
  process.exit(ok ? 0 : 1);
} catch (err) {
  process.stderr.write(`${opts.server}: INDISPONÍVEL — ${err?.message ?? err}\n`);
  process.exit(1);
}
