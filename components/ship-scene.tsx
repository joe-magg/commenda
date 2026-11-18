"use client";

import Dither from "@/components/Dither";

/**
 * Commenda lore: little merchant agents board a ship and set sail at dawn.
 * Hand-built SVG (no AI art) over a dithered WebGL sea. ships loop in and out
 * so a venture departs and, eventually, returns.
 */
export function ShipScene() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {/* dithered sea + sun glow */}
      <div className="absolute inset-x-0 bottom-0 h-[62%] opacity-70">
        <Dither
          waveSpeed={0.18}
          waveFrequency={3}
          waveAmplitude={0.35}
          colorNum={5}
          pixelSize={2.4}
          ditherMode="bayer"
          palette={["#e8f4fb", "#9fd6ef", "#4aa7cf", "#1f6f9c", "#0b3f63"]}
          enableMouseInteraction={false}
          disableAnimation={false}
          contrast={1.1}
        />
      </div>

      {/* sky wash */}
      <div className="absolute inset-x-0 top-0 h-[42%] bg-gradient-to-b from-[#eaf5fc] to-transparent" />

      {/* low sun */}
      <svg className="absolute left-1/2 top-[26%] h-40 w-40 -translate-x-1/2 opacity-80" viewBox="0 0 160 160" fill="none">
        <circle cx="80" cy="80" r="40" fill="#ffd9a0" opacity="0.9" />
        <circle cx="80" cy="80" r="54" stroke="#ffd9a0" strokeWidth="1" opacity="0.4" />
        <circle cx="80" cy="80" r="68" stroke="#ffd9a0" strokeWidth="1" opacity="0.2" />
      </svg>

      {/* merchant ships — pixelated silhouettes drifting out and back */}
      <Ship x="8%" duration={26} delay={0} scale={0.9} />
      <Ship x="62%" duration={34} delay={-12} scale={0.65} />
      <Ship x="30%" duration={42} delay={-25} scale={0.5} />

      {/* gentle fade at the very bottom for foreground text */}
      <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-white/70 to-transparent" />
    </div>
  );
}

function Ship({ x, duration, delay, scale }: { x: string; duration: number; delay: number; scale: number }) {
  return (
    <div
      className="absolute bottom-[20%] animate-[sail_linear_infinite]"
      style={{ left: x, animationDuration: `${duration}s`, animationDelay: `${delay}s`, ["--s" as string]: scale } as React.CSSProperties}
    >
      <svg width="72" height="48" viewBox="0 0 72 48" fill="none" shapeRendering="crispEdges">
        {/* hull */}
        <path d="M6 30 H64 L56 42 H16 Z" fill="#134a6b" />
        <path d="M6 30 H64 L62 33 H8 Z" fill="#2a789c" />
        {/* mast + sail */}
        <path d="M34 30 V6" stroke="#134a6b" strokeWidth="2" />
        <path d="M34 8 L52 27 H34 Z" fill="#f3efe4" />
        <path d="M31 12 L18 27 H31 Z" fill="#e4dcc8" />
        {/* tiny merchant */}
        <circle cx="24" cy="24" r="2" fill="#b8862b" />
      </svg>
    </div>
  );
}
