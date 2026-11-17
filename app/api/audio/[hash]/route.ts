/**
 * Read-only audio cache server. Serves bytes that speak() already generated;
 * it can NEVER trigger a paid generation. Hash is a server-produced digest.
 */
import { getCachedAudio } from "@/lib/voice/synth";

export const runtime = "nodejs";

const HASH = /^[a-f0-9]{20}$/;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ hash: string }> },
): Promise<Response> {
  const { hash } = await params;
  if (!HASH.test(hash)) return new Response("not found", { status: 404 });
  const buf = getCachedAudio(hash);
  if (!buf) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": String(buf.byteLength),
    },
  });
}
