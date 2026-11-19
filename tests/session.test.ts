import { describe, it, expect } from "vitest";
import { signSession, verifySession, issueChallenge, consumeChallenge, CHALLENGE_TTL_MS, SESSION_TTL_MS } from "../lib/session";

const key = Buffer.from("k".repeat(32));
const other = Buffer.from("x".repeat(32));

describe("session tokens", () => {
  it("round-trips a user id", () => {
    expect(verifySession(signSession("wallet_0xabc", 1_000, key), 2_000, key)).toBe("wallet_0xabc");
  });

  it("rejects the old forgeable format: a bare user id", () => {
    expect(verifySession("demo-user-ava", 2_000, key)).toBeNull();
  });

  it("rejects an edited user id, a foreign key, and an expired token", () => {
    const t = signSession("demo-user-ava", 1_000, key);
    const [, exp, sig] = t.split(".");
    const forged = `${Buffer.from("demo-user-bao").toString("base64url")}.${exp}.${sig}`;
    expect(verifySession(forged, 2_000, key)).toBeNull();
    expect(verifySession(t, 2_000, other)).toBeNull();
    expect(verifySession(t, 1_000 + SESSION_TTL_MS + 1, key)).toBeNull();
    expect(verifySession(undefined, 2_000, key)).toBeNull();
    expect(verifySession("a.b", 2_000, key)).toBeNull();
  });
});

describe("sign-in challenges", () => {
  const T = 1_800_000_000_000;
  it("are single-use", () => {
    const { nonce, message } = issueChallenge(T, key);
    expect(message).toContain(nonce);
    expect(consumeChallenge(nonce, T + 1_000, key)).toBe(true);
    expect(consumeChallenge(nonce, T + 2_000, key)).toBe(false); // replay
  });

  it("survive a restart (stateless issue) but not a different server key", () => {
    const { nonce } = issueChallenge(T, key);
    expect(consumeChallenge(nonce, T + 1_000, other)).toBe(false);
    const fresh = issueChallenge(T, key).nonce;
    expect(consumeChallenge(fresh, T + 1_000, key)).toBe(true);
  });

  it("expire, and reject forged, malformed or unknown nonces", () => {
    const { nonce } = issueChallenge(T, key);
    expect(consumeChallenge(nonce, T + CHALLENGE_TTL_MS + 1, key)).toBe(false);
    const [exp, rnd] = nonce.split(".");
    expect(consumeChallenge(`${Number(exp) + 999999}.${rnd}.${nonce.split(".")[2]}`, T, key)).toBe(false);
    expect(consumeChallenge("not-a-nonce", T, key)).toBe(false);
    expect(consumeChallenge(42, T, key)).toBe(false);
  });
});
