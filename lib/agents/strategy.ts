/**
 * Deterministic bidding strategies — the agents' "minds". Pure, no I/O, no
 * LLM: the same item, market and agent always produce the same decision, so
 * every bid an agent makes is reproducible and explainable after the fact.
 *
 * Each agent holds a PRIVATE valuation per item (derived from its persona,
 * its owner's per-bid cap and its category affinity)
 * and a persona that decides HOW it bids toward that valuation. The auction
 * floor asks every agent each round; an agent either raises, waits, or drops
 * out. decide() still gates every proposal — a strategy can only propose.
 */

export type Persona = "steady" | "jumper" | "sniper" | "bargain" | "collector";

export const PERSONAS: readonly Persona[] = ["steady", "jumper", "sniper", "bargain", "collector"];

export const PERSONA_BLURB: Record<Persona, string> = {
  steady: "Raises by the minimum until its limit",
  jumper: "Opens with jump bids to scare off the field",
  sniper: "Waits silently, strikes in the final seconds",
  bargain: "Only bids while the price is a steal",
  collector: "Pays up for its favourite category",
};

export type AgentProfile = {
  id: string;
  persona: Persona;
  perBidCapMinor: number;
  /** First entry is the agent's favourite category. */
  watchlist: readonly string[];
};

export type ItemFacts = {
  sku: string;
  category: string;
  openingMinor: number;
};

export type Market = {
  /** Highest receipt-confirmed bid, or null when the lot has no bids yet. */
  highestMinor: number | null;
  openingMinor: number;
  leaderId: string | null;
  phase: "bidding" | "countdown";
  /** Seconds left on the countdown clock (countdown phase only). */
  secondsLeft: number | null;
  bidCount: number;
};

export type Intent =
  | { act: "bid"; amountMinor: number; why: string }
  | { act: "wait"; why: string }
  | { act: "drop"; why: string };

/** Auction-house bid steps, in USDC minor units (6 decimals):
 *  0.10 under 1 USDC, 0.25 under 5, 0.50 above. */
export function minIncrement(currentMinor: number): number {
  if (currentMinor < 1_000_000) return 100_000;
  if (currentMinor < 5_000_000) return 250_000;
  return 500_000;
}

/** The smallest bid the floor will accept next (escrow requires strictly higher). */
export function minNextBid(highestMinor: number | null, openingMinor: number): number {
  return highestMinor === null ? openingMinor : highestMinor + minIncrement(highestMinor);
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // murmur3 finalizer — spreads similar inputs apart
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The agent's private valuation of an item, in minor units, floored to the
 * cent and never above its owner's per-bid cap. Deterministic per
 * (agent, item): rerunning the same auction reproduces the same limits.
 */
export function valuation(profile: AgentProfile, item: ItemFacts): number {
  const r = hash32(`${profile.id.toLowerCase()}|${item.sku}`) / 0xffffffff; // [0,1]
  let v = profile.perBidCapMinor * (0.55 + 0.45 * r);
  const favourite = profile.watchlist[0] === item.category;
  if (!favourite) v *= 0.8;
  if (profile.persona === "collector" && favourite) v *= 1.25;
  const capped = Math.min(v, profile.perBidCapMinor);
  return Math.max(0, Math.floor(capped / 10_000) * 10_000);
}

/** The highest price this persona will actually pay given its valuation. */
export function walkAwayPrice(persona: Persona, value: number): number {
  if (persona === "bargain") return Math.floor((value * 0.7) / 10_000) * 10_000;
  return value;
}

/** What this agent wants to do right now. Pure. */
export function intent(profile: AgentProfile, value: number, m: Market): Intent {
  if (m.leaderId !== null && m.leaderId.toLowerCase() === profile.id.toLowerCase()) {
    return { act: "wait", why: "already leading" };
  }
  const limit = walkAwayPrice(profile.persona, value);
  const next = minNextBid(m.highestMinor, m.openingMinor);
  if (next > limit) return { act: "drop", why: "price passed its limit" };

  switch (profile.persona) {
    case "sniper": {
      // Silent until the hammer is about to fall.
      if (m.phase !== "countdown" || m.secondsLeft === null || m.secondsLeft > 4) {
        return { act: "wait", why: "waiting for the final seconds" };
      }
      const strike = Math.min(limit, next + minIncrement(next));
      return { act: "bid", amountMinor: strike, why: "late strike" };
    }
    case "jumper": {
      // Early jump bids signal strength; later it raises like everyone else.
      if (m.bidCount < 3) {
        const jump = next + 2 * minIncrement(next);
        if (jump <= limit) return { act: "bid", amountMinor: jump, why: "jump bid" };
      }
      return { act: "bid", amountMinor: next, why: "minimum raise" };
    }
    default:
      return { act: "bid", amountMinor: next, why: "minimum raise" };
  }
}

/**
 * The floor recognises one hand per round. Highest proposal wins the round;
 * ties break by a per-round hash so the same agent doesn't always react
 * first — deterministic, but not a fixed rotation.
 */
export function pickRound<T extends { id: string; amountMinor: number }>(
  proposals: readonly T[],
  roundKey: string,
): T | null {
  if (proposals.length === 0) return null;
  return [...proposals].sort((a, b) =>
    b.amountMinor - a.amountMinor ||
    hash32(`${roundKey}|${a.id}`) - hash32(`${roundKey}|${b.id}`),
  )[0];
}
