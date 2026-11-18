import { describe, it, expect, beforeEach } from "vitest";
import { record, analyze, resetTrace, snapshot } from "../lib/auction/trace";

describe("auction trace", () => {
  beforeEach(() => resetTrace());

  it("records events into the ring buffer", () => {
    record({ kind: "lot_open", at: 1, chainLotId: 7, displayId: 0 });
    record({ kind: "bid_outcome", source: "client", at: 2, agentId: "a", chainLotId: 7, amountMinor: 100, status: "placed", msClient: 120, msServer: 60 });
    expect(snapshot()).toHaveLength(2);
  });

  it("caps the buffer", () => {
    for (let i = 0; i < 5000; i++) {
      record({ kind: "bid_attempt", at: i, agentId: "a", chainLotId: 1, amountMinor: 1, slot: 0 });
    }
    expect(snapshot().length).toBeLessThanOrEqual(4000);
  });

  it("flags self-outbids: same agent, consecutive successful bids, one lot", () => {
    record({ kind: "bid_outcome", source: "client", at: 1, agentId: "x", chainLotId: 9, amountMinor: 100, status: "placed" });
    record({ kind: "bid_outcome", source: "client", at: 2, agentId: "y", chainLotId: 9, amountMinor: 200, status: "placed" });
    record({ kind: "bid_outcome", source: "client", at: 3, agentId: "x", chainLotId: 9, amountMinor: 300, status: "placed" });
    // x -> y -> x is a legitimate duel; x -> x on one lot is not.
    record({ kind: "bid_outcome", source: "client", at: 4, agentId: "x", chainLotId: 10, amountMinor: 100, status: "placed" });
    record({ kind: "bid_outcome", source: "client", at: 5, agentId: "x", chainLotId: 10, amountMinor: 200, status: "placed" });
    const a = analyze();
    expect(a.selfOutbids).toHaveLength(1);
    expect(a.selfOutbids[0]).toEqual({ chainLotId: 10, agentId: "x", amounts: [100, 200] });
  });

  it("a failed bid between two successes by the same agent still self-outbids", () => {
    record({ kind: "bid_outcome", source: "client", at: 1, agentId: "x", chainLotId: 9, amountMinor: 100, status: "placed" });
    record({ kind: "bid_outcome", source: "client", at: 2, agentId: "x", chainLotId: 9, amountMinor: 200, status: "failed" });
    record({ kind: "bid_outcome", source: "client", at: 3, agentId: "x", chainLotId: 9, amountMinor: 300, status: "placed" });
    // Among SUCCESSFUL bids the sequence is x, x — the agent raised its own
    // price; the failure in between does not excuse it.
    expect(analyze().selfOutbids).toHaveLength(1);
  });

  it("reports latency percentiles and churn", () => {
    const ms = [100, 200, 300, 400, 500, 1000, 2000, 5000];
    for (const m of ms) {
      record({ kind: "bid_outcome", source: "client", at: 1, agentId: "x", chainLotId: 1, amountMinor: 100, status: "placed", msClient: m, msServer: m / 2 });
    }
    record({ kind: "bid_outcome", source: "client", at: 2, agentId: "y", chainLotId: 1, amountMinor: 200, status: "busy" });
    const a = analyze();
    expect(a.latency.clientMs.n).toBe(8);
    expect(a.latency.clientMs.p50).toBe(500);
    expect(a.latency.clientMs.p95).toBe(5000);
    expect(a.churn[0]).toMatchObject({ chainLotId: 1, busy: 1, failed: 0 });
    expect(a.counts["bid_outcome"]).toBe(9);
  });

  it("separates lots in churn accounting", () => {
    record({ kind: "bid_outcome", source: "client", at: 1, agentId: "x", chainLotId: 1, amountMinor: 100, status: "failed" });
    record({ kind: "bid_outcome", source: "client", at: 2, agentId: "x", chainLotId: 2, amountMinor: 100, status: "placed" });
    const a = analyze();
    expect(a.lots).toHaveLength(2);
    expect(a.lots[0]).toMatchObject({ chainLotId: 1, failed: 1, placed: 0 });
  });
});

describe("server-view folding", () => {
  beforeEach(() => resetTrace());

  it("folds the server record of the same bid into the client record", () => {
    record({ kind: "bid_outcome", at: 1000, agentId: "x", chainLotId: 1, amountMinor: 100, status: "placed", source: "server", msServer: 2500 });
    record({ kind: "bid_outcome", at: 1400, agentId: "x", chainLotId: 1, amountMinor: 100, status: "placed", source: "client", msClient: 7400 });
    const a = analyze();
    expect(a.counts["bid_outcome"]).toBe(1);
    expect(a.selfOutbids).toHaveLength(0);
    expect(a.latency.clientMs.p50).toBe(7400);
    expect(a.latency.serverMs.p50).toBe(2500);
  });

  it("keeps unmatched server records (external agents) in the analysis", () => {
    record({ kind: "bid_outcome", at: 1000, agentId: "ext", chainLotId: 1, amountMinor: 100, status: "placed", source: "server", msServer: 2500 });
    const a = analyze();
    expect(a.counts["bid_outcome"]).toBe(1);
    expect(a.latency.serverMs.n).toBe(1);
  });

  it("does not fold two different bids by the same agent", () => {
    record({ kind: "bid_outcome", at: 1000, agentId: "x", chainLotId: 1, amountMinor: 100, status: "placed", source: "server", msServer: 2000 });
    record({ kind: "bid_outcome", at: 4000, agentId: "x", chainLotId: 1, amountMinor: 200, status: "placed", source: "client", msClient: 7000 });
    record({ kind: "bid_outcome", at: 4100, agentId: "x", chainLotId: 1, amountMinor: 200, status: "placed", source: "server", msServer: 2500 });
    const a = analyze();
    expect(a.counts["bid_outcome"]).toBe(2);
    // x bid 0.10 then x bid 0.20 on one lot — a genuine self-outbid
    expect(a.selfOutbids).toHaveLength(1);
  });
});
