/**
 * GET /api/auction — the agent-facing public snapshot.
 *
 * Agents today can only blind-bid POST /api/bids; they had no way to learn
 * the current lot, the on-chain highest bid, or how long the lot has left.
 * Everything here is public on-chain or engine state — no mandate data.
 */
import { ensureBootstrapped } from "@/lib/auction/bootstrap";
import { getEngine } from "@/lib/auction/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INCREMENT_MINOR = 100_000; // matches the demo's bid step

export async function GET(): Promise<Response> {
  ensureBootstrapped();
  const snap = getEngine().snapshot();

  // Highest bid above the opening ask; local state is receipt-confirmed
  // (a bid reaches the engine only after its placeBid receipt succeeded).
  const highest = Math.max(0, snap.currentBidMinor - (snap.lot?.openingMinor ?? 0));

  return Response.json({
    lot:
      snap.lot && snap.phase !== "idle"
        ? {
            chainLotId: snap.chainLotId,
            displayId: snap.lot.id,
            title: snap.lot.title,
            category: snap.lot.category,
            seller: snap.lot.seller,
            openingMinor: snap.lot.openingMinor,
            sku: snap.lot.sku,
          }
        : null,
    phase: snap.phase,
    lotIndex: snap.lotIndex,
    totalLots: snap.totalLots,
    highestBidMinor: highest,
    highestBidder: snap.leaderLabel, // display label; the address is public on-chain
    minNextBidMinor:
      highest > 0 ? snap.currentBidMinor + INCREMENT_MINOR : (snap.lot?.openingMinor ?? 0) + INCREMENT_MINOR,
    endsInMs: Math.max(0, snap.phaseEndsAt - Date.now()),
  });
}
