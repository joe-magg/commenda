/**
 * Thin viem adapter for Arc testnet AuctionEscrow. All RPC/timeout handling here;
 * the rest of the caller layer depends only on the ChainPort interface.
 * Reads on-chain amounts as bigint; no number conversion except bounded helpers.
 */
import { createPublicClient, createWalletClient, http, parseAbiItem, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";
import type { ChainPort } from "./submit-bid";
import type { ChainEvent, EventKey } from "./reconcile";
import type { Bid } from "./decide";

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "Arcscan", url: "https://explorer.testnet.arc.io" } },
  // Arc has sub-second finality. Without this, viem assumes Ethereum's 12s
  // blocks and polls receipts every 4s, adding up to 8s to a two-tx bid.
  blockTime: 500,
});

const RPC = "https://rpc.testnet.arc.io";
const rpc = (timeoutMs = 15_000) => http(RPC, { timeout: timeoutMs });
/** Client-level interval — viem's default is 4s, far too slow for Arc. */
const POLL_MS = 250;

export const USDC_ARC = "0x3600000000000000000000000000000000000000" as const;

const EVENT_ABI = [
  parseAbiItem("event BidPlaced(uint256 indexed lotId, address indexed bidder, uint96 amount, address indexed prevBidder, uint96 prevAmount, address seller)"),
  parseAbiItem("event RefundQueued(address indexed bidder, uint256 amount)"),
  parseAbiItem("event RefundClaimed(address indexed bidder, uint256 amount)"),
  parseAbiItem("event LotSettled(uint256 indexed lotId, address indexed bidder, uint96 amount, address indexed seller)"),
  parseAbiItem("event EmergencyRefund(uint256 indexed lotId, address indexed bidder, uint96 amount)"),
  parseAbiItem("event AuctioneerChanged(address oldAuctioneer, address newAuctioneer)"),
] as const;

const ESCROW_ABI = [
  parseAbiItem("function approve(address spender, uint256 amount) returns (bool)"),
  parseAbiItem("function allowance(address owner, address spender) view returns (uint256)"),
  parseAbiItem("function placeBid(uint256 lotId, uint96 amount, address seller)"),
] as const;

export type ChainAdapterConfig = {
  escrowAddress: Address;
  /** Server-held agent wallets keyed by agentId (demo keys; testnet only). */
  agentKeys: Record<string, `0x${string}`>;
  /** Per-agent USDC allowance to pre-approve to escrow (minor units). */
  allowances?: Record<string, number>;
  rpcUrl?: string;
  timeoutMs?: number;
};

