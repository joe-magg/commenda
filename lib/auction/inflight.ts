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
