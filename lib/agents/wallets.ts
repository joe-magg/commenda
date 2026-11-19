/**
 * Wallets for user-created agents.
 *
 * WHY a server-held agent key (not the owner's MetaMask): an agent must sign
 * every bid — the x402 EIP-3009 authorization and the escrow placeBid — on
 * its own, in real time. A browser wallet never signs without a human click.
 * The agent's wallet holds only what its owner deposits, so the worst case
 * (bug, compromised server, bad strategy) is bounded by that deposit; the
 * owner's own key never leaves their wallet.
 *
 * WHY derived (HKDF over AGENT_MASTER_SEED + agent id), not stored: no key
 * ever rests in the database (a DB leak exposes only public addresses), and a
 * lost DB loses no funds — same seed + id → same wallet. The cost: the seed
 * holder controls every agent wallet. Testnet-appropriate; production moves
 * the seed into a KMS or swaps this module for Circle MPC wallets.
 *
 * Funds leave an agent wallet only two ways: bids into the escrow, and
 * withdraw() to its OWNER's sign-in address — there is no other destination.
 */
import { hkdfSync } from "node:crypto";
import { createPublicClient, createWalletClient, http, parseAbiItem, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, USDC_ARC } from "@/lib/auction/chain";

/** secp256k1 group order — a derived key must be in [1, n-1]. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export const USER_AGENT_PREFIX = "agt_";
/** One-time testnet grant from the house treasury, in USDC minor units. */
export const GRANT_MINOR = 5_000_000;
/** Kept back on withdraw so the transfer itself can pay gas (gas is USDC on Arc). */
export const GAS_RESERVE_MINOR = 20_000;
/** Minimum balance before an agent may go to the floor (an opening bid + fees). */
export const MIN_FLOOR_BALANCE_MINOR = 500_000;

const ERC20 = [
  parseAbiItem("function balanceOf(address) view returns (uint256)"),
  parseAbiItem("function transfer(address to, uint256 amount) returns (bool)"),
] as const;

export function isUserAgent(agentId: string): boolean {
  return agentId.startsWith(USER_AGENT_PREFIX) && /^agt_[a-f0-9]{16}$/.test(agentId);
}

function masterSeed(): Buffer | null {
  const raw = process.env.AGENT_MASTER_SEED;
  if (!raw || !/^0x[a-fA-F0-9]{64,}$/.test(raw)) return null;
  return Buffer.from(raw.slice(2), "hex");
}

/** True when user agents can have wallets on this server. */
export function walletsEnabled(): boolean {
  return masterSeed() !== null;
}

/**
 * Derive a user agent's private key. Deterministic, never stored, never
 * logged. Pure given the seed — exported for tests via the `seed` arg.
 */
export function deriveAgentKey(agentId: string, seed: Buffer | null = masterSeed()): `0x${string}` | null {
  if (!seed || !isUserAgent(agentId)) return null;
  for (let counter = 0; counter < 8; counter++) {
    const okm = Buffer.from(hkdfSync("sha256", seed, "commenda-agent-wallet-v1", `${agentId}:${counter}`, 32));
    const k = BigInt(`0x${okm.toString("hex")}`);
    if (k > 0n && k < SECP256K1_N) return `0x${okm.toString("hex")}`;
  }
  return null; // astronomically unlikely
}

export function deriveAgentAddress(agentId: string, seed?: Buffer | null): string | null {
  const key = deriveAgentKey(agentId, seed === undefined ? masterSeed() : seed);
  return key ? privateKeyToAccount(key).address.toLowerCase() : null;
}

const rpc = () => http("https://rpc.testnet.arc.io", { timeout: 15_000 });
const publicClient = () => createPublicClient({ chain: arcTestnet, transport: rpc(), pollingInterval: 250 });

/** Liquid USDC in a wallet, in minor units (ERC-20 view, 6 decimals). */
export async function usdcBalance(address: string): Promise<number> {
  const raw = await publicClient().readContract({
    address: USDC_ARC, abi: ERC20, functionName: "balanceOf", args: [address as Address],
  });
  return Number(raw);
}

async function transferUsdc(fromKey: `0x${string}`, to: string, amountMinor: number): Promise<string> {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error("bad amount");
  const account = privateKeyToAccount(fromKey);
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: rpc() });
  const hash = await wallet.writeContract({
    address: USDC_ARC, abi: ERC20, functionName: "transfer", args: [to as Address, BigInt(amountMinor)],
  });
  const receipt = await publicClient().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transfer reverted: ${hash}`);
  return hash;
}

/** One-time testnet grant from the house treasury to a user agent. */
export async function grantFromTreasury(agentId: string): Promise<{ txHash: string; amountMinor: number }> {
  const to = deriveAgentAddress(agentId);
  const treasuryKey = process.env.FEE_SELLER_PRIVATE_KEY as `0x${string}` | undefined;
  if (!to || !treasuryKey) throw new Error("grants unavailable");
  const txHash = await transferUsdc(treasuryKey, to, GRANT_MINOR);
  return { txHash, amountMinor: GRANT_MINOR };
}

/**
 * Send an agent's liquid balance home. The destination is a parameter only
 * so the caller can pass the OWNER's verified sign-in address — the route
 * derives it from the session, never from the request body.
 */
export async function withdrawToOwner(agentId: string, ownerAddress: string): Promise<{ txHash: string; amountMinor: number } | null> {
  const key = deriveAgentKey(agentId);
  const from = deriveAgentAddress(agentId);
  if (!key || !from) throw new Error("no wallet for agent");
  const balance = await usdcBalance(from);
  const amount = balance - GAS_RESERVE_MINOR;
  if (amount <= 0) return null;
  const txHash = await transferUsdc(key, ownerAddress, amount);
  return { txHash, amountMinor: amount };
}

/** Owner's sign-in address from a wallet user id (`wallet_0x…`), else null. */
export function ownerAddressFor(userId: string): string | null {
  const m = /^wallet_(0x[a-f0-9]{40})$/.exec(userId);
  return m ? m[1] : null;
}
