/** Manual "Next lot" override for demo safety. */
import { ensureBootstrapped } from "@/lib/auction/bootstrap";
import { getEngine } from "@/lib/auction/engine";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  ensureBootstrapped();
  getEngine().next();
  return Response.json({ ok: true });
}
