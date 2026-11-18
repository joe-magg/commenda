import { listAgents } from "@/lib/db/repo";
import { SignInD } from "@/components/proto/signin-d";

export const metadata = { title: "proto D — the network" };
export const dynamic = "force-dynamic";

export default function Page() {
  const agents = listAgents().map((a) => ({ id: a.id, label: a.label }));
  return <SignInD agents={agents} />;
}
