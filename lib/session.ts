/**
 * Session tokens and sign-in challenges. Pure crypto, no framework imports,
 * so it is unit-testable.
 *
 * - Session cookie = `<base64url(userId)>.<expiryMs>.<hmac>`; HMAC-SHA256 over
 *   the first two parts with SESSION_SECRET. A forged or edited cookie fails
 *   verification (constant-time compare). Previously the cookie WAS the user
 *   id, so anyone could set `commenda_user=<id>` and be that user.
 * - Sign-in challenge = a server-issued, single-use nonce with a short TTL,
 *   embedded in the message the wallet signs. A captured signature can't be
 *   replayed (the old message was a fixed string, valid forever).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const g = globalThis as typeof globalThis & {
  __commendaSessionSecret?: Buffer;
  __commendaChallenges?: Map<string, number>;
};

/** SESSION_SECRET (≥ 32 chars) or, if unset, a per-process random key —
 *  sessions then reset on restart, which is safe, just inconvenient. */
export function sessionSecret(): Buffer {
  const env = process.env.SESSION_SECRET;
  if (env && env.length >= 32) return Buffer.from(env, "utf8");
  if (!g.__commendaSessionSecret) {
    g.__commendaSessionSecret = randomBytes(32);
    console.warn("[commenda:auth] SESSION_SECRET unset — using a per-process key (sessions reset on restart)");
  }
  return g.__commendaSessionSecret;
}

const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url").toString("utf8");
const mac = (body: string, key: Buffer) => createHmac("sha256", key).update(body).digest("base64url");

export function signSession(userId: string, nowMs = Date.now(), key = sessionSecret()): string {
  const body = `${b64u(userId)}.${nowMs + SESSION_TTL_MS}`;
  return `${body}.${mac(body, key)}`;
}

/** The user id inside a valid, unexpired token — or null. Never throws. */
export function verifySession(token: string | undefined, nowMs = Date.now(), key = sessionSecret()): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  const expected = Buffer.from(mac(`${uid}.${exp}`, key));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const expiry = Number(exp);
  if (!Number.isSafeInteger(expiry) || expiry <= nowMs) return null;
  try {
    const id = unb64u(uid);
    return id.length > 0 && id.length <= 200 ? id : null;
  } catch {
    return null;
  }
}

/** The exact text the wallet signs. The nonce makes every signature single-use. */
export function challengeMessage(nonce: string): string {
  return `Sign in to Commenda.\n\nFree signature, no transaction.\nNonce: ${nonce}`;
}

function used(): Map<string, number> {
  if (!g.__commendaChallenges) g.__commendaChallenges = new Map();
  return g.__commendaChallenges;
}

/**
 * A self-verifying challenge: `<expiryMs>.<random>.<hmac>`. Stateless to
 * issue, so a server restart between "get challenge" and "submit signature"
 * no longer fails sign-in; replay is blocked by a used-nonce set, and a
 * nonce is only ever valid for CHALLENGE_TTL_MS.
 */
export function issueChallenge(nowMs = Date.now(), key = sessionSecret()): { nonce: string; message: string } {
  const body = `${nowMs + CHALLENGE_TTL_MS}.${randomBytes(12).toString("hex")}`;
  const nonce = `${body}.${mac(body, key).slice(0, 22)}`;
  return { nonce, message: challengeMessage(nonce) };
}

/** Consume a nonce: true exactly once, only if it is ours and unexpired. */
export function consumeChallenge(nonce: unknown, nowMs = Date.now(), key = sessionSecret()): boolean {
  if (typeof nonce !== "string" || !/^\d{13}\.[a-f0-9]{24}\.[A-Za-z0-9_-]{22}$/.test(nonce)) return false;
  const [exp, rnd, sig] = nonce.split(".");
  const expected = Buffer.from(mac(`${exp}.${rnd}`, key).slice(0, 22));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  const expiry = Number(exp);
  if (expiry <= nowMs) return false;
  const store = used();
  for (const [n, e] of store) if (e <= nowMs) store.delete(n); // sweep expired
  if (store.has(nonce)) return false; // replay
  store.set(nonce, expiry);
  return true;
}
