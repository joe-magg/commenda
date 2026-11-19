/**
 * Pure agent-mandate seeding from trusted server config. No secrets in the config;
 * wallet keys come from env and are validated here (never logged). Audit-fixed v2.
 */
import type { Mandate } from "./decide";
import type { AuctionState } from "./state";
import { PERSONAS } from "@/lib/agents/strategy";

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const PRIVATE_KEY = /^0x[a-fA-F0-9]{64}$/;
const PERSONA_SET = new Set<string>(PERSONAS);
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

export type AgentConfig = {
  id: string; // lowercase 0x address
  payer: string; // lowercase 0x address
  budgetMinor: number;
  perBidCapMinor: number;
  watchlist: string[];
  sellerAllowlist: string[];
  approvalEnabled: boolean;
  approvalAboveMinor: number;
  /** Bidding persona (lib/agents/strategy.ts). Not a guardrail — decide() ignores it. */
  strategy?: string;
};

const isPosInt = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;

function isAddress(x: unknown): x is string {
  return typeof x === "string" && ADDRESS.test(x);
}

/** Strict parse + validation. Rejects unknown fields and any value that would brick every bid. */
export function parseAgentConfig(raw: unknown): AgentConfig[] {
  if (!Array.isArray(raw)) throw new Error("agents config must be an array");
  const seenIds = new Set<string>();
  const seenPayers = new Set<string>();
  return raw.map((item, i) => {
    if (typeof item !== "object" || item === null) throw new Error(`agent[${i}] not an object`);
    const o = item as Record<string, unknown>;
    const allowed = ["id", "payer", "budgetMinor", "perBidCapMinor", "watchlist", "sellerAllowlist", "approvalEnabled", "approvalAboveMinor", "strategy"];
    for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`agent[${i}] unknown field ${k}`);

    if (!isAddress(o.id)) throw new Error(`agent[${i}] bad id address`);
    if (!isAddress(o.payer)) throw new Error(`agent[${i}] bad payer address`);
    const id = o.id.toLowerCase();
    const payer = o.payer.toLowerCase();
    if (seenIds.has(id)) throw new Error(`duplicate agent id ${id}`);
    if (seenPayers.has(payer)) throw new Error(`duplicate payer ${payer}`);
    seenIds.add(id);
    seenPayers.add(payer);

    if (!isPosInt(o.budgetMinor)) throw new Error(`agent[${i}] budgetMinor must be positive integer`);
    if (!isPosInt(o.perBidCapMinor)) throw new Error(`agent[${i}] perBidCapMinor must be positive integer`);
    if (!Array.isArray(o.watchlist) || o.watchlist.length === 0 || !o.watchlist.every((v) => typeof v === "string" && v.length > 0))
      throw new Error(`agent[${i}] watchlist must be non-empty strings`);
    if (!Array.isArray(o.sellerAllowlist) || o.sellerAllowlist.length === 0 || !o.sellerAllowlist.every((v) => isAddress(v)))
      throw new Error(`agent[${i}] sellerAllowlist must be non-empty addresses`);
    if (typeof o.approvalEnabled !== "boolean") throw new Error(`agent[${i}] approvalEnabled must be boolean`);
    if (!Number.isSafeInteger(o.approvalAboveMinor) || (o.approvalAboveMinor as number) < 0)
      throw new Error(`agent[${i}] bad approvalAboveMinor`);
    if (o.strategy !== undefined && !(typeof o.strategy === "string" && PERSONA_SET.has(o.strategy)))
      throw new Error(`agent[${i}] unknown strategy`);
    const approvalAboveMinor = o.approvalAboveMinor as number;
    if (o.approvalEnabled && !(approvalAboveMinor > 0 && approvalAboveMinor < (o.perBidCapMinor as number)))
      throw new Error(`agent[${i}] approvalAboveMinor must be in (0, perBidCapMinor)`);

    return {
      id,
      payer,
      budgetMinor: o.budgetMinor,
      perBidCapMinor: o.perBidCapMinor,
      watchlist: (o.watchlist as string[]).map((v) => v.toLowerCase()),
      sellerAllowlist: (o.sellerAllowlist as string[]).map((v) => v.toLowerCase()),
      approvalEnabled: o.approvalEnabled,
      approvalAboveMinor,
      ...(typeof o.strategy === "string" ? { strategy: o.strategy } : {}),
    };
  });
}

/** Build a full runtime Mandate with non-zero defaults. */
export function buildMandate(c: AgentConfig, killSwitch: boolean): Mandate {
  return {
    agentId: c.id,
    budgetMinor: c.budgetMinor,
    spentMinor: 0,
    perBidCapMinor: c.perBidCapMinor,
    watchlist: new Set(c.watchlist),
    sellerAllowlist: new Set(c.sellerAllowlist),
    killSwitch,
    approvalEnabled: c.approvalEnabled,
    approvalAboveMinor: c.approvalAboveMinor,
    approvedKeys: new Set(),
    seenKeys: new Set(),
    consecutiveFailures: 0,
    maxConsecutiveFailures: 3,
    recentBidTimesMs: [],
    maxBidsPerWindow: 20,
    windowMs: MAX_WINDOW_MS < 60_000 ? MAX_WINDOW_MS : 60_000,
  };
}

export type SeedSummary = { seeded: string[]; skipped: string[]; killSwitched: string[] };

/** Idempotent: only seeds mandates that are absent. Never logs key material. */
export function seedState(
  state: AuctionState,
  configs: AgentConfig[],
  envKeys: unknown,
): SeedSummary {
  const keys = envKeys && typeof envKeys === "object" && !Array.isArray(envKeys)
    ? (envKeys as Record<string, unknown>)
    : {};
  const summary: SeedSummary = { seeded: [], skipped: [], killSwitched: [] };

  for (const c of configs) {
    if (state.getMandate(c.id)) {
      summary.skipped.push(c.id);
      continue;
    }
    // Validate key by id (lowercase canonical); never print the value.
    const rawKey = keys[c.id] ?? keys[c.id.toLowerCase()];
    const validKey = typeof rawKey === "string" && PRIVATE_KEY.test(rawKey);
    state.setMandate(c.id, buildMandate(c, !validKey));
    // address -> agent id map for on-chain refund credits (F4)
    state.addressToAgent.set(c.id, c.id);
    state.addressToAgent.set(c.payer, c.id);
    if (!validKey) summary.killSwitched.push(c.id);
    else summary.seeded.push(c.id);
  }
  return summary;
}

/** Lowercase payer -> agent id. */
export function derivePayerMap(configs: AgentConfig[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of configs) m.set(c.payer, c.id);
  return m;
}

/** Validated lowercase agent id -> key. Invalid keys omitted (agent kill-switched at seed). */
export function deriveAgentKeys(configs: AgentConfig[], envKeys: unknown): Record<string, `0x${string}`> {
  const keys = envKeys && typeof envKeys === "object" && !Array.isArray(envKeys)
    ? (envKeys as Record<string, unknown>)
    : {};
  const out: Record<string, `0x${string}`> = {};
  for (const c of configs) {
    const raw = keys[c.id];
    if (typeof raw === "string" && PRIVATE_KEY.test(raw)) out[c.id] = raw as `0x${string}`;
  }
  return out;
}
