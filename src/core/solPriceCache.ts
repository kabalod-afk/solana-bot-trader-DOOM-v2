/** Precio SOL compartido: 1 fetch / 5 min, no por cada token. */
let cached = 160;
let lastFetch = 0;
const TTL_MS = 5 * 60_000;
let inflight: Promise<number> | null = null;

export function getCachedSolPrice(): number {
  return cached;
}

export async function refreshSolPrice(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastFetch < TTL_MS) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
      );
      const data = (await res.json()) as { solana?: { usd?: number } };
      if (data.solana?.usd) cached = data.solana.usd;
      lastFetch = Date.now();
    } catch {
      /* keep last */
    } finally {
      inflight = null;
    }
    return cached;
  })();

  return inflight;
}
