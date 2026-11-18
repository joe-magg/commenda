"use client";

import { ArrowRight, LogOut } from "lucide-react";
import { useWalletSignIn } from "@/lib/client/use-wallet-signin";
import { AgentMark } from "@/components/agent-mark";
import { BrandLine } from "@/components/brand-line";
import { CyclingHeadline } from "@/components/cycling-headline";
import { DitherField } from "@/components/ui/dither-field";
import { ProgressiveBlur } from "@/components/ui/progressive-blur";
import { Marquee } from "@/components/ui/marquee";

export type OrbitAgent = { id: string; label: string };

/**
 * PROTOTYPE D, rev 2 — "The network". Feedback applied:
 *  - nav is wordmark only (Watch live + USDC/Arc pill deleted)
 *  - the network line ("Live USDC auctions on Arc") sits under the hero with
 *    the real USDC + Arc marks
 *  - small text is no longer Geist, no longer small-gray: Satoshi, 14px+,
 *    ink — Geist Mono survives for data (addresses)
 *  - address chip lost its gray fill
 *  - agent chips use generative abstract marks (AgentMark), not letter glyphs
 *  - headline cycles "…to the auction." → "…to Commenda." (blur out,
 *    word-by-word blur in); a Commenda logo will replace the nav wordmark
 *    once generated (prompts in notes/commenda-logo-prompt*.md)
 *  - the dither background is the user's generated art (DitherField src)
 *  - caption trimmed to "A network of bidding agents"
 */
export function SignInD({ agents }: { agents: OrbitAgent[] }) {
  const { address, isConnected, connectors, connectWallet, connecting, disconnect, signIn, signing, error } =
    useWalletSignIn();

  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";
  const chips = [...agents, ...agents].map((a, i) => ({ ...a, key: `${a.id}-${i}` }));

  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden bg-[#e9f0f5]">
      {/* The user's generated reference art, dithered live by DitherField —
          inverted so the dark ship becomes a dense navy silhouette and the
          bright sky falls away to sparse dots. */}
      <DitherField
        src="/brand/sea-dawn.png"
        invert
        className="absolute inset-0"
        color={["#a8d4e8", "#4aa7cf", "#0b3f63"]}
        dotSize={2}
        intensity={0.85}
        speed={0.15}
        fps={30}
        interactive={false}
      />
      <ProgressiveBlur className="absolute inset-x-0 top-0 z-[1]" height="22%" position="top" />
      <ProgressiveBlur className="absolute inset-x-0 bottom-0 z-[1]" height="30%" position="bottom" />
      {/* soft radial scrim behind the copy only — narrow, so the ship keeps
          its full tonal range */}
      <div className="absolute inset-0 z-[1] bg-[radial-gradient(420px_360px_at_50%_55%,rgba(255,255,255,0.9),transparent_70%)]" />

      {/* Nav — wordmark only */}
      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center px-6 py-5 sm:px-10">
        <span className="text-[14px] font-semibold tracking-[-0.02em] text-ink">commenda</span>
      </header>

      {/* Hero */}
      <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center px-6 sm:px-10">
        <CyclingHeadline className="display-type text-center text-[clamp(2.2rem,5vw,3.4rem)] font-bold text-ink" />

        <div className="mt-5">
          <BrandLine className="text-[clamp(1.15rem,1.8vw,1.45rem)]" />
        </div>
        <p className="mt-2.5 max-w-lg text-center font-sans text-[15px] leading-relaxed text-ink/90">
          Your agent competes on the floor in real time, by your rules.
        </p>

        {/* Compact, icon-driven card */}
        <div className="mt-6 w-full max-w-[320px] rounded-2xl border border-black/[0.06] bg-white/95 p-4 shadow-[0_1px_2px_rgba(16,24,32,0.05),0_20px_60px_rgba(11,63,99,0.16)] backdrop-blur">
          {!isConnected ? (
            <div className="flex flex-col gap-1.5">
              {connectors.map((c, i) => (
                <button
                  key={c.uid}
                  onClick={() => connectWallet(c.uid)}
                  disabled={connecting}
                  className={
                    i === 0
                      ? "flex w-full items-center justify-center gap-2 rounded-xl bg-ink px-4 py-2.5 font-sans text-[14px] font-medium text-white transition-transform active:scale-[0.98] disabled:opacity-50"
                      : "flex w-full items-center justify-center rounded-xl border border-black/[0.07] bg-white px-4 py-2 font-sans text-[13px] font-medium text-ink/80 transition-colors hover:text-ink disabled:opacity-50"
                  }
                >
                  {connecting && i === 0 ? "Connecting…" : `Connect ${c.name}`}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="flex-1 text-center font-mono text-[13px] text-ink">{short}</span>
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
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-black/[0.07] bg-white text-ink/70 transition-colors hover:text-ink"
              >
                <LogOut className="size-4" />
              </button>
            </div>
          )}
          {error && <p className="mt-2 text-center font-sans text-[13px] leading-relaxed text-ink">{error}</p>}
        </div>
      </div>

      {/* Agent network marquee — scale, not a roster */}
      <footer className="relative z-10 pb-7">
        <div className="mx-auto max-w-6xl px-6 sm:px-10">
          <Marquee pauseOnHover className="max-w-full [--duration:26s] [mask-image:linear-gradient(to_right,transparent,black_15%,black_85%,transparent)]">
            {chips.map((a) => (
              <AgentMark key={a.key} id={a.id} title={a.label} size={34} className="mx-2" />
            ))}
          </Marquee>
          <p className="mt-2 text-center font-mono text-[10px] font-medium tracking-[0.14em] text-ink/70 uppercase">
            A network of bidding agents
          </p>
        </div>
      </footer>
    </main>
  );
}
