/** Typed repository over the SQLite store. All amounts stay in minor units. */
import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./client";

export type User = { id: string; name: string; createdAt: number };
export type Policy = {
  budgetMinor: number;
  perBidCapMinor: number;
  watchlist: string[];
  sellerAllowlist: string[];
  approvalEnabled: boolean;
  approvalAboveMinor: number;
};
export type Agent = {
  id: string;
  ownerId: string;
  label: string;
  walletAddress: string | null;
  enabled: boolean;
  status: "standby" | "bidding" | "paused";
  createdAt: number;
  policy: Policy;
};
export type Session = {
  id: string;
  name: string;
  startsAt: number;
  status: "scheduled" | "live" | "ended";
  catalog: { id: number; title: string; category: string; openingMinor: number; sku: string }[];
  createdAt: number;
};
export type Claim = {
  id: string;
  chainLotId: string;
  winnerId: string | null;
  title: string;
  sku: string;
  amountMinor: number;
  settleTx: string | null;
  status: "issued" | "redeemed";
  createdAt: number;
};

type AgentRow = {
  id: string; owner_id: string; label: string; wallet_address: string | null;
  enabled: number; status: Agent["status"]; created_at: number;
  budget_minor: number; per_bid_cap_minor: number; watchlist: string;
  seller_allowlist: string; approval_enabled: number; approval_above_minor: number;
};

const AGENT_JOIN = `
  SELECT a.*, p.budget_minor, p.per_bid_cap_minor, p.watchlist, p.seller_allowlist,
         p.approval_enabled, p.approval_above_minor
  FROM agents a JOIN agent_policies p ON p.agent_id = a.id
`;

function toAgent(r: AgentRow): Agent {
  return {
    id: r.id,
    ownerId: r.owner_id,
    label: r.label,
    walletAddress: r.wallet_address,
    enabled: r.enabled === 1,
    status: r.status,
    createdAt: r.created_at,
    policy: {
      budgetMinor: r.budget_minor,
      perBidCapMinor: r.per_bid_cap_minor,
      watchlist: JSON.parse(r.watchlist) as string[],
      sellerAllowlist: JSON.parse(r.seller_allowlist) as string[],
      approvalEnabled: r.approval_enabled === 1,
      approvalAboveMinor: r.approval_above_minor,
    },
  };
}

export function listUsers(): User[] {
  const rows = getDb().prepare("SELECT id, name, created_at FROM users ORDER BY created_at, id").all() as
    { id: string; name: string; created_at: number }[];
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
}

export function listAgents(ownerId?: string): Agent[] {
  const rows = (ownerId
    ? getDb().prepare(`${AGENT_JOIN} WHERE a.owner_id = ? ORDER BY a.created_at, a.id`).all(ownerId)
    : getDb().prepare(`${AGENT_JOIN} ORDER BY a.created_at, a.id`).all()) as AgentRow[];
  return rows.map(toAgent);
}

export function getAgent(id: string): Agent | undefined {
  const row = getDb().prepare(`${AGENT_JOIN} WHERE a.id = ?`).get(id) as AgentRow | undefined;
  return row ? toAgent(row) : undefined;
}

export function listSessions(): Session[] {
  const rows = getDb().prepare("SELECT * FROM sessions ORDER BY starts_at").all() as
    { id: string; name: string; starts_at: number; status: Session["status"]; catalog: string; created_at: number }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    startsAt: r.starts_at,
    status: r.status,
    catalog: JSON.parse(r.catalog) as Session["catalog"],
    createdAt: r.created_at,
  }));
}

/** Create a non-transferable redemption claim for a lot winner. */
export function createClaim(input: {
  chainLotId: number;
  winnerId: string | null;
  title: string;
  sku: string;
  amountMinor: number;
  settleTx: string | null;
}): Claim {
  const db = getDb();
  const id = `clm_${randomBytes(8).toString("hex")}`;
  const now = Date.now();
  db.prepare(
    "INSERT INTO claims (id, chain_lot_id, winner_id, title, sku, amount_minor, settle_tx, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'issued', ?)",
  ).run(id, String(input.chainLotId), input.winnerId, input.title, input.sku, input.amountMinor, input.settleTx, now);
  return getClaim(id)!;
}

function getClaim(id: string): Claim | undefined {
  const r = getDb().prepare("SELECT * FROM claims WHERE id = ?").get(id) as
    { id: string; chain_lot_id: string; winner_id: string | null; title: string; sku: string; amount_minor: number; settle_tx: string | null; status: Claim["status"]; created_at: number } | undefined;
  return r ? {
    id: r.id, chainLotId: r.chain_lot_id, winnerId: r.winner_id, title: r.title,
    sku: r.sku, amountMinor: r.amount_minor, settleTx: r.settle_tx, status: r.status, createdAt: r.created_at,
  } : undefined;
}

