import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { listAgents } from "@/lib/db/repo";
import { SignIn } from "@/components/sign-in";
import { Ledger } from "@/components/screens/ledger";

export const dynamic = "force-dynamic";

/** Your agents' results. First visit (no agents yet) goes straight to the brief. */
export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) return <SignIn />;
  if (listAgents(user.id).length === 0) redirect("/create");
  return <Ledger userName={user.name} />;
}
