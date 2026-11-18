import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetTrace, analyze } from "../lib/auction/trace";
import type { Lot } from "../lib/auction/lots";
import type { BidOutcome } from "../lib/auction/engine";

// Controllable fake for the paid-bid client; the pool must never bypass it.
const bidderState = vi.hoisted(() => ({
  impl: (_agent: unknown, _bid: unknown): Promise<BidOutcome> =>
    Promise.resolve({ ok: true, amountMinor: 0, bidder: "agent-A", txHash: "0x1" }),
  calls: 0,
}));

vi.mock("../lib/auction/bidder", () => ({
  getPaidAgents: () => [
    { id: "agent-A", label: "Agent A", key: "0xac" as const },
    { id: "agent-B", label: "Agent B", key: "0xbc" as const },
  ],
  placeBid: (agent: unknown, bid: unknown) => {
    bidderState.calls++;
    return bidderState.impl(agent, bid);
  },
}));

vi.mock("@/lib/db/repo", () => ({
  listAgents: () => [
    {
      id: "agent-A", enabled: true, walletAddress: "0xac",
      policy: { budgetMinor: 10_000_000, perBidCapMinor: 2_000_000, watchlist: ["electronics"], sellerAllowlist: [], approvalEnabled: false, approvalAboveMinor: 0, maxWins: 3 },
    },
    {
      id: "agent-B", enabled: true, walletAddress: "0xbc",
      policy: { budgetMinor: 10_000_000, perBidCapMinor: 2_000_000, watchlist: ["electronics"], sellerAllowlist: [], approvalEnabled: false, approvalAboveMinor: 0, maxWins: 3 },
    },
  ],
}));

const { BidWorkerPool } = await import("../lib/auction/worker-pool");

const lot: Lot = {
  id: 0, chainId: 900001, title: "Test Lot", category: "electronics",
  seller: "0x3333333333333333333333333333333333333333", openingMinor: 100_000,
  accent: "#0ea5e9", sku: "TEST-1", artSeed: "abcd1234",
};

function outcomeFor(agentId: string): BidOutcome {
  return { ok: true, amountMinor: 0, bidder: agentId, txHash: "0x1" };
}

beforeEach(() => {
  bidderState.impl = (agent, bid) =>
    Promise.resolve({
      ok: true,
      amountMinor: (bid as { amountMinor: number }).amountMinor,
      bidder: (agent as { id: string }).id,
      txHash: "0x1",
    });
  bidderState.calls = 0;
  resetTrace();
});

describe("BidWorkerPool behavioral invariants", () => {
  it("never runs two slots at once: an unresolved slot blocks the next", async () => {
    const pool = new BidWorkerPool();
    pool.onLotOpen(lot, lot.chainId);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    bidderState.impl = () => new Promise((r) => { gate.then(() => r(outcomeFor("agent-A"))); });

    const first = pool.onBidSlot(lot, 0, lot.chainId);
    const second = await pool.onBidSlot(lot, 1, lot.chainId);
    expect(second).toBeNull(); // slot busy — no concurrent bids
    expect(bidderState.calls).toBe(1);
    release();
    const resolved = await first;
    expect(resolved?.ok).toBe(true);
    // the deferred slot can now run
    const third = await pool.onBidSlot(lot, 1, lot.chainId);
    expect(third?.ok).toBe(true);
    expect(bidderState.calls).toBe(2);
  });

  it("never lets the leader re-bid: no self-outbid over a full lot", async () => {
    const pool = new BidWorkerPool();
    pool.onLotOpen(lot, lot.chainId);
    const leaders: (string | null)[] = [];
    const bidders: string[] = [];
    for (let slot = 0; slot < 4; slot++) {
      const outcome = await pool.onBidSlot(lot, slot, lot.chainId);
      if (outcome?.ok) {
        expect(outcome.bidder).not.toBe(leaders[leaders.length - 1] ?? null); // invariant
        leaders.push(outcome.bidder);
        bidders.push(outcome.bidder);
      }
    }
    // The two agents must alternate — never the same bidder twice in a row.
    for (let i = 1; i < bidders.length; i++) {
      expect(bidders[i]).not.toBe(bidders[i - 1]);
    }
  });

  it("a pending outcome does not claim leadership", async () => {
    const pool = new BidWorkerPool();
    pool.onLotOpen(lot, lot.chainId);
    bidderState.impl = () => Promise.resolve({ ok: false, agentId: "agent-A", rule: "PENDING", amountMinor: 200_000 });
    const outcome = await pool.onBidSlot(lot, 0, lot.chainId);
    expect(outcome?.ok).toBe(false);
    // leader is still unset: the next slot may pick either agent
    const a = analyze();
    expect(a.selfOutbids).toHaveLength(0);
    expect(a.lots[0]).toMatchObject({ pending: 1, placed: 0 });
  });

  it("a busy or failed outcome releases the slot for the next bid", async () => {
    const pool = new BidWorkerPool();
    pool.onLotOpen(lot, lot.chainId);
    bidderState.impl = () => Promise.resolve({ ok: false, agentId: "agent-A", rule: "busy", amountMinor: 200_000 });
    await pool.onBidSlot(lot, 0, lot.chainId);
    bidderState.impl = (agent, bid) =>
      Promise.resolve({
        ok: true,
        amountMinor: (bid as { amountMinor: number }).amountMinor,
        bidder: (agent as { id: string }).id,
        txHash: "0x1",
      });
    const second = await pool.onBidSlot(lot, 1, lot.chainId);
    expect(second?.ok).toBe(true);
    expect(bidderState.calls).toBe(2);
  });

  it("resets slotBusy when the lot ends (stale slot must not wedge the next lot)", async () => {
    const pool = new BidWorkerPool();
    pool.onLotOpen(lot, lot.chainId);
    // simulate a slot that never resolved (e.g. bidder threw mid-flight)
    (pool as unknown as { lots: Map<number, { slotBusy: boolean }> }).lots.get(lot.chainId)!.slotBusy = true;
    pool.onLotEnd(lot.chainId, null);
    pool.onLotOpen({ ...lot, chainId: lot.chainId + 1000 }, lot.chainId + 1000);
    const outcome = await pool.onBidSlot({ ...lot, chainId: lot.chainId + 1000 }, 0, lot.chainId + 1000);
    expect(outcome?.ok).toBe(true);
  });
});
