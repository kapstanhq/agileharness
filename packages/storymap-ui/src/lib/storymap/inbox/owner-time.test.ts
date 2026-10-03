// A HORA DO DONO: o relógio do Inbox saía no fuso do SERVIDOR (o processo num fuso, o dono noutro); uma execução que
// morreu às 03:07Z aparecia como «04:07» em vez de «21:07» da véspera. Toda hora e data das
// superfícies do Inbox sai agora no fuso configurado do dono (`governor.timezone`), resolvido no servidor e passado à
// tela: o mesmo texto no SSR e na hidratação, qualquer que seja o fuso do processo ou do navegador.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { approvalAbsentState } from "@/components/inicio/cockpit-labels";
import { formatDecisionText, localTimeFormatter, relativeWithClock, timeToken } from "./copy";

const governor = vi.hoisted(() => ({ timezone: "America/Chicago" as string | undefined }));
vi.mock("../runner/config", async (orig) => {
  const real = await orig<typeof import("../runner/config")>();
  return { ...real, loadRunnerConfig: () => ({ ...real.loadRunnerConfig(), governor: { timezone: governor.timezone } }) };
});
const { resolvedOwnerTimeZone, hostTimeZone } = await import("../owner-timezone");

const OWNER_TZ = "America/Chicago";
const DIED = "2026-01-14T03:07:00.000Z"; // 21:07 do dia 13 em Chicago, 04:07 do dia 14 em Berlim
const NOW = Date.parse("2026-01-14T03:20:00.000Z");

let prevTz: string | undefined;
beforeAll(() => {
  prevTz = process.env.TZ;
  process.env.TZ = "Europe/Berlin"; // o processo num fuso DIFERENTE do dono (a VPS)
});
afterAll(() => {
  if (prevTz === undefined) delete process.env.TZ;
  else process.env.TZ = prevTz;
});

describe("um instante fixo sai no relógio do dono, seja qual for o fuso do processo", () => {
  it("controle: sem o fuso do dono, o processo em Berlim escreveria 04:07 — o teste discrimina", () => {
    expect(relativeWithClock(DIED, NOW)).toBe("há 13 min · 04:07");
  });

  it.each(["Europe/Berlin", "UTC", "Asia/Tokyo"])("«há 13 min · 21:07» — a idade e o relógio do dono, com o processo em %s", (processTz) => {
    process.env.TZ = processTz;
    try {
      expect(relativeWithClock(DIED, NOW, OWNER_TZ)).toBe("há 13 min · 21:07");
      expect(localTimeFormatter(NOW, OWNER_TZ).at(Date.parse(DIED))).toBe("hoje às 21:07");
      // o controle: o fuso do processo mudou de verdade (sem o do dono, o relógio acompanha o processo)
      expect(relativeWithClock(DIED, NOW)).toBe({ "Europe/Berlin": "há 13 min · 04:07", UTC: "há 13 min · 03:07", "Asia/Tokyo": "há 13 min · 12:07" }[processTz]);
    } finally {
      process.env.TZ = "Europe/Berlin";
    }
  });

  it("os marcadores do texto (o «Se ignorar», os recibos, o desfecho) e o «hoje/ontem» são os do dono", () => {
    const fmt = localTimeFormatter(NOW, OWNER_TZ);
    expect(fmt.at(Date.parse(DIED))).toBe("hoje às 21:07"); // em Berlim já seria «amanhã»/14
    expect(formatDecisionText(`Decidido ${timeToken(DIED)}.`, fmt)).toBe("Decidido hoje às 21:07.");
    // o dia de uma data de mais de 24 h, no fuso do dono: 03:30Z do dia 15 é 21:30 do dia 14 em Chicago
    expect(relativeWithClock("2026-01-15T03:30:00.000Z", Date.parse("2026-01-16T12:00:00.000Z"), OWNER_TZ)).toBe("há 1 dia · 14/01");
  });

  it("uma DATA pura (a proposta de PRD nasce com o dia) é o dia do calendário — não vira a véspera no fuso do dono", () => {
    expect(relativeWithClock("2026-01-09", NOW, OWNER_TZ)).toBe("há 5 dias · 09/01");
  });

  it("o primeiro render (relógio 0) não depende do relógio de ninguém: escreve o dia, nunca «hoje»", () => {
    expect(localTimeFormatter(0, OWNER_TZ).at(Date.parse(DIED))).toBe("13/01 às 21:07");
  });

  it("o desfecho de um pedido decidido tarde da noite diz o dia do dono, não o dia em UTC", () => {
    const s = approvalAbsentState({ status: "granted", decidedAt: "2026-01-15T03:30:00.000Z" });
    expect(formatDecisionText(s.detail, localTimeFormatter(NOW, OWNER_TZ))).toMatch(/^Autorizado em 14\/01 —/);
  });
});

describe("o fuso que a tela recebe", () => {
  it("é o `governor.timezone` configurado; inválido ou ausente, o do host — sempre um nome concreto", () => {
    governor.timezone = "America/Chicago";
    expect(resolvedOwnerTimeZone()).toBe("America/Chicago");
    governor.timezone = "Marte/Base";
    expect(resolvedOwnerTimeZone()).toBe(hostTimeZone());
    governor.timezone = undefined;
    expect(resolvedOwnerTimeZone()).toBe(hostTimeZone());
    expect(hostTimeZone()).toMatch(/\w/);
    governor.timezone = "America/Chicago";
  });

  it("o layout raiz o resolve no servidor e o entrega a toda tela", () => {
    const layout = readFileSync(fileURLToPath(new URL("../../../app/layout.tsx", import.meta.url)), "utf8");
    expect(layout).toMatch(/<OwnerTimeZoneProvider timeZone=\{resolvedOwnerTimeZone\(\)\}>\{children\}<\/OwnerTimeZoneProvider>/);
  });

  it("nenhuma tela formata hora sem o fuso do dono (nem cai no relógio do navegador no primeiro render)", () => {
    const root = fileURLToPath(new URL("../../../components", import.meta.url));
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = path.join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".tsx")) files.push(p);
      }
    };
    walk(root);
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/localTimeFormatter\(([^)]*)\)/g)) if (!/,\s*tz\b/.test(m[1])) offenders.push(`${path.basename(f)}: localTimeFormatter(${m[1]})`);
      for (const m of src.matchAll(/relativeWithClock\(([^)]*)\)/g)) if (!/,\s*tz\b/.test(m[1])) offenders.push(`${path.basename(f)}: relativeWithClock(${m[1]})`);
      if (/now \|\| Date\.now\(\)/.test(src) && /localTimeFormatter/.test(src)) offenders.push(`${path.basename(f)}: now || Date.now()`);
    }
    expect(offenders).toEqual([]);
    const publish = readFileSync(path.join(root, "inbox/PublishStatusModal.tsx"), "utf8");
    expect(publish).toMatch(/localWhen\(state\.data\.deployFiredAt, tz\)/);
  });
});
