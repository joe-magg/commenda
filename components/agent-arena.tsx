"use client";

import { useRef, useState, useEffect, useMemo, type RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AnimatedBeam } from "@/components/ui/animated-beam";
import { AgentMark } from "@/components/agent-mark";
import HoloCard from "@/components/HoloCard";
import { cardArtDataUri } from "@/lib/items/card-art";
import type { Lot } from "@/lib/auction/lots";

type Member = { id: string; label: string; live: boolean };

/**
 * The live stage as an "arena": the agent network flanks the item — a real
 * HoloCard (react-bits) that tilts and shimmers — and each bid fires a beam
 * from that agent into the card. Only live (funded) agents ever bid.
 */
export function AgentArena({
  members,
  lot,
  lastBidder,
  bidSeq,
  reduce,
}: {
  members: Member[];
  lot: Lot | null;
  lastBidder: string | null;
  bidSeq: number;
  reduce: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const center = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Record<string, RefObject<HTMLDivElement | null>>>({});
  const [active, setActive] = useState<string | null>(null);

  const refs = useMemo(() => {
    const map: Record<string, RefObject<HTMLDivElement | null>> = {};
    for (const m of members) {
      if (!nodeRefs.current[m.id]) nodeRefs.current[m.id] = { current: null };
      map[m.id] = nodeRefs.current[m.id];
    }
    return map;
  }, [members]);

  useEffect(() => {
    if (!lastBidder || reduce) return;
    setActive(lastBidder);
    const t = window.setTimeout(() => setActive(null), 1100);
    return () => window.clearTimeout(t);
  }, [lastBidder, bidSeq, reduce]);

  // Split roster into two side columns, evenly spaced top to bottom.
  const half = Math.ceil(members.length / 2);
  const positioned = members.map((m, i) => {
    const left = i < half;
    const col = left ? members.slice(0, half) : members.slice(half);
    const row = left ? i : i - half;
    const y = col.length === 1 ? 50 : 16 + (row / (col.length - 1)) * 68;
    return { ...m, x: left ? 7 : 93, y };
  });

  return (
    <div ref={container} className="relative h-[400px] w-full max-w-[520px] sm:h-[440px]">
      {!reduce && active && refs[active]?.current && (
        <AnimatedBeam
          key={`${active}-${bidSeq}`}
          containerRef={container}
          fromRef={refs[active]}
          toRef={center}
          curvature={16}
          duration={1}
          repeat={1}
          pathColor="#00a9d6"
          pathWidth={2}
          pathOpacity={0.3}
          gradientStartColor="#00a9d6"
          gradientStopColor="#7fd6ff"
        />
      )}

      {/* centre item — the HoloCard */}
      <div ref={center} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        {lot?.artSeed ? (
          <HoloCard
            image={cardArtDataUri(lot.artSeed)}
            alt={lot.title}
            width={240}
            radius={16}
            tiltMax={12}
            intensity={0.8}
            glare={0.55}
            edgeSparkle={0.7}
            frame={4}
            idle
          />
        ) : (
          <div className="h-[334px] w-[240px] rounded-2xl bg-white/70" />
        )}
      </div>

      <AnimatePresence>
        {positioned.map((m) => {
          const isActive = active === m.id;
          return (
            <motion.div
              key={m.id}
              ref={(el) => { nodeRefs.current[m.id] = { current: el }; }}
              className="absolute z-10 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${m.x}%`, top: `${m.y}%` }}
              animate={isActive && !reduce ? { scale: [1, 1.16, 1] } : { scale: 1 }}
              transition={{ duration: 0.45 }}
            >
              <div
                className={`rounded-full ${m.live ? "" : "opacity-50 grayscale"}`}
                style={{ boxShadow: isActive ? "0 0 0 4px rgba(0,169,214,0.35)" : undefined }}
                title={`${m.label}${m.live ? "" : " (standby)"}`}
              >
                <AgentMark id={m.id} size={38} />
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
