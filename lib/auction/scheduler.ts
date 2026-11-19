/**
 * Auction scheduler — production architecture for a single-process webapp.
 *
 * One process (Railway web service) runs auctions on a fixed schedule:
 * recover anything unsettled from the previous auction → create a fresh
 * session with a generated catalog → run exactly one auction → sleep for
 * AUCTION_GAP_MINUTES → repeat. Each auction is genuinely distinct: new
 * catalog, new on-chain lot ids (chainLotIds are derived from a monotonic
 * visit counter and a per-process base), a persisted session row.
 *
 * This also closes the restart gap: a crash mid-auction leaves committed
 * funds in escrow, and the next boot's recovery step settles those lots (the
 * escrow pays the highest bidder and refunds the rest) before anything new
 * starts.
 */
import { getEngine, type AuctionEvent } from "./engine";
import { getWorkerPool } from "./worker-pool";
import { settleLot } from "./settlement";
import { createSession, endStaleSessions, listOpenLots, setSessionStatus } from "@/lib/db/repo";
import { generateCatalog, itemsToLots, type GeneratedItem } from "@/lib/items/generator";

const ITEMS_PER_AUCTION = Math.min(9, Math.max(1, Number(process.env.AUCTION_ITEMS ?? 3)));
const GAP_MS = Math.max(30_000, Number(process.env.AUCTION_GAP_MINUTES ?? 5) * 60_000);
const START_DELAY_MS = Math.max(5_000, Number(process.env.AUCTION_START_DELAY_MS ?? 45_000));

/**
 * Settle every lot the engine opened but never closed (crash recovery). The
 * open_lots table is written at lot open, so this covers lots interrupted
 * mid-bidding — not just lots that reached SOLD. Lots with no bids are
 * simply closed. Failures leave the lot open for the next pass.
 */
export async function recoverUnsettledLots(skipChainLotId?: number): Promise<number> {
  let recovered = 0;
  for (const lot of listOpenLots()) {
    if (lot.chainLotId === skipChainLotId) continue; // the live lot
    try {
      const r = await settleLot(lot);
      if (r.winnerId) {
        recovered++;
        console.info("[commenda:scheduler] recovered lot", JSON.stringify({ lotId: lot.chainLotId, tx: r.tx }));
      }
    } catch (e) {
      console.warn("[commenda:scheduler] recovery settle deferred", JSON.stringify({
        lotId: lot.chainLotId, reason: e instanceof Error ? e.message.slice(0, 80) : "unknown",
      }));
    }
  }
  return recovered;
}

type SchedulerControl = { startNow: () => boolean };
const ctl = globalThis as typeof globalThis & { __commendaSchedulerCtl?: SchedulerControl };

/** Skip the intermission and start the next auction now (demo control). */
export function startNextAuctionNow(): boolean {
  return ctl.__commendaSchedulerCtl?.startNow() ?? false;
}

export function startAuctionScheduler(): () => void {
  const g = globalThis as typeof globalThis & { __commendaScheduler?: boolean };
  if (g.__commendaScheduler) return () => {};
  g.__commendaScheduler = true;

  const engine = getEngine();
  const pool = getWorkerPool();
  endStaleSessions();
  let sessionIdx = 0;
  let stopped = false;
  let stopWaiting: (() => void) | null = null;
  let sleeping = false;
  ctl.__commendaSchedulerCtl = {
    startNow: () => {
      if (!sleeping || !stopWaiting) return false;
      stopWaiting();
      return true;
    },
  };

  /** Resolve when the engine emits auction_end (or immediately if it already did). */
  function waitAuctionEnd(): Promise<void> {
    if (engine.snapshot().phase === "ended" || engine.snapshot().phase === "idle") return Promise.resolve();
    return new Promise((resolve) => {
      const unsub = engine.subscribe((e: AuctionEvent) => {
        if (e.type === "auction_end") {
          unsub();
          stopWaiting = null;
          resolve();
        }
      });
      stopWaiting = () => { unsub(); resolve(); };
    });
  }

  /** The next auction is published at the START of the intermission — the
   *  Sotheby's model: bidders (and viewers) see the catalog before it runs. */
  let upcoming: { id: string; name: string; items: GeneratedItem[] } | null = null;
  function publishNext(): void {
    const items = generateCatalog(`commenda-session-${Date.now().toString(36)}`, ITEMS_PER_AUCTION)
      .map((item: GeneratedItem, i: number) => ({ ...item, id: i }));
    const name = `Flash Auction #${sessionIdx + 1}`;
    const session = createSession(name, items, "scheduled");
    upcoming = { id: session.id, name, items };
  }

  async function runAuction(): Promise<void> {
    sessionIdx++;
    if (!upcoming) publishNext();
    const { id, name, items } = upcoming!;
    upcoming = null;
    setSessionStatus(id, "live");
    console.info("[commenda:scheduler] starting auction", JSON.stringify({
      session: id, items: items.length, gapMinutes: GAP_MS / 60_000,
    }));

    pool.resetCycle();
    engine.setLots(itemsToLots(items), name);
    engine.start();

    await waitAuctionEnd();
    setSessionStatus(id, "ended");
    console.info("[commenda:scheduler] auction ended", JSON.stringify({ session: id }));
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        // Sleep first: START_DELAY before the very first auction, the gap
        // between subsequent ones. Recovery runs in that window too.
        const ms = sessionIdx === 0 ? START_DELAY_MS : GAP_MS;
        publishNext();
        engine.setNextAuctionAt(Date.now() + ms);
        sleeping = true;
        await new Promise<void>((r) => {
          const t = setTimeout(r, ms);
          stopWaiting = () => { clearTimeout(t); r(); };
        });
        sleeping = false;
        stopWaiting = null;
        if (stopped) return;
        const recovered = await recoverUnsettledLots();
        if (recovered > 0) {
          console.info("[commenda:scheduler] recovery settled lots", JSON.stringify({ recovered }));
        }
        await runAuction();
      } catch (e) {
        console.warn("[commenda:scheduler] cycle failed — retrying after gap", JSON.stringify({
          reason: e instanceof Error ? e.message.slice(0, 120) : "unknown",
        }));
        sleeping = false;
        await new Promise<void>((r) => { setTimeout(r, GAP_MS); stopWaiting = () => r(); });
      }
    }
  }

  void loop();

  return () => {
    stopped = true;
    stopWaiting?.();
  };
}
