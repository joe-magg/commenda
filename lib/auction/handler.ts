/**
 * Testable, pure-ish HTTP handler for POST /api/bids.
 * Knows nothing about x402 (the wrapper handles payment) — only body validation,
 * payer→agent resolution, orchestration, and the response DTO allowlist (M4).
 */
import { isValidBid, type Bid } from "./decide";
import { submitBid, type SubmitBidDeps, type SubmitResult } from "./submit-bid";
import type { AuctionState } from "./state";

export type BidResponse = {
  status: "placed" | "rejected" | "needs_approval" | "busy" | "no_agent" | "pending" | "failed";
  rule?: string;
  txHash?: string;
  /** Set on 409 busy: when the agent should retry (chained-slot cadence). */
  retryAfterMs?: number;
};

/** Map an orchestration result to an HTTP status + a strict DTO (no audit/numbers leak). */
export function toHttp(result: SubmitResult): { code: number; body: BidResponse } {
  switch (result.status) {
    case "placed":
      return { code: 200, body: { status: "placed", txHash: result.txHash } };
    case "pending":
      return { code: 200, body: { status: "pending", txHash: result.txHash } };
    case "failed":
      // 5xx so x402 never settles the fee for a broadcast that never landed (auditor F2).
      return { code: 502, body: { status: "failed", txHash: result.txHash } };
    case "rejected":
      return { code: 400, body: { status: "rejected", rule: result.rule } };
    case "needs_approval":
      return { code: 409, body: { status: "needs_approval" } };
    case "busy":
      // Tell the agent when to retry — slots are chained, so one bid is in
      // flight for ~a few seconds.
      return { code: 409, body: { status: "busy", retryAfterMs: 1500 } as BidResponse };
    case "no_agent":
      return { code: 403, body: { status: "no_agent" } };
  }
}

/** The lot the auction floor is currently taking bids on (engine truth). */
export type OpenLot = { chainLotId: number; category: string; seller: string; accepting: boolean };

export type FloorRule = "LOT_CLOSED" | "LOT_MISMATCH";

/**
 * Bind an agent's bid to the lot that is ACTUALLY open. The agent states
 * only which lot and how much; the lot's category and seller are server
 * facts, so the watchlist and seller guardrails in decide() check truth,
 * not the agent's own claims. Any stated fact that disagrees with the floor
 * is rejected outright (an honest client never mismatches).
 */
export function bindToOpenLot(
  body: unknown,
  lot: OpenLot | null,
): { ok: true; bid: unknown } | { ok: false; rule: FloorRule | "INVALID_BID" } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, rule: "INVALID_BID" };
  const b = body as Record<string, unknown>;
  if (!lot || !lot.accepting) return { ok: false, rule: "LOT_CLOSED" };
  if (String(b.lotId) !== String(lot.chainLotId)) return { ok: false, rule: "LOT_CLOSED" };
  if (b.category !== undefined && b.category !== lot.category) return { ok: false, rule: "LOT_MISMATCH" };
  if (b.seller !== undefined && (typeof b.seller !== "string" || b.seller.toLowerCase() !== lot.seller.toLowerCase())) {
    return { ok: false, rule: "LOT_MISMATCH" };
  }
  return { ok: true, bid: { ...b, lotId: String(lot.chainLotId), category: lot.category, seller: lot.seller } };
}

export type HandlerDeps = {
  state: AuctionState;
  /** Resolve agent from the x402-authenticated payer address (server-side). */
  resolveAgentId: (payer: string) => string | null;
  now: () => number;
  getChain: () => SubmitBidDeps["chain"];
  /** Optional audit sink for every decide() outcome (see SubmitBidDeps.onDecision). */
  onDecision?: SubmitBidDeps["onDecision"];
  /** The open lot (engine). Omitted only in unit tests of the decide path. */
  openLot?: () => OpenLot | null;
  /** Observe floor-level rejections (before decide) for the audit log. */
  onFloorReject?: (rule: FloorRule, payer: string, body: unknown) => void;
};

/** Parse + validate the request body into a Bid, or null. */
export function parseBid(body: unknown): Bid | null {
  if (!isValidBid(body)) return null;
  return body;
}

/** Core handler — returns the mapped HTTP code + allowlisted body. */
export async function handleBid(
  body: unknown,
  payer: string,
  deps: HandlerDeps,
): Promise<{ code: number; body: BidResponse }> {
  let candidate: unknown = body;
  if (deps.openLot) {
    const bound = bindToOpenLot(body, deps.openLot());
    if (!bound.ok) {
      if (bound.rule !== "INVALID_BID") {
        try { deps.onFloorReject?.(bound.rule, payer, body); } catch { /* audit never breaks bidding */ }
      }
      return { code: 400, body: { status: "rejected", rule: bound.rule } };
    }
    candidate = bound.bid;
  }
  const bid = parseBid(candidate);
  if (!bid) return { code: 400, body: { status: "rejected", rule: "INVALID_BID" } };

  const result = await submitBid(deps.state, bid, {
    chain: deps.getChain(),
    resolveAgentId: deps.resolveAgentId,
    payer,
    now: deps.now,
    onDecision: deps.onDecision,
  });
  return toHttp(result);
}
