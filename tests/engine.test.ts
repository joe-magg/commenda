import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AuctionEngine, TIMING, type AuctionEvent, type BidOutcome, type RoundContext } from "../lib/auction/engine";
import type { Lot } from "../lib/auction/lots";

const mkLots = (n: number): Lot[] =>
  Array.from({ length: n }, (_, i) => ({
    id: i, chainId: 1_000_000 + i, title: `Item ${i}`, category: "electronics" as const,
    seller: "0x3333333333333333333333333333333333333333", openingMinor: 100_000,
    accent: "#000", sku: `SKU-${i}`, artSeed: "abcd",
  }));

let tx = 0;
const placed = (amountMinor: number, bidder = "0xabc"): BidOutcome =>
  ({ ok: true, amountMinor, bidder, txHash: `0x${++tx}` });

/** Long enough for one quiet lot: intro + countdown + sold + slack. */
const QUIET_LOT = TIMING.introMs + TIMING.countdownMs + TIMING.soldMs + 2_000;

describe("auction engine — the floor", () => {
  let engine: AuctionEngine;
  let events: AuctionEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    engine = new AuctionEngine();
    engine.setLots(mkLots(3), "Test Auction");
    events = [];
    engine.subscribe((e) => events.push(e));
  });

  afterEach(() => vi.useRealTimers());

  it("opens a lot in intro, then moves to bidding", async () => {
    engine.setHooks({ onBidSlot: () => new Promise(() => {}) });
    engine.start();
    expect(engine.snapshot().phase).toBe("intro");
    expect(events.some((e) => e.type === "lot_open")).toBe(true);
    expect(events.some((e) => e.type === "auction_start")).toBe(true);
    await vi.advanceTimersByTimeAsync(TIMING.introMs);
    expect(engine.snapshot().phase).toBe("bidding");
  });

  it("keeps asking while agents raise, then counts down when the room goes quiet", async () => {
    const amounts = [200_000, 300_000, 400_000];
    let round = 0;
    engine.setHooks({ onBidSlot: async () => (round < amounts.length ? placed(amounts[round++], `0x${round}`) : null) });
    engine.start();
    await vi.advanceTimersByTimeAsync(TIMING.introMs + 3 * (TIMING.slotGapMs + 10));
    expect(engine.snapshot().bidCount).toBe(3);
    expect(engine.snapshot().currentBidMinor).toBe(400_000);
    await vi.advanceTimersByTimeAsync(TIMING.slotGapMs);
    expect(engine.snapshot().phase).toBe("countdown");
  });

  it("is driven by agents, not a fixed slot count", async () => {
    let round = 0;
    engine.setHooks({ onBidSlot: async () => (round < 9 ? placed(200_000 + 100_000 * round++, `0x${round}`) : null) });
    engine.start();
    await vi.advanceTimersByTimeAsync(TIMING.introMs + 10 * (TIMING.slotGapMs + 10));
    expect(engine.snapshot().bidCount).toBe(9); // old engine stopped at 4
  });

  it("soft close: a bid during the countdown reopens the lot", async () => {
    let calls: RoundContext[] = [];
    let sniped = false;
    engine.setHooks({
      onBidSlot: async (_l, _s, _c, ctx) => {
        calls.push(ctx);
        if (ctx.phase === "countdown" && ctx.secondsLeft !== null && ctx.secondsLeft <= 4 && !sniped) {
          sniped = true;
          return placed(500_000, "0xsniper");
        }
        return null;
      },
    });
    engine.start();
    await vi.advanceTimersByTimeAsync(TIMING.introMs + 100);
    expect(engine.snapshot().phase).toBe("countdown");
    await vi.advanceTimersByTimeAsync(3_000);
    const late = events.find((e) => e.type === "bid") as Extract<AuctionEvent, { type: "bid" }>;
    expect(late.late).toBe(true);
    expect(engine.snapshot().leaderId).toBe("0xsniper");
    // reopened, then quiet again → a fresh countdown → sold
    expect(calls.some((c) => c.phase === "countdown")).toBe(true);
    await vi.advanceTimersByTimeAsync(TIMING.countdownMs + TIMING.slotGapMs + 500);
    expect(events.filter((e) => e.type === "sold").length).toBe(1);
  });

  it("recordBid is idempotent per tx and ignores stale lots or non-raises", async () => {
    engine.setHooks({ onBidSlot: () => new Promise(() => {}) });
    engine.start();
    await vi.advanceTimersByTimeAsync(TIMING.introMs);
    const cid = engine.snapshot().chainLotId;
    expect(engine.recordBid({ chainLotId: cid, amountMinor: 200_000, bidder: "0xa", txHash: "0xt1" })).toBe(true);
    expect(engine.recordBid({ chainLotId: cid, amountMinor: 200_000, bidder: "0xa", txHash: "0xt1" })).toBe(false);
    expect(engine.recordBid({ chainLotId: cid, amountMinor: 150_000, bidder: "0xb", txHash: "0xt2" })).toBe(false);
    expect(engine.recordBid({ chainLotId: cid + 1, amountMinor: 900_000, bidder: "0xb", txHash: "0xt3" })).toBe(false);
    expect(engine.recordBid({ chainLotId: cid, amountMinor: 300_000, bidder: "0xb", txHash: "0xt4" })).toBe(true);
    expect(engine.snapshot()).toMatchObject({ bidCount: 2, currentBidMinor: 300_000, leaderId: "0xb" });
    expect(events.some((e) => e.type === "outbid")).toBe(true);
  });

  it("refuses bids while the floor is closed (intro)", () => {
    engine.start();
    const cid = engine.snapshot().chainLotId;
    expect(engine.openLot()?.accepting).toBe(false);
    expect(engine.recordBid({ chainLotId: cid, amountMinor: 200_000, bidder: "0xa", txHash: "0xi" })).toBe(false);
  });

  it("settles and advances on manual Next", async () => {
    const settle = vi.fn(async () => "0xsettle");
    engine.setHooks({ onBidSlot: async () => placed(200_000), onSold: settle });
    engine.start();
    await vi.advanceTimersByTimeAsync(TIMING.introMs + 50);
    engine.next();
    await vi.advanceTimersByTimeAsync(TIMING.soldMs + 500);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(engine.snapshot().lotIndex).toBe(1);
    expect(events.some((e) => e.type === "sold")).toBe(true);
  });

  it("SOLD reports the escrow's winner, not the local leader (late external bid)", async () => {
    let once = false;
    engine.setHooks({
      onBidSlot: async () => (once ? null : ((once = true), placed(200_000, "0xlocal"))),
      onSold: async () => ({ txHash: "0xs", winnerId: "0xchain", winnerLabel: "Agent Z", amountMinor: 300_000 }),
    });
    engine.start();
    await vi.advanceTimersByTimeAsync(TIMING.introMs + TIMING.slotGapMs + TIMING.countdownMs + 2_000);
    const sold = events.find((e) => e.type === "sold") as Extract<AuctionEvent, { type: "sold" }>;
    expect(sold).toMatchObject({ winnerId: "0xchain", winner: "Agent Z", amountMinor: 300_000, txHash: "0xs" });
  });

  it("emits unsold (never sold) when a lot has no bids", async () => {
    const unsold = vi.fn();
    engine.setHooks({ onBidSlot: async () => null, onUnsold: unsold });
    engine.start();
    await vi.advanceTimersByTimeAsync(TIMING.introMs + TIMING.countdownMs + 2_000);
    expect(events.some((e) => e.type === "unsold")).toBe(true);
    expect(events.some((e) => e.type === "sold")).toBe(false);
    expect(unsold).toHaveBeenCalledTimes(1);
  });

  it("does not double-advance or overlay a stale sale when Next fires during onSold (finding 6)", async () => {
    let release!: (tx?: string) => void;
    const gate = new Promise<string | undefined>((res) => { release = res; });
    let once = false;
    engine.setHooks({
      onBidSlot: async () => (once ? null : ((once = true), placed(200_000))),
      onSold: () => gate,
    });
    engine.start();
    await vi.advanceTimersByTimeAsync(TIMING.introMs + TIMING.slotGapMs + TIMING.countdownMs + 2_000);
    expect(engine.snapshot().phase).toBe("sold");
    expect(events.filter((e) => e.type === "sold").length).toBe(0);

    engine.next(); // phase already "sold" -> advances immediately to lot 1
    expect(engine.snapshot().lotIndex).toBe(1);
    release("0xsettle");
    await vi.advanceTimersByTimeAsync(TIMING.soldMs + 500);
    expect(engine.snapshot().lotIndex).toBe(1);
    expect(events.filter((e) => e.type === "sold").length).toBe(0);
  });

  it("does not apply a late bid outcome to the next lot (stale round)", async () => {
    let release!: (v: BidOutcome) => void;
    const gate = new Promise<BidOutcome>((res) => { release = res; });
    let first = true;
    engine.setHooks({ onBidSlot: async () => (first ? ((first = false), gate) : null) });
    engine.start();
    await vi.advanceTimersByTimeAsync(TIMING.introMs + 10);
    engine.next(); // move on while the round is pending
    await vi.advanceTimersByTimeAsync(TIMING.introMs + 10);
    expect(engine.snapshot().lotIndex).toBe(1);
    release(placed(900_000, "0xlate"));
    await vi.advanceTimersByTimeAsync(10);
    expect(engine.snapshot().bidCount).toBe(0);
    expect(engine.snapshot().leaderId).toBeNull();
  });

  it("chains rounds — never two in flight", async () => {
    let active = 0;
    let maxActive = 0;
    engine.setHooks({
      onBidSlot: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 50));
        active--;
        return null;
      },
    });
    engine.start();
    await vi.advanceTimersByTimeAsync(QUIET_LOT);
    expect(maxActive).toBe(1);
  });

  it("recovers the show when a driver hangs (round timeout)", async () => {
    engine.setHooks({ onBidSlot: () => new Promise(() => {}) });
    engine.start();
    await vi.advanceTimersByTimeAsync(TIMING.introMs + 2 * TIMING.slotTimeoutMs + TIMING.countdownMs + TIMING.soldMs + 500);
    expect(engine.snapshot().lotIndex).toBe(1);
  });

  it("runs the catalog exactly once, then ends (scheduler model)", async () => {
    engine.setHooks({ onBidSlot: async () => null });
    const ends: number[] = [];
    engine.subscribe((e) => { if (e.type === "auction_end") ends.push(e.lots); });
    engine.start();
    await vi.advanceTimersByTimeAsync(3 * QUIET_LOT);
    expect(ends).toEqual([3]);
    expect(engine.snapshot().phase).toBe("ended");
    engine.setLots(mkLots(2).map((l) => ({ ...l, chainId: l.chainId + 50 })));
    engine.start();
    expect(engine.snapshot().phase).toBe("intro");
  });

  it("a viewer's Next never starts an auction — only the scheduler does", () => {
    engine.next();
    expect(engine.snapshot().started).toBe(false);
    expect(engine.snapshot().phase).toBe("idle");
  });

  it("uses each lot's scheduler-assigned on-chain id", () => {
    engine.start();
    expect(engine.snapshot().chainLotId).toBe(1_000_000);
  });

  it("speaks the lot intro with the lot itself as context", async () => {
    const speak = vi.fn(async () => ({ text: "Lot 1. Item 0.", audioUrl: "/api/audio/abc" }));
    engine.setHooks({ speak });
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(speak).toHaveBeenCalledWith("lotIntro", { n: 1, amountMinor: 100_000 }, 0, expect.objectContaining({ lot: expect.objectContaining({ title: "Item 0" }) }));
    expect(events.find((e) => e.type === "caption")).toMatchObject({ text: "Lot 1. Item 0.", audioUrl: "/api/audio/abc" });
  });
});
