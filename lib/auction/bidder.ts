/**
 * Low-level x402 bid client. Loads funded agents from the registry and places
 * one paid bid with a deterministic payment identifier (Circle idempotency).
 * Agent selection / policy decisions live in worker-pool.ts.
 */
import { createHash } from "node:crypto";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme, type ClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { listAgents } from "@/lib/db/repo";
import { getRuntime } from "./runtime";
import type { BidOutcome } from "./engine";

const NETWORK = "eip155:5042002";
const BASE_URL = process.env.COMMENDA_BASE_URL ?? `http://localhost:${process.env.PORT ?? "3000"}`;

export type PaidAgent = { id: string; label: string; key: `0x${string}` };

export type ProposedBid = {
  id: string;
  lotId: string;
  amountMinor: number;
  category: string;
  seller: string;
};

/** Enabled registry agents the server can sign for: house agents (keys in
 *  AGENT_KEYS) and user agents (keys derived from AGENT_MASTER_SEED). */
export function getPaidAgents(): PaidAgent[] {
  const keys = getRuntime().keys;
  const out: PaidAgent[] = [];
  for (const a of listAgents()) {
    if (!a.enabled || !a.walletAddress) continue;
    const raw = keys[a.id];
    if (typeof raw !== "string" || !/^0x[a-f0-9]{64}$/i.test(raw)) continue;
    out.push({ id: a.id, label: a.label, key: raw });
  }
  return out;
}

/** 36-char id: "bid_" + 32 hex. Valid per Circle's 16-128 [A-Za-z0-9_-] rule. */
export function paymentIdFor(bidKey: string): string {
  return `bid_${createHash("sha256").update(bidKey).digest("hex").slice(0, 32)}`;
}

function paidFetchFor(key: `0x${string}`, paymentId: string) {
  const account = privateKeyToAccount(key);
  const signer: ClientEvmSigner = {
    address: account.address,
    signTypedData: (msg) => account.signTypedData(msg as Parameters<typeof account.signTypedData>[0]),
  };
  const client = new x402Client()
    .register(NETWORK, new ExactEvmScheme(signer))
    .registerExtension({
      key: "payment-identifier",
      enrichPaymentPayload: async (payload) => ({
        ...payload,
        extensions: {
          ...(payload.extensions ?? {}),
          "payment-identifier": { info: { required: true, id: paymentId } },
        },
      }),
    });
  return wrapFetchWithPayment(fetch, client);
}

/** Place one bid for a specific agent. */
export async function placeBid(agent: PaidAgent, bid: ProposedBid): Promise<BidOutcome> {
  try {
    const res = await paidFetchFor(agent.key, paymentIdFor(bid.id))(`${BASE_URL}/api/bids`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bid),
    });
    const dto = (await res.json().catch(() => ({}))) as { status?: string; rule?: string; txHash?: string };
    if (res.ok && dto.status === "placed") {
      return { ok: true, amountMinor: bid.amountMinor, bidder: agent.id, txHash: dto.txHash ?? "" };
    }
    // "pending" (broadcast landed, receipt unknown) must NOT claim leadership:
    // the tx may still revert. The pool records it as churn and skips the
    // leader update; the resolver settles the truth.
    if (res.ok && dto.status === "pending") {
      return { ok: false, agentId: agent.id, rule: "PENDING", amountMinor: bid.amountMinor };
    }
    return { ok: false, agentId: agent.id, rule: dto.rule ?? dto.status ?? `HTTP_${res.status}`, amountMinor: bid.amountMinor };
  } catch {
    return { ok: false, agentId: agent.id, rule: "NETWORK_ERROR", amountMinor: bid.amountMinor };
  }
}
