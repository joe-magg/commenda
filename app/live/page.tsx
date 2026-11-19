import { currentUser } from "@/lib/auth";
import { listAgents } from "@/lib/db/repo";
import { isUserAgent } from "@/lib/agents/wallets";
import { Floor, type MyAgent } from "@/components/screens/floor";

export const dynamic = "force-dynamic";

/** the live floor, centred on YOUR agent. Rivals: name + mark only. */
export default async function Page() {
  const user = await currentUser();
  const all = listAgents();
  const own = user ? listAgents(user.id).filter((a) => isUserAgent(a.id)) : [];
  // Your most recent agent on the floor, else your most recent one.
  const pick = [...own].reverse().find((a) => a.enabled) ?? own.at(-1);
  const mine: MyAgent = pick ? {
    id: pick.id, label: pick.label, enabled: pick.enabled, strategy: pick.policy.strategy,
    ceilingMinor: pick.policy.perBidCapMinor, budgetMinor: pick.policy.budgetMinor, maxWins: pick.policy.maxWins,
    walletAddress: pick.walletAddress,
  } : null;
  // Public roster: names and marks only — no budgets, no strategies.
  const agents = all
    .filter((a) => a.enabled && a.walletAddress)
    .map((a) => ({ id: a.id, label: a.label, live: true }))
    // Your agent takes the first seat.
    .sort((a, b) => (a.id === mine?.id ? -1 : b.id === mine?.id ? 1 : 0));
  return <Floor agents={agents} mine={mine} />;
}
