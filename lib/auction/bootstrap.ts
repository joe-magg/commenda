/**
 * One-time wiring of engine hooks to the worker pool, voice and settlement.
 * Called lazily from the first SSE connection so dev reloads cannot double-start.
 */
import { getEngine } from "./engine";
import { getWorkerPool } from "./worker-pool";
import { settleOnChain } from "./chain";
import { startResolver } from "./resolver-runner";
import { speak } from "@/lib/voice/synth";
import { createClaim, listSessions } from "@/lib/db/repo";
import { itemsToLots, type GeneratedItem } from "@/lib/items/generator";

const g = globalThis as typeof globalThis & {
  __commendaResolver?: () => void;
  __commendaBootstrapped?: boolean;
};

export function ensureBootstrapped(): void {
  if (g.__commendaBootstrapped) return;
  g.__commendaBootstrapped = true;
  if (!g.__commendaResolver) g.__commendaResolver = startResolver();

  const engine = getEngine();
  const sessions = listSessions();
  if (sessions[0]?.catalog.length) {
    engine.setLots(itemsToLots(sessions[0].catalog as GeneratedItem[]));
  }
  const pool = getWorkerPool();
  pool.setEmitter((e) => engine.emitExternal(e));

  engine.setHooks({
    onLotOpen: (lot, chainLotId) => pool.onLotOpen(lot, chainLotId),
    onBidSlot: (lot, slot, chainLotId) => pool.onBidSlot(lot, slot, chainLotId),
    speak: (lineId, args, lotIndex) => speak(lineId, args, lotIndex),
    onSold: async (lot, amount, chainLotId) => {
      const winner = pool.winnerFor(chainLotId);
      const tx = await settleOnChain(chainLotId).catch(() => "");
      if (winner) {
        createClaim({
          chainLotId,
          winnerId: winner,
          title: lot.title,
          sku: lot.sku,
          amountMinor: amount,
          settleTx: tx || null,
        });
      }
      pool.onLotEnd(chainLotId);
      return tx;
    },
  });
  console.info("[commenda] worker pool wired; engine ready");
}
