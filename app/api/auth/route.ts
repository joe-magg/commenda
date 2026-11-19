/**
 * Wallet sign-in, challenge-response:
 *   GET  → a single-use nonce + the exact message to sign (5-minute TTL)
 *   POST → { address, signature, nonce }: consume the nonce, verify the
 *          signature over the challenge message, set a signed session cookie.
 */
import { verifyMessage } from "viem";
import { userForAddress } from "@/lib/db/repo";
import { SESSION_COOKIE } from "@/lib/auth";
import { challengeMessage, consumeChallenge, issueChallenge, signSession, SESSION_TTL_MS } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json(issueChallenge());
}

export async function POST(req: Request): Promise<Response> {
  let body: { address?: string; signature?: string; nonce?: string };
  try { body = await req.json(); } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.address || !body.signature || !body.nonce) {
    return Response.json({ error: "address, signature and nonce required" }, { status: 400 });
  }
  // Single-use: consumed before verification, so a failed attempt burns it too.
  if (!consumeChallenge(body.nonce)) {
    return Response.json({ error: "Sign-in expired — try again." }, { status: 401 });
  }

  let valid = false;
  try {
    valid = await verifyMessage({
      address: body.address as `0x${string}`,
      message: challengeMessage(body.nonce),
      signature: body.signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) return Response.json({ error: "invalid signature" }, { status: 401 });

  const user = userForAddress(body.address);
  if (!user) return Response.json({ error: "no user for address" }, { status: 404 });

  const res = Response.json({ user });
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.headers.set(
    "set-cookie",
    `${SESSION_COOKIE}=${signSession(user.id)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
  );
  return res;
}

export async function DELETE(): Promise<Response> {
  const res = Response.json({ ok: true });
  res.headers.set("set-cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  return res;
}
