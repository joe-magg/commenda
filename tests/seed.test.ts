import { describe, it, expect } from "vitest";
import { AuctionState } from "../lib/auction/state";
import { parseAgentConfig, buildMandate, seedState, derivePayerMap, deriveAgentKeys } from "../lib/auction/seed";
import { decide } from "../lib/auction/decide";
import { reconcile } from "../lib/auction/reconcile";

const ID = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const SELLER = "0x3333333333333333333333333333333333333333";
const KEY = `0x${"ab".repeat(32)}`;

const raw = () => [
  {
    id: ID, payer: PAYER, budgetMinor: 5_000_000, perBidCapMinor: 500_000,
    watchlist: ["electronics"], sellerAllowlist: [SELLER],
    approvalEnabled: false, approvalAboveMinor: 250_000,
  },
];

describe("parseAgentConfig", () => {
  it("normalizes addresses to lowercase and accepts valid config", () => {
    const c = parseAgentConfig(raw());
    expect(c[0].id).toBe(ID);
    expect(c[0].payer).toBe(PAYER);
  });

  it("accepts checksummed mixed-case addresses", () => {
    const mixed = raw();
    mixed[0].id = "0x" + ID.slice(2).toUpperCase();
    expect(parseAgentConfig(mixed)[0].id).toBe(ID);
  });

  it("rejects zero/negative guardrail values (F3)", () => {
    for (const [field, value] of [["budgetMinor", 0], ["perBidCapMinor", 0]] as const) {
      const bad = raw() as unknown as Record<string, unknown>[];
      bad[0][field] = value;
      expect(() => parseAgentConfig(bad)).toThrow();
    }
  });

  it("rejects unknown fields (no secret keys in config) (F7)", () => {
    const bad = raw() as unknown as Record<string, unknown>[];
    bad[0].privateKey = KEY;
    expect(() => parseAgentConfig(bad)).toThrow(/unknown field/);
  });

  it("rejects duplicate payers", () => {
    const two = [...raw(), { ...raw()[0], id: "0x" + "44".repeat(20) }];
    expect(() => parseAgentConfig(two)).toThrow(/duplicate payer/);
  });

  it("rejects bad approvalAbove range", () => {
    const bad = raw() as unknown as Record<string, unknown>[];
    bad[0].approvalEnabled = true;
    bad[0].approvalAboveMinor = 500_000; // == cap
    expect(() => parseAgentConfig(bad)).toThrow(/approvalAboveMinor/);
  });
});

describe("buildMandate + smoke", () => {
  it("produces non-zero defaults and a bid is not auto-rejected (F3)", () => {
    const c = parseAgentConfig(raw())[0];
    const m = buildMandate(c, false);
    const r = decide({ id: "b1", lotId: "L", amountMinor: 1000, category: "electronics", seller: SELLER }, m, 1000);
    expect(r.decision.decision).not.toBe("REJECT");
  });
});

describe("seedState", () => {
  it("seeds with a valid key and maps addresses (F4)", () => {
    const s = new AuctionState();
    const summary = seedState(s, parseAgentConfig(raw()), { [ID]: KEY });
    expect(summary.seeded).toContain(ID);
    expect(s.getMandate(ID)).toBeDefined();
    expect(s.addressToAgent.get(PAYER)).toBe(ID);
  });

  it("kill-switches an agent with a missing key, no secret logged (F2)", () => {
    const s = new AuctionState();
    const summary = seedState(s, parseAgentConfig(raw()), {});
    expect(summary.killSwitched).toContain(ID);
    expect(s.getMandate(ID)!.killSwitch).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(KEY);
  });

  it("is idempotent — re-seed preserves spentMinor (F1)", () => {
    const s = new AuctionState();
    const c = parseAgentConfig(raw());
    seedState(s, c, { [ID]: KEY });
    const m = s.getMandate(ID)!;
    s.setMandate(ID, { ...m, spentMinor: 1234 });
    const second = seedState(s, c, { [ID]: KEY });
    expect(second.skipped).toContain(ID);
    expect(s.getMandate(ID)!.spentMinor).toBe(1234);
  });
});

describe("derive helpers", () => {
  it("derives payer map and validated keys", () => {
    const c = parseAgentConfig(raw());
    expect(derivePayerMap(c).get(PAYER)).toBe(ID);
    expect(deriveAgentKeys(c, { [ID]: KEY })[ID]).toBe(KEY);
    expect(deriveAgentKeys(c, { [ID]: "bad" })[ID]).toBeUndefined();
  });
});

describe("reconcile with address->id resolver (F4)", () => {
  it("credits the agent when the on-chain bidder is an address, not an agent id", () => {
    const s = new AuctionState();
    const c = parseAgentConfig(raw());
    seedState(s, c, { [ID]: KEY });
    s.setMandate(ID, { ...s.getMandate(ID)!, spentMinor: 500_000 });
    const up = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const r = reconcile(
      new Map(s.mandates), s.ingest,
      [{ kind: "BidPlaced", lotId: 1n, bidder: up as `0x${string}`, amount: 600_000n, prevBidder: PAYER, prevAmount: 500_000n, seller: SELLER, key: { blockNumber: 1n, logIndex: 0 } }],
      (addr) => s.addressToAgent.get(addr) ?? addr,
    );
    expect(r.mandates.get(ID)!.spentMinor).toBe(0); // credited via payer address -> id
    expect(r.warnings).toHaveLength(0);
  });
});
