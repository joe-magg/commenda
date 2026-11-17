/**
 * Simulated physical redemption. In production this would hand off to the
 * seller's fulfillment system; here it only moves the claim to `redeemed`.
 */
import { redeemClaim } from "@/lib/db/repo";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  const claim = redeemClaim(id);
  if (!claim) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ claim, note: "Physical redemption simulated" });
}
