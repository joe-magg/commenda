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

export type HandlerDeps = {
  state: AuctionState;
  /** Resolve agent from the x402-authenticated payer address (server-side). */
  resolveAgentId: (payer: string) => string | null;
  now: () => number;
  getChain: () => SubmitBidDeps["chain"];
  /** Optional audit sink for every decide() outcome (see SubmitBidDeps.onDecision). */
  onDecision?: SubmitBidDeps["onDecision"];
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
  const bid = parseBid(body);
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
