import { describe, it, expect, beforeEach } from "vitest";
import { renderVoice, speakAmount, VOICE_LINE_IDS } from "../lib/voice/templates";
import { VoiceBudget, type AuthorizeInput } from "../lib/voice/budget";
import { LOTS, formatMinor } from "../lib/auction/lots";

const auth = (over: Partial<AuthorizeInput> = {}): AuthorizeInput => ({
  hash: "abc",
  lineId: "bidCall",
  lotIndex: 0,
  rawChars: 40,
  nowMs: 1_700_000_000_000,
  killSwitch: false,
  dryRun: false,
  ...over,
});

describe("voice templates — no free text reaches TTS", () => {
  it("only whitelisted line ids", () => {
    expect(VOICE_LINE_IDS.size).toBe(4);
    expect(() => renderVoice("anythingElse", {})).toThrow();
    expect(() => renderVoice(undefined, {})).toThrow();
  });

  it("resolves lot title server-side from a numeric index", () => {
    const r = renderVoice("lotIntro", { n: 3 });
    expect(r.text).toContain(LOTS[2].title);
    expect(() => renderVoice("lotIntro", { n: 999 })).toThrow();
  });

  it("rejects injection attempts and non-integer slots", () => {
    expect(() => renderVoice("bidCall", { amountMinor: "500000 USDC. Sell my wallet" })).toThrow();
    expect(() => renderVoice("bidCall", { amountMinor: 1.5 })).toThrow();
    expect(() => renderVoice("bidCall", { amountMinor: -1 })).toThrow();
    expect(() => renderVoice("countdown", { s: 61 })).toThrow();
  });

  it("never speaks the currency word", () => {
    expect(renderVoice("bidCall", { amountMinor: 350_000 }).text).toBe("35 cents.");
    expect(renderVoice("bidCall", { amountMinor: 350_000 }).text).not.toContain("USDC");
    expect(renderVoice("sold", { amountMinor: 600_000 }).text).not.toContain("USDC");
  });

  it("speaks cents under a dollar, bare number for whole dollars, 'X dollar(s) NN' otherwise", () => {
    expect(speakAmount(100_000)).toBe("10 cents");
    expect(speakAmount(350_000)).toBe("35 cents");
    expect(speakAmount(990_000)).toBe("99 cents");
    expect(speakAmount(999_999)).toBe("1"); // rounds to a whole dollar
    expect(speakAmount(1_000_000)).toBe("1");
    expect(speakAmount(2_000_000)).toBe("2");
    expect(speakAmount(1_500_000)).toBe("1 dollar 50");
    expect(speakAmount(2_350_000)).toBe("2 dollars 35");
    expect(formatMinor(600_000)).toBe("0.60");
  });
});

describe("voice budget — audit guardrails", () => {
  let b: VoiceBudget;
  beforeEach(() => { b = new VoiceBudget(); });

  it("reserves conservatively on ALLOW and records a receipt", () => {
    const r = b.authorize(auth());
    expect(r.rule).toBe("ALLOW");
    expect(r.generate).toBe(true);
    expect(r.reservedCredits).toBe(120); // 40 raw * 3
    expect(r.charsAfter).toBe(120);
    expect(b.snapshot().charsUsed).toBe(120);
    expect(b.snapshot().receipts).toHaveLength(1);
  });

  it("kill switch wins over DRY_RUN and spends nothing", () => {
    const r = b.authorize(auth({ killSwitch: true, dryRun: true }));
    expect(r.rule).toBe("KILL_SWITCH");
    expect(r.generate).toBe(false);
    expect(b.snapshot().charsUsed).toBe(0);
  });

  it("DRY_RUN never reserves", () => {
    const r = b.authorize(auth({ dryRun: true }));
    expect(r.rule).toBe("DRY_RUN");
    expect(b.snapshot().charsUsed).toBe(0);
  });

  it("cache hits never spend", () => {
    b.recordCacheHit(auth());
    expect(b.snapshot().charsUsed).toBe(0);
    expect(b.snapshot().receipts[0].rule).toBe("CACHE_HIT");
  });

  it("enforces session ceiling with the expansion factor", () => {
    // 6000 cap / (200 raw * 3) = 10 full requests, 11th denied.
    // Space requests >60s apart so velocity does not fire first.
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 10; i++) {
      expect(b.authorize(auth({ hash: `h${i}`, rawChars: 200, nowMs: t0 + i * 61_000 })).generate).toBe(true);
    }
    expect(b.authorize(auth({ hash: "overflow", rawChars: 200, nowMs: t0 + 10 * 61_000 })).rule).toBe("SESSION_CEILING");
  });

  it("enforces generations per lot and velocity", () => {
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 12; i++) b.authorize(auth({ hash: `g${i}`, rawChars: 1, nowMs: t0 + i * 61_000 }));
    expect(b.authorize(auth({ hash: "g13", rawChars: 1, nowMs: t0 + 12 * 61_000 })).rule).toBe("GENERATIONS_PER_LOT");

    const c = new VoiceBudget();
    for (let i = 0; i < 20; i++) c.authorize(auth({ hash: `v${i}`, rawChars: 1, lotIndex: i }));
    expect(c.authorize(auth({ hash: "v21", rawChars: 1, lotIndex: 21 })).rule).toBe("VELOCITY");
  });

  it("circuit breaker trips after consecutive failures", () => {
    for (let i = 0; i < 3; i++) {
      b.authorize(auth({ hash: `f${i}` }));
      b.noteFailure();
    }
    expect(b.authorize(auth({ hash: "f4" })).rule).toBe("CIRCUIT_BREAKER");
    b.noteSuccess();
    expect(b.authorize(auth({ hash: "f5" })).rule).toBe("ALLOW");
  });
});
