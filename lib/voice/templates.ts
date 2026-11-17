/**
 * Fixed TTS templates. The ONLY text that may reach ElevenLabs.
 *
 * Audit hardening (L1/L2): lineId is whitelisted, every slot is a runtime-
 * validated safe integer in a bounded range, and all prose is server-owned.
 * A caller can never inject free-form text — not even a lot name: lotIntro
 * takes a numeric lot index and resolves the title from the server catalog.
 * Amounts are passed in USDC MINOR units and formatted here to major units.
 */
import { LOTS } from "@/lib/auction/lots";
import budgetConfig from "@/agent-budget.json";

export type VoiceLineId = "lotIntro" | "bidCall" | "countdown" | "sold";
export const VOICE_LINE_IDS = new Set<string>(["lotIntro", "bidCall", "countdown", "sold"]);

export type RenderedVoice = { lineId: VoiceLineId; text: string; hashInput: string };

const MAX_AMOUNT_MINOR = 100_000_000; // 100 USDC — far above any demo bid

function amountToWords(minor: number): string {
  const major = minor / 1_000_000;
  return Number.isInteger(major) ? major.toFixed(0) : major.toFixed(2);
}

/** Runtime validation of a numeric slot: safe integer within [min,max]. */
function slot(args: Record<string, unknown>, key: string, min: number, max: number): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new Error(`invalid voice slot ${key}`);
  }
  return v;
}

/**
 * Render a whitelisted template with validated numeric args.
 * Throws on any unknown line id, malformed arg, or over-cap text.
 */
export function renderVoice(lineId: unknown, args: unknown): RenderedVoice {
  if (typeof lineId !== "string" || !VOICE_LINE_IDS.has(lineId)) {
    throw new Error("unknown voice line id");
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("voice args must be an object");
  }
  const a = args as Record<string, unknown>;
  let text: string;

  switch (lineId as VoiceLineId) {
    case "lotIntro": {
      const n = slot(a, "n", 1, LOTS.length);
      const lot = LOTS[n - 1];
      text = `Lot ${n}. ${lot.title}. Bidding is open.`;
      break;
    }
    case "bidCall": {
      const amount = slot(a, "amountMinor", 1, MAX_AMOUNT_MINOR);
      text = `${amountToWords(amount)} USDC. Do I hear more?`;
      break;
    }
    case "countdown": {
      const s = slot(a, "s", 1, 60);
      text = `${s} seconds.`;
      break;
    }
    case "sold": {
      const amount = slot(a, "amountMinor", 1, MAX_AMOUNT_MINOR);
      text = `Sold. ${amountToWords(amount)} USDC.`;
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
