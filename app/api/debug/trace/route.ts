/**
 * GET /api/debug/trace — auction observability for the signed-in operator:
 * raw trace events plus derived analysis (self-outbids, churn, latencies).
 * Signed-in only: the trace exposes internal agent behavior.
 */
import { currentUser } from "@/lib/auth";
import { analyze, snapshot } from "@/lib/auction/trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: "not signed in" }, { status: 401 });
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 200);
  const analysis = analyze();
  return Response.json({
    analysis,
    events: snapshot().slice(-Math.max(1, Math.min(limit, 1000))),
  });
}
