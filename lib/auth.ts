import { cookies } from "next/headers";
import { listUsers, type User } from "@/lib/db/repo";

export const SESSION_COOKIE = "commenda_user";

/** Server-side session read. The cookie holds a user id, never a key. */
export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (!id) return null;
  return listUsers().find((u) => u.id === id) ?? null;
}
