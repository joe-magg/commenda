/**
 * TTS synthesis with cache-first, single-flight dedupe and a disk-backed cache.
 *
 * Order matters (audit H1/H2):
 *   1. render + validate (numeric slots only)
 *   2. cache lookup — a hit spends NOTHING and never calls ElevenLabs
 *   3. single-flight map — concurrent identical requests share one generation
 *   4. authorize/reserve, then generate
 * No public HTTP endpoint generates audio; the engine calls speak() directly.
 * app/api/audio/[hash] only serves bytes already in the cache.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import budgetConfig from "@/agent-budget.json";
import { getVoiceBudget, type VoiceReceipt } from "./budget";
import { renderVoice } from "./templates";

const CACHE_DIR = join(process.cwd(), "cache", "voice");
const mem = new Map<string, Buffer>();
const inflight = new Map<string, Promise<VoiceResult>>();

export type VoiceResult = {
  text: string;
  hash: string;
  audioUrl?: string;
  cached: boolean;
  warning?: string;
  receipt: VoiceReceipt;
};

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 20);
}

function diskPath(hash: string): string {
  return join(CACHE_DIR, `${hash}.mp3`);
}

function loadCache(hash: string): Buffer | undefined {
  const hit = mem.get(hash);
  if (hit) return hit;
  const p = diskPath(hash);
  if (!existsSync(p)) return undefined;
  const buf = readFileSync(p);
  mem.set(hash, buf);
  return buf;
}

function saveCache(hash: string, buf: Buffer): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(diskPath(hash), buf);
  mem.set(hash, buf);
}

export function hasCachedAudio(hash: string): boolean {
  return loadCache(hash) !== undefined;
}

export function getCachedAudio(hash: string): Buffer | undefined {
  return loadCache(hash);
}

/** Render + authorize + (maybe) generate. Never throws; returns undefined on invalid input. */
export async function speak(
  lineId: unknown,
  args: unknown,
  lotIndex: number,
): Promise<VoiceResult | undefined> {
  let rendered;
  try {
    rendered = renderVoice(lineId, args);
  } catch (e) {
    console.warn("[commenda:voice] rejected:", e instanceof Error ? e.message : e);
    return undefined;
  }

  const hash = hashText(rendered.text);
  const budget = getVoiceBudget();
  const killSwitch = process.env.VOICE_KILL_SWITCH === "1" || process.env.VOICE_KILL_SWITCH === "true";
  const dryRun = process.env.DRY_RUN === "1";
  const authInput = {
    hash,
    lineId: rendered.lineId,
    lotIndex,
    rawChars: rendered.text.length,
    nowMs: Date.now(),
    killSwitch,
    dryRun,
  };

  // 1. Cache first — replays are free and bypass all caps (audit H1).
  if (loadCache(hash)) {
    budget.recordCacheHit(authInput);
    return { text: rendered.text, hash, audioUrl: `/api/audio/${hash}`, cached: true, receipt: budget.snapshot().receipts.at(-1)! };
  }

  // 2. Single-flight — identical in-flight requests share one spend (audit H2).
  const existing = inflight.get(hash);
  if (existing) return existing;

  const task = (async (): Promise<VoiceResult> => {
    // Re-check cache inside the critical path (another call may have just finished).
    const raced = loadCache(hash);
    if (raced) {
      budget.recordCacheHit(authInput);
      return { text: rendered.text, hash, audioUrl: `/api/audio/${hash}`, cached: true, receipt: budget.snapshot().receipts.at(-1)! };
    }

    const receipt = budget.authorize(authInput);
    if (!receipt.generate) {
      return {
        text: rendered.text,
        hash,
        cached: false,
        warning: receipt.rule === "DRY_RUN" ? "DRY_RUN" : `VOICE_${receipt.rule}`,
        receipt,
      };
    }

    const key = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    if (!key || !voiceId) {
      budget.noteFailure();
      return { text: rendered.text, hash, cached: false, warning: "VOICE_NOT_CONFIGURED", receipt };
    }

    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": key,
            "content-type": "application/json",
            accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text: rendered.text,
            model_id: budgetConfig.model,
            output_format: budgetConfig.outputFormat,
            voice_settings: { stability: 0.4, similarity_boost: 0.8 },
            apply_text_normalization: budgetConfig.applyTextNormalization ? "on" : "off",
          }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength === 0) throw new Error("empty audio response");
      saveCache(hash, buf);
      budget.noteSuccess();

      // If ElevenLabs reports billed chars above our conservative reserve, log it.
      const billedHeader = res.headers.get("x-character-count");
      const billed = billedHeader ? Number(billedHeader) : NaN;
      if (Number.isFinite(billed) && billed > receipt.reservedCredits) {
        console.warn("[commenda:voice] billed chars exceeded reserve", { hash, billed, reserved: receipt.reservedCredits });
      }
      return { text: rendered.text, hash, audioUrl: `/api/audio/${hash}`, cached: false, receipt };
    } catch (e) {
      budget.noteFailure();
      console.warn("[commenda:voice] generation failed:", e instanceof Error ? e.message : e);
      return { text: rendered.text, hash, cached: false, warning: "VOICE_GENERATION_FAILED", receipt };
    }
  })().finally(() => inflight.delete(hash));

  inflight.set(hash, task);
  return task;
}

/** Diagnostic id so two concurrent callers can observe they shared one generation. */
export const voiceRuntimeId = randomUUID();
