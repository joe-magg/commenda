/**
 * GET /api/auction — the agent-facing public snapshot. Everything an
 * external agent needs to make a decision: the open lot and its facts, the
 * receipt-confirmed highest bid, the minimum valid raise, and the clock.
 * Public on-chain or engine state only — no mandate data.
 *
 * To bid: POST /api/bids (x402, $0.001) with { id, lotId, amountMinor }.
 * The server binds the bid to the open lot; category/seller are floor facts.
 */
import { ensureBootstrapped } from "@/lib/auction/bootstrap";
import { getEngine } from "@/lib/auction/engine";
import { minNextBid } from "@/lib/agents/strategy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  ensureBootstrapped();
  const snap = getEngine().snapshot();
  const open = getEngine().openLot();
  const highest = snap.bidCount > 0 ? snap.currentBidMinor : null;

  return Response.json({
    session: snap.sessionName,
    lot:
      open
        ? {
            chainLotId: open.chainLotId,
            displayId: open.lot.id,
            title: open.lot.title,
            category: open.lot.category,
            seller: open.lot.seller,
            openingMinor: open.lot.openingMinor,
            sku: open.lot.sku,
          }
        : null,
    phase: snap.phase,
    acceptingBids: open?.accepting ?? false,
    lotIndex: snap.lotIndex,
    totalLots: snap.totalLots,
    bidCount: snap.bidCount,
    highestBidMinor: highest,
    highestBidder: snap.leaderLabel,
    minNextBidMinor: open ? minNextBid(highest, open.lot.openingMinor) : null,
    endsInMs: snap.phaseEndsAt ? Math.max(0, snap.phaseEndsAt - Date.now()) : null,
    softClose: "a bid during the countdown reopens the lot",
    nextAuctionInMs: snap.nextAuctionAt ? Math.max(0, snap.nextAuctionAt - Date.now()) : null,
  });
}
