/** Enable/pause an agent, or patch its policy. Owner-gated; syncs to guardrail runtime. */
import { currentUser } from "@/lib/auth";
import { getAgent, setAgentEnabled, updatePolicy, type Policy } from "@/lib/db/repo";
import { syncAgentPolicy } from "@/lib/auction/runtime";
import { getWorkerPool } from "@/lib/auction/worker-pool";
import { isUserAgent, MIN_FLOOR_BALANCE_MINOR, usdcBalance } from "@/lib/agents/wallets";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const isPosInt = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;

export async function PATCH(req: Request, { params }: Ctx): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: "not signed in" }, { status: 401 });
  const { id } = await params;
  const existing = getAgent(id);
  if (!existing) return Response.json({ error: "not found" }, { status: 404 });
  if (existing.ownerId !== user.id) return Response.json({ error: "forbidden" }, { status: 403 });
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Enabling without a wallet is allowed — the worker pool (next phase) skips
  // agents that have no signing key, and the UI shows them as unfunded.
  if (typeof body.enabled === "boolean") {
    // A user agent goes to the floor only once its wallet can actually pay.
    if (body.enabled && isUserAgent(id) && existing.walletAddress) {
      const balance = await usdcBalance(existing.walletAddress).catch(() => 0);
      if (balance < MIN_FLOOR_BALANCE_MINOR) {
        return Response.json({ error: "fund your agent first", balanceMinor: balance }, { status: 409 });
      }
    }
    const agent = setAgentEnabled(id, body.enabled);
    if (agent) await syncAgentPolicy(agent);
    // Recall: stop bidding on the current lot now, not at the next one.
    if (!body.enabled) getWorkerPool().recall(id);
    return Response.json({ agent });
  }

  const isAddress = (x: unknown): x is string =>
    typeof x === "string" && /^0x[a-fA-F0-9]{40}$/.test(x);
  const err = (error: string) => Response.json({ error }, { status: 400 });

  const allowed = ["budgetMinor", "perBidCapMinor", "watchlist", "sellerAllowlist", "approvalEnabled", "approvalAboveMinor", "maxWins"];
  const patch: Partial<Policy> = {};
  for (const k of allowed) {
    if (!(k in body)) continue;
    const v = body[k];
    switch (k) {
      case "budgetMinor":
      case "perBidCapMinor":
        if (!isPosInt(v)) return err("amounts must be positive integers (minor units)");
        break;
      case "watchlist":
        if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string" && x.length > 0)) {
          return err("watchlist must be non-empty strings");
        }
        break;
      case "sellerAllowlist":
        if (!Array.isArray(v) || v.length === 0 || !v.every((x) => isAddress(x))) {
          return err("sellerAllowlist must be non-empty addresses");
        }
        break;
      case "approvalEnabled":
        if (typeof v !== "boolean") return err("approvalEnabled must be boolean");
        break;
      case "approvalAboveMinor":
        if (!Number.isSafeInteger(v) || (v as number) < 0) return err("invalid approvalAboveMinor");
        break;
      case "maxWins":
        if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 20) {
          return err("maxWins must be 1-20");
        }
        break;
    }
    patch[k as keyof Policy] = v as never;
  }
  if (Object.keys(patch).length === 0) return err("no valid policy fields");

  // Keep the approval invariant that decide() enforces as INVALID_MANDATE.
  const merged = { ...existing.policy, ...patch };
  if (
    merged.approvalEnabled &&
    (!("approvalAboveMinor" in patch) ? merged.approvalAboveMinor : (patch.approvalAboveMinor as number)) >= merged.perBidCapMinor
  ) {
    return err("approvalAboveMinor must be below perBidCapMinor when approvals are on");
  }
  const agent = updatePolicy(id, patch);
  if (agent) await syncAgentPolicy(agent);
  return Response.json({ agent });
}
