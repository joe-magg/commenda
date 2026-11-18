import { cn } from "@/lib/utils";

/**
 * Official Arc brand mark (arc.io partner assets — permitted for teams
 * building on Arc). Mono type per the type system: small labels are Geist Mono.
 */
export function ArcBadge({
  className,
  text = "USDC · Arc testnet",
}: {
  className?: string;
  text?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-black/[0.08] bg-white px-3 py-1.5 font-mono text-[11px] font-medium tracking-[0.06em] text-ink uppercase shadow-[0_1px_2px_rgba(16,24,32,0.06)]",
        className,
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/arc-icon.svg" alt="" width={13} height={13} className="shrink-0" />
      {text}
    </span>
  );
}
