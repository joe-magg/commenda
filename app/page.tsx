import agentConfigRaw from "@/config/agents.json";
import { AuctionRoom, type AgentView } from "@/components/auction-room";

export default function Home() {
  // Sanitized, public demo info only — no keys, no secrets cross to the client.
  const agents: AgentView[] = agentConfigRaw.map((a, i) => ({
    id: a.id,
    label: `Agent ${i === 0 ? "A" : "B"}`,
    short: `${a.id.slice(0, 6)}…${a.id.slice(-4)}`,
    budgetMinor: a.budgetMinor,
    perBidCapMinor: a.perBidCapMinor,
    watchlist: a.watchlist,
    approvalEnabled: a.approvalEnabled,
  }));
  return <AuctionRoom agents={agents} />;
}
