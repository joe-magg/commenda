"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { AuctionEvent, EngineSnapshot } from "@/lib/auction/engine";
import { formatMinor, type Lot } from "@/lib/auction/lots";
import { playSfx } from "@/lib/client/sfx";
import { agentIdentity } from "@/lib/agent-identity";
import { AgentArena } from "@/components/agent-arena";
import { AgentMark } from "@/components/agent-mark";
import { ArcBadge } from "@/components/arc-badge";
import { BorderBeam } from "@/components/ui/border-beam";
import { MagicCard } from "@/components/ui/magic-card";
import { NumberTicker } from "@/components/ui/number-ticker";
import { Dock, DockIcon } from "@/components/ui/dock";
import { Volume2, VolumeX, SkipForward, LayoutDashboard } from "lucide-react";

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
  /** True when the signed-in user owns this agent — financials render only for these. */
  owned?: boolean;
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
  const [soundOn, setSoundOn] = useState(true);
  const [sold, setSold] = useState<{ amount: number; winner: string | null } | null>(null);
  const [committed, setCommitted] = useState<Record<string, number>>({});
  const [lastBidder, setLastBidder] = useState<string | null>(null);
  const [bidSeq, setBidSeq] = useState(0);
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
          setSold(null);
          setCommitted({});
          queueRef.current = [];
          break;
        case "bid":
          setBids((xs) => [{ key: nextKey(), label: e.label, amountMinor: e.amountMinor, agentId: e.bidder, at: Date.now() }, ...xs].slice(0, 10));
          setCommitted((c) => ({ ...c, [e.bidder]: e.amountMinor }));
          setLastBidder(e.bidder);
          setBidSeq((n) => n + 1);
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
        case "unsold":
          pushActivity("reject", `Lot ${e.lotId + 1} passed — no bids`);
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
          if (!soundRef.current || !e.audioUrl) break;
          const a = audioRef.current;
          if (!a) break;
          if (a.paused) {
            queueRef.current = [];
            a.src = e.audioUrl;
            a.currentTime = 0;
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
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section className="flex flex-col gap-5">
          {/* CENTERED STAGE — the HoloCard is the one focal point */}
          <div className="glass-stage relative flex min-h-[560px] flex-col items-center overflow-hidden px-6 py-7 sm:min-h-[600px]">
            {!reduce && isLive && <BorderBeam size={90} duration={9} colorFrom="#00a9d6" colorTo="#7fd6ff" borderWidth={2} />}
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

            <div className="relative mt-1 flex w-full items-center justify-center">
              <AgentArena
                members={agents.map((a) => ({ id: a.id, label: a.label, live: a.active }))}
                lot={displayLot}
                lastBidder={lastBidder}
                bidSeq={bidSeq}
                reduce={Boolean(reduce)}
              />
            </div>

            <div className="flex flex-col items-center text-center">
              <div className="max-w-md text-[16px] font-medium leading-snug text-ink">
                {displayLot?.title ?? "Preparing the next lot"}
              </div>
              <NumberTicker
                value={current / 1_000_000}
                startValue={current / 1_000_000}
                decimalPlaces={2}
                className="mt-1.5 display-type text-[clamp(2.6rem,6vw,4rem)] font-semibold !text-ink"
              />
              {/* Arc pill meshes the currency with the chain this runs on. */}
              <ArcBadge className="mt-1" />
              {phase === "countdown" && (
                <motion.div key={snap?.countdown} initial={{ opacity: 0.4, y: -4 }} animate={{ opacity: 1, y: 0 }}
                  className="mt-1.5 text-xl font-semibold text-ink">{snap?.countdown}s</motion.div>
              )}
            </div>
          </div>

          {/* VERTICAL BID TAPE */}
          <div className="card p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">Bid tape</h2>
              <span className="text-[10px] text-subtle">newest first</span>
            </div>
            <div className="max-h-[190px] overflow-y-auto">
              {bids.length === 0 ? (
                <span className="text-xs text-subtle">No bids yet on this lot.</span>
              ) : (
                // Newest first — matching the label. AnimatedList internally
                // reverses its children, which is what made the tape read as
                // impossible descending bids.
                <AnimatePresence initial={false}>
                  {bids.map((b) => {
                    const id = agentIdentity(b.agentId);
                    return (
                      <motion.div key={b.key} layout
                        initial={{ opacity: 0, scale: 0.96, y: -6 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.96 }}
                        transition={{ type: "spring", bounce: 0, duration: 0.3 }}
                        className="mx-auto mb-1.5 w-full">
                        <div className="flex items-center gap-3 rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-xs shadow-sm">
                          <span className="text-sm" style={{ color: id.color }}>{id.glyph}</span>
                          <span className="font-semibold text-ink">{b.label}</span>
                          <span className="tabular ml-auto font-semibold text-accent-deep">{formatMinor(b.amountMinor)}</span>
                        </div>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              )}
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
                  // Financials (budget, committed, win cap) are private to the
                  // owner — spectators see identity and status only.
                  const spent = a.owned ? (committed[a.id] ?? 0) : 0;
                  const pct = a.owned && a.budgetMinor > 0 ? Math.min(100, (spent / a.budgetMinor) * 100) : 0;
                  return (
                    <MagicCard key={a.id} gradientSize={180} gradientColor="#0d9ec4" className="rounded-xl border border-white/70 bg-white/45 p-3">
                      <div className="flex items-center gap-2">
                        <AgentMark id={a.id} size={26} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-semibold text-ink">{a.label}</span>
                            <span className={`h-1.5 w-1.5 rounded-full ${a.active ? "bg-accent" : "bg-subtle"}`} />
                          </div>
                          <div className="truncate text-[10px] text-subtle">{a.short}</div>
                        </div>
                        {a.owned && (
                          <span className="tabular ml-auto text-xs text-muted">{formatMinor(a.budgetMinor)}</span>
                        )}
                      </div>
                      {a.owned && (
                        <>
                          <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/70">
                            <div className="h-full rounded-full transition-[width] duration-500 bg-accent" style={{ width: `${pct}%` }} />
                          </div>
                          <div className="tabular mt-1 flex justify-between text-[10px] text-muted">
                            <span>{formatMinor(spent)} committed</span>
                            <span>stop after {a.maxWins}</span>
                          </div>
                        </>
                      )}
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {a.watchlist.map((w) => <span key={w} className="rounded bg-white/60 px-1.5 py-0.5 text-[10px] text-muted">{w}</span>)}
                      </div>
                    </MagicCard>
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

        </aside>
      </div>

      <footer className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-subtle">
        <span>Arc testnet · USDC gas</span>
        <a className="underline underline-offset-2 hover:text-ink" href="https://explorer.testnet.arc.io/address/0xB1e11FCF92439A0F71daaefCC4B51c276210Ea45" target="_blank" rel="noreferrer">escrow contract</a>
        <span>bids pay a $0.001 x402 fee</span>
        <span>outbid funds refunded instantly</span>
      </footer>

      <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center">
        <Dock className="pointer-events-auto !mt-0 border-white/70 bg-white/60 shadow-[0_12px_40px_rgba(15,60,85,0.18)]">
          <DockIcon onClick={toggleSound} aria-label={soundOn ? "Mute" : "Enable sound"} title={soundOn ? "Sound on" : "Sound off"}>
            {soundOn ? <Volume2 className="size-5 text-ink" /> : <VolumeX className="size-5 text-muted" />}
          </DockIcon>
          <DockIcon onClick={goNext} aria-label="Next lot" title="Next lot">
            <SkipForward className="size-5 text-accent-deep" />
          </DockIcon>
          <a href="/dashboard" aria-label="Dashboard" title="Dashboard">
            <DockIcon>
              <LayoutDashboard className="size-5 text-ink" />
            </DockIcon>
          </a>
        </Dock>
      </div>
    </main>
  );
}
