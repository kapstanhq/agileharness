// O bloco `vps:` — o limite semanal e o medidor são do HOST do operador, nunca da máquina de origem.
import { describe, expect, it, vi } from "vitest";
import { coerceVpsSettings, vpsOf } from "./vps-settings";
import { coerceRunnerSettings } from "./runner/config";

describe("vps — coerção tolerante", () => {
  it("aceita um limite inteiro positivo e um medidor em loopback (sem a barra final)", () => {
    expect(coerceVpsSettings({ weeklyTokenLimit: 400_000_000, headroomUrl: "http://127.0.0.1:9100/" }, () => {})).toEqual({
      weeklyTokenLimit: 400_000_000,
      headroomUrl: "http://127.0.0.1:9100",
    });
    expect(coerceVpsSettings({ weeklyTokenLimit: 12.9 }, () => {})).toEqual({ weeklyTokenLimit: 12 });
  });

  it("descarta, peça a peça e COM aviso, o que não tem forma", () => {
    const avisos: string[] = [];
    const out = coerceVpsSettings(
      { weeklyTokenLimit: -3, headroomUrl: "http://proxy.example:9100" },
      (m) => avisos.push(m),
    );
    expect(out).toBeUndefined();
    expect(avisos).toHaveLength(2);
    expect(avisos.join("\n")).toMatch(/weeklyTokenLimit/);
    expect(avisos.join("\n")).toMatch(/headroomUrl/);
  });

  it("recusa limite não-numérico/zero/gigante e URL com credencial, sem porta, com caminho ou fora de loopback", () => {
    for (const weeklyTokenLimit of [0, "512000000", Number.NaN, Infinity, 1e14, null, [1]]) expect(coerceVpsSettings({ weeklyTokenLimit }, () => {})).toBeUndefined();
    for (const headroomUrl of ["http://u:p@127.0.0.1:9100", "http://127.0.0.1", "http://127.0.0.1:9100/stats?x=1", "http://127.0.0.1:9100/sub", "ftp://127.0.0.1:21", "http://10.1.1.1:9100", "", 7]) {
      expect(coerceVpsSettings({ headroomUrl }, () => {})).toBeUndefined();
    }
  });

  it("sem o bloco, ou com um valor que não é mapa, não há vps — e nunca lança", () => {
    for (const raw of [undefined, null, 3, "x", [], {}]) expect(() => coerceVpsSettings(raw, () => {})).not.toThrow();
    expect(coerceVpsSettings(undefined)).toBeUndefined();
    expect(coerceVpsSettings({}, () => {})).toBeUndefined();
  });
});

describe("vpsOf — «não declarado» é {}", () => {
  it("sem declaração não devolve limite nem endereço", () => {
    expect(vpsOf(undefined)).toEqual({});
    expect(vpsOf({})).toEqual({});
    expect(vpsOf({ vps: { weeklyTokenLimit: 5 } })).toEqual({ weeklyTokenLimit: 5 });
  });

  it("chega pelo coerceRunnerSettings (e some quando o arquivo não o declara)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(coerceRunnerSettings({ vps: { weeklyTokenLimit: 99, headroomUrl: "http://localhost:8123" } }).vps).toEqual({ weeklyTokenLimit: 99, headroomUrl: "http://localhost:8123" });
    expect(coerceRunnerSettings({}).vps).toBeUndefined();
    vi.restoreAllMocks();
  });
});
