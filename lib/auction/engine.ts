/**
 * Single-process auction state machine for the demo.
 *
 * One instance lives on globalThis so Next.js dev hot reloads cannot fork the
 * show. The engine owns NO money logic and makes NO bidding decisions: it
 * runs the floor (intro → bidding → countdown → sold), asks the agent pool
 * once per round whether anyone raises, and applies receipt-confirmed bids
 * from ANY bidder through recordBid(). Agents decide for themselves
 * (lib/agents/strategy.ts); decide() authorizes; the escrow is the truth.
 *
 * Soft close: a bid that lands during the countdown reopens the lot. The
 * floor takes one bid at a time (rounds are chained), so two of the pool's
 * bids are never in flight at once.
 */
import { LOTS, type Lot, bidderLabel } from "./lots";

export type Phase = "idle" | "intro" | "bidding" | "countdown" | "sold" | "ended";

export type EngineSnapshot = {
  started: boolean;
  phase: Phase;
  lotIndex: number;
  totalLots: number;
  lot: Lot | null;
  chainLotId: number; // on-chain lot id for the current visit
  currentBidMinor: number; // highest bid, or the opening ask when bidCount = 0
  bidCount: number;
  leaderId: string | null;
  leaderLabel: string | null;
  countdown: number;
  /** Epoch ms when the current phase is scheduled to end (best estimate). */
  phaseEndsAt: number;
  /** Epoch ms when the scheduler starts the next auction (between auctions). */
  nextAuctionAt: number;
  sessionName: string | null;
  /** Agents currently in the room for this lot (public: who, never why). */
  participants: string[];
};

export type AuctionEvent =
  | { type: "snapshot"; state: EngineSnapshot }
  | { type: "phase"; phase: Phase }
  | { type: "lot_open"; lot: Lot; index: number; total: number }
  | { type: "bid"; lotId: number; amountMinor: number; bidder: string; label: string; txHash: string; late?: boolean }
  | { type: "reject"; lotId: number; agentId: string; rule: string; amountMinor: number; label?: string }
  | { type: "outbid"; lotId: number; previousBidder: string; amountMinor: number; label: string }
  | { type: "countdown"; seconds: number }
  | { type: "agent_join"; agentId: string; label: string; lotId: number; persona?: string }
  | { type: "agent_leave"; agentId: string; label: string; lotId: number; reason: string }
  | { type: "agent_wait"; agentId: string; label: string; lotId: number; reason: string }
  /** PRIVATE: what an agent is thinking — delivered only to its owner. */
  | { type: "agent_mind"; agentId: string; lotId: number; state: MindState; text: string; limitMinor: number | null }
  | { type: "sold"; lotId: number; amountMinor: number; winner: string | null; winnerId?: string | null; txHash?: string }
  | { type: "unsold"; lotId: number }
  | { type: "auction_start"; name: string; lots: number }
  | { type: "auction_end"; lots: number }
  | { type: "caption"; text: string; lineId: string; audioUrl?: string }
  | { type: "voice_warning"; reason: string };

export type MindState = "watching" | "raising" | "leading" | "holding" | "out" | "skipping" | "recalled" | "blocked";

/** Events only an agent's owner may see (strategy, limits, block reasons). */
export function isPrivateEvent(e: AuctionEvent): e is Extract<AuctionEvent, { agentId: string }> {
  return e.type === "agent_mind" || e.type === "agent_wait" || e.type === "reject";
}

export type BidOutcome =
  | { ok: true; amountMinor: number; bidder: string; txHash: string; previousBidder?: string; label?: string }
  | { ok: false; agentId: string; rule: string; amountMinor: number };

/** What the floor tells the pool about the round it is asking for. */
export type RoundContext = { phase: "bidding" | "countdown"; secondsLeft: number | null };

export type SoldVerdict = { txHash: string; winnerId: string | null; winnerLabel: string | null; amountMinor: number };

