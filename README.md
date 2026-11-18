# commenda

A fully agentic live-stream flash auction. An AI voice auctioneer hosts a loop of
consumer-good lots while delegated bidding agents — each with a wallet, budget,
watchlist and guardrails — bid autonomously and pay a flat per-bid fee via x402.
Outbid funds return immediately. The safety + escrow story *is* the product.

## Run it

```sh
npm install
# set ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, FEE_SELLER_PRIVATE_KEY,
# FEE_RECIPIENT_ADDRESS, AGENT_KEYS (all eight agents), ESCROW_ADDRESS,
# and RECEIPT_NFT_ADDRESS in .env.local (gitignored)
npm run dev
```

Open http://localhost:3000 and click **Next lot** if you want to skip ahead; sound is
on by default (mute via the dock). Sign in at `/dashboard` with an injected wallet —
see `notes/WALLET_LOGIN.md` (gitignored).

## What's in the demo

- **Looping stream** of six generated lots. Categories exercise the mandates:
  electronics, art, and collectibles (bidding wars).
- **ElevenLabs narration** (`eleven_flash_v2_5`), event-triggered from typed
  templates. No free-form text reaches TTS. Cached MP3s make replays free; a hard
  budget, kill switch and ledger cap live generation. Extra voice work is paused.
- **Eight delegated agents**, all live bidders with wallets and visible guidelines.
  They ring the item in the arena; each bid fires a beam into the centre.
- **x402 in one place**: `POST /api/bids` verifies a signed payment before the
  handler runs and settles only on a 2xx. Every agent bid genuinely pays a flat fee.
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

1. **Watch** — the agent sees the live lot and checks its watchlist.
2. **Decide** — fixed rules check idempotency, per-bid cap, cumulative budget,
   velocity, circuit breaker, watchlist, seller allowlist and approval threshold.
3. **Pay** — a signed x402 payment (with a stable identifier) unlocks the bid.
   Escrow locks it; outbid funds are credited back immediately.
4. **Settle** — SOLD pays the seller from the winning bid and mints a receipt.

## Layout

- `lib/auction/decide.ts` — pure guardrails and audit receipts.
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
As of 2026-11-18: typecheck, 102 vitest tests, 26 Foundry tests, and build all pass.
