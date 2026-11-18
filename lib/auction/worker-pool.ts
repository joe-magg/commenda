/**
 * Event-driven bidder pool. Replaces the hardcoded bid script: agents are
 * loaded from the registry on every lot open, filtered by watchlist, and bid
 * with amounts derived from their policy. They join mid-show, and leave when
 * capped, out of budget, or when the lot ends.
 */
import { getPaidAgents, placeBid, type PaidAgent } from "./bidder";
import { record, type TraceEvent } from "./trace";
import { listAgents } from "@/lib/db/repo";
import type { Lot } from "./lots";
import type { AuctionEvent, BidOutcome } from "./engine";

const INCREMENT_MINOR = 100_000; // 0.10 USDC per step
const MAX_BIDS_PER_LOT = 6;

type JoinedAgent = {
  agent: PaidAgent;
  perBidCapMinor: number;
  maxWins: number;
  wins: number;
  bids: number;
  left: boolean;
};

/** Pure selection logic, exported for table tests. */
export type BidderCapability = { perBidCapMinor: number; bids: number; left: boolean };

/** The "max items to buy per deploy" guardrail. */
export function canDeploy(wins: number, maxWins: number): boolean {
  return wins < maxWins;
}

export function nextBidAmount(openingMinor: number, slot: number): number {
  return openingMinor + (slot + 1) * INCREMENT_MINOR;
}

export function eligibleBidders(
  joined: readonly BidderCapability[],
  slot: number,
  amount: number,
): number[] {
  return joined
    .map((j, i) => i)
    .filter((i) => {
      const j = joined[i];
      return !j.left && j.bids < MAX_BIDS_PER_LOT && j.perBidCapMinor >= amount;
    });
}

type LotState = {
  displayId: number;
  joined: JoinedAgent[];
  currentBidder: string | null;
  /** A slot's outcome is still resolving — the next slot must not start. */
  slotBusy: boolean;
};

const g = globalThis as typeof globalThis & { __commendaPool?: BidWorkerPool };

export class BidWorkerPool {
  private lots = new Map<number, LotState>();
  private emit: (e: AuctionEvent) => void = () => {};
  // Wins are scoped to the current show cycle. A long-running site loops the
  // catalog, so a global count would retire the agents after one pass.
  private cycleWins = new Map<string, number>();
  private lastLotId = -1;

  setEmitter(fn: (e: AuctionEvent) => void): void {
    this.emit = fn;
  }

  /** Refresh from the registry: an agent enabled mid-show joins the next lot. */
  onLotOpen(lot: Lot, chainLotId: number): void {
    // Wrapping from the last lot back to the first starts a fresh deploy cycle.
    if (lot.id === 0 && this.lastLotId > 0) this.cycleWins.clear();
    this.lastLotId = lot.id;

    const funded = new Map(getPaidAgents().map((a) => [a.id, a]));
    const policies = new Map(listAgents().map((a) => [a.id, a.policy]));
    const winsFor = (id: string) => this.cycleWins.get(id) ?? 0;
    const joined: JoinedAgent[] = [];
    for (const [id, agent] of funded) {
      const policy = policies.get(id);
      if (!policy || !policy.watchlist.includes(lot.category)) continue;
      const wins = winsFor(id);
      if (!canDeploy(wins, policy.maxWins)) {
        this.emit({
          type: "agent_leave", agentId: id, label: agent.label,
          lotId: lot.id, reason: "max items reached",
        });
        continue;
      }
      joined.push({
        agent, perBidCapMinor: policy.perBidCapMinor,
        maxWins: policy.maxWins, wins, bids: 0, left: false,
      });
      this.emit({ type: "agent_join", agentId: id, label: agent.label, lotId: lot.id });
    }
    this.lots.set(chainLotId, { displayId: lot.id, joined, currentBidder: null, slotBusy: false });
    record({ kind: "lot_open", at: Date.now(), chainLotId, displayId: lot.id });
  }

