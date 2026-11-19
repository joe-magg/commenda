/**
 * An agent's own wallet. Owner-gated.
 *   GET                       → address, live USDC balance, grant availability
 *   POST {action:"grant"}     → one-time testnet grant from the house treasury
 *   POST {action:"withdraw"}  → bring the liquid balance home to the OWNER's
 *                               sign-in address (derived from the session —
 *                               never from the request). Agent must be recalled.
 */
import { currentUser } from "@/lib/auth";
import { getAgent, hasGrant, recordAuditEvent } from "@/lib/db/repo";
import {
  GRANT_MINOR, MIN_FLOOR_BALANCE_MINOR, grantFromTreasury, isUserAgent,
  ownerAddressFor, usdcBalance, withdrawToOwner,
} from "@/lib/agents/wallets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function owned(ctx: Ctx) {
  const user = await currentUser();
  if (!user) return { error: Response.json({ error: "not signed in" }, { status: 401 }) };
  const { id } = await ctx.params;
  const agent = getAgent(id);
  if (!agent) return { error: Response.json({ error: "not found" }, { status: 404 }) };
  if (agent.ownerId !== user.id) return { error: Response.json({ error: "forbidden" }, { status: 403 }) };
  if (!isUserAgent(id) || !agent.walletAddress) {
    return { error: Response.json({ error: "this agent has no user wallet" }, { status: 400 }) };
  }
  return { user, agent };
}

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const o = await owned(ctx);
  if ("error" in o) return o.error!;
  const balanceMinor = await usdcBalance(o.agent.walletAddress!).catch(() => null);
  return Response.json({
    address: o.agent.walletAddress,
    balanceMinor,
    readyMinor: MIN_FLOOR_BALANCE_MINOR,
    grantAvailable: !hasGrant(o.agent.id),
    grantMinor: GRANT_MINOR,
    canWithdrawTo: ownerAddressFor(o.user.id),
  });
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const o = await owned(ctx);
  if ("error" in o) return o.error!;
  let body: { action?: unknown };
  try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }

  if (body.action === "grant") {
    if (hasGrant(o.agent.id)) return Response.json({ error: "grant already used" }, { status: 409 });
    // Record first: a concurrent second request can't double-grant.
    recordAuditEvent(Date.now(), o.agent.id, "agent_granted", `amount=${GRANT_MINOR}`);
    try {
      const r = await grantFromTreasury(o.agent.id);
      return Response.json(r);
    } catch (e) {
      recordAuditEvent(Date.now(), o.agent.id, "agent_grant_failed", e instanceof Error ? e.message.slice(0, 120) : "");
      return Response.json({ error: "grant failed — try again shortly" }, { status: 502 });
    }
  }

  if (body.action === "withdraw") {
    const to = ownerAddressFor(o.user.id);
    if (!to) return Response.json({ error: "sign in with a wallet to withdraw" }, { status: 400 });
    if (o.agent.enabled) return Response.json({ error: "recall your agent first" }, { status: 409 });
    try {
      const r = await withdrawToOwner(o.agent.id, to);
      recordAuditEvent(Date.now(), o.agent.id, "agent_withdrawn", `to=${to} amount=${r?.amountMinor ?? 0}`);
      return Response.json(r ?? { txHash: null, amountMinor: 0 });
    } catch {
      return Response.json({ error: "withdraw failed — try again shortly" }, { status: 502 });
    }
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}
