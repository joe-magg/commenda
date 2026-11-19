/** Manual "Next lot" override for demo safety. Requires a signed-in operator. */
import { currentUser } from "@/lib/auth";
import { ensureBootstrapped } from "@/lib/auction/bootstrap";
import { getEngine } from "@/lib/auction/engine";
import { startNextAuctionNow } from "@/lib/auction/scheduler";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: "not signed in" }, { status: 401 });
  ensureBootstrapped();
  const engine = getEngine();
  // Between auctions, "next" skips the intermission; during one, it advances a lot.
  if (!engine.snapshot().started) return Response.json({ ok: startNextAuctionNow(), started: true });
  engine.next();
  return Response.json({ ok: true });
}
