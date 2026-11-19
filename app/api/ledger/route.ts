/**
 * GET /api/ledger — the signed-in owner's results: each of their agents with
 * its wallet, and the story of every lot it competed on (won / outbid / sat
 * out). Owner-scoped: rivals appear only as the public winner label + price.
 */
import { currentUser } from "@/lib/auth";
import { agentBidsByLot, getAgent, listAgents, listClaims, listLotHistory } from "@/lib/db/repo";
import { isUserAgent, usdcBalance } from "@/lib/agents/wallets";
import { getRuntime } from "@/lib/auction/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: "not signed in" }, { status: 401 });
  const agents = listAgents(user.id);
  const history = listLotHistory();
  const { state } = getRuntime();

  const out = await Promise.all(agents.map(async (a) => {
    const bids = agentBidsByLot(a.id);
    const claims = listClaims(a.id);
    // Claims are the source of truth for wins (they exist for every settled
    // sale, including lots settled by crash recovery).
    const claimByLot = new Map(claims.map((c) => [c.chainLotId, c]));
    const lots = history
      .filter((l) => bids.has(l.chainLotId) || l.winnerId === a.id || claimByLot.has(l.chainLotId))
      .map((l) => {
        const mine = bids.get(l.chainLotId);
        const claim = claimByLot.get(l.chainLotId);
        const won = Boolean(claim) || l.winnerId === a.id;
        return {
          chainLotId: l.chainLotId, title: l.title, sku: l.sku, artSeed: l.artSeed, category: l.category,
          at: l.openedAt, outcome: won ? "won" : "outbid",
          yourBidMinor: mine?.maxMinor ?? null, yourBids: mine?.count ?? 0,
          soldMinor: claim?.amountMinor ?? l.soldMinor,
          soldTo: won ? a.label : l.winnerId ? (getAgent(l.winnerId)?.label ?? "another bidder") : null,
        };
      });
    const balanceMinor = isUserAgent(a.id) && a.walletAddress
      ? await usdcBalance(a.walletAddress).catch(() => null)
      : null;
    const spentMinor = claims.reduce((s, c) => s + c.amountMinor, 0);
    return {
      id: a.id, label: a.label, enabled: a.enabled, walletAddress: a.walletAddress,
      policy: a.policy, balanceMinor,
      committedMinor: state.getMandate(a.id)?.spentMinor ?? 0,
      wins: claims.length, spentMinor, lots,
    };
  }));
  return Response.json({ agents: out });
}
