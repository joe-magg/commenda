"use client";

import { SignOutButton } from "@/components/sign-out";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowUpRight, Mic, Volume2, VolumeX } from "lucide-react";
import type { AuctionEvent, EngineSnapshot, MindState } from "@/lib/auction/engine";
import { formatMinor, type Lot } from "@/lib/auction/lots";
import { playSfx } from "@/lib/client/sfx";
import { AgentMark } from "@/components/agent-mark";
import { AgentArena } from "@/components/agent-arena";
import { NumberTicker } from "@/components/ui/number-ticker";

export type FloorAgent = { id: string; label: string; live: boolean };
export type MyAgent = {
  id: string; label: string; enabled: boolean; strategy: string;
  ceilingMinor: number; budgetMinor: number; maxWins: number;
  walletAddress: string | null;
} | null;

type BidRow = { key: string; label: string; agentId: string; amountMinor: number; late?: boolean };
type Mind = { state: MindState; text: string; limitMinor: number | null };

const STYLE_NAME: Record<string, string> = {
  steady: "Steady", jumper: "Jumper", sniper: "Sniper", bargain: "Bargain", collector: "Collector",
};

let seq = 0;
const key = () => `${Date.now()}-${seq++}`;

export function Floor({ agents, mine }: { agents: FloorAgent[]; mine: MyAgent }) {
  const [snap, setSnap] = useState<EngineSnapshot | null>(null);
  const [lot, setLot] = useState<Lot | null>(null);
  const [bids, setBids] = useState<BidRow[]>([]);
  const [room, setRoom] = useState<string[]>([]);
  const [lastBidder, setLastBidder] = useState<string | null>(null);
  const [bidSeq, setBidSeq] = useState(0);
  const [caption, setCaption] = useState<{ key: string; text: string } | null>(null);
  const [mind, setMind] = useState<Mind | null>(null);
  const [sold, setSold] = useState<{ mine: boolean; winner: string | null; amount: number } | null>(null);
  const [wallet, setWallet] = useState<{ balanceMinor: number | null } | null>(null);
  const [enabled, setEnabled] = useState(mine?.enabled ?? false);
  const [wins, setWins] = useState(0);
  const [soundOn, setSoundOn] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const reduce = useReducedMotion();
  const soundRef = useRef(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queueRef = useRef<string[]>([]);
  const mineId = mine?.id ?? null;

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Wallet: what your agent can still spend.
  const refreshWallet = useCallback(async () => {
    if (!mineId) return;
    const r = await fetch(`/api/agents/${mineId}/wallet`, { cache: "no-store" });
    if (r.ok) setWallet(await r.json());
  }, [mineId]);
  useEffect(() => {
    void refreshWallet();
    const t = window.setInterval(refreshWallet, 6000);
    return () => window.clearInterval(t);
  }, [refreshWallet]);

  // One audio element; auctioneer lines queue behind each other.
  useEffect(() => {
    const a = new Audio();
    a.volume = 0.9;
    const next = () => {
      const url = queueRef.current.shift();
      if (url) { a.src = url; void a.play().catch(() => {}); }
    };
    a.addEventListener("ended", next);
    audioRef.current = a;
    return () => { a.pause(); a.removeEventListener("ended", next); };
  }, []);

  const sfx = (cue: Parameters<typeof playSfx>[0]) => { if (soundRef.current) playSfx(cue); };

  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onmessage = (m) => {
      let e: AuctionEvent;
      try { e = JSON.parse(m.data); } catch { return; }
      switch (e.type) {
        case "snapshot": setSnap(e.state); setRoom(e.state.participants ?? []); break;
        case "lot_open":
          setLot(e.lot); setBids([]); setRoom([]); setSold(null); queueRef.current = [];
          break;
        case "agent_join": setRoom((r) => (r.includes(e.agentId) ? r : [...r, e.agentId])); break;
        case "agent_leave": setRoom((r) => r.filter((id) => id !== e.agentId)); break;
        case "agent_mind":
          if (e.agentId === mineId) setMind({ state: e.state, text: e.text, limitMinor: e.limitMinor });
          break;
        case "bid": {
          setBids((xs) => [{ key: key(), label: e.label, agentId: e.bidder, amountMinor: e.amountMinor, late: e.late }, ...xs].slice(0, 14));
          setRoom((r) => (r.includes(e.bidder) ? r : [...r, e.bidder]));
          setLastBidder(e.bidder);
          setBidSeq((n) => n + 1);
          sfx(e.bidder === mineId ? "mine" : "bid");
          break;
        }
        case "outbid":
          if (e.previousBidder === mineId) sfx("youOutbid");
          break;
        case "countdown": sfx("countdown"); break;
        case "sold": {
          const isMine = Boolean(mineId) && e.winnerId === mineId;
          setSold({ mine: isMine, winner: e.winner, amount: e.amountMinor });
          if (isMine) { setWins((w) => w + 1); sfx("youWon"); } else sfx("sold");
          window.setTimeout(() => setSold(null), isMine ? 5200 : 3200);
          void refreshWallet();
          break;
        }
        case "caption": {
          setCaption({ key: key(), text: e.text });
          const a = audioRef.current;
          if (!soundRef.current || !e.audioUrl || !a) break;
          // Never restart or re-queue a line that is already playing/queued —
          // that is what produced the stuttered "twice… -ice".
          const playing = !a.paused && a.src.endsWith(e.audioUrl);
          if (playing || queueRef.current.includes(e.audioUrl)) break;
          if (a.paused) { a.src = e.audioUrl; void a.play().catch(() => {}); }
          else { queueRef.current.push(e.audioUrl); if (queueRef.current.length > 2) queueRef.current.shift(); }
          break;
        }
      }
    };
    return () => es.close();
  }, [mineId, refreshWallet]);

  const recall = async () => {
    if (!mineId) return;
    const r = await fetch(`/api/agents/${mineId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !enabled }),
    });
    if (r.ok) {
      setEnabled(!enabled);
      if (enabled) setMind({ state: "recalled", text: "Recalled. It won't bid again until you send it back.", limitMinor: mind?.limitMinor ?? null });
    }
  };

  const phase = snap?.phase ?? "idle";
  const displayLot = lot ?? snap?.lot ?? null;
  const hasBids = (snap?.bidCount ?? 0) > 0;
  const price = snap?.currentBidMinor ?? displayLot?.openingMinor ?? 0;
  const between = !snap?.started;
  const leaderId = snap?.leaderId ?? null;
  const youLead = Boolean(mineId) && leaderId === mineId;
  const ceiling = mind?.limitMinor ?? mine?.ceilingMinor ?? 0;
  const meter = ceiling > 0 ? Math.min(1, price / ceiling) : 0;
  const nextIn = snap?.nextAuctionAt ? Math.max(0, snap.nextAuctionAt - now) : 0;

  const phaseText =
    between ? "Between auctions"
    : phase === "intro" ? "On the block"
    : phase === "bidding" ? "Bidding"
    : phase === "countdown" ? ((snap?.countdown ?? 0) > 2 ? "Going once…" : "Going twice…")
    : phase === "sold" ? (hasBids ? "Sold" : "Passed") : "";

  const mindHeadline =
    !mine ? null
    : !enabled ? "Recalled"
    : youLead ? "Leading"
    : mind?.state === "raising" ? "Bidding"
    : mind?.state === "holding" ? "Lying in wait"
    : mind?.state === "out" ? "Out on this lot"
    : mind?.state === "skipping" ? "Sitting out"
    : mind?.state === "blocked" ? "Stopped"
    : between ? "Ready" : "Watching";

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#e9f0f5]">

      <div className="relative z-10 mx-auto max-w-[1280px] px-5 py-5 sm:px-8">
        <header className="mb-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <a href="/dashboard" className="display-type text-[22px] font-bold text-ink">commenda</a>
            <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10px] font-semibold tracking-[0.16em] ${between ? "bg-white/80 text-ink/50" : "bg-ink text-white"}`}>
              <span className={`size-1.5 rounded-full ${between ? "bg-ink/30" : "animate-pulse bg-accent"}`} />
              {between ? "OFF AIR" : "LIVE"}
            </span>
            {!between && snap && (
              <span className="font-sans text-[13px] font-bold text-ink/60">{snap.sessionName} · lot {snap.lotIndex + 1} of {snap.totalLots}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <a href="/dashboard" className="rounded-full bg-white/80 px-3.5 py-2 font-sans text-[13px] font-bold text-ink shadow-sm hover:bg-white">Dashboard</a>
            <SignOutButton />
            <button type="button" onClick={() => { soundRef.current = !soundRef.current; setSoundOn(soundRef.current); if (!soundRef.current) audioRef.current?.pause(); }}
              aria-label={soundOn ? "Mute" : "Unmute"} className="flex size-9 items-center justify-center rounded-full bg-white/80 text-ink shadow-sm hover:bg-white">
              {soundOn ? <Volume2 className="size-4" /> : <VolumeX className="size-4 text-ink/50" />}
            </button>
          </div>
        </header>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
          {/* THE STAGE — the item, its art dithered as the room's light */}
          <section className="relative min-h-[620px] overflow-hidden rounded-[26px] border border-black/[0.06] bg-white shadow-[0_1px_2px_rgba(16,24,32,0.05),0_24px_70px_rgba(11,63,99,0.16)]">

            <div className="relative flex h-full min-h-[620px] flex-col items-center px-5 pb-5 pt-5">
              <div className="flex w-full justify-end">
                <motion.span key={phaseText} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
                  className={`rounded-full px-3 py-1 font-sans text-[13px] font-bold ${phase === "countdown" ? "bg-win/15 text-win" : "bg-ink/[0.05] text-ink/70"}`}>
                  {phaseText}
                </motion.span>
              </div>

              {between ? (
                <div className="flex flex-1 flex-col items-center justify-center text-center">
                  <div className="font-sans text-[13px] font-bold uppercase tracking-[0.18em] text-ink/45">Next auction</div>
                  <div className="display-type tabular mt-2 text-[clamp(4rem,10vw,7rem)] font-bold leading-none text-ink">
                    {nextIn > 0 ? `${Math.floor(nextIn / 60000)}:${String(Math.floor((nextIn % 60000) / 1000)).padStart(2, "0")}` : "soon"}
                  </div>
                  {mine && <p className="mt-4 font-sans text-[15px] font-bold text-ink/60">{mine.label} is ready. It will join the lots it cares about.</p>}
                  {/* Skip the intermission (signed-in only; handy when recording). */}
                  <button type="button" onClick={() => { void fetch("/api/next", { method: "POST" }); }}
                    className="mt-6 rounded-full bg-ink px-5 py-2.5 font-sans text-[14px] font-bold text-white shadow-[0_8px_24px_rgba(11,63,99,0.3)] transition hover:bg-ink/90 active:scale-[0.98]">
                    Start now
                  </button>
                </div>
              ) : (
                <>
                  <AgentArena
                    members={agents.map((a) => ({ id: a.id, label: a.label }))}
                    participants={room}
                    lot={displayLot} lastBidder={lastBidder} bidSeq={bidSeq} reduce={Boolean(reduce)}
                    leaderId={leaderId} mineId={mineId}
                  />
                  <div className="-mt-2 text-center">
                    <h1 className="display-type text-[clamp(1.4rem,2.4vw,1.9rem)] font-bold text-ink">{displayLot?.title ?? "—"}</h1>
                    {displayLot && (
                      <p className="mt-1 font-sans text-[13px] font-bold capitalize text-ink/50">
                        {displayLot.category}
                      </p>
                    )}
                    <div className="mt-3 flex items-end justify-center gap-2">
                      <NumberTicker value={price / 1e6} startValue={price / 1e6} decimalPlaces={2}
                        className="display-type text-[clamp(3.2rem,7vw,5rem)] font-bold leading-none !tracking-[-0.04em] !text-ink" />
                      <span className="mb-2 font-sans text-[15px] font-bold text-ink/40">USDC</span>
                    </div>
                    <p className="mt-1 h-5 font-sans text-[14px] font-bold text-ink/60">
                      {hasBids ? (youLead ? <span className="text-win">You lead.</span> : <>{snap?.leaderLabel} leads</>) : "Opening ask"}
                    </p>
                  </div>
                </>
              )}

              <div className="mt-auto flex min-h-[56px] w-full items-end justify-center pt-3" aria-live="polite">
                <AnimatePresence mode="wait">
                  {caption && !between && (
                    <motion.div key={caption.key} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                      className="flex max-w-xl items-center gap-2.5 rounded-2xl bg-ink px-4 py-2.5 font-sans text-[14px] font-bold text-white shadow-lg">
                      <Mic className="size-4 shrink-0 text-accent" /> {caption.text}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            <AnimatePresence>
              {sold && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className={`absolute inset-0 z-30 flex items-center justify-center ${sold.mine ? "bg-[#fbf6ea]/90" : "bg-white/70"} backdrop-blur-md`}>
                  <motion.div initial={{ scale: 0.92, y: 8 }} animate={{ scale: 1, y: 0 }} transition={{ type: "spring", bounce: 0.3 }} className="text-center">
                    {sold.mine && mineId && <div className="mb-4 flex justify-center"><AgentMark id={mineId} size={72} /></div>}
                    <div className={`display-type font-bold leading-none ${sold.mine ? "text-[clamp(3rem,8vw,5.5rem)] text-win" : "text-[clamp(2.5rem,6vw,4rem)] text-ink"}`}>
                      {sold.mine ? `${mine?.label} won it.` : "Sold."}
                    </div>
                    <p className="mt-3 font-sans text-[17px] font-bold text-ink/65">
                      {sold.mine ? `${formatMinor(sold.amount)} USDC, settled on Arc. A receipt is on its way to your wallet.` : `${sold.winner ?? "Another bidder"} · ${formatMinor(sold.amount)} USDC`}
                    </p>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </section>

          {/* YOUR AGENT — the one dark object: this is why you're watching */}
          <aside className="flex flex-col gap-5">
            {mine ? (
              <section className="rounded-[26px] bg-[linear-gradient(160deg,#14171a,#0b2a40)] p-6 text-white shadow-[0_24px_70px_rgba(11,63,99,0.35)]">
                <div className="flex items-center gap-3">
                  <AgentMark id={mine.id} size={46} />
                  <div className="min-w-0 flex-1">
                    <div className="font-sans text-[19px] font-bold">{mine.label}</div>
                    <div className="font-sans text-[12px] font-bold text-white/50">Your agent · {STYLE_NAME[mine.strategy] ?? mine.strategy}</div>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 font-sans text-[12px] font-bold ${youLead ? "bg-win text-white" : "bg-white/10 text-white/80"}`}>{mindHeadline}</span>
                </div>

                <AnimatePresence mode="wait">
                  <motion.p key={mind?.text ?? "idle"} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                    className="mt-6 min-h-[64px] font-sans text-[21px] font-bold leading-snug">
                    {enabled ? (mind?.text ?? (between ? "Ready for the next auction." : "Watching the floor.")) : "Recalled. It won't bid again until you send it back."}
                  </motion.p>
                </AnimatePresence>

                {/* Price vs. your ceiling — how close to walking away. Faded when it isn't in this lot. */}
                <div className={`mt-5 transition-opacity ${mind?.state === "skipping" || between ? "opacity-30" : ""}`}>
                  <div className="flex justify-between font-sans text-[12px] font-bold text-white/50">
                    <span>Price {formatMinor(price)}</span><span>Your ceiling {formatMinor(ceiling)}</span>
                  </div>
                  <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-white/10">
                    <motion.div className={`h-full rounded-full ${youLead ? "bg-win" : meter >= 1 ? "bg-white/40" : "bg-accent"}`}
                      animate={{ width: `${between ? 0 : meter * 100}%` }} transition={{ type: "spring", bounce: 0, duration: 0.6 }} />
                  </div>
                </div>

                <dl className="mt-6 grid grid-cols-3 gap-3 border-t border-white/10 pt-5">
                  <div><dt className="font-sans text-[11px] font-bold text-white/45">Wallet</dt><dd className="tabular mt-0.5 font-sans text-[18px] font-bold">{wallet?.balanceMinor == null ? "—" : formatMinor(wallet.balanceMinor)}</dd></div>
                  <div><dt className="font-sans text-[11px] font-bold text-white/45">Budget</dt><dd className="tabular mt-0.5 font-sans text-[18px] font-bold">{formatMinor(mine.budgetMinor)}</dd></div>
                  <div><dt className="font-sans text-[11px] font-bold text-white/45">Wins</dt><dd className="tabular mt-0.5 font-sans text-[18px] font-bold">{wins} / {mine.maxWins}</dd></div>
                </dl>

                <button type="button" onClick={recall}
                  className={`mt-6 w-full rounded-2xl py-3 font-sans text-[14px] font-bold transition active:scale-[0.98] ${enabled ? "border border-white/20 text-white hover:bg-white/10" : "bg-white text-ink hover:bg-white/90"}`}>
                  {enabled ? "Recall agent" : `Send ${mine.label} back in`}
                </button>
                {mine.walletAddress && (
                  <a href={`https://explorer.testnet.arc.io/address/${mine.walletAddress}`} target="_blank" rel="noreferrer"
                  className="mt-3 flex items-center justify-center gap-1.5 font-sans text-[12px] font-bold text-white/55 transition hover:text-white">
                  View its wallet on ArcScan <ArrowUpRight className="size-3.5" />
                </a>
                )}
              </section>
            ) : (
              <section className="rounded-[26px] bg-ink p-6 text-white">
                <p className="font-sans text-[20px] font-bold leading-snug">You&apos;re watching without an agent.</p>
                <a href="/create" className="mt-5 block rounded-2xl bg-white py-3 text-center font-sans text-[14px] font-bold text-ink">Brief your agent →</a>
              </section>
            )}

            <section className="rounded-[22px] border border-black/[0.06] bg-white p-5 shadow-[0_1px_2px_rgba(16,24,32,0.05),0_16px_44px_rgba(11,63,99,0.1)]">
              <h2 className="font-sans text-[13px] font-bold text-ink/50">Bids on this lot</h2>
              <div className="mt-3 flex max-h-[300px] flex-col gap-1.5 overflow-y-auto">
                {bids.length === 0 && <span className="font-sans text-[13px] text-ink/40">No bids yet.</span>}
                <AnimatePresence initial={false}>
                  {bids.map((b) => {
                    const isMine = b.agentId === mineId;
                    return (
                      <motion.div key={b.key} layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                        className={`flex items-center gap-2.5 rounded-xl px-3 py-2 ${isMine ? "bg-ink text-white" : "bg-[#f3f6f8] text-ink"}`}>
                        <AgentMark id={b.agentId} size={22} />
                        <span className="font-sans text-[13px] font-bold">{isMine ? `You · ${b.label}` : b.label}</span>
                        {b.late && <span className={`rounded px-1.5 font-sans text-[10px] font-bold ${isMine ? "bg-win text-white" : "bg-win/15 text-win"}`}>late</span>}
                        <span className="tabular ml-auto font-sans text-[14px] font-bold">{formatMinor(b.amountMinor)}</span>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}
