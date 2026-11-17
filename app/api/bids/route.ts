/**
 * POST /api/bids — the ONE x402 function.
 *
 * x402 wrapper (withX402):
 *  - verifies the buyer's signed payment BEFORE the handler runs
 *  - settles ONLY if the handler returns <400
 *  - so guardrail rejections (400/409/403) are NOT charged; valid submissions (200) are
 *
 * The custom CircleFacilitator adds Circle's seller-proof header so settlement
 * happens on Arc. See notes/CALLER_DESIGN.md.
 */
import { NextRequest, NextResponse } from "next/server";
import { withX402, x402ResourceServer } from "@x402/next";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  declarePaymentIdentifierExtension,
  paymentIdentifierResourceServerExtension,
} from "@x402/extensions/payment-identifier";
import { CircleFacilitator } from "@/lib/auction/circle-facilitator";
import { createChainAdapter } from "@/lib/auction/chain";
import { handleBid, type HandlerDeps } from "@/lib/auction/handler";
import { getRuntime } from "@/lib/auction/runtime";
import { listAgents } from "@/lib/db/repo";

const NETWORK = "eip155:5042002" as const;
const ROUTE_KEY = "/api/bids";

// One shared runtime for the bid route, the engine and the resolver.
const runtime = getRuntime();
const state = runtime.state;
const payerToAgent = runtime.payer;

function env(name: string): `0x${string}` {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v as `0x${string}`;
}

function buildServer() {
  const facilitator = new CircleFacilitator({
    sellerPrivateKey: env("FEE_SELLER_PRIVATE_KEY"),
    payTo: env("FEE_RECIPIENT_ADDRESS"),
    network: NETWORK,
  });
  return new x402ResourceServer(facilitator)
    .register(NETWORK, new ExactEvmScheme())
    // Advertise payment-identifier so clients attach a stable idempotency key;
    // Circle uses it to settle a retried bid at most once.
    .registerExtension(paymentIdentifierResourceServerExtension);
}

// One adapter for the process: reuses the RPC client, the cached approval set
// and the last synced block. Rebuilding it per bid cost ~1s in allowance reads.
const chainG = globalThis as typeof globalThis & { __commendaChain?: ReturnType<typeof createChainAdapter> };
function chain(): ReturnType<typeof createChainAdapter> {
  if (!chainG.__commendaChain) {
    chainG.__commendaChain = createChainAdapter({
      escrowAddress: env("ESCROW_ADDRESS"),
      agentKeys: runtime.keys,
      // One-time allowance = the agent's configured budget, not a per-bid tx.
      allowances: Object.fromEntries(
        listAgents().map((a) => [a.id, a.policy.budgetMinor]),
      ),
    });
  }
  return chainG.__commendaChain;
}

const deps: HandlerDeps = {
  state,
  resolveAgentId: (payer) => payerToAgent.get(payer.toLowerCase()) ?? null,
  now: () => Date.now(),
  getChain: chain,
};

/** Extract the authenticated payer from the x402 payment payload header. */
function payerFromRequest(req: NextRequest): string | null {
  const raw = req.headers.get("payment-signature") ?? req.headers.get("x-payment");
  if (!raw) return null;
  try {
    const payload = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    const payer = payload?.payload?.authorization?.from ?? payload?.payload?.from;
    return typeof payer === "string" ? payer : null;
  } catch {
    return null;
  }
}

async function handler(req: NextRequest): Promise<NextResponse> {
  const payer = payerFromRequest(req);
  if (!payer) return NextResponse.json({ status: "rejected", rule: "NO_PAYER" }, { status: 400 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ status: "rejected", rule: "INVALID_BID" }, { status: 400 });
  }
  const start = Date.now();
  const { code, body: dto } = await handleBid(body, payer, deps);
  console.info("[commenda:bids] handled", JSON.stringify({ status: dto.status, ms: Date.now() - start }));
  return NextResponse.json(dto, { status: code });
}

let cachedServer: ReturnType<typeof buildServer> | undefined;
function server() {
  if (!cachedServer) cachedServer = buildServer();
  return cachedServer;
}

export const POST = (req: NextRequest) =>
  withX402(
    handler,
    {
      [ROUTE_KEY]: {
        accepts: [{ scheme: "exact", price: "$0.001", network: NETWORK, payTo: process.env.FEE_RECIPIENT_ADDRESS ?? "" }],
        description: "Submit one bid to the Commenda auctioneer",
        mimeType: "application/json",
        extensions: {
          "payment-identifier": declarePaymentIdentifierExtension(true),
        },
      },
    },
    server(),
  )(req);
