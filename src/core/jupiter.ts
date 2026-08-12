/** Jupiter Swap API v1. Lite es público; Pro si hay JUPITER_API_KEY. */

const LITE = 'https://lite-api.jup.ag/swap/v1';
const PRO = 'https://api.jup.ag/swap/v1';

export function jupiterConfig(): { base: string; headers: Record<string, string> } {
  const key = (process.env.JUPITER_API_KEY || '').trim();
  if (key) {
    return {
      base: PRO,
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    };
  }
  return {
    base: LITE,
    headers: { 'Content-Type': 'application/json' },
  };
}

export function isLiveTrading(): boolean {
  return process.env.LIVE_TRADING?.trim().toLowerCase() === 'true';
}
