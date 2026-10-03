import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  parseFaceGateFail,
  faceGateReason,
  readFaceGateReason,
  FACE_GATE_FAIL_MARKER,
} from "./face-gate-detail";
import { buildDeployFailureFinding } from "./deploy-revert";
import { logFileFor } from "./product-deploy";

// A face-deploy gate verdict travels gate → runner → finding.
//
// In a real case a deploy reverted repeatedly, with the card reading only "Deploy de produção falhou (exit 1)
// para <site> … veja o log". The gate KNEW which package and step had failed, and threw it away on exit(1).
// These tests pin the sentence the card must now carry.

/** A realistic face-deploy log: the gate's verdict is the LAST line, after a long stretch of build-tool noise. */
const DEPLOY_LOG = [
  "[deploy shopfront-site] just --yes deploy-shopfront-site",
  "🔎 escopo do gate = escopo do build (mesma decisão, lib/face-scope.mjs):",
  "   shopfront: 3 changed file(s) touch its build inputs (packages/shopfront/web/src/app/catalog/page.tsx) — building.",
  "🧪 gate do rosto (shop.example.test): 1 pacote(s) — shopfront",
  "",
  "▶ lint",
  "shopfront:lint: src/app/catalog/filters.tsx 41:9  error  'sortOrder' is assigned a value but never used  @typescript-eslint/no-unused-vars",
  " ERROR  shopfront#lint: command (/repo/packages/shopfront) bun run lint exited (1)",
  "✗ gate do rosto: lint FALHOU — abortando ANTES de publicar o rosto de shop.example.test.",
  `${FACE_GATE_FAIL_MARKER} {"pkg":"shopfront","task":"lint","firstError":"src/app/catalog/filters.tsx 41:9 error 'sortOrder' is assigned a value but never used"}`,
  "",
  "[deploy shopfront-site] finished exit 1",
].join("\n");

describe("parseFaceGateFail", () => {
  it("lifts the gate's verdict out of a noisy deploy log", () => {
    expect(parseFaceGateFail(DEPLOY_LOG)).toEqual({
      pkg: "shopfront",
      task: "lint",
      firstError: "src/app/catalog/filters.tsx 41:9 error 'sortOrder' is assigned a value but never used",
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
    expect(reason).toContain("shopfront#lint");
    expect(reason).toContain("never used");
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
    expect(await readFaceGateReason(PKG)).toContain("shopfront#lint");
  });

  it("a missing log resolves to null instead of throwing (best-effort, deploy callback must not break)", async () => {
    expect(await readFaceGateReason("no-such-deploy-log-anywhere")).toBeNull();
  });
});

describe("AC4 — the fio: gate verdict → DeployFailureDetail.reason → the card's finding", () => {
  it("the finding NAMES the package, the step and the error (not just 'deploy falhou')", () => {
    const reason = faceGateReason(DEPLOY_LOG)!;
    const finding = buildDeployFailureFinding({ pkg: "shopfront-site", exitCode: 1, phase: "deploy", reason }, "2026-02-09");

    expect(finding.detail).toContain("shopfront#lint");
    expect(finding.detail).toContain("never used");
    expect(finding.detail).toContain("src/app/catalog/filters.tsx");
    // …and the old generic sentence is still there as the frame, not as the whole story.
    expect(finding.detail).toContain("Deploy de produção FALHOU (exit 1)");
  });

  it("without a gate verdict the finding is unchanged from today (no regression, no fake detail)", () => {
    const finding = buildDeployFailureFinding({ pkg: "shopfront-site", exitCode: 1, phase: "deploy" }, "2026-02-09");
    expect(finding.detail).not.toContain("Motivo:");
  });
});

// O pino contra o EMISSOR do marcador (`scripts/deploy/**` do repositório de origem) saiu com a segunda
// árvore (issue #1): aqui só existe o LEITOR, e os casos acima exercitam o lado dele por inteiro.
