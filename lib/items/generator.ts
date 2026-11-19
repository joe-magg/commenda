/**
 * Deterministic catalog generation for a session. No AI calls, no credits:
 * a seed produces a fixed block of specific, named items with a stable SKU and
 * an art seed used to render per-item SVG.
 */
import { createHash } from "node:crypto";
import type { Lot } from "@/lib/auction/lots";
import { DEMO_SELLER } from "@/lib/auction/lots";
import catalogConfig from "@/config/catalog.json";

export type Category = "electronics" | "art" | "collectibles";

export type GeneratedItem = {
  id: number;
  title: string;
  sku: string;
  category: Category;
  artSeed: string;
  openingMinor: number;
};

const GRAMMAR: Record<Category, { code: string; adjectives: string[]; materials: string[]; nouns: string[] }> = {
  electronics: {
    code: "ELEC",
    adjectives: ["Vintage", "Refurbished", "Rare", "Classic", "Limited"],
    materials: ["Brass", "Walnut", "Steel", "Bakelite", "Aluminium"],
    nouns: ["Film Camera", "Mechanical Keyboard", "Cassette Deck", "Turntable", "Field Recorder"],
  },
  art: {
    code: "ART",
    adjectives: ["Numbered", "Framed", "Original", "Signed", "Studio"],
    materials: ["Oil", "Ink", "Watercolour", "Charcoal", "Acrylic"],
    nouns: ["Gallery Print", "Canvas Study", "Lithograph", "Sketchbook", "Poster"],
  },
  collectibles: {
    code: "COLL",
    adjectives: ["First-Edition", "Sealed", "Graded", "Antique", "Mint"],
    materials: ["Coin", "Comic", "Stamp", "Trading Card", "Pocket Watch"],
    nouns: ["Set", "Issue", "Collection", "Album", "Piece"],
  },
};


function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];

export function artSeedFor(sku: string): string {
  return createHash("sha256").update(sku).digest("hex").slice(0, 16);
}

/** Fixed category order so a generated catalog exercises all watchlists. */
const ORDER: Category[] = ["electronics", "art", "collectibles", "electronics", "art", "collectibles"];

const SAFE_TITLE = /^[A-Za-z0-9 ,'-]{1,60}$/;

/** The hand-picked demo catalog (config/catalog.json): item names per
 *  category. Names that the auctioneer couldn't safely speak are skipped. */
function curated(): Record<Category, string[]> {
  const raw = catalogConfig as Record<string, unknown>;
  const out = { electronics: [], art: [], collectibles: [] } as Record<Category, string[]>;
  for (const cat of Object.keys(out) as Category[]) {
    const list = Array.isArray(raw[cat]) ? (raw[cat] as unknown[]) : [];
    for (const t of list) {
      if (typeof t === "string" && SAFE_TITLE.test(t.trim())) out[cat].push(t.trim());
    }
  }
  return out;
}

export function generateCatalog(seed: string, count = 6): GeneratedItem[] {
  const rng = mulberry32(hashString(seed));
  const pool = curated();
  // Shuffle each category's curated list once per auction, then deal in order.
  const decks = Object.fromEntries((Object.keys(pool) as Category[]).map((c) => {
    const d = [...pool[c]];
    for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
    return [c, d];
  })) as Record<Category, string[]>;
  return Array.from({ length: count }, (_, id) => {
    const category = ORDER[id % ORDER.length];
    const g = GRAMMAR[category];
    const curatedTitle = decks[category].shift();
    const title = curatedTitle ?? `${pick(rng, g.adjectives)} ${pick(rng, g.materials)} ${pick(rng, g.nouns)}`;
    const year = 1950 + Math.floor(rng() * 70);
    const sku = `${g.code}-${year}-${String(100 + id * 37).padStart(3, "0")}`;
    return {
      id,
      title,
      sku,
      category,
      // Curated items keep the same card art in every auction (seeded by title).
      artSeed: artSeedFor(curatedTitle ? `item:${title}` : sku),
      openingMinor: [300_000, 500_000, 750_000][Math.floor(rng() * 3)], // 0.30 / 0.50 / 0.75
    };
  });
}

/**
 * Globally unique on-chain lot ids for one auction: epoch seconds × 100 + the
 * lot index. Two auctions never start in the same second (the scheduler gap
 * is ≥ 30s), so a new auction can never reuse a settled lot id — even across
 * restarts. Stays well inside Number.MAX_SAFE_INTEGER.
 */
export function chainLotBase(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000) * 100;
}

/** Map a generated catalog onto the engine's Lot shape. */
export function itemsToLots(items: readonly GeneratedItem[], base = chainLotBase()): Lot[] {
  return items.slice(0, 99).map((item, i) => ({
    id: item.id,
    chainId: base + i,
    title: item.title,
    category: item.category,
    seller: DEMO_SELLER,
    openingMinor: item.openingMinor,
    accent: "#6b7280",
    sku: item.sku,
    artSeed: item.artSeed,
  }));
}
