/**
 * Fixed, pre-approved lot catalog for the demo. No generative assets.
 *
 * Categories are chosen to exercise the seeded mandates:
 *  - electronics -> only agent A watches
 *  - art         -> only agent B watches
 *  - collectibles-> BOTH watch -> a genuine bidding war
 *
 * The seller is the single allowlisted address in config/agents.json. The
 * contract pins the seller at the first bid (M2), so this value must match the
 * agents' sellerAllowlist or decide() rejects every bid (SELLER rule).
 */

export const DEMO_SELLER = "0x3333333333333333333333333333333333333333" as const;

/** Fresh on-chain lot range per process so a restart never reuses settled lots. */
const CHAIN_LOT_BASE = Math.floor(Math.random() * 900_000) + 100_000;

export type Lot = {
  id: number; // display index 0..N-1 (stable across restarts)
  chainId: number; // uint256 lotId on-chain — unique per process
  title: string;
  category: "electronics" | "art" | "collectibles";
  seller: string;
  openingMinor: number; // starting ask, in USDC minor units (6 decimals)
  accent: string; // CSS color used by the stage, from the neutral palette
};

const CATALOG = [
  { title: "Vintage Film Camera", category: "electronics", accent: "#3f6fb5" },
  { title: "Mid-Century Poster", category: "art", accent: "#8a6b4f" },
  { title: "First-Edition Comic", category: "collectibles", accent: "#a8453f" },
  { title: "Mechanical Keyboard", category: "electronics", accent: "#4a6b63" },
  { title: "Oil Painting Study", category: "art", accent: "#6b5a8a" },
  { title: "Vintage Coin Set", category: "collectibles", accent: "#8a7a3f" },
] as const;

export const LOTS: readonly Lot[] = CATALOG.map((c, id) => ({
  id,
  chainId: CHAIN_LOT_BASE + id,
  title: c.title,
  category: c.category,
  seller: DEMO_SELLER,
  openingMinor: 100_000,
  accent: c.accent,
}));

/** Short, human-friendly label for a bidder address in the UI. */
export function bidderLabel(address: string): string {
  if (address.toLowerCase() === DEMO_SELLER) return "Seller";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** USDC minor units -> display string (e.g. 350000 -> "0.35"). */
export function formatMinor(minor: number): string {
  return (minor / 1_000_000).toFixed(2);
}
