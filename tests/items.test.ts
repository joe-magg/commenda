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
      expect(item.title.split(" ").length).toBeGreaterThanOrEqual(3);
      expect(item.sku).toMatch(/^(ELEC|ART|COLL)-\d{4}-\d{3}$/);
      expect(item.artSeed).toBe(artSeedFor(item.sku));
      expect(item.condition).toBeTruthy();
      expect(item.provenance).toBeTruthy();
    }
  });

  it("covers all watchlist categories", () => {
    const cats = new Set(generateCatalog("demo").map((i) => i.category));
    expect([...cats].sort()).toEqual(["art", "collectibles", "electronics"]);
  });
});
