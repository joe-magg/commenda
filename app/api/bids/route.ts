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
import { record } from "@/lib/auction/trace";
import { getAgent, recordAuditEvent } from "@/lib/db/repo";
import { getEngine } from "@/lib/auction/engine";
import { ensureBootstrapped } from "@/lib/auction/bootstrap";

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
      allowances: (id) => getAgent(id)?.policy.budgetMinor ?? 0,
    });
  }
  return chainG.__commendaChain;
}

const labelFor = (agentId: string) => getAgent(agentId)?.label ?? `${agentId.slice(0, 6)}…${agentId.slice(-4)}`;

/** Every blocked bid is visible on the stage — enforcement is part of the show. */
function showBlock(agentId: string, rule: string, amountMinor: unknown): void {
  const open = getEngine().openLot();
  getEngine().emitExternal({
    type: "reject",
    lotId: open?.lot.id ?? -1,
    agentId,
    rule,
    amountMinor: typeof amountMinor === "number" ? amountMinor : 0,
    label: labelFor(agentId),
  });
}

const deps: HandlerDeps = {
  state,
  resolveAgentId: (payer) => payerToAgent.get(payer.toLowerCase()) ?? null,
  now: () => Date.now(),
  getChain: chain,
  // The floor's truth: which lot is open and what it is. Agents can't assert it.
  openLot: () => {
    const o = getEngine().openLot();
    return o ? { chainLotId: o.chainLotId, category: o.lot.category, seller: o.lot.seller, accepting: o.accepting } : null;
  },
  onFloorReject: (rule, payer, body) => {
    const agentId = payerToAgent.get(payer.toLowerCase()) ?? payer.toLowerCase();
    const b = (body ?? {}) as Record<string, unknown>;
    const open = getEngine().openLot();
    recordAuditEvent(
      Date.now(),
      agentId,
      `bid_${rule.toLowerCase()}`,
      JSON.stringify({
        detail: `claimed lot=${String(b.lotId).slice(0, 40)} category=${String(b.category).slice(0, 40)}; floor lot=${open?.chainLotId ?? "closed"} category=${open?.lot.category ?? "-"}`,
        lotId: String(b.lotId).slice(0, 40),
        amountMinor: typeof b.amountMinor === "number" ? b.amountMinor : 0,
      }),
    );
    showBlock(agentId, rule, b.amountMinor);
  },
  // Every decide() outcome lands in audit_events (agent-side, audit-only detail).
  onDecision: (audit) => {
    recordAuditEvent(
      Date.parse(audit.at),
      audit.agentId,
      `bid_${audit.rule.toLowerCase()}`,
      JSON.stringify({ detail: audit.detail, lotId: audit.bid.lotId, amountMinor: audit.bid.amountMinor }),
    );
    if (audit.decision.decision !== "BID") showBlock(audit.agentId, audit.rule, audit.bid.amountMinor);
  },
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
  ensureBootstrapped();
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
  // A receipt-confirmed bid from ANY client goes onto the floor here — the
  // pool's agents and an external agent take exactly the same path.
  if (dto.status === "placed" && dto.txHash) {
    const b = body as { lotId?: unknown; amountMinor?: unknown };
    const agentId = deps.resolveAgentId(payer);
    if (agentId && typeof b.amountMinor === "number") {
      getEngine().recordBid({
        chainLotId: Number(b.lotId),
        amountMinor: b.amountMinor,
        bidder: agentId,
        txHash: dto.txHash,
        label: labelFor(agentId),
      });
    }
  }
  console.info("[commenda:bids] handled", JSON.stringify({ status: dto.status, ms: Date.now() - start }));
  // Server-side trace: handler latency and outcome per request. The pool's
  // trace records the same bid from the driver side with client latency.
  if (body && typeof body === "object" && "amountMinor" in (body as Record<string, unknown>)) {
    const b = body as { lotId?: unknown; amountMinor?: unknown };
    record({
      kind: "bid_outcome",
      at: Date.now(),
      agentId: deps.resolveAgentId(payer) ?? payer,
      chainLotId: Number(b.lotId ?? 0),
      amountMinor: typeof b.amountMinor === "number" ? b.amountMinor : 0,
      status:
        dto.status === "placed" ? "placed"
        : dto.status === "pending" ? "pending"
        : dto.status === "rejected" ? "rejected"
        : dto.status === "needs_approval" ? "needs_approval"
        : dto.status === "busy" ? "busy"
        : dto.status === "no_agent" ? "no_agent"
        : "failed",
      rule: dto.rule,
      source: "server",
      msServer: Date.now() - start,
    });
  }
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
