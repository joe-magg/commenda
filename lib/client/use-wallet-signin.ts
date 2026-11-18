"use client";

import { useState } from "react";
import { useAccount, useConnect, useDisconnect, useSignMessage } from "wagmi";

/**
 * Shared wallet sign-in flow for the landing and prototype routes.
 * Connect errors are mapped to human copy — raw provider messages never render.
 */
export function useWalletSignIn(onSuccess?: () => void) {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { signMessageAsync, isPending: signing } = useSignMessage();
  const [error, setError] = useState("");

  const friendlyConnectError = (e: unknown): string => {
    const raw = e instanceof Error ? `${e.message} ${e.name}` : "";
    if (/denied|rejected|unauthorized|not been authorized/i.test(raw)) {
      return "The wallet request was declined. Approve it in your wallet and try again.";
    }
    return "Couldn't connect that wallet. Try again or pick another one.";
  };

  const connectWallet = (connectorId: string) => {
    setError("");
    const connector = connectors.find((c) => c.uid === connectorId);
    if (!connector) return;
    connect({ connector }, { onError: (e) => setError(friendlyConnectError(e)) });
  };

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

  return {
    address,
    isConnected,
    connectors,
    connectWallet,
    connecting,
    disconnect,
    signIn,
    signing,
    error,
  };
}
