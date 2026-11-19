"use client";

import { useState } from "react";
import { useAccount, useConnect, useDisconnect, useSignMessage } from "wagmi";

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
    // Fresh single-use challenge per attempt — a signature can't be replayed.
    const challenge = await fetch("/api/auth", { cache: "no-store" }).then((r) => r.json()) as { nonce: string; message: string };
    const signature = await signMessageAsync({ message: challenge.message });
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: (addr ?? address) as string, signature, nonce: challenge.nonce }),
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
      let account: string | undefined;
      try {
        const res = await connectAsync({ connector: connectors[0] });
        account = res?.accounts?.[0];
      } catch (e) {
        // Already connected (e.g. after a wallet transaction) is fine — sign with it.
        if (!/already connected/i.test(e instanceof Error ? e.message : "")) { setError(friendlyConnectError(e)); return; }
      }
      await authorize(account);
    } catch (e) {
      setError(describe(e));
    }
  };

  const connectWallet = (connectorId: string) => {
    setError("");
    const connector = connectors.find((c) => c.uid === connectorId);
    if (!connector) return;
    connect({ connector }, { onError: (e) => setError(friendlyConnectError(e)) });
  };

  /** Say what actually failed — a blanket "declined" hid real problems. */
  const describe = (e: unknown): string => {
    const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error("[commenda:signin]", e);
    if (/User rejected|denied|4001/i.test(raw)) return "You declined the signature in your wallet.";
    if (/not connected|ConnectorNotConnected|AccountNotFound/i.test(raw)) {
      disconnect();
      return "Your wallet disconnected — press Connect again.";
    }
    return `Sign-in failed: ${raw.replace(/^Error: /, "").slice(0, 120)}`;
  };

  const signIn = async () => {
    setError("");
    try {
      await authorize();
    } catch (e) {
      setError(describe(e));
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
