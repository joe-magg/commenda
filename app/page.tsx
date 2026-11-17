import agentConfigRaw from "@/config/agents.json";
import { AuctionRoom, type AgentView } from "@/components/auction-room";

export const dynamic = "force-dynamic";

const KEY_RE = /^0x[a-f0-9]{64}$/i;

export default function Home() {
  // Public demo info only — no keys cross to the client. `active` reflects
  // whether a server-side wallet key exists (agents without one are kill-switched).
  let keys: Record<string, string> = {};
  try { keys = JSON.parse(process.env.AGENT_KEYS ?? "{}"); } catch { /* none */ }

  const agents: AgentView[] = agentConfigRaw.map((a, i) => ({
    id: a.id,
    label: `Agent ${String.fromCharCode(65 + i)}`,
    short: `${a.id.slice(0, 6)}…${a.id.slice(-4)}`,
    budgetMinor: a.budgetMinor,
    perBidCapMinor: a.perBidCapMinor,
    watchlist: a.watchlist,
    approvalEnabled: a.approvalEnabled,
    approvalAboveMinor: a.approvalAboveMinor,
    active: typeof keys[a.id] === "string" && KEY_RE.test(keys[a.id]),
  }));
  return <AuctionRoom agents={agents} />;
}
