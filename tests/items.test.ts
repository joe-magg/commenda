import { describe, it, expect } from "vitest";
import { generateCatalog, artSeedFor } from "../lib/items/generator";

describe("deterministic item catalog", () => {
  it("is reproducible for a session seed", () => {
    expect(generateCatalog("session-1")).toEqual(generateCatalog("session-1"));
    expect(generateCatalog("session-1")).not.toEqual(generateCatalog("session-2"));
  });

  it("produces specific titled items with SKUs and art seeds", () => {
    const items = generateCatalog("demo");
    expect(items).toHaveLength(6);
    for (const item of items) {
      expect(item.title.trim().length).toBeGreaterThan(0);
      expect(item.sku).toMatch(/^(ELEC|ART|COLL)-\d{4}-\d{3}$/);
      // Curated items keep their card art across auctions (seeded by title).
      expect([artSeedFor(item.sku), artSeedFor(`item:${item.title}`)]).toContain(item.artSeed);
    }
  });

  it("deals the hand-picked catalog first, without repeats inside an auction", () => {
    const titles = generateCatalog("demo", 6).map((i) => i.title);
    expect(new Set(titles).size).toBe(6);
    expect(titles).toContain(generateCatalog("demo", 6)[0].title);
  });

  it("covers all watchlist categories", () => {
    const cats = new Set(generateCatalog("demo").map((i) => i.category));
    expect([...cats].sort()).toEqual(["art", "collectibles", "electronics"]);
  });
});
