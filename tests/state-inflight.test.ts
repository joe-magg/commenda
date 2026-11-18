import { describe, it, expect } from "vitest";
import { AuctionState, Mutex, type InFlightEntry } from "../lib/auction/state";
import { resolveEntry, resolveAll, escalateManual, mergeCommittedNext, type TxOutcome } from "../lib/auction/inflight";
import { bidKey, type Bid, type Mandate } from "../lib/auction/decide";

const bid: Bid = { id: "b1", lotId: "lot-1", amountMinor: 1000, category: "electronics", seller: "seller-ok" };
const mandate = (over: Partial<Mandate> = {}): Mandate => ({
  agentId: "agent-1", budgetMinor: 10_000, spentMinor: 0, perBidCapMinor: 2_000,
  watchlist: new Set(["electronics"]), sellerAllowlist: new Set(["seller-ok"]),
  killSwitch: false, approvalEnabled: false, approvalAboveMinor: 1500,
  approvedKeys: new Set(), seenKeys: new Set(), consecutiveFailures: 0,
  maxConsecutiveFailures: 3, recentBidTimesMs: [], maxBidsPerWindow: 20, windowMs: 60_000, ...over,
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

  it("does NOT block on a manual entry (finding 4: no permanent busy wedge)", () => {
    const s = new AuctionState();
    s.addInFlight(entry({ status: "needs_manual_intervention" }));
    expect(s.hasInFlight("agent-1")).toBe(false);
    expect(s.inFlight.size).toBe(1); // registry keeps it for observability
  });
});

describe("escalateManual (review 1.1/1.2)", () => {
  it("charges conservatively and records the idempotency key", () => {
    const s = new AuctionState();
    s.setMandate("agent-1", mandate());
    const e = entry();
    s.addInFlight(e);
    escalateManual(s, e);
    const m = s.getMandate("agent-1")!;
    expect(m.spentMinor).toBe(bid.amountMinor);
    expect(m.seenKeys.has(bidKey("agent-1", bid))).toBe(true);
    expect(s.inFlight.get(e.bidKey)?.status).toBe("needs_manual_intervention");
  });

  it("never drives spentMinor negative", () => {
    const s = new AuctionState();
    s.setMandate("agent-1", mandate({ spentMinor: 0 }));
    escalateManual(s, entry());
    expect(s.getMandate("agent-1")!.spentMinor).toBe(bid.amountMinor);
  });
});

describe("mergeCommittedNext (finding 5 / review 2.1)", () => {
  it("takes policy (incl. killSwitch) from current, decide-managed from next", () => {
    const cur = mandate({ killSwitch: true, budgetMinor: 5_000, spentMinor: 300 });
    const next = mandate({ killSwitch: false, budgetMinor: 10_000, spentMinor: 1_300, seenKeys: new Set(["k2"]) });
    const merged = mergeCommittedNext(cur, next, bid);
    expect(merged.killSwitch).toBe(true); // pending bid must not resurrect a flipped switch
    expect(merged.budgetMinor).toBe(5_000);
    expect(merged.spentMinor).toBe(1_300); // current 300 + this bid 1000
    expect(merged.seenKeys.has("k2")).toBe(true);
  });

  it("unions seenKeys so a conservative manual key is never un-recorded", () => {
    const cur = mandate({ seenKeys: new Set(["k-manual"]) });
    const next = mandate({ seenKeys: new Set(["k-new"]) });
    const merged = mergeCommittedNext(cur, next, bid);
    expect(merged.seenKeys.has("k-manual")).toBe(true);
    expect(merged.seenKeys.has("k-new")).toBe(true);
  });

  it("clamps spentMinor at zero when credits drove current to zero", () => {
    const cur = mandate({ spentMinor: 0 });
    const merged = mergeCommittedNext(cur, mandate({ spentMinor: 1000 }), bid);
    expect(merged.spentMinor).toBe(1000);
  });

  it("returns next unchanged when no current mandate exists", () => {
    const next = mandate({ spentMinor: 1000 });
    expect(mergeCommittedNext(undefined, next, bid)).toBe(next);
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
