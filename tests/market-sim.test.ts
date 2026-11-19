/**
 * Market simulation over the REAL roster (config/agents.json) and generated
 * catalogs — no chain, no x402. Pins the property the demo depends on: lots
 * are genuinely contested (several bids, varied winners, prices under caps),
 * not a two-bid formality. Uses the same pure strategy + floor rules the
 * live pool runs (one hand per round; soft close lets snipers strike).
 */
import { describe, it, expect } from "vitest";
import roster from "../config/agents.json";
import { intent, pickRound, valuation, type AgentProfile, type Market } from "../lib/agents/strategy";
import { generateCatalog } from "../lib/items/generator";

type Sim = { bids: number; winner: string | null; price: number; lateBids: number };

function simulateLot(item: ReturnType<typeof generateCatalog>[number]): Sim {
  const agents = (roster as { id: string; strategy?: string; perBidCapMinor: number; watchlist: string[] }[])
    .filter((a) => a.watchlist.includes(item.category))
    .map((a) => {
      const p: AgentProfile = { id: a.id, persona: (a.strategy ?? "steady") as AgentProfile["persona"], perBidCapMinor: a.perBidCapMinor, watchlist: a.watchlist };
      return { p, v: valuation(p, item), out: false };
    });
  let m: Market = { highestMinor: null, openingMinor: item.openingMinor, leaderId: null, phase: "bidding", secondsLeft: null, bidCount: 0 };
  let lateBids = 0;
  for (let round = 0; round < 40; round++) {
    const proposals = agents.flatMap((a) => {
      if (a.out) return [];
      const it = intent(a.p, a.v, m);
      if (it.act === "drop") a.out = true;
      return it.act === "bid" ? [{ id: a.p.id, amountMinor: it.amountMinor }] : [];
    });
    const pick = pickRound(proposals, `${item.sku}:${m.bidCount}`);
    if (pick) {
      if (m.phase === "countdown") lateBids++;
      m = { ...m, highestMinor: pick.amountMinor, leaderId: pick.id, bidCount: m.bidCount + 1, phase: "bidding", secondsLeft: null };
      continue;
    }
    if (m.phase === "bidding") { m = { ...m, phase: "countdown", secondsLeft: 6 }; continue; }
    if ((m.secondsLeft ?? 0) <= 1) break;
    m = { ...m, secondsLeft: (m.secondsLeft ?? 0) - 1 };
  }
  return { bids: m.bidCount, winner: m.leaderId, price: m.highestMinor ?? 0, lateBids };
}

describe("market simulation — lots are genuinely contested", () => {
  const items = Array.from({ length: 20 }, (_, i) => generateCatalog(`sim-${i}`, 3)).flat();
  const results = items.map(simulateLot);

  it("most lots draw several bids", () => {
    const sorted = results.map((r) => r.bids).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    expect(median).toBeGreaterThanOrEqual(4);
    expect(median).toBeLessThanOrEqual(14); // a lot must fit a short show
    expect(results.filter((r) => r.bids === 0).length).toBeLessThan(results.length / 10);
  });

  it("winners vary across agents and personas", () => {
    expect(new Set(results.map((r) => r.winner)).size).toBeGreaterThanOrEqual(5);
  });

  it("snipers actually strike late in a meaningful share of lots", () => {
    expect(results.filter((r) => r.lateBids > 0).length).toBeGreaterThanOrEqual(results.length / 5);
  });

  it("no lot ever clears above the highest per-bid cap", () => {
    const maxCap = Math.max(...(roster as { perBidCapMinor: number }[]).map((a) => a.perBidCapMinor));
    for (const r of results) expect(r.price).toBeLessThanOrEqual(maxCap);
  });
});
