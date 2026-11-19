# commenda

A live-stream flash auction run entirely by agents. An ElevenLabs auctioneer calls
the floor; eight bidding agents — each with its own wallet, owner-set budget and
guardrails, private valuations and a bidding persona — decide for themselves when to
raise, when to wait and when to walk away, and pay for every bid over x402 on Arc.
No model ever touches money: agents propose, deterministic code decides, and the
escrow is the truth.

## Run it

```sh
npm install
# set ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, FEE_SELLER_PRIVATE_KEY,
# FEE_RECIPIENT_ADDRESS, AGENT_KEYS (all eight agents), ESCROW_ADDRESS,
# and RECEIPT_NFT_ADDRESS in .env.local (gitignored)
npm run dev
```

Open http://localhost:3000/live. Auctions run on a schedule (`AUCTION_START_DELAY_MS`,
`AUCTION_GAP_MINUTES`, `AUCTION_ITEMS`); between auctions the dock's ⏭ starts the next
one immediately (signed-in). Sound is on by default. Sign in at `/` with an injected
wallet. For a recording: `AUCTION_START_DELAY_MS=8000 AUCTION_GAP_MINUTES=0.5 AUCTION_ITEMS=2 npm run dev`.

**Red-team demo** — while a lot is open, run a compromised agent against the floor:

```sh
node --env-file=.env.local scripts/rogue-agent.mjs
```

It holds a real funded wallet and valid x402 signatures, and tries to lie about the
lot's category, redirect the proceeds, bid on a closed lot, blow its owner's cap and
bid outside its mandate. Every attempt is blocked, logged, flashed on the stage — and
never charged the fee.

## What's in the demo

- **Scheduled auctions** of generated lots, published before they run. Each lot is
  a genuine English auction with a soft close: a bid during "going once… going
  twice…" reopens the lot.
- **Autonomous, deterministic agents** (`lib/agents/strategy.ts`). Each agent
  derives a private valuation per item (owner's per-bid cap × category affinity ×
  condition) and bids through a persona — *steady*, *jumper* (jump bids to scare off
  the field), *sniper* (silent until the final seconds), *bargain*, *collector*. No
  LLM, no randomness: every decision is reproducible and explainable. The floor
  recognises one hand per round, like a real auctioneer.
- **ElevenLabs auctioneer** (`eleven_flash_v2_5`): introduces each lot, calls
  every bid by name ("1 dollar 25, from Agent B! Do I hear 1 dollar 50?"), calls
  the late strike and the hammer — with on-screen captions. Only server-owned text
  reaches TTS (whitelisted templates, strict allowlists on catalog prose and
  names); cached MP3s make replays free; a budget, kill switch and ledger cap spend.
- **x402 in one place**: `POST /api/bids` verifies a signed payment before the
  handler runs and settles only on a 2xx. Every agent bid genuinely pays a flat fee.
  The agent states only *which lot* and *how much*; the server binds the bid to the
  lot actually on the block and supplies its category and seller itself, so the
  guardrails check facts, not the agent's claims (`LOT_MISMATCH`, `LOT_CLOSED`).
- **Deterministic guardrails**: `lib/auction/decide.ts` is pure, dependency-free,
  table-tested, and the sole authority on whether a proposed bid becomes an
  on-chain action. "AI recommends, code enforces the max."
- **On-chain escrow** on Arc testnet (`contracts/AuctionEscrow.sol`): per-bid
  lock, immediate outbid refund, seller settlement on SOLD, auction key rotation,
  and a 24-hour emergency refund.
- **Soulbound receipts** (`contracts/ReceiptNFT.sol`): each SOLD mints a
  non-transferable receipt with on-chain SVG metadata to the winner; the vault
  shows them as holo cards.
- **SQLite persistence** (`node:sqlite`) for users, agents, policies, sessions,
  claims and an audit trail; no external database.

## Decision loop

1. **Watch** — the agent reads the floor (`GET /api/auction`): lot, facts, highest
   bid, minimum valid raise, clock.
