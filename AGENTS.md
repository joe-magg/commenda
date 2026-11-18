# Commenda — agent instructions

## Project
- Next.js App Router + React 19 + TS + Tailwind v4 + shadcn/ui + Motion. Arc testnet primary; Solana devnet fallback.
- x402 in exactly one function; ElevenLabs via server route only; deterministic `decide()` rules module; per-bid escrow with immediate refunds.
- Read `notes/SPEC.md` for scope, `notes/DESIGN.md` for the visual grammar, `notes/SECURITY.md` for the original supply-chain notes.

## Security (non-negotiable)
- No API keys, private keys, or secrets in source, config, or chat. Keys live in `.env.local` (gitignored).
- Never commit `node_modules`, build output, `.env*`, or key material.
- Never pipe downloaded content straight into a shell (`curl … | bash`).
- Verify unfamiliar package names against the registry before installing. Pin exact versions and commit `package-lock.json`.

## Tooling
- Use standard CLIs the normal way — `shadcn`, `forge`, etc. Prefer exact-pinned devDependencies invoked as `./node_modules/.bin/<tool>`; `npm exec --package=<pkg>@<exact> -- <cmd>` is fine for one-off tools.
- New dependencies: `sfw npm install -E <pkg>@<version>` is preferred; a normal `npm install` with an exact pin is acceptable when a CLI needs it.
- No `@latest` in committed files.
- Run `npm run dev` only for a test pass; stop it as soon as testing is done. Never leave it running for the user.

## Workflow gates
- `npm run typecheck && npm test` after any TS change; `npm run build` before a PR; `forge test` for contracts.
- Before changing `.github/workflows/*`, the escrow contract, or `lib/auction/decide.ts`, run the read-only `auction-auditor` subagent.
- Ask before any chain deployment command (`solana *`, Foundry broadcasts) or any command that broadcasts a transaction.
- Keep agent spend caps in `agent-budget.json`, never hardcoded. Keep spend/guardrail amounts in minor units; read back before irreversible actions.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
