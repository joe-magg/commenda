/**
 * Background in-flight resolver. Arc has instant finality and the chain adapter
 * already awaits receipts, so entries resolve in ~1 tick. Without this loop,
 * submitBid()'s committed `next` is never applied and the agent stays BUSY.
 *
 * The success branch reconciles ALL mandates with the new events (not just the
 * submitting agent), so an outbid credit for another agent is never marked seen
 * without being applied — a cross-agent correctness fix for the demo loop.
 */
import type { Address } from "viem";
import { createChainAdapter, createTxResolver } from "./chain";
import { resolveAll, type ResolveDeps } from "./inflight";
import { reconcile } from "./reconcile";
import { getRuntime } from "./runtime";

export function startResolver(): () => void {
  const { state } = getRuntime();
  const escrow = process.env.ESCROW_ADDRESS as Address;
  if (!escrow) throw new Error("ESCROW_ADDRESS missing — resolver not started");

  const resolveTx = createTxResolver({});
  const chain = createChainAdapter({ escrowAddress: escrow, agentKeys: {} });

  const deps: ResolveDeps = {
    resolveTx: async (txHash, fromBlock) => {
      try {
        const r = await resolveTx(txHash);
        if (r.status === "reverted") return { status: "reverted" };
        const { events } = await chain.syncEvents(fromBlock);
        return { status: "success", blockNumber: r.blockNumber, events };
      } catch {
        return { status: "unknown" };
      }
    },
    commit: async (entry, outcome) => {
      await state.globalLock.run(() => {
        if (outcome.status === "unknown") {
          const cur = state.inFlight.get(entry.bidKey);
          if (cur) state.inFlight.set(entry.bidKey, { ...cur, status: "needs_manual_intervention" });
          return; // retention is deliberate
        }
        if (outcome.status === "reverted") {
          const m = state.getMandate(entry.agentId);
          if (m) state.setMandate(entry.agentId, { ...m, consecutiveFailures: m.consecutiveFailures + 1 });
        } else {
          // Apply the decision's committed next, then credit EVERY affected mandate.
          state.setMandate(entry.agentId, entry.next);
          const all = new Map(state.mandates);
          const r = reconcile(all, state.ingest, outcome.events, (addr) =>
            state.addressToAgent.get(addr.toLowerCase()) ?? addr.toLowerCase(),
          );
          for (const [id, m] of r.mandates) state.setMandate(id, m);
          state.ingest.cursor = r.ingest.cursor;
          state.ingest.seen = r.ingest.seen;
        }
        state.removeInFlight(entry.bidKey);
      });
    },
    now: () => Date.now(),
    deadlineMs: 120_000,
  };

  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const counts = await resolveAll(state, deps);
      if (counts.committed || counts.failed) {
        console.info("[commenda:resolver]", JSON.stringify(counts));
      }
    } catch (e) {
      console.warn("[commenda:resolver] tick failed", e instanceof Error ? e.message : e);
    }
  };
  const timer = setInterval(tick, 1000);
  return () => { stopped = true; clearInterval(timer); };
}
