/** Umbrales de momentum (Phantom-style) desde .env con defaults seguros. */
export interface MomentumConfig {
  minMcUSD: number;
  maxMcUSD: number;
  minTxCount: number;
  minPoolSol: number;
}

export function loadMomentumConfig(heliosMinPoolSol = 5): MomentumConfig {
  const num = (key: string, fallback: number): number => {
    const raw = process.env[key];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    minMcUSD: num('MIN_MC_USD', 30_000),
    maxMcUSD: num('MAX_MC_USD', 250_000),
    minTxCount: num('MIN_TX_COUNT', 200),
    minPoolSol: num('MIN_POOL_SOL', heliosMinPoolSol),
  };
}
