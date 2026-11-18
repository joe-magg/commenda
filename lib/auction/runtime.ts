/**
 * Shared single-process runtime: one AuctionState + seeded mandates.
 * Imported by both the bid route and the engine bootstrap so they operate on
 * the same state (the resolver needs the state the bid route writes to).
 */
import { AuctionState } from "./state";
import { parseAgentConfig, seedState, derivePayerMap, deriveAgentKeys, buildMandate, type AgentConfig } from "./seed";
import type { Agent } from "@/lib/db/repo";
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
    console.info("[commenda] seeded agents:", summary.seeded.length, "kill-switched:", summary.killSwitched.length);
    g.__commendaRuntime = {
      state,
      payer: derivePayerMap(configs),
      keys: deriveAgentKeys(configs, envKeys),
    };
  }
  return g.__commendaRuntime;
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
  const watchlist = new Set(agent.policy.watchlist.map((v) => v.toLowerCase()));
  const sellerAllowlist = new Set(agent.policy.sellerAllowlist.map((v) => v.toLowerCase()));
  await state.globalLock.run(() => {
    const existing = state.getMandate(agent.id);
    if (existing) {
      state.setMandate(agent.id, {
        ...existing,
        budgetMinor: agent.policy.budgetMinor,
        perBidCapMinor: agent.policy.perBidCapMinor,
        watchlist,
        sellerAllowlist,
        approvalEnabled: agent.policy.approvalEnabled,
        approvalAboveMinor: agent.policy.approvalAboveMinor,
      });
      return;
    }
    const config: AgentConfig = {
      id: agent.id,
      payer: agent.walletAddress ? agent.walletAddress.toLowerCase() : agent.id,
      budgetMinor: agent.policy.budgetMinor,
      perBidCapMinor: agent.policy.perBidCapMinor,
      watchlist: [...watchlist],
      sellerAllowlist: [...sellerAllowlist],
      approvalEnabled: agent.policy.approvalEnabled,
      approvalAboveMinor: agent.policy.approvalAboveMinor,
    };
    state.setMandate(agent.id, buildMandate(config, !rt.keys[agent.id]));
    state.addressToAgent.set(agent.id, agent.id);
    if (agent.walletAddress) {
      state.addressToAgent.set(agent.walletAddress.toLowerCase(), agent.id);
    }
    // Resolution uses runtime.payer (payer address -> agent id); a new agent
    // must be resolvable there too or it can never reach decide().
    if (agent.walletAddress) rt.payer.set(agent.walletAddress.toLowerCase(), agent.id);
    else rt.payer.set(agent.id, agent.id);
  });
}
