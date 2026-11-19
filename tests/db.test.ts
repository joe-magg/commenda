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
    // Every agent is its own principal: one user per funded agent, each with
    // their own guardrails — not a shared demo owner.
    expect(repo.listUsers().length).toBe(8);
    const agents = repo.listAgents();
    expect(agents.length).toBe(8);
    expect(new Set(agents.map((a) => a.ownerId)).size).toBe(8);
    // Liveness is derived from AGENT_KEYS; in the test env there are no keys,
    // so all agents seed as standby (kill-switched) — never a hardcoded count.
    expect(agents.filter((a) => a.enabled).length).toBe(0);
    expect(agents[0].policy.watchlist.length).toBeGreaterThan(0);
    expect(repo.listSessions()[0].catalog.length).toBe(6);
  });

  it("creates and closes auction sessions", () => {
    const before = repo.listSessions().length;
    const session = repo.createSession("Test Auction", [
      { id: 0, title: "A", sku: "A-1", category: "art", artSeed: "aaaa", openingMinor: 100_000 },
    ]);
    expect(session.status).toBe("live");
    expect(repo.listSessions().length).toBe(before + 1);
    repo.setSessionStatus(session.id, "ended");
    expect(repo.listSessions().find((s) => s.id === session.id)?.status).toBe("ended");
  });

  it("filters the audit log by kind prefix", () => {
    repo.recordAuditEvent(1000, "agent-1", "bid_self_outbid", "held the lead");
    repo.recordAuditEvent(1001, "agent-1", "claim_redeemed", "sku");
    const decisions = repo.listAuditEvents(50, "bid_");
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((e) => e.kind.startsWith("bid_"))).toBe(true);
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
        maxWins: 1,
        strategy: "steady",
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

  it("records bounded bid-decision audit entries (finding 3)", () => {
    repo.recordAuditEvent(1000, "agent-1", "bid_bid", JSON.stringify({ detail: "approved 1000 minor units" }));
    repo.recordAuditEvent(1001, "agent-2", "bid_reject", "x".repeat(2000));
    const events = repo.listAudit(50);
    const bidBid = events.find((e) => e.kind === "bid_bid");
    const bidReject = events.find((e) => e.kind === "bid_reject");
    expect(bidBid?.agentId).toBe("agent-1");
    expect(bidReject?.detail.length).toBeLessThanOrEqual(500);
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
