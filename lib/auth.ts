import { cookies } from "next/headers";
import { listUsers, type User } from "@/lib/db/repo";
import { verifySession } from "@/lib/session";

export const SESSION_COOKIE = "commenda_user";

/** Server-side session read. The cookie is an HMAC-signed, expiring token —
 *  it holds a user id, never a key, and cannot be forged or edited. */
export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  const id = verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!id) return null;
  return listUsers().find((u) => u.id === id) ?? null;
}
