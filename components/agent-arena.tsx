"use client";

import { useRef, useState, useEffect, useMemo, type RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AnimatedBeam } from "@/components/ui/animated-beam";
import { agentIdentity } from "@/lib/agent-identity";
import { ItemArt } from "@/components/item-art";
import type { Lot } from "@/lib/auction/lots";

type Member = { id: string; label: string };

/**
 * The live stage as an "arena": agents ring the item, and each bid fires a
 * beam from that agent into the centre — they visibly fight for the lot.
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

  // React's ref callback identity changes each render; keep stable refs per id.
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

  // Evenly distribute agents around a circle; the item sits at the centre.
  const count = Math.max(members.length, 1);
  const positioned = members.map((m, i) => {
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
    return { ...m, x: 50 + 40 * Math.cos(angle), y: 50 + 40 * Math.sin(angle) };
  });

  return (
    <div ref={container} className="relative h-[280px] w-[280px] sm:h-[320px] sm:w-[320px]">
      {/* beams — re-key on bidSeq so a new bid restarts the travelling pulse */}
      {!reduce && active && refs[active]?.current && (
        <AnimatedBeam
          key={`${active}-${bidSeq}`}
          containerRef={container}
          fromRef={refs[active]}
          toRef={center}
          curvature={18}
          duration={1}
          repeat={1}
          pathColor="#00a9d6"
          pathWidth={2}
          pathOpacity={0.25}
          gradientStartColor="#00a9d6"
          gradientStopColor="#7fd6ff"
        />
      )}

      {/* centre item */}
      <div ref={center} className="absolute left-1/2 top-1/2 h-[168px] w-[168px] -translate-x-1/2 -translate-y-1/2 sm:h-[196px] sm:w-[196px]">
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

      {/* agent nodes */}
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
                className="flex h-9 w-9 items-center justify-center rounded-full border border-white/80 bg-white/75 text-[13px] font-semibold shadow-md backdrop-blur-md"
                style={{ color: id.color, boxShadow: isActive ? `0 0 0 4px ${id.soft}` : undefined }}
                title={m.label}
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
