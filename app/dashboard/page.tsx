import { currentUser } from "@/lib/auth";
import { AgentDashboard } from "@/components/agent-dashboard";
import { SignIn } from "@/components/sign-in";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) return <SignIn />;
  return <AgentDashboard userName={user.name} />;
}
