// Sound channel — a dependency-free WebAudio "earcon" per event type, so a human
// watching the board hears when an agent (or the UI) does CRUD. No audio assets:
// short oscillator tones, each event type with its own shape.
//
// Browsers block audio until a user gesture; call unlock() from a click handler
// (the toggle in NotificationCenter does this) to create/resume the context.

import type { AgentAlert, AgentAlertKind, NotificationChannel, AgileHarnessEvent, AgileHarnessEventType } from "../event";

type Tone = { freqs: number[]; step: number; duration: number };

// Distinct, recognizable motifs: created rises, deleted falls, moved is a quick
// two-note hop, plain updates a single blip, board config a low neutral tone.
const TONES: Record<AgileHarnessEventType, Tone> = {
  "card.created": { freqs: [523.25, 783.99], step: 0.09, duration: 0.12 }, // C5→G5 up
  "card.moved": { freqs: [659.25, 880.0], step: 0.08, duration: 0.11 }, // E5→A5 hop
  "card.updated": { freqs: [587.33], step: 0, duration: 0.1 }, // D5 blip
  "card.deleted": { freqs: [440.0, 329.63], step: 0.09, duration: 0.12 }, // A4→E4 down
  "board.updated": { freqs: [493.88], step: 0, duration: 0.12 }, // B4 neutral
};

/**
 * Os AVISOS têm um timbre PRÓPRIO, e de propósito bem diferente dos blips de CRUD acima: um card que
 * mudou é ruído de fundo do board; um terminal esperando você é uma batida na porta. Duas notas
 * DESCENDENTES repetidas (a "batida") não se confundem com nenhum dos motivos ascendentes de evento.
 */
const ALERT_TONES: Record<AgentAlertKind, Tone> = {
  // batida dupla, grave e insistente — "vem cá"
  "terminal-waiting": { freqs: [739.99, 587.33, 739.99, 587.33], step: 0.13, duration: 0.14 },
  // uma nota só, macia — "acabei"
  "terminal-quiet": { freqs: [523.25], step: 0, duration: 0.16 },
  // três notas DESCENDENTES, graves e lentas — "isto parou". Distinta da batida do terminal de propósito:
  // ela não pede que você vá a um terminal, avisa que a entrega travou.
  "publish-blocked": { freqs: [493.88, 415.3, 349.23], step: 0.16, duration: 0.18 },
};

export class SoundChannel implements NotificationChannel {
  readonly id = "sound";
  private ctx?: AudioContext;

  /** Create/resume the AudioContext. Must run inside a user gesture. */
  unlock(): void {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx ??= new Ctor();
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  notify(event: AgileHarnessEvent): void {
    this.play(TONES[event.type], 0.16);
  }

  /** Um AVISO do agente — timbre próprio (ALERT_TONES) e um pouco mais alto que o blip de CRUD:
   *  ele existe para tirar o operador de outra tela, não para pontuar o board. */
  alert(alert: AgentAlert): void {
    const tone = ALERT_TONES[alert.kind];
    if (tone) this.play(tone, alert.urgency === "blocking" ? 0.22 : 0.14);
  }

  /** O motor de sopro, único: uma nota por frequência, com envelope curto. Sem contexto destravado
   *  (o navegador exige um gesto do usuário) é um no-op silencioso. */
  private play(tone: Tone, peak: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    tone.freqs.forEach((freq, i) => {
      const start = ctx.currentTime + i * tone.step;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(peak, start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, start + tone.duration);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + tone.duration + 0.02);
    });
  }
}
