"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";

/**
 * Each character that changes drops in from above while the old one falls
 * away — a split-flap / slot-machine feel. Springs are critically damped,
 * so a rapid sequence of bids stays smooth rather than bouncing.
 */
export function RollingNumber({ value, className = "" }: { value: string; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <span className={`tabular inline-flex overflow-hidden ${className}`} aria-label={value}>
      {value.split("").map((ch, i) => (
        <span key={i} className="relative inline-block overflow-hidden align-baseline" style={{ width: ch === "." ? "0.42em" : "0.62em", height: "1.05em" }}>
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={`${i}-${ch}`}
              initial={reduce ? { opacity: 0 } : { y: "-110%", opacity: 0 }}
              animate={{ y: "0%", opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { y: "110%", opacity: 0 }}
              transition={{ type: "spring", bounce: 0.18, duration: 0.42 }}
              className="absolute inset-0 flex items-center justify-center"
            >
              {ch}
            </motion.span>
          </AnimatePresence>
        </span>
      ))}
    </span>
  );
}
