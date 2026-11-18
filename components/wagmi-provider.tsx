"use client";

import { useState, type ReactNode } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "@wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { arcTestnet } from "viem/chains";

// Injected wallet only — no WalletConnect project ID needed. EIP-6963
// discovery means wallets={...} is optional; injected() covers MetaMask.
const config = createConfig({
  chains: [arcTestnet],
  connectors: [injected()],
  transports: { [arcTestnet.id]: http("https://rpc.testnet.arc.io") },
  ssr: true,
});

export function Providers({ children }: { children: ReactNode }) {
  const [query] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={query}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
