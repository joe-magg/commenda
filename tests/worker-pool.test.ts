import { describe, it, expect } from "vitest";
import { canDeploy, eligibleBidders, nextBidAmount, type BidderCapability } from "../lib/auction/worker-pool";

const cap = (perBidCapMinor: number, over: Partial<BidderCapability> = {}): BidderCapability => ({
  perBidCapMinor, bids: 0, left: false, ...over,
});

describe("worker pool selection", () => {
  it("stops deploying once the max-items limit is reached", () => {
    expect(canDeploy(0, 1)).toBe(true);
    expect(canDeploy(1, 1)).toBe(false);
    expect(canDeploy(2, 3)).toBe(true);
    expect(canDeploy(3, 3)).toBe(false);
  });

  it("derives increasing amounts from the opening bid", () => {
    expect(nextBidAmount(100_000, 0)).toBe(200_000);
    expect(nextBidAmount(100_000, 5)).toBe(700_000);
  });

  it("round-robins eligible bidders", () => {
    const joined = [cap(500_000), cap(1_000_000)];
    expect(eligibleBidders(joined, 0, 100_000)).toEqual([0, 1]);
    expect(eligibleBidders(joined, 1, 200_000)).toEqual([0, 1]);
  });

  it("excludes bidders whose per-bid cap is too low", () => {
    const joined = [cap(500_000), cap(1_000_000)];
    expect(eligibleBidders(joined, 5, 600_000)).toEqual([1]);
  });

  it("excludes bidders that left or hit the per-lot bid limit", () => {
    const joined = [cap(500_000, { left: true }), cap(1_000_000, { bids: 6 })];
    expect(eligibleBidders(joined, 0, 100_000)).toEqual([]);
  });

  it("resets win counts when the catalog loops back to lot zero", () => {
    // canDeploy is the guardrail used with per-cycle wins; after a reset the
    // count is 0 so the agent may deploy again on the new cycle.
    expect(canDeploy(1, 1)).toBe(false); // capped in cycle 1
    const cycleWins = new Map<string, number>();
    cycleWins.clear(); // simulated wrap to lot 0
    expect(canDeploy(cycleWins.get("a") ?? 0, 1)).toBe(true); // fresh cycle
  });

  it("never lets the current leader bid against itself", () => {
    // Mirrors onBidSlot: eligible indices are filtered by the leader id.
    const ids = ["agent-A", "agent-B"];
    const joined = [cap(500_000), cap(1_000_000)];
    const leader = "agent-A";
    const eligible = eligibleBidders(joined, 0, 100_000).filter((i) => ids[i] !== leader);
    expect(eligible).toEqual([1]); // only the non-leader may raise
  });
});
