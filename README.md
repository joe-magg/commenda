# commenda

A fully agentic live-stream flash auction. An AI voice auctioneer hosts a loop of
consumer-good lots while delegated bidding agents — each with a wallet, budget,
watchlist and guardrails — bid autonomously and pay a flat per-bid fee via x402.
Outbid funds return immediately. The safety + escrow story *is* the product.

## Run it

```sh
npm install
# set ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, FEE_SELLER_PRIVATE_KEY,
# FEE_RECIPIENT_ADDRESS, AGENT_KEYS, ESCROW_ADDRESS in .env.local (gitignored)
npm run dev
```

Open http://localhost:3000 and click **Enable sound**. The show loops until you
stop it; **Next lot** skips ahead.

## What's in the demo

- **Looping stream** of six lots. Categories are chosen to exercise the mandates:
  electronics attracts one agent, art another, and collectibles produces a
  bidding war.
- **ElevenLabs narration** (`eleven_flash_v2_5`), event-triggered from typed
  templates. No free-form text reaches TTS. Cached MP3s make replays free; a
  hard budget, kill switch and audit ledger cap live generation.
- **Delegated agents** with visible guidelines. Two are live bidders; six are
  kill-switched (no wallet key) and shown as standby.
- **x402 in one place**: `POST /api/bids` verifies a signed payment before the
  handler runs and settles only on a 2xx. Every agent bid genuinely pays.
- **Deterministic guardrails**: `lib/auction/decide.ts` is pure, dependency-free,
  table-tested, and the sole authority on whether a proposed bid becomes an
  on-chain action. "AI recommends, code enforces the max."
- **On-chain escrow** on Arc testnet (`contracts/AuctionEscrow.sol`): per-bid
  lock, immediate outbid refund, seller settlement on SOLD, auction key rotation,
  and a 24-hour emergency refund.

## Decision loop

1. **Watch** — the agent sees the live lot and checks its watchlist. No match, no bid.
2. **Decide** — fixed rules check idempotency, per-bid cap, cumulative budget,
   velocity, circuit breaker, watchlist, seller allowlist and approval threshold.
   Each rejection emits a reason code for the audit log.
3. **Pay** — a signed x402 payment unlocks the bid. Escrow locks it; outbid funds
   are credited back immediately.
4. **Settle** — SOLD pays the seller from the winning bid.

## Layout

- `lib/auction/decide.ts` — pure guardrails and audit receipts.
- `lib/auction/{state,seed,reconcile,submit-bid,inflight,resolver-runner}.ts` —
  single-process mandate store, event-sourced budgets, in-flight resolution.
- `lib/auction/{chain,circle-facilitator,handler,bidder,engine,stream}.ts` — RPC
  adapter, Circle settlement, HTTP handler, x402 bidder client, state machine.
- `lib/voice/*` — templated TTS, spend ledger, cache-first synthesis.
- `app/api/*` — x402-gated bids, SSE readout, manual Next, read-only audio cache.

All state is in memory by design for the demo (documented single-process
assumption); the engine and reconciler survive Next dev hot reloads via
`globalThis`.

## Known tradeoff: escrow refund model

`placeBid` pulls the **full new amount** from the bidder's wallet and refunds the
previous bidder **inside the same transaction**. Two consequences worth being
explicit about:

- On a self-raise (25 → 35), the wallet must hold 35 liquid at that moment; the
  old 25 comes back in the same tx. Net locked is 10, but peak liquidity is 35.
  Delta-funding ("just add 10") would lower that peak but needs per-lot
  committed-balance tracking in the contract.
- An outbid bidder's funds are returned immediately, in the *outbid* transaction,
  so they are free to bid on another lot at once. This is better for capital
  mobility across concurrent auctions than an eBay-style hold-until-settlement.

A pooled-deposit variant is a legitimate future direction for a multi-auction
product. It would require a new escrow version, a re-audit, and a rewrite of
`spentMinor` semantics; it is deliberately out of scope here.

## Products used

Next.js 16, React 19, TypeScript, Tailwind v4, Motion, viem, x402 (EVM + Next),
Circle Facilitator Service on Arc testnet, ElevenLabs TTS, Foundry.

## Verification

`npm run typecheck && npm test && npm run build` must pass. Foundry escrow tests:
`forge test`.
