/** Agent registry API — signed-in users own agents with typed policies. */
import { currentUser } from "@/lib/auth";
import { createAgent, listAgents, type Policy } from "@/lib/db/repo";
import { DEMO_SELLER } from "@/lib/auction/lots";
import { syncAgentPolicy } from "@/lib/auction/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isPosInt = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;

export async function GET(): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: "not signed in" }, { status: 401 });
  // Owner is always the session user — never a client-supplied id.
  return Response.json({ agents: listAgents(user.id) });
}

export async function POST(req: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: "not signed in" }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  // ownerId comes from the session, never from the request body.
  const { label, budgetMinor, perBidCapMinor, watchlist, approvalEnabled, approvalAboveMinor, maxWins } = body;
  if (typeof label !== "string" || label.trim().length < 1 || label.length > 40) {
    return Response.json({ error: "label must be 1-40 chars" }, { status: 400 });
  }
  if (!isPosInt(budgetMinor) || !isPosInt(perBidCapMinor)) {
    return Response.json({ error: "amounts must be positive integers (minor units)" }, { status: 400 });
  }
  if (!Array.isArray(watchlist) || watchlist.length === 0 || !watchlist.every((v) => typeof v === "string" && v.length > 0)) {
    return Response.json({ error: "watchlist must be non-empty strings" }, { status: 400 });
  }
  if (typeof approvalEnabled !== "boolean" || !Number.isSafeInteger(approvalAboveMinor) || (approvalAboveMinor as number) < 0) {
    return Response.json({ error: "invalid approval settings" }, { status: 400 });
  }
  if (!Number.isSafeInteger(maxWins) || (maxWins as number) < 1 || (maxWins as number) > 20) {
    return Response.json({ error: "maxWins must be 1-20" }, { status: 400 });
  }
  // Keep decide()'s INVALID_MANDATE invariant out of the way at creation time:
  // with approvals on, the threshold must sit strictly below the per-bid cap.
  if (approvalEnabled && !((approvalAboveMinor as number) > 0 && (approvalAboveMinor as number) < (perBidCapMinor as number))) {
    return Response.json({ error: "approvalAboveMinor must be in (0, perBidCapMinor) when approvals are on" }, { status: 400 });
  }

  const policy: Policy = {
    budgetMinor,
    perBidCapMinor,
    watchlist: (watchlist as string[]).map((v) => v.toLowerCase()),
    sellerAllowlist: [DEMO_SELLER],
    approvalEnabled,
    approvalAboveMinor: approvalAboveMinor as number,
    maxWins: maxWins as number,
  };

  const { agent, apiKey } = createAgent({
    ownerId: user.id,
    label: label.trim(),
    walletAddress: null, // no wallet key -> standby until funded in a later phase
    policy,
  });
  // Register the policy with the guardrail runtime so decide() sees it
  // immediately — awaited so the 201 never precedes the mandate's existence.
  await syncAgentPolicy(agent);
  return Response.json({ agent, apiKey }, { status: 201 });
}
