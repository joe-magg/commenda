"use client";

import { useState } from "react";
import { useAccount, useConnect, useDisconnect, useSignMessage } from "wagmi";

const SIGNIN_MESSAGE = "Sign in to Commenda. This is a free demo signature with no transaction.";

/**
 * Shared wallet sign-in flow for the landing and prototype routes.
 * Connect errors are mapped to human copy — raw provider messages never render.
 * `connectAndSignIn` is the one-button flow: connect → sign → enter, no
 * second click, no connector list.
 */
export function useWalletSignIn(onSuccess?: () => void) {
  const { address, isConnected } = useAccount();
  const { connectors, connect, connectAsync, isPending: connecting } = useConnect();
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

  /** Sign with the current account and exchange the signature for a session. */
  const authorize = async (addr?: string): Promise<void> => {
    const signature = await signMessageAsync({ message: SIGNIN_MESSAGE });
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: (addr ?? address) as string, signature }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "Sign-in failed — try again.");
      return;
    }
    onSuccess?.();
    window.location.reload();
  };

  const connectAndSignIn = async () => {
    setError("");
    try {
      const res = await connectAsync({ connector: connectors[0] });
      await authorize(res?.accounts?.[0]);
    } catch (e) {
      setError(friendlyConnectError(e));
    }
  };

  const connectWallet = (connectorId: string) => {
    setError("");
    const connector = connectors.find((c) => c.uid === connectorId);
    if (!connector) return;
    connect({ connector }, { onError: (e) => setError(friendlyConnectError(e)) });
  };

  const signIn = async () => {
    setError("");
    try {
      await authorize();
    } catch {
      setError("Signature request was declined.");
    }
  };

  return {
    address,
    isConnected,
    connectors,
    connectWallet,
    connectAndSignIn,
    connecting,
    disconnect,
    signIn,
    signing,
    error,
  };
}
