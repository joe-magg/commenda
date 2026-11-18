/**
 * On-chain bid-sequence auditor. Reconstructs every lot's bid history from
 * AuctionEscrow BidPlaced/RefundQueued events and flags anomalies:
 *   - SELF_OUTBID: the same bidder raising its own price on one lot
 *   - REVERT_ORDER overlap evidence comes from the server trace, not logs
 *     (reverted txs emit no events).
 *
 * Read-only RPC; safe to run any time. Run: node scripts/audit-bids.mjs [blocks]
 */
import { createPublicClient, http, parseAbiItem, formatUnits } from "viem";
import { defineChain } from "viem";
import { readFileSync } from "node:fs";

const arcTestnet = defineChain({ id: 5042002, rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } } });

// Load ESCROW_ADDRESS from .env.local without printing any other values.
const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const escrow = env.match(/^ESCROW_ADDRESS=(.+)$/m)?.[1]?.trim();
if (!escrow) {
  console.error("ESCROW_ADDRESS missing in .env.local");
  process.exit(1);
}

const lookback = Number(process.argv[2] ?? 200_000);
const client = createPublicClient({ chain: arcTestnet, transport: http("https://rpc.testnet.arc.io", { timeout: 30_000 }) });

const BID = parseAbiItem("event BidPlaced(uint256 indexed lotId, address indexed bidder, uint96 amount, address indexed prevBidder, uint96 prevAmount, address seller)");

const latest = await client.getBlockNumber();
const from = latest - BigInt(lookback);
const logs = await client.getLogs({ address: escrow, event: BID, fromBlock: from, toBlock: "latest" });
logs.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.logIndex - b.logIndex));

const byLot = new Map();
for (const log of logs) {
  const { lotId, bidder, amount, prevBidder, prevAmount } = log.args;
  const list = byLot.get(String(lotId)) ?? [];
  list.push({
    block: Number(log.blockNumber),
    bidder: String(bidder).toLowerCase(),
    amount: amount.toString(),
    prevBidder: String(prevBidder).toLowerCase(),
    prevAmount: prevAmount.toString(),
  });
  byLot.set(String(lotId), list);
}

let selfOutbids = 0;
let raises = 0;
console.log(`escrow ${escrow} · blocks ${from}..${latest} · ${logs.length} BidPlaced events\n`);

for (const [lotId, bids] of [...byLot.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).slice(-12)) {
  console.log(`lot ${lotId} — ${bids.length} bids`);
  for (const b of bids) {
    const self = b.prevBidder === b.bidder && BigInt(b.prevAmount) > 0n;
    if (self) selfOutbids++;
    else if (b.prevBidder !== "0x0000000000000000000000000000000000000000") raises++;
    const short = (a) => `${a.slice(0, 8)}…${a.slice(-4)}`;
    console.log(
      `  blk ${b.block}  ${short(b.bidder)}  ${formatUnits(BigInt(b.amount), 6)} USDC` +
        (self ? "  ← SELF-OUTBID" : b.prevBidder !== "0x0000000000000000000000000000000000000000" ? `  (outbids ${short(b.prevBidder)})` : "  (opening bid)"),
    );
  }
}

console.log(`\nsummary: ${raises} legitimate raises, ${selfOutbids} SELF-OUTBIDS in the last ${lookback} blocks`);
process.exit(0);
