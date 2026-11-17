/**
 * Pure SVG art seeded by an item's SKU hash. No image generation, no credits,
 * deterministic and offline — every item gets a distinct but coherent look.
 */
export function ItemArt({
  seed,
  size = 160,
  className = "",
}: {
  seed: string;
  size?: number;
  className?: string;
}) {
  const n = (i: number, mod: number) => parseInt(seed.slice(i, i + 4), 16) % mod;
  const hue = n(0, 360);
  const hue2 = (hue + 40 + n(4, 60)) % 360;
  const cx = 30 + n(4, 40);
  const cy = 30 + n(8, 40);
  const r = 18 + n(12, 16);
  const rot = n(0, 90);
  const poly = `${20 + n(2, 20)},${70 - n(6, 20)} ${50 + n(8, 20)},${20 + n(10, 20)} ${80 - n(12, 20)},${65 + n(14, 20)}`;
  const gid = `g-${seed.slice(0, 8)}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      role="img"
      aria-label={`Item artwork ${seed.slice(0, 6)}`}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={`hsl(${hue} 22% 88%)`} />
          <stop offset="100%" stopColor={`hsl(${hue2} 18% 68%)`} />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="10" fill={`url(#${gid})`} />
      <g transform={`rotate(${rot} 50 50)`} opacity="0.75">
        <circle cx={cx} cy={cy} r={r} fill={`hsl(${hue2} 30% 52%)`} />
        <polygon points={poly} fill="none" stroke={`hsl(${hue} 28% 40%)`} strokeWidth="1.5" />
      </g>
      <circle cx="50" cy="50" r="28" fill="none" stroke="rgba(255,255,255,.6)" strokeWidth="1" />
      <text x="50" y="92" textAnchor="middle" fontSize="6" fill={`hsl(${hue} 20% 32%)`} fontFamily="monospace" letterSpacing="0.5">
        {seed.slice(0, 6).toUpperCase()}
      </text>
    </svg>
  );
}