export function listClaims(winnerId?: string): Claim[] {
  const rows = (winnerId
    ? getDb().prepare("SELECT * FROM claims WHERE winner_id = ? ORDER BY created_at DESC").all(winnerId)
    : getDb().prepare("SELECT * FROM claims ORDER BY created_at DESC").all()) as
    { id: string; chain_lot_id: string; winner_id: string | null; title: string; sku: string; amount_minor: number; settle_tx: string | null; status: Claim["status"]; created_at: number }[];
  return rows.map((r) => ({
    id: r.id, chainLotId: r.chain_lot_id, winnerId: r.winner_id, title: r.title,
    sku: r.sku, amountMinor: r.amount_minor, settleTx: r.settle_tx, status: r.status, createdAt: r.created_at,
  }));
}

export function redeemClaim(id: string): Claim | undefined {
  const claim = getClaim(id);
  if (!claim || claim.status === "redeemed") return claim;
  getDb().prepare("UPDATE claims SET status = 'redeemed' WHERE id = ?").run(id);
  getDb().prepare("INSERT INTO audit_events (at, agent_id, kind, detail) VALUES (?, ?, ?, ?)").run(
    Date.now(), claim.winnerId, "claim_redeemed", claim.sku,
  );
  return getClaim(id);
}

export type CreateAgentInput = {
  ownerId: string;
  label: string;
  walletAddress: string | null;
  policy: Policy;
};

/** Create an agent and issue a scoped API key. Returns the key ONCE (plaintext). */
export function createAgent(input: CreateAgentInput): { agent: Agent; apiKey: string } {
  const db = getDb();
  const id = `agt_${randomBytes(8).toString("hex")}`;
  const apiKey = `commenda_agt_${randomBytes(18).toString("base64url")}`;
  const keyHash = createHash("sha256").update(apiKey).digest("hex");
  const now = Date.now();

  db.exec("BEGIN");
  try {
    db.prepare(
      "INSERT INTO agents (id, owner_id, label, wallet_address, api_key_hash, enabled, status, created_at) VALUES (?, ?, ?, ?, ?, 0, 'standby', ?)",
    ).run(id, input.ownerId, input.label, input.walletAddress, keyHash, now);
    db.prepare(
      "INSERT INTO agent_policies (agent_id, budget_minor, per_bid_cap_minor, watchlist, seller_allowlist, approval_enabled, approval_above_minor) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      input.policy.budgetMinor,
      input.policy.perBidCapMinor,
      JSON.stringify(input.policy.watchlist),
      JSON.stringify(input.policy.sellerAllowlist),
      input.policy.approvalEnabled ? 1 : 0,
      input.policy.approvalAboveMinor,
    );
    db.prepare("INSERT INTO audit_events (at, agent_id, kind, detail) VALUES (?, ?, ?, ?)").run(
      now,
      id,
      "agent_created",
      `owner=${input.ownerId} budget=${input.policy.budgetMinor}`,
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { agent: getAgent(id)!, apiKey };
}

export function setAgentEnabled(id: string, enabled: boolean): Agent | undefined {
  const db = getDb();
  db.prepare("UPDATE agents SET enabled = ?, status = ? WHERE id = ?").run(
    enabled ? 1 : 0,
    enabled ? "bidding" : "paused",
    id,
  );
  db.prepare("INSERT INTO audit_events (at, agent_id, kind, detail) VALUES (?, ?, ?, ?)").run(
    Date.now(),
    id,
    enabled ? "agent_enabled" : "agent_paused",
    "",
  );
  return getAgent(id);
}

export function updatePolicy(id: string, patch: Partial<Policy>): Agent | undefined {
  const current = getAgent(id);
  if (!current) return undefined;
  const merged = { ...current.policy, ...patch };
  getDb().prepare(
    "UPDATE agent_policies SET budget_minor=?, per_bid_cap_minor=?, watchlist=?, seller_allowlist=?, approval_enabled=?, approval_above_minor=? WHERE agent_id=?",
  ).run(
    merged.budgetMinor,
    merged.perBidCapMinor,
    JSON.stringify(merged.watchlist),
    JSON.stringify(merged.sellerAllowlist),
    merged.approvalEnabled ? 1 : 0,
    merged.approvalAboveMinor,
    id,
  );
  return getAgent(id);
}

export function listAudit(limit = 20): { at: number; agentId: string | null; kind: string; detail: string }[] {
  const rows = getDb().prepare("SELECT * FROM audit_events ORDER BY id DESC LIMIT ?").all(limit) as
    { at: number; agent_id: string | null; kind: string; detail: string }[];
  return rows.map((r) => ({ at: r.at, agentId: r.agent_id, kind: r.kind, detail: r.detail }));
}
