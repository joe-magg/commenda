import { listAgents } from "@/lib/db/repo";
import { AuctionRoom, type AgentView } from "@/components/auction-room";

export const dynamic = "force-dynamic";

export default function Home() {
  // The registry is the source of truth for the roster. Public info only —
  // no API keys or wallet keys cross to the client.
  const agents: AgentView[] = listAgents().map((a) => ({
    id: a.id,
    label: a.label,
    short: a.walletAddress
      ? `${a.walletAddress.slice(0, 6)}…${a.walletAddress.slice(-4)}`
      : `${a.id.slice(0, 6)}…`,
    budgetMinor: a.policy.budgetMinor,
    perBidCapMinor: a.policy.perBidCapMinor,
    watchlist: a.policy.watchlist,
    approvalEnabled: a.policy.approvalEnabled,
    approvalAboveMinor: a.policy.approvalAboveMinor,
    maxWins: a.policy.maxWins,
    active: a.enabled && a.walletAddress !== null,
  }));
  return <AuctionRoom agents={agents} />;
}
