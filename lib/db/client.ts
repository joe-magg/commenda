/**
 * SQLite persistence via Node's built-in `node:sqlite` — no new dependency.
 * Single-process demo store: users own agents, agents own typed policies, and
 * sessions carry a published catalog. Seeded from config on first run so the
 * dashboard is meaningful immediately.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import agentConfigRaw from "@/config/agents.json";
import { LOTS } from "@/lib/auction/lots";

let db: DatabaseSync | undefined;
let dbPath: string | undefined;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL,
  wallet_address TEXT,
  api_key_hash TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'standby',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_policies (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  budget_minor INTEGER NOT NULL,
  per_bid_cap_minor INTEGER NOT NULL,
  watchlist TEXT NOT NULL,
  seller_allowlist TEXT NOT NULL,
  approval_enabled INTEGER NOT NULL,
  approval_above_minor INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  catalog TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  agent_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_id);
CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_events(agent_id);
`;

function seed(d: DatabaseSync): void {
  const users = d.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if (users.n > 0) return;

  const now = Date.now();
  const insertUser = d.prepare("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)");
  insertUser.run("demo-you", "You", now);
  insertUser.run("demo-maya", "Maya", now);
  insertUser.run("demo-theo", "Theo", now);

  const insertAgent = d.prepare(
    "INSERT INTO agents (id, owner_id, label, wallet_address, enabled, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertPolicy = d.prepare(
    "INSERT INTO agent_policies (agent_id, budget_minor, per_bid_cap_minor, watchlist, seller_allowlist, approval_enabled, approval_above_minor) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const owners = ["demo-you", "demo-you", "demo-maya", "demo-maya", "demo-theo", "demo-theo", "demo-you", "demo-maya"];
  agentConfigRaw.forEach((c, i) => {
    const live = i < 2;
    // Only funded agents have a wallet address; the rest are standby with no
    // signing key, which the dashboard reports honestly.
    insertAgent.run(c.id, owners[i], `Agent ${String.fromCharCode(65 + i)}`, live ? c.payer : null, live ? 1 : 0, live ? "bidding" : "standby", now);
    insertPolicy.run(
      c.id,
      c.budgetMinor,
      c.perBidCapMinor,
      JSON.stringify(c.watchlist),
      JSON.stringify(c.sellerAllowlist),
      c.approvalEnabled ? 1 : 0,
      c.approvalAboveMinor,
    );
  });

  const catalog = LOTS.map((l) => ({
    id: l.id,
    title: l.title,
    category: l.category,
    openingMinor: l.openingMinor,
  }));
  d.prepare(
    "INSERT INTO sessions (id, name, starts_at, status, catalog, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("flash-001", "Thursday Flash Auction", now + 3_600_000, "scheduled", JSON.stringify(catalog), now);
}

export function getDb(): DatabaseSync {
  if (db) return db;
  dbPath = process.env.COMMENDA_DB_PATH ?? join(process.cwd(), "cache", "commenda.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  seed(db);
  return db;
}
