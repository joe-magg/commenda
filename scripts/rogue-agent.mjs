#!/usr/bin/env node
/**
 * Rogue agent — a red-team demo. Plays a COMPROMISED agent: it holds a real,
 * funded wallet and speaks valid x402, but tries to break its owner's
 * mandate and the auction's rules. Every attempt should be blocked server-side,
 * logged to the decision log, shown on the live stage — and never charged
 * the x402 fee (the server only settles payment on success).
 *
 *   node --env-file=.env.local scripts/rogue-agent.mjs [baseUrl]
 *
 * Reads AGENT_KEYS from env (never printed). Picks a funded agent whose
 * watchlist EXCLUDES the open lot's category, so it has no right to bid.
 */
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const BASE = process.argv[2] ?? process.env.COMMENDA_BASE_URL ?? "http://localhost:3000";
const NETWORK = "eip155:5042002";
const keys = JSON.parse(process.env.AGENT_KEYS ?? "{}");
const roster = JSON.parse(readFileSync(new URL("../config/agents.json", import.meta.url), "utf8"));

const c = { dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", reset: "\x1b[0m" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function paidFetch(key) {
  const account = privateKeyToAccount(key);
  const signer = { address: account.address, signTypedData: (m) => account.signTypedData(m) };
  const id = `bid_${createHash("sha256").update(randomBytes(16)).digest("hex").slice(0, 32)}`;
  const client = new x402Client()
    .register(NETWORK, new ExactEvmScheme(signer))
    .registerExtension({
      key: "payment-identifier",
      enrichPaymentPayload: async (p) => ({
        ...p,
        extensions: { ...(p.extensions ?? {}), "payment-identifier": { info: { required: true, id } } },
      }),
    });
  return wrapFetchWithPayment(fetch, client);
}

async function attempt(key, body) {
  try {
    const res = await paidFetch(key)(`${BASE}/api/bids`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const dto = await res.json().catch(() => ({}));
    const settled = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
    const rule = res.status === 402 ? "PAYMENT_REFUSED" : (dto.rule ?? dto.status ?? "-");
    return { code: res.status, rule, charged: Boolean(settled) };
  } catch (e) {
    return { code: 402, rule: "PAYMENT_REFUSED", charged: false, note: String(e?.message ?? e).slice(0, 60) };
  }
}

async function waitForOpenLot() {
  process.stdout.write(`${c.dim}waiting for an open lot at ${BASE} …${c.reset}`);
  for (;;) {
    const s = await fetch(`${BASE}/api/auction`).then((r) => r.json()).catch(() => null);
    if (s?.acceptingBids && s.lot) { process.stdout.write("\n"); return s; }
    process.stdout.write(".");
    await sleep(1500);
  }
}

const snap = await waitForOpenLot();
const lot = snap.lot;
const rogue = roster.find((a) => keys[a.id] && !a.watchlist.includes(lot.category));
if (!rogue) {
  console.error("no funded agent outside this lot's category — try again on the next lot");
  process.exit(1);
}
const key = keys[rogue.id];
const short = `${rogue.id.slice(0, 6)}…${rogue.id.slice(-4)}`;

console.log(`\n${c.bold}ROGUE AGENT${c.reset}  wallet ${short}  ${c.dim}(funded, valid x402 signer)${c.reset}`);
console.log(`${c.dim}mandate: watchlist [${rogue.watchlist.join(", ")}] · per-bid cap ${(rogue.perBidCapMinor / 1e6).toFixed(2)} USDC${c.reset}`);
console.log(`${c.dim}on the block: "${lot.title}" — ${lot.category} — lot ${lot.chainLotId}${c.reset}\n`);

const honest = { lotId: String(lot.chainLotId), amountMinor: snap.minNextBidMinor };
const attacks = [
  ["Lie about the category to slip past the watchlist", { ...honest, category: rogue.watchlist[0] }],
  ["Redirect the sale proceeds to an attacker seller", { ...honest, seller: privateKeyToAccount(generatePrivateKey()).address }],
  ["Bid on a lot that isn't on the block", { ...honest, lotId: String(lot.chainLotId - 1) }],
  ["Blow through the owner's per-bid cap", { ...honest, amountMinor: 50_000_000 }],
  ["Bid honestly — on a category its owner never allowed", { ...honest }],
];

let blocked = 0;
let charged = 0;
for (const [label, body] of attacks) {
  const r = await attempt(key, { id: `rogue-${Date.now()}-${blocked}`, ...body });
  const ok = r.code >= 400;
  blocked += ok ? 1 : 0;
  charged += r.charged ? 1 : 0;
  console.log(
    `${ok ? c.green + "BLOCKED" : c.yellow + "ALLOWED"}${c.reset}  ${label.padEnd(54)} ` +
    `${c.cyan}${String(r.rule).padEnd(16)}${c.reset} ${c.dim}HTTP ${r.code} · fee ${r.charged ? "CHARGED" : "not charged"}${c.reset}`,
  );
  await sleep(400);
}

// An unknown wallet: valid signature, no funds, no mandate.
const stranger = await attempt(generatePrivateKey(), { id: `stranger-${Date.now()}`, ...honest });
const sOk = stranger.code >= 400;
blocked += sOk ? 1 : 0;
console.log(
  `${sOk ? c.green + "BLOCKED" : c.yellow + "ALLOWED"}${c.reset}  ${"A stranger's wallet with no mandate and no funds".padEnd(54)} ` +
  `${c.cyan}${String(stranger.rule).padEnd(16)}${c.reset} ${c.dim}HTTP ${stranger.code} · fee ${stranger.charged ? "CHARGED" : "not charged"}${c.reset}`,
);

console.log(`\n${c.bold}${blocked}/${attacks.length + 1} blocked · ${charged} fees charged${c.reset} ${c.dim}— see the decision log on /dashboard${c.reset}\n`);
process.exit(blocked === attacks.length + 1 && charged === 0 ? 0 : 1);
