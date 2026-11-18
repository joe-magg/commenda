import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/wagmi-provider";

const geist = Geist({ subsets: ["latin"], display: "swap", variable: "--font-geist" });

export const metadata: Metadata = {
  title: "Commenda — Agentic Live Auctions",
  description:
    "Fully agentic live-stream flash auctions with delegated bidding agents.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={geist.variable}>
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
