/**
 * In-flight resolver (auditor B3/M6): a keyed registry of submissions plus a
 * resolve() that turns a tx outcome into a deterministic mandate write.
 *
 * This module is pure with respect to infrastructure: the caller supplies a
 * `resolveTx` function (receipt lookup) and a `commit` callback that runs under
 * the global lock. No RPC here.
 */
import type { AuctionState, InFlightEntry } from "./state";
import type { ChainEvent } from "./reconcile";
import { bidKey, type Bid, type Mandate } from "./decide";

/**
 * Merge a resolver-confirmed decision's `next` into the CURRENT mandate without
 * losing concurrent writes (audit finding 5 + review 2.1):
 *  - policy fields (budget, caps, watchlists, killSwitch, approval) come from
 *    `current` — a pending bid must never resurrect a flipped kill switch or
 *    revert a mid-flight policy change;
 *  - decide-managed fields come from `next`; seenKeys is UNIONED so a
 *    conservative manual-escalation key can never be un-recorded;
 *  - spentMinor = current (credit-adjusted) + this bid's amount — the only
 *    delta decide() contributed, since the per-agent lock serializes decides.
 */
export function mergeCommittedNext(current: Mandate | undefined, next: Mandate, bid: Bid): Mandate {
  if (!current) return next;
  return {
    ...current,
    spentMinor: Math.max(0, current.spentMinor + bid.amountMinor),
    seenKeys: new Set([...current.seenKeys, ...next.seenKeys]),
    approvedKeys: next.approvedKeys,
    recentBidTimesMs: next.recentBidTimesMs,
    consecutiveFailures: next.consecutiveFailures,
  };
}

export type TxOutcome =
  | { status: "success"; blockNumber: bigint; events: ChainEvent[] }
  | { status: "reverted" }
  | { status: "unknown" };

export type ResolveDeps = {
  /** Look up a submitted tx's outcome (receipt + events). RPC/timeout handled by caller. */
  resolveTx: (txHash: string, fromBlock: bigint) => Promise<TxOutcome>;
  /** Apply an entry's commit under the GLOBAL + per-agent lock (caller-owned). */
  commit: (entry: InFlightEntry, outcome: TxOutcome) => Promise<void>;
  now: () => number;
  deadlineMs?: number;
};

/**
 * Conservative commit for an entry whose outcome is unknowable past the
 * deadline (review 1.1/1.2): the tx may still confirm, so count the spend and
 * record the idempotency key NOW. A released agent must never under-count its
 * budget or re-submit the identical bid. Over-counting on a late revert is the
 * safe direction — on-chain refunds still credit via the event cursor if the
 * tx confirms later.
 * MUST run under the global lock.
 */
export function escalateManual(state: AuctionState, entry: InFlightEntry): void {
  const cur = state.inFlight.get(entry.bidKey);
  if (cur) state.inFlight.set(entry.bidKey, { ...cur, status: "needs_manual_intervention" });
  const m = state.getMandate(entry.agentId);
  if (m) {
    state.setMandate(entry.agentId, {
      ...m,
      spentMinor: Math.max(0, m.spentMinor + entry.bid.amountMinor),
      seenKeys: new Set(m.seenKeys).add(bidKey(entry.agentId, entry.bid)),
    });
  }
}

/** Resolve one entry. Returns what happened to it. */
export async function resolveEntry(
  state: AuctionState,
  entry: InFlightEntry,
  deps: ResolveDeps,
): Promise<"committed" | "failed" | "retained" | "manual"> {
  // Escalate stale entries without any RPC.
  if (deps.now() - entry.createdAt > (deps.deadlineMs ?? 120_000)) {
    await deps.commit(entry, { status: "unknown" }); // caller marks manual under lock
    return "manual";
  }
  if (!entry.txHash) return "retained"; // not broadcast yet

  const outcome = await deps.resolveTx(entry.txHash, entry.fromBlock);

  if (outcome.status === "unknown") return "retained";

  // Serialize the mandate write through the caller's commit (global lock).
  await deps.commit(entry, outcome);
  return outcome.status === "success" ? "committed" : "failed";
}

/** Resolve every non-manual entry (polling loop is the caller's responsibility). */
export async function resolveAll(
  state: AuctionState,
  deps: ResolveDeps,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = { committed: 0, failed: 0, retained: 0, manual: 0 };
  for (const entry of [...state.inFlight.values()]) {
    if (entry.status === "needs_manual_intervention") continue;
    const result = await resolveEntry(state, entry, deps);
    counts[result] += 1;
  }
  return counts;
}
