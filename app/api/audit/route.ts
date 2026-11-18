/**
 * GET /api/audit — the signed-in operator's decision log: every bid decision
 * (bid_* events from the x402 route), agent lifecycle changes, and claims.
 * This is the "watch the machine enforce" surface — the guardrail
 * architecture made observable.
 */
import { currentUser } from "@/lib/auth";
import { listAgents, listAuditEvents } from "@/lib/db/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: "not signed in" }, { status: 401 });
  const limit = Math.max(1, Math.min(300, Number(new URL(req.url).searchParams.get("limit") ?? 120)));
  const events = listAuditEvents(limit);
  // Enrich agent ids with their marks/labels for the UI.
  const agents = new Map(listAgents().map((a) => [a.id, a.label]));
  const counts: Record<string, number> = {};
  for (const e of events) {
    const group = e.kind.startsWith("bid_") ? `decision:${e.kind.slice(4)}` : e.kind;
    counts[group] = (counts[group] ?? 0) + 1;
  }
  return Response.json({ events: events.map((e) => ({ ...e, label: e.agentId ? agents.get(e.agentId) ?? null : null })), counts });
}
