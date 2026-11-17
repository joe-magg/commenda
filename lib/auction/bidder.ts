/**
 * Agent-side bidder driver: the missing x402 CLIENT.
 *
 * Each seeded agent holds a server-side testnet key. The driver wraps fetch so
 * it automatically answers the 402 challenge on POST /api/bids, paying the flat
 * fee in testnet USDC, then reads the allowlisted status DTO. It never sees the
 * mandate, the rules, or any limit field (H1/H3): it only proposes a Bid.
 *
 * The endpoint is reached over HTTP (not by calling handleBid directly) so the
 * full x402 verify → settle → handler path is genuinely exercised on every bid.
 */
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme, type ClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { parseAgentConfig, type AgentConfig } from "./seed";
import agentConfigRaw from "@/config/agents.json";
import type { Lot } from "./lots";
import type { BidOutcome } from "./engine";

const NETWORK = "eip155:5042002";
const BASE_URL = process.env.COMMENDA_BASE_URL ?? `http://localhost:${process.env.PORT ?? "3000"}`;

type Agent = { id: string; label: string; paidFetch: ReturnType<typeof wrapFetchWithPayment> };

/** Fixed bidding script: increasing amounts so idempotency never collides. */
const PLAN = [
  { agent: 0, amountMinor: 100_000 },
  { agent: 1, amountMinor: 200_000 },
  { agent: 0, amountMinor: 300_000 },
  { agent: 1, amountMinor: 400_000 },
  { agent: 0, amountMinor: 500_000 },
  { agent: 1, amountMinor: 600_000 },
] as const;

const g = globalThis as typeof globalThis & {
  __commendaDriver?: { agents: Agent[]; lastLeader: Map<number, string> };
};

function buildAgents(): Agent[] {
  const configs: AgentConfig[] = parseAgentConfig(agentConfigRaw);
  let keys: Record<string, string> = {};
  try { keys = JSON.parse(process.env.AGENT_KEYS ?? "{}"); } catch { /* kill-switched */ }
  const out: Agent[] = [];
  configs.forEach((c, i) => {
    const key = keys[c.id];
    if (typeof key !== "string" || !/^0x[a-f0-9]{64}$/i.test(key)) return; // kill-switched
    const account = privateKeyToAccount(key as `0x${string}`);
    const signer: ClientEvmSigner = {
      address: account.address,
      signTypedData: (msg) => account.signTypedData(msg as Parameters<typeof account.signTypedData>[0]),
    };
    const client = new x402Client().register(NETWORK, new ExactEvmScheme(signer));
    out.push({
      id: c.id,
      label: `Agent ${i === 0 ? "A" : "B"}`,
      paidFetch: wrapFetchWithPayment(fetch, client),
    });
  });
  return out;
}

function driver() {
  if (!g.__commendaDriver) {
    g.__commendaDriver = { agents: buildAgents(), lastLeader: new Map<number, string>() };
  }
  return g.__commendaDriver;
}

/** Place one scripted bid. Returns null only if there is no active agent for the slot. */
export async function placeScriptedBid(lot: Lot, slot: number, chainLotId: number): Promise<BidOutcome | null> {
  const step = PLAN[slot];
  if (!step) return null;
  const d = driver();
  const agent = d.agents[step.agent];
  if (!agent) return null;

  const bid = {
    id: `${agent.id.slice(0, 10)}-${chainLotId}-${step.amountMinor}`,
    lotId: String(chainLotId),
    amountMinor: step.amountMinor,
    category: lot.category,
    seller: lot.seller,
  };

  try {
    const res = await agent.paidFetch(`${BASE_URL}/api/bids`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bid),
    });
    const dto = (await res.json().catch(() => ({}))) as { status?: string; rule?: string; txHash?: string };

    if (res.ok && (dto.status === "placed" || dto.status === "pending")) {
      const previousBidder = d.lastLeader.get(chainLotId);
      d.lastLeader.set(chainLotId, agent.id);
      return {
        ok: true,
        amountMinor: step.amountMinor,
        bidder: agent.id,
        txHash: dto.txHash ?? "",
        previousBidder,
      };
    }
    const rule = dto.rule ?? dto.status ?? `HTTP_${res.status}`;
    return { ok: false, agentId: agent.id, rule, amountMinor: step.amountMinor };
  } catch (e) {
    return { ok: false, agentId: agent.id, rule: "NETWORK_ERROR", amountMinor: step.amountMinor };
  }
}

/** Exposed for the demo status panel: which agents are live. */
export function activeAgents(): { id: string; label: string }[] {
  return driver().agents.map((a) => ({ id: a.id, label: a.label }));
}
