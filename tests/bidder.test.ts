import { describe, it, expect } from "vitest";
import { paymentIdFor } from "../lib/auction/bidder";

describe("x402 payment identifier", () => {
  it("is deterministic for the same bid", () => {
    expect(paymentIdFor("agent-lot-amount")).toBe(paymentIdFor("agent-lot-amount"));
  });

  it("differs across bids", () => {
    expect(paymentIdFor("a-1-100")).not.toBe(paymentIdFor("a-1-200"));
  });

  it("matches Circle's 16-128 char [A-Za-z0-9_-] format", () => {
    const id = paymentIdFor("anything");
    expect(id).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(id.startsWith("bid_")).toBe(true);
  });
});
