import { describe, it, expect } from "vitest";
import { AuctionState } from "../lib/auction/state";
import { submitBid, commit, BroadcastError, type ChainPort } from "../lib/auction/submit-bid";
import type { Bid, Mandate } from "../lib/auction/decide";

const bid: Bid = { id: "b1", lotId: "lot-1", amountMinor: 1000, category: "electronics", seller: "seller-ok" };
const mandate = (over: Partial<Mandate> = {}): Mandate => ({
  agentId: "agent-1", budgetMinor: 10_000, spentMinor: 0, perBidCapMinor: 2_000,
  watchlist: new Set(["electronics"]), sellerAllowlist: new Set(["seller-ok"]),
  killSwitch: false, approvalEnabled: false, approvalAboveMinor: 1500,
  approvedKeys: new Set(), seenKeys: new Set(), consecutiveFailures: 0,
  maxConsecutiveFailures: 3, recentBidTimesMs: [], maxBidsPerWindow: 20, windowMs: 60_000, ...over,
});

const fakeChain = (over: Partial<ChainPort> = {}): ChainPort => ({
  syncEvents: async () => ({ events: [], latestBlock: 100n }),
  submitPlaceBid: async () => ({ txHash: "0xabc", fromBlock: 100n }),
  ...over,
});

const deps = (chain: ChainPort, payer = "payer-1") => ({
  chain,
  resolveAgentId: (p: string) => (p === "payer-1" ? "agent-1" : null),
  payer,
  now: () => 1000,
});

