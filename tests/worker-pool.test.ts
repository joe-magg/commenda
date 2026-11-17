import { describe, it, expect } from "vitest";
import { eligibleBidders, nextBidAmount, type BidderCapability } from "../lib/auction/worker-pool";

const cap = (perBidCapMinor: number, over: Partial<BidderCapability> = {}): BidderCapability => ({
  perBidCapMinor, bids: 0, left: false, ...over,
});

describe("worker pool selection", () => {
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
});
