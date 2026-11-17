/**
 * Event-driven bidder pool. Replaces the hardcoded bid script: agents are
 * loaded from the registry on every lot open, filtered by watchlist, and bid
 * with amounts derived from their policy. They join mid-show, and leave when
 * capped, out of budget, or when the lot ends.
 */
import { getPaidAgents, placeBid, type PaidAgent } from "./bidder";
import { listAgents } from "@/lib/db/repo";
import type { Lot } from "./lots";
import type { AuctionEvent, BidOutcome } from "./engine";

const INCREMENT_MINOR = 100_000; // 0.10 USDC per step
const MAX_BIDS_PER_LOT = 6;

type JoinedAgent = {
  agent: PaidAgent;
  perBidCapMinor: number;
  bids: number;
  left: boolean;
};

/** Pure selection logic, exported for table tests. */
export type BidderCapability = { perBidCapMinor: number; bids: number; left: boolean };

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
};

const g = globalThis as typeof globalThis & { __commendaPool?: BidWorkerPool };

export class BidWorkerPool {
  private lots = new Map<number, LotState>();
  private emit: (e: AuctionEvent) => void = () => {};

  setEmitter(fn: (e: AuctionEvent) => void): void {
    this.emit = fn;
  }

  /** Refresh from the registry: an agent enabled mid-show joins the next lot. */
  onLotOpen(lot: Lot, chainLotId: number): void {
    const funded = new Map(getPaidAgents().map((a) => [a.id, a]));
    const policies = new Map(listAgents().map((a) => [a.id, a.policy]));
    const joined: JoinedAgent[] = [];
    for (const [id, agent] of funded) {
      const policy = policies.get(id);
      if (!policy || !policy.watchlist.includes(lot.category)) continue;
      joined.push({ agent, perBidCapMinor: policy.perBidCapMinor, bids: 0, left: false });
      this.emit({ type: "agent_join", agentId: id, label: agent.label, lotId: lot.id });
    }
    this.lots.set(chainLotId, { displayId: lot.id, joined, currentBidder: null });
  }

  /** Pick an eligible agent for this slot and place a policy-derived bid. */
  async onBidSlot(lot: Lot, slot: number, chainLotId: number): Promise<BidOutcome | null> {
    const state = this.lots.get(chainLotId);
    if (!state) return null;

    const nextAmount = nextBidAmount(lot.openingMinor, slot);
    const eligibleIndices = eligibleBidders(state.joined, slot, nextAmount);
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
    const result = await placeBid(pick.agent, {
      id: `${pick.agent.id.slice(0, 10)}-${chainLotId}-${nextAmount}`,
      lotId: String(chainLotId),
      amountMinor: nextAmount,
      category: lot.category,
      seller: lot.seller,
    });

    if (result.ok) {
      state.currentBidder = pick.agent.id;
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

  /** Called on SOLD: remaining agents leave and the lot state is released. */
  onLotEnd(chainLotId: number): void {
    const state = this.lots.get(chainLotId);
    if (!state) return;
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
