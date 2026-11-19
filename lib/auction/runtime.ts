/**
 * Shared single-process runtime: one AuctionState + seeded mandates.
 * Imported by both the bid route and the engine bootstrap so they operate on
 * the same state (the resolver needs the state the bid route writes to).
 */
import { AuctionState } from "./state";
import { parseAgentConfig, seedState, derivePayerMap, deriveAgentKeys, buildMandate, type AgentConfig } from "./seed";
import { listAgents, type Agent } from "@/lib/db/repo";
import { deriveAgentKey } from "@/lib/agents/wallets";
import type { Mandate } from "./decide";
import agentConfigRaw from "@/config/agents.json";

export type Runtime = {
  state: AuctionState;
  payer: Map<string, string>;
  keys: Record<string, `0x${string}`>;
};

const configs = parseAgentConfig(agentConfigRaw);
const g = globalThis as typeof globalThis & { __commendaRuntime?: Runtime };

export function getRuntime(): Runtime {
  if (!g.__commendaRuntime) {
    const state = new AuctionState();
    let envKeys: unknown = {};
    try { envKeys = JSON.parse(process.env.AGENT_KEYS ?? "{}"); } catch { /* kill-switched */ }
    const summary = seedState(state, configs, envKeys);
    const keys = deriveAgentKeys(configs, envKeys);
    // The DB is the source of truth for owner-edited policy once seeded:
    // without this overlay, a cap an owner tightened on the dashboard would
    // silently revert to the config value on every restart.
    let overlaid = 0;
    const payer = derivePayerMap(configs);
    try {
      for (const agent of listAgents()) {
        const m = state.getMandate(agent.id);
        if (m) {
          state.setMandate(agent.id, withPolicy(m, agent, Boolean(keys[agent.id])));
        } else {
          // A user-created agent: its key is derived, never stored.
          registerAgent(state, payer, keys, agent);
        }
        overlaid++;
      }
    } catch (e) {
      console.warn("[commenda] policy overlay skipped", e instanceof Error ? e.message.slice(0, 80) : e);
    }
    console.info("[commenda] seeded agents:", summary.seeded.length, "kill-switched:", summary.killSwitched.length, "db policies:", overlaid);
    g.__commendaRuntime = { state, payer, keys };
  }
  return g.__commendaRuntime;
}

/** Policy fields from the DB onto a live mandate; decide-managed state kept.
 *  A paused agent (or one without a signing key) is kill-switched, so pausing
 *  on the dashboard stops x402 bids from ANY client, not just the pool. */
export function withPolicy(m: Mandate, agent: Agent, hasKey: boolean): Mandate {
  return {
    ...m,
    budgetMinor: agent.policy.budgetMinor,
    perBidCapMinor: agent.policy.perBidCapMinor,
    watchlist: new Set(agent.policy.watchlist.map((v) => v.toLowerCase())),
    sellerAllowlist: new Set(agent.policy.sellerAllowlist.map((v) => v.toLowerCase())),
    approvalEnabled: agent.policy.approvalEnabled,
    approvalAboveMinor: agent.policy.approvalAboveMinor,
    killSwitch: !agent.enabled || !hasKey,
  };
}

/**
 * Mirror a DB agent's policy into the guardrail runtime so `decide()` never
 * acts on a stale snapshot (audit finding 2). For an existing mandate only the
 * policy fields are updated in place — budget/velocity state is preserved. For
 * a brand-new agent a dormant mandate is built; it stays kill-switched until a
 * validated key exists for its id.
 */
export async function syncAgentPolicy(agent: Agent): Promise<void> {
  const rt = getRuntime();
  const state = rt.state;
  await state.globalLock.run(() => {
    const existing = state.getMandate(agent.id);
    if (existing) {
      state.setMandate(agent.id, withPolicy(existing, agent, Boolean(rt.keys[agent.id])));
      return;
    }
    registerAgent(state, rt.payer, rt.keys, agent);
  });
}

/** Register a brand-new agent with the guardrail runtime: its mandate, its
 *  derived key (user agents), and the address maps decide()/reconcile use.
 *  Kill-switched until it has a key AND its owner has enabled it. */
function registerAgent(
  state: Runtime["state"],
  payer: Runtime["payer"],
  keys: Runtime["keys"],
  agent: Agent,
): void {
  const derived = deriveAgentKey(agent.id);
  if (derived && !keys[agent.id]) keys[agent.id] = derived;
  const config: AgentConfig = {
    id: agent.id,
    payer: agent.walletAddress ? agent.walletAddress.toLowerCase() : agent.id,
    budgetMinor: agent.policy.budgetMinor,
    perBidCapMinor: agent.policy.perBidCapMinor,
    watchlist: agent.policy.watchlist.map((v) => v.toLowerCase()),
    sellerAllowlist: agent.policy.sellerAllowlist.map((v) => v.toLowerCase()),
    approvalEnabled: agent.policy.approvalEnabled,
    approvalAboveMinor: agent.policy.approvalAboveMinor,
  };
  state.setMandate(agent.id, withPolicy(buildMandate(config, true), agent, Boolean(keys[agent.id])));
  state.addressToAgent.set(agent.id, agent.id);
  if (agent.walletAddress) {
    state.addressToAgent.set(agent.walletAddress.toLowerCase(), agent.id);
    payer.set(agent.walletAddress.toLowerCase(), agent.id);
  } else {
    payer.set(agent.id, agent.id);
  }
}

/** The signing key for any agent the server may sign for, or undefined. */
export function keyFor(agentId: string): `0x${string}` | undefined {
  return getRuntime().keys[agentId];
}
