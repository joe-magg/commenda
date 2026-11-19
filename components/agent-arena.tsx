"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AgentMark } from "@/components/agent-mark";
import HoloCard from "@/components/HoloCard";
import { cardArtDataUri } from "@/lib/items/card-art";
import type { Lot } from "@/lib/auction/lots";

type Member = { id: string; label: string };

/**
 * The room as gravity. Agents that join a lot are pulled into orbit around
 * the item and spread evenly; when one arrives or leaves, everyone re-spaces
 * on a spring. The leader is drawn closest. A bid is a lunge toward the item
 * and back. An agent that drops out drifts away and fades — there is no list
 * of absentees. Only WHO is in the room is public; never why.
 */
export function AgentArena({
  members,
  participants,
  lot,
  lastBidder,
  bidSeq,
  reduce,
  leaderId = null,
  mineId = null,
}: {
  members: Member[];
  /** Agent ids currently in the room for this lot. */
  participants: readonly string[];
  lot: Lot | null;
  lastBidder: string | null;
  bidSeq: number;
  reduce: boolean;
  leaderId?: string | null;
  mineId?: string | null;
}) {
  const [lunging, setLunging] = useState<string | null>(null);

  useEffect(() => {
    if (!lastBidder || reduce) return;
    setLunging(lastBidder);
    const t = window.setTimeout(() => setLunging(null), 520);
    return () => window.clearTimeout(t);
  }, [lastBidder, bidSeq, reduce]);

  const byId = new Map(members.map((m) => [m.id, m]));
  // Stable seating: your agent first (top-left), then join order.
  const inRoom = participants
    .filter((id) => byId.has(id))
    .sort((a, b) => (a === mineId ? -1 : b === mineId ? 1 : 0));
  const n = inRoom.length;

  // Orbit geometry in px around the card's centre (box 680×470, card 220×306).
  // A superellipse hugs the card's rectangle, so seats never overlap it.
  const W = 680, H = 470, CARD_W = 220, CARD_H = 306, GAP = 74;
  const START = -150; // degrees — first seat upper-left
  const seat = (i: number, id: string) => {
    const t = ((START + (360 / Math.max(n, 1)) * i) * Math.PI) / 180;
    const c = Math.cos(t), s = Math.sin(t);
    // Squircle (p=4): x = a·sgn(c)|c|^½, y = b·sgn(s)|s|^½ — boxy around a portrait card.
    const a = CARD_W / 2 + GAP + 40, b = CARD_H / 2 + GAP * 0.55;
    let x = a * Math.sign(c) * Math.sqrt(Math.abs(c));
    let y = b * Math.sign(s) * Math.sqrt(Math.abs(s));
    // Gravity: the leader sits closer; a bidder lunges in for a beat.
    const pull = id === lunging ? 0.8 : id === leaderId ? 0.93 : 1;
    x *= pull; y *= pull;
    return { left: ((W / 2 + x) / W) * 100, top: ((H / 2 + y) / H) * 100 };
  };

  return (
    <div className="relative h-[470px] w-full max-w-[680px]">
      {/* the item at the centre of gravity */}
      <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
        <motion.div
          key={`ripple-${bidSeq}`}
          className="pointer-events-none absolute -inset-3 rounded-[24px] border-2 border-accent/60"
          initial={{ opacity: bidSeq > 0 && !reduce ? 0.9 : 0, scale: 1 }}
          animate={{ opacity: 0, scale: 1.12 }}
          transition={{ duration: 0.9, ease: "easeOut" }}
        />
        {lot?.artSeed ? (
          <HoloCard image={cardArtDataUri(lot.artSeed)} alt={lot.title} width={220} radius={16}
            tiltMax={12} intensity={0.8} glare={0.55} edgeSparkle={0.7} frame={4} idle />
        ) : (
          <div className="h-[306px] w-[220px] rounded-2xl bg-white/70" />
        )}
      </div>

      <AnimatePresence>
        {inRoom.map((id, i) => {
          const m = byId.get(id)!;
          const mine = id === mineId;
          const leading = id === leaderId;
          const pos = seat(i, id);
          return (
            <motion.div
              key={id}
              className="absolute z-20"
              style={{ translateX: "-50%", translateY: "-50%" }}
              initial={reduce ? { left: `${pos.left}%`, top: `${pos.top}%`, opacity: 0 } : { left: `${50 + (pos.left - 50) * 1.6}%`, top: `${50 + (pos.top - 50) * 1.6}%`, opacity: 0, scale: 0.6 }}
              animate={{ left: `${pos.left}%`, top: `${pos.top}%`, opacity: 1, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { left: `${50 + (pos.left - 50) * 1.7}%`, top: `${50 + (pos.top - 50) * 1.7}%`, opacity: 0, scale: 0.7 }}
              transition={{ type: "spring", stiffness: id === lunging ? 420 : 140, damping: id === lunging ? 18 : 20, mass: 0.9 }}
            >
              <div className="flex flex-col items-center gap-1">
                <div
                  className="rounded-full transition-shadow duration-300"
                  style={{
                    boxShadow: mine
                      ? leading
                        ? "0 0 0 3px #fff, 0 0 0 6px #b8862b, 0 10px 30px rgba(184,134,43,0.5)"
                        : "0 0 0 3px #fff, 0 0 0 6px #14171a, 0 10px 26px rgba(11,63,99,0.35)"
                      : leading
                        ? "0 0 0 3px #fff, 0 0 0 5px #00a9d6, 0 8px 24px rgba(0,169,214,0.4)"
                        : "0 6px 18px rgba(11,63,99,0.14)",
                  }}
                >
                  <AgentMark id={id} size={mine ? 52 : leading ? 46 : 40} />
                </div>
                <span className={`whitespace-nowrap rounded-full px-2 py-0.5 font-sans leading-tight ${
                  mine ? "bg-ink text-[12px] font-bold text-white" : "bg-white/85 text-[11px] font-bold text-ink/70"}`}>
                  {mine ? `You · ${m.label}` : m.label}
                </span>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
