"use client";

import { SignOutButton } from "@/components/sign-out";
import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { motion } from "motion/react";
import { ArrowRight, ArrowUpRight, Plus } from "lucide-react";
import { formatMinor } from "@/lib/auction/lots";
import { cardArtDataUri } from "@/lib/items/card-art";
import { AgentMark } from "@/components/agent-mark";
import { ItemArt } from "@/components/item-art";
import { DitherField } from "@/components/ui/dither-field";

const HoloCard = dynamic(() => import("@/components/HoloCard"), { ssr: false });
const CircularCarousel = dynamic(() => import("@/components/CircularCarousel"), { ssr: false });

type LotStory = {
  chainLotId: string; title: string; sku: string; artSeed: string | null; category: string | null; at: number;
  outcome: "won" | "outbid"; yourBidMinor: number | null; yourBids: number; soldMinor: number | null; soldTo: string | null;
};
type LedgerAgent = {
  id: string; label: string; enabled: boolean; walletAddress: string | null;
  policy: { budgetMinor: number; perBidCapMinor: number; watchlist: string[]; maxWins: number; strategy: string };
  balanceMinor: number | null; committedMinor: number; wins: number; spentMinor: number; lots: LotStory[];
};

const STYLE_NAME: Record<string, string> = { steady: "Steady", jumper: "Jumper", sniper: "Sniper", bargain: "Bargain", collector: "Collector" };

