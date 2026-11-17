import { describe, it, expect } from "vitest";
import { toHttp, parseBid, handleBid, type HandlerDeps } from "../lib/auction/handler";
import { AuctionState } from "../lib/auction/state";
import type { Mandate } from "../lib/auction/decide";
import type { ChainPort } from "../lib/auction/submit-bid";

const mandate = (): Mandate => ({
  agentId: "agent-1", budgetMinor: 10_000, spentMinor: 0, perBidCapMinor: 2_000,
  watchlist: new Set(["electronics"]), sellerAllowlist: new Set(["seller-ok"]),
  killSwitch: false, approvalEnabled: false, approvalAboveMinor: 1500,
  approvedKeys: new Set(), seenKeys: new Set(), consecutiveFailures: 0,
  maxConsecutiveFailures: 3, recentBidTimesMs: [], maxBidsPerWindow: 20, windowMs: 60_000,
});

const goodBid = { id: "b1", lotId: "lot-1", amountMinor: 1000, category: "electronics", seller: "seller-ok" };

describe("toHttp — DTO allowlist (auditor M4)", () => {
  it("never leaks audit/numeric fields, and maps statuses correctly", () => {
    expect(toHttp({ status: "placed", txHash: "0xabc" })).toEqual({
      code: 200, body: { status: "placed", txHash: "0xabc" },
    });
    expect(toHttp({ status: "rejected", rule: "BUDGET" })).toEqual({
      code: 400, body: { status: "rejected", rule: "BUDGET" },
    });
    const serialized = JSON.stringify(toHttp({ status: "placed", txHash: "0xabc" }).body);
    expect(serialized).not.toMatch(/budget|spent|snapshot|detail|seenKeys/i);
  });

  it("maps needs_approval / busy to 409, no_agent to 403, failed to 502 (never charged)", () => {
    expect(toHttp({ status: "needs_approval" }).code).toBe(409);
    expect(toHttp({ status: "busy" }).code).toBe(409);
    expect(toHttp({ status: "no_agent" }).code).toBe(403);
    expect(toHttp({ status: "failed", txHash: "" }).code).toBe(502);
  });
});

describe("parseBid", () => {
  it("rejects malformed bodies", () => {
    expect(parseBid(null)).toBeNull();
    expect(parseBid({ ...goodBid, seller: "" })).toBeNull();
    expect(parseBid({ ...goodBid, amountMinor: NaN })).toBeNull();
    expect(parseBid(goodBid)).toEqual(goodBid);
  });
});

describe("handleBid", () => {
  const deps = (): HandlerDeps => {
    const state = new AuctionState();
    state.setMandate("agent-1", mandate());
    const chain: ChainPort = {
      syncEvents: async () => ({ events: [], latestBlock: 1n }),
      submitPlaceBid: async () => ({ txHash: "0xabc", fromBlock: 1n }),
    };
    return {
      state,
      resolveAgentId: (p) => (p === "payer-1" ? "agent-1" : null),
      now: () => 1000,
      getChain: () => chain,
    };
  };

  it("returns a 200 placed DTO with txHash on success", async () => {
    const r = await handleBid(goodBid, "payer-1", deps());
    expect(r.code).toBe(200);
    expect(r.body.status).toBe("placed");
    expect(r.body.txHash).toBe("0xabc");
  });

  it("returns 403 no_agent for an unknown payer", async () => {
    const r = await handleBid(goodBid, "stranger", deps());
    expect(r.code).toBe(403);
    expect(r.body.status).toBe("no_agent");
  });

  it("returns 400 INVALID_BID for a bad body", async () => {
    const r = await handleBid({ ...goodBid, seller: "" }, "payer-1", deps());
    expect(r.code).toBe(400);
    expect(r.body.rule).toBe("INVALID_BID");
  });
});
