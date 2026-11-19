/**
 * GET /api/market — public price context per category: what recent lots
 * actually sold for. Shown on the brief so owners set a ceiling that can
 * compete. Public results only (prices); never who wanted what.
 */
import { listClaims, listLotHistory } from "@/lib/db/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  // Claims carry the sale price for every settled lot (older lots predate
  // the per-lot price column).
  const claimPrice = new Map(listClaims().map((c) => [c.chainLotId, c.amountMinor]));
  const byCat: Record<string, number[]> = {};
  for (const l of listLotHistory(120)) {
    const price = l.soldMinor ?? claimPrice.get(l.chainLotId);
    if (!l.category || !price) continue;
    (byCat[l.category] ??= []).push(price);
  }
  const categories = Object.fromEntries(Object.entries(byCat).map(([cat, xs]) => {
    const sorted = [...xs].sort((a, b) => a - b);
    return [cat, {
      lots: sorted.length,
      lowMinor: sorted[0],
      medianMinor: sorted[Math.floor(sorted.length / 2)],
      highMinor: sorted[sorted.length - 1],
    }];
  }));
  return Response.json({ categories });
}
