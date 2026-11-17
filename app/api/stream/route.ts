/**
 * Server-Sent Events feed — the one-way server -> browser stream.
 * Bids are writes via the x402-gated POST /api/bids; this is only the readout.
 */
import { ensureBootstrapped } from "@/lib/auction/bootstrap";
import { getEngine, type AuctionEvent } from "@/lib/auction/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  ensureBootstrapped();
  const engine = getEngine();
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => {};
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: AuctionEvent) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch { /* closed */ }
      };
      unsubscribe = engine.subscribe(send);
      keepalive = setInterval(() => {
        try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { /* closed */ }
      }, 15_000);
      engine.start();
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
