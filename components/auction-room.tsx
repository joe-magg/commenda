"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { AuctionEvent, EngineSnapshot } from "@/lib/auction/engine";
import { formatMinor, type Lot } from "@/lib/auction/lots";
import { playSfx } from "@/lib/client/sfx";
import { ItemArt } from "@/components/item-art";

export type AgentView = {
  id: string;
  label: string;
  short: string;
  budgetMinor: number;
  perBidCapMinor: number;
  watchlist: string[];
  approvalEnabled: boolean;
  approvalAboveMinor: number;
  active: boolean;
};

type SpokenLine = { text: string; audioUrl?: string };
type BidItem = { key: string; label: string; amountMinor: number; txHash?: string; at: number };
type ActivityItem = { key: string; tone: "bid" | "reject" | "outbid" | "sold" | "voice"; text: string; at: number };

let seq = 0;
const nextKey = () => `${Date.now()}-${seq++}`;

export function AuctionRoom({ agents }: { agents: AgentView[] }) {
  const [snap, setSnap] = useState<EngineSnapshot | null>(null);
  const [lot, setLot] = useState<Lot | null>(null);
  const [bids, setBids] = useState<BidItem[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [caption, setCaption] = useState("");
  const [soundOn, setSoundOn] = useState(false);
  const [connected, setConnected] = useState(false);
  const [sold, setSold] = useState<{ amount: number; winner: string | null } | null>(null);
  const [committed, setCommitted] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queueRef = useRef<SpokenLine[]>([]);
  const soundRef = useRef(false);

  const pushActivity = useCallback((tone: ActivityItem["tone"], text: string) => {
    setActivity((xs) => [{ key: nextKey(), tone, text, at: Date.now() }, ...xs].slice(0, 18));
  }, []);

  // One persistent audio element with a small queue. A new line lets the
  // current one finish; if more than two pile up, the oldest pending line is
  // dropped so audio never drifts far behind the live action.
  const playNext = useCallback(() => {
    const a = audioRef.current;
    const next = queueRef.current.shift();
    if (!a || !next?.audioUrl) return;
    a.src = next.audioUrl;
    a.currentTime = 0;
    setCaption(next.text);
    void a.play().catch(() => {});
  }, []);

  useEffect(() => {
    const a = new Audio();
    a.preload = "auto";
    a.volume = 0.9;
    a.addEventListener("ended", playNext);
    a.addEventListener("error", playNext);
    audioRef.current = a;
    return () => {
      a.removeEventListener("ended", playNext);
      a.removeEventListener("error", playNext);
      a.pause();
      queueRef.current = [];
    };
  }, [playNext]);

  const toggleSound = () => {
    const next = !soundRef.current;
    soundRef.current = next;
    setSoundOn(next);
    if (!next && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
      queueRef.current = [];
    }
  };

  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      let e: AuctionEvent;
      try { e = JSON.parse(m.data); } catch { return; }
      switch (e.type) {
        case "snapshot":
          setSnap(e.state);
          break;
        case "lot_open":
          setLot(e.lot);
          setBids([]);
          setCaption("");
          setSold(null);
          setCommitted({});
          // Drop stale pending lines on a lot change; let the current line finish.
          queueRef.current = [];
          break;
        case "bid":
          setBids((xs) => [{ key: nextKey(), label: e.label, amountMinor: e.amountMinor, txHash: e.txHash, at: Date.now() }, ...xs].slice(0, 10));
          setCommitted((c) => ({ ...c, [e.bidder]: e.amountMinor }));
          pushActivity("bid", `${e.label} bid ${formatMinor(e.amountMinor)} USDC`);
          if (soundRef.current) playSfx("bid");
          break;
        case "reject": {
          const a = agents.find((x) => x.id === e.agentId);
          pushActivity("reject", `${a?.label ?? "Agent"} held — ${e.rule.toLowerCase().replace(/_/g, " ")}`);
          break;
        }
        case "outbid":
          setCommitted((c) => ({ ...c, [e.previousBidder]: 0 }));
          pushActivity("outbid", `${e.label} refunded — outbid`);
          if (soundRef.current) playSfx("outbid");
          break;
        case "sold":
          setSold({ amount: e.amountMinor, winner: e.winner });
          pushActivity("sold", `SOLD ${formatMinor(e.amountMinor)} USDC${e.winner ? ` to ${e.winner}` : ""}`);
          if (soundRef.current) playSfx("sold");
          window.setTimeout(() => setSold(null), 2600);
          break;
        case "agent_join":
          pushActivity("bid", `${e.label} joined lot ${e.lotId + 1}`);
          break;
        case "agent_leave":
          pushActivity("reject", `${e.label} left — ${e.reason}`);
          break;
        case "countdown":
          if (soundRef.current) playSfx("countdown");
          break;
        case "caption": {
          const line: SpokenLine = { text: e.text, audioUrl: e.audioUrl };
          if (!soundRef.current || !e.audioUrl) {
            setCaption(e.text);
            break;
          }
          const a = audioRef.current;
          if (!a) {
            setCaption(e.text);
            break;
          }
          if (a.paused) {
            queueRef.current = [];
            a.src = e.audioUrl;
            a.currentTime = 0;
            setCaption(e.text);
            void a.play().catch(() => {});
          } else {
            queueRef.current.push(line);
            if (queueRef.current.length > 2) queueRef.current.shift();
          }
          break;
        }
        case "voice_warning":
          pushActivity("voice", `voice: ${e.reason.toLowerCase().replace(/_/g, " ")}`);
          break;
      }
    };
    return () => es.close();
  }, [agents, pushActivity]);

  const goNext = async () => {
    await fetch("/api/next", { method: "POST" }).catch(() => {});
  };

  const phase = snap?.phase ?? "idle";
  // A viewer who connects mid-lot gets the current lot from the initial snapshot,
  // not only from a future lot_open event.
  const displayLot = lot ?? snap?.lot ?? null;
  const current = snap?.currentBidMinor ?? displayLot?.openingMinor ?? 0;
  const isLive = phase === "bidding" || phase === "countdown";

  return (
    <main className="mx-auto min-h-screen max-w-[1380px] px-5 py-6 sm:px-8">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <span className="text-[22px] font-semibold tracking-[-0.04em]">commenda</span>
          <span className="hidden text-xs text-muted sm:inline">agentic live auction</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="mr-2 flex items-center gap-2 text-xs text-muted">
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? "live-dot bg-live" : "bg-subtle"}`} />
            {connected ? "live" : "connecting"}
          </span>
          <button
            onClick={toggleSound}
            className="whitespace-nowrap rounded-lg border border-line bg-surface px-3 py-2 text-xs font-medium text-ink transition-colors hover:border-muted"
          >
            {soundOn ? "Sound on" : "Enable sound"}
          </button>
          <button
            onClick={goNext}
            className="whitespace-nowrap rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white transition-opacity hover:opacity-85"
          >
            Next lot
          </button>
          <a
            href="/dashboard"
            className="hidden whitespace-nowrap rounded-lg border border-line bg-surface px-3 py-2 text-xs font-medium text-ink transition-colors hover:border-muted sm:block"
          >
            Dashboard
          </a>
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="flex flex-col gap-5">
          {/* STAGE — the one bold element */}
          <div className="card relative overflow-hidden">
            {sold && (
              <motion.div
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 z-20 flex items-center justify-center bg-surface/92 backdrop-blur-sm"
              >
                <div className="text-center">
                  <div className="text-[clamp(3.5rem,9vw,7rem)] font-bold leading-none tracking-[-0.06em] text-live">SOLD</div>
                  <div className="mt-3 text-lg text-ink">{formatMinor(sold.amount)} USDC{sold.winner ? ` · ${sold.winner}` : ""}</div>
                </div>
              </motion.div>
            )}

            <div className="flex items-center justify-between border-b border-line px-5 py-3 text-xs">
              <span className="font-medium tracking-wide text-ink">
                {displayLot ? `LOT ${String(displayLot.id + 1).padStart(2, "0")} · ${displayLot.category.toUpperCase()}` : "STANDBY"}
              </span>
              <span className="flex items-center gap-2 text-muted">
                {displayLot ? displayLot.title : "waiting for stream"}
                {phase === "bidding" && <span className="ml-1 rounded bg-live/10 px-2 py-0.5 font-medium text-live">BIDDING OPEN</span>}
              </span>
            </div>

            <div className="grid items-center gap-6 px-6 py-8 sm:grid-cols-[200px_minmax(0,1fr)] sm:px-10 sm:py-10">
              <div className="relative mx-auto h-44 w-44 sm:h-48 sm:w-48">
                <div
                  className="stage-ring absolute inset-0 rounded-full"
                  style={{ background: `conic-gradient(from 0deg, ${displayLot?.accent ?? "#9aa6b2"}22, ${displayLot?.accent ?? "#9aa6b2"}bb, ${displayLot?.accent ?? "#9aa6b2"}22)` }}
                />
                <div className="absolute inset-3 flex items-center justify-center overflow-hidden rounded-full bg-surface">
                  {displayLot?.artSeed ? (
                    <ItemArt seed={displayLot.artSeed} size={176} className="h-full w-full" />
                  ) : (
                    <span className="text-5xl font-semibold tracking-[-0.06em] text-ink/85">
                      {displayLot ? String(displayLot.id + 1).padStart(2, "0") : "—"}
                    </span>
                  )}
                </div>
                <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded bg-surface/90 px-2 py-0.5 text-[10px] font-medium text-muted">
                  {displayLot ? `LOT ${String(displayLot.id + 1).padStart(2, "0")}` : "—"}
                </div>
              </div>

              <div>
                <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">Current bid</div>
                <div className="tabular mt-1 flex flex-wrap items-baseline gap-3">
                  <motion.span
                    key={current}
                    initial={{ opacity: 0.55, scale: 0.97 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.28, ease: "easeOut" }}
                    className="text-[clamp(3rem,7vw,5.5rem)] font-semibold leading-none tracking-[-0.06em]"
                  >
                    {formatMinor(current)}
                  </motion.span>
                  <span className="text-xl text-muted">USDC</span>
                  {phase === "countdown" && (
                    <motion.span
                      key={snap?.countdown}
                      initial={{ opacity: 0.4, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="ml-auto text-2xl font-medium text-live"
                    >
                      {snap?.countdown}s
                    </motion.span>
                  )}
                </div>
                <div className="mt-5 min-h-12 border-l-2 border-line pl-4 text-base leading-relaxed text-muted">
                  <AnimatePresence mode="wait">
                    {caption ? (
                      <motion.p key={caption} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                        {caption}
                      </motion.p>
                    ) : (
                      <motion.p key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-subtle">
                        The auctioneer is getting ready.
                      </motion.p>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </div>

          {/* BID TAPE */}
          <div className="card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-muted">Bid tape</h2>
              <span className="text-[11px] text-subtle">newest first</span>
            </div>
            <div className="flex min-h-9 flex-wrap gap-2">
              <AnimatePresence initial={false}>
                {bids.map((b) => (
                  <motion.div
                    key={b.key}
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="tabular rounded-md border border-line bg-bg px-2.5 py-1 text-xs"
                  >
                    <span className="font-semibold text-ink">{formatMinor(b.amountMinor)}</span>
                    <span className="ml-2 text-muted">{b.label}</span>
                  </motion.div>
                ))}
              </AnimatePresence>
              {bids.length === 0 && <span className="text-xs text-subtle">No bids yet on this lot.</span>}
            </div>
          </div>

          <div className="card p-5">
            <h2 className="mb-4 text-xs font-medium uppercase tracking-[0.14em] text-muted">How an agent decides</h2>
            <div className="grid gap-5 sm:grid-cols-3">
              {[
                ["01", "Watch", "It sees the live lot and checks its watchlist. No match, no bid."],
                ["02", "Decide", "Fixed rules cap the bid against budget, per-bid limit and seller allowlist. The model never moves money."],
                ["03", "Pay", "A signed x402 payment unlocks the bid. Escrow locks it, and outbid funds return immediately."],
              ].map(([n, title, body]) => (
                <div key={n}>
                  <div className="tabular text-[11px] font-medium text-subtle">{n}</div>
                  <div className="mt-1 text-sm font-semibold text-ink">{title}</div>
                  <p className="mt-1 text-xs leading-relaxed text-muted">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* RIGHT RAIL */}
        <aside className="flex flex-col gap-5">
          <div className="card p-5">
            <div className="mb-4 flex items-baseline justify-between gap-2">
              <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-muted">Delegated agents</h2>
              <span className="text-[11px] text-subtle">{agents.filter((a) => a.active).length} live · {agents.length} enrolled</span>
            </div>
            <div className="flex max-h-[460px] flex-col gap-2 overflow-y-auto pr-1">
              {agents.map((a) => {
                const spent = committed[a.id] ?? 0;
                const pct = Math.min(100, (spent / a.budgetMinor) * 100);
                const open = expanded.has(a.id);
                return (
                  <div key={a.id} className="rounded-lg border border-line p-3">
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(a.id)) next.delete(a.id);
                        else next.add(a.id);
                        return next;
                      })}
                      className="flex w-full items-start justify-between gap-2 text-left"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`h-1.5 w-1.5 rounded-full ${a.active ? "bg-settled" : "bg-subtle"}`} />
                          <span className="text-sm font-semibold text-ink">{a.label}</span>
                          <span className="text-[10px] text-subtle">{a.active ? "bidding" : "standby"}</span>
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-subtle">{a.short}</div>
                      </div>
                      <span className="tabular shrink-0 text-xs text-muted">{formatMinor(a.budgetMinor)}</span>
                    </button>
                    <div className="mt-2 h-1 overflow-hidden rounded-full bg-line">
                      <div
                        className="h-full rounded-full bg-ink transition-[width] duration-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="tabular mt-1 flex justify-between text-[10px] text-muted">
                      <span>{formatMinor(spent)} committed</span>
                      <span>per bid {formatMinor(a.perBidCapMinor)}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {a.watchlist.map((w) => (
                        <span key={w} className="rounded bg-bg px-1.5 py-0.5 text-[10px] text-muted">{w}</span>
                      ))}
                    </div>
                    <AnimatePresence initial={false}>
                      {open && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-line pt-3 text-[11px]">
                            <div>
                              <div className="text-subtle">Budget</div>
                              <div className="tabular text-ink">{formatMinor(a.budgetMinor)} USDC</div>
                            </div>
                            <div>
                              <div className="text-subtle">Per-bid cap</div>
                              <div className="tabular text-ink">{formatMinor(a.perBidCapMinor)} USDC</div>
                            </div>
                            <div>
                              <div className="text-subtle">Approval above</div>
                              <div className="tabular text-ink">{a.approvalEnabled ? `${formatMinor(a.approvalAboveMinor)} USDC` : "autonomous"}</div>
                            </div>
                            <div>
                              <div className="text-subtle">Status</div>
                              <div className="text-ink">{a.active ? "Wallet active" : "No wallet — halted"}</div>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card p-5">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-[0.14em] text-muted">Activity</h2>
            <div className="flex flex-col gap-2.5">
              <AnimatePresence initial={false}>
                {activity.map((x) => (
                  <motion.div
                    key={x.key}
                    initial={{ opacity: 0, x: 8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }}
                    className="flex gap-2 text-xs leading-snug"
                  >
                    <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                      x.tone === "sold" ? "bg-live" : x.tone === "reject" || x.tone === "voice" ? "bg-subtle" : "bg-settled"
                    }`} />
                    <span className={x.tone === "sold" ? "font-medium text-live" : "text-muted"}>{x.text}</span>
                  </motion.div>
                ))}
              </AnimatePresence>
              {activity.length === 0 && <span className="text-xs text-subtle">Waiting for the first decision.</span>}
            </div>
          </div>
        </aside>
      </div>

      <footer className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-subtle">
        <span>Arc testnet · USDC gas</span>
        <a className="underline underline-offset-2 hover:text-ink" href="https://explorer.testnet.arc.io/address/0xB1e11FCF92439A0F71daaefCC4B51c276210Ea45" target="_blank" rel="noreferrer">escrow contract</a>
        <span>bids pay a $0.001 x402 fee</span>
        <span>outbid funds refunded instantly</span>
      </footer>
    </main>
  );
}
