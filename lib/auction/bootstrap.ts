/**
 * One-time wiring of engine hooks to the worker pool, voice and settlement.
 * Called lazily from the first SSE connection so dev reloads cannot double-start.
 */
import { getEngine } from "./engine";
import { getWorkerPool } from "./worker-pool";
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
  const pool = getWorkerPool();
  pool.setEmitter((e) => engine.emitExternal(e));

  engine.setHooks({
    onLotOpen: (lot, chainLotId) => pool.onLotOpen(lot, chainLotId),
    onBidSlot: (lot, slot, chainLotId) => pool.onBidSlot(lot, slot, chainLotId),
    speak: (lineId, args, lotIndex) => speak(lineId, args, lotIndex),
    onSold: async (lot, _amount, chainLotId) => {
      const tx = await settleOnChain(chainLotId).catch(() => "");
      pool.onLotEnd(chainLotId);
      return tx;
    },
  });
  console.info("[commenda] worker pool wired; engine ready");
}
