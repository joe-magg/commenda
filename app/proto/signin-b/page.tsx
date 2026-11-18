import { listAgents } from "@/lib/db/repo";
import { SignInB } from "@/components/proto/signin-b";

export const metadata = { title: "proto B — agentic showcase" };
export const dynamic = "force-dynamic";

export default function Page() {
  const agents = listAgents().map((a) => ({ id: a.id, label: a.label }));
  return <SignInB agents={agents} />;
}
