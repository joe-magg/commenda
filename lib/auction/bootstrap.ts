/**
 * One-time wiring of engine hooks to the worker pool, voice and settlement.
 * Called lazily from the first SSE connection so dev reloads cannot double-start.
 */
import { getEngine } from "./engine";
import { getWorkerPool } from "./worker-pool";
import { settleOnChain, highestBidOnChain } from "./chain";
import { startResolver } from "./resolver-runner";
import { speak } from "@/lib/voice/synth";
import { createClaim, listSessions } from "@/lib/db/repo";
import { itemsToLots, type GeneratedItem } from "@/lib/items/generator";
import { buildReceiptUri } from "@/lib/items/art-uri";
import { mintReceipt } from "./receipt-chain";
import { getRuntime } from "./runtime";

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
      const tx = await settleOnChain(chainLotId).catch(() => "");
      // Winner + amount from ESCROW STATE, not the local pool (audit 4.2):
      // the pool's currentBidder is "last completed local bid" and can be
      // wrong when bid slots overlap; escrow holds whoever actually bid last.
      let winner = pool.winnerFor(chainLotId);
      let settledMinor = amount;
      try {
        const hb = await highestBidOnChain(chainLotId);
        if (hb) {
          const { state } = getRuntime();
          winner = state.addressToAgent.get(hb.bidder) ?? hb.bidder;
          settledMinor = hb.amountMinor;
        }
      } catch {
        // keep the pool attribution if the read fails — demo continues
      }
      if (winner) {
        createClaim({
          chainLotId,
          winnerId: winner,
          title: lot.title,
          sku: lot.sku,
          amountMinor: settledMinor,
          settleTx: tx || null,
        });
        // Soulbound receipt — best effort: a mint failure must not stall the show.
        if (process.env.RECEIPT_NFT_ADDRESS) {
          try {
            const uri = buildReceiptUri(
              { title: lot.title, sku: lot.sku, amountMinor: settledMinor, artSeed: lot.artSeed },
              winner,
            );
            const mint = await mintReceipt(chainLotId, winner, uri);
            console.info("[commenda:receipt] minted", JSON.stringify({ lot: chainLotId, tokenId: mint.tokenId, winner }));
          } catch (e) {
            console.warn("[commenda:receipt] mint failed", e instanceof Error ? e.message.slice(0, 120) : e);
          }
        }
      }
      pool.onLotEnd(chainLotId, winner);
      return tx;
    },
  });
  console.info("[commenda] worker pool wired; engine ready");
}
