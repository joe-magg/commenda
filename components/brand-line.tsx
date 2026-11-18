import { cn } from "@/lib/utils";

/**
 * "Live [USDC] auctions on [Arc]" — the network line. Official marks only:
 * USDC from cryptologos (brand blue), Arc from the official press kit
 * (`Arc_Logos.zip`, permitted for teams building on Arc).
 */
export function BrandLine({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[15px] font-medium text-ink", className)}>
      <span>Live</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/usdc.svg" alt="USDC" width={19} height={19} className="h-[19px] w-[19px] shrink-0 translate-y-[1px]" />
      <span className="font-semibold">USDC</span>
      <span>auctions on</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/arc-icon-navy-gradient.svg" alt="Arc" width={17} height={18} className="h-[18px] w-[17px] shrink-0 translate-y-[1px]" />
      <span className="font-semibold">Arc</span>
    </span>
  );
}
