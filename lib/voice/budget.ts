/**
 * Voice spend ledger. Pure decision logic + a small in-memory state object.
 *
 * Audit fixes applied:
 *  - kill switch is a per-request runtime control (env), precedence over DRY_RUN
 *  - DRY_RUN never reserves; cache hits never reserve (see synth.ts)
 *  - conservative billed-char metering (normalization expands billed text)
 *  - consecutive-failure circuit breaker
 *  - a full audit receipt is produced for EVERY decision
 */
import budgetConfig from "@/agent-budget.json";

export type VoiceRule =
  | "ALLOW" | "CACHE_HIT" | "DRY_RUN"
  | "KILL_SWITCH" | "SESSION_CEILING" | "GENERATIONS_PER_LOT"
  | "VELOCITY" | "CIRCUIT_BREAKER";

export type VoiceReceipt = {
  rule: VoiceRule;
  allow: boolean;
  generate: boolean;
  at: string;
  lineId: string;
  lotIndex: number;
  hash: string;
  rawChars: number;
  reservedCredits: number;
  charsBefore: number;
  charsAfter: number;
  generationsThisLot: number;
  requestsInWindow: number;
  consecutiveFailures: number;
  killSwitch: boolean;
  dryRun: boolean;
  detail: string;
};

export type AuthorizeInput = {
  hash: string;
  lineId: string;
  lotIndex: number;
  rawChars: number;
  nowMs: number;
  killSwitch: boolean;
  dryRun: boolean;
};

export class VoiceBudget {
  private charsUsed = 0;
  private generationsByLot = new Map<number, number>();
  private requestTimes: number[] = [];
  private consecutiveFailures = 0;
  private readonly receipts: VoiceReceipt[] = [];

  /** Evaluate a generation request BEFORE any network call. Pure w.r.t. spend. */
  authorize(input: AuthorizeInput): VoiceReceipt {
    const reserved = input.rawChars * budgetConfig.billedCharsPerRawChar;
    const gen = this.generationsByLot.get(input.lotIndex) ?? 0;
    const inWindow = this.requestTimes.filter((t) => input.nowMs - t < 60_000);
    const base = {
      at: new Date(input.nowMs).toISOString(),
      lineId: input.lineId,
      lotIndex: input.lotIndex,
      hash: input.hash,
      rawChars: input.rawChars,
      reservedCredits: reserved,
      charsBefore: this.charsUsed,
      generationsThisLot: gen,
      requestsInWindow: inWindow.length,
      consecutiveFailures: this.consecutiveFailures,
      killSwitch: input.killSwitch,
      dryRun: input.dryRun,
    };
    const deny = (rule: VoiceRule, detail: string): VoiceReceipt => {
      const r = { ...base, rule, allow: false, generate: false, charsAfter: this.charsUsed, detail };
      this.record(r);
      return r;
    };

    if (input.killSwitch) return deny("KILL_SWITCH", "voice kill switch engaged");
    if (this.consecutiveFailures >= budgetConfig.maxConsecutiveFailures) {
      return deny("CIRCUIT_BREAKER", "too many consecutive TTS failures");
    }
    if (inWindow.length >= budgetConfig.maxRequestsPerMinute) {
      return deny("VELOCITY", "request window full");
    }
    if (gen >= budgetConfig.maxGenerationsPerLot) {
      return deny("GENERATIONS_PER_LOT", "lot generation cap reached");
    }
    if (this.charsUsed + reserved > budgetConfig.maxCreditsPerSession) {
      return deny("SESSION_CEILING", "session character ceiling reached");
    }

    // DRY_RUN: allowed to exercise the full path, but never reserves or generates.
    if (input.dryRun) {
      const r: VoiceReceipt = { ...base, rule: "DRY_RUN", allow: true, generate: false, charsAfter: this.charsUsed, detail: "dry run — no call, no spend" };
      this.record(r);
      return r;
    }

    // ALLOW — reserve conservatively before the network call.
    this.charsUsed += reserved;
    this.generationsByLot.set(input.lotIndex, gen + 1);
    this.requestTimes = [...inWindow, input.nowMs];
    const r: VoiceReceipt = { ...base, rule: "ALLOW", allow: true, generate: true, charsAfter: this.charsUsed, detail: "reserved before generation" };
    this.record(r);
    return r;
  }

  noteSuccess(): void {
    this.consecutiveFailures = 0;
  }

  noteFailure(): void {
    this.consecutiveFailures++;
  }

  private record(r: VoiceReceipt): void {
    this.receipts.push(r);
    if (this.receipts.length > 200) this.receipts.shift();
    console.info("[commenda:voice]", JSON.stringify(r));
  }

  /** Cached replays are recorded but never spend. */
  recordCacheHit(input: AuthorizeInput): void {
    const r: VoiceReceipt = {
      at: new Date(input.nowMs).toISOString(),
      lineId: input.lineId,
      lotIndex: input.lotIndex,
      hash: input.hash,
      rawChars: input.rawChars,
      reservedCredits: 0,
      charsBefore: this.charsUsed,
      charsAfter: this.charsUsed,
      generationsThisLot: this.generationsByLot.get(input.lotIndex) ?? 0,
      requestsInWindow: this.requestTimes.filter((t) => input.nowMs - t < 60_000).length,
      consecutiveFailures: this.consecutiveFailures,
      killSwitch: input.killSwitch,
      dryRun: input.dryRun,
      rule: "CACHE_HIT",
      allow: true,
      generate: false,
      detail: "cache hit — zero live credits",
    };
    this.record(r);
  }

  snapshot(): { charsUsed: number; receipts: readonly VoiceReceipt[] } {
    return { charsUsed: this.charsUsed, receipts: [...this.receipts] };
  }
}

const g = globalThis as typeof globalThis & { __commendaVoiceBudget?: VoiceBudget };
export function getVoiceBudget(): VoiceBudget {
  if (!g.__commendaVoiceBudget) g.__commendaVoiceBudget = new VoiceBudget();
  return g.__commendaVoiceBudget;
}
