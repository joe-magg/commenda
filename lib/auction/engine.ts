/**
 * Single-process auction state machine for the demo.
 *
 * One instance lives on globalThis so Next.js dev hot reloads cannot fork the
 * show (same pattern as the bid route). Timers are chained setTimeout calls,
 * not a long-running interval, so a manual Next can cancel everything cleanly.
 *
 * The engine owns NO money logic. It emits events and calls injected hooks;
 * the bidder/voice/settlement modules are wired in `bootstrap.ts`. This keeps
 * the state machine unit-testable and free of RPC/API imports.
 */
import { LOTS, type Lot, bidderLabel } from "./lots";

export type Phase = "idle" | "intro" | "bidding" | "countdown" | "sold";

export type EngineSnapshot = {
  started: boolean;
  phase: Phase;
  lotIndex: number;
  totalLots: number;
  lot: Lot | null;
  chainLotId: number; // on-chain lot id for the current visit
  currentBidMinor: number;
  leaderLabel: string | null;
  countdown: number;
  /** Epoch ms when the current phase is scheduled to end (best estimate). */
  phaseEndsAt: number;
};

export type AuctionEvent =
  | { type: "snapshot"; state: EngineSnapshot }
  | { type: "phase"; phase: Phase }
  | { type: "lot_open"; lot: Lot; index: number; total: number }
  | { type: "bid"; lotId: number; amountMinor: number; bidder: string; label: string; txHash: string }
  | { type: "reject"; lotId: number; agentId: string; rule: string; amountMinor: number }
  | { type: "outbid"; lotId: number; previousBidder: string; amountMinor: number; label: string }
  | { type: "countdown"; seconds: number }
  | { type: "agent_join"; agentId: string; label: string; lotId: number }
  | { type: "agent_leave"; agentId: string; label: string; lotId: number; reason: string }
  | { type: "sold"; lotId: number; amountMinor: number; winner: string | null; txHash?: string }
  | { type: "unsold"; lotId: number }
  | { type: "caption"; text: string; lineId: string; audioUrl?: string }
  | { type: "voice_warning"; reason: string };

export type BidOutcome =
  | { ok: true; amountMinor: number; bidder: string; txHash: string; previousBidder?: string }
  | { ok: false; agentId: string; rule: string; amountMinor: number };

export type SpokenLine = { text: string; audioUrl?: string; warning?: string };

export type EngineHooks = {
  onLotOpen?: (lot: Lot, chainLotId: number) => void;
  onBidSlot?: (lot: Lot, slot: number, chainLotId: number) => Promise<BidOutcome | null>;
  onSold?: (lot: Lot, amountMinor: number, chainLotId: number) => Promise<string | undefined>;
  speak?: (lineId: string, args: Record<string, number>, lotIndex: number) => Promise<SpokenLine | undefined>;
};

export const TIMING = {
  introMs: 3500,
  // One bid round-trip is ~4-5s on Arc (x402 verify + settle + receipt wait),
  // so fixed slot offsets used to OVERLAP: two bids in flight at once, and the
  // lower one could land after the higher and revert — wasted churn that read
  // as agents outbidding themselves. Slots are now CHAINED: the next bid
  // starts slotGapMs after the previous resolves; two bids are never in
  // flight simultaneously. biddingMs is a floor on the bidding window.
  slotGapMs: 1500,
  maxBidSlots: 4,
  slotTimeoutMs: 8000,
  biddingMs: 15000,
  countdownMs: 5000,
  soldMs: 3200,
} as const;

export class AuctionEngine {
  private state: EngineSnapshot = {
    started: false,
    phase: "idle",
    lotIndex: 0,
    totalLots: LOTS.length,
    lot: null,
    chainLotId: 0,
    currentBidMinor: 0,
    leaderLabel: null,
    countdown: 0,
    phaseEndsAt: 0,
  };
  private listeners = new Set<(e: AuctionEvent) => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private hooks: EngineHooks = {};
  private generation = 0;
  private advancing = false;
  private lotVisits = 0;
  private currentChainLotId = 0;
  private phaseStart = 0;
  private lots: readonly Lot[] = LOTS;

  /** Replace the catalog with generated session items before start(). */
  setLots(lots: readonly Lot[]): void {
    if (lots.length === 0) return;
    this.lots = lots;
    this.state = { ...this.state, totalLots: lots.length };
  }

  setHooks(hooks: EngineHooks): void {
    this.hooks = hooks;
  }

  /** Emit an event from an external worker (agent join/leave, etc.). */
  emitExternal(e: AuctionEvent): void {
    this.emit(e);
  }

