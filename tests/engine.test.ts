import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AuctionEngine, TIMING, type AuctionEvent } from "../lib/auction/engine";

describe("auction engine state machine", () => {
  let engine: AuctionEngine;
  let events: AuctionEvent[];
  let unsub: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = new AuctionEngine();
    events = [];
    unsub = engine.subscribe((e) => events.push(e));
  });

  afterEach(() => {
    unsub();
    vi.useRealTimers();
  });

  it("opens a lot in intro, then moves to bidding", async () => {
    engine.start();
    expect(engine.snapshot().phase).toBe("intro");
    expect(events.some((e) => e.type === "lot_open")).toBe(true);
    await vi.advanceTimersByTimeAsync(TIMING.introMs);
    expect(engine.snapshot().phase).toBe("bidding");
  });

  it("applies a successful bid to the current amount", async () => {
    engine.setHooks({
      onBidSlot: async () => ({ ok: true, amountMinor: 200_000, bidder: "0xabc", txHash: "0x1" }),
    });
    engine.start();
    await vi.advanceTimersByTimeAsync(TIMING.introMs + TIMING.bidOffsetsMs[0]);
    expect(engine.snapshot().currentBidMinor).toBe(200_000);
    expect(engine.snapshot().leaderLabel).toBeTruthy();
    expect(events.some((e) => e.type === "bid")).toBe(true);
  });

  it("surfaces guardrail rejections without changing the bid", async () => {
    engine.setHooks({
      onBidSlot: async () => ({ ok: false, agentId: "0xabc", rule: "WATCHLIST", amountMinor: 200_000 }),
    });
    engine.start();
    await vi.advanceTimersByTimeAsync(TIMING.introMs + TIMING.bidOffsetsMs[0]);
    expect(engine.snapshot().currentBidMinor).toBe(100_000);
    expect(events.some((e) => e.type === "reject")).toBe(true);
  });

  it("settles and advances on manual Next", async () => {
    const settle = vi.fn(async () => "0xsettle");
    engine.setHooks({
      onBidSlot: async () => ({ ok: true, amountMinor: 200_000, bidder: "0xabc", txHash: "0x1" }),
      onSold: settle,
    });
    engine.start();
    await vi.advanceTimersByTimeAsync(TIMING.introMs + TIMING.bidOffsetsMs[0]);
    engine.next();
    // Bounded advance — the engine intentionally loops forever, so never runAllTimers.
    await vi.advanceTimersByTimeAsync(TIMING.soldMs + 500);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(engine.snapshot().lotIndex).toBe(1);
    expect(events.some((e) => e.type === "sold")).toBe(true);
  });

  it("emits unsold (never sold) when a lot has no bids", async () => {
    // No onBidSlot hook -> every slot is a no-op, so no bids land.
    engine.start();
    await vi.advanceTimersByTimeAsync(
      TIMING.introMs + TIMING.biddingMs + TIMING.countdownMs + 100,
    );
    expect(events.some((e) => e.type === "unsold")).toBe(true);
    expect(events.some((e) => e.type === "sold")).toBe(false);
    expect(engine.snapshot().currentBidMinor).toBe(100_000); // opening ask, not a bid
  });

  it("gives each loop of a lot a fresh on-chain id", async () => {
    const ids: number[] = [];
    engine.setHooks({
      onBidSlot: async (_lot, _slot, chainLotId) => { ids.push(chainLotId); return null; },
    });
    engine.start();
    await vi.advanceTimersByTimeAsync(TIMING.introMs + TIMING.bidOffsetsMs[0]);
    // Run out the lot, advance into the next cycle's first bid slot.
    await vi.advanceTimersByTimeAsync(TIMING.biddingMs + TIMING.countdownMs + TIMING.soldMs);
    await vi.advanceTimersByTimeAsync(TIMING.introMs + TIMING.bidOffsetsMs[0]);
    expect(ids.length).toBeGreaterThan(1);
    // Slots within one visit share an id; a new loop must get a different one.
    expect(new Set(ids).size).toBeGreaterThan(1);
    expect(ids.at(-1)).not.toBe(ids[0]);
  });

  it("emits captions with audio URLs from the voice hook", async () => {
    engine.setHooks({ speak: async () => ({ text: "Lot 1. Bidding is open.", audioUrl: "/api/audio/abc" }) });
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    const cap = events.find((e) => e.type === "caption");
    expect(cap).toMatchObject({ text: "Lot 1. Bidding is open.", audioUrl: "/api/audio/abc" });
  });
});