2. **Choose** — its strategy compares the price to its private valuation: raise,
   wait (snipers), or drop out.
3. **Authorize** — `decide()` checks the floor binding, kill switch, idempotency,
   self-outbid, per-bid cap, budget, velocity, circuit breaker, watchlist, seller
   allowlist and approval threshold. Rejections cost nothing.
4. **Pay** — a signed x402 payment (with a stable identifier) unlocks the bid.
   Escrow locks it; the outbid bidder is refunded in the same transaction.
5. **Settle** — the hammer settles from escrow state (the chain names the winner),
   issues a claim and mints a soulbound receipt. A crash mid-lot is recovered on
   the next boot from the `open_lots` ledger.

## Agent API (bring your own agent)

- `GET /api/auction` — public floor snapshot: `lot`, `acceptingBids`,
  `highestBidMinor`, `minNextBidMinor`, `endsInMs`, `nextAuctionInMs`.
- `POST /api/bids` — x402 ($0.001 USDC on Arc, `payment-identifier` required) with
  `{ id, lotId, amountMinor }`. Responses: `placed` (receipt-confirmed),
  `rejected` + rule, `busy` + `retryAfterMs`. Only `placed` is charged.

## Layout

- `lib/agents/strategy.ts` — personas, private valuations, market rules (pure).
- `lib/auction/decide.ts` — pure guardrails and audit receipts.
- `lib/auction/{settlement,scheduler}.ts` — chain-truth settlement and recovery; sessions.
- `scripts/rogue-agent.mjs` — red-team agent for the guardrail demo.
- `lib/auction/{state,seed,reconcile,submit-bid,inflight,resolver-runner}.ts` —
  single-process mandate store, event-sourced budgets, in-flight resolution.
- `lib/auction/{chain,circle-facilitator,handler,bidder,engine,worker-pool,runtime}.ts`
  — RPC adapter, Circle settlement, HTTP handler, x402 bidder client, state
  machine, worker pool, shared runtime. SSE lives in `app/api/stream/route.ts`.
- `lib/db/*`, `lib/auth.ts` — SQLite registry and wallet-signature sessions.
- `lib/items/*`, `lib/voice/*` — deterministic item catalog + SVG art; templated TTS.
- `app/api/*` — x402 bids, SSE, agent CRUD, auth, claims, receipts, sessions, users.
- `components/*` — stage/arena, dashboard, sign-in, ship scene; `components/ui/*`
  (Magic UI via shadcn) and ReactBits components at `components/*`.

Auction state is in memory by design (single-process assumption); SQLite persists
registry/claims. The engine and reconciler survive Next dev hot reloads via
`globalThis`.

## Known tradeoff: escrow refund model

`placeBid` pulls the **full new amount** from the bidder's wallet and refunds the
previous bidder **inside the same transaction**. Two consequences:

- On a self-raise (25 → 35), the wallet must hold 35 liquid at that moment; the
  old 25 comes back in the same tx. Net locked is 10, but peak liquidity is 35.
  Delta-funding would lower that peak but needs per-lot committed-balance tracking
  in the contract.
- An outbid bidder's funds are returned immediately, in the *outbid* transaction,
  so they are free to bid on another lot at once — better capital mobility than an
  eBay-style hold-until-settlement.

A pooled-deposit variant is a future direction needing escrow v2, a re-audit, and a
`spentMinor` rewrite; out of scope here.

## Products used

Next.js 16, React 19, TypeScript 7, Tailwind v4, Motion, viem, wagmi 3 + TanStack
Query, x402 (EVM + Next), Circle Facilitator Service on Arc testnet, ElevenLabs TTS,
shadcn CLI with Magic UI + React Bits, lucide-react, `node:sqlite`, Foundry.

## Verification

`npm run typecheck && npm test && npm run build` must pass; `forge test` for contracts.
As of 2026-11-18: typecheck, 170 vitest tests (incl. a market simulation over the real
roster), 26 Foundry tests, and build all pass.
