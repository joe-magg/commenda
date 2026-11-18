/**
 * Simulated physical redemption. In production this would hand off to the
 * seller's fulfillment system; here it only moves the claim to `redeemed`.
 * Owner-gated: the claim's winning agent must belong to the signed-in user.
 */
import { currentUser } from "@/lib/auth";
import { getClaimById, listAgents, redeemClaim } from "@/lib/db/repo";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: "not signed in" }, { status: 401 });
  const { id } = await params;
  // Ownership check BEFORE any state change.
  const existing = getClaimById(id);
  if (!existing) return Response.json({ error: "not found" }, { status: 404 });
  if (!listAgents(user.id).some((a) => a.id === existing.winnerId)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const claim = redeemClaim(id);
  if (!claim) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ claim, note: "Physical redemption simulated" });
}