export type SpokenLine = { text: string; audioUrl?: string; warning?: string };

/** Voice args are numbers (validated) plus server-owned context the template may read. */
export type VoiceContext = { lot?: Lot | null; bidderLabel?: string | null; sessionName?: string | null };

export type EngineHooks = {
  onLotOpen?: (lot: Lot, chainLotId: number) => void;
  onBidSlot?: (lot: Lot, slot: number, chainLotId: number, ctx: RoundContext) => Promise<BidOutcome | null>;
  /** Settle on-chain. May return the ESCROW's verdict, which overrides the
   *  local view in the SOLD event (a late external bid can land between the
   *  hammer and settle — the chain decides who actually won). */
  onSold?: (lot: Lot, amountMinor: number, chainLotId: number) => Promise<string | SoldVerdict | undefined>;
  onUnsold?: (lot: Lot, chainLotId: number) => void;
  speak?: (lineId: string, args: Record<string, number>, lotIndex: number, ctx: VoiceContext) => Promise<SpokenLine | undefined>;
};

export const TIMING = {
  introMs: 5000,
  slotGapMs: 1200,
  slotTimeoutMs: 12000,
  countdownMs: 6000,
  /** Poll interval while the countdown runs and nobody is bidding. */
  countdownPollMs: 1000,
  soldMs: 4500,
  /** Safety valve: a lot never takes more than this many bids. */
  maxBidsPerLot: 16,
  /** Consecutive non-placed attempts before the floor treats a round as quiet. */
  maxQuietAttempts: 2,
} as const;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AuctionEngine {
  private state: EngineSnapshot = {
    started: false,
    phase: "idle",
    lotIndex: 0,
    totalLots: LOTS.length,
    lot: null,
    chainLotId: 0,
    currentBidMinor: 0,
    bidCount: 0,
    leaderId: null,
    leaderLabel: null,
    countdown: 0,
    phaseEndsAt: 0,
    nextAuctionAt: 0,
    sessionName: null,
    participants: [],
  };
  private listeners = new Set<(e: AuctionEvent) => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private hooks: EngineHooks = {};
  private generation = 0;
  private advancing = false;
  private currentChainLotId = 0;
  private lots: readonly Lot[] = LOTS;
  private appliedTx = new Set<string>();
  private countdownToken = 0;
  private countdownEndsAt = 0;

  /** Replace the catalog with generated session items before start(). */
  setLots(lots: readonly Lot[], sessionName?: string): void {
    if (lots.length === 0) return;
    this.lots = lots;
    this.state = { ...this.state, totalLots: lots.length, sessionName: sessionName ?? this.state.sessionName };
  }

  setHooks(hooks: EngineHooks): void {
    this.hooks = hooks;
  }

  /** The scheduler publishes when the next auction starts (intermission UI). */
  setNextAuctionAt(at: number): void {
    this.state = { ...this.state, nextAuctionAt: at };
    this.emit({ type: "snapshot", state: this.snapshot() });
  }

  /** Emit an event from an external worker (agent join/leave, guardrail blocks).
   *  Joins/leaves also maintain the room roster, so a late viewer's snapshot
   *  shows who is already gathered around the lot. */
  emitExternal(e: AuctionEvent): void {
    if (e.type === "agent_join" && !this.state.participants.includes(e.agentId)) {
      this.state = { ...this.state, participants: [...this.state.participants, e.agentId] };
    } else if (e.type === "agent_leave") {
      this.state = { ...this.state, participants: this.state.participants.filter((id) => id !== e.agentId) };
    }
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

  /** The lot bids may currently target, or null when the floor is closed. */
  openLot(): { chainLotId: number; lot: Lot; accepting: boolean } | null {
    const lot = this.state.lot;
    if (!this.state.started || !lot) return null;
    const accepting = this.state.phase === "bidding" || this.state.phase === "countdown";
    return { chainLotId: this.currentChainLotId, lot, accepting };
  }

  private emit(e: AuctionEvent): void {
    for (const fn of this.listeners) {
      try { fn(e); } catch { /* one slow/broken client cannot stall the show */ }
    }
  }

  /** Fire-and-forget voice; captions/audio URLs arrive as events when ready. */
  private say(lineId: string, args: Record<string, number>, ctx: VoiceContext = {}): void {
    if (!this.hooks.speak) return;
    void this.hooks.speak(lineId, args, this.state.lotIndex, { lot: this.state.lot, sessionName: this.state.sessionName, ...ctx })
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
    this.countdownToken++;
  }

  start(): void {
    // A finished auction may be started again with a fresh catalog (the
    // scheduler runs one auction per session); only a LIVE run is guarded.
    if (this.state.started && this.state.phase !== "ended") return;
    this.state = { ...this.state, started: true, nextAuctionAt: 0 };
    if (this.state.sessionName) {
      this.emit({ type: "auction_start", name: this.state.sessionName, lots: this.lots.length });
    }
    this.openLotAt(0);
  }

  /** Manual override: settle the current lot (if any) and jump to the next.
   *  Starting an auction is the scheduler's job, never a viewer's. */
  next(): void {
    if (!this.state.started) return;
    if (this.advancing) return;
    this.advancing = true;
    this.clearTimers();
    const lot = this.state.lot;
    const advance = () => {
      this.advancing = false;
      this.advanceLot();
    };
    if (lot && this.state.phase !== "sold" && this.state.bidCount > 0) {
      void this.finishLot(lot, advance);
    } else {
      advance();
    }
  }

  /**
   * Apply a receipt-confirmed bid from ANY bidder (the pool's agents or an
   * external x402 client). Idempotent per tx hash; ignores bids for a lot
   * that is no longer open or that do not raise the price. A bid during the
   * countdown reopens the lot (soft close).
   */
  recordBid(b: { chainLotId: number; amountMinor: number; bidder: string; txHash: string; label?: string }): boolean {
    if (!b.txHash || this.appliedTx.has(b.txHash)) return false;
    if (b.chainLotId !== this.currentChainLotId) return false;
    const open = this.openLot();
    // A bid may land a beat after the hammer while finishLot reads escrow —
    // the sale reads chain truth either way, so only the open floor shows it.
    if (!open?.accepting) return false;
    if (this.state.bidCount > 0 && b.amountMinor <= this.state.currentBidMinor) return false;
    this.appliedTx.add(b.txHash);

    const lot = open.lot;
    const label = b.label ?? bidderLabel(b.bidder);
    const prev = this.state.leaderId;
    const late = this.state.phase === "countdown";
    if (prev && prev !== b.bidder) {
      this.emit({ type: "outbid", lotId: lot.id, previousBidder: prev, amountMinor: b.amountMinor, label: this.state.leaderLabel ?? bidderLabel(prev) });
    }
    this.state = {
      ...this.state,
      currentBidMinor: b.amountMinor,
      bidCount: this.state.bidCount + 1,
      leaderId: b.bidder,
      leaderLabel: label,
    };
    if (late) this.reopen();
    this.emit({ type: "bid", lotId: lot.id, amountMinor: b.amountMinor, bidder: b.bidder, label, txHash: b.txHash, late });
    this.emit({ type: "snapshot", state: this.snapshot() });
    this.say(late ? "lateBid" : "bidCall", { amountMinor: b.amountMinor }, { bidderLabel: label });
    return true;
  }

  /** Advance to the next lot, or end the auction when the catalog is done. */
  private advanceLot(): void {
    const next = this.state.lotIndex + 1;
    if (next >= this.lots.length) {
      this.endAuction();
      return;
    }
    this.openLotAt(next);
  }

  /** One auction = one pass over the catalog. Ending lets the scheduler run
   *  the next session after its gap — auctions are genuinely distinct. */
  private endAuction(): void {
    this.clearTimers();
    this.advancing = false;
    this.state = { ...this.state, started: false, phase: "ended", phaseEndsAt: 0, leaderId: null, leaderLabel: null };
    this.emit({ type: "phase", phase: "ended" });
    this.emit({ type: "auction_end", lots: this.lots.length });
    this.emit({ type: "snapshot", state: this.snapshot() });
  }

  private openLotAt(index: number): void {
    const lot = this.lots[index];
    // Session catalogs carry globally unique on-chain ids (scheduler-assigned,
    // time-based), so a new auction can never collide with a settled lot.
    this.currentChainLotId = lot.chainId;
    this.state = {
      ...this.state,
      phase: "intro",
      lotIndex: index,
      lot,
      chainLotId: this.currentChainLotId,
      currentBidMinor: lot.openingMinor,
      bidCount: 0,
      leaderId: null,
      leaderLabel: null,
      participants: [],
      countdown: 0,
      phaseEndsAt: Date.now() + TIMING.introMs,
    };
    this.emit({ type: "phase", phase: "intro" });
    this.emit({ type: "lot_open", lot, index, total: this.lots.length });
    this.emit({ type: "snapshot", state: this.snapshot() });
    this.hooks.onLotOpen?.(lot, this.currentChainLotId);
    this.say("lotIntro", { n: index + 1, amountMinor: lot.openingMinor });
    this.later(() => this.beginBidding(lot), TIMING.introMs);
  }

  private beginBidding(lot: Lot): void {
    this.state = { ...this.state, phase: "bidding", phaseEndsAt: 0 };
    this.emit({ type: "phase", phase: "bidding" });
    this.emit({ type: "snapshot", state: this.snapshot() });
    void this.runFloor(lot);
  }

  /**
   * The floor: ask the pool for one bid per round until the room goes quiet,
   * then run the countdown — still asking, so a late bid can reopen the lot.
   * Rounds are chained: each completes before the next starts.
   */
  private async runFloor(lot: Lot): Promise<void> {
    const gen = this.generation;
    const chainLotId = this.currentChainLotId;
    const alive = () => gen === this.generation && chainLotId === this.currentChainLotId;
    let slot = 0;
    let quiet = 0;

    while (alive()) {
      const phase = this.state.phase;
      if (phase !== "bidding" && phase !== "countdown") return;
      if (phase === "countdown" && Date.now() >= this.countdownEndsAt) break;
      if (phase === "bidding" && this.state.bidCount >= TIMING.maxBidsPerLot) {
        this.beginCountdown();
        continue;
      }

      const before = this.state.bidCount;
      const secondsLeft = phase === "countdown"
        ? Math.max(0, Math.ceil((this.countdownEndsAt - Date.now()) / 1000))
        : null;
      let outcome: BidOutcome | null = null;
      if (this.hooks.onBidSlot) {
        try {
          outcome = await Promise.race([
            this.hooks.onBidSlot(lot, slot++, chainLotId, { phase, secondsLeft }),
            wait(TIMING.slotTimeoutMs).then(() => null),
          ]);
        } catch {
          outcome = null; // driver errors are surfaced by the driver itself
        }
      }
      if (!alive()) return;
      // The pool's own outcome is applied here too (deduped by tx hash) —
      // in production the bid route already recorded it on the way out.
      if (outcome?.ok) {
        this.recordBid({ chainLotId, amountMinor: outcome.amountMinor, bidder: outcome.bidder, txHash: outcome.txHash, label: outcome.label });
      }

      if (this.state.bidCount > before) {
        quiet = 0;
        await wait(TIMING.slotGapMs);
        continue;
      }
      // An attempt that did not land (rejected, reverted) gets a short retry
      // so another agent can take the round; a quiet room moves on.
      if (outcome && !outcome.ok && ++quiet < TIMING.maxQuietAttempts) {
        await wait(TIMING.slotGapMs);
        continue;
      }
      quiet = 0;
      if (this.state.phase === "bidding") {
        this.beginCountdown();
        continue;
      }
      await wait(Math.min(TIMING.countdownPollMs, Math.max(50, this.countdownEndsAt - Date.now())));
    }
    if (alive()) void this.finishLot(lot);
  }

  private beginCountdown(): void {
    const token = ++this.countdownToken;
    const seconds = Math.round(TIMING.countdownMs / 1000);
    this.countdownEndsAt = Date.now() + TIMING.countdownMs;
    this.state = { ...this.state, phase: "countdown", countdown: seconds, phaseEndsAt: this.countdownEndsAt };
    this.emit({ type: "phase", phase: "countdown" });
    this.emit({ type: "snapshot", state: this.snapshot() });
    this.say("countdown", { s: seconds });
    for (let s = seconds - 1; s >= 0; s--) {
      this.later(() => {
        if (token !== this.countdownToken || this.state.phase !== "countdown") return;
        this.state = { ...this.state, countdown: s };
        this.emit({ type: "countdown", seconds: s });
        this.emit({ type: "snapshot", state: this.snapshot() });
      }, (seconds - s) * 1000);
    }
  }

  /** A late bid reopens the floor: back to bidding, countdown cancelled. */
  private reopen(): void {
    this.countdownToken++;
    this.state = { ...this.state, phase: "bidding", countdown: 0, phaseEndsAt: 0 };
    this.emit({ type: "phase", phase: "bidding" });
  }

  private async finishLot(lot: Lot, done?: () => void): Promise<void> {
    if (this.state.phase === "sold") { done?.(); return; }
    this.countdownToken++;
    this.state = { ...this.state, phase: "sold", countdown: 0, phaseEndsAt: Date.now() + TIMING.soldMs };
    this.emit({ type: "phase", phase: "sold" });

    let amount = this.state.currentBidMinor;
    let winner = this.state.leaderLabel;
    let winnerId = this.state.leaderId;
    const hasBids = this.state.bidCount > 0;
    // If a manual Next() opened another lot while onSold was awaiting, this
    // continuation is stale — the settle side effects (claims/mint) are keyed
    // by chainLotId inside the hook and stay correct, but the emits below
    // would overlay the OLD sale onto the NEW lot.
    const chainLotIdAtStart = this.currentChainLotId;

    if (!hasBids) {
      // No bids: nothing to settle, no SOLD, no receipt — the lot simply passes.
      this.hooks.onUnsold?.(lot, chainLotIdAtStart);
      this.emit({ type: "unsold", lotId: lot.id });
      this.emit({ type: "snapshot", state: this.snapshot() });
      this.say("unsold", {});
    } else {
      // The hammer falls before settlement — the voice shouldn't wait on Arc.
      this.say("sold", { amountMinor: amount }, { bidderLabel: winner });
      let txHash: string | undefined;
      if (this.hooks.onSold) {
        try {
          const r = await this.hooks.onSold(lot, amount, chainLotIdAtStart);
          if (typeof r === "string") txHash = r;
          else if (r) {
            txHash = r.txHash;
            if (r.winnerId && r.amountMinor > 0) {
              winnerId = r.winnerId;
              winner = r.winnerLabel ?? winner;
              amount = r.amountMinor;
            }
          }
        } catch { /* settle failure is surfaced in the log */ }
        if (this.currentChainLotId !== chainLotIdAtStart) return;
      }
      this.emit({ type: "sold", lotId: lot.id, amountMinor: amount, winner, winnerId, txHash });
      this.emit({ type: "snapshot", state: this.snapshot() });
    }

    const advance = done ?? (() => this.advanceLot());
    this.later(advance, TIMING.soldMs);
  }
}

const g = globalThis as typeof globalThis & { __commendaEngine?: AuctionEngine };
export function getEngine(): AuctionEngine {
  if (!g.__commendaEngine) g.__commendaEngine = new AuctionEngine();
  return g.__commendaEngine;
}
