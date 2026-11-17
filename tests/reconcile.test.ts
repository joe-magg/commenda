import { describe, it, expect } from "vitest";
import { reconcile, compareEventKey, type ChainEvent, type IngestState } from "../lib/auction/reconcile";
import type { Mandate } from "../lib/auction/decide";

const key = (block: number, log: number) => ({ blockNumber: BigInt(block), logIndex: log });

const mandate = (spent = 0): Mandate => ({
  agentId: "agent-1",
  budgetMinor: 10_000,
  spentMinor: spent,
  perBidCapMinor: 2_000,
  watchlist: new Set(["electronics"]),
  sellerAllowlist: new Set(["seller-ok"]),
  killSwitch: false,
  approvalEnabled: false,
  approvalAboveMinor: 1_500,
  approvedKeys: new Set(),
  seenKeys: new Set(),
  consecutiveFailures: 0,
  maxConsecutiveFailures: 3,
  recentBidTimesMs: [],
  maxBidsPerWindow: 20,
  windowMs: 60_000,
});

const bidPlaced = (over: Partial<Extract<ChainEvent, { kind: "BidPlaced" }>> = {}): ChainEvent => ({
  kind: "BidPlaced",
  lotId: 7n,
  bidder: "agent-2",
  amount: 2_500n,
  prevBidder: "agent-1",
  prevAmount: 2_000n,
  seller: "seller-ok",
  key: key(10, 0),
  ...over,
});

const ingest = (): IngestState => ({ cursor: null, seen: new Set() });

describe("reconcile — H1 credits", () => {
  it("credits the outbid bidder's spentMinor", () => {
    const mandates = new Map([["agent-1", mandate(2_000)]]);
    const r = reconcile(mandates, ingest(), [bidPlaced()]);
    expect(r.mandates.get("agent-1")!.spentMinor).toBe(0);
    expect(r.applied).toHaveLength(1);
  });

  it("handles self-raise as a net delta (prevBidder == bidder)", () => {
    // decide() added full 3_000 to spent (1_000 -> 4_000); contract refunds old 1_000.
    const mandates = new Map([["agent-1", mandate(4_000)]]);
    const r = reconcile(mandates, ingest(), [
      bidPlaced({ bidder: "agent-1", prevBidder: "agent-1", amount: 3_000n, prevAmount: 1_000n }),
    ]);
    expect(r.mandates.get("agent-1")!.spentMinor).toBe(3_000); // 4_000 - 1_000
  });

  it("credits EmergencyRefund", () => {
    const mandates = new Map([["agent-1", mandate(2_000)]]);
    const ev: ChainEvent = { kind: "EmergencyRefund", lotId: 7n, bidder: "agent-1", amount: 2_000n, key: key(11, 0) };
    const r = reconcile(mandates, ingest(), [ev]);
    expect(r.mandates.get("agent-1")!.spentMinor).toBe(0);
  });

  it("LotSettled consumes budget (no credit)", () => {
    const mandates = new Map([["agent-1", mandate(2_000)]]);
    const ev: ChainEvent = { kind: "LotSettled", lotId: 7n, bidder: "agent-1", amount: 2_000n, seller: "seller-ok", key: key(11, 0) };
    const r = reconcile(mandates, ingest(), [ev]);
    expect(r.mandates.get("agent-1")!.spentMinor).toBe(2_000);
  });
});

describe("reconcile — idempotency & ordering", () => {
  it("does not double-credit on replay of the same event key", () => {
    const mandates = new Map([["agent-1", mandate(2_000)]]);
    const first = reconcile(mandates, ingest(), [bidPlaced()]);
    const second = reconcile(first.mandates, first.ingest, [bidPlaced()]); // same key
    expect(second.mandates.get("agent-1")!.spentMinor).toBe(0);
    expect(second.applied).toHaveLength(0);
  });

  it("compares block numbers numerically, not as strings", () => {
    expect(compareEventKey(key(9, 5), key(10, 0))).toBeLessThan(0);
    expect(compareEventKey(key(10, 0), key(9, 5))).toBeGreaterThan(0);
    expect(compareEventKey(key(10, 2), key(10, 3))).toBeLessThan(0);
  });

  it("skips events at or before the cursor", () => {
    const start: IngestState = { cursor: key(10, 0), seen: new Set() };
    const r = reconcile(new Map([["agent-1", mandate(2_000)]]), start, [bidPlaced({ key: key(10, 0) })]);
    expect(r.applied).toHaveLength(0);
  });
});

describe("reconcile — bigint bounds", () => {
  it("ignores amounts above MAX_SAFE_INTEGER and warns", () => {
    const mandates = new Map([["agent-1", mandate(2_000)]]);
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const r = reconcile(mandates, ingest(), [bidPlaced({ prevAmount: huge })]);
    expect(r.mandates.get("agent-1")!.spentMinor).toBe(2_000); // unchanged
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});
