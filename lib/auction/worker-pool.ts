/**
 * The agent pool. Each funded agent decides for itself, every round, from
 * its persona and its PRIVATE valuation of the item (lib/agents/strategy.ts):
 * raise, wait, or drop out. The pool only plays the floor: it collects the
 * round's proposals, the auctioneer recognises one hand (pickRound), and that
 * agent places its bid through the public x402 endpoint like any client.
 *
 * Nothing here can move money: proposals go through POST /api/bids, where
 * decide() is the sole authority and the escrow is the truth.
 */
import { getPaidAgents, placeBid, type PaidAgent } from "./bidder";
import { record, type TraceEvent } from "./trace";
import { listAgents, listClaims } from "@/lib/db/repo";
import { personaFor } from "@/lib/agents/roster";
import { isUserAgent } from "@/lib/agents/wallets";
import { formatMinor } from "./lots";
import {
  intent, pickRound, valuation, minNextBid,
  type AgentProfile, type Market,
} from "@/lib/agents/strategy";
import type { Lot } from "./lots";
import type { AuctionEvent, BidOutcome, MindState, RoundContext } from "./engine";

/** Hard ceiling on an agent's bids per lot (runaway-loop guard, not strategy). */
const MAX_BIDS_PER_LOT = 8;

type JoinedAgent = {
  agent: PaidAgent;
  profile: AgentProfile;
  /** Private: never leaves the server except as an owner-only audit detail. */
  valueMinor: number;
  maxWins: number;
  wins: number;
  bids: number;
  left: boolean;
  waiting: boolean;
  /** Last private thought sent to the owner (dedupe). */
  lastMind: string;
};

/** Pure selection logic, exported for table tests. */
export type BidderCapability = { perBidCapMinor: number; bids: number; left: boolean };

/** The "max items to buy per deploy" guardrail. */
export function canDeploy(wins: number, maxWins: number): boolean {
  return wins < maxWins;
}

export function eligibleBidders(
  joined: readonly BidderCapability[],
  amount: number,
): number[] {
  return joined
    .map((_, i) => i)
    .filter((i) => {
      const j = joined[i];
      return !j.left && j.bids < MAX_BIDS_PER_LOT && j.perBidCapMinor >= amount;
    });
}

/** Market view the pool reads before each round (engine snapshot in prod). */
export type MarketSource = (chainLotId: number) => {
  highestMinor: number | null;
  leaderId: string | null;
  bidCount: number;
} | null;

type LotState = {
  displayId: number;
  lot: Lot;
  joined: JoinedAgent[];
  /** Local fallback market (used when no MarketSource is wired). */
  highestMinor: number | null;
  currentBidder: string | null;
  bidCount: number;
  /** A round's outcome is still resolving — the next round must not start. */
  slotBusy: boolean;
};

const g = globalThis as typeof globalThis & { __commendaPool?: BidWorkerPool };

export class BidWorkerPool {
  private lots = new Map<number, LotState>();
  private emit: (e: AuctionEvent) => void = () => {};
  private market: MarketSource | null = null;
  // Wins are scoped to the current auction (reset by the scheduler).
  private cycleWins = new Map<string, number>();

  setEmitter(fn: (e: AuctionEvent) => void): void {
    this.emit = fn;
  }

  setMarketSource(fn: MarketSource): void {
    this.market = fn;
  }

  /** Private narration for user agents' owners — deduped, never broadcast
   *  (the stream filters agent_mind to the owner). */
  private mind(j: JoinedAgent | { agent: PaidAgent; valueMinor: number | null; lastMind?: string }, lotId: number, state: MindState, text: string): void {
    if (!isUserAgent(j.agent.id)) return;
    const key = `${state}|${text}`;
    if ("lastMind" in j && j.lastMind === key) return;
    if ("lastMind" in j) (j as JoinedAgent).lastMind = key;
    this.emit({ type: "agent_mind", agentId: j.agent.id, lotId, state, text, limitMinor: j.valueMinor ?? null });
  }

  /** Owner recalled the agent: it stops on this lot immediately. */
  recall(agentId: string): void {
    for (const state of this.lots.values()) {
      const j = state.joined.find((x) => x.agent.id === agentId);
      if (!j || j.left) continue;
      j.left = true;
      this.mind(j, state.displayId, "recalled", "Recalled. No more bids — whatever it holds in escrow settles as normal.");
    }
  }

