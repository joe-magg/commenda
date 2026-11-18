/** viem adapter for minting soulbound receipts on Arc testnet. */
import { createPublicClient, createWalletClient, http, parseAbiItem, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "./chain";

const ABI = [parseAbiItem("function mint(uint256 lotId, address to, string uri) returns (uint256)")] as const;
const VIEW = [
  parseAbiItem("function totalMinted() view returns (uint256)"),
  parseAbiItem("function balanceOf(address) view returns (uint256)"),
  parseAbiItem("function tokenOfOwnerByIndex(address,uint256) view returns (uint256)"),
  parseAbiItem("function tokenURI(uint256) view returns (string)"),
] as const;

function address(): Address {
  const a = process.env.RECEIPT_NFT_ADDRESS;
  if (!a) throw new Error("RECEIPT_NFT_ADDRESS missing");
  return a as Address;
}

function transport() {
  return http("https://rpc.testnet.arc.io", { timeout: 15_000 });
}

export async function mintReceipt(lotId: number, to: string, uri: string): Promise<{ txHash: string; tokenId: number }> {
  const key = process.env.FEE_SELLER_PRIVATE_KEY;
  if (!key) throw new Error("FEE_SELLER_PRIVATE_KEY missing");
  const account = privateKeyToAccount(key as `0x${string}`);
  const publicClient = createPublicClient({ chain: arcTestnet, transport: transport(), pollingInterval: 250 });
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: transport() });

  const txHash = await wallet.writeContract({
    address: address(),
    abi: ABI,
    functionName: "mint",
    args: [BigInt(lotId), to as Address, uri],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  const total = await publicClient.readContract({ address: address(), abi: VIEW, functionName: "totalMinted" });
  return { txHash, tokenId: Number(total) };
}

export type OnChainReceipt = { tokenId: number; uri: string };

export async function receiptsFor(owner: string): Promise<OnChainReceipt[]> {
  const publicClient = createPublicClient({ chain: arcTestnet, transport: transport() });
  const addr = address();
  const balance = await publicClient.readContract({ address: addr, abi: VIEW, functionName: "balanceOf", args: [owner as Address] });
  const out: OnChainReceipt[] = [];
  for (let i = 0; i < Number(balance); i++) {
    const tokenId = await publicClient.readContract({
      address: addr, abi: VIEW, functionName: "tokenOfOwnerByIndex", args: [owner as Address, BigInt(i)],
    });
    const uri = await publicClient.readContract({ address: addr, abi: VIEW, functionName: "tokenURI", args: [tokenId] });
    out.push({ tokenId: Number(tokenId), uri });
  }
  return out;
}
