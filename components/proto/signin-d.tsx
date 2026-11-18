"use client";

import { LogOut } from "lucide-react";
import { useWalletSignIn } from "@/lib/client/use-wallet-signin";
import { BrandLine } from "@/components/brand-line";
import { DitherField } from "@/components/ui/dither-field";
import { ProgressiveBlur } from "@/components/ui/progressive-blur";
import { ShimmerButton } from "@/components/ui/shimmer-button";

/**
 * PROTOTYPE D, rev 3 — the ship speaks for itself.
 *  - static hero (no cycling, slightly smaller so it clears the ship)
 *  - bold one-line sub copy; no nav wordmark; no bottom marquee/caption
 *  - ONE button: connect → sign → enter, fully automatic. No connector
 *    list, no second click. ShimmerButton (ink + cyan shimmer) is the
 *    flashy-but-on-theme CTA from the installed library.
 */
export function SignInD() {
  const { address, isConnected, connectors, connectAndSignIn, signIn, disconnect, connecting, signing, error } =
    useWalletSignIn();

  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";
  const connector = connectors[0];
  const connectorLabel = /metamask/i.test(connector?.name ?? "") ? "MetaMask" : (connector?.name ?? "wallet");

  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden bg-[#e9f0f5]">
      {/* The generated reference art, dithered live — inverted so the dark
          ship is a dense navy silhouette and the sky falls away. */}
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

      {/* Hero */}
      <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center px-6 sm:px-10">
        <h1 className="display-type text-center text-[clamp(1.9rem,4.2vw,2.9rem)] font-bold text-ink">
          Send your agent to the auction.
        </h1>

        <div className="mt-4">
          <BrandLine className="text-[clamp(1.05rem,1.6vw,1.35rem)]" />
        </div>
        <p className="mt-2.5 text-center font-sans text-[15px] font-bold text-ink">
          Your agent competes on the floor in real time, by your rules.
        </p>

        {/* One-button card */}
        <div className="mt-6 w-full max-w-[320px] rounded-2xl border border-black/[0.06] bg-white/95 p-3.5 shadow-[0_1px_2px_rgba(16,24,32,0.05),0_20px_60px_rgba(11,63,99,0.16)] backdrop-blur">
          {isConnected && (
            <span className="mb-2 block text-center font-mono text-[12px] text-ink/80">{short}</span>
          )}
          {!isConnected ? (
            <ShimmerButton
              onClick={connectAndSignIn}
              disabled={connecting}
              background="linear-gradient(110deg,#14171a,#26323c)"
              shimmerColor="#00a9d6"
              shimmerSize="0.08em"
              borderRadius="12px"
              className="w-full px-4 py-3 font-sans text-[14px] font-medium text-white shadow-none disabled:opacity-50"
            >
              {connecting ? "Connecting…" : `Connect ${connectorLabel}`}
            </ShimmerButton>
          ) : (
            <div className="flex items-center gap-2">
              <ShimmerButton
                onClick={signIn}
                disabled={signing}
                background="linear-gradient(110deg,#14171a,#26323c)"
                shimmerColor="#00a9d6"
                shimmerSize="0.08em"
                borderRadius="12px"
                className="w-full flex-1 px-4 py-2.5 font-sans text-[14px] font-medium text-white shadow-none disabled:opacity-50"
              >
                {signing ? "Signing…" : "Sign in"}
              </ShimmerButton>
              <button
                onClick={() => disconnect()}
                title="Disconnect"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-black/[0.07] bg-white text-ink/70 transition-colors hover:text-ink"
              >
                <LogOut className="size-4" />
              </button>
            </div>
          )}
          {error && <p className="mt-2 text-center font-sans text-[13px] leading-relaxed text-ink">{error}</p>}
        </div>
      </div>
    </main>
  );
}
