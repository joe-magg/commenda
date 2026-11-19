/**
 * One-time wiring of engine hooks to the agent pool, voice and settlement.
 * Called lazily from the first SSE/API request so dev reloads cannot double-start.
 * Starting auctions is the scheduler's job alone — viewers never start the show.
 */
import { getEngine } from "./engine";
import { getWorkerPool } from "./worker-pool";
import { startResolver } from "./resolver-runner";
import { startAuctionScheduler } from "./scheduler";
import { settleLot } from "./settlement";
import { speak } from "@/lib/voice/synth";
import { getAgent, recordLotOpened } from "@/lib/db/repo";

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
  // Agents read the floor as the engine sees it: receipt-confirmed bids from
  // ANY bidder (pool or external x402 client) — not just their own.
  pool.setMarketSource((chainLotId) => {
    const s = engine.snapshot();
    if (s.chainLotId !== chainLotId) return null;
    return {
      highestMinor: s.bidCount > 0 ? s.currentBidMinor : null,
      leaderId: s.leaderId,
      bidCount: s.bidCount,
    };
  });

  engine.setHooks({
    onLotOpen: (lot, chainLotId) => {
      // Persist BEFORE bidding opens: crash recovery settles any lot left open.
      recordLotOpened({ chainLotId, title: lot.title, sku: lot.sku, artSeed: lot.artSeed, category: lot.category });
      pool.onLotOpen(lot, chainLotId);
    },
    onBidSlot: (lot, slot, chainLotId, ctx) => pool.onBidSlot(lot, slot, chainLotId, ctx),
    speak: (lineId, args, lotIndex, ctx) => speak(lineId, args, lotIndex, ctx),
    onUnsold: (lot, chainLotId) => {
      pool.onLotEnd(chainLotId, null);
      // Still chain-checked: a late external bid would otherwise be stranded.
      // settleLot closes a truly empty lot and settles anything that landed.
      void settleLot({ chainLotId, title: lot.title, sku: lot.sku, artSeed: lot.artSeed })
        .catch(() => { /* stays open; recovery retries */ });
    },
    onSold: async (lot, _amount, chainLotId) => {
      // Winner + amount come from ESCROW STATE (settlement.ts), never local.
      try {
        const r = await settleLot({ chainLotId, title: lot.title, sku: lot.sku, artSeed: lot.artSeed });
        pool.onLotEnd(chainLotId, r.winnerId);
        return {
          txHash: r.tx,
          winnerId: r.winnerId,
          winnerLabel: r.winnerId ? getAgent(r.winnerId)?.label ?? null : null,
          amountMinor: r.amountMinor,
        };
      } catch (e) {
        // Lot stays in open_lots; the scheduler's recovery pass retries it.
        console.warn("[commenda:settle] deferred to recovery", e instanceof Error ? e.message.slice(0, 120) : e);
        pool.onLotEnd(chainLotId, pool.winnerFor(chainLotId));
        return undefined;
      }
    },
  });

  startAuctionScheduler();
  console.info("[commenda] agent pool wired; engine ready");
}