  /** Pick an eligible agent for this slot and place a policy-derived bid. */
  async onBidSlot(lot: Lot, slot: number, chainLotId: number): Promise<BidOutcome | null> {
    const state = this.lots.get(chainLotId);
    if (!state) return null;
    // Defense in depth against overlapping slots (the engine chains them, but
    // a manual Next() or a slow bid must never produce concurrent bids): one
    // unresolved slot per lot, period.
    if (state.slotBusy) return null;

    const nextAmount = nextBidAmount(lot.openingMinor, slot);
    // Never let the current leader bid again — self-outbids are pointless churn.
    const eligibleIndices = eligibleBidders(state.joined, slot, nextAmount)
      .filter((i) => state.joined[i].agent.id !== state.currentBidder);
    const eligible = eligibleIndices.map((i) => state.joined[i]);

    if (eligible.length === 0) {
      for (const j of state.joined) {
        if (j.left) continue;
        j.left = true;
        this.emit({
          type: "agent_leave", agentId: j.agent.id, label: j.agent.label,
          lotId: state.displayId, reason: "per-bid cap reached",
        });
      }
      return null;
    }

    const pick = state.joined[eligibleIndices[slot % eligibleIndices.length]];
    pick.bids++;
    const previousBidder = state.currentBidder;
    state.slotBusy = true;
    record({ kind: "bid_attempt", at: Date.now(), agentId: pick.agent.id, chainLotId, amountMinor: nextAmount, slot });
    const startedAt = Date.now();
    const result = await placeBid(pick.agent, {
      id: `${pick.agent.id.slice(0, 10)}-${chainLotId}-${nextAmount}`,
      lotId: String(chainLotId),
      amountMinor: nextAmount,
      category: lot.category,
      seller: lot.seller,
    });
    state.slotBusy = false;

    // Trace the outcome with the bidder-side latency.
    const outcome: TraceEvent = {
      kind: "bid_outcome",
      at: Date.now(),
      agentId: pick.agent.id,
      chainLotId,
      amountMinor: nextAmount,
      status: "rejected",
      rule: result.ok ? undefined : result.rule,
      msClient: Date.now() - startedAt,
    };
    if (result.ok) {
      outcome.status = "placed";
      state.currentBidder = pick.agent.id;
    } else if (result.rule === "PENDING") {
      outcome.status = "pending";
    } else if (result.rule === "busy" || result.rule === "NETWORK_ERROR") {
      outcome.status = result.rule === "busy" ? "busy" : "failed";
    } else if (result.rule === "needs_approval" || result.rule === "no_agent") {
      outcome.status = result.rule;
    }
    record(outcome);

    if (result.ok) {
      return { ...result, previousBidder: previousBidder ?? undefined };
    }

    if (
      !pick.left &&
      ["BUDGET", "PER_BID_CAP", "CIRCUIT_BREAKER", "KILL_SWITCH"].includes(result.rule)
    ) {
      pick.left = true;
      this.emit({
        type: "agent_leave", agentId: pick.agent.id, label: pick.agent.label,
        lotId: state.displayId, reason: result.rule.toLowerCase().replace(/_/g, " "),
      });
    }
    return result;
  }

  winnerFor(chainLotId: number): string | null {
    return this.lots.get(chainLotId)?.currentBidder ?? null;
  }

  /** Called on SOLD: remaining agents leave and the lot state is released. */
  onLotEnd(chainLotId: number, winnerId?: string | null): void {
    record({ kind: "lot_end", at: Date.now(), chainLotId, winner: winnerId ?? null });
    const state = this.lots.get(chainLotId);
    if (!state) return;
    if (winnerId) this.cycleWins.set(winnerId, (this.cycleWins.get(winnerId) ?? 0) + 1);
    for (const j of state.joined) {
      if (j.left) continue;
      j.left = true;
      this.emit({
        type: "agent_leave", agentId: j.agent.id, label: j.agent.label,
        lotId: state.displayId, reason: "lot ended",
      });
    }
    this.lots.delete(chainLotId);
  }
}

export function getWorkerPool(): BidWorkerPool {
  if (!g.__commendaPool) g.__commendaPool = new BidWorkerPool();
  return g.__commendaPool;
}
