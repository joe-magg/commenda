/**
 * Deterministic portrait card art for a lot's HoloCard — seeded by the item's
 * art seed, no text (the old hex stamp was unreadable), no external assets.
 * Rendered as a data-URI SVG so HoloCard can upload it as a WebGL texture.
 */

type Palette = { bgLow: string; bgHigh: string; a: string; b: string; ink: string };

// Bright but paper-like: light grounds with two saturated accents each.
const PALETTES: Palette[] = [
  { bgLow: "#e8f4fb", bgHigh: "#c3e5f4", a: "#00a9d6", b: "#0b3f63", ink: "#123a52" },
  { bgLow: "#f3efe4", bgHigh: "#e6dcc3", a: "#b8862b", b: "#0b3f63", ink: "#4a3a14" },
  { bgLow: "#eef0fb", bgHigh: "#d8dcf6", a: "#7c6cf0", b: "#0b3f63", ink: "#2a2650" },
  { bgLow: "#e9f6ef", bgHigh: "#cdeadd", a: "#3ecf8e", b: "#0b3f63", ink: "#14503a" },
  { bgLow: "#fdeee8", bgHigh: "#f8d8cb", a: "#ff7a59", b: "#0b3f63", ink: "#5c2415" },
  { bgLow: "#eaf3f6", bgHigh: "#d0e6ee", a: "#7fd6ff", b: "#b8862b", ink: "#163a47" },
];

function hash32(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * Portrait 630×880 card face. Three composition families keep the set coherent:
 * a rising disc, a strung arc, and an orbited polygon — all with one satellite.
 */
export function cardArtDataUri(seed: string): string {
  const h = hash32(seed.toLowerCase());
  const p = PALETTES[h % PALETTES.length];
  const family = Math.floor(h / PALETTES.length) % 3;
  const rot = ((Math.floor(h / (PALETTES.length * 3)) % 24) - 12) * 0.9;

  // Seeded geometry (0..630 x 0..880 safe ranges)
  const cx = 240 + (h % 150);
  const cy = 300 + (Math.floor(h / 7) % 140);
  const r = 150 + (Math.floor(h / 13) % 80);
  const dot1x = 90 + (Math.floor(h / 17) % 120);
  const dot1y = 620 + (Math.floor(h / 23) % 140);
  const poly = `${120 + (h % 60)},${560 - (Math.floor(h / 29) % 60)} ${320 + (Math.floor(h / 31) % 60)},${300 + (Math.floor(h / 37) % 60)} ${520 - (Math.floor(h / 41) % 60)},${540 + (Math.floor(h / 43) % 60)}`;

  const composition =
    family === 0
      ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${p.a}" opacity="0.82"/>
         <circle cx="${630 - dot1x}" cy="${dot1y}" r="34" fill="none" stroke="${p.b}" stroke-width="10" opacity="0.8"/>
         <polygon points="${poly}" fill="none" stroke="${p.ink}" stroke-width="7" stroke-linejoin="round" opacity="0.55" transform="rotate(${rot} 315 440)"/>`
      : family === 1
        ? `<path d="M ${cx - r} ${cy + 120} A ${r} ${r} 0 0 1 ${cx + r} ${cy + 120}" fill="none" stroke="${p.a}" stroke-width="26" stroke-linecap="round" opacity="0.85"/>
           <path d="M ${cx - r * 0.55} ${cy + 130} A ${r * 0.55} ${r * 0.55} 0 0 1 ${cx + r * 0.55} ${cy + 130}" fill="none" stroke="${p.b}" stroke-width="18" stroke-linecap="round" opacity="0.75"/>
           <circle cx="${cx}" cy="${cy - r * 0.7}" r="42" fill="${p.ink}" opacity="0.85"/>`
        : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${p.a}" stroke-width="22" opacity="0.85"/>
           <circle cx="${cx}" cy="${cy}" r="${r * 0.55}" fill="${p.b}" opacity="0.28"/>
           <polygon points="${poly}" fill="${p.a}" opacity="0.5" transform="rotate(${-rot} 315 440)"/>
           <circle cx="${dot1x}" cy="${dot1y}" r="26" fill="${p.ink}" opacity="0.8"/>`;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="630" height="880" viewBox="0 0 630 880">` +
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="0.7" y2="1">` +
    `<stop offset="0" stop-color="${p.bgLow}"/><stop offset="1" stop-color="${p.bgHigh}"/>` +
    `</linearGradient></defs>` +
    `<rect width="630" height="880" fill="url(#bg)"/>` +
    `<rect x="26" y="26" width="578" height="828" rx="34" fill="none" stroke="rgba(255,255,255,0.65)" stroke-width="4"/>` +
    `<rect x="40" y="40" width="550" height="800" rx="26" fill="none" stroke="${p.ink}" stroke-opacity="0.12" stroke-width="3"/>` +
    `<g>${composition}</g>` +
    `</svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
