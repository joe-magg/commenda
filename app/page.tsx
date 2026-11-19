import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { listAgents } from "@/lib/db/repo";
import { SignIn } from "@/components/sign-in";

export const dynamic = "force-dynamic";

/** Sign in first; then first-timers brief an agent, returning users see results. */
export default async function Home() {
  const user = await currentUser();
  if (user) redirect(listAgents(user.id).length === 0 ? "/create" : "/dashboard");
  return <SignIn />;
}
