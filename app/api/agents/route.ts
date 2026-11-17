/** Agent registry API — users own agents with typed policies. */
import { createAgent, listAgents, type Policy } from "@/lib/db/repo";
import { DEMO_SELLER } from "@/lib/auction/lots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isPosInt = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;

export async function GET(req: Request): Promise<Response> {
  const owner = new URL(req.url).searchParams.get("owner") ?? undefined;
  return Response.json({ agents: listAgents(owner) });
}

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { ownerId, label, budgetMinor, perBidCapMinor, watchlist, approvalEnabled, approvalAboveMinor, maxWins } = body;
  if (typeof ownerId !== "string" || !ownerId) return Response.json({ error: "ownerId required" }, { status: 400 });
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
    ownerId,
    label: label.trim(),
    walletAddress: null, // no wallet key -> standby until funded in a later phase
    policy,
  });
  return Response.json({ agent, apiKey }, { status: 201 });
}
