/**
 * Auction trace — an in-memory ring buffer of auction behavior plus an
 * analyzer that derives correctness/latency metrics. Purpose: make the
 * demo's bidding observable so anomalies (self-outbids, busy churn,
 * reverts) are provable, not anecdotal.
 *
 * Single-process by design (same assumption as AuctionState).
 */

export type TraceEvent =
  | { kind: "lot_open"; at: number; chainLotId: number; displayId: number }
  | { kind: "lot_end"; at: number; chainLotId: number; winner: string | null }
  | { kind: "bid_attempt"; at: number; agentId: string; chainLotId: number; amountMinor: number; slot: number }
  | {
      kind: "bid_outcome";
      at: number;
      agentId: string;
      chainLotId: number;
      amountMinor: number;
      status: "placed" | "pending" | "failed" | "rejected" | "needs_approval" | "busy" | "no_agent";
      rule?: string;
      /** Which side recorded it — the same bid is seen twice (pool + route). */
      source: "client" | "server";
      msClient?: number; // bidder-side total (x402 verify+settle+bid) when known
      msServer?: number; // bids-route handler total when known
    };

const MAX_EVENTS = 4000;
const events: TraceEvent[] = [];

export function record(event: TraceEvent): void {
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export function snapshot(): TraceEvent[] {
  return [...events];
}

export function resetTrace(): void {
  events.length = 0;
}

export type TraceAnalysis = {
  counts: Record<string, number>;
  latency: {
    clientMs: { p50: number; p95: number; n: number };
    serverMs: { p50: number; p95: number; n: number };
  };
  /** Same agent placing two consecutive successful bids on one lot. */
  selfOutbids: { chainLotId: number; agentId: string; amounts: number[] }[];
  /** Lots where more than one bid attempt was rejected/failed. */
  churn: { chainLotId: number; failed: number; rejected: number; busy: number }[];
  lots: { chainLotId: number; attempts: number; placed: number; pending: number; failed: number }[];
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

type Outcome = Extract<TraceEvent, { kind: "bid_outcome" }>;

/**
 * Merge the two views of the same bid: the pool records the outcome with
 * client latency; the bids route records the same bid with handler latency
 * (usually slightly earlier). A server record within 3s of a client record
 * with the same (agent, lot, amount, status) is the SAME logical bid — fold
 * msServer in and drop the duplicate, otherwise the self-outbid detector
 * counts every demo bid twice. Unmatched server records are real bids from
 * agents outside the pool and stay in the analysis.
 */
function foldServerViews(events: TraceEvent[]): Outcome[] {
  const outcomes = events.filter((e): e is Outcome => e.kind === "bid_outcome");
  const consumed = new Set<number>();
  const merged: Outcome[] = [];
  for (const c of outcomes) {
    if (c.source !== "client") continue;
    const si = outcomes.findIndex(
      (s, i) =>
        !consumed.has(i) &&
        s.source === "server" &&
        s.agentId === c.agentId &&
        s.chainLotId === c.chainLotId &&
        s.amountMinor === c.amountMinor &&
        s.status === c.status &&
        Math.abs(s.at - c.at) <= 3000,
    );
    if (si >= 0) {
      consumed.add(si);
      merged.push({ ...c, msServer: outcomes[si].msServer ?? c.msServer, rule: c.rule ?? outcomes[si].rule });
    } else {
      merged.push(c);
    }
  }
  outcomes.forEach((s, i) => {
    if (s.source === "server" && !consumed.has(i)) merged.push(s);
  });
  return merged;
}

export function analyze(input: TraceEvent[] = snapshot()): TraceAnalysis {
  const outcomes = foldServerViews(input);
  const counts: Record<string, number> = {};
  for (const e of input) {
    if (e.kind !== "bid_outcome") counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  }
  counts["bid_outcome"] = outcomes.length;

  const clientMs = outcomes
    .flatMap((e) => (e.msClient != null ? [e.msClient] : []))
    .sort((a, b) => a - b);
  const serverMs = outcomes
    .flatMap((e) => (e.msServer != null ? [e.msServer] : []))
    .sort((a, b) => a - b);

  // Successful-bid sequence per lot, in arrival order. Only "placed":
  // pending outcomes no longer claim leadership (bidder.ts), so counting
  // them here would fabricate self-outbid pairs.
  const perLot = new Map<number, { agentId: string; amountMinor: number; at: number }[]>();
  for (const e of outcomes) {
    if (e.status !== "placed") continue;
    const list = perLot.get(e.chainLotId) ?? [];
    list.push({ agentId: e.agentId, amountMinor: e.amountMinor, at: e.at });
    perLot.set(e.chainLotId, list);
  }

  const selfOutbids: TraceAnalysis["selfOutbids"] = [];
  for (const [chainLotId, bids] of perLot) {
    for (let i = 1; i < bids.length; i++) {
      if (bids[i].agentId === bids[i - 1].agentId) {
        const existing = selfOutbids.find((s) => s.chainLotId === chainLotId && s.agentId === bids[i].agentId);
        if (existing) existing.amounts.push(bids[i].amountMinor);
        else selfOutbids.push({ chainLotId, agentId: bids[i].agentId, amounts: [bids[i - 1].amountMinor, bids[i].amountMinor] });
      }
    }
  }

  const churn = new Map<number, { failed: number; rejected: number; busy: number }>();
  const lots = new Map<number, { attempts: number; placed: number; pending: number; failed: number }>();
  for (const e of outcomes) {
    const c = churn.get(e.chainLotId) ?? { failed: 0, rejected: 0, busy: 0 };
    if (e.status === "failed") c.failed++;
    if (e.status === "rejected") c.rejected++;
    if (e.status === "busy") c.busy++;
    churn.set(e.chainLotId, c);

    const l = lots.get(e.chainLotId) ?? { attempts: 0, placed: 0, pending: 0, failed: 0 };
    l.attempts++;
    if (e.status === "placed") l.placed++;
    if (e.status === "pending") l.pending++;
    if (e.status === "failed") l.failed++;
    lots.set(e.chainLotId, l);
  }

  return {
    counts,
    latency: {
      clientMs: { p50: percentile(clientMs, 50), p95: percentile(clientMs, 95), n: clientMs.length },
      serverMs: { p50: percentile(serverMs, 50), p95: percentile(serverMs, 95), n: serverMs.length },
    },
    selfOutbids,
    churn: [...churn.entries()].map(([chainLotId, v]) => ({ chainLotId, ...v })).filter((c) => c.failed + c.rejected + c.busy > 0),
    lots: [...lots.entries()].map(([chainLotId, v]) => ({ chainLotId, ...v })),
  };
}
