/** Enable/pause an agent, or patch its policy. */
import { getAgent, setAgentEnabled, updatePolicy, type Policy } from "@/lib/db/repo";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  if (!getAgent(id)) return Response.json({ error: "not found" }, { status: 404 });
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Enabling without a wallet is allowed — the worker pool (next phase) skips
  // agents that have no signing key, and the UI shows them as unfunded.
  if (typeof body.enabled === "boolean") {
    return Response.json({ agent: setAgentEnabled(id, body.enabled) });
  }

  const allowed = ["budgetMinor", "perBidCapMinor", "watchlist", "sellerAllowlist", "approvalEnabled", "approvalAboveMinor"];
  const patch: Partial<Policy> = {};
  for (const k of allowed) if (k in body) patch[k as keyof Policy] = body[k] as never;
  return Response.json({ agent: updatePolicy(id, patch) });
}
