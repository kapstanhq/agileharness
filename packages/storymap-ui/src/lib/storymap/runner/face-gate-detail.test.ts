import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { soDoUmbrella } from "@/lib/storymap/oss-tree";
import {
  parseFaceGateFail,
  faceGateReason,
  readFaceGateReason,
  FACE_GATE_FAIL_MARKER,
} from "./face-gate-detail";
import { buildDeployFailureFinding } from "./deploy-revert";
import { logFileFor } from "./product-deploy";

// WS-11.2 / D15 (card storymap/story-pxj9gz) — the fio gate → runner → finding.
//
// On 2026-07-16 acme/story-qb8z2c and acme/story-eqpdtz reverted all day reading only "Deploy de produção
// falhou (exit 1) para mosaico-site … veja o log". The gate KNEW it was nimbus#typecheck / TS2307 and threw
// it away on exit(1). These tests pin the sentence the card must now carry.

/** A realistic face-deploy log: the gate's verdict is the LAST line, after 32KB of turbo noise. */
const DEPLOY_LOG = [
  "[deploy mosaico-site] just --yes deploy-mosaico-site",
  "🔎 escopo do gate = escopo do build (mesma decisão, lib/face-scope.mjs):",
  "   acmeapp: 7 changed file(s) touch its build inputs (packages/acmeapp/web/src/app/page.tsx) — building.",
  "🧪 gate do rosto (mosaico.app): 2 pacote(s) — @acmeapp/web, acmeapp",
  "",
  "▶ typecheck",
  "nimbus:typecheck: [web] .next/types/app/waitlist/page.ts(2,24): error TS2307: Cannot find module '../../../../src/app/waitlist/page.js' or its corresponding type declarations.",
  " ERROR  nimbus#typecheck: command (/repo/packages/nimbus) bun run typecheck exited (1)",
  "✗ gate do rosto: typecheck FALHOU — abortando ANTES de publicar o rosto de mosaico.app.",
  `${FACE_GATE_FAIL_MARKER} {"pkg":"nimbus","task":"typecheck","firstError":"[web] .next/types/app/waitlist/page.ts(2,24): error TS2307: Cannot find module '../../../../src/app/waitlist/page.js' or its corresponding type declarations."}`,
  "",
  "[deploy mosaico-site] finished exit 1",
].join("\n");

describe("parseFaceGateFail", () => {
  it("lifts the gate's verdict out of a noisy deploy log", () => {
    expect(parseFaceGateFail(DEPLOY_LOG)).toEqual({
      pkg: "nimbus",
      task: "typecheck",
      firstError:
        "[web] .next/types/app/waitlist/page.ts(2,24): error TS2307: Cannot find module '../../../../src/app/waitlist/page.js' or its corresponding type declarations.",
    });
  });

  it("returns null when the deploy failed for a NON-gate reason (never dress it up as a gate veto)", () => {
    expect(parseFaceGateFail("firebase: HTTP Error: 400, Invalid site\n[deploy] finished exit 1")).toBeNull();
    expect(parseFaceGateFail("")).toBeNull();
  });

  it("takes the LAST verdict when a log carries more than one", () => {
    const log = [
      `${FACE_GATE_FAIL_MARKER} {"pkg":"old","task":"typecheck","firstError":"stale"}`,
      `${FACE_GATE_FAIL_MARKER} {"pkg":"fresh","task":"test:unit","firstError":"current"}`,
    ].join("\n");
    expect(parseFaceGateFail(log)?.pkg).toBe("fresh");
  });

  it("survives a malformed/truncated verdict line instead of throwing (the revert must still land)", () => {
    expect(parseFaceGateFail(`${FACE_GATE_FAIL_MARKER} {"pkg":"x","tas`)).toBeNull();
    expect(parseFaceGateFail(`${FACE_GATE_FAIL_MARKER} {"pkg":"x"}`)).toBeNull(); // no task ⇒ unusable
    expect(parseFaceGateFail(`${FACE_GATE_FAIL_MARKER} not-json-at-all`)).toBeNull();
  });

  it("a package-less verdict (timeout / killed suite) keeps its task", () => {
    const log = `${FACE_GATE_FAIL_MARKER} {"pkg":null,"task":"test:unit","firstError":"morto por SIGKILL — a suíte nunca reportou resultado"}`;
    expect(parseFaceGateFail(log)).toEqual({
      pkg: null,
      task: "test:unit",
      firstError: "morto por SIGKILL — a suíte nunca reportou resultado",
    });
  });
});

