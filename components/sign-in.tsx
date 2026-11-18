"use client";

import { useState } from "react";
import { useAccount, useConnect, useDisconnect, useSignMessage } from "wagmi";
import dynamic from "next/dynamic";

const ShipScene = dynamic(() => import("@/components/ship-scene").then((m) => m.ShipScene), { ssr: false });

export function SignIn({ onSuccess }: { onSuccess?: () => void }) {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { signMessageAsync, isPending: signing } = useSignMessage();
  const [error, setError] = useState("");

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
        setError(d.error ?? "Sign-in failed");
        return;
      }
      onSuccess?.();
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message.slice(0, 120) : "Signing failed");
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-5">
      <ShipScene />
      <div className="glass-stage relative z-10 w-full max-w-md px-7 py-9 text-center">
        <div className="display-type text-2xl font-semibold">commenda</div>
        <h1 className="mt-6 text-xl font-semibold text-ink">Sign in to your dashboard</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Connect your Arc testnet wallet and sign a free message — no transaction, no gas.
        </p>

        {!isConnected ? (
          <div className="mt-6 flex flex-col gap-2">
            {connectors.map((c) => (
              <button key={c.uid} onClick={() => connect({ connector: c })}
                className="rounded-xl bg-accent px-4 py-3 text-sm font-medium text-white shadow-[0_6px_18px_rgba(0,169,214,0.35)] transition-transform active:scale-[0.97] disabled:opacity-50"
                disabled={connecting}>
                {connecting ? "Connecting…" : `Connect ${c.name}`}
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-6">
            <div className="rounded-xl border border-white/70 bg-white/50 px-3 py-2 text-xs text-muted">
              {address?.slice(0, 8)}…{address?.slice(-6)}
            </div>
            <button onClick={signIn} disabled={signing}
              className="mt-3 w-full rounded-xl bg-accent px-4 py-3 text-sm font-medium text-white shadow-[0_6px_18px_rgba(0,169,214,0.35)] transition-transform active:scale-[0.97] disabled:opacity-50">
              {signing ? "Signing…" : "Sign in"}
            </button>
            <button onClick={() => disconnect()} className="mt-2 text-xs text-muted underline underline-offset-2">
              Disconnect
            </button>
          </div>
        )}

        {error && <p className="mt-4 text-xs text-ink">{error}</p>}
        <a href="/" className="mt-6 block text-xs text-muted underline underline-offset-2">Watch the auction as a guest →</a>
      </div>
    </div>
  );
}
