/**
 * Server-side receipt metadata: a data: URI containing JSON whose `image` is
 * an embedded SVG data URI. Fully self-contained on-chain — no IPFS.
 */
import { artSeedFor } from "./generator";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildReceiptUri(item: {
  title: string;
  sku: string;
  amountMinor: number;
  artSeed?: string;
}, winner: string): string {
  const seed = item.artSeed ?? artSeedFor(item.sku);
  const n = (i: number, mod: number) => parseInt(seed.slice(i, i + 4), 16) % mod;
  const hue = n(0, 360);
  const hue2 = (hue + 40 + n(4, 60)) % 360;
  const cx = 90 + n(4, 140);
  const cy = 90 + n(8, 140);
  const r = 55 + n(12, 45);
  const rot = n(0, 80);
  const poly = `${60 + n(2, 70)},${230 - n(6, 70)} ${200 + n(8, 60)},${60 + n(10, 70)} ${340 - n(12, 70)},${220 + n(14, 60)}`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 22% 90%)"/><stop offset="1" stop-color="hsl(${hue2} 20% 70%)"/></linearGradient></defs>
<rect width="400" height="400" rx="28" fill="url(#g)"/>
<g transform="rotate(${rot} 200 200)" opacity="0.8">
<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsl(${hue2} 32% 52%)"/>
<polygon points="${poly}" fill="none" stroke="hsl(${hue} 30% 38%)" stroke-width="4"/>
</g>
<circle cx="200" cy="200" r="150" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="3"/>
<text x="200" y="372" text-anchor="middle" font-family="monospace" font-size="18" fill="hsl(${hue} 22% 28%)">${esc(item.sku)}</text>
<text x="200" y="52" text-anchor="middle" font-family="sans-serif" font-size="22" font-weight="700" fill="hsl(${hue} 22% 28%)">${esc(item.title)}</text>
</svg>`;

  const json = {
    name: `${item.title} — Commenda Receipt`,
    description: `Non-transferable receipt for a physical item won in a Commenda flash auction. Winner: ${winner}. Redemption simulated.`,
    image: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    attributes: [
      { trait_type: "SKU", value: item.sku },
      { trait_type: "Winning bid (USDC)", value: (item.amountMinor / 1_000_000).toFixed(2) },
      { trait_type: "Soulbound", value: "true" },
    ],
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(json)).toString("base64")}`;
}
