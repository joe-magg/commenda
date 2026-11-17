/**
 * Shared single-process runtime: one AuctionState + seeded mandates.
 * Imported by both the bid route and the engine bootstrap so they operate on
 * the same state (the resolver needs the state the bid route writes to).
 */
import { AuctionState } from "./state";
import { parseAgentConfig, seedState, derivePayerMap, deriveAgentKeys } from "./seed";
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
