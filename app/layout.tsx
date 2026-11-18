import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import { Providers } from "@/components/wagmi-provider";

const geist = Geist({ subsets: ["latin"], display: "swap", variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], display: "swap", variable: "--font-geist-mono" });
// Satoshi (Fontshare, free license) — the UI/body face for small text; Geist keeps
// display/headline duty until the user picks otherwise.
const satoshi = localFont({
  src: [
    { path: "../app/fonts/satoshi-400.woff2", weight: "400" },
    { path: "../app/fonts/satoshi-500.woff2", weight: "500" },
    { path: "../app/fonts/satoshi-700.woff2", weight: "700" },
  ],
  variable: "--font-satoshi",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Commenda — Agentic Live Auctions",
  description:
    "Fully agentic live-stream flash auctions with delegated bidding agents.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable} ${satoshi.variable}`}>
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
