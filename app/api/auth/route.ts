/** Wallet sign-in: verify a signed message, map the address to a demo user, set a session cookie. */
import { verifyMessage } from "viem";
import { userForAddress } from "@/lib/db/repo";
import { SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

export const SIGNIN_MESSAGE = "Sign in to Commenda. This is a free demo signature with no transaction.";

export async function POST(req: Request): Promise<Response> {
  let body: { address?: string; signature?: string };
  try { body = await req.json(); } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.address || !body.signature) {
    return Response.json({ error: "address and signature required" }, { status: 400 });
  }

  let valid = false;
  try {
    valid = await verifyMessage({
      address: body.address as `0x${string}`,
      message: SIGNIN_MESSAGE,
      signature: body.signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) return Response.json({ error: "invalid signature" }, { status: 401 });

  const user = userForAddress(body.address);
  if (!user) return Response.json({ error: "no user for address" }, { status: 404 });

  const res = Response.json({ user });
  res.headers.set(
    "set-cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(user.id)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`,
  );
  return res;
}

export async function DELETE(): Promise<Response> {
  const res = Response.json({ ok: true });
  res.headers.set("set-cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  return res;
}