describe("faceGateReason", () => {
  it("reads as {pacote, etapa, 1ª linha de erro}", () => {
    const reason = faceGateReason(DEPLOY_LOG);
    expect(reason).toContain("nimbus#typecheck");
    expect(reason).toContain("TS2307");
  });

  it("names the task even with no owning package", () => {
    const log = `${FACE_GATE_FAIL_MARKER} {"pkg":null,"task":"test:unit","firstError":"estourou o tempo"}`;
    expect(faceGateReason(log)).toBe("o gate do rosto reprovou test:unit: estourou o tempo");
  });

  it("null ⇒ the caller omits `reason` (exactly today's finding, never worse)", () => {
    expect(faceGateReason("nothing here")).toBeNull();
  });
});

describe("readFaceGateReason — reads the real deploy log the launcher wrote", () => {
  const PKG = "test-face-gate-detail";
  afterEach(() => rmSync(logFileFor(PKG), { force: true }));

  it("finds the verdict in logFileFor(pkg)", async () => {
    const file = logFileFor(PKG);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, DEPLOY_LOG);
    expect(await readFaceGateReason(PKG)).toContain("nimbus#typecheck");
  });

  it("a missing log resolves to null instead of throwing (best-effort, deploy callback must not break)", async () => {
    expect(await readFaceGateReason("no-such-deploy-log-anywhere")).toBeNull();
  });
});

describe("AC4 — the fio: gate verdict → DeployFailureDetail.reason → the card's finding", () => {
  it("the finding NAMES the package, the step and the error (not just 'deploy falhou')", () => {
    const reason = faceGateReason(DEPLOY_LOG)!;
    const finding = buildDeployFailureFinding({ pkg: "mosaico-site", exitCode: 1, phase: "deploy", reason }, "2026-07-16");

    expect(finding.detail).toContain("nimbus#typecheck");
    expect(finding.detail).toContain("TS2307");
    expect(finding.detail).toContain(".next/types/app/waitlist/page.ts");
    // …and the old generic sentence is still there as the frame, not as the whole story.
    expect(finding.detail).toContain("Deploy de produção FALHOU (exit 1)");
  });

  it("without a gate verdict the finding is unchanged from today (no regression, no fake detail)", () => {
    const finding = buildDeployFailureFinding({ pkg: "mosaico-site", exitCode: 1, phase: "deploy" }, "2026-07-16");
    expect(finding.detail).not.toContain("Motivo:");
  });
});

describe("cross-language contract — the marker cannot drift silently", () => {
  // `skipIf` NO LUGAR DO `return` ANTECIPADO: o emissor não viaja (o comentário abaixo explica por
  // quê), então na árvore extraída este corpo saía SEM asserção nenhuma — e "passou" e "não mediu
  // nada" eram a mesma linha verde. Pulado é uma terceira coisa, e o vitest sabe dizê-la.
  it.skipIf(
    !soDoUmbrella("scripts/deploy/lib/turbo-failure.mjs") || !soDoUmbrella("scripts/deploy/predeploy-face-gate.mjs"),
  )("predeploy-face-gate.mjs emits the EXACT marker this module greps", () => {
    // The emitter is .mjs and the reader is .ts: no compiler links them. A silent rename on either side
    // would make every face veto anonymous again — which is the bug WS-11.2 exists to fix.
    //
    // ⚠ O EMISSOR NÃO VIAJA. `scripts/deploy/**` publica os produtos do dono (a face composta mosaico.app)
    // e a régua o exclui; o LEITOR (face-gate-detail.ts) viaja com o runner. Considerou-se fazer o par
    // .mjs viajar — recusado: `predeploy-face-gate.mjs` fala de mosaico.app por dentro, e um repo público
    // que carrega o gate de deploy de um produto alheio ganha código morto de origem confusa.
    // No artefato o marcador continua coberto pelos 12 casos acima, que exercitam o LADO do leitor
    // (parse, marcador duplicado, verdict truncado, ausência de pacote) — o que deixa de ser medido lá
    // é só o pino contra o emissor, que lá não existe. `soDoUmbrella` LANÇA se ele sumir DAQUI.
    const libPath = soDoUmbrella("scripts/deploy/lib/turbo-failure.mjs");
    const gatePath = soDoUmbrella("scripts/deploy/predeploy-face-gate.mjs");

    const lib = readFileSync(libPath!, "utf8");
    expect(lib).toContain(`FACE_GATE_FAIL_MARKER = '${FACE_GATE_FAIL_MARKER}'`);

    const gate = readFileSync(gatePath!, "utf8");
    expect(gate).toContain("formatFaceGateFail");
  });
});
