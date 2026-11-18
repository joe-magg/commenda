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
import { settleOnChain } from "./chain";
import { createSession, listClaims, setSessionStatus } from "@/lib/db/repo";
import { generateCatalog, itemsToLots, type GeneratedItem } from "@/lib/items/generator";

const ITEMS_PER_AUCTION = Math.max(1, Number(process.env.AUCTION_ITEMS ?? 3));
const GAP_MS = Math.max(30_000, Number(process.env.AUCTION_GAP_MINUTES ?? 5) * 60_000);
const START_DELAY_MS = Math.max(5_000, Number(process.env.AUCTION_START_DELAY_MS ?? 45_000));

/** Best-effort settle of lots that never finished (crash recovery). */
export async function recoverUnsettledLots(): Promise<number> {
  const unsettled = listClaims().filter((c) => c.status === "issued" && !c.settleTx);
  let recovered = 0;
  for (const claim of unsettled) {
    const lotId = Number(claim.chainLotId);
    if (!Number.isSafeInteger(lotId)) continue;
    try {
      const tx = await settleOnChain(lotId); // idempotent: skips already-settled lots
      if (tx) {
        recovered++;
        console.info("[commenda:scheduler] recovered unsettled lot", JSON.stringify({ lotId, tx }));
      }
    } catch (e) {
      // An empty or already-settled lot reverts — recovery is best-effort.
      console.warn("[commenda:scheduler] recovery settle skipped", JSON.stringify({
        lotId, reason: e instanceof Error ? e.message.slice(0, 80) : "unknown",
      }));
    }
  }
  return recovered;
}

export function startAuctionScheduler(): () => void {
  const g = globalThis as typeof globalThis & { __commendaScheduler?: boolean };
  if (g.__commendaScheduler) return () => {};
  g.__commendaScheduler = true;

  const engine = getEngine();
  const pool = getWorkerPool();
  let sessionIdx = 0;
  let stopped = false;
  let stopWaiting: (() => void) | null = null;

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

  async function runAuction(): Promise<void> {
    sessionIdx++;
    const catalog = generateCatalog(`commenda-session-${Date.now().toString(36)}`, ITEMS_PER_AUCTION)
      .map((item: GeneratedItem, i: number) => ({ ...item, id: i }));
    const items = catalog as GeneratedItem[];
    const session = createSession(`Flash Auction #${sessionIdx}`, items);
    console.info("[commenda:scheduler] starting auction", JSON.stringify({
      session: session.id, items: items.length, gapMinutes: GAP_MS / 60_000,
    }));

    pool.resetCycle();
    engine.setLots(itemsToLots(items));
    engine.start();

    await waitAuctionEnd();
    setSessionStatus(session.id, "ended");
    console.info("[commenda:scheduler] auction ended", JSON.stringify({ session: session.id }));
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        // Sleep first: START_DELAY before the very first auction, the gap
        // between subsequent ones. Recovery runs in that window too.
        await new Promise<void>((r) => {
          const t = setTimeout(r, sessionIdx === 0 ? START_DELAY_MS : GAP_MS);
          stopWaiting = () => { clearTimeout(t); r(); };
        });
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
