/**
 * Scaffold placeholder. Visual direction only — no auction logic yet.
 * Clean, minimal, neutral. The stream stage goes here in Tier 0.
 */
export default function Home() {
  return (
    <main className="min-h-screen px-6 py-16">
      <div className="mx-auto max-w-2xl">
        <div className="card p-10">
          <h1 className="text-4xl font-semibold tracking-tight">commenda</h1>
          <p className="mt-3 text-lg text-muted">
            A fully agentic live-stream flash auction.
          </p>
          <p className="mt-6 max-w-xl text-sm leading-relaxed text-muted">
            Delegate a budget and a watchlist to an agent. It watches the
            stream, bids on your behalf, and renders an account — on-chain.
          </p>
        </div>
      </div>
    </main>
  );
}
