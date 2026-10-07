// O RITMO DA COTA — o que o anel da barra do topo diz no hover: «Cota da assinatura · 7 dias».
//
// Um número de uso sozinho ("usou 31%") não responde a pergunta do dono, que é «posso deixar o board andar?».
// 31% no 2º dia é muito; 31% no 6º é folga. A régua é o ESPERADO HOJE — a fração da janela de 7 dias que já
// passou —, e o veredito compara as duas. PURO (o rig de teste é node, sem DOM).

/** A janela da assinatura: 7 dias, em minutos. */
export const QUOTA_WINDOW_MIN = 7 * 24 * 60;

/** Quantos pontos percentuais de folga contam como "no ritmo" (para cima ou para baixo). */
export const QUOTA_PACE_BAND = 10;

export type QuotaVerdict = "below" | "on" | "above";

export interface QuotaPace {
  /** % usado da janela (0..100, arredondado). */
  usedPct: number;
  /** % da janela que já passou — o "esperado hoje" (0..100, arredondado). null = não sei quando zera. */
  expectedPct: number | null;
  /** o dia da janela (1..7), quando se sabe o reset. */
  day: number | null;
  verdict: QuotaVerdict | null;
  /** «Bem abaixo do ritmo» · «No ritmo» · «Acima do ritmo» (null sem esperado). */
  verdictLabel: string | null;
  /** a frase de ajuda — o que o número quer dizer para o board. */
  help: string;
}

const VERDICT_LABEL: Record<QuotaVerdict, string> = {
  below: "Bem abaixo do ritmo",
  on: "No ritmo",
  above: "Acima do ritmo",
};

/** "3,5" — uma casa decimal com vírgula, sem ",0". */
function fmtDays(d: number): string {
  const r = Math.round(d * 10) / 10;
  return (Number.isInteger(r) ? String(r) : r.toFixed(1)).replace(".", ",");
}

/**
 * O que o BOARD da tela permite sugerir (o texto de ajuda só fala do que existe): as vagas de condutor dele (null = o
 * board não usa condutor, ou a tela não é de board) e se o escopo está em «Só consertos».
 */
export interface QuotaBoardContext {
  conductorSlots?: number | null;
  scopeFixes?: boolean;
}

/** «Sobra cota: dá para ligar o 2º condutor ou voltar o escopo para Tudo.» — só as alavancas que o board tem. */
function slackWords(ctx: QuotaBoardContext): string {
  const levers = [
    ...(ctx.conductorSlots === 1 ? ["ligar o 2º condutor"] : []),
    ...(ctx.scopeFixes ? ["voltar o escopo para Tudo"] : []),
  ];
  return levers.length ? `Sobra cota: dá para ${levers.join(" ou ")}.` : "Sobra cota: dá para o board andar mais rápido.";
}

/** «Sugestão: andar devagar ou 1 condutor.» — o «1 condutor» só quando o board tem mais de uma vaga. */
function brakeWords(ctx: QuotaBoardContext): string {
  return ctx.conductorSlots != null && ctx.conductorSlots > 1 ? "Sugestão: andar devagar ou 1 condutor." : "Sugestão: andar devagar.";
}

/**
 * O ritmo da cota a partir do % usado e de quantos minutos faltam para a janela zerar. `resetsInMinutes`
 * null/negativo/maior que a janela ⇒ não se sabe onde estamos na semana: sem esperado, sem veredito — só o uso.
 * `ctx` diz que alavancas o board da tela tem (o texto de ajuda só sugere essas).
 */
export function quotaPace(usedPct: number, resetsInMinutes: number | null | undefined, ctx: QuotaBoardContext = {}): QuotaPace {
  const used = Math.max(0, Math.min(100, usedPct));
  const usedR = Math.round(used);
  const known =
    typeof resetsInMinutes === "number" && Number.isFinite(resetsInMinutes) && resetsInMinutes >= 0 && resetsInMinutes <= QUOTA_WINDOW_MIN;
  if (!known) {
    return { usedPct: usedR, expectedPct: null, day: null, verdict: null, verdictLabel: null, help: `Usou ${usedR}% da cota desta semana.` };
  }
  const elapsed = 1 - resetsInMinutes / QUOTA_WINDOW_MIN; // 0..1
  const expected = elapsed * 100;
  const expectedR = Math.round(expected);
  const day = Math.min(7, Math.max(1, Math.ceil(elapsed * 7)));
  const diff = used - expected;
  const verdict: QuotaVerdict = diff < -QUOTA_PACE_BAND ? "below" : diff > QUOTA_PACE_BAND ? "above" : "on";
  const head = `Usou ${usedR}% com ${expectedR}% da janela passada.`;
  let tail: string;
  if (verdict === "below") {
    tail = slackWords(ctx);
  } else if (elapsed <= 0 || used <= 0) {
    tail = "";
  } else {
    // A projeção no passo de hoje: quanto a semana fecha (≤100%) ou em quantos dias a cota acaba.
    const projected = used / elapsed;
    if (projected <= 100) tail = `Neste passo a cota fecha a semana perto de ${Math.round(projected)}%.`;
    else {
      const daysToEnd = (7 * elapsed * 100) / used;
      tail = `Neste passo a cota acaba em cerca de ${fmtDays(daysToEnd)} dias. ${brakeWords(ctx)}`;
    }
  }
  return {
    usedPct: usedR,
    expectedPct: expectedR,
    day,
    verdict,
    verdictLabel: VERDICT_LABEL[verdict],
    help: tail ? `${head} ${tail}` : head,
  };
}

/** O traço do anel (svg r=14, circunferência ≈ 88): "<cheio> 88". */
export function ringDash(usedPct: number | null): string {
  const pct = usedPct == null || !Number.isFinite(usedPct) ? 0 : Math.max(0, Math.min(100, usedPct));
  return `${((pct / 100) * 88).toFixed(1)} 88`;
}
