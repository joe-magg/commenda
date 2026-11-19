import { describe, it, expect } from "vitest";
import { deriveAgentKey, deriveAgentAddress, isUserAgent, ownerAddressFor } from "../lib/agents/wallets";
import { isPrivateEvent } from "../lib/auction/engine";

const seed = Buffer.alloc(32, 7);
const other = Buffer.alloc(32, 9);
const id = "agt_0123456789abcdef";

describe("user-agent wallets", () => {
  it("derive deterministically from seed + agent id — nothing to store", () => {
    expect(deriveAgentKey(id, seed)).toBe(deriveAgentKey(id, seed));
    expect(deriveAgentAddress(id, seed)).toMatch(/^0x[a-f0-9]{40}$/);
  });

  it("differ per agent and per seed", () => {
    expect(deriveAgentAddress(id, seed)).not.toBe(deriveAgentAddress("agt_fedcba9876543210", seed));
    expect(deriveAgentAddress(id, seed)).not.toBe(deriveAgentAddress(id, other));
  });

  it("never derive for house agents, malformed ids, or a missing seed", () => {
    expect(deriveAgentKey("0x04d9fd5dc9da8c827daa0c110d6c1637f0a7c207", seed)).toBeNull();
    expect(deriveAgentKey("agt_../../etc", seed)).toBeNull();
    expect(deriveAgentKey(id, null)).toBeNull();
    expect(isUserAgent(id)).toBe(true);
  });

  it("withdraw destination comes only from a wallet sign-in identity", () => {
    expect(ownerAddressFor("wallet_0x04d9fd5dc9da8c827daa0c110d6c1637f0a7c207")).toBe("0x04d9fd5dc9da8c827daa0c110d6c1637f0a7c207");
    expect(ownerAddressFor("demo-user-ava")).toBeNull();
  });
});

describe("private events reach only owners", () => {
  it("classifies an agent's thoughts, waits and blocks as private; the floor as public", () => {
    expect(isPrivateEvent({ type: "agent_mind", agentId: "a", lotId: 0, state: "raising", text: "", limitMinor: 1 })).toBe(true);
    expect(isPrivateEvent({ type: "reject", lotId: 0, agentId: "a", rule: "BUDGET", amountMinor: 1 })).toBe(true);
    expect(isPrivateEvent({ type: "bid", lotId: 0, amountMinor: 1, bidder: "a", label: "A", txHash: "0x" })).toBe(false);
    expect(isPrivateEvent({ type: "agent_join", agentId: "a", label: "A", lotId: 0 })).toBe(false);
  });
});
