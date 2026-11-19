"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useAccount, useSwitchChain, useWriteContract } from "wagmi";
import { parseAbiItem } from "viem";
import { Check, Copy, Minus, Plus } from "lucide-react";
import { DitherField } from "@/components/ui/dither-field";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { AgentMark } from "@/components/agent-mark";

const USDC = "0x3600000000000000000000000000000000000000" as const;
const TRANSFER = [parseAbiItem("function transfer(address to, uint256 amount) returns (bool)")] as const;
const ARC_TESTNET = 5042002;

type Style = "steady" | "jumper" | "sniper" | "bargain";
const STYLES: { key: Style; phrase: string; title: string; blurb: string; path: string }[] = [
  { key: "steady", phrase: "raises steadily", title: "Steady", blurb: "Answers every bid by the minimum, right up to your ceiling.", path: "M4 40 H14 V34 H24 V28 H34 V22 H44 V16 H54 V10 H60" },
  { key: "jumper", phrase: "opens with big jumps", title: "Jumper", blurb: "Leaps early to thin the field, then raises like everyone else.", path: "M4 40 H12 V24 H22 V12 H34 V9 H46 V6 H60" },
  { key: "sniper", phrase: "waits for the final seconds", title: "Sniper", blurb: "Silent while others bid. Strikes as the countdown runs out.", path: "M4 40 H46 V40 L50 8 H60" },
  { key: "bargain", phrase: "only chases a bargain", title: "Bargain", blurb: "Bids while the price is a steal; walks away early.", path: "M4 40 H16 V34 H28 V30 H40 V30 H60" },
];
const CATEGORIES = ["electronics", "art", "collectibles"] as const;

const usd = (minor: number) => (minor / 1_000_000).toFixed(2);

type Draft = { name: string; categories: string[]; style: Style; ceiling: number; budget: number; wins: number };
type Wallet = { address: string; balanceMinor: number | null; readyMinor: number; grantAvailable: boolean; grantMinor: number };

