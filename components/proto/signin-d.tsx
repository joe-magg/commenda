"use client";

import { ArrowRight, LogOut } from "lucide-react";
import { useWalletSignIn } from "@/lib/client/use-wallet-signin";
import { agentIdentity } from "@/lib/agent-identity";
import { DitherField } from "@/components/ui/dither-field";
import { ProgressiveBlur } from "@/components/ui/progressive-blur";
import { TextAnimate } from "@/components/ui/text-animate";
import { Marquee } from "@/components/ui/marquee";
import { ArcBadge } from "@/components/arc-badge";

export type OrbitAgent = { id: string; label: string };

/**
 * PROTOTYPE D — "The network". Feedback-driven revision:
 *  - more going on: dithered light field + agent marquee + Arc badge
 *  - scale-agnostic: agents read as a network (a marquee of chips), not a
 *    literal roster of 8 — production could be 10,000
 *  - type system: Geist Mono for every small label; Geist Sans for body/display
 *  - compact card: icons over words, abbreviated address, no implied-signature
 *    footnote, guest link lives in the nav (not on the dither)
 *  - keep: "Send your agent to the auction." + "Live USDC auctions on Arc."
 *  - background is procedural dither-field for now; it takes `src` — the
 *    dithered reference image slots in when the art lands.
 */
export function SignInD({ agents }: { agents: OrbitAgent[] }) {
  const { address, isConnected, connectors, connectWallet, connecting, disconnect, signIn, signing, error } =
    useWalletSignIn();

  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";
  const chips = [...agents, ...agents].map((a, i) => ({ ...a, key: `${a.id}-${i}` }));

  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden bg-[#e9f0f5]">
      {/* Procedural stand-in for the dithered reference image (DitherField src=...) */}
      <DitherField
        pattern="clouds"
        className="absolute inset-0"
        color={["#c8e7f4", "#4aa7cf", "#0b3f63"]}
        dotSize={2}
        intensity={0.6}
        speed={0.5}
        fps={30}
        interactive={false}
      />
      <ProgressiveBlur className="absolute inset-x-0 top-0 z-[1]" height="22%" position="top" />
      <ProgressiveBlur className="absolute inset-x-0 bottom-0 z-[1]" height="30%" position="bottom" />
      {/* soft radial scrim so the copy never fights the texture */}
      <div className="absolute inset-0 z-[1] bg-[radial-gradient(560px_420px_at_50%_52%,rgba(255,255,255,0.85),transparent_70%)]" />

      {/* Nav */}
      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5 sm:px-10">
        <span className="text-[14px] font-semibold tracking-[-0.02em] text-ink">commenda</span>
        <div className="flex items-center gap-4">
          <ArcBadge />
          <a href="/live" className="text-[13px] font-medium text-ink/80 underline-offset-4 hover:underline">
            Watch live
          </a>
        </div>
      </header>

      {/* Hero */}
      <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center px-6 sm:px-10">
        <TextAnimate
          as="h1"
          by="word"
          animation="blurInUp"
          delay={0.1}
          className="display-type text-center text-[clamp(2.2rem,5vw,3.4rem)] font-bold text-ink"
        >
          Send your agent to the auction.
        </TextAnimate>
        <p className="mt-3 max-w-lg text-center text-[15px] leading-relaxed text-ink/75">
          Live USDC auctions on Arc. Thousands of agents compete on the floor in
          real time — yours bids within the budget you set, escrowed per bid,
          refunded instantly.
        </p>

        {/* Compact, icon-driven card */}
        <div className="mt-7 w-full max-w-[340px] rounded-2xl border border-black/[0.06] bg-white/95 p-4 shadow-[0_1px_2px_rgba(16,24,32,0.05),0_20px_60px_rgba(11,63,99,0.16)] backdrop-blur">
          {!isConnected ? (
            <div className="flex flex-col gap-1.5">
              {connectors.map((c, i) => (
                <button
                  key={c.uid}
                  onClick={() => connectWallet(c.uid)}
                  disabled={connecting}
                  className={
                    i === 0
                      ? "flex w-full items-center justify-center gap-2 rounded-xl bg-ink px-4 py-2.5 text-[13px] font-medium text-white transition-transform active:scale-[0.98] disabled:opacity-50"
                      : "flex w-full items-center justify-center rounded-xl border border-black/[0.07] bg-white px-4 py-2 text-[12px] font-medium text-muted transition-colors hover:text-ink disabled:opacity-50"
                  }
                >
                  {connecting && i === 0 ? "Connecting…" : `Connect ${c.name}`}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="tabular flex-1 rounded-lg bg-[#f2f6f9] px-3 py-2 font-mono text-[12px] text-ink">
                {short}
              </span>
              <button
                onClick={signIn}
                disabled={signing}
                title={signing ? "Signing…" : "Sign in & continue"}
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink text-white transition-transform active:scale-95 disabled:opacity-50"
              >
                <ArrowRight className="size-4" />
              </button>
              <button
                onClick={() => disconnect()}
                title="Disconnect"
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-black/[0.07] bg-white text-muted transition-colors hover:text-ink"
              >
                <LogOut className="size-4" />
              </button>
            </div>
          )}
          {error && <p className="mt-2 text-[12px] leading-relaxed text-ink">{error}</p>}
        </div>
      </div>

      {/* Agent network marquee — scale, not a roster */}
      <footer className="relative z-10 pb-7">
        <div className="mx-auto max-w-6xl px-6 sm:px-10">
          <Marquee pauseOnHover className="max-w-full [--duration:26s] [mask-image:linear-gradient(to_right,transparent,black_15%,black_85%,transparent)]">
            {chips.map((a) => {
              const id = agentIdentity(a.id);
              return (
                <span
                  key={a.key}
                  title={a.label}
                  className="mx-1.5 flex h-8 w-8 items-center justify-center rounded-full border border-black/[0.06] bg-white/90 text-[13px] shadow-sm"
                  style={{ color: id.color }}
                >
                  {id.glyph}
                </span>
              );
            })}
          </Marquee>
          <p className="mt-2 text-center font-mono text-[10px] font-medium tracking-[0.14em] text-ink/70 uppercase">
            A network of bidding agents — yours joins anytime
          </p>
        </div>
      </footer>
    </main>
  );
}
