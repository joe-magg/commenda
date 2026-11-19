import { currentUser } from "@/lib/auth";
import { SignIn } from "@/components/sign-in";
import { CreateAgent } from "@/components/screens/create-agent";

export const dynamic = "force-dynamic";

/** Brief + fund a new agent. */
export default async function Page() {
  if (!(await currentUser())) return <SignIn />;
  return <CreateAgent />;
}