  subscribe(fn: (e: AuctionEvent) => void): () => void {
    this.listeners.add(fn);
    fn({ type: "snapshot", state: this.snapshot() });
    return () => this.listeners.delete(fn);
  }

  snapshot(): EngineSnapshot {
    return { ...this.state };
  }

  private emit(e: AuctionEvent): void {
    for (const fn of this.listeners) {
      try { fn(e); } catch { /* one slow/broken client cannot stall the show */ }
    }
  }

  /** Fire-and-forget voice; captions/audio URLs arrive as events when ready. */
  private say(lineId: string, args: Record<string, number>): void {
    if (!this.hooks.speak) return;
    void this.hooks.speak(lineId, args, this.state.lotIndex)
      .then((r) => {
        if (!r) return;
        if (r.text) this.emit({ type: "caption", text: r.text, lineId, audioUrl: r.audioUrl });
        if (r.warning) this.emit({ type: "voice_warning", reason: r.warning });
      })
      .catch(() => { /* voice failures never stall the show */ });
  }

  private later(fn: () => void, ms: number): void {
    const gen = this.generation;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (gen !== this.generation) return; // cancelled by Next()
      fn();
    }, ms);
    this.timers.add(t);
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.generation++;
  }

  start(): void {
    if (this.state.started) return;
    this.state.started = true;
    this.openLot(0);
  }

  /** Manual override: settle the current lot (if any) and jump to the next. */
  next(): void {
    if (!this.state.started) { this.start(); return; }
    if (this.advancing) return;
    this.advancing = true;
    this.clearTimers();
    const lot = this.state.lot;
    const advance = () => {
      const i = (this.state.lotIndex + 1) % this.lots.length;
      this.advancing = false;
      this.openLot(i);
    };
    if (lot && this.state.phase !== "sold" && this.state.currentBidMinor > lot.openingMinor) {
      void this.finishLot(lot, advance);
    } else {
      advance();
    }
  }

  private openLot(index: number): void {
    const lot = this.lots[index];
    // Every visit gets a distinct on-chain lot id, so looping the same six
    // lots never collides with decide()'s per-lot idempotency key.
    this.currentChainLotId = lot.chainId + this.lotVisits * 1000;
    this.lotVisits++;
    this.state = {
      ...this.state,
      phase: "intro",
      lotIndex: index,
      lot,
      chainLotId: this.currentChainLotId,
      currentBidMinor: lot.openingMinor,
      leaderLabel: null,
      countdown: 0,
      phaseEndsAt: Date.now() + TIMING.introMs,
    };
    this.emit({ type: "phase", phase: "intro" });
    this.emit({ type: "lot_open", lot, index, total: this.lots.length });
    this.emit({ type: "snapshot", state: this.snapshot() });
    this.hooks.onLotOpen?.(lot, this.currentChainLotId);
    this.say("lotIntro", { n: lot.id + 1 });
    this.later(() => this.beginBidding(lot), TIMING.introMs);
  }

  private beginBidding(lot: Lot): void {
    this.state = { ...this.state, phase: "bidding", phaseEndsAt: Date.now() + TIMING.biddingMs };
    this.emit({ type: "phase", phase: "bidding" });
    this.emit({ type: "snapshot", state: this.snapshot() });
    this.phaseStart = Date.now();
    this.later(() => { void this.runBidSlotChain(lot, 0); }, TIMING.slotGapMs);
  }

  /**
   * Chain the bid slots: each slot runs to completion (placed, rejected or
   * failed) before the next is scheduled, so two bids are never in flight at
   * once. A wedged driver recovers after slotTimeoutMs by ending the bidding
   * for this lot — the show must never freeze on one stuck bid.
   */
  private async runBidSlotChain(lot: Lot, slot: number): Promise<void> {
    const gen = this.generation;
    let settled = false;
    await Promise.race([
      this.runBidSlot(lot, slot).then(() => { settled = true; }),
      new Promise<void>((r) => setTimeout(r, TIMING.slotTimeoutMs)),
    ]);
    if (gen !== this.generation) return; // superseded by Next()
    if (!settled) {
      // Driver wedged: abandon the remaining slots and recover the show.
      // (If the stuck bid later lands on the SAME lot, the existing
      // chainLotId guard still applies its outcome.)
      this.later(() => this.beginCountdown(lot), TIMING.slotGapMs);
      return;
    }
    const next = slot + 1;
    if (next < TIMING.maxBidSlots) {
      this.later(() => { void this.runBidSlotChain(lot, next); }, TIMING.slotGapMs);
    } else {
      const wait = Math.max(TIMING.slotGapMs, this.phaseStart + TIMING.biddingMs - Date.now());
      this.later(() => this.beginCountdown(lot), wait);
    }
  }

  private async runBidSlot(lot: Lot, slot: number): Promise<void> {
    if (!this.hooks.onBidSlot) return;
    // Guard against stale continuations: next()/countdown can open a new lot
    // while this hook is awaiting. If the on-chain lot id moved on, the outcome
    // belongs to a lot that is already over — drop it instead of corrupting the
    // new lot's bid state with the old lot's winner.
    const chainLotIdAtStart = this.currentChainLotId;
    let outcome: BidOutcome | null;
    try {
      outcome = await this.hooks.onBidSlot(lot, slot, this.currentChainLotId);
    } catch {
      return; // driver errors are surfaced by the driver itself; never kill the show
    }
    if (this.currentChainLotId !== chainLotIdAtStart) return;
    if (!outcome) return;
    if (!outcome.ok) {
      this.emit({ type: "reject", lotId: lot.id, agentId: outcome.agentId, rule: outcome.rule, amountMinor: outcome.amountMinor });
      return;
    }
    if (outcome.previousBidder) {
      this.emit({
        type: "outbid",
        lotId: lot.id,
        previousBidder: outcome.previousBidder,
        amountMinor: outcome.amountMinor,
        label: bidderLabel(outcome.previousBidder),
      });
    }
    this.state = {
      ...this.state,
      currentBidMinor: outcome.amountMinor,
      leaderLabel: bidderLabel(outcome.bidder),
    };
    this.emit({
      type: "bid",
      lotId: lot.id,
      amountMinor: outcome.amountMinor,
      bidder: outcome.bidder,
      label: bidderLabel(outcome.bidder),
      txHash: outcome.txHash,
    });
    this.emit({ type: "snapshot", state: this.snapshot() });
    this.say("bidCall", { amountMinor: outcome.amountMinor });
  }

  private beginCountdown(lot: Lot): void {
    this.state = { ...this.state, phase: "countdown", countdown: 5, phaseEndsAt: Date.now() + TIMING.countdownMs };
    this.emit({ type: "phase", phase: "countdown" });
    this.say("countdown", { s: 5 });
    for (let s = 5; s >= 1; s--) {
      this.later(() => {
        this.state = { ...this.state, countdown: s };
        this.emit({ type: "countdown", seconds: s });
        this.emit({ type: "snapshot", state: this.snapshot() });
      }, (5 - s) * 1000);
    }
    this.later(() => { void this.finishLot(lot); }, TIMING.countdownMs);
  }

  private async finishLot(lot: Lot, done?: () => void): Promise<void> {
    if (this.state.phase === "sold") { done?.(); return; }
    this.state = { ...this.state, phase: "sold", countdown: 0, phaseEndsAt: Date.now() + TIMING.soldMs };
    this.emit({ type: "phase", phase: "sold" });

    const amount = this.state.currentBidMinor;
    const winner = this.state.leaderLabel;
    const hasBids = amount > lot.openingMinor;
    // If a manual Next() opened another lot while onSold was awaiting, this
    // continuation is stale — the settle side effects (claims/mint) are keyed
    // by chainLotId inside the hook and stay correct, but the emits below
    // would overlay the OLD sale onto the NEW lot.
    const chainLotIdAtStart = this.currentChainLotId;

    if (!hasBids) {
      // No bids: nothing to settle, no SOLD, no receipt — the lot simply passes.
      this.emit({ type: "unsold", lotId: lot.id });
      this.emit({ type: "snapshot", state: this.snapshot() });
    } else {
      let txHash: string | undefined;
      if (this.hooks.onSold) {
        try { txHash = await this.hooks.onSold(lot, amount, this.currentChainLotId); } catch { /* settle failure is surfaced in the log */ }
        if (this.currentChainLotId !== chainLotIdAtStart) return;
      }
      this.emit({ type: "sold", lotId: lot.id, amountMinor: amount, winner, txHash });
      this.emit({ type: "snapshot", state: this.snapshot() });
      this.say("sold", { amountMinor: amount });
    }

    const advance = done ?? (() => this.openLot((this.state.lotIndex + 1) % this.lots.length));
    this.later(advance, TIMING.soldMs);
  }
}

const g = globalThis as typeof globalThis & { __commendaEngine?: AuctionEngine };
export function getEngine(): AuctionEngine {
  if (!g.__commendaEngine) g.__commendaEngine = new AuctionEngine();
  return g.__commendaEngine;
}