/** Build a ChainPort backed by viem against Arc testnet. */
export function createChainAdapter(config: ChainAdapterConfig): ChainPort {
  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: rpc(config.timeoutMs),
    pollingInterval: POLL_MS,
  });

  const accounts = new Map<string, ReturnType<typeof privateKeyToAccount>>();
  for (const [id, key] of Object.entries(config.agentKeys)) accounts.set(id, privateKeyToAccount(key));
  const approved = new Set<string>();
  let lastBlock = 0n;

  /** One-time bounded approval per agent. Saves a whole tx + receipt wait per bid. */
  async function ensureAllowance(agentId: string, account: ReturnType<typeof privateKeyToAccount>): Promise<void> {
    if (approved.has(agentId)) return;
    const wallet = createWalletClient({ account, chain: arcTestnet, transport: rpc(config.timeoutMs) });
    const current = await publicClient.readContract({
      address: USDC_ARC,
      abi: ESCROW_ABI,
      functionName: "allowance",
      args: [account.address, config.escrowAddress],
    });
    const desired = BigInt(config.allowances?.[agentId] ?? 0);
    if (desired > 0n && BigInt(current) < desired) {
      const hash = await wallet.writeContract({
        address: USDC_ARC,
        abi: ESCROW_ABI,
        functionName: "approve",
        args: [config.escrowAddress, desired],
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }
    approved.add(agentId);
  }

  async function submitPlaceBid(bid: Bid, agentId: string): Promise<{ txHash: string; fromBlock: bigint }> {
    const start = Date.now();
    const account = accounts.get(agentId);
    if (!account) throw new Error(`no server wallet for agent ${agentId}`);
    const wallet = createWalletClient({ account, chain: arcTestnet, transport: rpc(config.timeoutMs) });
    await ensureAllowance(agentId, account);

    const hash = await wallet.writeContract({
      address: config.escrowAddress,
      abi: ESCROW_ABI,
      functionName: "placeBid",
      args: [BigInt(bid.lotId), BigInt(bid.amountMinor) as never, bid.seller as Address],
    });
    // Arc has instant finality and the resolver already waits for the receipt
    // authoritatively. Don't spend another RPC round trip here — hand it a
    // bounded lookback from the block we just synced in this same request.
    const fromBlock = lastBlock > 2n ? lastBlock - 2n : 0n;
    console.info("[commenda:chain] placeBid", JSON.stringify({
      agent: agentId,
      ms: Date.now() - start,
      fromBlock: String(fromBlock),
    }));
    return { txHash: hash, fromBlock };
  }

  async function syncEvents(fromBlock?: bigint): Promise<{ events: ChainEvent[]; latestBlock: bigint }> {
    const latest = await publicClient.getBlockNumber();
    lastBlock = latest;
    const from = fromBlock ?? latest - 500n; // bounded lookback for the demo
    const logs = await publicClient.getLogs({
      address: config.escrowAddress,
      events: EVENT_ABI,
      fromBlock: from < 0n ? 0n : from,
      toBlock: latest,
    });
    const events: ChainEvent[] = [];
    for (const log of logs) {
      const key: EventKey = { blockNumber: log.blockNumber, logIndex: log.logIndex };
      const a = log.args as Record<string, unknown>;
      switch (log.eventName) {
        case "BidPlaced":
          events.push({ kind: "BidPlaced", lotId: a.lotId as bigint, bidder: a.bidder as string, amount: a.amount as bigint, prevBidder: a.prevBidder as string, prevAmount: a.prevAmount as bigint, seller: a.seller as string, key });
          break;
        case "RefundQueued":
          events.push({ kind: "RefundQueued", bidder: a.bidder as string, amount: a.amount as bigint, key });
          break;
        case "RefundClaimed":
          events.push({ kind: "RefundClaimed", bidder: a.bidder as string, amount: a.amount as bigint, key });
          break;
        case "LotSettled":
          events.push({ kind: "LotSettled", lotId: a.lotId as bigint, bidder: a.bidder as string, amount: a.amount as bigint, seller: a.seller as string, key });
          break;
        case "EmergencyRefund":
          events.push({ kind: "EmergencyRefund", lotId: a.lotId as bigint, bidder: a.bidder as string, amount: a.amount as bigint, key });
          break;
        case "AuctioneerChanged":
          events.push({ kind: "AuctioneerChanged", oldAuctioneer: a.oldAuctioneer as string, newAuctioneer: a.newAuctioneer as string, key });
          break;
      }
    }
    return { events, latestBlock: latest };
  }

  return { syncEvents, submitPlaceBid };
}

/**
 * Settle a lot as the auctioneer (server-held fee-seller key). Used once per
 * lot on SOLD. Reverts are caught by the engine hook and surfaced as a warning.
 */
export async function settleOnChain(lotId: number): Promise<string> {
  const key = process.env.FEE_SELLER_PRIVATE_KEY;
  const escrow = process.env.ESCROW_ADDRESS;
  if (!key || !escrow) throw new Error("missing settlement env");
  const account = privateKeyToAccount(key as `0x${string}`);
  const transport = rpc();
  const wallet = createWalletClient({ account, chain: arcTestnet, transport });
  const publicClient = createPublicClient({ chain: arcTestnet, transport, pollingInterval: POLL_MS });
  const already = await publicClient.readContract({
    address: escrow as Address,
    abi: [parseAbiItem("function isSettled(uint256) view returns (bool)")],
    functionName: "isSettled",
    args: [BigInt(lotId)],
  });
  if (already) return "";
  const hash = await wallet.writeContract({
    address: escrow as Address,
    abi: [parseAbiItem("function settle(uint256)")],
    functionName: "settle",
    args: [BigInt(lotId)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Resolve a submitted tx to a receipt + its events (used by the resolver). */
export function createTxResolver(config: { rpcUrl?: string }) {
  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: rpc(),
    pollingInterval: POLL_MS,
  });
  return async (txHash: string): Promise<{ blockNumber: bigint; status: "success" | "reverted" }> => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hex });
    return { blockNumber: receipt.blockNumber, status: receipt.status };
  };
}
