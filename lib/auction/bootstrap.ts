/**
 * One-time wiring of engine hooks to the real bidder, voice and settlement
 * modules. Called lazily from the first SSE connection so dev reloads and
 * route imports cannot double-start the show.
 */
import { getEngine } from "./engine";
import { placeScriptedBid, activeAgents } from "./bidder";
import { settleOnChain } from "./chain";
import { startResolver } from "./resolver-runner";
import { speak } from "@/lib/voice/synth";

const g = globalThis as typeof globalThis & {
  __commendaResolver?: () => void;
  __commendaBootstrapped?: boolean;
};

export function ensureBootstrapped(): void {
  if (g.__commendaBootstrapped) return;
  g.__commendaBootstrapped = true;
  if (!g.__commendaResolver) g.__commendaResolver = startResolver();
  const engine = getEngine();
  engine.setHooks({
    onBidSlot: (lot, slot, chainLotId) => placeScriptedBid(lot, slot, chainLotId),
    speak: (lineId, args, lotIndex) => speak(lineId, args, lotIndex),
    onSold: (_lot, _amount, chainLotId) => settleOnChain(chainLotId).catch(() => ""),
  });
  console.info("[commenda] engine bootstrapped; live agents:", activeAgents().map((a) => a.label).join(", ") || "(none)");
}
