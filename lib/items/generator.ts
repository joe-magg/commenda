/**
 * Deterministic catalog generation for a session. No AI calls, no credits:
 * a seed produces a fixed block of specific, named items with a stable SKU and
 * an art seed used to render per-item SVG.
 */
import { createHash } from "node:crypto";
import type { Lot } from "@/lib/auction/lots";
import { LOTS } from "@/lib/auction/lots";

export type Category = "electronics" | "art" | "collectibles";

export type GeneratedItem = {
  id: number;
  title: string;
  sku: string;
  category: Category;
  condition: string;
  provenance: string;
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

const CONDITIONS = ["Excellent", "Very good", "Restored", "As found", "Fair"];
const PROVENANCE = ["Private collection", "Estate sale find", "Original owner", "Gallery archive", "Auction consignment"];

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

export function generateCatalog(seed: string, count = 6): GeneratedItem[] {
  const rng = mulberry32(hashString(seed));
  return Array.from({ length: count }, (_, id) => {
    const category = ORDER[id % ORDER.length];
    const g = GRAMMAR[category];
    const title = `${pick(rng, g.adjectives)} ${pick(rng, g.materials)} ${pick(rng, g.nouns)}`;
    const year = 1950 + Math.floor(rng() * 70);
    const sku = `${g.code}-${year}-${String(100 + id * 37).padStart(3, "0")}`;
    return {
      id,
      title,
      sku,
      category,
      condition: pick(rng, CONDITIONS),
      provenance: pick(rng, PROVENANCE),
      artSeed: artSeedFor(sku),
      openingMinor: 100_000,
    };
  });
}

/** Map a generated catalog onto the engine's Lot shape, reusing chain ids. */
export function itemsToLots(items: readonly GeneratedItem[]): Lot[] {
  return items.map((item, i) => ({
    id: item.id,
    chainId: LOTS[i]?.chainId ?? 100_000 + i,
    title: item.title,
    category: item.category,
    seller: LOTS[i]?.seller ?? "0x3333333333333333333333333333333333333333",
    openingMinor: item.openingMinor,
    accent: "#6b7280",
    sku: item.sku,
    artSeed: item.artSeed,
  }));
}
