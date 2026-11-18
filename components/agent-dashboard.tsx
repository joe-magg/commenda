"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { formatMinor } from "@/lib/auction/lots";
import { ItemArt } from "@/components/item-art";
import { artSeedFor } from "@/lib/items/generator";

const HoloCard = dynamic(() => import("@/components/HoloCard"), { ssr: false });
const CircularCarousel = dynamic(() => import("@/components/CircularCarousel"), { ssr: false });

type Policy = {
  budgetMinor: number;
  perBidCapMinor: number;
  watchlist: string[];
  sellerAllowlist: string[];
  approvalEnabled: boolean;
  approvalAboveMinor: number;
  maxWins: number;
};
type Agent = {
  id: string;
  ownerId: string;
  label: string;
  walletAddress: string | null;
  enabled: boolean;
  status: "standby" | "bidding" | "paused";
  policy: Policy;
};
type Session = {
  id: string;
  name: string;
  status: string;
  catalog: { id: number; title: string; category: string; openingMinor: number; sku: string; artSeed: string }[];
};
type OnChainReceipt = { tokenId: number; uri: string; owner: string };
type DecodedReceipt = {
  name: string;
  description: string;
  image: string;
  attributes: { trait_type: string; value: string }[];
};

function decodeReceipt(uri: string): DecodedReceipt | null {
  try { return JSON.parse(atob(uri.split(",")[1] ?? "")) as DecodedReceipt; } catch { return null; }
}

type Claim = {
  id: string;
  winnerId: string | null;
  title: string;
  sku: string;
  amountMinor: number;
  settleTx: string | null;
  status: "issued" | "redeemed";
};

const CATEGORIES = ["electronics", "art", "collectibles"];

