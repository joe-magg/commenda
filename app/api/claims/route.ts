/** Redemption claims — non-transferable receipts for lots won on-chain. */
import { listClaims } from "@/lib/db/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const winner = new URL(req.url).searchParams.get("winner") ?? undefined;
  return Response.json({ claims: listClaims(winner) });
}
