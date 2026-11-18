"use client";

import { useRef, useState, useEffect, useMemo, type RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AnimatedBeam } from "@/components/ui/animated-beam";
import { agentIdentity } from "@/lib/agent-identity";
import { ItemArt } from "@/components/item-art";
import type { Lot } from "@/lib/auction/lots";

type Member = { id: string; label: string; live: boolean };

/**
 * The live stage as an "arena": the full agent roster flanks the item in two
 * columns, and each bid fires a beam from that agent into the centre — they
 * visibly fight for the lot. Only live (funded) agents ever bid.
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
    const y = col.length === 1 ? 50 : 18 + (row / (col.length - 1)) * 64;
    return { ...m, x: left ? 8 : 92, y };
  });

  return (
    <div ref={container} className="relative h-[280px] w-full max-w-[520px] sm:h-[320px]">
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

      {/* centre item */}
      <div ref={center} className="absolute left-1/2 top-1/2 h-[150px] w-[150px] -translate-x-1/2 -translate-y-1/2 sm:h-[184px] sm:w-[184px]">
        <motion.div
          animate={reduce ? {} : { rotate: 360 }}
          transition={{ duration: 26, ease: "linear", repeat: Infinity }}
          className="h-full w-full overflow-hidden rounded-full shadow-[0_16px_44px_rgba(15,70,95,0.25)]"
        >
          {lot?.artSeed ? (
            <ItemArt seed={lot.artSeed} size={196} className="h-full w-full" />
          ) : (
            <div className="h-full w-full rounded-full bg-white/70" />
          )}
        </motion.div>
      </div>

      <AnimatePresence>
        {positioned.map((m) => {
          const id = agentIdentity(m.id);
          const isActive = active === m.id;
          return (
            <motion.div
              key={m.id}
              ref={(el) => { nodeRefs.current[m.id] = { current: el }; }}
              className="absolute z-10 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${m.x}%`, top: `${m.y}%` }}
              animate={isActive && !reduce ? { scale: [1, 1.18, 1] } : { scale: 1 }}
              transition={{ duration: 0.45 }}
            >
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-full border text-[13px] font-semibold shadow-md backdrop-blur-md ${
                  m.live ? "border-white/80 bg-white/80" : "border-white/50 bg-white/35 opacity-55"
                }`}
                style={{ color: id.color, boxShadow: isActive ? `0 0 0 4px ${id.soft}` : undefined }}
                title={`${m.label}${m.live ? "" : " (standby)"}`}
              >
                {id.glyph}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
