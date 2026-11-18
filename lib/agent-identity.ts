/** Stable, distinct visual identity per agent — derived from its id, no storage. */
const HUES = [188, 262, 32, 148, 340, 96, 216, 12];
const GLYPHS = ["◆", "▲", "●", "■", "✦", "⬟", "★", "❖"];

function hash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

export function agentIdentity(id: string): { hue: number; glyph: string; color: string; soft: string } {
  const h = hash(id);
  const idx = h % HUES.length;
  const hue = HUES[idx];
  return {
    hue,
    glyph: GLYPHS[idx],
    color: `hsl(${hue} 70% 42%)`,
    soft: `hsla(${hue} 70% 52% / 0.14)`,
  };
}
