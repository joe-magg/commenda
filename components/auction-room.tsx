"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { AuctionEvent, EngineSnapshot } from "@/lib/auction/engine";
import { formatMinor, type Lot } from "@/lib/auction/lots";
import { playSfx } from "@/lib/client/sfx";
import { ItemArt } from "@/components/item-art";
import { RollingNumber } from "@/components/rolling-number";
import { agentIdentity } from "@/lib/agent-identity";

export type AgentView = {
  id: string;
  label: string;
  short: string;
  budgetMinor: number;
  perBidCapMinor: number;
  watchlist: string[];
  approvalEnabled: boolean;
  approvalAboveMinor: number;
  maxWins: number;
  active: boolean;
};

type SpokenLine = { text: string; audioUrl?: string };
type BidItem = { key: string; label: string; amountMinor: number; agentId: string; at: number };
type ActivityItem = { key: string; tone: "bid" | "reject" | "outbid" | "sold" | "voice" | "join"; text: string; at: number };
type SessionInfo = { id: string; name: string; status: string; catalog: { title: string; sku: string }[] };

let seq = 0;
const nextKey = () => `${Date.now()}-${seq++}`;

export function AuctionRoom({ agents }: { agents: AgentView[] }) {
  const [snap, setSnap] = useState<EngineSnapshot | null>(null);
  const [lot, setLot] = useState<Lot | null>(null);
  const [bids, setBids] = useState<BidItem[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [caption, setCaption] = useState("");
  const [soundOn, setSoundOn] = useState(true);
  const [connected, setConnected] = useState(false);
  const [sold, setSold] = useState<{ amount: number; winner: string | null } | null>(null);
  const [committed, setCommitted] = useState<Record<string, number>>({});
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [tab, setTab] = useState<"agents" | "session">("agents");
  const reduce = useReducedMotion();

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queueRef = useRef<SpokenLine[]>([]);
  const soundRef = useRef(true);

  const pushActivity = useCallback((tone: ActivityItem["tone"], text: string) => {
    setActivity((xs) => [{ key: nextKey(), tone, text, at: Date.now() }, ...xs].slice(0, 16));
  }, []);

  // unlock Web Audio on the first gesture so sound-on-by-default actually plays
  useEffect(() => {
    const unlock = () => {
      soundRef.current && playSfx("bid");
      window.removeEventListener("pointerdown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  useEffect(() => {
    fetch("/api/sessions").then((r) => r.json()).then((d) => setSession(d.sessions?.[0] ?? null)).catch(() => {});
  }, []);

  // one persistent audio element with a bounded queue: a line finishes, newer
  // lines queue behind it, and stale lines drop if the queue grows past two.
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
          queueRef.current = [];
          break;
        case "bid":
          setBids((xs) => [{ key: nextKey(), label: e.label, amountMinor: e.amountMinor, agentId: e.bidder, at: Date.now() }, ...xs].slice(0, 10));
          setCommitted((c) => ({ ...c, [e.bidder]: e.amountMinor }));
          pushActivity("bid", `${e.label} bid ${formatMinor(e.amountMinor)}`);
          if (soundRef.current) playSfx("bid");
          break;
        case "reject":
          pushActivity("reject", `${agents.find((a) => a.id === e.agentId)?.label ?? "Agent"} held — ${e.rule.toLowerCase().replace(/_/g, " ")}`);
          break;
        case "outbid":
          setCommitted((c) => ({ ...c, [e.previousBidder]: 0 }));
          pushActivity("outbid", `${e.label} refunded — outbid`);
          if (soundRef.current) playSfx("outbid");
          break;
        case "agent_join":
          pushActivity("join", `${e.label} joined`);
          break;
        case "agent_leave":
          pushActivity("reject", `${e.label} left — ${e.reason}`);
          break;
        case "sold":
          setSold({ amount: e.amountMinor, winner: e.winner });
          pushActivity("sold", `SOLD ${formatMinor(e.amountMinor)}${e.winner ? ` to ${e.winner}` : ""}`);
          if (soundRef.current) playSfx("sold");
          window.setTimeout(() => setSold(null), 2600);
          break;
        case "countdown":
          if (soundRef.current) playSfx("countdown");
          break;
        case "caption": {
          const line: SpokenLine = { text: e.text, audioUrl: e.audioUrl };
          if (!soundRef.current || !e.audioUrl) { setCaption(e.text); break; }
          const a = audioRef.current;
          if (!a) { setCaption(e.text); break; }
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

  const goNext = async () => { await fetch("/api/next", { method: "POST" }).catch(() => {}); };

  const phase = snap?.phase ?? "idle";
  const displayLot = lot ?? snap?.lot ?? null;
  const current = snap?.currentBidMinor ?? displayLot?.openingMinor ?? 0;
  const isLive = phase === "bidding" || phase === "countdown";

  return (
    <main className="mx-auto min-h-screen max-w-[1180px] px-5 py-6 sm:px-8">
      <header className="mb-5 flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <span className="display-type text-[23px] font-semibold">commenda</span>
          <span className="hidden text-xs text-muted sm:inline">agentic live auction</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="mr-1 flex items-center gap-2 text-xs text-muted">
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? "live-dot bg-accent" : "bg-subtle"}`} />
            {connected ? "live" : "connecting"}
          </span>
          <button onClick={toggleSound} aria-pressed={soundOn}
            className="whitespace-nowrap rounded-xl border border-white/70 bg-white/55 px-3 py-2 text-xs font-medium text-ink shadow-sm backdrop-blur-xl transition-transform active:scale-[0.97]">
            {soundOn ? "Sound on" : "Sound off"}
          </button>
          <button onClick={goNext}
            className="whitespace-nowrap rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white shadow-[0_6px_18px_rgba(0,169,214,0.35)] transition-transform active:scale-[0.97]">
            Next lot
          </button>
          <a href="/dashboard"
            className="hidden whitespace-nowrap rounded-xl border border-white/70 bg-white/55 px-3 py-2 text-xs font-medium text-ink shadow-sm backdrop-blur-xl transition-transform active:scale-[0.97] sm:block">
            Dashboard
          </a>
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section className="flex flex-col gap-5">
          {/* CENTERED GLASS STAGE — the one bold element */}
          <div className="glass-stage relative flex min-h-[440px] flex-col items-center overflow-hidden px-6 py-7 sm:min-h-[480px]">
            <AnimatePresence>
              {sold && (
                <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                  className="absolute inset-0 z-20 flex items-center justify-center bg-white/60 backdrop-blur-xl">
                  <div className="text-center">
                    <div className="display-type text-[clamp(3.5rem,10vw,7rem)] font-bold text-win">SOLD</div>
                    <div className="mt-2 text-lg text-ink">{formatMinor(sold.amount)} · {sold.winner ?? "unknown"}</div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="flex w-full items-center justify-between text-[11px]">
              <span className="font-semibold tracking-[0.12em] text-muted">
                {displayLot ? `LOT ${String(displayLot.id + 1).padStart(2, "0")} · ${displayLot.category.toUpperCase()}` : "STANDBY"}
              </span>
              <span className="text-subtle">{displayLot ? displayLot.title : "waiting for stream"}</span>
            </div>

            <div className="relative my-5 flex items-center justify-center">
              <div className={`stage-ring absolute h-[260px] w-[260px] rounded-full sm:h-[290px] sm:w-[290px]`}
                style={{ background: `conic-gradient(from 0deg, rgba(0,169,214,0.10), rgba(0,169,214,0.55), rgba(120,180,210,0.15))` }} />
              <motion.div
                animate={reduce ? {} : { rotate: 360 }}
                transition={{ duration: 26, ease: "linear", repeat: Infinity }}
                className="relative h-[230px] w-[230px] rounded-full shadow-[0_22px_60px_rgba(15,70,95,0.28)] sm:h-[260px] sm:w-[260px]"
              >
                {displayLot?.artSeed ? (
                  <ItemArt seed={displayLot.artSeed} size={260} className="h-full w-full rounded-full" />
                ) : (
                  <div className="h-full w-full rounded-full bg-white/70" />
                )}
              </motion.div>
            </div>

            <div className="text-center">
              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted">Current bid</div>
              <div className="mt-1 flex flex-wrap items-baseline justify-center gap-2">
                <RollingNumber value={formatMinor(current)} className="display-type text-[clamp(3.2rem,8vw,5.2rem)] font-semibold" />
                <span className="text-xl text-muted">USDC</span>
                {phase === "countdown" && (
                  <motion.span key={snap?.countdown} initial={{ opacity: 0.4, y: -4 }} animate={{ opacity: 1, y: 0 }}
                    className="ml-2 text-2xl font-semibold text-accent">{snap?.countdown}s</motion.span>
                )}
              </div>
              <div className="mx-auto mt-4 min-h-12 max-w-md border-l-2 border-accent/40 pl-4 text-left text-[15px] leading-relaxed text-muted">
                <AnimatePresence mode="wait">
                  {caption ? (
                    <motion.p key={caption} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>{caption}</motion.p>
                  ) : (
                    <motion.p key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-subtle">
                      The auctioneer is getting ready.
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>
              {isLive && <div className="mt-2 text-[10px] font-medium tracking-[0.1em] text-accent">BIDDING OPEN</div>}
            </div>
          </div>

          {/* VERTICAL BID TAPE */}
          <div className="card p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">Bid tape</h2>
              <span className="text-[10px] text-subtle">newest first</span>
            </div>
            <div className="flex max-h-[190px] flex-col gap-1.5 overflow-y-auto">
              <AnimatePresence initial={false}>
                {bids.map((b) => {
                  const id = agentIdentity(b.agentId);
                  return (
                    <motion.div key={b.key} initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
                      className="flex items-center gap-3 rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-xs shadow-sm">
                      <span className="text-sm" style={{ color: id.color }}>{id.glyph}</span>
                      <span className="font-semibold text-ink">{b.label}</span>
                      <span className="tabular ml-auto font-semibold text-accent-deep">{formatMinor(b.amountMinor)}</span>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
              {bids.length === 0 && <span className="text-xs text-subtle">No bids yet on this lot.</span>}
            </div>
          </div>
        </section>

        <aside className="flex flex-col gap-4">
          <div className="card overflow-hidden p-4">
            <div className="mb-3 flex gap-1 rounded-xl bg-white/45 p-1">
              {(["agents", "session"] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)}
                  className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium capitalize transition-transform active:scale-[0.97] ${tab === t ? "bg-white text-ink shadow-sm" : "text-muted"}`}>
                  {t === "agents" ? "Agents" : "Session"}
                </button>
              ))}
            </div>

            {tab === "agents" ? (
              <div className="flex max-h-[420px] flex-col gap-2 overflow-y-auto pr-1">
                {agents.map((a) => {
                  const id = agentIdentity(a.id);
                  const spent = committed[a.id] ?? 0;
                  const pct = Math.min(100, (spent / a.budgetMinor) * 100);
                  return (
                    <div key={a.id} className="rounded-xl border border-white/70 bg-white/45 p-3">
                      <div className="flex items-center gap-2">
                        <span className="flex h-6 w-6 items-center justify-center rounded-lg text-xs font-semibold"
                          style={{ background: id.soft, color: id.color }}>{id.glyph}</span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-semibold text-ink">{a.label}</span>
                            <span className={`h-1.5 w-1.5 rounded-full ${a.active ? "bg-accent" : "bg-subtle"}`} />
                          </div>
                          <div className="truncate text-[10px] text-subtle">{a.short}</div>
                        </div>
                        <span className="tabular ml-auto text-xs text-muted">{formatMinor(a.budgetMinor)}</span>
                      </div>
                      <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/70">
                        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: id.color }} />
                      </div>
                      <div className="tabular mt-1 flex justify-between text-[10px] text-muted">
                        <span>{formatMinor(spent)} committed</span>
                        <span>stop after {a.maxWins}</span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {a.watchlist.map((w) => <span key={w} className="rounded bg-white/60 px-1.5 py-0.5 text-[10px] text-muted">{w}</span>)}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div>
                <h3 className="text-sm font-semibold text-ink">{session?.name ?? "Loading…"}</h3>
                <span className="text-[10px] capitalize text-subtle">{session?.status ?? ""}</span>
                <div className="mt-3 flex flex-col gap-1.5">
                  {session?.catalog.map((item, i) => (
                    <div key={item.sku} className={`flex items-center justify-between rounded-lg px-2 py-1.5 text-xs ${displayLot?.id === i ? "bg-accent/10 text-accent-deep" : "bg-white/45 text-muted"}`}>
                      <span className="truncate">{item.title}</span>
                      <span className="font-mono text-[9px] text-subtle">{item.sku}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="card p-4">
            <h2 className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted">Activity</h2>
            <div className="flex max-h-[200px] flex-col gap-2 overflow-y-auto">
              <AnimatePresence initial={false}>
                {activity.map((x) => (
                  <motion.div key={x.key} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
                    className="flex gap-2 text-xs leading-snug">
                    <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                      x.tone === "sold" ? "bg-win" : x.tone === "join" ? "bg-accent" : x.tone === "bid" ? "bg-accent-deep" : "bg-subtle"
                    }`} />
                    <span className={x.tone === "sold" ? "font-medium text-win" : "text-muted"}>{x.text}</span>
                  </motion.div>
                ))}
              </AnimatePresence>
              {activity.length === 0 && <span className="text-xs text-subtle">Waiting for the first decision.</span>}
            </div>
          </div>

          <div className="card p-4 text-[11px] leading-relaxed text-muted">
            <span className="font-medium text-ink">Decision loop — </span>
            watch the lot, check the watchlist, enforce budget + caps in code, then pay per bid via x402. The model never moves money.
          </div>
        </aside>
      </div>

      <footer className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-subtle">
        <span>Arc testnet · USDC gas</span>
        <a className="underline underline-offset-2 hover:text-ink" href="https://explorer.testnet.arc.io/address/0xB1e11FCF92439A0F71daaefCC4B51c276210Ea45" target="_blank" rel="noreferrer">escrow contract</a>
        <span>bids pay a $0.001 x402 fee</span>
        <span>outbid funds refunded instantly</span>
      </footer>
    </main>
  );
}