export function AgentDashboard({ userName }: { userName: string }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [receipts, setReceipts] = useState<OnChainReceipt[]>([]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    label: "",
    budget: "5",
    perBid: "0.5",
    watchlist: [] as string[],
    approvalEnabled: false,
    approvalAbove: "0.25",
    maxWins: "1",
  });

  const refresh = useCallback(async () => {
    const [s, c, r] = await Promise.all([
      fetch("/api/sessions").then((r) => r.json()),
      fetch("/api/claims").then((r) => r.json()),
      fetch("/api/receipts").then((r) => r.json()),
    ]);
    setSessions(s.sessions);
    setClaims(c.claims);
    setReceipts(r.receipts ?? []);
    // Server scopes agents to the session user; no client-supplied owner.
    const a = await fetch("/api/agents").then((r) => r.json());
    setAgents(a.agents ?? []);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const toggleCategory = (c: string) =>
    setForm((f) => ({ ...f, watchlist: f.watchlist.includes(c) ? f.watchlist.filter((x) => x !== c) : [...f.watchlist, c] }));

  const create = async () => {
    if (!form.label.trim() || form.watchlist.length === 0) return;
    setBusy(true);
    const budgetMinor = Math.round(Number(form.budget) * 1_000_000);
    const perBidCapMinor = Math.round(Number(form.perBid) * 1_000_000);
    const approvalAboveMinor = Math.round(Number(form.approvalAbove) * 1_000_000);
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: form.label.trim(),
        budgetMinor,
        perBidCapMinor,
        watchlist: form.watchlist,
        approvalEnabled: form.approvalEnabled,
        approvalAboveMinor,
        maxWins: Math.max(1, Math.round(Number(form.maxWins) || 1)),
      }),
    }).then((r) => r.json());
    setNewKey(res.apiKey ?? null);
    setForm({ label: "", budget: "5", perBid: "0.5", watchlist: [], approvalEnabled: false, approvalAbove: "0.25", maxWins: "1" });
    setBusy(false);
    await refresh();
  };

  const toggleAgent = async (agent: Agent) => {
    await fetch(`/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !agent.enabled }),
    });
    await refresh();
  };

  const redeem = async (claim: Claim) => {
    await fetch(`/api/claims/${claim.id}/redeem`, { method: "POST" });
    await refresh();
  };

  const myAgentIds = new Set(agents.map((a) => a.id));
  const myClaims = claims.filter((c) => c.winnerId && myAgentIds.has(c.winnerId));

  return (
    <main className="mx-auto min-h-screen max-w-[1180px] px-5 py-8 sm:px-8">
      <header className="mb-7 flex flex-wrap items-center justify-between gap-4">
        <div>
          <a href="/" className="text-[22px] font-semibold tracking-[-0.04em]">commenda</a>
          <h1 className="mt-3 text-2xl font-semibold tracking-[-0.03em]">Your agents</h1>
          <p className="mt-1 max-w-xl text-sm text-muted">
            Delegate a budget and a watchlist. An agent bids only within the policy you set.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">{userName}</span>
          <button onClick={async () => { await fetch("/api/auth", { method: "DELETE" }); window.location.reload(); }}
            className="whitespace-nowrap rounded-xl border border-white/70 bg-white/55 px-3 py-2 text-xs font-medium text-ink shadow-sm backdrop-blur-xl">
            Sign out
          </button>
          <a href="/live" className="whitespace-nowrap rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white shadow-[0_6px_18px_rgba(0,169,214,0.35)]">
            Watch the auction
          </a>
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="flex flex-col gap-5">
          <div className="card p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-muted">Your agents</h2>
            </div>

            {agents.length === 0 ? (
              <p className="py-6 text-sm text-subtle">No agents yet. Create one to get started.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {agents.map((a) => (
                  <div key={a.id} className="rounded-lg border border-line p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className={`h-1.5 w-1.5 rounded-full ${a.enabled ? "bg-accent" : "bg-subtle"}`} />
                          <span className="font-semibold text-ink">{a.label}</span>
                          <span className="text-[11px] text-subtle">{a.status}</span>
                        </div>
                        <div className="mt-1 text-[11px] text-subtle">{a.id} · {a.walletAddress ? "wallet attached" : "no wallet key"}</div>
                      </div>
                      <button
                        onClick={() => toggleAgent(a)}
                        className="whitespace-nowrap rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:border-muted"
                      >
                        {a.enabled ? "Pause" : "Enable"}
                      </button>
                    </div>
                    <div className="tabular mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted sm:grid-cols-3">
                      <span>Budget {formatMinor(a.policy.budgetMinor)} USDC</span>
                      <span>Per bid {formatMinor(a.policy.perBidCapMinor)}</span>
                      <span>{a.policy.approvalEnabled ? `Approve > ${formatMinor(a.policy.approvalAboveMinor)}` : "Autonomous"}</span>
                      <span>Stop after {a.policy.maxWins} win{a.policy.maxWins === 1 ? "" : "s"}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {a.policy.watchlist.map((w) => <span key={w} className="rounded bg-bg px-1.5 py-0.5 text-[10px] text-muted">{w}</span>)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card p-5">
            <h2 className="mb-4 text-xs font-medium uppercase tracking-[0.14em] text-muted">New agent</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-xs text-muted">
                Name
                <input
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  placeholder="e.g. Camera sniper"
                  className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
                />
              </label>
              <div className="text-xs text-muted">
                Watches
                <div className="mt-1 flex flex-wrap gap-2">
                  {CATEGORIES.map((c) => (
                    <button
                      key={c}
                      onClick={() => toggleCategory(c)}
                      className={`rounded-lg border px-2.5 py-1.5 text-xs ${form.watchlist.includes(c) ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink"}`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
              <label className="block text-xs text-muted">
                Budget (USDC)
                <input type="number" step="0.1" min="0.1" value={form.budget}
                  onChange={(e) => setForm({ ...form, budget: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink" />
              </label>
              <label className="block text-xs text-muted">
                Max per bid (USDC)
                <input type="number" step="0.05" min="0.01" value={form.perBid}
                  onChange={(e) => setForm({ ...form, perBid: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink" />
              </label>
              <label className="block text-xs text-muted">
                Max items to buy
                <input type="number" min="1" max="20" value={form.maxWins}
                  onChange={(e) => setForm({ ...form, maxWins: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink" />
              </label>
              <label className="flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={form.approvalEnabled}
                  onChange={(e) => setForm({ ...form, approvalEnabled: e.target.checked })}
                  className="accent-ink" />
                Require approval above threshold
              </label>
              {form.approvalEnabled && (
                <label className="block text-xs text-muted">
                  Approval above (USDC)
                  <input type="number" step="0.05" min="0" value={form.approvalAbove}
                    onChange={(e) => setForm({ ...form, approvalAbove: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink" />
                </label>
              )}
            </div>
            <button
              onClick={create}
              disabled={busy || !form.label.trim() || form.watchlist.length === 0}
              className="mt-5 rounded-lg bg-accent px-4 py-2 text-xs font-medium text-white disabled:opacity-40"
            >
              {busy ? "Creating…" : "Create agent"}
            </button>
            {newKey && (
              <div className="mt-4 rounded-lg border border-line bg-bg p-3 text-xs">
                <div className="font-medium text-ink">Agent API key — shown once</div>
                <code className="mt-1 block break-all text-muted">{newKey}</code>
              </div>
            )}
          </div>
        </section>

        <aside className="flex flex-col gap-5">
          <div className="card p-5">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-[0.14em] text-muted">Your wins</h2>
            {myClaims.length === 0 ? (
              <p className="text-xs text-subtle">No wins yet. Claims appear here when your agent takes a lot.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {myClaims.map((c) => (
                  <div key={c.id} className="rounded-lg border border-line p-3">
                    <div className="mb-2 flex justify-center">
                      <ItemArt seed={artSeedFor(c.sku)} size={96} className="rounded-lg" />
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-semibold text-ink">{c.title}</span>
                      <span className="tabular text-xs text-muted">{formatMinor(c.amountMinor)}</span>
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-subtle">SKU {c.sku}</div>
                    {c.settleTx && (
                      <a
                        href={`https://explorer.testnet.arc.io/tx/${c.settleTx}`}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 block font-mono text-[10px] text-muted underline underline-offset-2"
                      >
                        on-chain settlement ↗
                      </a>
                    )}
                    <div className="mt-2 flex items-center justify-between">
                      <span className={`text-[10px] ${c.status === "redeemed" ? "text-win" : "text-subtle"}`}>
                        {c.status === "redeemed" ? "redeemed" : "right to redeem"}
                      </span>
                      {c.status === "issued" && (
                        <button
                          onClick={() => redeem(c)}
                          className="rounded border border-line bg-surface px-2 py-1 text-[10px] font-medium text-ink hover:border-muted"
                        >
                          Redeem (simulated)
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card p-5">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-[0.14em] text-muted">Upcoming sessions</h2>
            {sessions.map((s) => (
              <div key={s.id} className="mb-4 last:mb-0">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-semibold text-ink">{s.name}</span>
                  <span className="text-[10px] text-subtle">{s.status}</span>
                </div>
                <div className="mt-2 flex flex-col gap-1.5">
                  {s.catalog.map((l) => (
                    <div key={l.id} className="flex items-center gap-2">
                      <ItemArt seed={l.artSeed || artSeedFor(l.sku)} size={30} className="shrink-0 rounded" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[11px] text-ink">{l.title}</div>
                        <div className="truncate font-mono text-[9px] text-subtle">{l.sku}</div>
                      </div>
                      <span className="tabular text-[11px] text-muted">{formatMinor(l.openingMinor)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {receipts.length > 0 && (
            <div className="card p-5">
              <h2 className="mb-3 text-xs font-medium uppercase tracking-[0.14em] text-muted">On-chain receipts</h2>
              <div className="grid grid-cols-2 gap-3">
                {receipts.map((r) => {
                  const d = decodeReceipt(r.uri);
                  return (
                    <div key={r.tokenId} className="flex flex-col items-center rounded-xl border border-white/70 bg-white/45 p-3">
                      {d?.image && <HoloCard image={d.image} alt={d.name} width={140} radius={12} intensity={0.7} />}
                      <div className="mt-2 w-full truncate text-[11px] font-semibold text-ink">{d?.name ?? `Receipt #${r.tokenId}`}</div>
                      <div className="font-mono text-[9px] text-subtle">soulbound · #{r.tokenId}</div>
                    </div>
                  );
                })}
              </div>
              {receipts.length > 2 && (
                <div className="mt-4">
                  <CircularCarousel
                    items={receipts.map((r) => {
                      const d = decodeReceipt(r.uri);
                      return { src: d?.image ?? "", alt: d?.name ?? `Receipt #${r.tokenId}`, title: d?.name };
                    })}
                    cardWidth={120}
                    captions
                  />
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
