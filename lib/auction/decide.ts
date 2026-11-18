/**
 * Deterministic bid guardrails. Pure, zero dependencies, table-testable.
 *
 * TRUST BOUNDARY (auditor H1): `Mandate` is constructed server-side from
 * trusted config (`agent-budget.json` / DB). It MUST NOT be derived from LLM
 * output, and the agent-facing tool schema MUST NOT expose any limit field.
 * "AI recommends, code enforces": the agent proposes a `Bid`; this module is
 * the sole authority on whether it becomes an on-chain action.
 *
 * STATE CONTRACT (auditor B3): `decide()` is pure. It returns `next`, the
 * updated mandate state. The caller MUST persist `next` with an atomic
 * read-modify-write before any subsequent decision for that agent, and MUST
 * serialize decisions per agent. Two calls against the same snapshot are not
 * safe. `BID` output binds ONLY to `place_bid` — never a transfer/withdraw
 * tool — and the raw on-chain outcome must be verified before it is trusted.
 *
 * `spentMinor` semantics: funds currently committed in escrow
 * across open lots. Caller increments on submit, decrements on outbid refund.
 */

export type RuleCode =
  | "KILL_SWITCH"
  | "INVALID_AMOUNT"
  | "INVALID_BID"
  | "INVALID_MANDATE"
  | "IDEMPOTENCY"
  | "SELF_OUTBID"
  | "PER_BID_CAP"
  | "BUDGET"
  | "VELOCITY"
  | "CIRCUIT_BREAKER"
  | "WATCHLIST"
  | "SELLER"
  | "APPROVAL_REQUIRED";

export type Decision =
  | { decision: "BID" }
  | { decision: "REJECT"; rule: RuleCode } // opaque code only — no numbers to the agent
  | { decision: "NEEDS_APPROVAL" };

export type Bid = {
  id: string;
  lotId: string;
  amountMinor: number; // USDC minor units (6 decimals) — integers only
  category: string;
  seller: string;
};

export type Mandate = {
  agentId: string;
  budgetMinor: number; // cumulative cap on committed funds
  spentMinor: number; // currently committed in escrow
  perBidCapMinor: number; // max single bid
  watchlist: ReadonlySet<string>;
  sellerAllowlist: ReadonlySet<string>;
  killSwitch: boolean;
  approvalEnabled: boolean; // "approvals ON by default"; false = autonomous demo toggle
  approvalAboveMinor: number; // must be < perBidCapMinor when approval enabled
  approvedKeys: ReadonlySet<string>; // human-approved, not yet submitted
  seenKeys: ReadonlySet<string>; // submitted keys (idempotency)
  consecutiveFailures: number; // tool failures, incremented by caller
  maxConsecutiveFailures: number;
  recentBidTimesMs: readonly number[]; // rolling-window velocity state
  maxBidsPerWindow: number;
  windowMs: number;
};

export type AuditEntry = {
  at: string; // UTC ISO, derived from nowMs
  agentId: string;
  bid: Bid;
  decision: Decision;
  rule: RuleCode | "BID";
  detail: string; // full numbers — audit only, never surfaced to the agent
  snapshot: {
    budgetMinor: number;
    spentMinor: number;
    perBidCapMinor: number;
    consecutiveFailures: number;
    seenKeysCount: number;
  };
};

export type DecideResult = {
  decision: Decision;
  audit: AuditEntry;
  next: Mandate;
};

const validMinor = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 0;

/** Runtime string check — TS types vanish at runtime, and a Bid may be built
 *  from untrusted agent JSON. Also caps length to bound audit-log content. */
const validString = (x: unknown): x is string =>
  typeof x === "string" && x.length > 0 && x.length <= 200;

/** Validate every runtime field of a Bid. Call before any other use. */
export function isValidBid(bid: unknown): bid is Bid {
  if (typeof bid !== "object" || bid === null) return false;
  const b = bid as Record<string, unknown>;
  return (
    validString(b.id) &&
    validString(b.lotId) &&
    validString(b.category) &&
    validString(b.seller) &&
    validMinor(b.amountMinor)
  );
}

/** Idempotency key: same agent + lot + amount can never be submitted twice.
 *  A higher amount on the same lot is a distinct key (legitimate raise).
 *  JSON-encoded tuple avoids template-literal coercion collisions
 *  (e.g. number 1 vs string "1", or an array coercing to "a,b"). */
export function bidKey(agentId: string, bid: Bid): string {
  return JSON.stringify([agentId, bid.lotId, bid.amountMinor]);
}

function reject(
  rule: RuleCode,
  detail: string,
  bid: Bid,
  m: Mandate,
  nowMs: number,
): DecideResult {
  return {
    decision: { decision: "REJECT", rule },
    audit: makeAudit(rule, detail, bid, m, nowMs, { decision: "REJECT", rule }),
    next: m,
  };
}

function makeAudit(
  rule: RuleCode | "BID",
  detail: string,
  bid: Bid,
  m: Mandate,
  nowMs: number,
  decision: Decision,
): AuditEntry {
  return {
    at: new Date(nowMs).toISOString(),
    agentId: m.agentId,
    bid,
    decision,
    rule,
    detail,
    snapshot: {
      budgetMinor: m.budgetMinor,
      spentMinor: m.spentMinor,
      perBidCapMinor: m.perBidCapMinor,
      consecutiveFailures: m.consecutiveFailures,
      seenKeysCount: m.seenKeys.size,
    },
  };
}

export type DecideContext = {
  /** The agent that currently holds the lead on bid.lotId, when known.
   *  Derived from applied BidPlaced events (chain truth as of the last
   *  sync). Stale by at most one sync window — a leader who was JUST
   *  outbid may be rejected once; the retry lands after a fresh sync. */
  currentLeaderAgentId?: string | null;
};

