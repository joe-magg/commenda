import { describe, it, expect, beforeAll } from "vitest";
import { rmSync } from "node:fs";

const TEST_DB = "/tmp/opencode/commenda-test.db";
process.env.COMMENDA_DB_PATH = TEST_DB;

let repo: typeof import("../lib/db/repo");

beforeAll(async () => {
  rmSync(TEST_DB, { force: true });
  rmSync(`${TEST_DB}-wal`, { force: true });
  rmSync(`${TEST_DB}-shm`, { force: true });
  repo = await import("../lib/db/repo");
});

describe("agent registry (SQLite)", () => {
  it("seeds users, agents, policies and a session", () => {
    expect(repo.listUsers().length).toBe(3);
    const agents = repo.listAgents();
    expect(agents.length).toBe(8);
    expect(agents.filter((a) => a.enabled).length).toBe(2);
    expect(agents[0].policy.watchlist.length).toBeGreaterThan(0);
    expect(repo.listSessions()[0].catalog.length).toBe(6);
  });

  it("creates an agent with a policy and a one-time key", () => {
    const owner = repo.listUsers()[0].id;
    const { agent, apiKey } = repo.createAgent({
      ownerId: owner,
      label: "Test Bidder",
      walletAddress: null,
      policy: {
        budgetMinor: 1_000_000,
        perBidCapMinor: 200_000,
        watchlist: ["art"],
        sellerAllowlist: ["0x3333333333333333333333333333333333333333"],
        approvalEnabled: false,
        approvalAboveMinor: 0,
      },
    });
    expect(agent.label).toBe("Test Bidder");
    expect(agent.enabled).toBe(false);
    expect(apiKey.startsWith("commenda_agt_")).toBe(true);
    expect(repo.getAgent(agent.id)?.policy.budgetMinor).toBe(1_000_000);
    expect(repo.listAgents(owner).some((a) => a.id === agent.id)).toBe(true);
  });

  it("enables/pauses and patches policy", () => {
    const agent = repo.listAgents()[0];
    expect(repo.setAgentEnabled(agent.id, false)?.enabled).toBe(false);
    expect(repo.setAgentEnabled(agent.id, true)?.status).toBe("bidding");
    expect(repo.updatePolicy(agent.id, { perBidCapMinor: 777_777 })?.policy.perBidCapMinor).toBe(777_777);
  });

  it("writes an audit trail", () => {
    expect(repo.listAudit().some((e) => e.kind === "agent_created")).toBe(true);
  });

  it("creates and redeems a non-transferable claim", () => {
    const winner = repo.listAgents()[0].id;
    const claim = repo.createClaim({
      chainLotId: 12345,
      winnerId: winner,
      title: "Leica M6 Film Camera",
      sku: "LEICA-M6-1847321",
      amountMinor: 400_000,
      settleTx: "0xabc",
    });
    expect(claim.status).toBe("issued");
    expect(repo.listClaims(winner).some((c) => c.id === claim.id)).toBe(true);
    expect(repo.redeemClaim(claim.id)?.status).toBe("redeemed");
    expect(repo.listAudit().some((e) => e.kind === "claim_redeemed")).toBe(true);
  });
});
