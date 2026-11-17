import { describe, it, expect } from "vitest";
import { AuctionState, Mutex, type InFlightEntry } from "../lib/auction/state";
import { resolveEntry, resolveAll, type TxOutcome } from "../lib/auction/inflight";
import { bidKey, type Bid, type Mandate } from "../lib/auction/decide";

const bid: Bid = { id: "b1", lotId: "lot-1", amountMinor: 1000, category: "electronics", seller: "seller-ok" };
const mandate = (): Mandate => ({
  agentId: "agent-1", budgetMinor: 10_000, spentMinor: 0, perBidCapMinor: 2_000,
  watchlist: new Set(["electronics"]), sellerAllowlist: new Set(["seller-ok"]),
  killSwitch: false, approvalEnabled: false, approvalAboveMinor: 1500,
  approvedKeys: new Set(), seenKeys: new Set(), consecutiveFailures: 0,
  maxConsecutiveFailures: 3, recentBidTimesMs: [], maxBidsPerWindow: 20, windowMs: 60_000,
});
const entry = (over: Partial<InFlightEntry> = {}): InFlightEntry => ({
  bidKey: bidKey("agent-1", bid), agentId: "agent-1", txHash: "0xabc",
  createdAt: 1000, next: mandate(), bid, fromBlock: 10n, status: "pending", ...over,
});

describe("Mutex", () => {
  it("serializes critical sections", async () => {
    const m = new Mutex();
    const order: number[] = [];
    const p1 = m.run(async () => { await new Promise((r) => setTimeout(r, 10)); order.push(1); });
    const p2 = m.run(() => { order.push(2); });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("releases the lock even when fn throws", async () => {
    const m = new Mutex();
    await expect(m.run(() => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(m.run(() => "ok")).resolves.toBe("ok");
  });
});

describe("AuctionState inFlight / BUSY", () => {
  it("detects in-flight per agent", () => {
    const s = new AuctionState();
    expect(s.hasInFlight("agent-1")).toBe(false);
    s.addInFlight(entry());
    expect(s.hasInFlight("agent-1")).toBe(true);
    expect(s.hasInFlight("agent-2")).toBe(false);
    s.removeInFlight(bidKey("agent-1", bid));
    expect(s.hasInFlight("agent-1")).toBe(false);
  });
});

describe("resolveEntry", () => {
  it("commits on success", async () => {
    const s = new AuctionState();
    const e = entry();
    const committed: TxOutcome[] = [];
    const r = await resolveEntry(s, e, {
      resolveTx: async () => ({ status: "success", blockNumber: 10n, events: [] }),
      commit: async (_, o) => { committed.push(o); },
      now: () => 2000,
    });
    expect(r).toBe("committed");
    expect(committed[0].status).toBe("success");
  });

  it("increments failures on revert via commit", async () => {
    const s = new AuctionState();
    const committed: TxOutcome[] = [];
    const r = await resolveEntry(s, entry(), {
      resolveTx: async () => ({ status: "reverted" }),
      commit: async (_, o) => { committed.push(o); },
      now: () => 2000,
    });
    expect(r).toBe("failed");
    expect(committed[0].status).toBe("reverted");
  });

  it("retains on unknown outcome", async () => {
    const s = new AuctionState();
    let committed = false;
    const r = await resolveEntry(s, entry(), {
      resolveTx: async () => ({ status: "unknown" }),
      commit: async () => { committed = true; },
      now: () => 2000,
    });
    expect(r).toBe("retained");
    expect(committed).toBe(false);
  });

  it("escalates stale entries to manual (via commit with unknown)", async () => {
    const s = new AuctionState();
    let sawUnknown = false;
    const r = await resolveEntry(s, entry({ createdAt: 0 }), {
      resolveTx: async () => { throw new Error("should not be called"); },
      commit: async (_, o) => { sawUnknown = o.status === "unknown"; },
      now: () => 200_000,
      deadlineMs: 120_000,
    });
    expect(r).toBe("manual");
    expect(sawUnknown).toBe(true);
  });

  it("retains entries not yet broadcast (no txHash)", async () => {
    const s = new AuctionState();
    const r = await resolveEntry(s, entry({ txHash: undefined }), {
      resolveTx: async () => { throw new Error("should not be called"); },
      commit: async () => {},
      now: () => 2000,
    });
    expect(r).toBe("retained");
  });
});

describe("resolveAll", () => {
  it("skips manual entries", async () => {
    const s = new AuctionState();
    s.addInFlight(entry({ bidKey: "k1", status: "needs_manual_intervention" }));
    let calls = 0;
    const counts = await resolveAll(s, {
      resolveTx: async () => { calls++; return { status: "success", blockNumber: 1n, events: [] }; },
      commit: async () => {},
      now: () => 2000,
    });
    expect(calls).toBe(0);
    expect(counts.committed).toBe(0);
  });
});
