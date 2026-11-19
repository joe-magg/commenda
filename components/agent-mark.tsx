import { cn } from "@/lib/utils";
import { rosterIndex } from "@/lib/agents/roster";

/**
 * Deterministic abstract marks for agents — no more letter glyphs. Each agent
 * id hashes to one of six shape motifs × six bright two-color pairs, with a
 * small deterministic rotation, so a fleet of 10,000 would still read as a
 * designed set (same grammar, endless variation).
 */

type Pair = { a: string; b: string };

// Bright, no-red palette; cyan kept as the anchor of the system.
const PALETTE: Pair[] = [
  { a: "#00a9d6", b: "#0b3f63" }, // cyan / deep navy
  { a: "#7c6cf0", b: "#00a9d6" }, // violet / cyan
  { a: "#f2b632", b: "#0b3f63" }, // gold / navy
  { a: "#ff7a59", b: "#7c6cf0" }, // coral / violet
  { a: "#3ecf8e", b: "#0b3f63" }, // mint / navy
  { a: "#7fd6ff", b: "#f2b632" }, // sky / gold
];

/** (palette, motif) = (v % 6, ⌊v/6⌋ % 6): eight distinct pairs. */
const ROSTER_VARIANTS = [0, 7, 14, 21, 28, 35, 3, 10];

function hash32(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Six 48×48 motifs. `a` is the primary color, `b` the deep counter-color. */
function motif(index: number, a: string, b: string) {
  switch (index % 6) {
    case 0: // two overlapping discs — the contract's two parties
      return (
        <>
          <circle cx="30" cy="19" r="12" fill={a} />
          <circle cx="18" cy="30" r="10" fill="none" stroke={b} strokeWidth="5" />
        </>
      );
    case 1: // half-disc + dot — a sail and its cargo
      return (
        <>
          <path d="M10 34 A14 14 0 0 1 38 34 Z" fill={a} />
          <circle cx="24" cy="12" r="5" fill={b} />
        </>
      );
    case 2: // concentric arcs — bid / counter-bid
      return (
        <>
          <path d="M10 36 A17 17 0 0 1 38 36" fill="none" stroke={a} strokeWidth="6" strokeLinecap="round" />
          <path d="M17 36 A10 10 0 0 1 31 36" fill="none" stroke={b} strokeWidth="6" strokeLinecap="round" />
        </>
      );
    case 3: // triangle + circle overlap — risk / escrow
      return (
        <>
          <path d="M24 8 L40 36 L8 36 Z" fill="none" stroke={b} strokeWidth="5" strokeLinejoin="round" />
          <circle cx="24" cy="27" r="7" fill={a} />
        </>
      );
    case 4: // quarter-pie + satellite dot — a rising market
      return (
        <>
          <path d="M12 36 L12 12 A24 24 0 0 1 36 36 Z" fill={a} />
          <circle cx="38" cy="10" r="4.5" fill={b} />
        </>
      );
    default: // wave + orb — the sea the commenda sails on
      return (
        <>
          <path d="M6 30 Q14 22 24 30 T42 30" fill="none" stroke={a} strokeWidth="6" strokeLinecap="round" />
          <circle cx="24" cy="14" r="6" fill={b} />
        </>
      );
  }
}

export function AgentMark({
  id,
  size = 34,
  className,
  title,
}: {
  id: string;
  size?: number;
  className?: string;
  title?: string;
}) {
  const h = hash32(id.toLowerCase());
  // Seeded agents get hand-assigned variants so no two share a mark (a hash
  // over 36 combinations collides ~57% of the time for 8 agents). Agents
  // created later fall back to the hash.
  const slot = rosterIndex(id);
  const variant = slot >= 0 ? ROSTER_VARIANTS[slot % ROSTER_VARIANTS.length] : h;
  const pair = PALETTE[variant % PALETTE.length];
  const motifIndex = Math.floor(variant / PALETTE.length) % 6;
  const rotation = ((Math.floor(h / (PALETTE.length * 6)) % 21) - 10) * 0.6; // ±6°
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-black/[0.06] bg-white shadow-[0_1px_2px_rgba(16,24,32,0.08)]",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <svg width={Math.round(size * 0.72)} height={Math.round(size * 0.72)} viewBox="0 0 48 48" style={{ transform: `rotate(${rotation}deg)` }} aria-hidden="true">
        {motif(motifIndex, pair.a, pair.b)}
      </svg>
    </span>
  );
}