function ago(at: number): string {
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export function Ledger({ userName }: { userName: string }) {
  const [agents, setAgents] = useState<LedgerAgent[] | null>(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const r = await fetch("/api/ledger", { cache: "no-store" });
    if (r.ok) setAgents((await r.json()).agents);
  }, []);
  useEffect(() => {
    void load();
    const t = window.setInterval(load, 8000);
    return () => window.clearInterval(t);
  }, [load]);

  // First visit: nothing to show yet — go brief an agent.
  useEffect(() => {
    if (agents && agents.length === 0) window.location.replace("/create");
  }, [agents]);

  const act = async (a: LedgerAgent, what: "recall" | "deploy" | "withdraw") => {
    setBusy(`${a.id}:${what}`);
    setNote("");
    const r = what === "withdraw"
      ? await fetch(`/api/agents/${a.id}/wallet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "withdraw" }) })
      : await fetch(`/api/agents/${a.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: what === "deploy" }) });
    const d = await r.json().catch(() => ({}));
    setBusy("");
    if (!r.ok) setNote(d.error ?? "That didn't work.");
    else if (what === "withdraw") setNote(d.amountMinor ? `${formatMinor(d.amountMinor)} USDC is on its way to your wallet.` : "Nothing left to withdraw.");
    void load();
  };

  if (!agents || agents.length === 0) {
    return <main className="min-h-screen bg-[#e9f0f5]" />;
  }

  const allWins = agents.flatMap((a) => a.lots.filter((l) => l.outcome === "won").map((l) => ({ ...l, agent: a })));
  const totalWins = allWins.length;
  const totalSpent = allWins.reduce((s, l) => s + (l.soldMinor ?? 0), 0);
  const lead = agents[agents.length - 1];
  const headline = totalWins === 0
    ? `${lead.label} hasn't won a lot yet.`
    : `${agents.length === 1 ? lead.label : "Your agents"} won ${totalWins} lot${totalWins === 1 ? "" : "s"} for ${formatMinor(totalSpent)} USDC.`;

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#e9f0f5]">
      <DitherField pattern="clouds" className="absolute inset-0" color={["#c9e3f0", "#7bbbd9", "#2f6f96"]}
        dotSize={2} intensity={0.34} speed={0.1} fps={24} interactive={false} />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(233,240,245,0.55),rgba(233,240,245,0.92)_45%)]" />

      <div className="relative z-10 mx-auto max-w-[1180px] px-5 py-6 sm:px-8">
        <header className="flex items-center justify-between">
          <span className="display-type text-[22px] font-bold text-ink">commenda</span>
          <div className="flex items-center gap-2">
            <a href="/create" className="flex items-center gap-1.5 rounded-full bg-white/80 px-3.5 py-2 font-sans text-[13px] font-bold text-ink shadow-sm hover:bg-white">
              <Plus className="size-3.5" /> New agent
            </a>
            <a href="/live" className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 font-sans text-[13px] font-bold text-white shadow-[0_8px_24px_rgba(11,63,99,0.3)]">
              Watch the floor <ArrowRight className="size-3.5" />
            </a>
            <SignOutButton />
          </div>
        </header>

        <section className="mt-14">
          <p className="font-sans text-[15px] font-bold text-ink/50">Welcome back, {userName}.</p>
          <h1 className="display-type mt-2 max-w-5xl text-[clamp(1.9rem,3.4vw,2.75rem)] font-bold text-ink">{headline}</h1>
        </section>

        {/* The trophies — flashy on purpose: this is the payoff. Past five,
            they ride a react-bits cylinder carousel instead of a row. */}
        {allWins.length > 5 && (
          <section className="mt-8">
            <CircularCarousel
              items={allWins.filter((w) => w.artSeed).map((w) => ({
                src: cardArtDataUri(w.artSeed!), alt: w.title, title: w.title,
                subtitle: `${formatMinor(w.soldMinor ?? 0)} USDC · ${w.agent.label}`,
              }))}
              preset="cylinder" cardWidth={190} aspectRatio={630 / 880} autoplay="drift" speed={0.4}
              draggable snap pauseOnHover captions fadeColor="#e9f0f5" cornerRadius={16}
            />
          </section>
        )}
        {allWins.length > 0 && allWins.length <= 5 && (
          <section className="mt-10 flex gap-6 overflow-x-auto pb-4">
            {allWins.map((w, i) => (
              <motion.figure key={w.chainLotId} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.08 }}
                className="shrink-0">
                {w.artSeed && <HoloCard image={cardArtDataUri(w.artSeed)} alt={w.title} width={200} radius={16} intensity={0.85} glare={0.6} edgeSparkle={0.7} frame={4} />}
                <figcaption className="mt-3 w-[200px]">
                  <div className="truncate font-sans text-[14px] font-bold text-ink">{w.title}</div>
                  <div className="font-sans text-[12px] font-bold text-ink/50">{formatMinor(w.soldMinor ?? 0)} USDC · {w.agent.label}</div>
                </figcaption>
              </motion.figure>
            ))}
          </section>
        )}

        <div className="mt-10 grid gap-6 lg:grid-cols-[380px_minmax(0,1fr)]">
          <div className="flex flex-col gap-5">
            {agents.map((a) => (
              <section key={a.id} className="rounded-[26px] bg-[linear-gradient(160deg,#14171a,#0b2a40)] p-6 text-white shadow-[0_24px_70px_rgba(11,63,99,0.3)]">
                <div className="flex items-center gap-3">
                  <AgentMark id={a.id} size={46} />
                  <div className="min-w-0 flex-1">
                    <div className="font-sans text-[19px] font-bold">{a.label}</div>
                    <div className="font-sans text-[12px] font-bold text-white/50">{STYLE_NAME[a.policy.strategy] ?? a.policy.strategy} · {a.policy.watchlist.join(", ")}</div>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 font-sans text-[12px] font-bold ${a.enabled ? "bg-accent/25 text-[#7fd6ff]" : "bg-white/10 text-white/60"}`}>
                    {a.enabled ? "On the floor" : "Recalled"}
                  </span>
                </div>
                <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-4">
                  <div><dt className="font-sans text-[11px] font-bold text-white/45">Wallet</dt><dd className="tabular font-sans text-[22px] font-bold">{a.balanceMinor == null ? "—" : formatMinor(a.balanceMinor)}</dd></div>
                  <div><dt className="font-sans text-[11px] font-bold text-white/45">Won</dt><dd className="tabular font-sans text-[22px] font-bold">{a.lots.filter((l) => l.outcome === "won").length} <span className="text-[13px] text-white/45">of {a.policy.maxWins} max</span></dd></div>
                  <div><dt className="font-sans text-[11px] font-bold text-white/45">Ceiling per lot</dt><dd className="tabular font-sans text-[15px] font-bold">{formatMinor(a.policy.perBidCapMinor)}</dd></div>
                  <div><dt className="font-sans text-[11px] font-bold text-white/45">Budget</dt><dd className="tabular font-sans text-[15px] font-bold">{formatMinor(a.policy.budgetMinor)}</dd></div>
                </dl>
                <div className="mt-6 flex gap-2">
                  {a.enabled ? (
                    <button type="button" disabled={Boolean(busy)} onClick={() => act(a, "recall")}
                      className="flex-1 rounded-2xl border border-white/20 py-2.5 font-sans text-[13px] font-bold hover:bg-white/10 disabled:opacity-40">Recall</button>
                  ) : (
                    <>
                      <button type="button" disabled={Boolean(busy)} onClick={() => act(a, "deploy")}
                        className="flex-1 rounded-2xl bg-white py-2.5 font-sans text-[13px] font-bold text-ink hover:bg-white/90 disabled:opacity-40">Send back in</button>
                      <button type="button" disabled={Boolean(busy)} onClick={() => act(a, "withdraw")}
                        className="flex-1 rounded-2xl border border-white/20 py-2.5 font-sans text-[13px] font-bold hover:bg-white/10 disabled:opacity-40">
                        {busy === `${a.id}:withdraw` ? "Sending…" : "Bring funds home"}
                      </button>
                    </>
                  )}
                </div>
                {a.walletAddress && (
                  <a href={`https://explorer.testnet.arc.io/address/${a.walletAddress}`} target="_blank" rel="noreferrer"
                  className="mt-3 flex items-center justify-center gap-1.5 font-sans text-[12px] font-bold text-white/55 transition hover:text-white">
                  View its wallet on ArcScan <ArrowUpRight className="size-3.5" />
                </a>
                )}
              </section>
            ))}
            {note && <p className="font-sans text-[13px] font-bold text-ink/70">{note}</p>}
          </div>

          {/* Every lot your agent fought for, in its own words */}
          <section className="rounded-[26px] border border-black/[0.06] bg-white p-6 shadow-[0_1px_2px_rgba(16,24,32,0.05),0_24px_70px_rgba(11,63,99,0.14)]">
            <h2 className="font-sans text-[15px] font-bold text-ink">What happened on the floor</h2>
            {agents.every((a) => a.lots.length === 0) ? (
              <p className="mt-4 font-sans text-[14px] text-ink/50">Nothing yet — once your agent bids, every lot it fought for shows up here.</p>
            ) : (
              <ol className="mt-4 flex flex-col">
                {agents.flatMap((a) => a.lots.map((l) => ({ ...l, agent: a }))).sort((x, y) => y.at - x.at).map((l) => (
                  <li key={`${l.agent.id}-${l.chainLotId}`} className="flex items-center gap-4 border-t border-black/[0.05] py-3.5 first:border-t-0">
                    {l.artSeed && <ItemArt seed={l.artSeed} size={48} className="shrink-0 rounded-xl" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-sans text-[14px] font-bold text-ink">{l.title}</div>
                      <div className="font-sans text-[13px] text-ink/60">
                        {l.outcome === "won"
                          ? <>Won for <b className="text-ink">{formatMinor(l.soldMinor ?? 0)}</b> after {l.yourBids} bid{l.yourBids === 1 ? "" : "s"}.</>
                          : l.soldMinor
                            ? <>Went to {formatMinor(l.yourBidMinor ?? 0)}, then stopped — {l.soldTo ?? "another bidder"} took it for {formatMinor(l.soldMinor)}.</>
                            : <>Went to {formatMinor(l.yourBidMinor ?? 0)}, then stopped. Another bidder took it.</>}
                      </div>
                    </div>
                    <span className={`shrink-0 rounded-full px-2.5 py-1 font-sans text-[12px] font-bold ${l.outcome === "won" ? "bg-win/15 text-win" : "bg-ink/[0.05] text-ink/50"}`}>
                      {l.outcome === "won" ? "Won" : "Outbid"}
                    </span>
                    <span className="hidden w-16 shrink-0 text-right font-sans text-[12px] text-ink/40 sm:block">{ago(l.at)}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