  /** Refresh from the registry: an agent enabled mid-show joins the next lot. */
  onLotOpen(lot: Lot, chainLotId: number): void {
    const funded = new Map(getPaidAgents().map((a) => [a.id, a]));
    const policies = new Map(listAgents().map((a) => [a.id, a.policy]));
    const joined: JoinedAgent[] = [];
    for (const [id, agent] of funded) {
      const policy = policies.get(id);
      if (!policy) continue;
      if (!policy.watchlist.includes(lot.category)) {
        this.mind({ agent, valueMinor: null }, lot.id, "skipping", `Sitting this one out — ${lot.category} isn't in your categories.`);
        continue;
      }
      // House agents' win limit is per auction (they live forever on the
      // demo floor). YOUR agent's "stops after N wins" is a lifetime promise:
      // count every lot it has ever won.
      const wins = isUserAgent(id) ? listClaims(id).length : (this.cycleWins.get(id) ?? 0);
      if (!canDeploy(wins, policy.maxWins)) {
        this.mind({ agent, valueMinor: null }, lot.id, "skipping", `Done for this auction — it already bought ${wins} item${wins === 1 ? "" : "s"}, your limit.`);
        continue;
      }
      const persona = (policy.strategy as AgentProfile["persona"] | undefined) ?? personaFor(id);
      const profile: AgentProfile = { id, persona, perBidCapMinor: policy.perBidCapMinor, watchlist: policy.watchlist };
      // A house agent's limit is its private valuation; YOUR agent's limit is
      // exactly the ceiling you set — it bids up to it and never past it.
      const valueMinor = isUserAgent(id)
        ? Math.floor(policy.perBidCapMinor / 10_000) * 10_000
        : valuation(profile, { sku: lot.sku, category: lot.category, openingMinor: lot.openingMinor });
      const j: JoinedAgent = { agent, profile, valueMinor, maxWins: policy.maxWins, wins, bids: 0, left: false, waiting: false, lastMind: "" };
      joined.push(j);
      // Public: an agent joined. Its persona stays private.
      this.emit({ type: "agent_join", agentId: id, label: agent.label, lotId: lot.id });
      this.mind(j, lot.id, "watching", `In. Watching the opening — your ceiling here is ${formatMinor(valueMinor)}.`);
    }
    this.lots.set(chainLotId, {
      displayId: lot.id, lot, joined, highestMinor: null, currentBidder: null, bidCount: 0, slotBusy: false,
    });
    record({ kind: "lot_open", at: Date.now(), chainLotId, displayId: lot.id });
  }

  private readMarket(state: LotState, chainLotId: number, ctx: RoundContext): Market {
    const m = this.market?.(chainLotId);
    return {
      highestMinor: m ? m.highestMinor : state.highestMinor,
      leaderId: m ? m.leaderId : state.currentBidder,
      bidCount: m ? m.bidCount : state.bidCount,
      openingMinor: state.lot.openingMinor,
      phase: ctx.phase,
      secondsLeft: ctx.secondsLeft,
    };
  }

