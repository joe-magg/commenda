/**
 * Settle one lot from CHAIN TRUTH: read the escrow's highest bid, settle it
 * (idempotent — settleOnChain skips settled lots), issue the claim and mint
 * the soulbound receipt. Used by the live hammer AND by crash recovery, so a
 * lot interrupted mid-bidding ends exactly like one that ran to SOLD.
 */
import { settleOnChain, highestBidOnChain } from "./chain";
import { mintReceipt } from "./receipt-chain";
import { getRuntime } from "./runtime";
import { createClaim, listClaims, markLotClosed } from "@/lib/db/repo";
import { buildReceiptUri } from "@/lib/items/art-uri";

export type LotRecord = { chainLotId: number; title: string; sku: string; artSeed?: string | null };
export type SettleResult = { tx: string; winnerId: string | null; amountMinor: number };

export async function settleLot(lot: LotRecord): Promise<SettleResult> {
  const hb = await highestBidOnChain(lot.chainLotId);
  if (!hb) {
    // No bids ever landed — nothing in escrow, nothing to settle.
    markLotClosed(lot.chainLotId);
    return { tx: "", winnerId: null, amountMinor: 0 };
  }
  // Throws on RPC failure: the lot stays open and recovery retries it.
  const tx = await settleOnChain(lot.chainLotId);
  const winnerId = getRuntime().state.addressToAgent.get(hb.bidder) ?? hb.bidder;

  const already = listClaims().some((c) => c.chainLotId === String(lot.chainLotId));
  if (!already) {
    createClaim({
      chainLotId: lot.chainLotId, winnerId, title: lot.title, sku: lot.sku,
      amountMinor: hb.amountMinor, settleTx: tx || null,
    });
    if (process.env.RECEIPT_NFT_ADDRESS) {
      try {
        const uri = buildReceiptUri(
          { title: lot.title, sku: lot.sku, amountMinor: hb.amountMinor, artSeed: lot.artSeed ?? undefined },
          winnerId,
        );
        // The receipt contract only mints to the escrow's recorded winner —
        // the winning WALLET address (hb.bidder), never an internal agent id
        // (user agents' ids are "agt_…", which is not an address).
        const mint = await mintReceipt(lot.chainLotId, hb.bidder, uri);
        console.info("[commenda:receipt] minted", JSON.stringify({ lot: lot.chainLotId, tokenId: mint.tokenId, winner: winnerId }));
      } catch (e) {
        // Best effort: a mint failure must not stall the show.
        console.warn("[commenda:receipt] mint failed", e instanceof Error ? e.message.slice(0, 120) : e);
      }
    }
  }
  markLotClosed(lot.chainLotId, { winnerId, amountMinor: hb.amountMinor });
  return { tx, winnerId, amountMinor: hb.amountMinor };
}
