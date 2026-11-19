import { describe, it, expect } from "vitest";
import { canDeploy, eligibleBidders, type BidderCapability } from "../lib/auction/worker-pool";
import {
  intent, valuation, minNextBid, minIncrement, pickRound, walkAwayPrice,
  type AgentProfile, type Market,
} from "../lib/agents/strategy";

const cap = (perBidCapMinor: number, over: Partial<BidderCapability> = {}): BidderCapability => ({
  perBidCapMinor, bids: 0, left: false, ...over,
});

const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  id: "0xaaaa", persona: "steady", perBidCapMinor: 1_000_000, watchlist: ["electronics"], ...over,
});

const market = (over: Partial<Market> = {}): Market => ({
  highestMinor: null, openingMinor: 100_000, leaderId: null, phase: "bidding", secondsLeft: null, bidCount: 0, ...over,
});

const item = { sku: "ELEC-1990-100", category: "electronics", openingMinor: 100_000 };

describe("pool guardrails", () => {
  it("stops deploying once the max-items limit is reached", () => {
    expect(canDeploy(0, 1)).toBe(true);
    expect(canDeploy(1, 1)).toBe(false);
    expect(canDeploy(3, 3)).toBe(false);
  });

  it("excludes bidders that left, hit the per-lot limit, or can't afford the amount", () => {
    const joined = [cap(500_000, { left: true }), cap(1_000_000, { bids: 8 }), cap(300_000), cap(900_000)];
    expect(eligibleBidders(joined, 400_000)).toEqual([3]);
  });
});

describe("strategy — market rules", () => {
  it("first bid may equal the opening ask; later bids must clear the increment", () => {
    expect(minNextBid(null, 150_000)).toBe(150_000);
    expect(minNextBid(400_000, 150_000)).toBe(500_000);
    expect(minIncrement(2_500_000)).toBe(250_000);
  });
});

describe("strategy — valuations are private, deterministic, capped", () => {
  it("is reproducible and never exceeds the owner's per-bid cap", () => {
    const p = profile();
    expect(valuation(p, item)).toBe(valuation(p, item));
    for (const persona of ["steady", "jumper", "sniper", "bargain", "collector"] as const) {
      const v = valuation(profile({ persona }), item);
      expect(v).toBeLessThanOrEqual(1_000_000);
      expect(v % 10_000).toBe(0);
    }
  });

  it("differs between agents on the same item", () => {
    const values = new Set(["0x1", "0x2", "0x3", "0x4", "0x5"].map((id) => valuation(profile({ id }), item)));
    expect(values.size).toBeGreaterThan(1);
  });

  it("values the favourite category higher than a secondary one", () => {
    const fav = valuation(profile({ watchlist: ["electronics", "art"] }), item);
    const sec = valuation(profile({ watchlist: ["art", "electronics"] }), item);
    expect(fav).toBeGreaterThan(sec);
  });

  it("bargain hunters walk away early", () => {
    expect(walkAwayPrice("bargain", 1_000_000)).toBe(700_000);
    expect(walkAwayPrice("steady", 1_000_000)).toBe(1_000_000);
  });
});

describe("strategy — personas", () => {
  it("never raises against itself", () => {
    expect(intent(profile(), 900_000, market({ leaderId: "0xAAAA", highestMinor: 300_000 })).act).toBe("wait");
  });

  it("drops out once the next valid bid passes its limit", () => {
    expect(intent(profile(), 400_000, market({ highestMinor: 400_000 })).act).toBe("drop");
  });

  it("steady raises by the minimum", () => {
    expect(intent(profile(), 900_000, market({ highestMinor: 300_000 }))).toMatchObject({ act: "bid", amountMinor: 400_000 });
  });

  it("jumper jumps early, raises normally later", () => {
    const p = profile({ persona: "jumper" });
    expect(intent(p, 900_000, market({ highestMinor: 200_000, bidCount: 1 }))).toMatchObject({ act: "bid", amountMinor: 500_000 });
    expect(intent(p, 900_000, market({ highestMinor: 500_000, bidCount: 4 }))).toMatchObject({ act: "bid", amountMinor: 600_000 });
  });

  it("sniper waits through bidding, strikes in the last seconds, never above its limit", () => {
    const p = profile({ persona: "sniper" });
    expect(intent(p, 900_000, market({ highestMinor: 300_000 })).act).toBe("wait");
    expect(intent(p, 900_000, market({ highestMinor: 300_000, phase: "countdown", secondsLeft: 5 })).act).toBe("wait");
    expect(intent(p, 900_000, market({ highestMinor: 300_000, phase: "countdown", secondsLeft: 3 }))).toMatchObject({ act: "bid", amountMinor: 500_000 });
    expect(intent(p, 420_000, market({ highestMinor: 300_000, phase: "countdown", secondsLeft: 2 }))).toMatchObject({ act: "bid", amountMinor: 420_000 });
  });

  it("an English auction converges: the highest valuation wins near the runner-up's limit", () => {
    const a = profile({ id: "0xa" });
    const b = profile({ id: "0xb" });
    const values = { "0xa": 650_000, "0xb": 900_000 } as Record<string, number>;
    let m = market();
    for (let round = 0; round < 30; round++) {
      const proposals = [a, b].flatMap((p) => {
        const it = intent(p, values[p.id], m);
        return it.act === "bid" ? [{ id: p.id, amountMinor: it.amountMinor }] : [];
      });
      const pick = pickRound(proposals, `r${round}`);
      if (!pick) break;
      m = { ...m, highestMinor: pick.amountMinor, leaderId: pick.id, bidCount: m.bidCount + 1 };
    }
    expect(m.leaderId).toBe("0xb");
    expect(m.highestMinor).toBeLessThanOrEqual(900_000);
    expect(m.highestMinor).toBeGreaterThanOrEqual(600_000);
  });
});

describe("pickRound", () => {
  it("recognises the highest proposal; ties break deterministically", () => {
    expect(pickRound([], "k")).toBeNull();
    expect(pickRound([{ id: "a", amountMinor: 1 }, { id: "b", amountMinor: 2 }], "k")?.id).toBe("b");
    const tie = [{ id: "a", amountMinor: 5 }, { id: "b", amountMinor: 5 }];
    expect(pickRound(tie, "k")?.id).toBe(pickRound(tie, "k")?.id);
  });
});
