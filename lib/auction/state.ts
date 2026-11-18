/**
 * In-memory state store for the demo: mandates, in-flight submissions, and a
 * global reconciliation lock. Single-process assumption (documented).
 *
 * Lock scopes (auditor B1):
 *  - per-agent decision lock: serializes decide+submit for one agent
 *  - GLOBAL reconciliation lock: serializes every mandate write (credits + next)
 */
import type { Mandate } from "./decide";
import type { IngestState } from "./reconcile";

/** A promise-chain mutex: `run(fn)` executes fn serially and always releases. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const previous = this.tail;
    this.tail = this.tail.then(() => gate);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export type InFlightEntry = {
  bidKey: string;
  agentId: string;
  txHash?: string;
  createdAt: number;
  next: import("./decide").DecideResult["next"];
  bid: import("./decide").Bid;
  fromBlock: bigint;
  status: "pending" | "needs_manual_intervention";
};

export class AuctionState {
  readonly mandates = new Map<string, Mandate>();
  /** On-chain bidder/seller address (lowercase) -> canonical agent id (auditor F4). */
  readonly addressToAgent = new Map<string, string>();
  readonly ingest: IngestState = { cursor: null, seen: new Set() };
  readonly inFlight = new Map<string, InFlightEntry>();

  /** Per-lot current leader, derived from applied BidPlaced events. FIFO-capped. */
  private readonly lotLeaders = new Map<number, { agentId: string; amountMinor: number }>();
  private static readonly LOT_LEADER_CAP = 64;

  /** One global lock for ALL mandate writes. */
  readonly globalLock = new Mutex();

  private readonly agentLocks = new Map<string, Mutex>();

  agentLock(agentId: string): Mutex {
    let m = this.agentLocks.get(agentId);
    if (!m) {
      m = new Mutex();
      this.agentLocks.set(agentId, m);
    }
    return m;
  }

  setMandate(agentId: string, mandate: Mandate): void {
    this.mandates.set(agentId, mandate);
  }

  getMandate(agentId: string): Mandate | undefined {
    return this.mandates.get(agentId);
  }

  /** Is an unresolved submission currently in flight for this agent?
   *  Only `pending` blocks: a `needs_manual_intervention` entry is past its
   *  resolution deadline (Arc finality makes "unknown" a stuck RPC, not a live
   *  tx), so it must not wedge the agent into permanent `busy`. The entry
   *  stays in the registry for observability; a late-confirming tx is still
   *  reconciled through the event cursor. */
  hasInFlight(agentId: string): boolean {
    for (const entry of this.inFlight.values()) {
      if (entry.agentId === agentId && entry.status === "pending") return true;
    }
    return false;
  }

  addInFlight(entry: InFlightEntry): void {
    this.inFlight.set(entry.bidKey, entry);
  }

  removeInFlight(bidKey: string): void {
    this.inFlight.delete(bidKey);
  }

  /** Record the current leader for a lot (FIFO-capped; safe under globalLock). */
  setLeader(chainLotId: number, agentId: string, amountMinor: number): void {
    this.lotLeaders.set(chainLotId, { agentId, amountMinor });
    if (this.lotLeaders.size > AuctionState.LOT_LEADER_CAP) {
      const oldest = this.lotLeaders.keys().next().value;
      if (oldest !== undefined) this.lotLeaders.delete(oldest);
    }
  }

  /** Leader for a lot, or undefined. Malformed lot ids fail open. */
  getLeader(chainLotId: number): { agentId: string; amountMinor: number } | undefined {
    if (!Number.isSafeInteger(chainLotId) || chainLotId < 0) return undefined;
    return this.lotLeaders.get(chainLotId);
  }
}
