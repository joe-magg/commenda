"use client";

import Dither from "@/components/Dither";

/**
 * The dithered sea at dawn — background for the sign-in screen. Ships and the
 * sun were removed deliberately: the hero copy is the one focal point, and the
 * texture must never compete with foreground text (DESIGN.md).
 */
export function SeaScene() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {/* dithered sea — the canvas is masked so it fades in from the horizon
          instead of hitting a hard edge under the copy */}
      <div
        className="absolute inset-x-0 bottom-0 h-[62%] opacity-70"
        style={{
          WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 32%)",
          maskImage: "linear-gradient(to bottom, transparent 0%, black 32%)",
        }}
      >
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

      {/* sky wash over the sea's top edge for text legibility */}
      <div className="absolute inset-x-0 top-0 h-[46%] bg-gradient-to-b from-[#eaf5fc] via-[#eaf5fc]/40 to-transparent" />

      {/* gentle fade at the very bottom for foreground text */}
      <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-white/70 to-transparent" />
    </div>
  );
}
