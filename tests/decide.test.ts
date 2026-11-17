import { describe, it, expect } from "vitest";
import { decide, bidKey, type Bid, type Mandate } from "../lib/auction/decide";

const NOW = 1_700_000_000_000;

const base = (over: Partial<Mandate> = {}): Mandate => ({
  agentId: "agent-1",
  budgetMinor: 10_000,
  spentMinor: 0,
  perBidCapMinor: 2_000,
  watchlist: new Set(["electronics"]),
  sellerAllowlist: new Set(["seller-ok"]),
  killSwitch: false,
  approvalEnabled: false,
  approvalAboveMinor: 1_500,
  approvedKeys: new Set(),
  seenKeys: new Set(),
  consecutiveFailures: 0,
  maxConsecutiveFailures: 3,
  recentBidTimesMs: [],
  maxBidsPerWindow: 20,
  windowMs: 60_000,
  ...over,
});

const bid = (over: Partial<Bid> = {}): Bid => ({
  id: "b1",
  lotId: "lot-1",
  amountMinor: 1_000,
  category: "electronics",
  seller: "seller-ok",
  ...over,
});

const code = (m: Mandate, b: Bid, now = NOW) => {
  const r = decide(b, m, now);
  return r.decision.decision === "REJECT" ? r.decision.rule : r.decision.decision;
};

describe("decide — happy path", () => {
  it("permits a valid bid and returns advanced state", () => {
    const m = base();
    const r = decide(bid(), m, NOW);
    expect(r.decision).toEqual({ decision: "BID" });
    expect(r.next.spentMinor).toBe(1_000);
    expect(r.next.seenKeys.has(bidKey("agent-1", bid()))).toBe(true);
    expect(m.spentMinor).toBe(0); // input not mutated
    expect(r.audit.rule).toBe("BID");
  });

  it("allows a bid exactly at the cap and exactly at the budget", () => {
    expect(code(base(), bid({ amountMinor: 2_000 }))).toBe("BID");
    expect(code(base({ budgetMinor: 1_000 }), bid({ amountMinor: 1_000 }))).toBe("BID");
  });

  it("allows a higher raise on the same lot (distinct idempotency key)", () => {
    const m = base({ seenKeys: new Set([bidKey("agent-1", bid({ amountMinor: 1_000 }))]) });
    expect(code(m, bid({ amountMinor: 1_500 }))).toBe("BID");
  });
});

describe("decide — numeric validation (auditor B1)", () => {
  it("rejects NaN, negative, float, and Infinity amounts in the bid", () => {
    for (const bad of [NaN, -1, 1.5, Infinity, -Infinity]) {
      expect(code(base(), bid({ amountMinor: bad }))).toBe("INVALID_BID");
    }
  });

  it("rejects invalid mandate numbers", () => {
    expect(code(base({ budgetMinor: NaN }), bid())).toBe("INVALID_AMOUNT");
    expect(code(base({ budgetMinor: -1 }), bid())).toBe("INVALID_AMOUNT");
    expect(code(base({ perBidCapMinor: 1.5 }), bid())).toBe("INVALID_AMOUNT");
  });

  it("rejects violated mandate invariants", () => {
    expect(code(base({ spentMinor: 20_000 }), bid())).toBe("INVALID_MANDATE");
    expect(
      code(base({ approvalEnabled: true, approvalAboveMinor: 2_000 }), bid()),
    ).toBe("INVALID_MANDATE");
  });
});

describe("decide — string field validation", () => {
  it("rejects non-string lotId, empty seller, and oversized fields", () => {
    expect(code(base(), bid({ lotId: 1 as unknown as string }))).toBe("INVALID_BID");
    expect(code(base(), bid({ seller: "" }))).toBe("INVALID_BID");
    expect(code(base(), bid({ category: "x".repeat(201) }))).toBe("INVALID_BID");
  });

  it("idempotency key does not collapse number 1 and string '1'", () => {
    const numeric = bidKey("agent-1", bid({ lotId: 1 as unknown as string }));
    const text = bidKey("agent-1", bid({ lotId: "1" }));
    expect(numeric).not.toBe(text);
  });

  it("idempotency key does not collapse an array with its joined string", () => {
    const arr = bidKey("agent-1", bid({ lotId: ["a", "b"] as unknown as string }));
    const str = bidKey("agent-1", bid({ lotId: "a,b" }));
    expect(arr).not.toBe(str);
  });
});

describe("decide — idempotency (auditor B2)", () => {
  it("rejects the same agent+lot+amount even with a different bid id", () => {
    const m = base({ seenKeys: new Set([bidKey("agent-1", bid({ amountMinor: 1_000 }))]) });
    const replay = bid({ id: "totally-new-id", amountMinor: 1_000 });
    expect(code(m, replay)).toBe("IDEMPOTENCY");
  });

  it("scopes the key per agent", () => {
    const m = base({ agentId: "agent-2", seenKeys: new Set([bidKey("agent-1", bid())]) });
    expect(code(m, bid())).toBe("BID");
  });
});

