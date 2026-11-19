"use client";

/**
 * Tiny Web Audio cues — no audio library, no package install, no credits.
 * Short synthesized blips keep the UI responsive without competing with the
 * ElevenLabs narration. All calls are no-ops until the user enables sound.
 */
export type Sfx = "bid" | "outbid" | "countdown" | "sold" | "mine" | "youOutbid" | "youWon";

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function blip(
  freq: number,
  ms: number,
  peak: number,
  delay = 0,
  type: OscillatorType = "sine",
): void {
  const ac = context();
  if (!ac) return;
  const start = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + ms / 1000);
  osc.connect(gain).connect(ac.destination);
  osc.start(start);
  osc.stop(start + ms / 1000 + 0.02);
}

export function playSfx(cue: Sfx): void {
  switch (cue) {
    case "bid":
      blip(880, 70, 0.05);
      break;
    case "outbid":
      blip(440, 110, 0.04);
      break;
    case "countdown":
      blip(1200, 45, 0.022);
      break;
    case "sold":
      blip(523, 160, 0.06, 0, "triangle");
      blip(784, 220, 0.05, 0.08, "sine");
      break;
    // YOUR agent gets its own voice in the mix: a bright rising pair when it
    // bids, a soft falling pair when someone takes the lead from it, and a
    // major arpeggio when it wins. Rivals keep the plain single blip.
    case "mine":
      blip(988, 60, 0.06);
      blip(1319, 90, 0.05, 0.06);
      break;
    case "youOutbid":
      blip(659, 90, 0.045, 0, "triangle");
      blip(494, 140, 0.04, 0.09, "triangle");
      break;
    case "youWon":
      blip(523, 140, 0.07, 0, "triangle");
      blip(659, 140, 0.06, 0.11);
      blip(784, 160, 0.06, 0.22);
      blip(1047, 320, 0.06, 0.33);
      break;
  }
}
