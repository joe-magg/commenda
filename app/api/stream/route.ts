/**
 * Server-Sent Events feed — the one-way server -> browser stream.
 * Bids are writes via the x402-gated POST /api/bids; this is only the readout.
 */
import { ensureBootstrapped } from "@/lib/auction/bootstrap";
import { getEngine, isPrivateEvent, type AuctionEvent } from "@/lib/auction/engine";
import { currentUser } from "@/lib/auth";
import { listAgents } from "@/lib/db/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  ensureBootstrapped();
  // Private events (an agent's reasoning, limits, block reasons) reach ONLY
  // its owner. Ownership is re-read per event so a freshly created agent's
  // thoughts arrive without reconnecting.
  const user = await currentUser();
  const ownsAgent = (agentId: string) =>
    Boolean(user) && listAgents(user!.id).some((a) => a.id === agentId);
  const engine = getEngine();
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => {};
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: AuctionEvent) => {
        if (isPrivateEvent(event) && !ownsAgent(event.agentId)) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch { /* closed */ }
      };
      unsubscribe = engine.subscribe(send);
      keepalive = setInterval(() => {
        try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { /* closed */ }
      }, 15_000);
      // Viewers never start the show — the scheduler owns auction starts.
    },
    cancel() {
      unsubscribe();
      if (keepalive) clearInterval(keepalive);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