export function decide(bid: Bid, m: Mandate, nowMs: number, context?: DecideContext): DecideResult {
  // Rule 0 — kill switch, before everything else.
  if (m.killSwitch) {
    return reject("KILL_SWITCH", "agent kill switch is engaged", bid, m, nowMs);
  }

  // Validation — untrusted Bid shape and NaN/negative/float amounts cannot authorize a bid.
  if (!isValidBid(bid)) {
    return reject("INVALID_BID", "malformed bid: string fields must be non-empty", bid, m, nowMs);
  }
  if (
    !validMinor(bid.amountMinor) ||
    !validMinor(m.budgetMinor) ||
    !validMinor(m.spentMinor) ||
    !validMinor(m.perBidCapMinor) ||
    !validMinor(m.approvalAboveMinor) ||
    !validMinor(m.consecutiveFailures) ||
    !validMinor(m.maxConsecutiveFailures) ||
    !validMinor(m.maxBidsPerWindow) ||
    !validMinor(m.windowMs) ||
    !Number.isSafeInteger(nowMs)
  ) {
    return reject("INVALID_AMOUNT", "non-integer or invalid amount/state", bid, m, nowMs);
  }
  if (
    m.spentMinor > m.budgetMinor ||
    m.consecutiveFailures > m.maxConsecutiveFailures ||
    (m.approvalEnabled && m.approvalAboveMinor >= m.perBidCapMinor)
  ) {
    return reject("INVALID_MANDATE", "mandate invariants violated", bid, m, nowMs);
  }

  const key = bidKey(m.agentId, bid);

  // Rule 1 — idempotency: never two identical (agent, lot, amount) submissions.
  if (m.seenKeys.has(key)) {
    return reject("IDEMPOTENCY", `key ${key} already submitted`, bid, m, nowMs);
  }

  // Rule 1b — self-outbid: the agent already holds the lead on this lot. The
  // escrow nets a self-raise internally (two transfers + gas) to no effect —
  // pure fee/gas waste. Placed AFTER idempotency so replays stay
  // IDEMPOTENCY forever (the leader map is mutable context; replay
  // determinism wins).
  if (
    context?.currentLeaderAgentId != null &&
    context.currentLeaderAgentId === m.agentId
  ) {
    return reject("SELF_OUTBID", "agent already holds the lead on this lot", bid, m, nowMs);
  }

  // Rule 2 — per-bid cap.
  if (bid.amountMinor > m.perBidCapMinor) {
    return reject(
      "PER_BID_CAP",
      `${bid.amountMinor} > cap ${m.perBidCapMinor}`,
      bid,
      m,
      nowMs,
    );
  }

  // Rule 3 — aggregate budget: committed + this bid must stay under cap.
  if (m.spentMinor + bid.amountMinor > m.budgetMinor) {
    return reject(
      "BUDGET",
      `${m.spentMinor}+${bid.amountMinor} > ${m.budgetMinor}`,
      bid,
      m,
      nowMs,
    );
  }

  // Rule 4 — velocity: rolling-window bid count.
  const inWindow = m.recentBidTimesMs.filter(
    (t) => Number.isSafeInteger(t) && nowMs - t < m.windowMs,
  );
  if (inWindow.length >= m.maxBidsPerWindow) {
    return reject(
      "VELOCITY",
      `${inWindow.length} bids in window >= ${m.maxBidsPerWindow}`,
      bid,
      m,
      nowMs,
    );
  }

  // Rule 5 — circuit breaker: consecutive tool failures (caller increments).
  if (m.consecutiveFailures >= m.maxConsecutiveFailures) {
    return reject(
      "CIRCUIT_BREAKER",
      `${m.consecutiveFailures} >= ${m.maxConsecutiveFailures}`,
      bid,
      m,
      nowMs,
    );
  }

  // Rule 6 — watchlist / category match.
  if (!m.watchlist.has(bid.category)) {
    return reject("WATCHLIST", `category ${bid.category} not watched`, bid, m, nowMs);
  }

  // Rule 7 — seller allowlist.
  if (!m.sellerAllowlist.has(bid.seller)) {
    return reject("SELLER", `seller ${bid.seller} not allowed`, bid, m, nowMs);
  }

  // Rule 8 — human approval threshold (approvals ON by default).
  if (
    m.approvalEnabled &&
    !m.approvedKeys.has(key) &&
    bid.amountMinor > m.approvalAboveMinor
  ) {
    return {
      decision: { decision: "NEEDS_APPROVAL" },
      audit: makeAudit(
        "APPROVAL_REQUIRED",
        `${bid.amountMinor} > approval threshold ${m.approvalAboveMinor}`,
        bid,
        m,
        nowMs,
        { decision: "NEEDS_APPROVAL" },
      ),
      next: m,
    };
  }

  // BID — advance state. Caller persists `next` atomically.
  const nextKeys = new Set(m.seenKeys);
  nextKeys.add(key);
  const nextApproved = new Set(m.approvedKeys);
  nextApproved.delete(key);
  const next: Mandate = {
    ...m,
    spentMinor: m.spentMinor + bid.amountMinor,
    seenKeys: nextKeys,
    approvedKeys: nextApproved,
    recentBidTimesMs: [...inWindow, nowMs],
    consecutiveFailures: 0, // reset on a successful decision
  };

  return {
    decision: { decision: "BID" },
    audit: makeAudit("BID", `approved ${bid.amountMinor} minor units`, bid, m, nowMs, {
      decision: "BID",
    }),
    next,
  };
}
