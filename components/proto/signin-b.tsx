"use client";

import { useWalletSignIn } from "@/lib/client/use-wallet-signin";
import { agentIdentity } from "@/lib/agent-identity";
import { OrbitingCircles } from "@/components/ui/orbiting-circles";
import { ShineBorder } from "@/components/ui/shine-border";
import { AnimatedShinyText } from "@/components/ui/animated-shiny-text";
import { DotPattern } from "@/components/ui/dot-pattern";

export type OrbitAgent = { id: string; label: string };

/**
 * PROTOTYPE B — "Agentic showcase". The sign-in is the product story: the
 * funded agents literally orbit the vault you're about to unlock. Library
 * pieces: orbiting-circles, shine-border, animated-shiny-text, dot-pattern.
 */
export function SignInB({ agents }: { agents: OrbitAgent[] }) {
  const { address, isConnected, connectors, connectWallet, connecting, disconnect, signIn, signing, error } =
    useWalletSignIn();

  const orbit = agents.slice(0, 8);

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[#f6f8fa] px-5 py-12">
      <DotPattern
        className="absolute inset-0 opacity-[0.5] [fill:rgba(0,169,214,0.25)]"
        width={22}
        height={22}
        cx={1}
        cy={1}
        cr={1}
      />

      <div className="relative z-10 flex flex-col items-center">
        <div className="inline-flex items-center">
          <AnimatedShinyText className="inline-flex items-center gap-2 rounded-full border border-black/[0.06] bg-white px-3.5 py-1 text-[11px] font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            <span>LIVE ON ARC — USDC</span>
          </AnimatedShinyText>
        </div>

        <h1 className="display-type mt-5 text-center text-[clamp(2.3rem,5vw,3.6rem)] font-bold text-ink">
          Eight agents.
          <br />
          One auction house.
        </h1>

        {/* The orbit — agents circle the card you sign into */}
        <div className="relative mt-10 flex items-center justify-center">
          <OrbitingCircles radius={210} duration={28} iconSize={40} path speed={1.4}>
            {orbit.map((a) => {
              const id = agentIdentity(a.id);
              return (
                <span
                  key={a.id}
                  title={a.label}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-black/[0.06] bg-white text-[16px] shadow-sm"
                  style={{ color: id.color }}
                >
                  {id.glyph}
                </span>
              );
            })}
          </OrbitingCircles>
          <OrbitingCircles radius={140} duration={20} reverse iconSize={28} path speed={1.4}>
            {orbit.slice(0, 4).map((a) => {
              const id = agentIdentity(a.id);
              return (
                <span
                  key={`inner-${a.id}`}
                  className="flex h-7 w-7 items-center justify-center rounded-full border border-black/[0.06] bg-white text-[11px] shadow-sm"
                  style={{ background: id.soft, color: id.color }}
                >
                  {id.glyph}
                </span>
              );
            })}
          </OrbitingCircles>

          {/* The vault card */}
          <ShineBorder borderWidth={2} duration={10} shineColor={["#00a9d6", "#7fd6ff", "#00a9d6"]} className="rounded-2xl">
            <div className="w-[340px] rounded-2xl bg-white p-7 shadow-[0_1px_2px_rgba(16,24,32,0.05),0_20px_60px_rgba(16,40,60,0.12)]">
              <div className="text-[15px] font-semibold text-ink">Enter the floor</div>
              {!isConnected ? (
                <div className="mt-4 flex flex-col gap-2">
                  {connectors.map((c) => (
                    <button
                      key={c.uid}
                      onClick={() => connectWallet(c.uid)}
                      disabled={connecting}
                      className="w-full rounded-xl border border-black/[0.08] bg-[#f6f8fa] px-4 py-3 text-sm font-medium text-ink transition-transform active:scale-[0.98] disabled:opacity-50"
                    >
                      {connecting ? "Connecting…" : `Connect ${c.name}`}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="mt-4">
                  <div className="tabular rounded-xl bg-[#f6f8fa] px-3 py-2.5 text-center text-[12px] text-muted">
                    {address?.slice(0, 8)}…{address?.slice(-6)}
                  </div>
                  <button
                    onClick={signIn}
                    disabled={signing}
                    className="mt-2.5 w-full rounded-xl bg-accent px-4 py-3 text-sm font-medium text-white shadow-[0_6px_18px_rgba(0,169,214,0.35)] transition-transform active:scale-[0.98] disabled:opacity-50"
                  >
                    {signing ? "Signing…" : "Sign in"}
                  </button>
                  <button
                    onClick={() => disconnect()}
                    className="mt-2 w-full text-center text-[12px] text-muted transition-colors hover:text-ink"
                  >
                    Disconnect
                  </button>
                </div>
              )}
              {error && <p className="mt-3 text-[12px] leading-relaxed text-ink">{error}</p>}
              <p className="mt-4 text-center text-[12px] text-muted">Free signature · no transaction · no gas</p>
            </div>
          </ShineBorder>
        </div>

        <a href="/live" className="mt-8 text-[13px] text-muted transition-colors hover:text-ink">
          Watch the auction as a guest →
        </a>
      </div>
    </main>
  );
}
