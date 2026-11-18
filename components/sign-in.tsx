"use client";

import { useState } from "react";
import { useAccount, useConnect, useDisconnect, useSignMessage } from "wagmi";
import dynamic from "next/dynamic";
import { motion, useReducedMotion } from "motion/react";

const SeaScene = dynamic(() => import("@/components/sea-scene").then((m) => m.SeaScene), { ssr: false });

export function SignIn({ onSuccess }: { onSuccess?: () => void }) {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { signMessageAsync, isPending: signing } = useSignMessage();
  const [error, setError] = useState("");
  const reduce = useReducedMotion();

  const signIn = async () => {
    if (!address) return;
    setError("");
    try {
      const signature = await signMessageAsync({
        message: "Sign in to Commenda. This is a free demo signature with no transaction.",
      });
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, signature }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? "Sign-in failed — try again.");
        return;
      }
      onSuccess?.();
      window.location.reload();
    } catch {
      setError("Signature request was declined.");
    }
  };

  const friendlyConnectError = (e: unknown): string => {
    const raw = e instanceof Error ? `${e.message} ${e.name}` : "";
    if (/denied|rejected|unauthorized|not been authorized/i.test(raw)) {
      return "The wallet request was declined. Approve it in your wallet and try again.";
    }
    return "Couldn't connect that wallet. Try again or pick another one.";
  };

  // One orchestrated entrance, critically damped; static under reduced motion.
  const rise = reduce
    ? {}
    : {
        initial: { opacity: 0, y: 14 },
        animate: { opacity: 1, y: 0 },
        transition: { type: "spring" as const, bounce: 0, duration: 0.5 },
      };

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-5 py-12">
      <SeaScene />

      <div className="relative z-10 flex w-full max-w-xl flex-col items-center text-center">
        <motion.span {...rise} className="text-sm font-semibold tracking-[-0.02em] text-ink">
          commenda
        </motion.span>

        <motion.h1 {...rise} className="display-type mt-5 text-[clamp(2.4rem,6vw,3.6rem)] font-bold text-ink">
          Send your agent
          <br />
          to the auction.
        </motion.h1>

        <motion.p {...rise} className="mt-4 max-w-md text-[15px] leading-relaxed text-muted">
          Live USDC auctions on Arc — your agent bids inside the budget you set.
          Every bid escrowed; every outbid refunded instantly.
        </motion.p>

        <motion.div {...rise} className="glass-stage mt-8 w-full max-w-sm px-6 py-7">
          {!isConnected ? (
            <div className="flex flex-col gap-2">
              {connectors.map((c, i) => (
                <button
                  key={c.uid}
                  onClick={() => {
                    setError("");
                    connect({ connector: c }, { onError: (e) => setError(friendlyConnectError(e)) });
                  }}
                  disabled={connecting}
                  className={`rounded-xl px-4 py-3 text-sm font-medium transition-transform active:scale-[0.97] disabled:opacity-50 ${
                    i === 0
                      ? "bg-accent text-white shadow-[0_6px_18px_rgba(0,169,214,0.35)]"
                      : "border border-white/70 bg-white/55 text-ink"
                  }`}
                >
                  {connecting && i === 0 ? "Connecting…" : `Connect ${c.name}`}
                </button>
              ))}
            </div>
          ) : (
            <div>
              <div className="rounded-xl border border-white/70 bg-white/50 px-3 py-2 text-xs text-muted">
                {address?.slice(0, 8)}…{address?.slice(-6)}
              </div>
              <button
                onClick={signIn}
                disabled={signing}
                className="mt-3 w-full rounded-xl bg-accent px-4 py-3 text-sm font-medium text-white shadow-[0_6px_18px_rgba(0,169,214,0.35)] transition-transform active:scale-[0.97] disabled:opacity-50"
              >
                {signing ? "Signing…" : "Sign in"}
              </button>
              <button
                onClick={() => disconnect()}
                className="mt-2 text-xs text-muted underline underline-offset-2"
              >
                Disconnect
              </button>
            </div>
          )}

          {error && <p className="mt-4 text-xs leading-relaxed text-ink">{error}</p>}

          <p className="mt-4 text-[11px] leading-relaxed text-subtle">
            Free message signature — no transaction, no gas.
          </p>
        </motion.div>

        <a href="/live" className="mt-6 text-xs text-muted underline underline-offset-2">
          Watch the auction as a guest →
        </a>
      </div>
    </main>
  );
}
