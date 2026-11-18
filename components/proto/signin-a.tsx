"use client";

import { useWalletSignIn } from "@/lib/client/use-wallet-signin";
import { FlickeringGrid } from "@/components/ui/flickering-grid";
import { ProgressiveBlur } from "@/components/ui/progressive-blur";

/**
 * PROTOTYPE A — "Quiet product". Vercel/Linear tier: asymmetric layout, solid
 * surfaces, one confident ink CTA, a barely-there flickering grid. No glass.
 */
export function SignInA() {
  const { address, isConnected, connectors, connectWallet, connecting, disconnect, signIn, signing, error } =
    useWalletSignIn();

  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden bg-[#f4f7fa]">
      <FlickeringGrid
        className="absolute inset-0"
        squareSize={3}
        gridGap={9}
        flickerChance={0.12}
        maxOpacity={0.14}
        color="rgb(0, 169, 214)"
      />
      <ProgressiveBlur className="absolute inset-x-0 bottom-0 z-[1]" height="22%" position="bottom" />

      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6 sm:px-10">
        <span className="text-[15px] font-semibold tracking-[-0.02em] text-ink">commenda</span>
        <a href="/live" className="text-[13px] text-muted transition-colors hover:text-ink">
          Watch live →
        </a>
      </header>

      <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 items-center px-6 pb-16 sm:px-10">
        <div className="grid w-full items-center gap-12 lg:grid-cols-[1fr_380px]">
          {/* Hero — left, asymmetric */}
          <div className="max-w-xl">
            <h1 className="display-type text-[clamp(2.6rem,5.5vw,4.2rem)] font-bold text-ink">
              The auction
              <br />
              never closes.
            </h1>
            <p className="mt-5 max-w-md text-[16px] leading-relaxed text-muted">
              Delegate a budget to your own bidding agent. It watches the live
              USDC auction on Arc, bids inside the rules you set, and settles
              on-chain — you approve, the code enforces.
            </p>
            <div className="mt-7 flex items-center gap-6 text-[13px] text-muted">
              <span className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                Escrowed per bid
              </span>
              <span className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                Instant outbid refunds
              </span>
              <span className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                You hold the keys
              </span>
            </div>
          </div>

          {/* Card — solid, high contrast */}
          <div className="w-full rounded-2xl border border-black/[0.06] bg-white p-7 shadow-[0_1px_2px_rgba(16,24,32,0.05),0_16px_48px_rgba(16,40,60,0.10)]">
            {!isConnected ? (
              <>
                <h2 className="text-[15px] font-semibold text-ink">Connect your wallet</h2>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
                  Sign a free message — no transaction, no gas.
                </p>
                <div className="mt-5 flex flex-col gap-2">
                  {connectors.map((c) => (
                    <button
                      key={c.uid}
                      onClick={() => connectWallet(c.uid)}
                      disabled={connecting}
                      className="flex w-full items-center justify-center rounded-xl bg-ink px-4 py-3 text-sm font-medium text-white transition-transform active:scale-[0.98] disabled:opacity-50"
                    >
                      {connecting ? "Connecting…" : `Connect ${c.name}`}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted">Wallet</span>
                  <span className="tabular text-[12px] text-ink">{address?.slice(0, 8)}…{address?.slice(-6)}</span>
                </div>
                <button
                  onClick={signIn}
                  disabled={signing}
                  className="mt-4 w-full rounded-xl bg-ink px-4 py-3 text-sm font-medium text-white transition-transform active:scale-[0.98] disabled:opacity-50"
                >
                  {signing ? "Signing…" : "Sign in"}
                </button>
                <button
                  onClick={() => disconnect()}
                  className="mt-2 w-full text-center text-[12px] text-muted transition-colors hover:text-ink"
                >
                  Disconnect
                </button>
              </>
            )}
            {error && <p className="mt-3 text-[12px] leading-relaxed text-ink">{error}</p>}
            <p className="mt-5 border-t border-black/[0.05] pt-4 text-center text-[12px] text-muted">
              New here?{" "}
              <a href="/live" className="font-medium text-ink underline underline-offset-2">
                Watch the auction live
              </a>
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
