"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { TextAnimate } from "@/components/ui/text-animate";

const PHRASES = ["Send your agent to the auction.", "Send your agent to Commenda."];

/**
 * The headline starts on the product promise and resolves into the brand.
 * Blur-out, then word-by-word blur-in. Static under reduced motion.
 */
export function CyclingHeadline({ className }: { className?: string }) {
  const [i, setI] = useState(0);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce) return;
    const t = setInterval(() => setI((v) => (v + 1) % PHRASES.length), 5000);
    return () => clearInterval(t);
  }, [reduce]);

  if (reduce) return <h1 className={className}>{PHRASES[0]}</h1>;

  return (
    <div aria-live="polite">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={i}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10, filter: "blur(6px)" }}
          transition={{ type: "spring", bounce: 0, duration: 0.45 }}
        >
          <h1 className={className}>
            <TextAnimate as="span" by="word" animation="blurInUp" delay={0.05} className="block">
              {PHRASES[i]}
            </TextAnimate>
          </h1>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
