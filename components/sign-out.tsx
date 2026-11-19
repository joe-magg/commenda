"use client";

import { useState } from "react";
import { useDisconnect } from "wagmi";
import { LogOut } from "lucide-react";

/**
 * Sign out: clear the session cookie (server, HttpOnly — JS can't) and drop
 * the app's wallet connection, then return to the landing page. MetaMask may
 * still list this site as connected; the next "Connect" uses whichever
 * account is selected in MetaMask, so switch accounts there for a new user.
 */
export function SignOutButton({ tone = "light" }: { tone?: "light" | "dark" }) {
  const { disconnectAsync } = useDisconnect();
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true);
    await fetch("/api/auth", { method: "DELETE" }).catch(() => {});
    await disconnectAsync().catch(() => {});
    window.location.href = "/";
  };

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      title="Sign out"
      aria-label="Sign out"
      className={`flex items-center gap-1.5 rounded-full px-3.5 py-2 font-sans text-[13px] font-bold shadow-sm transition disabled:opacity-50 ${
        tone === "dark" ? "bg-ink text-white hover:bg-ink/90" : "bg-white/80 text-ink hover:bg-white"
      }`}
    >
      <LogOut className="size-3.5" /> {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
