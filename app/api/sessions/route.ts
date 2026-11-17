/** Published auction sessions — agents browse these to decide whether to join. */
import { listSessions } from "@/lib/db/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ sessions: listSessions() });
}