describe("decide — aggregate & state (auditor B3)", () => {
  it("two bids each under the per-bid cap cannot overspend the budget", () => {
    const m = base({ budgetMinor: 1_500, perBidCapMinor: 1_000 });
    const first = decide(bid({ amountMinor: 1_000 }), m, NOW);
    expect(first.decision).toEqual({ decision: "BID" });
    // different lot AND id so idempotency doesn't short-circuit — this must hit BUDGET
    const second = decide(bid({ id: "b2", lotId: "lot-2", amountMinor: 1_000 }), first.next, NOW);
    expect(second.decision.decision).toBe("REJECT");
    expect((second.decision as { rule: string }).rule).toBe("BUDGET");
  });

  it("a stale snapshot is not protected — caller must persist atomically", () => {
    const m = base({ budgetMinor: 1_500, perBidCapMinor: 1_000 });
    const a = decide(bid({ amountMinor: 1_000 }), m, NOW);
    const b = decide(bid({ id: "b2", amountMinor: 1_000 }), m, NOW);
    expect(a.decision).toEqual({ decision: "BID" });
    expect(b.decision).toEqual({ decision: "BID" }); // documented caller contract
  });
});

describe("decide — individual guardrails", () => {
  it("kill switch is checked first", () => {
    expect(code(base({ killSwitch: true }), bid({ amountMinor: 99_999 }))).toBe("KILL_SWITCH");
  });

  it("per-bid cap, watchlist, and seller", () => {
    expect(code(base(), bid({ amountMinor: 2_001 }))).toBe("PER_BID_CAP");
    expect(code(base(), bid({ category: "books" }))).toBe("WATCHLIST");
    expect(code(base(), bid({ seller: "seller-bad" }))).toBe("SELLER");
  });

  it("velocity window trips on many bids, then admits a later one", () => {
    const recent = [1, 2, 3].map((i) => NOW - i * 10_000);
    const m = base({ recentBidTimesMs: recent, maxBidsPerWindow: 3, windowMs: 60_000 });
    expect(code(m, bid())).toBe("VELOCITY");
    const later = base({ recentBidTimesMs: recent, maxBidsPerWindow: 3, windowMs: 5_000 });
    expect(code(later, bid(), NOW)).toBe("BID");
  });

  it("circuit breaker trips after N consecutive failures and resets on BID", () => {
    const m = base({ consecutiveFailures: 3 });
    expect(code(m, bid())).toBe("CIRCUIT_BREAKER");
    const r = decide(bid(), base({ consecutiveFailures: 2 }), NOW);
    expect(r.decision).toEqual({ decision: "BID" });
    expect(r.next.consecutiveFailures).toBe(0);
  });
});

describe("decide — approval flow (auditor H2/H3)", () => {
  it("requires approval above the threshold, then accepts the approved bid", () => {
    const m = base({ approvalEnabled: true, approvalAboveMinor: 500 });
    const first = decide(bid({ amountMinor: 1_000 }), m, NOW);
    expect(first.decision).toEqual({ decision: "NEEDS_APPROVAL" });
    expect(first.next.spentMinor).toBe(0); // no state change until approved

    const key = bidKey("agent-1", bid({ amountMinor: 1_000 }));
    const approved = decide(
      bid({ amountMinor: 1_000 }),
      { ...first.next, approvedKeys: new Set([key]) },
      NOW,
    );
    expect(approved.decision).toEqual({ decision: "BID" });
  });

  it("autonomous toggle bypasses approval entirely", () => {
    const m = base({ approvalEnabled: false, approvalAboveMinor: 1 });
    expect(code(m, bid({ amountMinor: 1_000 }))).toBe("BID");
  });
});

describe("decide — audit completeness (auditor M2/L1)", () => {
  it("records a structured entry for every branch with full detail", () => {
    const r1 = decide(bid(), base(), NOW);
    const r2 = decide(bid({ amountMinor: 9_999 }), base(), NOW);
    const r3 = decide(bid(), base({ approvalEnabled: true, approvalAboveMinor: 500 }), NOW);
    expect(r1.audit.rule).toBe("BID");
    expect(r2.audit.rule).toBe("PER_BID_CAP");
    expect(r3.audit.rule).toBe("APPROVAL_REQUIRED");
    for (const r of [r1, r2, r3]) {
      expect(r.audit.detail.length).toBeGreaterThan(0);
      expect(r.audit.snapshot.budgetMinor).toBe(10_000);
      expect(r.audit.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(r2.audit.at).toBeDefined();
    // opaque to the agent: REJECT carries only a rule code, no numbers
    expect(r2.decision).toEqual({ decision: "REJECT", rule: "PER_BID_CAP" });
  });
});