  /** One round: every agent decides; the floor recognises one hand. */
  async onBidSlot(
    lot: Lot,
    slot: number,
    chainLotId: number,
    ctx: RoundContext = { phase: "bidding", secondsLeft: null },
  ): Promise<BidOutcome | null> {
    const state = this.lots.get(chainLotId);
    if (!state) return null;
    // Defense in depth: one unresolved round per lot, period.
    if (state.slotBusy) return null;

    const market = this.readMarket(state, chainLotId, ctx);
    const proposals: { id: string; amountMinor: number; j: JoinedAgent; why: string }[] = [];
    for (const j of state.joined) {
      if (j.left) continue;
      if (j.bids >= MAX_BIDS_PER_LOT) continue;
      const it = intent(j.profile, j.valueMinor, market);
      if (it.act === "drop") {
        j.left = true;
        // Public sees only that it stopped; the owner sees why.
        this.emit({ type: "agent_leave", agentId: j.agent.id, label: j.agent.label, lotId: state.displayId, reason: "" });
        this.mind(j, state.displayId, "out", `Out. The next bid would pass your ${formatMinor(j.valueMinor)} ceiling.`);
        continue;
      }
      if (it.act === "wait") {
        if (it.why === "already leading") {
          this.mind(j, state.displayId, "leading", `Leading at ${formatMinor(market.highestMinor ?? 0)}. Holding.`);
        } else {
          this.mind(j, state.displayId, "holding", "Holding back — it strikes in the final seconds.");
        }
        continue;
      }
      proposals.push({ id: j.agent.id, amountMinor: it.amountMinor, j, why: it.why });
    }

    const pick = pickRound(proposals, `${chainLotId}:${market.bidCount}`);
    if (!pick) return null;

    const j = pick.j;
    j.bids++;
    this.mind(j, state.displayId, "raising", `Raising to ${formatMinor(pick.amountMinor)}${pick.why === "jump bid" ? " — a jump bid to thin the field" : pick.why === "late strike" ? " — a late strike" : ""}.`);
    const previousBidder = market.leaderId;
    state.slotBusy = true;
    record({ kind: "bid_attempt", at: Date.now(), agentId: j.agent.id, chainLotId, amountMinor: pick.amountMinor, slot });
    const startedAt = Date.now();
    let result: BidOutcome;
    try {
      // The agent states only lot + amount; the server derives the lot's
      // category and seller itself and rejects any mismatch.
      result = await placeBid(j.agent, {
        id: `${j.agent.id.slice(0, 10)}-${chainLotId}-${pick.amountMinor}`,
        lotId: String(chainLotId),
        amountMinor: pick.amountMinor,
        category: lot.category,
        seller: lot.seller,
      });
    } finally {
      state.slotBusy = false;
    }

    const outcome: TraceEvent = {
      kind: "bid_outcome",
      at: Date.now(),
      agentId: j.agent.id,
      chainLotId,
      amountMinor: pick.amountMinor,
      status: "rejected",
      rule: result.ok ? undefined : result.rule,
      source: "client",
      msClient: Date.now() - startedAt,
    };
    if (result.ok) {
      outcome.status = "placed";
      state.currentBidder = j.agent.id;
      state.highestMinor = pick.amountMinor;
      state.bidCount++;
    } else if (result.rule === "PENDING") {
      outcome.status = "pending";
    } else if (result.rule === "busy" || result.rule === "NETWORK_ERROR") {
      outcome.status = result.rule === "busy" ? "busy" : "failed";
    } else if (result.rule === "needs_approval" || result.rule === "no_agent") {
      outcome.status = result.rule;
    }
    record(outcome);

    if (result.ok) {
      return { ...result, label: j.agent.label, previousBidder: previousBidder ?? undefined };
    }
    if (!j.left && ["BUDGET", "PER_BID_CAP", "CIRCUIT_BREAKER", "KILL_SWITCH", "needs_approval"].includes(result.rule)) {
      j.left = true;
      this.emit({ type: "agent_leave", agentId: j.agent.id, label: j.agent.label, lotId: state.displayId, reason: "" });
      this.mind(j, state.displayId, "blocked", `Stopped by your guardrails: ${result.rule.toLowerCase().replace(/_/g, " ")}.`);
    }
    return result;
  }

  /** Reset per-auction state: a new session means fresh win limits and
   *  no stale lot maps. Called by the scheduler before each auction. */
  resetCycle(): void {
    this.cycleWins.clear();
    this.lots.clear();
  }

  winnerFor(chainLotId: number): string | null {
    return this.lots.get(chainLotId)?.currentBidder ?? null;
  }

  /** Owner-only view of an agent's private limit on the current lot. */
  valuationFor(chainLotId: number, agentId: string): number | null {
    return this.lots.get(chainLotId)?.joined.find((j) => j.agent.id === agentId)?.valueMinor ?? null;
  }

  /** Called on SOLD/UNSOLD: remaining agents leave and the lot state is released. */
  onLotEnd(chainLotId: number, winnerId?: string | null): void {
    record({ kind: "lot_end", at: Date.now(), chainLotId, winner: winnerId ?? null });
    const state = this.lots.get(chainLotId);
    if (winnerId) this.cycleWins.set(winnerId, (this.cycleWins.get(winnerId) ?? 0) + 1);
    if (!state) return;
    this.lots.delete(chainLotId);
  }
}

export { minNextBid };

export function getWorkerPool(): BidWorkerPool {
  if (!g.__commendaPool) g.__commendaPool = new BidWorkerPool();
  return g.__commendaPool;
}
