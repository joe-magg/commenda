/** On-chain receipts for the signed-in user's agent wallets. */
import { currentUser } from "@/lib/auth";
import { listAgents } from "@/lib/db/repo";
import { receiptsFor, type OnChainReceipt } from "@/lib/auction/receipt-chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: "not signed in" }, { status: 401 });
  if (!process.env.RECEIPT_NFT_ADDRESS) return Response.json({ receipts: [] });

  const wallets = listAgents(user.id)
    .map((a) => a.walletAddress)
    .filter((w): w is string => Boolean(w));
  const all: (OnChainReceipt & { owner: string })[] = [];
  for (const wallet of wallets) {
    try {
      const receipts = await receiptsFor(wallet);
      all.push(...receipts.map((r) => ({ ...r, owner: wallet })));
    } catch {
      // a single wallet failing must not break the gallery
    }
  }
  return Response.json({ receipts: all });
}
