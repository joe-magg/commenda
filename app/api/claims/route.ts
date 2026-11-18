/** Redemption claims — non-transferable receipts for lots won on-chain. Sign-in required. */
import { currentUser } from "@/lib/auth";
import { listAgents, listClaims } from "@/lib/db/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: "not signed in" }, { status: 401 });
  const requested = new URL(req.url).searchParams.get("winner") ?? undefined;
  // The winner filter may only narrow to the caller's own agents — an arbitrary
  // ?winner= must not enumerate other users' claims.
  const mine = new Set(listAgents(user.id).map((a) => a.id));
  const winner = requested && mine.has(requested) ? requested : undefined;
  return Response.json({ claims: listClaims(winner).filter((c) => !c.winnerId || mine.has(c.winnerId)) });
}