describe("submitBid", () => {
  it("places a valid bid and records in-flight with the full next", async () => {
    const s = new AuctionState();
    s.setMandate("agent-1", mandate());
    const r = await submitBid(s, bid, deps(fakeChain()));
    expect(r.status).toBe("placed");
    expect(s.inFlight.size).toBe(1);
    const entry = [...s.inFlight.values()][0];
    expect(entry.next.spentMinor).toBe(1000); // full next persisted (D1)
    expect(entry.txHash).toBe("0xabc");
  });

  it("rejects without submitting when guardrail fails", async () => {
    const s = new AuctionState();
    s.setMandate("agent-1", mandate({ killSwitch: true }));
    let submitted = false;
    const r = await submitBid(s, bid, deps(fakeChain({ submitPlaceBid: async () => { submitted = true; return { txHash: "x", fromBlock: 1n }; } })));
    expect(r.status).toBe("rejected");
    expect(r.status === "rejected" && r.rule).toBe("KILL_SWITCH");
    expect(submitted).toBe(false);
    expect(s.inFlight.size).toBe(0);
  });

  it("returns needs_approval without submitting", async () => {
    const s = new AuctionState();
    s.setMandate("agent-1", mandate({ approvalEnabled: true, approvalAboveMinor: 500 }));
    const r = await submitBid(s, bid, deps(fakeChain()));
    expect(r.status).toBe("needs_approval");
    expect(s.inFlight.size).toBe(0);
  });

  it("returns busy while an in-flight entry exists", async () => {
    const s = new AuctionState();
    s.setMandate("agent-1", mandate());
    s.addInFlight({ bidKey: "k", agentId: "agent-1", createdAt: 1000, next: mandate(), bid, fromBlock: 1n, status: "pending" });
    const r = await submitBid(s, bid, deps(fakeChain()));
    expect(r.status).toBe("busy");
  });

  it("increments only failures on broadcast throw, no in-flight", async () => {
    const s = new AuctionState();
    s.setMandate("agent-1", mandate());
    const r = await submitBid(s, bid, deps(fakeChain({ submitPlaceBid: async () => { throw new Error("rpc"); } })));
    expect(r.status).toBe("failed");
    expect(s.getMandate("agent-1")!.consecutiveFailures).toBe(1);
    expect(s.getMandate("agent-1")!.spentMinor).toBe(0); // no charge committed
    expect(s.inFlight.size).toBe(0);
  });

  it("no_agent for an unknown payer", async () => {
    const s = new AuctionState();
    const r = await submitBid(s, bid, deps(fakeChain(), "stranger"));
    expect(r.status).toBe("no_agent");
  });

  it("keeps a pending entry when the broadcast throws AFTER a hash (review 4.1)", async () => {
    const s = new AuctionState();
    s.setMandate("agent-1", mandate());
    const chain = fakeChain({
      submitPlaceBid: async () => { throw new BroadcastError("receipt unavailable", "0xlost"); },
    });
    const r = await submitBid(s, bid, deps(chain));
    expect(r.status).toBe("pending");
    expect(r.status === "pending" && r.txHash).toBe("0xlost");
    const e = [...s.inFlight.values()][0];
    expect(e.txHash).toBe("0xlost");
    expect(e.next.spentMinor).toBe(1000); // decide's next preserved for the resolver
    expect(s.getMandate("agent-1")!.consecutiveFailures).toBe(0); // not a definite failure
  });

  it("treats a definite pre-hash failure as failed", async () => {
    const s = new AuctionState();
    s.setMandate("agent-1", mandate());
    const chain = fakeChain({
      submitPlaceBid: async () => { throw new Error("rpc down"); },
    });
    const r = await submitBid(s, bid, deps(chain));
    expect(r.status).toBe("failed");
    expect(s.inFlight.size).toBe(0);
    expect(s.getMandate("agent-1")!.consecutiveFailures).toBe(1);
  });

  it("reports every decide() outcome via onDecision (finding 3)", async () => {
    const s = new AuctionState();
    s.setMandate("agent-1", mandate());
    const seen: string[] = [];
    const r = await submitBid(s, bid, { ...deps(fakeChain()), onDecision: (a) => seen.push(a.rule) });
    expect(r.status).toBe("placed");
    expect(seen).toEqual(["BID"]);

    const s2 = new AuctionState();
    s2.setMandate("agent-1", mandate({ killSwitch: true }));
    const rejected: string[] = [];
    await submitBid(s2, bid, { ...deps(fakeChain()), onDecision: (a) => rejected.push(a.rule) });
    expect(rejected).toEqual(["KILL_SWITCH"]);
  });

  it("survives an onDecision sink that throws (audit must never break bidding)", async () => {
    const s = new AuctionState();
    s.setMandate("agent-1", mandate());
    const r = await submitBid(s, bid, { ...deps(fakeChain()), onDecision: () => { throw new Error("db"); } });
    expect(r.status).toBe("placed");
  });

  it("applies outbid credits from synced events before deciding", async () => {
    const s = new AuctionState();
    s.setMandate("agent-1", mandate({ spentMinor: 2000 }));
    const chain = fakeChain({
      syncEvents: async () => ({
        events: [{
          kind: "BidPlaced", lotId: 1n, bidder: "agent-2", amount: 2500n,
          prevBidder: "agent-1", prevAmount: 2000n, seller: "seller-ok",
          key: { blockNumber: 10n, logIndex: 0 },
        }],
        latestBlock: 100n,
      }),
    });
    const r = await submitBid(s, bid, deps(chain));
    // credit applied before deciding: spent 2000 -> 0. The new bid's +1000 lives
    // in the in-flight entry's `next` and is committed by the resolver on confirmation.
    expect(r.status).toBe("placed");
    expect(s.getMandate("agent-1")!.spentMinor).toBe(0);
    expect([...s.inFlight.values()][0].next.spentMinor).toBe(1000);
  });
});

describe("commit", () => {
  it("applies event credits to the CURRENT mandate, preserving decide-managed state", async () => {
    const s = new AuctionState();
    s.setMandate("agent-1", mandate({ spentMinor: 2000, seenKeys: new Set(["k1"]) }));
    const events = [{
      kind: "BidPlaced" as const, lotId: 1n, bidder: "agent-2", amount: 2500n,
      prevBidder: "agent-1", prevAmount: 2000n, seller: "seller-ok",
      key: { blockNumber: 10n, logIndex: 0 },
    }];
    await commit(s, "agent-1", events);
    const m = s.getMandate("agent-1")!;
    expect(m.spentMinor).toBe(0); // outbid credit applied
    expect(m.seenKeys.has("k1")).toBe(true); // decide-managed state untouched
  });

  it("never adopts a caller-supplied stale snapshot (review 2.1)", async () => {
    const s = new AuctionState();
    s.setMandate("agent-1", mandate({ spentMinor: 500, killSwitch: false }));
    const staleNext = mandate({ spentMinor: 1500, killSwitch: true });
    await commit(s, "agent-1", []);
    const m = s.getMandate("agent-1")!;
    expect(m.spentMinor).toBe(500); // unchanged by the discarded snapshot
    expect(m.killSwitch).toBe(false);
  });
});