/** An inline, sentence-embedded stepper for USDC amounts. */
function Amount({ value, onChange, step, min, max, label }: {
  value: number; onChange: (v: number) => void; step: number; min: number; max: number; label: string;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  return (
    <span className="inline-flex items-center gap-1 align-baseline">
      <button type="button" aria-label={`Lower ${label}`} onClick={() => onChange(clamp(value - step))}
        className="inline-flex size-7 items-center justify-center rounded-full text-ink/45 transition hover:bg-ink/5 hover:text-ink active:scale-95">
        <Minus className="size-3.5" />
      </button>
      <span className="tabular border-b-2 border-accent pb-0.5 text-accent-deep" aria-live="polite">{usd(value)}</span>
      <button type="button" aria-label={`Raise ${label}`} onClick={() => onChange(clamp(value + step))}
        className="inline-flex size-7 items-center justify-center rounded-full text-ink/45 transition hover:bg-ink/5 hover:text-ink active:scale-95">
        <Plus className="size-3.5" />
      </button>
    </span>
  );
}

export function CreateAgent() {
  const [step, setStep] = useState<"brief" | "fund">("brief");
  const [draft, setDraft] = useState<Draft>({
    name: "", categories: ["art"], style: "sniper", ceiling: 2_500_000, budget: 5_000_000, wins: 1,
  });
  const [agent, setAgent] = useState<{ id: string; label: string; walletAddress: string } | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [market, setMarket] = useState<Record<string, { lots: number; lowMinor: number; medianMinor: number; highMinor: number }>>({});

  useEffect(() => {
    fetch("/api/market", { cache: "no-store" }).then((r) => r.json()).then((d) => setMarket(d.categories ?? {})).catch(() => {});
  }, []);

  const { isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const style = STYLES.find((s) => s.key === draft.style)!;
  const name = draft.name.trim() || "Your agent";
  const validName = /^[A-Za-z][A-Za-z0-9 '-]{0,23}$/.test(draft.name.trim());
  const canCreate = validName && draft.categories.length > 0 && draft.ceiling <= draft.budget;

  const toggleCategory = (c: string) =>
    setDraft((d) => ({
      ...d,
      categories: d.categories.includes(c) ? d.categories.filter((x) => x !== c) : [...d.categories, c],
    }));

  const create = async () => {
    setBusy(true);
    setError("");
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: draft.name.trim(), strategy: draft.style, watchlist: draft.categories,
        perBidCapMinor: draft.ceiling, budgetMinor: draft.budget, maxWins: draft.wins,
        approvalEnabled: false, approvalAboveMinor: 0,
      }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(d.error ?? "Couldn't create the agent."); return; }
    setAgent(d.agent);
    setStep("fund");
  };

  const refreshWallet = useCallback(async () => {
    if (!agent) return;
    const r = await fetch(`/api/agents/${agent.id}/wallet`, { cache: "no-store" });
    if (r.ok) setWallet(await r.json());
  }, [agent]);

  useEffect(() => {
    if (step !== "fund") return;
    void refreshWallet();
    const t = window.setInterval(refreshWallet, 3000);
    return () => window.clearInterval(t);
  }, [step, refreshWallet]);

  const fundFromWallet = async () => {
    if (!agent) return;
    setError("");
    setBusy(true);
    try {
      if (chainId !== ARC_TESTNET) await switchChainAsync({ chainId: ARC_TESTNET });
      await writeContractAsync({
        address: USDC, abi: TRANSFER, functionName: "transfer",
        args: [agent.walletAddress as `0x${string}`, BigInt(draft.budget)],
        chainId: ARC_TESTNET,
      });
    } catch (e) {
      const raw = e instanceof Error ? e.message : "";
      setError(/denied|rejected/i.test(raw) ? "Transfer declined in your wallet." : "The transfer didn't go through — check you have testnet USDC on Arc.");
    } finally {
      setBusy(false);
    }
  };

  const grant = async () => {
    if (!agent) return;
    setBusy(true);
    setError("");
    const r = await fetch(`/api/agents/${agent.id}/wallet`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "grant" }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) setError(d.error ?? "Grant failed.");
    void refreshWallet();
  };

  const deploy = async () => {
    if (!agent) return;
    setBusy(true);
    const r = await fetch(`/api/agents/${agent.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }),
    });
    if (r.ok) { window.location.href = "/live"; return; }
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    setError(d.error ?? "Couldn't deploy.");
  };

  const funded = (wallet?.balanceMinor ?? 0) >= (wallet?.readyMinor ?? Infinity);

  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden bg-[#e9f0f5]">
      {/* The landing's material — the same dot texture and ramp, as weather, not as a picture. */}
      <DitherField
        pattern="clouds"
        className="absolute inset-0"
        color={["#c9e3f0", "#7bbbd9", "#2f6f96"]}
        dotSize={2}
        intensity={0.42}
        speed={0.12}
        fps={30}
        interactive={false}
      />
      <div className="absolute inset-0 bg-[radial-gradient(900px_620px_at_50%_48%,rgba(233,240,245,0.96),rgba(233,240,245,0.55)_60%,transparent)]" />

      <div className="relative z-10 mx-auto flex w-full max-w-[880px] flex-1 flex-col justify-center px-5 py-12">
        <div className="mb-7 flex items-center justify-between">
          <a href="/" className="display-type text-[22px] font-bold text-ink">commenda</a>
          <ol className="flex items-center gap-4 font-sans text-[13px] font-bold">
            {(["Brief", "Fund", "Floor"] as const).map((s, i) => {
              const active = (step === "brief" && i === 0) || (step === "fund" && i === 1);
              const done = step === "fund" && i === 0;
              return (
                <li key={s} className={`flex items-center gap-1.5 ${active ? "text-ink" : done ? "text-accent-deep" : "text-ink/35"}`}>
                  <span className={`flex size-5 items-center justify-center rounded-full text-[11px] ${active ? "bg-ink text-white" : done ? "bg-accent/15" : "bg-ink/[0.06]"}`}>
                    {done ? <Check className="size-3" /> : i + 1}
                  </span>
                  {s}
                </li>
              );
            })}
          </ol>
        </div>

        <AnimatePresence mode="wait">
          {step === "brief" ? (
            <motion.section key="brief" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}
              transition={{ type: "spring", bounce: 0, duration: 0.45 }}>
              <h1 className="display-type text-[clamp(2.2rem,5vw,3.4rem)] font-bold text-ink">Brief your agent.</h1>
              <p className="mt-2 font-sans text-[16px] font-bold text-ink/70">Set the rules once. It bids on its own — and never past them.</p>

              <div className="mt-7 rounded-[22px] border border-black/[0.06] bg-white p-7 shadow-[0_1px_2px_rgba(16,24,32,0.05),0_24px_70px_rgba(11,63,99,0.18)] sm:p-9">
                {/* The brief IS the form: a sentence you write. */}
                <p className="font-sans text-[clamp(1.25rem,2.4vw,1.6rem)] font-bold leading-[1.9] text-ink">
                  <input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value.slice(0, 24) })}
                    placeholder="Name it"
                    aria-label="Agent name"
                    size={Math.max(7, draft.name.length + 1)}
                    className="border-b-2 border-dashed border-accent bg-transparent text-accent-deep outline-none placeholder:text-accent/50 focus:border-solid"
                  />{" "}
                  shops for{" "}
                  {CATEGORIES.map((c, i) => (
                    <span key={c}>
                      <button type="button" onClick={() => toggleCategory(c)} aria-pressed={draft.categories.includes(c)}
                        className={`rounded-full px-3 py-0.5 align-baseline transition active:scale-[0.97] ${
                          draft.categories.includes(c) ? "bg-ink text-white" : "bg-ink/[0.05] text-ink/40 hover:text-ink/70"}`}>
                        {c}
                      </button>
                      {i < CATEGORIES.length - 1 ? " " : ""}
                    </span>
                  ))}
                  . It <span className="border-b-2 border-accent text-accent-deep">{style.phrase}</span>, never pays more than{" "}
                  <Amount label="ceiling" value={draft.ceiling} step={250_000} min={500_000} max={10_000_000}
                    onChange={(v) => setDraft({ ...draft, ceiling: v, budget: Math.max(draft.budget, v) })} />{" "}
                  for a lot, spends no more than{" "}
                  <Amount label="budget" value={draft.budget} step={500_000} min={500_000} max={50_000_000}
                    onChange={(v) => setDraft({ ...draft, budget: Math.max(v, draft.ceiling) })} />{" "}
                  in all, and stops after{" "}
                  <span className="inline-flex items-center gap-1 align-baseline">
                    <button type="button" aria-label="Fewer wins" onClick={() => setDraft({ ...draft, wins: Math.max(1, draft.wins - 1) })}
                      className="inline-flex size-7 items-center justify-center rounded-full text-ink/45 hover:bg-ink/5 hover:text-ink"><Minus className="size-3.5" /></button>
                    <span className="tabular border-b-2 border-accent pb-0.5 text-accent-deep">{draft.wins}</span>
                    <button type="button" aria-label="More wins" onClick={() => setDraft({ ...draft, wins: Math.min(5, draft.wins + 1) })}
                      className="inline-flex size-7 items-center justify-center rounded-full text-ink/45 hover:bg-ink/5 hover:text-ink"><Plus className="size-3.5" /></button>
                  </span>{" "}
                  {draft.wins === 1 ? "win" : "wins"}.
                </p>

                {/* What lots actually sell for — so the ceiling can compete. */}
                {(() => {
                  const seen = draft.categories.filter((c) => market[c]?.lots);
                  if (seen.length === 0) return null;
                  const outpriced = seen.filter((c) => draft.ceiling < market[c].medianMinor);
                  return (
                    <p className="mt-4 font-sans text-[13px] leading-relaxed text-ink/60">
                      Recently {seen.map((c, i) => (
                        <span key={c}>{i > 0 ? (i === seen.length - 1 ? " and " : ", ") : ""}{c} sold for <b className="tabular text-ink/80">{usd(market[c].lowMinor)}–{usd(market[c].highMinor)}</b></span>
                      ))}.{" "}
                      {outpriced.length > 0 && (
                        <span className="font-bold text-guard">
                          At {usd(draft.ceiling)}, {name} will usually be outbid on {outpriced.join(" and ")}.
                        </span>
                      )}
                    </p>
                  );
                })()}

                {/* Style: pick by shape — how each one bids over a lot. */}
                <div className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-4" role="radiogroup" aria-label="Bidding style">
                  {STYLES.map((s) => {
                    const on = draft.style === s.key;
                    return (
                      <button key={s.key} type="button" role="radio" aria-checked={on}
                        onClick={() => setDraft({ ...draft, style: s.key })}
                        className={`group rounded-2xl border p-3.5 text-left transition active:scale-[0.98] ${
                          on ? "border-ink bg-ink text-white shadow-[0_12px_30px_rgba(11,63,99,0.25)]" : "border-black/[0.07] bg-[#f5f8fa] text-ink hover:border-black/15"}`}>
                        <svg viewBox="0 0 64 46" className="h-11 w-full" aria-hidden="true">
                          <path d="M4 42 H60" stroke="currentColor" strokeOpacity="0.15" strokeWidth="1.5" />
                          <motion.path d={s.path} fill="none" stroke={on ? "#7fd6ff" : "#007f9f"} strokeWidth="2.6"
                            strokeLinecap="round" strokeLinejoin="round"
                            initial={false} animate={{ pathLength: on ? [0, 1] : 1 }} transition={{ duration: on ? 0.9 : 0, ease: "easeInOut" }} />
                        </svg>
                        <div className="mt-2 font-sans text-[14px] font-bold">{s.title}</div>
                        <div className={`mt-0.5 font-sans text-[12px] leading-snug ${on ? "text-white/70" : "text-ink/55"}`}>{s.blurb}</div>
                      </button>
                    );
                  })}
                </div>

                <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
                  <p className="max-w-sm font-sans text-[13px] leading-relaxed text-ink/55">
                    These limits are enforced by code on every bid — not by the agent. You can recall it at any moment.
                  </p>
                  <ShimmerButton onClick={create} disabled={!canCreate || busy}
                    background="linear-gradient(110deg,#14171a,#26323c)" shimmerColor="#00a9d6" shimmerSize="0.08em" borderRadius="14px"
                    className="px-6 py-3.5 font-sans text-[15px] font-bold text-white shadow-none disabled:opacity-40">
                    {busy ? "Creating…" : `Create ${validName ? name : "agent"} →`}
                  </ShimmerButton>
                </div>
                {draft.name && !validName && <p className="mt-3 font-sans text-[13px] text-guard">Names start with a letter: letters, numbers, spaces, &apos; or -.</p>}
                {error && <p className="mt-3 font-sans text-[13px] text-guard">{error}</p>}
              </div>
            </motion.section>
          ) : agent && (
            <motion.section key="fund" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              transition={{ type: "spring", bounce: 0, duration: 0.45 }}>
              <h1 className="display-type text-[clamp(2.2rem,5vw,3.4rem)] font-bold text-ink">Fund {agent.label}.</h1>
              <p className="mt-2 font-sans text-[16px] font-bold text-ink/70">
                It gets its own wallet. It can only ever spend what you put in it.
              </p>

              <div className="mt-7 grid gap-5 rounded-[22px] border border-black/[0.06] bg-white p-7 shadow-[0_1px_2px_rgba(16,24,32,0.05),0_24px_70px_rgba(11,63,99,0.18)] sm:grid-cols-[1fr_auto] sm:p-9">
                <div>
                  <div className="flex items-center gap-3">
                    <AgentMark id={agent.id} size={52} />
                    <div>
                      <div className="font-sans text-[18px] font-bold text-ink">{agent.label}</div>
                      <button type="button"
                        onClick={() => { void navigator.clipboard.writeText(agent.walletAddress); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }}
                        className="flex items-center gap-1.5 font-mono text-[12px] text-ink/50 hover:text-ink">
                        {agent.walletAddress.slice(0, 10)}…{agent.walletAddress.slice(-6)}
                        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                      </button>
                    </div>
                  </div>

                  <div className="mt-6 font-sans text-[12px] font-bold uppercase tracking-[0.14em] text-ink/40">Agent wallet</div>
                  <div className="display-type tabular mt-1 text-[clamp(3rem,7vw,4.5rem)] font-bold text-ink">
                    {wallet?.balanceMinor == null ? "—" : usd(wallet.balanceMinor)}
                    <span className="ml-2 font-sans text-[18px] font-bold text-ink/40">USDC</span>
                  </div>
                  <p className="mt-1 font-sans text-[13px] text-ink/55">
                    {funded ? "Funded. Gas on Arc is paid in USDC, so this covers its bids and fees." : "Waiting for funds — this updates on its own."}
                  </p>
                </div>

                <div className="flex flex-col justify-end gap-3 sm:w-[300px]">
                  {!funded ? (
                    <>
                      <ShimmerButton onClick={fundFromWallet} disabled={busy || !isConnected}
                        background="linear-gradient(110deg,#14171a,#26323c)" shimmerColor="#00a9d6" shimmerSize="0.08em" borderRadius="14px"
                        className="w-full px-5 py-3.5 font-sans text-[15px] font-bold text-white shadow-none disabled:opacity-40">
                        {busy ? "Waiting for your wallet…" : `Send ${usd(draft.budget)} USDC from your wallet`}
                      </ShimmerButton>
                      {wallet?.grantAvailable && (
                        <button type="button" onClick={grant} disabled={busy}
                          className="font-sans text-[13px] font-bold text-accent-deep underline-offset-4 hover:underline disabled:opacity-40">
                          No testnet USDC? Use a one-time {usd(wallet.grantMinor)} USDC grant
                        </button>
                      )}
                    </>
                  ) : (
                    <ShimmerButton onClick={deploy} disabled={busy}
                      background="linear-gradient(110deg,#0b3f63,#007f9f)" shimmerColor="#7fd6ff" shimmerSize="0.08em" borderRadius="14px"
                      className="w-full px-5 py-4 font-sans text-[16px] font-bold text-white shadow-none disabled:opacity-40">
                      Send {agent.label} to the floor →
                    </ShimmerButton>
                  )}
                  {error && <p className="font-sans text-[13px] text-guard">{error}</p>}
                </div>
              </div>
            </motion.section>
          )}
        </AnimatePresence>
      </div>
    </main>
  );
}
