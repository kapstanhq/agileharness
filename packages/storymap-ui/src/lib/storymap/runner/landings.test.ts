// landings — the RECEIPT ledger. Its whole value rests on ONE asymmetry, so that is what these pin:
// a receipt PROVES `landed`, and its ABSENCE proves nothing at all. Get that backwards and the branch-gc
// deletes every pre-ledger branch on the first boot, because none of them has a line.

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLanding, readLandings, recordLanding } from "./landings";

describe("landings — o recibo do split", () => {
  let dir: string;
  const ledger = () => path.join(dir, "landings.jsonl");

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-landings-"));
    process.env.AGILEHARNESS_RUNNER_STATE_DIR = dir;
  });
  afterEach(async () => {
    delete process.env.AGILEHARNESS_RUNNER_STATE_DIR;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("grava uma linha por metade, com o SHA conferível (um bool afirma; um sha prova)", async () => {
    await recordLanding({ runId: "r1", board: "acme", cardId: "c1", half: "code", ref: "stage", sha: "abc1234" });
    await recordLanding({ runId: "r1", board: "acme", cardId: "c1", half: "data", ref: "main", sha: "def5678" });

    const all = await readLandings();
    expect(all).toHaveLength(2);
    expect(await readLanding("r1", "code")).toMatchObject({ v: 1, half: "code", ref: "stage", sha: "abc1234" });
    expect(await readLanding("r1", "data")).toMatchObject({ v: 1, half: "data", ref: "main", sha: "def5678" });
  });

  it("a metade VAZIA também registra (empty:true) — 'sem código' ≠ 'nunca tentou'", async () => {
    await recordLanding({ runId: "r2", board: "acme", half: "code", ref: "stage", sha: null, empty: true });
    const r = await readLanding("r2", "code");
    expect(r).toMatchObject({ half: "code", sha: null, empty: true });
  });

  it("idempotente por (runId, half): a recovery re-executa o passo ⇒ UMA linha, não duas", async () => {
    await recordLanding({ runId: "r3", board: "acme", half: "data", ref: "main", sha: "aaa" });
    await recordLanding({ runId: "r3", board: "acme", half: "data", ref: "main", sha: "bbb" });
    const all = await readLandings();
    expect(all.filter((r) => r.runId === "r3" && r.half === "data")).toHaveLength(1);
    // O PRIMEIRO fato vence — o recibo testemunha o que aconteceu, não o que a última tentativa achou.
    expect((await readLanding("r3", "data"))?.sha).toBe("aaa");
  });

  it("as duas metades do MESMO run são fatos distintos (a chave é o par, não só o runId)", async () => {
    await recordLanding({ runId: "r4", board: "acme", half: "code", ref: "stage", sha: "c0de" });
    await recordLanding({ runId: "r4", board: "acme", half: "data", ref: "main", sha: "da7a" });
    expect(await readLandings()).toHaveLength(2);
  });

  it("linha truncada/corrompida ⇒ tratada como ausente; o resto do ledger sobrevive e NADA lança", async () => {
    // Um ledger append-only VAI ter uma linha truncada um dia (restart no meio do write). Se a leitura
    // lançasse, o ledger derrubaria o train junto.
    await recordLanding({ runId: "r5", board: "acme", half: "code", ref: "stage", sha: "ok1" });
    await fsp.appendFile(ledger(), '{"v":1,"runId":"r6","half":"cod\n', "utf8"); // truncado
    await fsp.appendFile(ledger(), "não é json\n", "utf8");
    await fsp.appendFile(ledger(), '{"v":99,"runId":"r7","half":"code"}\n', "utf8"); // versão desconhecida
    await recordLanding({ runId: "r8", board: "acme", half: "data", ref: "main", sha: "ok2" });

    const all = await readLandings();
    expect(all.map((r) => r.runId)).toEqual(["r5", "r8"]); // as boas sobrevivem; as ruins somem
    expect(await readLanding("r6", "code")).toBeNull();
    expect(await readLanding("r7", "code")).toBeNull(); // uma linha em que não confio é uma linha que não tenho
  });

  it("ledger inexistente ⇒ [] (todo run PRÉ-ledger cai aqui) — nunca lança, nunca refuta", async () => {
    expect(await readLandings()).toEqual([]);
    expect(await readLanding("qualquer", "code")).toBeNull();
  });

  it("falha de escrita é NÃO-FATAL: o recibo é otimização, não pode derrubar a integração que deu certo", async () => {
    // Um ARQUIVO no lugar do diretório de estado ⇒ ENOTDIR no mkdir/append. É a forma mais barata de um IO
    // que falha de verdade (e falha RÁPIDO — apontar para /proc trava em vez de errar).
    const notADir = path.join(dir, "sou-um-arquivo");
    await fsp.writeFile(notADir, "");
    process.env.AGILEHARNESS_RUNNER_STATE_DIR = path.join(notADir, "runner");

    await expect(
      recordLanding({ runId: "r9", board: "acme", half: "code", ref: "stage", sha: "x" }),
    ).resolves.toBeUndefined();
  });
});
