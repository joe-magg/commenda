/**
 * Pure event reconciliation — applies on-chain escrow events to a mandate's
 * spentMinor. The chain is the source of truth for agent budgets (ESCROW_DESIGN §3).
 *
 * Only mutates `spentMinor`. Never rebuilds the Mandate or touches decide-managed
 * fields (seenKeys, velocity, approvedKeys) — that is `commit()`'s job in the caller.
 *
 * Idempotency: a cursor (blockNumber, logIndex) plus an ingest set makes replay a
 * no-op. logIndex is unique only within a block, so the pair is required.
 */
import type { Mandate } from "./decide";

export type EventKey = { blockNumber: bigint; logIndex: number };

export type ChainEvent =
  | { kind: "BidPlaced"; lotId: bigint; bidder: string; amount: bigint; prevBidder: string; prevAmount: bigint; seller: string; key: EventKey }
  | { kind: "RefundQueued"; bidder: string; amount: bigint; key: EventKey }
  | { kind: "RefundClaimed"; bidder: string; amount: bigint; key: EventKey }
  | { kind: "LotSettled"; lotId: bigint; bidder: string; amount: bigint; seller: string; key: EventKey }
  | { kind: "EmergencyRefund"; lotId: bigint; bidder: string; amount: bigint; key: EventKey }
  | { kind: "AuctioneerChanged"; oldAuctioneer: string; newAuctioneer: string; key: EventKey };

export type IngestState = {
  cursor: EventKey | null;
  seen: Set<string>; // "blockNumber:logIndex" exact-membership keys
};

export type ReconcileResult = {
  mandates: Map<string, Mandate>; // agentId -> updated mandate (only spentMinor changed)
  ingest: IngestState;
  applied: ChainEvent[];
  warnings: string[];
};

export function eventKeyString(k: EventKey): string {
  return `${k.blockNumber}:${k.logIndex}`;
}

/** Compare (blockNumber, logIndex) as a numeric tuple — never as a string. */
export function compareEventKey(a: EventKey, b: EventKey): number {
  if (a.blockNumber < b.blockNumber) return -1;
  if (a.blockNumber > b.blockNumber) return 1;
  return a.logIndex - b.logIndex;
}

function toSafeMinor(value: bigint, warnings: string[], label: string): number | null {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    warnings.push(`${label} exceeds MAX_SAFE_INTEGER; event ignored`);
    return null;
  }
  return Number(value);
}

/**
 * Apply ordered events to a copy of the mandates map. Idempotent by event key.
 * `commit()` in the caller is responsible for merging decide's `next` into the
 * same mandate before/after this — reconcile itself only adjusts spentMinor.
 */
export function reconcile(
  mandates: ReadonlyMap<string, Mandate>,
  ingest: IngestState,
  events: readonly ChainEvent[],
  /** Map an on-chain address to a mandate key; default identity for tests. (auditor F4) */
  resolveAddress: (address: string) => string = (a) => a,
): ReconcileResult {
  const out = new Map<string, Mandate>();
  for (const [id, m] of mandates) out.set(id, { ...m }); // shallow copy; fields are immutable-ish Sets

  const nextSeen = new Set(ingest.seen);
  let cursor = ingest.cursor;
  const applied: ChainEvent[] = [];
  const warnings: string[] = [];

  const sorted = [...events].sort((a, b) => compareEventKey(a.key, b.key));

  for (const ev of sorted) {
    const ek = eventKeyString(ev.key);
    if (nextSeen.has(ek)) continue; // replay — no double credit
    if (cursor && compareEventKey(ev.key, cursor) <= 0) continue; // already past cursor

    switch (ev.kind) {
      case "BidPlaced": {
        // Unified credit rule (auditor N2): every outbid credits prevBidder,
        // including self-raise (contract nets internally; decide added full amount).
        if (ev.prevBidder && ev.prevAmount > 0n) {
          const amt = toSafeMinor(ev.prevAmount, warnings, "BidPlaced.prevAmount");
          if (amt !== null) {
            const key = resolveAddress(ev.prevBidder.toLowerCase());
            const m = out.get(key);
            // Clamp at zero: an in-memory cursor starts empty on restart, so
            // replaying historical events must never drive committed funds
            // negative (decide() rejects negative spentMinor as INVALID_AMOUNT).
            if (m) out.set(key, { ...m, spentMinor: Math.max(0, m.spentMinor - amt) });
            else warnings.push(`BidPlaced prevBidder ${ev.prevBidder} unknown; credit skipped`);
          }
        }
        break;
      }
      case "EmergencyRefund": {
        const amt = toSafeMinor(ev.amount, warnings, "EmergencyRefund.amount");
        if (amt !== null) {
          const key = resolveAddress(ev.bidder.toLowerCase());
          const m = out.get(key);
          if (m) out.set(key, { ...m, spentMinor: Math.max(0, m.spentMinor - amt) });
          else warnings.push(`EmergencyRefund bidder ${ev.bidder} unknown; credit skipped`);
        }
        break;
      }
      // RefundQueued / RefundClaimed / LotSettled / AuctioneerChanged: no credit.
      // A win consumes budget (LotSettled); queued refunds were credited at BidPlaced.
      case "RefundQueued":
      case "RefundClaimed":
      case "LotSettled":
      case "AuctioneerChanged":
        break;
    }

    nextSeen.add(ek);
    cursor = ev.key;
    applied.push(ev);
  }

  return {
    mandates: out,
    ingest: { cursor, seen: nextSeen },
    applied,
    warnings,
  };
}
