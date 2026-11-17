/**
 * Bid orchestration: sync → decide → submit → in-flight. No HTTP, no x402.
 * Depends on a ChainPort interface so it is testable with a fake adapter.
 * Implements the lock ordering and atomic commit from CALLER_DESIGN §2.
 */
import { decide, bidKey, type Bid, type Decision, type Mandate } from "./decide";
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
 * Commit decide's `next` plus new-event credits under the global lock, merging
 * into the existing mandate (never rebuild from chain events alone — H1).
 */
export async function commit(
  state: AuctionState,
  agentId: string,
  next: Mandate,
  events: ChainEvent[],
): Promise<void> {
  await state.globalLock.run(() => {
    const current = state.getMandate(agentId);
    if (!current) return;
    // decide-managed fields come from `next`; only spentMinor is adjusted by credits.
    const merged: Mandate = { ...next };
    const r = reconcile(
      new Map([[agentId, merged]]),
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
    void latestBlock;
    await commit(state, agentId, mandate, events);
    const fresh = state.getMandate(agentId)!;

    // 2. Decide against a fresh, authoritative mandate.
    const result = decide(bid, fresh, deps.now());
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
    } catch {
      // Definite broadcast failure: increment failures ONLY (no other next effects).
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
