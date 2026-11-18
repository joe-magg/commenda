"use client";

import { useWalletSignIn } from "@/lib/client/use-wallet-signin";
import { DitherField } from "@/components/ui/dither-field";
import { AuroraText } from "@/components/ui/aurora-text";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { ProgressiveBlur } from "@/components/ui/progressive-blur";

/**
 * PROTOTYPE C — "Bold hero". Cinematic: MagicUI's dither-field (procedural
 * dot dithering — and it can dither an image via `src` when the user's
 * reference art lands), aurora headline, shimmer CTA.
 */
export function SignInC() {
  const { address, isConnected, connectors, connectWallet, connecting, disconnect, signIn, signing, error } =
    useWalletSignIn();

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[#eef4f8] px-5 py-12">
      {/* Procedural dithered light field — deep-sea cyan dunes */}
      <DitherField
        pattern="waves"
        className="absolute inset-0"
        color={["#c8e7f4", "#4aa7cf", "#0b3f63"]}
        dotSize={2}
        intensity={0.6}
        speed={0.7}
        fps={30}
        interactive={false}
      />
      <ProgressiveBlur className="absolute inset-x-0 top-0 z-[1]" height="26%" position="top" />
      <ProgressiveBlur className="absolute inset-x-0 bottom-0 z-[1]" height="26%" position="bottom" />

      <div className="relative z-10 flex w-full max-w-lg flex-col items-center text-center">
        <span className="text-[13px] font-semibold tracking-[-0.02em] text-ink">commenda</span>

        <h1 className="display-type mt-6 text-[clamp(2.6rem,6vw,4rem)] font-bold text-ink">
          <AuroraText colors={["#00a9d6", "#007f9f", "#0b3f63"]}>Send your agent</AuroraText>
          <br />
          to the auction.
        </h1>

        <p className="mt-4 max-w-md text-[15px] leading-relaxed text-muted">
          Live USDC auctions on Arc. Your agent bids inside the budget you set —
          every bid escrowed, every outbid refunded instantly.
        </p>

        <div className="mt-9 w-full max-w-sm rounded-2xl border border-black/[0.06] bg-white/95 p-7 shadow-[0_1px_2px_rgba(16,24,32,0.05),0_24px_70px_rgba(11,63,99,0.18)] backdrop-blur">
          {!isConnected ? (
            <div className="flex flex-col gap-2">
              {connectors.map((c) => (
                <ShimmerButton
                  key={c.uid}
                  onClick={() => connectWallet(c.uid)}
                  disabled={connecting}
                  background="linear-gradient(110deg,#14171a,#26323c)"
                  shimmerColor="#00a9d6"
                  shimmerSize="0.08em"
                  borderRadius="12px"
                  className="w-full px-4 py-3 text-sm font-medium text-white shadow-none disabled:opacity-50"
                >
                  {connecting ? "Connecting…" : `Connect ${c.name}`}
                </ShimmerButton>
              ))}
            </div>
          ) : (
            <div>
              <div className="tabular rounded-xl bg-[#f2f6f9] px-3 py-2.5 text-center text-[12px] text-muted">
                {address?.slice(0, 8)}…{address?.slice(-6)}
              </div>
              <ShimmerButton
                onClick={signIn}
                disabled={signing}
                background="linear-gradient(110deg,#14171a,#26323c)"
                shimmerColor="#00a9d6"
                shimmerSize="0.08em"
                borderRadius="12px"
                className="mt-3 w-full px-4 py-3 text-sm font-medium text-white shadow-none disabled:opacity-50"
              >
                {signing ? "Signing…" : "Sign in"}
              </ShimmerButton>
              <button
                onClick={() => disconnect()}
                className="mt-2 w-full text-center text-[12px] text-muted transition-colors hover:text-ink"
              >
                Disconnect
              </button>
            </div>
          )}
          {error && <p className="mt-3 text-[12px] leading-relaxed text-ink">{error}</p>}
          <p className="mt-5 text-[12px] text-muted">Free signature · no transaction · no gas</p>
        </div>

        <a href="/live" className="mt-7 text-[13px] text-white/85 underline underline-offset-4 transition-colors hover:text-white">
          Watch the auction as a guest →
        </a>
      </div>
    </main>
  );
}
