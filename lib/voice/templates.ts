/**
 * Fixed auctioneer templates. The ONLY text that may reach ElevenLabs.
 *
 * Audit hardening (L1/L2), kept: lineId is whitelisted, every numeric slot is
 * a runtime-validated safe integer in a bounded range, and all prose is
 * server-owned. Two server-side context values may be woven in:
 *   - the lot's title — from our own catalog (config/catalog.json)
 *     grammar (lib/items/generator.ts), and still filtered to a strict
 *     character allowlist here;
 *   - the bidder's display label — dashboard-editable, so it must match a
 *     tight name pattern or it is replaced by "our bidder".
 * Amounts are passed in USDC MINOR units and formatted here to major units.
 */
import budgetConfig from "@/agent-budget.json";
import { minNextBid } from "@/lib/agents/strategy";
import type { Lot } from "@/lib/auction/lots";

export type VoiceLineId = "lotIntro" | "bidCall" | "lateBid" | "countdown" | "sold" | "unsold";
export const VOICE_LINE_IDS = new Set<string>(["lotIntro", "bidCall", "lateBid", "countdown", "sold", "unsold"]);

export type VoiceContext = { lot?: Lot | null; bidderLabel?: string | null; sessionName?: string | null };
export type RenderedVoice = { lineId: VoiceLineId; text: string; hashInput: string };

const MAX_AMOUNT_MINOR = 100_000_000; // 100 USDC — far above any demo bid

/**
 * Spoken amount — no currency word, since USDC is already on screen.
 *   < 1 USDC   -> "35 cents"
 *   whole USDC -> "2 dollars"
 *   x.50       -> "1 dollar 50"
 */
export function speakAmount(minor: number): string {
  const cents = Math.round(minor / 10_000); // 1 USDC = 100 cents = 1,000,000 minor
  if (cents < 100) return `${cents} cents`;
  const dollars = Math.floor(cents / 100);
  const remainder = cents % 100;
  if (remainder === 0) return `${dollars} dollar${dollars === 1 ? "" : "s"}`;
  // "2 dollars 5" would sound like 2.50 — single-digit cents get spelled out.
  if (remainder < 10) return `${dollars} dollar${dollars === 1 ? "" : "s"} and ${remainder} cent${remainder === 1 ? "" : "s"}`;
  return `${dollars} dollar${dollars === 1 ? "" : "s"} ${remainder}`;
}

/** Runtime validation of a numeric slot: safe integer within [min,max]. */
function slot(args: Record<string, unknown>, key: string, min: number, max: number): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new Error(`invalid voice slot ${key}`);
  }
  return v;
}

/** Strict allowlist for catalog prose: letters, digits, spaces, a little punctuation. */
export function safeProse(s: unknown, max: number): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (t.length === 0 || t.length > max || !/^[A-Za-z0-9 ,'-]+$/.test(t)) return null;
  return t;
}

/** A bidder name the auctioneer may say aloud, or the neutral fallback. */
export function safeName(s: unknown): string {
  return typeof s === "string" && /^[A-Za-z][A-Za-z0-9 '-]{0,23}$/.test(s.trim()) ? s.trim() : "our bidder";
}

/** Deterministic variety: same inputs, same line (cache-friendly), no RNG. */
function vary<T>(options: readonly T[], seed: number): T {
  return options[Math.abs(seed) % options.length];
}

/**
 * Render a whitelisted template with validated numeric args and filtered
 * server context. Throws on any unknown line id, malformed arg, or over-cap text.
 */
export function renderVoice(lineId: unknown, args: unknown, ctx: VoiceContext = {}): RenderedVoice {
  if (typeof lineId !== "string" || !VOICE_LINE_IDS.has(lineId)) {
    throw new Error("unknown voice line id");
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("voice args must be an object");
  }
  const a = args as Record<string, unknown>;
  const name = safeName(ctx.bidderLabel);
  let text: string;

  switch (lineId as VoiceLineId) {
    case "lotIntro": {
      const n = slot(a, "n", 1, 99);
      const title = safeProse(ctx.lot?.title, 60);
      const open = typeof a.amountMinor === "number" ? slot(a, "amountMinor", 1, MAX_AMOUNT_MINOR) : null;
      if (!title) {
        text = `Lot ${n}. Bidding is open.`;
        break;
      }
      text = `Lot ${n}. ${title}.${open ? ` We open at ${speakAmount(open)}.` : ""}`;
      break;
    }
    case "bidCall": {
      const amount = slot(a, "amountMinor", 1, MAX_AMOUNT_MINOR);
      const next = speakAmount(minNextBid(amount, 0));
      const amt = speakAmount(amount);
      text = vary([
        `${amt}, from ${name}! Do I hear ${next}?`,
        `${name} bids ${amt}. Who'll give me ${next}?`,
        `${amt}! ${name} has it. ${next}, anywhere?`,
      ], amount / 10_000 + name.length);
      break;
    }
    case "lateBid": {
      const amount = slot(a, "amountMinor", 1, MAX_AMOUNT_MINOR);
      text = `A late bid! ${name}, ${speakAmount(amount)}. We go again!`;
      break;
    }
    case "countdown": {
      slot(a, "s", 1, 60);
      // Plain full stops: ellipses make the TTS trail off with artifacts.
      text = "Going once. Going twice.";
      break;
    }
    case "sold": {
      const amount = slot(a, "amountMinor", 1, MAX_AMOUNT_MINOR);
      text = `Sold! To ${name}, for ${speakAmount(amount)}.`;
      break;
    }
    case "unsold": {
      text = "No bids. The lot passes.";
      break;
    }
    default:
      throw new Error("unreachable voice line");
  }

  if (text.length > budgetConfig.maxCharsPerRequest) {
    throw new Error("rendered voice text exceeds char cap");
  }
  return { lineId: lineId as VoiceLineId, text, hashInput: text };
}
