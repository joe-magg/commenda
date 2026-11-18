/**
 * Bid orchestration: sync → decide → submit → in-flight. No HTTP, no x402.
 * Depends on a ChainPort interface so it is testable with a fake adapter.
 * Implements the lock ordering and atomic commit from CALLER_DESIGN §2.
 */
import { decide, bidKey, type AuditEntry, type Bid, type Decision, type Mandate } from "./decide";
import { reconcile, type ChainEvent } from "./reconcile";
import { AuctionState, type InFlightEntry } from "./state";

export type ChainPort = {
  /** Fetch escrow events from a block (RPC — called OUTSIDE the global lock). */
  syncEvents: (fromBlock?: bigint) => Promise<{ events: ChainEvent[]; latestBlock: bigint }>;
  /** Broadcast approve+placeBid using the agent's server-held wallet. */
  submitPlaceBid: (bid: Bid, agentId: string) => Promise<{ txHash: string; fromBlock: bigint }>;
};

export type SubmitBidDeps = {
  chain: ChainPort;
  /** Server-side agent resolution from the authenticated payer — NEVER from the bid body. */
  resolveAgentId: (payer: string) => string | null;
  payer: string;
  now: () => number;
  /** Observe every decide() outcome (BID/REJECT/NEEDS_APPROVAL) for the audit log.
   *  Optional so tests stay dependency-free; production wires it to audit_events. */
  onDecision?: (audit: AuditEntry) => void;
};

export type SubmitResult =
  | { status: "placed"; txHash: string }
  | { status: "rejected"; rule: string }
  | { status: "needs_approval" }
  | { status: "busy" }
  | { status: "no_agent" }
  | { status: "pending"; txHash: string }
  | { status: "failed"; txHash: string };

/**
 * Thrown AFTER a broadcast obtained a tx hash but its outcome is unknown
 * (receipt unavailable, RPC drop). Carries the hash so the caller can keep a
 * pending in-flight entry — the resolver, not the catch path, decides the
 * outcome. A plain Error remains a definite pre-hash failure.
 */
export class BroadcastError extends Error {
  constructor(message: string, readonly txHash: string) {
    super(message);
    this.name = "BroadcastError";
  }
}

/**
 * Apply new-event credits under the global lock, merging into the CURRENT
 * mandate (never from a stale snapshot — H1 + review 2.1). The per-agent lock
 * serializes decides, but a resolver commit for a previous entry can land
 * between this call's read and its lock section — starting from the current
 * mandate preserves its decide-managed state and credits.
 */
export async function commit(
  state: AuctionState,
  agentId: string,
  events: ChainEvent[],
): Promise<void> {
  await state.globalLock.run(() => {
    const current = state.getMandate(agentId);
    if (!current) return;
    const r = reconcile(
      new Map([[agentId, current]]),
      state.ingest,
      events,
      (addr) => state.addressToAgent.get(addr.toLowerCase()) ?? addr.toLowerCase(),
    );
    const updated = r.mandates.get(agentId);
    if (updated) state.setMandate(agentId, updated);
    state.ingest.cursor = r.ingest.cursor;
    state.ingest.seen = r.ingest.seen;
  });
}

export async function submitBid(
  state: AuctionState,
  bid: Bid,
  deps: SubmitBidDeps,
): Promise<SubmitResult> {
  const agentId = deps.resolveAgentId(deps.payer);
  if (!agentId) return { status: "no_agent" };

  return state.agentLock(agentId).run(async () => {
    if (state.hasInFlight(agentId)) return { status: "busy" };

    const mandate = state.getMandate(agentId);
    if (!mandate) return { status: "no_agent" };

    // 1. Sync from chain (RPC outside locks), then reconcile under the global lock.
    const { events, latestBlock } = await deps.chain.syncEvents(state.ingest.cursor?.blockNumber);
    await commit(state, agentId, events);
    const fresh = state.getMandate(agentId)!;

    // 2. Decide against a fresh, authoritative mandate.
    const result = decide(bid, fresh, deps.now());
    // Persist the decision audit for ALL branches — never discard it (audit finding 3).
    try { deps.onDecision?.(result.audit); } catch { /* audit must never break bidding */ }
    if (result.decision.decision === "REJECT") {
      return { status: "rejected", rule: result.decision.rule };
    }
    if (result.decision.decision === "NEEDS_APPROVAL") {
      return { status: "needs_approval" };
    }

    // 3. Broadcast (RPC outside the global lock, inside the per-agent lock).
    let submitted: { txHash: string; fromBlock: bigint };
    try {
      submitted = await deps.chain.submitPlaceBid(bid, agentId);
    } catch (e) {
      if (e instanceof BroadcastError) {
        // Post-hash failure: the tx may still confirm. Keep the pending entry
        // with decide's full next (preserving seenKeys/spent) — the resolver
        // decides the outcome. HTTP-wise this maps to "pending" (see handler).
        const entry: InFlightEntry = {
          bidKey: bidKey(agentId, bid),
          agentId,
          txHash: e.txHash,
          createdAt: deps.now(),
          next: result.next,
          bid,
          // The tx was mined after the block we synced at decision time — a
          // tight lookback that never lets the resolver's ingest cursor jump
          // past other agents' unapplied credits (a 0n scan would).
          fromBlock: latestBlock > 2n ? latestBlock - 2n : 0n,
          status: "pending",
        };
        await state.globalLock.run(() => state.addInFlight(entry));
        return { status: "pending", txHash: e.txHash };
      }
      // Definite pre-hash broadcast failure: increment failures ONLY
      // (no other next effects — the bid never reached the chain).
      await state.globalLock.run(() => {
        const m = state.getMandate(agentId)!;
        state.setMandate(agentId, { ...m, consecutiveFailures: m.consecutiveFailures + 1 });
      });
      return { status: "failed", txHash: "" };
    }

    const entry: InFlightEntry = {
      bidKey: bidKey(agentId, bid),
      agentId,
      txHash: submitted.txHash,
      createdAt: deps.now(),
      next: result.next, // full next persisted for the resolver (auditor D1)
      bid,
      fromBlock: submitted.fromBlock,
      status: "pending",
    };
    await state.globalLock.run(() => state.addInFlight(entry));

    return { status: "placed", txHash: submitted.txHash };
  });
}
